import { DAEMON_COMPONENT, M, POLICY_SLOTS, PolicyEntry, PolicySlot, RobotState } from "./protocol.js";
import { DuckTransport, Snapshot, SnapshotRequest } from "./types.js";
import { parseSource } from "../policy.js";

/** 8×6 duck-yellow PNG, so duck_camera returns a valid image on mock. */
const MOCK_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAIAAABxZ0isAAAAGklEQVR4nGP4jwoYRvkkkSPqR0eMcJ5eG2QAoyHzcNqoS3gAAAAASUVORK5CYII=";

const j = (pos_rad: number, vel_rad_s: number, temp_c: number) => ({
  pos_rad: +pos_rad.toFixed(3),
  vel_rad_s: +vel_rad_s.toFixed(3),
  temp_c,
});

/**
 * What each slot runs when nothing overrides it — the official set, copied
 * from policy-channel-design.md §10 (the mapping is not recoverable from the
 * names on the Hub, which is why upstream records it). Version is the
 * `policies` component's semver, as §6 renders an official policy.
 */
const OFFICIAL_DEFAULTS: Record<PolicySlot, string> = {
  walk: "alpha_walking.onnx",
  stand: "alpha_stand.onnx",
  sitstand: "alpha_sitstand.onnx",
  ground_pick: "alpha_ground_pick.onnx",
  kick_left: "ball_kick_left.onnx",
  kick_right: "ball_kick_right.onnx",
  roulade: "roulade.onnx",
};
const OFFICIAL_SET_VERSION = "1.2.0";

/** upstream duck_control::model::battery_percent: 6.6 V empty, 8.2 V full. */
const batteryPercent = (v: number) => Math.max(0, Math.min(1, (v - 6.6) / (8.2 - 6.6))) * 100;

/**
 * Mock transport — no robot required. This is the default until you own
 * hardware (ships ~Christmas 2026). Returns plausible canned state so every
 * MCP tool can be exercised end-to-end from any client today. Speaks
 * upstream's method names and result shapes (see protocol.ts).
 */
export class MockTransport implements DuckTransport {
  private volts = 7.9;
  private mode: "standing" | "walking" | "sitting" | "fallen" = "standing";
  private vel = { vx: 0, vy: 0, vyaw: 0 };
  private odom = { x: 0, y: 0, yaw: 0 };
  private lastSampleAt = Date.now();
  /**
   * Per-slot overrides, exactly as robotd holds them: a slot missing from this
   * map is a config key that was never written, which resolves to the official
   * default (§3). `reset` deletes; it does not write a default back.
   */
  private overrides = new Map<PolicySlot, string>();

  async call(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.volts = Math.max(6.7, this.volts - 0.001);

    switch (method) {
      case M.robotHealth: {
        const pct = batteryPercent(this.volts);
        return {
          healthy: this.mode !== "fallen",
          degraded: false,
          mode: this.mode,
          battery: { volts: +this.volts.toFixed(2), percent: +pct.toFixed(1) },
          control_loop: { hz: 50.0, missed: 0 },
          motors: { hottest_c: 41.2 },
          cpu_temp_c: 47.8,
          policy: "walk",
          mock: true,
        };
      }
      case M.robotMove: {
        this.integrate();
        const vx = Number(params?.vx ?? 0);
        const vy = Number(params?.vy ?? 0);
        const vyaw = Number(params?.vyaw ?? 0);
        this.vel = { vx, vy, vyaw };
        this.mode = Math.abs(vx) + Math.abs(vy) + Math.abs(vyaw) > 0.01 ? "walking" : "standing";
        return { accepted: true, mock: true };
      }
      case M.robotDo: {
        const skill = String(params?.skill ?? "");
        if (skill === "sit_toggle") this.mode = this.mode === "sitting" ? "standing" : "sitting";
        return { accepted: true, skill, mock: true };
      }
      case M.robotInit:
        this.mode = "standing";
        return { accepted: true, mock: true };
      case M.robotSound:
        return { accepted: true, tag: params?.tag, mock: true };
      case M.robotStop:
        this.integrate();
        this.mode = "standing";
        this.vel = { vx: 0, vy: 0, vyaw: 0 };
        return { accepted: true, mock: true };
      case M.robotPolicies:
        return { api_version: 17, slots: this.policyRows(), mock: true };
      case M.robotLoadPolicy: {
        const slot = String(params?.slot ?? "") as PolicySlot;
        if (!(POLICY_SLOTS as readonly string[]).includes(slot)) {
          throw new Error(`no such policy slot: ${slot}`);
        }
        const source = params?.source;
        // A request that is already true does no work (§4) — the same answer
        // robot.setMode gives for "already in that mode", and for the same
        // reason: the caller asked for a state and has it. Without it, a reset
        // on an untouched robot homes the duck and rebuilds seven sessions to
        // arrive back where it started, which reads as a fault.
        if (source === null || source === undefined) {
          const had = this.overrides.delete(slot);
          return { accepted: true, slot, queued: had, note: had ? "override removed" : "slot was not overridden", mock: true };
        }
        const src = String(source);
        if (this.overrides.get(slot) === src) {
          return { accepted: true, slot, queued: false, note: "already loaded", mock: true };
        }
        this.overrides.set(slot, src);
        return { accepted: true, slot, source: src, queued: true, mock: true };
      }
      case M.robotState:
        return this.state();
      case M.systemInfo:
        return { name: "mockduck", serial: null, uptime_seconds: 1234, mock: true };
      case M.updateListInstalled:
        return [
          { version: "0.9.2", active: false, golden: true, component: params?.component ?? DAEMON_COMPONENT },
          { version: "0.9.3", active: true, golden: false, component: params?.component ?? DAEMON_COMPONENT },
        ];
      default:
        return { method, params, note: "mock echo — no handler", mock: true };
    }
  }

  /**
   * One row per slot. Origin is read off the source string by §2's rule — the
   * same `parseSource` the real tools use, so the mock cannot disagree with
   * them — and the version is rendered by what the publisher offers (§6):
   * official policies get the set's semver, HF ones their revision, local
   * ones `local`.
   */
  private policyRows(): PolicyEntry[] {
    return POLICY_SLOTS.map((slot) => {
      const override = this.overrides.get(slot);
      if (override === undefined) {
        return {
          slot,
          policy: OFFICIAL_DEFAULTS[slot],
          source: `pollen-robotics/microduck-policies`,
          origin: "official" as const,
          version: OFFICIAL_SET_VERSION,
        };
      }
      const parsed = parseSource(override);
      if (parsed.kind === "none") {
        return { slot, policy: null, source: "none", origin: "local" as const, version: null };
      }
      return {
        slot,
        policy: parsed.kind === "hf" ? `${parsed.repo}:policy.onnx` : override,
        source: override,
        origin: parsed.origin,
        version: parsed.kind === "hf" ? parsed.rev : parsed.kind === "path" ? "local" : null,
      };
    });
  }

  async state(): Promise<RobotState> {
    this.integrate();
    const walking = this.mode === "walking";
    const phase = (Date.now() / 400) % (2 * Math.PI);
    const gait = walking ? 0.15 * Math.sin(phase) : 0;
    const sit = this.mode === "sitting" ? 0.9 : 0;
    const joints: Record<string, { pos_rad: number; vel_rad_s: number; temp_c: number }> = {};
    for (const side of ["left", "right"] as const) {
      const sgn = side === "left" ? 1 : -1;
      joints[`${side}_hip_yaw`] = j(0.0, 0, 38);
      joints[`${side}_hip_roll`] = j(0.02 * sgn, 0, 39);
      joints[`${side}_hip_pitch`] = j(-0.35 - sit + sgn * gait, walking ? sgn * 0.6 : 0, 41);
      joints[`${side}_knee`] = j(0.7 + sit * 1.2 - sgn * gait, walking ? -sgn * 0.6 : 0, 42);
      joints[`${side}_ankle`] = j(-0.35 - sit * 0.3, 0, 40);
    }
    joints.neck_pitch = j(0.1, 0, 36);
    joints.head_yaw = j(0.0, 0, 35);
    const v = [this.vel.vx, this.vel.vy, this.vel.vyaw];
    return {
      t: Date.now() / 1000,
      mode: this.mode,
      policy: this.mode === "sitting" ? "sit" : walking ? "walk" : "stand",
      move: { requested: v, applied: v, limited_by: [] },
      gravity: this.mode === "fallen" ? [-0.97, 0.02, -0.14] : [0.0, 0.0, -1.0],
      gyro_rad_s: [0, 0, walking ? this.vel.vyaw : 0],
      joints,
      odometry: {
        x_m: +this.odom.x.toFixed(3),
        y_m: +this.odom.y.toFixed(3),
        yaw_rad: +this.odom.yaw.toFixed(3),
      },
      safety: { fallen: this.mode === "fallen", limp: this.mode === "fallen", busy: false },
      loop: { hz: 50, missed: 0 },
      mock: true,
    };
  }

  /** Advance odometry by the last intent since the previous sample, so it visibly moves in demos. */
  private integrate(): void {
    const dt = (Date.now() - this.lastSampleAt) / 1000;
    this.lastSampleAt = Date.now();
    if (this.mode === "walking") {
      this.odom.x += this.vel.vx * dt;
      this.odom.y += this.vel.vy * dt;
      this.odom.yaw += this.vel.vyaw * dt;
    }
  }

  async snapshot(req: SnapshotRequest): Promise<Snapshot> {
    return {
      png_base64: MOCK_PNG,
      width: 8,
      height: 6,
      view: req.view,
      note: "mock transport — placeholder frame. Use DUCK_TRANSPORT=sim for a rendered view.",
    };
  }

  async ping(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {}
}
