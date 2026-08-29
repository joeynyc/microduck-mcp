import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  clampVelocity,
  preMotionCheck,
  resetMotionCooldown,
  LIMITS,
} from "../safety.js";
import { DuckService, DuckTransport } from "../transport/types.js";

/** Transport stub: returns a fixed health payload, records every call. */
function stub(health: unknown): DuckTransport & { calls: string[] } {
  return {
    calls: [],
    async call(_s: DuckService, method: string) {
      this.calls.push(method);
      if (method === "robot.health") return health;
      return {};
    },
    async ping() {
      return true;
    },
    async close() {},
  };
}

const OK = { healthy: true, mode: "standing", battery: { fraction: 0.8 } };

describe("clampVelocity", () => {
  test("passes values inside the envelope through unchanged", () => {
    assert.deepEqual(clampVelocity(0.1, -0.1, 0.5), { vx: 0.1, vy: -0.1, wz: 0.5 });
  });

  test("clamps linear velocity to ±maxLinearVelocity", () => {
    const v = clampVelocity(5, -5, 0);
    assert.equal(v.vx, LIMITS.maxLinearVelocity);
    assert.equal(v.vy, -LIMITS.maxLinearVelocity);
  });

  test("clamps yaw to ±maxYawRate", () => {
    assert.equal(clampVelocity(0, 0, 99).wz, LIMITS.maxYawRate);
    assert.equal(clampVelocity(0, 0, -99).wz, -LIMITS.maxYawRate);
  });

  test("zero stays zero", () => {
    assert.deepEqual(clampVelocity(0, 0, 0), { vx: 0, vy: 0, wz: 0 });
  });
});

describe("preMotionCheck", () => {
  beforeEach(() => resetMotionCooldown());

  test("allows motion on a healthy, charged robot", async () => {
    const t = stub(OK);
    await preMotionCheck(t);
    assert.deepEqual(t.calls, ["robot.health"]);
  });

  test("refuses motion below the battery floor", async () => {
    const t = stub({ ...OK, battery: { fraction: LIMITS.minBatteryForMotion - 0.01 } });
    await assert.rejects(() => preMotionCheck(t), /Battery at 14%.*motion floor/);
  });

  test("allows motion exactly at the battery floor", async () => {
    const t = stub({ ...OK, battery: { fraction: LIMITS.minBatteryForMotion } });
    await preMotionCheck(t);
  });

  test("allows motion when battery is unreported (robotd is the authority)", async () => {
    const t = stub({ healthy: true, mode: "standing" });
    await preMotionCheck(t);
  });

  test("refuses motion when the robot reports unhealthy", async () => {
    const t = stub({ ...OK, healthy: false, mode: "fallen" });
    await assert.rejects(() => preMotionCheck(t), /unhealthy \(mode: fallen\)/);
  });

  test("allowUnhealthy lets a recovery behavior through a fallen robot", async () => {
    const t = stub({ ...OK, healthy: false, mode: "fallen" });
    await preMotionCheck(t, { allowUnhealthy: true });
  });

  test("allowUnhealthy does not bypass the battery floor", async () => {
    const t = stub({ healthy: false, mode: "fallen", battery: { fraction: 0.05 } });
    await assert.rejects(() => preMotionCheck(t, { allowUnhealthy: true }), /Battery/);
  });

  test("battery floor is checked before the healthy flag", async () => {
    const t = stub({ healthy: false, mode: "fallen", battery: { fraction: 0.05 } });
    await assert.rejects(() => preMotionCheck(t), /Battery/);
  });

  test("rate-limits back-to-back motion commands", async () => {
    const t = stub(OK);
    await preMotionCheck(t);
    await assert.rejects(() => preMotionCheck(t), /Rate limited/);
    // The rate limit fires before hitting the robot at all.
    assert.deepEqual(t.calls, ["robot.health"]);
  });

  test("a refused command does not consume the cooldown", async () => {
    const low = stub({ ...OK, battery: { fraction: 0.05 } });
    await assert.rejects(() => preMotionCheck(low));
    // Immediately afterwards a good command must still be allowed.
    await preMotionCheck(stub(OK));
  });

  test("allows motion again once the cooldown has elapsed", async () => {
    const t = stub(OK);
    await preMotionCheck(t);
    await new Promise((r) => setTimeout(r, LIMITS.motionCooldownMs + 20));
    await preMotionCheck(t);
  });

  test("propagates transport errors (unreachable robot => no motion)", async () => {
    const t: DuckTransport = {
      async call() {
        throw new Error("ECONNREFUSED /run/robotd.sock");
      },
      async ping() {
        return false;
      },
      async close() {},
    };
    await assert.rejects(() => preMotionCheck(t), /ECONNREFUSED/);
  });
});
