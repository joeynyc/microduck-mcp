#!/usr/bin/env node
// Record a demo: a headless Claude Code session (`claude -p`, stream-json in
// and out) drives this MCP server in sim mode while the sidecar captures the
// duck at 30 fps. Everything the agent says and every tool call/result is
// logged with wall-clock timestamps so scripts/compose-demo.py can build the
// split-screen video.
//
//   node scripts/record-demo.mjs <out-dir> [shot-list.json]
//
// The shot list is an array of user turns (strings); default is the one in
// docs/demo-script.md. Requires `claude` on PATH and a logged-in account.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, createWriteStream } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(process.argv[2] ?? "demo-rec");
const shots = process.argv[3]
  ? JSON.parse(readFileSync(process.argv[3], "utf8"))
  : [
      "Check the duck's health and tell me if it's safe to move.",
      "Walk forward for 8 seconds, then show me what the duck sees through its head camera.",
      "Now sprint forward at 2 m/s for 3 seconds.",
      "Sit down, then quack.",
      "Stand up, then do a forward roll and check whether it landed on its feet.",
      "Stop the duck and give me a one-line summary of what it did.",
    ];
const pauseMs = Number(process.env.DEMO_PAUSE_MS ?? 2500);

mkdirSync(out, { recursive: true });
const mcpConfig = join(out, "mcp.json");
writeFileSync(
  mcpConfig,
  JSON.stringify({
    mcpServers: {
      microduck: {
        command: process.execPath,
        args: [join(root, "dist", "index.js")],
        env: {
          DUCK_TRANSPORT: "sim",
          DUCK_SIM_RECORD: join(out, "frames"),
          DUCK_SIM_RECORD_FPS: "30",
          DUCK_SIM_RECORD_SIZE: "640x480",
          DUCK_SIM_RECORD_VIEW: process.env.DEMO_VIEW ?? "follow",
          DUCK_SIM_RECORD_DISTANCE: process.env.DEMO_DISTANCE ?? "0.9",
        },
      },
    },
  }),
);

const events = createWriteStream(join(out, "events.jsonl"));
const log = (type, data) => {
  const e = { t: Date.now() / 1000, type, ...data };
  events.write(JSON.stringify(e) + "\n");
  const brief = JSON.stringify(data).slice(0, 110);
  console.error(`[${new Date().toISOString().slice(11, 19)}] ${type} ${brief}`);
};

const claude = spawn(
  "claude",
  [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--strict-mcp-config",
    "--mcp-config", mcpConfig,
    "--allowedTools", "mcp__microduck__*",
    "--max-turns", "40",
    "--append-system-prompt",
      "You are operating a small biped robot (a Pollen Robotics Microduck) through MCP tools. " +
      "Narrate briefly before each action in one short sentence, then act. Keep replies to two sentences.",
  ],
  { cwd: root, stdio: ["pipe", "pipe", "pipe"] },
);
createInterface({ input: claude.stderr }).on("line", (l) => console.error(`[claude] ${l}`));

let resolveTurn;
createInterface({ input: claude.stdout }).on("line", (line) => {
  if (!line.trim()) return;
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    return;
  }
  const content = e.message?.content;
  if (e.type === "assistant" && Array.isArray(content)) {
    for (const c of content) {
      if (c.type === "text" && c.text.trim()) log("assistant", { text: c.text });
      else if (c.type === "tool_use" && c.name.startsWith("mcp__microduck__"))
        log("tool_use", { id: c.id, name: c.name.replace("mcp__microduck__", ""), input: c.input });
    }
  } else if (e.type === "user" && Array.isArray(content)) {
    for (const c of content) {
      if (c.type !== "tool_result") continue;
      const parts = Array.isArray(c.content) ? c.content : [{ type: "text", text: String(c.content ?? "") }];
      const text = parts.filter((p) => p.type === "text").map((p) => p.text).join("\n");
      const img = parts.find((p) => p.type === "image");
      const image = img?.source?.data ?? img?.data ?? null;
      if (text.includes("tool_reference")) continue; // ToolSearch plumbing, not a robot call
      log("tool_result", { id: c.tool_use_id, is_error: !!c.is_error, text, image });
    }
  } else if (e.type === "result") {
    log("result", { subtype: e.subtype, cost_usd: e.total_cost_usd, turns: e.num_turns });
    resolveTurn?.();
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const turn = (text) =>
  new Promise((res) => {
    resolveTurn = res;
    log("user", { text });
    claude.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n");
  });

for (const [i, shot] of shots.entries()) {
  await turn(shot);
  if (i < shots.length - 1) await sleep(pauseMs);
}
log("end", {});
claude.stdin.end();
await new Promise((r) => claude.on("exit", r));
events.end();
console.error(`recorded → ${out}`);
