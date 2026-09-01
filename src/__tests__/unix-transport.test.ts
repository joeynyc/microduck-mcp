import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { createInterface } from "node:readline";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnixTransport } from "../transport/unix.js";
import { SshTransport } from "../transport/ssh.js";

/**
 * Contract tests for UnixTransport against a fake robotd on a Unix socket:
 * one JSON object per line, requests answered by id, `robot.subscribe`
 * acknowledged and then followed by `robot.state` notifications — the shape
 * duck-ipc-proto describes.
 */
const dir = mkdtempSync(join(tmpdir(), "duck-unix-test-"));
const sock = join(dir, "robotd.sock");
let server: net.Server;

before(async () => {
  server = net.createServer((conn) => {
    const send = (o: unknown) => conn.write(JSON.stringify(o) + "\n");
    createInterface({ input: conn }).on("line", (line) => {
      const { id, method, params } = JSON.parse(line);
      switch (method) {
        case "robot.health":
          return send({ jsonrpc: "2.0", id, result: { healthy: true, battery: { volts: 7.9, percent: 80 } } });
        case "robot.move":
          return send({ jsonrpc: "2.0", id, result: { accepted: true, echo: params } });
        case "robot.subscribe":
          send({ jsonrpc: "2.0", id, result: { accepted: true, walk: "alpha_walking.onnx" } });
          // two frames, then the first one is what a one-shot reader takes
          send({ jsonrpc: "2.0", method: "robot.state", params: { t: 1.0, policy: "stand", hz: params?.hz } });
          send({ jsonrpc: "2.0", method: "robot.state", params: { t: 1.02, policy: "stand" } });
          return;
        case "robot.subscribeRefused":
          return send({ jsonrpc: "2.0", id, error: { code: -32000, message: "no policy" } });
        case "hang":
          return; // never answers
        case "hangup":
          return conn.end();
        default:
          return send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
      }
    });
  });
  await new Promise<void>((r) => server.listen(sock, r));
});
after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

const paths = { robotd: sock, configd: sock, updaterd: sock };

describe("UnixTransport", () => {
  test("round-trips a request by id", async () => {
    const t = new UnixTransport(paths, 500);
    const h = (await t.call("robot.health")) as { healthy: boolean };
    assert.equal(h.healthy, true);
    const m = (await t.call("robot.move", { vx: 0.1, vy: 0, vyaw: 0 })) as { echo: unknown };
    assert.deepEqual(m.echo, { vx: 0.1, vy: 0, vyaw: 0 });
    assert.equal(await t.ping(), true);
  });

  test("state() subscribes and returns the first robot.state frame", async () => {
    const t = new UnixTransport(paths, 500);
    const s = await t.state();
    assert.equal(s.t, 1.0);
    assert.equal(s.policy, "stand");
    assert.equal((s as any).hz, 50, "subscribes at 50 Hz");
  });

  test("maps a JSON-RPC error to a rejection naming the method", async () => {
    const t = new UnixTransport(paths, 500);
    await assert.rejects(() => t.call("robot.nope"), /robot\.nope: method not found/);
  });

  test("times out when the daemon never answers", async () => {
    const t = new UnixTransport(paths, 200);
    await assert.rejects(() => t.call("hang"), /timed out after 200ms/);
  });

  test("rejects when the daemon hangs up without answering", async () => {
    const t = new UnixTransport(paths, 500);
    await assert.rejects(() => t.call("hangup"), /closed without an answer/);
  });

  test("rejects when the socket does not exist", async () => {
    const t = new UnixTransport({ ...paths, robotd: join(dir, "missing.sock") }, 500);
    await assert.rejects(() => t.call("robot.health"), /ENOENT|ECONNREFUSED/);
    assert.equal(await t.ping(), false);
  });
});

describe("SshTransport", () => {
  test("a failed tunnel is forgotten, so the next call tries again", async () => {
    const t = new SshTransport("duck@nowhere", [], 2000, join(dir, "no-such-ssh"));
    await assert.rejects(() => t.call("robot.health"), /ssh to duck@nowhere: .*ENOENT/);
    assert.equal(t.connected, false, "the rejected start must not be cached");
    await assert.rejects(() => t.call("robot.health"), /ENOENT/);
    assert.equal(await t.ping(), false);
    await t.close();
  });

  test("forwards all three daemon sockets into the local dir", () => {
    const args = SshTransport.forwardArgs("duck@host", ["-o", "X=y"], "/tmp/d");
    assert.deepEqual(args, [
      "-N",
      "-o",
      "X=y",
      "-L",
      "/tmp/d/robotd.sock:/run/robotd.sock",
      "-L",
      "/tmp/d/configd.sock:/run/configd.sock",
      "-L",
      "/tmp/d/updaterd.sock:/run/updaterd.sock",
      "duck@host",
    ]);
  });
});
