import { DuckService, DuckTransport } from "./types.js";

const j = (pos_rad: number, vel_rad_s: number, temp_c: number) => ({
  pos_rad: +pos_rad.toFixed(3),
  vel_rad_s: +vel_rad_s.toFixed(3),
  temp_c,
});

/**
 * Mock transport — no robot required. This is the default until you own
 * hardware (ships ~Christmas 2026). Returns plausible canned state so every
 * MCP tool can be exercised end-to-end from any client today.
 */
export class MockTransport implements DuckTransport {
  private battery = 0.82;
  private mode: "standing" | "walking" | "sitting" | "fallen" = "standing";
  private log: string[] = [];
  private vel = { vx: 0, vy: 0, wz: 0 };
  private odom = { x: 0, y: 0, yaw: 0 };
  private lastSampleAt = Date.now();

  async call(
    _service: DuckService,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    this.log.push(method);
    this.battery = Math.max(0.05, this.battery - 0.001);

    switch (method) {
      case "robot.health":
        return {
          healthy: this.mode !== "fallen",
          mode: this.mode,
          battery: {
            fraction: +this.battery.toFixed(3),
            volts: +(6.4 + this.battery * 2).toFixed(2),
          },
          loop_hz: 50.0,
          hottest_servo_c: 41.2,
          board_temp_c: 47.8,
          policy: "walk-v1.onnx",
          mock: true,
        };
      case "robot.intent": {
        const vx = Number(params?.vx ?? 0);
        const vy = Number(params?.vy ?? 0);
        const wz = Number(params?.wz ?? 0);
        this.vel = { vx, vy, wz };
        this.mode =
          Math.abs(vx) + Math.abs(vy) + Math.abs(wz) > 0.01 ? "walking" : "standing";
        return { applied: params, clamped: false, mock: true };
      }
      case "robot.behavior": {
        const b = String(params?.name ?? "");
        if (b === "sit") this.mode = "sitting";
        if (b === "stand" || b === "getup") this.mode = "standing";
        return { behavior: b, started: true, mock: true };
      }
      case "robot.stop":
        this.mode = "standing";
        this.vel = { vx: 0, vy: 0, wz: 0 };
        return { stopped: true, mock: true };
      case "robot.state": {
        // One-shot sample: joints, gravity vector, odometry. Integrates the
        // last velocity intent so the odometry visibly moves in demos.
        const dt = (Date.now() - this.lastSampleAt) / 1000;
        this.lastSampleAt = Date.now();
        if (this.mode === "walking") {
          this.odom.x += this.vel.vx * dt;
          this.odom.y += this.vel.vy * dt;
          this.odom.yaw += this.vel.wz * dt;
        }
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
        return {
          t_ms: Date.now(),
          mode: this.mode,
          gravity: this.mode === "fallen" ? [9.6, 0.2, 1.4] : [0.0, 0.0, 9.81],
          gyro_rad_s: [0, 0, walking ? this.vel.wz : 0],
          joints,
          odometry: {
            x_m: +this.odom.x.toFixed(3),
            y_m: +this.odom.y.toFixed(3),
            yaw_rad: +this.odom.yaw.toFixed(3),
          },
          intent: this.vel,
          mock: true,
        };
      }
      case "system.version":
        return {
          release: "0.9.3-mock",
          revision: "rev unknown, not a CI build",
          daemons: { robotd: "0.9.3", configd: "0.9.3", updaterd: "0.9.3" },
          mock: true,
        };
      case "update.list":
        return {
          current: "0.9.3-mock",
          installed: ["0.9.2", "0.9.3-mock"],
          mock: true,
        };
      default:
        return { method, params, note: "mock echo — no handler", mock: true };
    }
  }

  async ping(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {}
}
