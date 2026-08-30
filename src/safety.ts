import { HealthResult, M, Skill, SoundTag } from "./transport/protocol.js";
import { DuckTransport } from "./transport/types.js";

/**
 * Server-side guardrails. robotd has its own safety authority (joint clamps,
 * fall->limp, intent deadman) and nothing here replaces it — but this server
 * is agent-agnostic by design, so it assumes NOTHING about how careful the
 * calling model is. Belt and suspenders.
 */

export const LIMITS = {
  /** m/s — conservative cap well under the policy's own envelope. */
  maxLinearVelocity: 0.25,
  /** rad/s yaw cap. */
  maxYawRate: 1.0,
  /** Refuse motion commands below this battery fraction. */
  minBatteryForMotion: 0.15,
  /** Min ms between motion-issuing tool calls. */
  motionCooldownMs: 250,
} as const;

/**
 * What each agent-facing behavior is on the wire, and how it is gated.
 * Gates: "motion" = full preMotionCheck; "recovery" = preMotionCheck with
 * allowUnhealthy (a fallen robot is unhealthy by definition, and refusing the
 * one command that fixes that would strand it); "none" = never gated.
 * The tool enum is derived from this table so adding a behavior is one edit.
 */
export const BEHAVIORS = {
  sit: { gate: "motion", method: M.robotDo, params: { skill: "sit_toggle" satisfies Skill } },
  stand: { gate: "motion", method: M.robotDo, params: { skill: "sit_toggle" satisfies Skill } },
  /** robot.init powers the joints and ramps to the home pose. On hardware a
   *  human rights the robot first; in sim it is set upright in place. */
  getup: { gate: "recovery", method: M.robotInit, params: {} },
  pickup: { gate: "motion", method: M.robotDo, params: { skill: "ground_pick" satisfies Skill } },
  kick: { gate: "motion", method: M.robotDo, params: { skill: "kick_right" satisfies Skill } },
  roulade: { gate: "motion", method: M.robotDo, params: { skill: "roulade" satisfies Skill } },
  quack: { gate: "none", method: M.robotSound, params: { tag: "chirp" satisfies SoundTag } },
} as const satisfies Record<string, { gate: "motion" | "recovery" | "none"; method: string; params: object }>;
export type Behavior = keyof typeof BEHAVIORS;
export const BEHAVIOR_NAMES = Object.keys(BEHAVIORS) as [Behavior, ...Behavior[]];

export async function preBehaviorCheck(t: DuckTransport, name: Behavior): Promise<void> {
  const gate = BEHAVIORS[name].gate;
  if (gate === "none") return;
  await preMotionCheck(t, { allowUnhealthy: gate === "recovery" });
}

let lastMotionAt = 0;
/** Bumped by stopWalk(); an in-flight walk() ends when it changes. */
let walkEpoch = 0;

/** Clear the motion cooldown. Intended for tests; never call from a tool. */
export function resetMotionCooldown(): void {
  lastMotionAt = 0;
}

export type Twist = { vx: number; vy: number; vyaw: number };

export function clampVelocity(vx: number, vy: number, vyaw: number): Twist {
  const clamp = (v: number, lim: number) => Math.max(-lim, Math.min(lim, v));
  return {
    vx: clamp(vx, LIMITS.maxLinearVelocity),
    vy: clamp(vy, LIMITS.maxLinearVelocity),
    vyaw: clamp(vyaw, LIMITS.maxYawRate),
  };
}

/**
 * Drive a velocity intent for `durationS`, transport-independently: robotd's
 * `robot.move` is a deadman-stamped intent, so a walk of any length is a
 * stream of intents followed by a stop. Re-sends every `intervalMs`, then
 * sends robot.stop. Returns early if stopWalk() is called (duck_stop) or the
 * transport refuses an intent (fallen, unreachable).
 */
export async function walk(
  t: DuckTransport,
  v: Twist,
  durationS: number,
  intervalMs = 250,
): Promise<{ applied: Twist; result: unknown; duration_s: number; interrupted: boolean }> {
  const epoch = ++walkEpoch;
  const result = await t.call("robotd", M.robotMove, v);
  const until = Date.now() + durationS * 1000;
  let interrupted = false;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, Math.min(intervalMs, until - Date.now())));
    if (walkEpoch !== epoch) {
      interrupted = true;
      break;
    }
    if (Date.now() < until) await t.call("robotd", M.robotMove, v);
  }
  if (!interrupted) await t.call("robotd", M.robotStop);
  return { applied: v, result, duration_s: durationS, interrupted };
}

/** End any in-flight walk() loop. duck_stop calls this before robot.stop. */
export function stopWalk(): void {
  walkEpoch++;
}

/**
 * Throws with an agent-readable reason if motion should not be issued.
 * `allowUnhealthy` is for recovery behaviors (getup): a fallen robot is by
 * definition unhealthy, and refusing the one command that fixes that would
 * strand it. Battery floor and rate limit still apply.
 */
export async function preMotionCheck(
  t: DuckTransport,
  opts: { allowUnhealthy?: boolean } = {},
): Promise<void> {
  const now = Date.now();
  if (now - lastMotionAt < LIMITS.motionCooldownMs) {
    throw new Error(
      `Rate limited: wait ${LIMITS.motionCooldownMs}ms between motion commands.`,
    );
  }
  const health = (await t.call("robotd", M.robotHealth)) as HealthResult;
  const pct = health?.battery?.percent;
  if (typeof pct === "number" && pct / 100 < LIMITS.minBatteryForMotion) {
    throw new Error(
      `Battery at ${pct.toFixed(0)}% — below the ${
        LIMITS.minBatteryForMotion * 100
      }% motion floor. Charge the duck. (Note: 0% is the hardware cutoff ` +
        `where robotd sits the robot down; this floor keeps margin above it.)`,
    );
  }
  if (health?.healthy === false && !opts.allowUnhealthy) {
    throw new Error(
      `Robot reports unhealthy (${health?.reason ?? `mode: ${health?.mode ?? "unknown"}`}). ` +
        `Run duck_health for details before commanding motion.`,
    );
  }
  lastMotionAt = now;
}
