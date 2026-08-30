// Fake sim sidecar for SimTransport contract tests: the same line-delimited
// JSON-RPC the Python sidecar speaks, with no MuJoCo. `argv[2]` picks a
// failure mode: ok (default) | crash | missing-assets | never-ready.
import { createInterface } from "node:readline";

const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const mode = process.argv[2] ?? "ok";

if (mode === "crash") process.exit(3);
if (mode === "missing-assets") {
  send({ jsonrpc: "2.0", method: "sim.error", params: { message: "assets missing" } });
  process.exit(2);
}
if (mode !== "never-ready") {
  send({ jsonrpc: "2.0", method: "sim.ready", params: { policies: ["walk"], hz: 50 } });
}
process.stderr.write("fake sidecar up\n");

const handlers = {
  "robot.health": () => ({ healthy: true, mode: "standing", battery: { fraction: 0.8 } }),
  "robot.intent": (p) => ({ applied: p, ttl_s: p.ttl_s ?? 2 }),
  "sim.camera": (p) => ({ png_base64: "iVBORw0KGgo=", width: p.width ?? 1, height: p.height ?? 1, view: p.view }),
  slow: () => undefined, // never answers
};

createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  const h = handlers[method];
  if (!h) return send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
  const result = h(params ?? {});
  if (result !== undefined) send({ jsonrpc: "2.0", id, result });
});
