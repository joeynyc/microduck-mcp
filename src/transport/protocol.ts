/**
 * Upstream's wire vocabulary, as published in
 * `pollen-robotics/microduck` `duck-ipc-proto/src/lib.rs` (commit 590b986;
 * everything here re-checked at d7560ef, daemon 0.17.4 = API_VERSION 44).
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
  // robotd — the policy channel (policy-channel-design.md §8; API_VERSION 18).
  // A v17-or-older daemon answers METHOD_NOT_FOUND naming the method — the
  // designed skew behaviour, not a handshake refusal — so the tools turn it
  // into "your daemon is too old" rather than surfacing a raw JSON-RPC error.
  robotPolicies: "robot.policies", // → PoliciesResult
  robotLoadPolicy: "robot.loadPolicy", // {slot?, path?} → IntentResult; no path = reset the slot, neither = reset all
  // mediad — a JSON header then raw UYVY bytes on /run/mediad/media.sock. Not
  // called by this server: mediad's own console wraps it as an upright PNG
  // (see MEDIA below), which is what duck_camera fetches on hardware.
  mediaFrame: "media.frame",
  // configd
  systemInfo: "system.info",
  // updaterd
  updateListInstalled: "update.listInstalled", // {component}
  // updaterd — the Hub side of the policy channel (v19). Deliberately NOT
  // here: policy.check / policy.install, which fetch-and-apply "the newest"
  // official set (CLAUDE.md "Deliberately excluded").
  policyFetch: "policy.fetch", // {repo, revision?, file?} → PolicyFetchResult (downloads into the library)
  policySearch: "policy.search", // {query} → {models: PolicySearchHit[]}
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
 * The literal that switches a slot off (§9.2) — sent as the `path`, exactly
 * as `[policy] <slot> = "none"` in robotd.toml. Every slot but `walk`, which
 * is what the others fall back to and so can never be empty.
 */
export const POLICY_NONE = "none";

/** The API_VERSION that introduced robot.policies / robot.loadPolicy. */
export const POLICY_API_VERSION = 18;

/**
 * The HF org that makes a policy official (§2). Hardcoded on purpose and NOT
 * a config key: a robot that can be told which org to trust is a robot whose
 * "official" badge means nothing. The daemon applies the same rule and
 * reports the origin itself; this constant is for what we can say before
 * asking it.
 */
export const OFFICIAL_HF_ORG = "pollen-robotics";

/** Where a policy came from, which drives behaviour and not only a label (§2). */
export type PolicyOrigin = "official" | "community" | "local";

/** One row of `robot.policies` (upstream `PolicySlot`). */
export interface PolicySlotRow {
  slot: string;
  /** The file running in it. Absent = the slot is empty (a capability this robot lacks, not a fault). */
  path?: string | null;
  /** "official" | "community" | "local"; absent when the slot is empty. A string on the wire. */
  origin?: string | null;
  /** Whether config overrides this slot rather than it resolving to the mode's default. */
  overridden: boolean;
  /** Why the slot is not running what was asked: the override failed and the default is running. */
  error?: string | null;
  [k: string]: unknown;
}

/** `robot.policies` (upstream `PoliciesResult`). Fields we don't consume are left open. */
export interface PoliciesResult {
  /** "walk" or "roller" — whose slot defaults are in play. */
  mode: string;
  /** `[policy] enabled`. False is a legitimate bench configuration, not a fault. */
  enabled: boolean;
  slots: PolicySlotRow[];
  /** The one-shot skills this robot has (what `robot.do` answers to). Empty = "did not say". */
  skills?: string[];
  /** Why the last reload / whole-robot reset failed; cleared by the next success. */
  change_error?: string | null;
  /**
   * Whether the robot has finished homing after a reload. A `robot.do` sent
   * while it has not is refused. Absent from a daemon too old to say.
   */
  homed?: boolean | null;
  /**
   * Whether the duck is parked in its seat. Upstream's answer to "which way
   * does sit_toggle go": seated → `robot.do sit_toggle` stands it up. Absent
   * from a daemon too old to say; then the `robot.state` label is the fallback.
   */
  sitting?: boolean | null;
  [k: string]: unknown;
}

/** `policy.fetch` (upstream `PolicyFetchResult`). The manifest fields are the publisher's claims. */
export interface PolicyFetchResult {
  /** Where it landed in the library — what goes in the slot. */
  path: string;
  repo: string;
  revision: string;
  commit?: string | null;
  file: string;
  origin: string;
  name?: string | null;
  description?: string | null;
  kind?: string | null;
  [k: string]: unknown;
}

/** One `policy.search` hit. Everything here is written by whoever published it. */
export interface PolicySearchHit {
  id: string;
  origin: string;
  likes?: number | null;
  downloads?: number | null;
  /** The publisher's one-line description, from the repo's manifest. */
  description?: string | null;
  /** A link to the repo's preview clip, when it carries one. */
  preview?: string | null;
  [k: string]: unknown;
}

/**
 * mediad's console (`mediad/src/web.rs`): always served, `--port 8080` by
 * default, and `GET /frame` answers one `media.frame` as an upright PNG
 * (`image/png`, `Cache-Control: no-store`; 503 with a sentence when capture
 * is not running). It is mediad's own consumer of the raw socket — hello
 * handshake, UYVY decode, mount rotation — so a client that wants a picture
 * rather than a dataset asks here and never touches pixel formats.
 */
export const MEDIA = {
  consolePort: 8080,
  framePath: "/frame",
  rawSocket: "/run/mediad/media.sock",
} as const;

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
  /** What drove this tick: walk | stand | sit | rise | ground_pick | ... a
   *  net, or held | homing | rest when no policy is driving. */
  policy: string;
  safety: {
    fallen: boolean;
    limp: boolean;
    /** Somebody is holding the duck; the policy is paused until it is set
     *  down, then resumes on its own. Absent from an older robotd = false. */
    picked_up?: boolean;
    [k: string]: unknown;
  };
  loop: { hz: number; missed: number };
  [k: string]: unknown;
}
