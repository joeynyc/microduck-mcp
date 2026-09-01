/**
 * Upstream's wire vocabulary, as published in
 * `pollen-robotics/microduck` `duck-ipc-proto/src/lib.rs` (commit 590b986).
 * This is the only place method names and enum spellings live; every
 * transport, the sidecar and the tools speak exactly these.
 */
export const M = {
  // robotd — all answered as requests (intents reply with IntentResult).
  robotHealth: "robot.health",
  robotMove: "robot.move", // {vx, vy, vyaw} m/s, m/s, rad/s
  robotHead: "robot.head", // {neck_pitch, head_pitch, head_yaw, head_roll}
  robotStop: "robot.stop",
  robotInit: "robot.init", // power joints, ramp to home pose
  robotDo: "robot.do", // {skill}
  robotSound: "robot.sound", // {tag, hold?}
  robotSubscribe: "robot.subscribe", // {hz?} → SubscribeResult, then robot.state notifications
  robotState: "robot.state", // notification (server → client); sidecars may also answer it one-shot
  // robotd — the policy channel (policy-channel-design.md §8). NOTE: these two
  // methods took upstream's API_VERSION from 16 to 17. A v16 daemon answers
  // METHOD_NOT_FOUND naming the method — that is the designed skew behaviour,
  // not a handshake refusal, so the tools turn it into "your daemon is too
  // old" rather than surfacing a raw JSON-RPC error.
  robotPolicies: "robot.policies", // → per-slot current policy, origin, version
  robotLoadPolicy: "robot.loadPolicy", // {slot, source} — source null = reset (§3)
  // configd
  systemInfo: "system.info",
  // updaterd
  updateListInstalled: "update.listInstalled", // {component}
} as const;

/** `robot.do` skills. sit_toggle sits if standing, stands if sitting. */
export type Skill = "ground_pick" | "kick_left" | "kick_right" | "sit_toggle" | "roulade";

/** `robot.sound` tags. `chirp` is what `robotctl quack` plays. */
export type SoundTag = "alarm" | "greet" | "inquire" | "peck" | "chirp" | "coo" | "wheee";

/**
 * The seven policy slots (policy-channel-design.md §2), in upstream's order.
 * Single source of truth: the tool enums, the reset-all loop and the mock all
 * derive from this array, so a slot is added in exactly one place.
 */
export const POLICY_SLOTS = [
  "walk",
  "stand",
  "sitstand",
  "ground_pick",
  "kick_left",
  "kick_right",
  "roulade",
] as const;
export type PolicySlot = (typeof POLICY_SLOTS)[number];

/**
 * The literal that switches a slot off (§9.2) — the same `[policy] <slot> =
 * "none"` a robotd.toml already accepts. Every slot but `walk`, which is what
 * the others fall back to and so can never be empty.
 */
export const POLICY_NONE = "none";

/**
 * The HF org that makes a policy official (§2). Hardcoded on purpose and NOT
 * a config key: a robot that can be told which org to trust is a robot whose
 * "official" badge means nothing.
 */
export const OFFICIAL_HF_ORG = "pollen-robotics";

/** Where a policy came from, which drives behaviour and not only a label (§2). */
export type PolicyOrigin = "official" | "community" | "local" | "unknown";

/**
 * The daemon's own contract, published in upstream's `duck_ipc_proto` and
 * asserted at compile time in `duck_control`: obs[1,61] f32 → actions[1,14]
 * f32, model_api 1. Mirrored here only so a manifest can be read against it
 * before 800 KB is downloaded; robotd's shape gate is still the real check.
 */
export const POLICY_OBS_LEN = 61;
export const POLICY_ACTION_LEN = 14;
export const POLICY_MODEL_API = 1;

/** One row of `robot.policies`. Fields we don't consume are left open. */
export interface PolicyEntry {
  slot: string;
  policy?: string | null;
  origin?: PolicyOrigin;
  version?: string | null;
  source?: string | null;
  error?: string | null;
  [k: string]: unknown;
}

/**
 * `manifest.json` as published on the Hub (sharing-policies.md, schema v2).
 * Every field is optional here because the manifest is a stranger's claim
 * about a stranger's file: it may be absent, partial, or wrong.
 */
export interface PolicyManifest {
  schema_version?: number;
  model_api?: number;
  name?: string;
  kind?: string;
  obs_len?: number;
  action_len?: number;
  description?: string;
  robot?: { model?: string; [k: string]: unknown };
  [k: string]: unknown;
}

/** The updater component that carries the daemons. */
export const DAEMON_COMPONENT = "daemon";

/** Shapes we read back. Fields we don't consume are left open. */
export interface Battery {
  volts: number;
  percent: number;
}
export interface HealthResult {
  healthy: boolean;
  degraded?: boolean;
  reason?: string;
  battery?: Battery;
  [k: string]: unknown;
}
export interface RobotState {
  t: number;
  move: { requested: number[]; applied: number[]; limited_by?: string[] };
  policy: string; // which net drove this tick: walk | stand | sit | rise | ...
  safety: { fallen: boolean; limp: boolean; [k: string]: unknown };
  loop: { hz: number; missed: number };
  [k: string]: unknown;
}
