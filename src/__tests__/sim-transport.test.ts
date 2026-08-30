import { test, describe } from "node:test";
import assert from "node:assert/strict";
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
      const h = (await t.call("robotd", "robot.health")) as { healthy: boolean };
      assert.equal(h.healthy, true);
      assert.equal(await t.ping(), true);
    }));

  test("passes params through and keeps concurrent calls straight", () =>
    withSim("ok", async (t) => {
      const [a, b, c] = await Promise.all([
        t.call("robotd", "robot.intent", { vx: 0.1 }),
        t.call("robotd", "robot.health"),
        t.call("robotd", "robot.intent", { vx: 0.3, ttl_s: 5 }),
      ]);
      assert.deepEqual((a as any).applied, { vx: 0.1 });
      assert.equal((b as any).mode, "standing");
      assert.equal((c as any).ttl_s, 5);
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
      await assert.rejects(() => t.call("robotd", "robot.nope"), /method not found: robot.nope/);
    }));

  test("times out a call the sidecar never answers, and stays usable", () =>
    withSim("ok", async (t) => {
      await assert.rejects(() => t.call("robotd", "slow"), /timed out after 500ms/);
      assert.equal(await t.ping(), true);
    }));

  test("rejects every call if the sidecar exits", () =>
    withSim("crash", async (t) => {
      await assert.rejects(() => t.call("robotd", "robot.health"), /exited \(code 3/);
      assert.equal(await t.ping(), false);
    }));

  test("surfaces a sim.error (e.g. missing assets) as the startup failure", () =>
    withSim("missing-assets", async (t) => {
      await assert.rejects(() => t.call("robotd", "robot.health"), /assets missing/);
    }));

  test("fails fast when the sidecar never reports ready", () =>
    withSim(
      "never-ready",
      async (t) => {
        await assert.rejects(() => t.call("robotd", "robot.health"), /did not report ready/);
      },
      { readyTimeoutMs: 300 },
    ));

  test("fails with a helpful message when the python interpreter is missing", async () => {
    const t = new SimTransport({ python: "/nonexistent/python", script: fake });
    await assert.rejects(() => t.call("robotd", "robot.health"), /run sim\/setup.sh/);
    await t.close();
  });
});
