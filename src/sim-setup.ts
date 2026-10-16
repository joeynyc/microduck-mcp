import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { M } from "./transport/protocol.js";
import { SimTransport } from "./transport/sim.js";
import { AssetFile, AssetSource, SimManifest, loadManifest, simHome, sourceDir, venvPython } from "./sim-home.js";

/**
 * `microduck-mcp setup-sim`: everything DUCK_TRANSPORT=sim needs, in the sim
 * home (sim-home.ts), from nothing but Node and either uv or a Python.
 *
 *   1. A venv with the exact packages in sim/assets.json — uv if it is on
 *      PATH (it fetches the pinned Python itself), else a system Python.
 *   2. The upstream scene and policies, file by file from
 *      raw.githubusercontent.com at pinned commits, each checked against the
 *      manifest's sha256. No git. Files already present and intact are kept,
 *      so a re-run resumes rather than restarts.
 *   3. A smoke test: start the sidecar, ask robot.health, render one frame.
 *
 * Idempotent: re-running repairs whatever is missing or corrupt.
 */

const RAW_BASE = "https://raw.githubusercontent.com";
const DOWNLOAD_WORKERS = 8;
const DOWNLOAD_ATTEMPTS = 3;
const DOWNLOAD_TIMEOUT_MS = 60_000;
/** Pythons with wheels for every pinned package. */
const PYTHON_RANGE = { min: [3, 10], max: [3, 13] } as const;

type Log = (line: string) => void;

interface RunResult {
  code: number | null;
  out: string;
  err: string;
}

/** Run a command; `inherit` shows its output to the user (installs), otherwise it is captured. */
function run(cmd: string, args: string[], inherit = false): Promise<RunResult> {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    const p = spawn(cmd, args, { stdio: ["ignore", inherit ? "inherit" : "pipe", inherit ? "inherit" : "pipe"] });
    p.stdout?.on("data", (d) => (out += d));
    p.stderr?.on("data", (d) => (err += d));
    p.on("error", (e) => resolve({ code: null, out, err: e.message })); // not on PATH
    p.on("close", (code) => resolve({ code, out, err }));
  });
}

async function must(what: string, cmd: string, args: string[], hint = ""): Promise<void> {
  const r = await run(cmd, args, true);
  if (r.code !== 0) throw new Error(`${what} failed (${cmd} ${args.join(" ")}).${hint ? ` ${hint}` : ""}`);
}

/** A system Python inside PYTHON_RANGE, as [command, ...leading args]. */
async function findSystemPython(): Promise<{ cmd: string; pre: string[]; version: string } | undefined> {
  const candidates: [string, string[]][] =
    process.platform === "win32" ? [["py", ["-3"]], ["python", []]] : [["python3", []], ["python", []]];
  for (const [cmd, pre] of candidates) {
    const r = await run(cmd, [...pre, "-c", "import sys; print('%d.%d' % sys.version_info[:2])"]);
    if (r.code !== 0) continue;
    const version = r.out.trim();
    const [maj, min] = version.split(".").map(Number);
    const n = maj * 100 + min;
    const lo = PYTHON_RANGE.min[0] * 100 + PYTHON_RANGE.min[1];
    const hi = PYTHON_RANGE.max[0] * 100 + PYTHON_RANGE.max[1];
    if (n >= lo && n <= hi) return { cmd, pre, version };
  }
  return undefined;
}

export async function setupPython(home: string, m: SimManifest, log: Log): Promise<void> {
  const venv = join(home, ".venv");
  const py = venvPython(home);
  const stale = `If an old environment is in the way, delete ${venv} and re-run.`;
  if ((await run("uv", ["--version"])).code === 0) {
    log(`python: using uv (Python ${m.python})`);
    if (!existsSync(py)) await must("creating the venv", "uv", ["venv", "-q", "--python", m.python, venv]);
    await must("installing packages", "uv", ["pip", "install", "-q", "--python", py, ...m.packages], stale);
    return;
  }
  const sys = await findSystemPython();
  if (!sys) {
    throw new Error(
      `Need uv or Python ${PYTHON_RANGE.min.join(".")}–${PYTHON_RANGE.max.join(".")} on PATH. ` +
        `uv is the easy one — it fetches the right Python itself: https://docs.astral.sh/uv/getting-started/installation/`,
    );
  }
  log(`python: no uv on PATH, using ${sys.cmd} (Python ${sys.version})`);
  if (!existsSync(py)) {
    await must(
      "creating the venv",
      sys.cmd,
      [...sys.pre, "-m", "venv", venv],
      process.platform === "linux" ? "On Debian/Ubuntu: sudo apt install python3-venv (or install uv)." : "",
    );
  }
  await must(
    "installing packages",
    py,
    ["-m", "pip", "install", "-q", "--disable-pip-version-check", ...m.packages],
    stale,
  );
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function intact(path: string, f: AssetFile): boolean {
  if (!existsSync(path)) return false;
  return sha256(readFileSync(path)) === f.sha256;
}

/** The raw URL for one manifest file. Path segments are encoded; the slashes are not. */
export function assetUrl(base: string, s: AssetSource, f: AssetFile): string {
  const path = [...s.dir.split("/"), ...f.path.split("/")].map(encodeURIComponent).join("/");
  return `${base}/${s.repo}/${s.rev}/${path}`;
}

async function download(url: string, f: AssetFile, dest: string): Promise<void> {
  let last: unknown;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = Buffer.from(await res.arrayBuffer());
      // A wrong hash is refused, not "fixed": the manifest is the pin.
      if (sha256(body) !== f.sha256) throw new Error(`sha256 mismatch (got ${body.length} bytes)`);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(`${dest}.part`, body);
      renameSync(`${dest}.part`, dest);
      return;
    } catch (e) {
      last = e;
      if (attempt < DOWNLOAD_ATTEMPTS) await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  throw new Error(`${url}: ${last instanceof Error ? last.message : String(last)}`);
}

/** Fetch every manifest file that is missing or does not hash right. Returns how many were fetched. */
export async function fetchAssets(home: string, m: SimManifest, log: Log, base = RAW_BASE): Promise<number> {
  const jobs = m.sources.flatMap((s) =>
    s.files.map((f) => ({ url: assetUrl(base, s, f), f, dest: join(sourceDir(home, s), ...f.path.split("/")) })),
  );
  const todo = jobs.filter((j) => !intact(j.dest, j.f));
  const bytes = todo.reduce((n, j) => n + j.f.size, 0);
  if (todo.length === 0) {
    log(`assets: all ${jobs.length} files present and verified`);
    return 0;
  }
  log(`assets: fetching ${todo.length} of ${jobs.length} files (${(bytes / 1e6).toFixed(1)} MB), sha256-checked`);
  let done = 0;
  let nextReport = 0.25;
  const queue = [...todo];
  const worker = async () => {
    for (let j = queue.shift(); j; j = queue.shift()) {
      await download(j.url, j.f, j.dest);
      done++;
      if (done / todo.length >= nextReport && done < todo.length) {
        log(`  ${done}/${todo.length}`);
        nextReport += 0.25;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(DOWNLOAD_WORKERS, todo.length) }, worker));
  log(`  ${done}/${todo.length} done`);
  return todo.length;
}

/** Start the sidecar for real: health, then one rendered frame. */
async function smokeTest(log: Log): Promise<void> {
  log("smoke test: starting the sim (first start takes a few seconds)…");
  const t = new SimTransport();
  try {
    const began = Date.now();
    await t.call(M.robotHealth);
    log(`  sim up in ${((Date.now() - began) / 1000).toFixed(1)} s`);
    try {
      const frame = await t.snapshot({ view: "follow", width: 160, height: 120 });
      log(`  camera ok (${frame.width}×${frame.height})`);
    } catch (e) {
      log(
        `  camera unavailable: ${e instanceof Error ? e.message : e}\n` +
          `  Everything but duck_camera works without it. The camera needs headless OpenGL: ` +
          (process.platform === "linux"
            ? "EGL by default; try MUJOCO_GL=osmesa (apt install libosmesa6) if EGL is missing."
            : "set MUJOCO_GL to a renderer your machine has (see MuJoCo's docs)."),
      );
    }
  } finally {
    await t.close();
  }
}

function clientConfig(): string {
  const env: Record<string, string> = { DUCK_TRANSPORT: "sim" };
  if (process.env.DUCK_SIM_HOME) env.DUCK_SIM_HOME = process.env.DUCK_SIM_HOME;
  const entry = { microduck: { command: "npx", args: ["-y", "microduck-mcp"], env } };
  return JSON.stringify({ mcpServers: entry }, null, 2);
}

export const SETUP_USAGE = `usage: microduck-mcp setup-sim

Sets up DUCK_TRANSPORT=sim: a Python venv with MuJoCo + ONNX Runtime and the
official Microduck scene and policies (~35 MB), then starts the sim once to
check it works. Safe to re-run; it repairs anything missing or corrupt.

Needs uv (recommended, https://docs.astral.sh/uv/) or Python 3.10–3.13.
Installs into ${simHome()}
(set DUCK_SIM_HOME to choose another directory).`;

export async function setupSim(args: string[]): Promise<number> {
  if (args.includes("-h") || args.includes("--help")) {
    console.log(SETUP_USAGE);
    return 0;
  }
  if (args.length) {
    console.error(`unknown argument: ${args[0]}\n\n${SETUP_USAGE}`);
    return 2;
  }
  const log: Log = (line) => console.log(line);
  const home = simHome();
  const m = loadManifest();
  log(`microduck-mcp setup-sim → ${home}`);
  try {
    mkdirSync(home, { recursive: true });
    await setupPython(home, m, log);
    await fetchAssets(home, m, log);
    await smokeTest(log);
  } catch (e) {
    console.error(`\nsetup-sim failed: ${e instanceof Error ? e.message : e}`);
    return 1;
  }
  log(`\nSim ready. Add this to your MCP client's config (Claude Desktop, Cursor, …):\n\n${clientConfig()}`);
  return 0;
}
