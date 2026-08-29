#!/usr/bin/env node
// Scripted version of the first demo conversation, driven through a real MCP
// client against the mock duck:  "check the duck's health, then make it walk
// forward and quack."  Run with `npm run demo`.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const client = new Client({ name: "demo", version: "0.0.0" });
await client.connect(
  new StdioClientTransport({
    command: "node",
    args: [join(root, "dist/index.js")],
    env: { ...process.env, DUCK_TRANSPORT: "mock" },
  }),
);

const tools = (await client.listTools()).tools.map((t) => t.name);
console.log("tools:", tools.join(", "), "\n");

async function call(name, args = {}) {
  console.log(`> ${name}(${JSON.stringify(args)})`);
  const r = await client.callTool({ name, arguments: args });
  console.log(r.content.map((c) => c.text).join("\n"), "\n");
  return r;
}

await call("duck_health");
await call("duck_walk", { vx: 0.15 });
await new Promise((r) => setTimeout(r, 400));
await call("duck_monitor");
await call("duck_behavior", { name: "quack" });
await call("duck_stop");
await client.close();
