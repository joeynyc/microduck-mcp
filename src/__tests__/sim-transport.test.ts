import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SimTransport } from "../transport/sim.js";

/**
 * Contract tests for SimTransport against a fake sidecar written in Node, so
 * they run without MuJoCo. The fake speaks the same line-delimited JSON-RPC
 * the Python sidecar does: a `sim.ready` notification, then answers.
 */
const dir = mkdtempSync(join(tmpdir(), "duck-sim-test-"));
const fake = join(dir, "fake_sidecar.mjs");
writeFileSync(
  fake,
  `
import { createInterface } from "node:readline";
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const mode = process.argv[2] ?? "ok";
if (mode === "crash") process.exit(3);
if (mode === "missing-assets") { send({ jsonrpc: "2.0", method: "sim.error", params: { message: "assets missing" } }); process.exit(2); }
if (mode !== "never-ready") send({ jsonrpc: "2.0", method: "sim.ready", params: { policies: ["walk"], hz: 50 } });
process.stderr.write("fake sidecar up\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const req = JSON.parse(line);
  const { id, method, params } = req;
  if (method === "robot.health") return send({ jsonrpc: "2.0", id, result: { healthy: true, mode: "standing", battery: { fraction: 0.8 } } });
  if (method === "robot.intent") return send({ jsonrpc: "2.0", id, result: { applied: params, ttl_s: params.ttl_s ?? 2 } });
  if (method === "slow") return; // never answers
  if (method === "sim.camera") return send({ jsonrpc: "2.0", id, result: { png_base64: "iVBORw0KGgo=", width: 1, height: 1 } });
  send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found: " + method } });
});
`,
);
after(() => rmSync(dir, { recursive: true, force: true }));

const make = (mode = "ok", extra: Partial<ConstructorParameters<typeof SimTransport>[0]> = {}) =>
  new SimTransport({
    python: process.execPath,
    script: fake,
    args: [mode],
    readyTimeoutMs: 3000,
    callTimeoutMs: 500,
    ...extra,
  });

describe("SimTransport", () => {
  test("waits for sim.ready, then round-trips a call with id matching", async () => {
    const t = make();
    try {
      const h = (await t.call("robotd", "robot.health")) as { healthy: boolean };
      assert.equal(h.healthy, true);
      assert.equal(await t.ping(), true);
    } finally {
      await t.close();
    }
  });

  test("passes params through and keeps concurrent calls straight", async () => {
    const t = make();
    try {
      const [a, b, c] = await Promise.all([
        t.call("robotd", "robot.intent", { vx: 0.1 }),
        t.call("robotd", "robot.health"),
        t.call("robotd", "robot.intent", { vx: 0.3, ttl_s: 5 }),
      ]);
      assert.deepEqual((a as any).applied, { vx: 0.1 });
      assert.equal((b as any).mode, "standing");
      assert.equal((c as any).ttl_s, 5);
    } finally {
      await t.close();
    }
  });

  test("maps JSON-RPC errors to rejections with the message", async () => {
    const t = make();
    try {
      await assert.rejects(() => t.call("robotd", "robot.nope"), /method not found: robot.nope/);
    } finally {
      await t.close();
    }
  });

  test("times out a call the sidecar never answers", async () => {
    const t = make();
    try {
      await assert.rejects(() => t.call("robotd", "slow"), /timed out after 500ms/);
      // and the transport is still usable afterwards
      assert.equal(await t.ping(), true);
    } finally {
      await t.close();
    }
  });

  test("rejects every call if the sidecar exits", async () => {
    const t = make("crash");
    try {
      await assert.rejects(() => t.call("robotd", "robot.health"), /exited \(code 3/);
      assert.equal(await t.ping(), false);
    } finally {
      await t.close();
    }
  });

  test("surfaces a sim.error (e.g. missing assets) as the startup failure", async () => {
    const t = make("missing-assets");
    try {
      await assert.rejects(() => t.call("robotd", "robot.health"), /assets missing/);
    } finally {
      await t.close();
    }
  });

  test("fails fast when the sidecar never reports ready", async () => {
    const t = make("never-ready", { readyTimeoutMs: 300 });
    try {
      await assert.rejects(() => t.call("robotd", "robot.health"), /did not report ready/);
    } finally {
      await t.close();
    }
  });

  test("fails with a helpful message when the python interpreter is missing", async () => {
    const t = new SimTransport({ python: join(dir, "nope", "python"), script: fake });
    await assert.rejects(() => t.call("robotd", "robot.health"), /run sim\/setup.sh/);
    await t.close();
  });
});
