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

let lastMotionAt = 0;

/** Clear the motion cooldown. Intended for tests; never call from a tool. */
export function resetMotionCooldown(): void {
  lastMotionAt = 0;
}

export function clampVelocity(vx: number, vy: number, wz: number) {
  const clamp = (v: number, lim: number) => Math.max(-lim, Math.min(lim, v));
  return {
    vx: clamp(vx, LIMITS.maxLinearVelocity),
    vy: clamp(vy, LIMITS.maxLinearVelocity),
    wz: clamp(wz, LIMITS.maxYawRate),
  };
}

/** Throws with an agent-readable reason if motion should not be issued. */
export async function preMotionCheck(t: DuckTransport): Promise<void> {
  const now = Date.now();
  if (now - lastMotionAt < LIMITS.motionCooldownMs) {
    throw new Error(
      `Rate limited: wait ${LIMITS.motionCooldownMs}ms between motion commands.`,
    );
  }
  const health = (await t.call("robotd", "robot.health")) as {
    healthy?: boolean;
    battery?: { fraction?: number };
    mode?: string;
  };
  const frac = health?.battery?.fraction;
  if (typeof frac === "number" && frac < LIMITS.minBatteryForMotion) {
    throw new Error(
      `Battery at ${(frac * 100).toFixed(0)}% — below the ${
        LIMITS.minBatteryForMotion * 100
      }% motion floor. Charge the duck. (Note: 0% is the hardware cutoff ` +
        `where robotd sits the robot down; this floor keeps margin above it.)`,
    );
  }
  if (health?.healthy === false) {
    throw new Error(
      `Robot reports unhealthy (mode: ${health?.mode ?? "unknown"}). ` +
        `Run duck_health for details before commanding motion.`,
    );
  }
  lastMotionAt = now;
}
