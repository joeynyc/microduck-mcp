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
import { DAEMON_COMPONENT, M, OFFICIAL_HF_ORG, POLICY_SLOTS } from "./transport/protocol.js";
import { listPolicies, loadPolicy, resetPolicy } from "./policy.js";
import { MockTransport } from "./transport/mock.js";
import { UnixTransport } from "./transport/unix.js";
import { SshTransport } from "./transport/ssh.js";
import { SimTransport } from "./transport/sim.js";
import {
  BEHAVIORS,
  BEHAVIOR_NAMES,
  clampVelocity,
  LIMITS,
  preBehaviorCheck,
  preMotionCheck,
  stopWalk,
  walk,
} from "./safety.js";

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
      "Full hardware+software health report: battery (volts and percent), " +
      "control-loop rate, servo/board temperatures, loaded policy, and " +
      "whether the robot considers itself healthy. Read-only and always " +
      "safe to call. Call this FIRST in any session, and again before any " +
      "sequence of motion commands.",
    inputSchema: {},
  },
  async () => {
    try {
      return json(await duck.call("robotd", M.robotHealth));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "duck_version",
  {
    title: "Duck identity and uptime",
    description: "The robot's name, serial and uptime (configd system.info). Read-only.",
    inputSchema: {},
  },
  async () => {
    try {
      return json(await duck.call("configd", M.systemInfo));
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
      "Installed daemon releases and which one is active/golden. Read-only. " +
      "(Installing/rolling back is deliberately NOT exposed as a tool yet — " +
      "see CLAUDE.md 'Deliberately excluded'.)",
    inputSchema: {},
  },
  async () => {
    try {
      return json(await duck.call("updaterd", M.updateListInstalled, { component: DAEMON_COMPONENT }));
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
      "One robot.state frame: which policy is driving, the velocity requested " +
      "vs applied (and what limited it), joints, gravity in the body frame " +
      "(≈[0,0,-1] when upright — a large X or Y component means it has " +
      "fallen), odometry, and the safety flags (fallen, limp, busy). Read-only " +
      "and always safe to call. Use it to confirm a walk actually moved the " +
      "robot, or to check posture before/after a behavior. For battery and " +
      "temps use duck_health.",
    inputSchema: {},
  },
  async () => {
    try {
      return json(await duck.state());
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
  async (req) => {
    try {
      if (!duck.snapshot) {
        return fail(new Error(`no camera on the ${process.env.DUCK_TRANSPORT ?? "mock"} transport`));
      }
      const { png_base64, ...meta } = await duck.snapshot(req);
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
  "duck_policy_list",
  {
    title: "List policy slots",
    description:
      "What each of the seven policy slots (walk, stand, sitstand, " +
      "ground_pick, kick_left, kick_right, roulade) is currently running, with " +
      "its ORIGIN and version. Origin is decided by the Hugging Face org that " +
      `published it: '${OFFICIAL_HF_ORG}/*' is official, any other HF repo is ` +
      "community, a path on the board is local. Only official policies are what " +
      "duck_policy_reset returns to. Read-only and always safe to call — call " +
      "it before and after duck_policy_load so you can see what changed. " +
      "Needs a daemon on API_VERSION 17 or newer.",
    inputSchema: {},
  },
  async () => {
    try {
      return json({ slots: await listPolicies(duck) });
    } catch (e) {
      return fail(e);
    }
  },
);

// ---- Policy tools (guarded) ------------------------------------------------
//
// Deliberately NOT exposed: `policy update` and `policy check` from §7 of
// upstream's policy-channel-design.md, and anything else that fetches "the
// newest" and applies it. Same stance as `update.apply` (CLAUDE.md
// "Deliberately excluded"): an agent that can auto-apply new code or new
// weights onto hardware is a footgun, and which version to run is a decision a
// human makes. load + reset is the safe pair precisely because reset is a
// one-word undo — every load an agent makes is trivially reversible, which is
// what makes trying a stranger's gait a reasonable thing to do at all.

server.registerTool(
  "duck_policy_load",
  {
    title: "Load a policy into a slot",
    description:
      "Put a different ONNX policy in one slot. source is a Hugging Face repo " +
      "('org/name', optionally 'org/name@revision'), a name already in the " +
      "robot's policy library, or an absolute path to a .onnx on the board. " +
      `ORIGIN follows the HF org: '${OFFICIAL_HF_ORG}/*' is official, any other ` +
      "repo is community (unsigned, never auto-updated, never a reset target), " +
      "and a path is local. Before an HF repo is fetched its manifest.json is " +
      "read and the load is refused early if it declares a different " +
      "observation/action width or needs a newer daemon — but a repo with no " +
      "manifest is still accepted, because most of the Hub publishes none; " +
      "robotd's own shape gate is the real check. source='none' switches a slot " +
      "off — allowed for every slot EXCEPT walk, which the others fall back to. " +
      "The change is written to the robot's config, so it SURVIVES A REBOOT: " +
      "duck_policy_reset is the undo. A load that fails to build keeps the " +
      "policy that was already running. Battery- and health-gated like motion.",
    inputSchema: {
      slot: z.enum(POLICY_SLOTS).describe("Which of the seven slots to fill."),
      source: z
        .string()
        .min(1)
        .describe("HF repo 'org/name[@rev]', a library name, a path on the board, or 'none'."),
    },
  },
  async ({ slot, source }) => {
    try {
      // A load homes the robot and rebuilds every ONNX session under the
      // running 50 Hz loop (§4), so it is motion in every sense that matters
      // to this server's safety layer, and it is gated like motion.
      await preMotionCheck(duck);
      return json(await loadPolicy(duck, slot, source));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "duck_policy_reset",
  {
    title: "Reset policy slots to official",
    description:
      "Undo a duck_policy_load: remove the override on one slot, or on all " +
      "seven when no slot is given ('put it back the way it came'). The slot " +
      "goes back to the official policy for that role — official is the only " +
      "origin reset returns to, and a community or local policy is never a " +
      "reset target. Resetting a slot nobody overrode is a no-op that queues no " +
      "work. This is the one-word undo for anything duck_policy_load did, " +
      "including a load that survived a reboot; reach for it whenever a gait " +
      "misbehaves and you are not sure why. Battery- and health-gated like motion.",
    inputSchema: {
      slot: z
        .enum(POLICY_SLOTS)
        .optional()
        .describe("Which slot to reset. Omit to reset all seven."),
    },
  },
  async ({ slot }) => {
    try {
      await preMotionCheck(duck);
      return json(await resetPolicy(duck, slot));
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
      `and ±${LIMITS.maxYawRate} rad/s yaw. Walks for duration_s (default ` +
      "2 s, max 10 s) then stops; the call returns when the walk is over. " +
      "duck_stop interrupts it at any time, and robotd's own deadman stops " +
      "the duck if this server dies mid-walk — it does not run away. Call " +
      "duck_monitor afterwards to see how far it got. Refused below " +
      `${LIMITS.minBatteryForMotion * 100}% battery or when fallen.`,
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
      return json(await walk(duck, clampVelocity(vx, vy, wz), duration_s));
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
      "Trigger a named built-in behavior: sit, stand, getup (power the joints " +
      "and rise to the home pose after a fall — on hardware a human rights " +
      "the duck first; in sim it is set upright in place), pickup (beak to " +
      "floor, grab), kick, roulade (forward roll), quack. sit/stand are " +
      "no-ops if already in that posture. Scripted moves take 0.5–3 s; call " +
      "duck_monitor to see when 'busy' clears. Battery- and health-gated " +
      "like walking (quack is free).",
    inputSchema: {
      name: z.enum(BEHAVIOR_NAMES).describe("Which behavior to run."),
    },
  },
  async ({ name }) => {
    try {
      await preBehaviorCheck(duck, name);
      // Upstream's sit↔stand is one toggle; the daemon knows which way. We
      // check the frame so "sit" while seated doesn't stand the duck up.
      if (name === "sit" || name === "stand") {
        const seated = (await duck.state()).policy === "sit";
        if (seated === (name === "sit")) {
          return json({ behavior: name, started: false, note: `already ${name === "sit" ? "sitting" : "standing"}` });
        }
      }
      const { method, params } = BEHAVIORS[name];
      const result = await duck.call("robotd", method, { ...params });
      return json({ behavior: name, started: true, wire: { method, params }, result });
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
      stopWalk();
      return json(await duck.call("robotd", M.robotStop));
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
