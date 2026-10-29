import { HealthResult, M, PoliciesResult, Skill, SoundTag } from "./transport/protocol.js";
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
/** The walk's robot.move that is on the wire right now, if any. */
let inFlightIntent: Promise<unknown> | undefined;

function sendIntent(t: DuckTransport, v: Twist): Promise<unknown> {
  const p = t.call(M.robotMove, v);
  inFlightIntent = p;
  const clear = () => {
    if (inFlightIntent === p) inFlightIntent = undefined;
  };
  p.then(clear, clear);
  return p;
}

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
 * robotd zeroes the velocity when the newest intent is older than its
 * `safety.deadman_ms`, 500 by default (upstream robotd-params). Re-sends are
 * scheduled on a fixed grid from the first send, so a slow round trip (a fresh
 * connection over ssh on wifi) eats into the margin instead of adding to the
 * period — at 200 ms one whole intent can be lost before the duck stalls.
 */
export const WALK_RESEND_MS = 200;

/**
 * How often an in-flight walk() samples state for a pick-up. robotd pauses
 * the policy within ~100 ms of being lifted and holds the pause at least
 * 300 ms before it can hand back, so a 100 ms sample cannot miss the window.
 */
export const HELD_WATCH_MS = 100;

/**
 * Drive a velocity intent for `durationS`, transport-independently: robotd's
 * `robot.move` is a deadman-stamped intent, so a walk of any length is a
 * stream of intents followed by a stop. Re-sends every `intervalMs`, then
 * sends robot.stop. Returns early if stopWalk() is called (duck_stop) or the
 * transport refuses an intent (fallen, unreachable).
 *
 * Alongside the stream it samples state every `watchMs`: robotd keeps the
 * intent while someone holds the duck and resumes it on set-down, so a
 * pick-up ends the walk (with a robot.stop) rather than letting it carry on
 * out of their hands. The watcher runs beside the resend grid, never on it,
 * so a slow sample cannot stretch the period the deadman sees.
 */
export async function walk(
  t: DuckTransport,
  v: Twist,
  durationS: number,
  intervalMs = WALK_RESEND_MS,
  watchMs = HELD_WATCH_MS,
): Promise<{
  applied: Twist;
  result: unknown;
  duration_s: number;
  interrupted: boolean;
  stopped_because?: "picked_up";
}> {
  const epoch = ++walkEpoch;
  const started = Date.now();
  // Resolved when the watcher sees a pick-up or the walk ends; every sleep
  // below races it, so a pick-up is acted on now, not at the next grid tick.
  let wake!: () => void;
  const woken = new Promise<void>((r) => (wake = r));
  const sleep = (ms: number) => {
    if (ms <= 0) return Promise.resolve();
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([new Promise<void>((r) => (timer = setTimeout(r, ms))), woken]).finally(() =>
      clearTimeout(timer),
    );
  };
  let walking = true;
  let held = false;
  // Never awaited: it cannot throw, and a slow sample (ssh, a stalled robotd)
  // must not hold up the robot.stop below. It exits at its next check.
  void (async () => {
    while (walking) {
      try {
        if ((await t.state())?.safety?.picked_up === true) {
          held = true;
          wake();
          return;
        }
      } catch {
        // A failed sample is not a reason to stop; a failed intent is, and
        // the stream below raises that itself.
      }
      await sleep(watchMs);
    }
  })();

  let interrupted = false;
  let result: unknown;
  try {
    result = await sendIntent(t, v);
    const until = started + durationS * 1000;
    for (let next = started + intervalMs; next < until && !held; next += intervalMs) {
      await sleep(next - Date.now());
      if (walkEpoch !== epoch) {
        interrupted = true;
        break;
      }
      if (held) break;
      await sendIntent(t, v);
    }
    if (!interrupted && !held) {
      await sleep(until - Date.now());
      if (walkEpoch !== epoch) interrupted = true;
    }
  } catch (e) {
    // A refused or timed-out intent ends the walk. robotd's deadman would
    // zero it within 500 ms anyway; say it explicitly, best effort. Not after
    // stopWalk(): duck_stop owns that stop.
    if (walkEpoch === epoch) await t.call(M.robotStop).catch(() => {});
    throw e;
  } finally {
    walking = false;
    wake();
  }
  // After the last intent has been answered, so the stop cannot overtake it
  // on a transport that opens a connection per call.
  if (!interrupted) await t.call(M.robotStop);
  return {
    applied: v,
    result,
    duration_s: durationS,
    interrupted,
    ...(held ? { stopped_because: "picked_up" as const } : {}),
  };
}

/**
 * End any in-flight walk() loop. Returns the intent it still has on the
 * wire, if any (see stopMotion).
 */
export function stopWalk(): Promise<unknown> | undefined {
  walkEpoch++;
  return inFlightIntent;
}

/**
 * What duck_stop does: end the walk loop and zero motion now. A robot.move
 * already on the wire can still reach robotd after this robot.stop — the unix
 * and ssh transports open a connection per call, so nothing orders the two —
 * and it would walk the duck again until the deadman. So once that intent has
 * been answered, the stop is sent a second time. The first stop never waits.
 */
export async function stopMotion(t: DuckTransport): Promise<unknown> {
  const inFlight = stopWalk();
  const result = await t.call(M.robotStop);
  if (inFlight) {
    await inFlight.catch(() => {});
    await t.call(M.robotStop);
  }
  return result;
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
  // Take the slot before the round trips below: two calls issued in parallel
  // (clients do batch tool calls) would otherwise both pass the check above
  // and both reach the robot. A refusal hands the slot back.
  const previous = lastMotionAt;
  lastMotionAt = now;
  try {
    await motionAllowed(t, opts);
  } catch (e) {
    if (lastMotionAt === now) lastMotionAt = previous;
    throw e;
  }
}

async function motionAllowed(t: DuckTransport, opts: { allowUnhealthy?: boolean }): Promise<void> {
  const health = (await t.call(M.robotHealth)) as HealthResult;
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
  // robotd pauses the policy while the duck is in someone's hand but keeps
  // the intent, and resumes ~0.2 s after it is set down — so a walk started
  // now would carry on out of their hands. Recovery is exempt: on hardware a
  // human is holding the duck to right it.
  if (!opts.allowUnhealthy && (await t.state())?.safety?.picked_up === true) {
    throw new Error(
      `Someone is holding the duck (robotd's pick-up detector has paused the policy). ` +
        `Wait until it is set down before commanding motion.`,
    );
  }
}

/**
 * Whether the duck is in its seat, which decides what `sit_toggle` does.
 * Upstream publishes this as `robot.policies.sitting`; a daemon too old to
 * say (or the sim, which has no policy channel) falls back to the frame's
 * label, which reads "sit" while seated.
 */
export async function isSeated(t: DuckTransport): Promise<boolean> {
  try {
    const p = (await t.call(M.robotPolicies)) as PoliciesResult | null;
    if (typeof p?.sitting === "boolean") return p.sitting;
  } catch {
    // Older daemon: METHOD_NOT_FOUND. The frame still answers.
  }
  return (await t.state()).policy === "sit";
}
