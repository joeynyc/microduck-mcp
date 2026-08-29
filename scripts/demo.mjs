#!/usr/bin/env node
// Scripted version of the first demo conversation, driven through a real MCP
// client:  "check the duck's health, then make it walk forward and quack."
// Run with `npm run demo` (mock) or `DUCK_TRANSPORT=sim npm run demo`
// (CPU MuJoCo — camera frames are written to $DUCK_DEMO_OUT or ./demo-out).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const client = new Client({ name: "demo", version: "0.0.0" });
await client.connect(
  new StdioClientTransport({
    command: "node",
    args: [join(root, "dist/index.js")],
    env: { DUCK_TRANSPORT: "mock", ...process.env },
  }),
);

const tools = (await client.listTools()).tools.map((t) => t.name);
console.log("tools:", tools.join(", "), "\n");

const outDir = process.env.DUCK_DEMO_OUT ?? join(root, "demo-out");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let frames = 0;

async function call(name, args = {}) {
  console.log(`> ${name}(${JSON.stringify(args)})`);
  const r = await client.callTool({ name, arguments: args });
  for (const c of r.content) {
    if (c.type === "image") {
      mkdirSync(outDir, { recursive: true });
      const f = join(outDir, `frame-${++frames}-${args.view ?? "follow"}.png`);
      writeFileSync(f, Buffer.from(c.data, "base64"));
      console.log(`[image ${c.mimeType} → ${f}]`);
    } else console.log(c.text);
  }
  console.log();
  return r;
}

const sim = process.env.DUCK_TRANSPORT === "sim";
await call("duck_health");
await call("duck_walk", { vx: 0.25, duration_s: sim ? 4 : 2 });
await sleep(sim ? 4200 : 400);
await call("duck_monitor");
await call("duck_camera", { view: "follow" });
if (sim) await call("duck_camera", { view: "head" });
await call("duck_behavior", { name: "quack" });
await call("duck_stop");
await client.close();
