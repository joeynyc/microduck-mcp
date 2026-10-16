import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where the sim's Python environment and upstream assets live. Outside the
 * package on purpose: under `npx` the package directory is npm's cache, which
 * is neither writable in general nor kept. `microduck-mcp setup-sim` fills it;
 * the sim transport reads it. `DUCK_SIM_HOME` overrides.
 */
export function simHome(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (env.DUCK_SIM_HOME) return env.DUCK_SIM_HOME;
  const home = homedir();
  if (platform === "win32") return join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "microduck-mcp", "sim");
  if (platform === "darwin") return join(home, "Library", "Application Support", "microduck-mcp", "sim");
  return join(env.XDG_DATA_HOME ?? join(home, ".local", "share"), "microduck-mcp", "sim");
}

export function venvPython(home: string, platform = process.platform): string {
  return platform === "win32" ? join(home, ".venv", "Scripts", "python.exe") : join(home, ".venv", "bin", "python");
}

export interface AssetFile {
  path: string;
  size: number;
  sha256: string;
}
export interface AssetSource {
  role: "scene" | "policies";
  repo: string;
  rev: string;
  dir: string;
  /** The file the sidecar is pointed at, if not the directory itself. */
  entry?: string;
  files: AssetFile[];
}
export interface SimManifest {
  python: string;
  packages: string[];
  sources: AssetSource[];
}

/** The package root (where `sim/` ships), from dist/ or src/. */
export const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export function loadManifest(): SimManifest {
  return JSON.parse(readFileSync(join(packageRoot, "sim", "assets.json"), "utf8")) as SimManifest;
}

/** Where one source's files go: keyed by commit, so a re-pin never mixes revisions. */
export function sourceDir(home: string, s: AssetSource): string {
  return join(home, "assets", `${s.repo.split("/")[1]}@${s.rev.slice(0, 7)}`, ...s.dir.split("/"));
}

/** What the sidecar is pointed at (`--scene` / `--policies`). */
export function sidecarAssets(home: string, m: SimManifest = loadManifest()): { scene: string; policies: string } {
  const at = (role: AssetSource["role"]) => {
    const s = m.sources.find((x) => x.role === role);
    if (!s) throw new Error(`sim/assets.json has no ${role} source`);
    return s.entry ? join(sourceDir(home, s), s.entry) : sourceDir(home, s);
  };
  return { scene: at("scene"), policies: at("policies") };
}

/** Cheap presence check (no hashing) — enough to say "run setup-sim" instead of a stack trace. */
export function simReady(home: string): boolean {
  const { scene, policies } = sidecarAssets(home);
  return existsSync(venvPython(home)) && existsSync(scene) && existsSync(policies);
}

export const SETUP_HINT =
  "The sim isn't set up yet. Run `npx microduck-mcp setup-sim` once " +
  "(needs uv or Python 3.10–3.13; downloads ~35 MB of upstream assets plus MuJoCo).";
