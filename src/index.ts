#!/usr/bin/env node
/**
 * microduck-mcp — a Model Context Protocol server for the Pollen Robotics
 * Microduck. Agent-agnostic: works with any MCP client (Claude, ChatGPT,
 * Cursor, Gemini CLI, smolagents, ...). Transport is selected by env:
 *
 *   DUCK_TRANSPORT=mock            (default — no robot needed, canned state)
 *   DUCK_TRANSPORT=sim             (CPU MuJoCo + official ONNX policies; sim/setup.sh)
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
import { SimTransport } from "./transport/sim.js";
import { clampVelocity, preMotionCheck, LIMITS } from "./safety.js";

function pickTransport(): DuckTransport {
  switch (process.env.DUCK_TRANSPORT) {
    case "unix":
      return new UnixTransport();
    case "sim":
      return new SimTransport();
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
      `and ±${LIMITS.maxYawRate} rad/s yaw. The intent expires after ` +
      "duration_s (default 2 s, max 10 s) — robotd's deadman zeroes velocity " +
      "when intents stop arriving, so the duck stops on its own; it does not " +
      "run away. Call duck_monitor afterwards to see how far it got. Refused " +
      `below ${LIMITS.minBatteryForMotion * 100}% battery or when fallen.`,
    inputSchema: {
      vx: z.number().describe("Forward velocity, m/s. Negative = backward."),
      vy: z.number().default(0).describe("Sideways velocity, m/s."),
      wz: z.number().default(0).describe("Yaw rate, rad/s. Positive = left."),
      duration_s: z
        .number()
        .min(0.1)
        .max(10)
        .default(2)
        .describe("Seconds to keep walking before the intent expires."),
    },
  },
  async ({ vx, vy, wz, duration_s }) => {
    try {
      await preMotionCheck(duck);
      const v = clampVelocity(vx, vy ?? 0, wz ?? 0);
      return json(
        await duck.call("robotd", "robot.intent", { ...v, ttl_s: duration_s ?? 2 }),
      );
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
      "fall — on hardware a human picks the duck up; in sim it is set " +
      "upright in place), pickup (beak to floor, grab), kick, roulade " +
      "(forward roll), quack. Scripted moves take 0.5–3 s; call duck_monitor " +
      "to see when 'busy' clears. Battery- and health-gated like walking " +
      "(quack is free).",
    inputSchema: {
      name: z
        .enum(["sit", "stand", "getup", "pickup", "kick", "roulade", "quack"])
        .describe("Which behavior to run."),
    },
  },
  async ({ name }) => {
    try {
      // Quacking is free. getup is the recovery path and *must* be allowed
      // while the robot reports unhealthy/fallen, so it skips the health gate
      // but still runs the battery + rate checks.
      if (name === "getup") await preMotionCheck(duck, { allowUnhealthy: true });
      else if (name !== "quack") await preMotionCheck(duck);
      return json(await duck.call("robotd", "robot.behavior", { name }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "duck_camera",
  {
    title: "Duck camera",
    description:
      "A still frame of what the duck sees or looks like right now, returned " +
      "as a PNG image. view='head' is the robot's own head camera; 'follow' " +
      "(default), 'front', 'side' and 'top' are third-person views around the " +
      "robot. Read-only, never moves the robot. Available on the sim " +
      "transport today; on hardware it will come from mediad's WebRTC stream " +
      "(not wired yet) and the mock transport returns a placeholder.",
    inputSchema: {
      view: z
        .enum(["head", "follow", "front", "side", "top"])
        .default("follow")
        .describe("Which camera."),
      width: z.number().int().min(64).max(640).default(320),
      height: z.number().int().min(48).max(480).default(240),
    },
  },
  async ({ view, width, height }) => {
    try {
      const r = (await duck.call("robotd", "sim.camera", {
        view: view ?? "follow",
        width: width ?? 320,
        height: height ?? 240,
      })) as { png_base64?: string; width?: number; height?: number; note?: string };
      if (!r?.png_base64) {
        return fail(new Error("no frame available on this transport"));
      }
      const { png_base64, ...meta } = r;
      return {
        content: [
          { type: "image" as const, data: png_base64, mimeType: "image/png" },
          { type: "text" as const, text: JSON.stringify(meta) },
        ],
      };
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
