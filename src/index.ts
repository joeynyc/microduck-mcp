#!/usr/bin/env node
/**
 * microduck-mcp — a Model Context Protocol server for the Pollen Robotics
 * Microduck. Agent-agnostic: works with any MCP client (Claude, ChatGPT,
 * Cursor, Gemini CLI, smolagents, ...). Transport is selected by env:
 *
 *   DUCK_TRANSPORT=mock            (default — no robot needed)
 *   DUCK_TRANSPORT=unix            (running on the robot)
 *   DUCK_TRANSPORT=ssh DUCK_HOST=duck@microduck.local
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DuckTransport } from "./transport/types.js";
import { MockTransport } from "./transport/mock.js";
import { UnixTransport } from "./transport/unix.js";
import { SshTransport } from "./transport/ssh.js";
import { clampVelocity, preMotionCheck, LIMITS } from "./safety.js";

function pickTransport(): DuckTransport {
  switch (process.env.DUCK_TRANSPORT) {
    case "unix":
      return new UnixTransport();
    case "ssh": {
      const host = process.env.DUCK_HOST;
      if (!host) throw new Error("DUCK_TRANSPORT=ssh requires DUCK_HOST");
      return new SshTransport(host);
    }
    default:
      return new MockTransport();
  }
}

const duck = pickTransport();
const server = new McpServer({ name: "microduck-mcp", version: "0.1.0" });

const json = (v: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }],
});
const fail = (e: unknown) => ({
  content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }],
  isError: true,
});

// ---- Read-only tools -------------------------------------------------------

server.registerTool(
  "duck_health",
  {
    title: "Duck health",
    description:
      "Full hardware+software health report: battery (fraction and volts), " +
      "control-loop rate, servo/board temperatures, loaded policy, and " +
      "whether the robot considers itself healthy. Read-only and always " +
      "safe to call. Call this FIRST in any session, and again before any " +
      "sequence of motion commands.",
    inputSchema: {},
  },
  async () => {
    try {
      return json(await duck.call("robotd", "robot.health"));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "duck_version",
  {
    title: "Duck software version",
    description:
      "What every daemon is running vs what is installed. Read-only. Useful " +
      "after updates: a daemon serving old code looks exactly like a bug.",
    inputSchema: {},
  },
  async () => {
    try {
      return json(await duck.call("configd", "system.version"));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "duck_updates",
  {
    title: "List installed releases",
    description:
      "Installed software releases and which one is current. Read-only. " +
      "(Installing/rolling back is deliberately NOT exposed as a tool yet — " +
      "see CLAUDE.md 'Deliberately excluded'.)",
    inputSchema: {},
  },
  async () => {
    try {
      return json(await duck.call("updaterd", "update.list"));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "duck_monitor",
  {
    title: "Duck state sample",
    description:
      "One-shot snapshot of the robot's physical state: every joint's " +
      "position/velocity/temperature, the gravity vector in the body frame " +
      "(≈[0,0,9.81] when upright — a large X or Y component means it has " +
      "fallen), gyro, odometry (x, y, yaw since boot), and the velocity " +
      "intent currently applied. Read-only and always safe to call. Use it " +
      "to confirm a walk actually moved the robot, or to check posture " +
      "before/after a behavior. For battery and temps use duck_health.",
    inputSchema: {},
  },
  async () => {
    try {
      return json(await duck.call("robotd", "robot.state"));
    } catch (e) {
      return fail(e);
    }
  },
);

// ---- Motion tools (guarded) ------------------------------------------------

server.registerTool(
  "duck_walk",
  {
    title: "Walk the duck",
    description:
      "Send a velocity intent: vx forward m/s, vy sideways m/s, wz yaw " +
      `rad/s. Values are clamped to ±${LIMITS.maxLinearVelocity} m/s linear ` +
      `and ±${LIMITS.maxYawRate} rad/s yaw. robotd's own deadman zeroes ` +
      "velocity if intents stop arriving, so the duck stops on its own if " +
      "you stop calling this — it does not run away. Refused below " +
      `${LIMITS.minBatteryForMotion * 100}% battery.`,
    inputSchema: {
      vx: z.number().describe("Forward velocity, m/s. Negative = backward."),
      vy: z.number().default(0).describe("Sideways velocity, m/s."),
      wz: z.number().default(0).describe("Yaw rate, rad/s. Positive = left."),
    },
  },
  async ({ vx, vy, wz }) => {
    try {
      await preMotionCheck(duck);
      const v = clampVelocity(vx, vy ?? 0, wz ?? 0);
      return json(await duck.call("robotd", "robot.intent", v));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "duck_behavior",
  {
    title: "Run a behavior",
    description:
      "Trigger a named built-in behavior: sit, stand, getup (recover from a " +
      "fall), pickup (beak to floor, grab), kick, quack. Battery- and " +
      "health-gated like walking.",
    inputSchema: {
      name: z
        .enum(["sit", "stand", "getup", "pickup", "kick", "quack"])
        .describe("Which behavior to run."),
    },
  },
  async ({ name }) => {
    try {
      if (name !== "quack") await preMotionCheck(duck); // quacking is free
      return json(await duck.call("robotd", "robot.behavior", { name }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "duck_stop",
  {
    title: "STOP the duck",
    description:
      "Immediately zero all motion intents. NEVER gated, never rate-limited " +
      "— always available. Call this if anything looks wrong, if a human " +
      "asks you to stop, or if you are unsure what the robot is doing.",
    inputSchema: {},
  },
  async () => {
    try {
      return json(await duck.call("robotd", "robot.stop"));
    } catch (e) {
      return fail(e);
    }
  },
);

// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `microduck-mcp up (transport: ${process.env.DUCK_TRANSPORT ?? "mock"})`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
