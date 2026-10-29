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
/**
 * Every robot.move sent but not yet answered. walk() pipelines its intents —
 * a slow round trip must not push the next send off its grid — so several can
 * be on the wire at once, and a stop sent before they settle could be
 * overtaken by one (the unix/ssh transports open a connection per call).
 * stopWalk() hands the set to stopMotion; walk() drains it before its own
 * robot.stop.
 */
const inFlightIntents = new Set<Promise<unknown>>();

function sendIntent(t: DuckTransport, v: Twist): Promise<unknown> {
  const p = t.call(M.robotMove, v);
  inFlightIntents.add(p);
  const clear = () => {
    inFlightIntents.delete(p);
  };
  p.then(clear, clear);
  return p;
}

/**
 * The second robot.stop: once every intent that was on the wire beside the
 * first stop has been answered, none of them can still overtake it.
 * robot.stop is idempotent, so the repeat costs nothing.
 */
async function restopAfter(t: DuckTransport, drain: Promise<unknown>): Promise<unknown> {
  await drain.catch(() => {});
  return t.call(M.robotStop);
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
  // The grid runs on the monotonic clock. On Date.now() a wall-clock step
  // (NTP, WSL2 resyncing its clock, resume from sleep) ended a 10 s walk
  // 1.2 s early in the walk-link bench, and a backward step would sleep past
  // the deadman or burst catch-up intents.
  const started = performance.now();
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
  const seeHeld = (frame: { safety?: { picked_up?: boolean } } | undefined) => {
    if (frame?.safety?.picked_up === true) {
      held = true;
      wake();
    }
  };
  // Detection prefers the daemon's own stream: robot.subscribe pushes
  // robot.state at 50Hz, so a pick-up is seen one leg after it happens —
  // no request round trip, no waiting for a poll's turn. lastFrameAt is the
  // stream's heartbeat for the poll backstop below.
  let lastFrameAt = -Infinity; // ms since started; -Infinity = no frames yet
  const unsub = t.watchState?.((frame) => {
    lastFrameAt = performance.now() - started;
    seeHeld(frame);
  });
  void (async () => {
    // Backstop for transports without watchState and for a stream that dies
    // silently: poll only once no frame has arrived for half a second —
    // while the subscription lives it costs nothing to leave this asleep.
    // Cap pending samples at 3, same reason as before: a stalled robotd must
    // not have a socket queued against it every interval. The first sample
    // goes out immediately — a pick-up inside the first interval should not
    // wait a grid tick.
    let pending = 0;
    const sample = () => {
      if (pending >= 3) return;
      pending++;
      t.state().then(
        (frame) => {
          pending--;
          seeHeld(frame);
        },
        () => {
          // A failed sample is not a reason to stop; a failed intent is,
          // and the stream below raises that itself.
          pending--;
        },
      );
    };
    // One immediate poll regardless: it covers the window where the stream
    // is still opening (or was refused) — later polls fire only while the
    // stream stays quiet.
    sample();
    for (let next = started + watchMs; walking && !held; next += watchMs) {
      if (!unsub || performance.now() - started - lastFrameAt > 500) sample();
      await sleep(next - performance.now());
    }
  })();

  let interrupted = false;
  let result: unknown;
  let first: Promise<unknown> | undefined;
  /** The first intent rejection; ends the walk like the awaited version did. */
  let failure: unknown;
  const fail = (e: unknown) => {
    if (failure === undefined) {
      failure = e;
      wake();
    }
  };
  try {
    // Sends stay strictly on the grid: a send is NOT awaited here, because a
    // round trip longer than the interval (wifi spikes) would serialise the
    // stream on responses and stretch the gap robotd's deadman sees. The
    // first rejection still ends the walk — via `failure`, not an await.
    first = sendIntent(t, v);
    first.catch(fail);
    const until = started + durationS * 1000;
    for (let next = started + intervalMs; next < until && !held; next += intervalMs) {
      await sleep(next - performance.now());
      if (walkEpoch !== epoch) {
        interrupted = true;
        break;
      }
      if (held || failure !== undefined) break;
      sendIntent(t, v).catch(fail);
    }
    if (!interrupted && !held && failure === undefined) {
      await sleep(until - performance.now());
      if (walkEpoch !== epoch) interrupted = true;
    }
    // A rejected intent ends the walk with that error (the awaited version
    // threw it from sendIntent itself). The walk's result is the first
    // intent's answer — awaited AFTER the stops below: a stop must never
    // wait on an intent's round trip.
    if (failure !== undefined) throw failure;
  } catch (e) {
    // A refused or timed-out intent ends the walk. robotd's deadman would
    // zero it within 500 ms anyway; say it explicitly, best effort. Same
    // shape as a normal end — one stop now, one after outstanding intents
    // answer — so a late intent cannot overtake the only stop it saw. Not
    // after stopWalk(): duck_stop owns that stop.
    if (walkEpoch === epoch) {
      // Best effort throughout: the walk is already failing with `e`.
      const hadInFlight = inFlightIntents.size > 0;
      const stop = t.call(M.robotStop).catch(() => {});
      if (hadInFlight) await restopAfter(t, Promise.allSettled([...inFlightIntents])).catch(() => {});
      await stop;
    }
    throw e;
  } finally {
    walking = false;
    unsub?.();
    wake();
  }
  // duck_stop's own pattern: the stop goes out now, and once every intent
  // has been answered it goes out again — on a transport that opens a
  // connection per call the first could still be overtaken by an intent on
  // the wire. Nothing in flight → nothing can overtake it → no re-stop.
  if (!interrupted) {
    const hadInFlight = inFlightIntents.size > 0;
    const stop = t.call(M.robotStop);
    // Marked handled now so a rejection during the drain is not an
    // unhandled rejection; `await stop` below still raises it.
    stop.catch(() => {});
    if (hadInFlight) await restopAfter(t, Promise.allSettled([...inFlightIntents]));
    // The result is the first intent's answer — awaited only now, never
    // before a stop. If it was refused late, that error is the walk's.
    result = await first;
    await stop;
  } else {
    // duck_stop sent the stops; still report what the first intent got.
    result = await first?.catch(() => undefined);
  }
  return {
    applied: v,
    result,
    duration_s: durationS,
    interrupted,
    ...(held ? { stopped_because: "picked_up" as const } : {}),
  };
}

/**
 * End any in-flight walk() loop. Resolves once every robot.move that is
 * still on the wire has been answered — several can be, now that walk()
 * pipelines its sends (see stopMotion).
 */
export function stopWalk(): Promise<unknown> | undefined {
  walkEpoch++;
  return inFlightIntents.size ? Promise.allSettled([...inFlightIntents]) : undefined;
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
  // Not awaited before the drain: the first stop goes out now, whatever
  // happens to it, and the second is owed even if the first failed.
  const stop = t.call(M.robotStop);
  stop.catch(() => {}); // handled here; the caller still gets the rejection
  if (inFlight) await restopAfter(t, inFlight);
  return stop;
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
