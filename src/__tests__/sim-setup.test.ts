import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssetSource, SimManifest, loadManifest, sidecarAssets, simHome, sourceDir } from "../sim-home.js";
import { assetUrl, fetchAssets } from "../sim-setup.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const quiet = () => {};

describe("simHome", () => {
  test("DUCK_SIM_HOME wins everywhere", () => {
    for (const p of ["linux", "darwin", "win32"] as const) assert.equal(simHome({ DUCK_SIM_HOME: "/x" }, p), "/x");
  });

  test("Linux follows XDG_DATA_HOME", () => {
    assert.equal(simHome({ XDG_DATA_HOME: "/data" }, "linux"), join("/data", "microduck-mcp", "sim"));
  });

  test("Windows lands in LOCALAPPDATA, macOS in Application Support", () => {
    assert.equal(simHome({ LOCALAPPDATA: "C:/L" }, "win32"), join("C:/L", "microduck-mcp", "sim"));
    assert.match(simHome({}, "darwin"), /Library.Application Support.microduck-mcp.sim$/);
  });
});

describe("the shipped manifest", () => {
  const m = loadManifest();

  test("pins exact package versions and both sources at full commits", () => {
    assert.ok(m.packages.every((p) => /==\d/.test(p)), m.packages.join(" "));
    assert.deepEqual(m.sources.map((s) => s.role).sort(), ["policies", "scene"]);
    for (const s of m.sources) assert.match(s.rev, /^[0-9a-f]{40}$/);
  });

  test("carries the scene entry and every policy the sidecar loads", () => {
    const scene = m.sources.find((s) => s.role === "scene")!;
    assert.ok(scene.files.some((f) => f.path === scene.entry));
    const policies = m.sources.find((s) => s.role === "policies")!.files.map((f) => f.path);
    for (const net of ["alpha_walking", "alpha_stand", "alpha_sitstand", "alpha_ground_pick", "roulade"]) {
      assert.ok(policies.includes(`${net}.onnx`), net);
    }
  });

  test("points the sidecar at a per-commit directory", () => {
    const { scene, policies } = sidecarAssets("/h", m);
    assert.match(scene, /microduck_rl@d424a0c.*scene\.xml$/);
    assert.match(policies, /microduck@590b986.policies$/);
  });
});

describe("fetchAssets", () => {
  const files = { "a.xml": "<mujoco/>", "meshes/b c.stl": "solid" };
  const source: AssetSource = {
    role: "scene",
    repo: "org/repo",
    rev: "0".repeat(40),
    dir: "robot/duck",
    files: Object.entries(files).map(([path, body]) => ({ path, size: body.length, sha256: sha(body) })),
  };
  const manifest: SimManifest = { python: "3.10", packages: [], sources: [source] };

  /** Serve `files` under the raw-URL layout; `tamper` serves wrong bytes for one path. Counts requests. */
  async function serve(tamper?: string) {
    const hits: string[] = [];
    const server = createServer((req, res) => {
      const url = decodeURIComponent(req.url ?? "");
      hits.push(url);
      const path = url.replace(`/${source.repo}/${source.rev}/${source.dir}/`, "");
      const body = (files as Record<string, string>)[path];
      if (body === undefined) return void res.writeHead(404).end();
      res.end(path === tamper ? body + "!" : body);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { base, hits, close: () => new Promise((r) => server.close(r)) };
  }

  test("encodes each path segment, not the slashes", () => {
    const f = source.files[1];
    assert.equal(assetUrl("https://raw", source, f), `https://raw/org/repo/${source.rev}/robot/duck/meshes/b%20c.stl`);
  });

  test("downloads everything, then a re-run fetches nothing", async () => {
    const home = mkdtempSync(join(tmpdir(), "sim-fetch-"));
    const srv = await serve();
    try {
      assert.equal(await fetchAssets(home, manifest, quiet, srv.base), 2);
      assert.equal(readFileSync(join(sourceDir(home, source), "meshes", "b c.stl"), "utf8"), "solid");
      const before = srv.hits.length;
      assert.equal(await fetchAssets(home, manifest, quiet, srv.base), 0);
      assert.equal(srv.hits.length, before, "intact files are not re-requested");
    } finally {
      await srv.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("replaces a corrupted file and leaves the intact one alone", async () => {
    const home = mkdtempSync(join(tmpdir(), "sim-fetch-"));
    const srv = await serve();
    try {
      await fetchAssets(home, manifest, quiet, srv.base);
      writeFileSync(join(sourceDir(home, source), "a.xml"), "corrupt");
      srv.hits.length = 0;
      assert.equal(await fetchAssets(home, manifest, quiet, srv.base), 1);
      assert.equal(srv.hits.length, 1);
      assert.equal(readFileSync(join(sourceDir(home, source), "a.xml"), "utf8"), "<mujoco/>");
    } finally {
      await srv.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("refuses bytes that do not match the pinned hash, and writes nothing for them", async () => {
    const home = mkdtempSync(join(tmpdir(), "sim-fetch-"));
    const srv = await serve("a.xml");
    try {
      await assert.rejects(fetchAssets(home, manifest, quiet, srv.base), /a\.xml: sha256 mismatch/);
      assert.ok(!existsSync(join(sourceDir(home, source), "a.xml")));
      assert.ok(!existsSync(join(sourceDir(home, source), "a.xml.part")));
    } finally {
      await srv.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
