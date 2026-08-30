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
  // configd
  systemInfo: "system.info",
  // updaterd
  updateListInstalled: "update.listInstalled", // {component}
} as const;

/** `robot.do` skills. sit_toggle sits if standing, stands if sitting. */
export type Skill = "ground_pick" | "kick_left" | "kick_right" | "sit_toggle" | "roulade";

/** `robot.sound` tags. `chirp` is what `robotctl quack` plays. */
export type SoundTag = "alarm" | "greet" | "inquire" | "peck" | "chirp" | "coo" | "wheee";

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
