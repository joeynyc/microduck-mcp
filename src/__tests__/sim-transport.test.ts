import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SimTransport, SimTransportOptions } from "../transport/sim.js";

/**
 * Contract tests for SimTransport against `fixtures/fake_sidecar.mjs`, a Node
 * stand-in that speaks the sidecar's line-delimited JSON-RPC without MuJoCo.
 */
const fake = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "__tests__", "fixtures", "fake_sidecar.mjs");

/** Run `fn` against a fresh transport in the given fake mode; always closes it. */
async function withSim(mode: string, fn: (t: SimTransport) => Promise<void>, extra: SimTransportOptions = {}) {
  const t = new SimTransport({
    python: process.execPath,
    script: fake,
    args: [mode],
    readyTimeoutMs: 3000,
    callTimeoutMs: 500,
    ...extra,
  });
  try {
    await fn(t);
  } finally {
    await t.close();
  }
}

describe("SimTransport", () => {
  test("waits for sim.ready, then round-trips a call with id matching", () =>
    withSim("ok", async (t) => {
      const h = (await t.call("robot.health")) as { healthy: boolean };
      assert.equal(h.healthy, true);
      assert.equal(await t.ping(), true);
    }));

  test("passes params through and keeps concurrent calls straight", () =>
    withSim("ok", async (t) => {
      const [a, b, c] = await Promise.all([
        t.call("robot.move", { vx: 0.1 }),
        t.call("robot.health"),
        t.call("robot.move", { vx: 0.3, ttl_s: 5 }),
      ]);
      assert.deepEqual((a as any).applied, { vx: 0.1 });
      assert.equal((b as any).mode, "standing");
      assert.equal((c as any).ttl_s, 5);
    }));

  test("state() is the one-shot robot.state request", () =>
    withSim("ok", async (t) => {
      assert.equal((await t.state()).policy, "stand");
    }));

  test("snapshot() is the sim.camera method with its own timeout", () =>
    withSim("ok", async (t) => {
      const s = await t.snapshot({ view: "head", width: 64, height: 48 });
      assert.equal(s.png_base64, "iVBORw0KGgo=");
      assert.equal(s.view, "head");
      assert.equal(s.width, 64);
    }));

  test("maps JSON-RPC errors to rejections with the message", () =>
    withSim("ok", async (t) => {
      await assert.rejects(() => t.call("robot.nope"), /method not found: robot.nope/);
    }));

  test("times out a call the sidecar never answers, and stays usable", () =>
    withSim("ok", async (t) => {
      await assert.rejects(() => t.call("slow"), /timed out after 500ms/);
      assert.equal(await t.ping(), true);
    }));

  test("rejects every call if the sidecar exits", () =>
    withSim("crash", async (t) => {
      await assert.rejects(() => t.call("robot.health"), /exited \(code 3/);
      assert.equal(await t.ping(), false);
    }));

  test("surfaces a sim.error (e.g. missing assets) as the startup failure", () =>
    withSim("missing-assets", async (t) => {
      await assert.rejects(() => t.call("robot.health"), /assets missing/);
    }));

  test("fails fast when the sidecar never reports ready", () =>
    withSim(
      "never-ready",
      async (t) => {
        await assert.rejects(() => t.call("robot.health"), /did not report ready/);
      },
      { readyTimeoutMs: 300 },
    ));

  test("names the interpreter when the one it was given is missing", async () => {
    const t = new SimTransport({ python: "/nonexistent/python", script: fake });
    await assert.rejects(() => t.call("robot.health"), /\/nonexistent\/python/);
    await t.close();
  });

  test("points at setup-sim when the sim has never been set up", async () => {
    const saved = { home: process.env.DUCK_SIM_HOME, py: process.env.DUCK_SIM_PYTHON };
    process.env.DUCK_SIM_HOME = mkdtempSync(join(tmpdir(), "sim-home-"));
    delete process.env.DUCK_SIM_PYTHON;
    try {
      const t = new SimTransport({ script: fake });
      await assert.rejects(() => t.call("robot.health"), /npx microduck-mcp setup-sim/);
      await t.close();
    } finally {
      rmSync(process.env.DUCK_SIM_HOME, { recursive: true, force: true });
      if (saved.home === undefined) delete process.env.DUCK_SIM_HOME;
      else process.env.DUCK_SIM_HOME = saved.home;
      if (saved.py !== undefined) process.env.DUCK_SIM_PYTHON = saved.py;
    }
  });
});
