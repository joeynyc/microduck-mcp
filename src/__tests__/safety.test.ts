import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  BEHAVIOR_NAMES,
  BEHAVIORS,
  clampVelocity,
  LIMITS,
  preBehaviorCheck,
  preMotionCheck,
  resetMotionCooldown,
  stopWalk,
  walk,
} from "../safety.js";
import { DuckTransport } from "../transport/types.js";

/** Transport stub: returns a fixed health payload, records every call. */
function stub(health: unknown): DuckTransport & { calls: string[] } {
  return {
    calls: [],
    async state() {
      return { policy: "stand" } as any;
    },
    async call(method: string) {
      this.calls.push(method);
      if (method === "robot.health") return health;
      if (method === "robot.state") return { policy: "stand" };
      return {};
    },
    async ping() {
      return true;
    },
    async close() {},
  };
}

const OK = { healthy: true, mode: "standing", battery: { volts: 7.9, percent: 80 } };

describe("clampVelocity", () => {
  test("passes values inside the envelope through unchanged", () => {
    assert.deepEqual(clampVelocity(0.1, -0.1, 0.5), { vx: 0.1, vy: -0.1, vyaw: 0.5 });
  });

  test("clamps linear velocity to ±maxLinearVelocity", () => {
    const v = clampVelocity(5, -5, 0);
    assert.equal(v.vx, LIMITS.maxLinearVelocity);
    assert.equal(v.vy, -LIMITS.maxLinearVelocity);
  });

  test("clamps yaw to ±maxYawRate", () => {
    assert.equal(clampVelocity(0, 0, 99).vyaw, LIMITS.maxYawRate);
    assert.equal(clampVelocity(0, 0, -99).vyaw, -LIMITS.maxYawRate);
  });

  test("zero stays zero", () => {
    assert.deepEqual(clampVelocity(0, 0, 0), { vx: 0, vy: 0, vyaw: 0 });
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
    const t = stub({ ...OK, battery: { volts: 6.8, percent: LIMITS.minBatteryForMotion * 100 - 1 } });
    await assert.rejects(() => preMotionCheck(t), /Battery at 14%.*motion floor/);
  });

  test("allows motion exactly at the battery floor", async () => {
    const t = stub({ ...OK, battery: { volts: 6.8, percent: LIMITS.minBatteryForMotion * 100 } });
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
    const t = stub({ healthy: false, mode: "fallen", battery: { volts: 6.7, percent: 5 } });
    await assert.rejects(() => preMotionCheck(t, { allowUnhealthy: true }), /Battery/);
  });

  test("battery floor is checked before the healthy flag", async () => {
    const t = stub({ healthy: false, mode: "fallen", battery: { volts: 6.7, percent: 5 } });
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
    const low = stub({ ...OK, battery: { volts: 6.7, percent: 5 } });
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
      async state() {
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

describe("preBehaviorCheck", () => {
  beforeEach(() => resetMotionCooldown());

  test("quack is never gated", async () => {
    await preBehaviorCheck(stub({ healthy: false, battery: { volts: 6.6, percent: 1 } }), "quack");
  });

  test("getup is allowed on a fallen robot, but not on an empty battery", async () => {
    await preBehaviorCheck(stub({ ...OK, healthy: false, mode: "fallen" }), "getup");
    resetMotionCooldown();
    await assert.rejects(() => preBehaviorCheck(stub({ healthy: false, battery: { volts: 6.7, percent: 5 } }), "getup"), /Battery/);
  });

  test("every other behavior is fully gated", async () => {
    for (const b of BEHAVIOR_NAMES.filter((b) => b !== "quack" && b !== "getup")) {
      resetMotionCooldown();
      await assert.rejects(() => preBehaviorCheck(stub({ ...OK, healthy: false }), b), /unhealthy/);
    }
  });
});

describe("walk", () => {
  test("re-sends the intent for the duration, then stops", async () => {
    const t = stub(OK);
    const r = await walk(t, { vx: 0.1, vy: 0, vyaw: 0 }, 0.25, 50);
    const intents = t.calls.filter((c) => c === "robot.move").length;
    assert.ok(intents >= 3 && intents <= 7, `expected ~5 intents, got ${intents}`);
    assert.equal(t.calls.at(-1), "robot.stop");
    assert.equal(r.interrupted, false);
    assert.equal(r.duration_s, 0.25);
  });

  test("stopWalk() interrupts an in-flight walk and leaves the stop to the caller", async () => {
    const t = stub(OK);
    const p = walk(t, { vx: 0.1, vy: 0, vyaw: 0 }, 5, 20);
    await new Promise((r) => setTimeout(r, 60));
    stopWalk();
    const r = await p;
    assert.equal(r.interrupted, true);
    assert.ok(!t.calls.includes("robot.stop"), "duck_stop sends robot.stop itself");
    assert.ok(t.calls.length < 10, "did not keep walking after stopWalk");
  });

  test("re-sends on a fixed grid, so a slow round trip does not stretch the period", async () => {
    // Each intent takes 40 ms to answer; with a 50 ms grid over 300 ms we
    // still expect ~6 sends. An additive loop (sleep, then await) would
    // manage ~3 and hand the deadman a 90 ms period.
    const t = stub(OK);
    const slow: DuckTransport = {
      ...t,
      async call(method: string) {
        await new Promise((r) => setTimeout(r, 40));
        return t.call(method);
      },
    };
    const r = await walk(slow, { vx: 0.1, vy: 0, vyaw: 0 }, 0.3, 50);
    const intents = t.calls.filter((c) => c === "robot.move").length;
    assert.ok(intents >= 5, `expected ~6 intents on the grid, got ${intents}`);
    assert.equal(r.interrupted, false);
  });

  test("a refused intent aborts the walk", async () => {
    const t: DuckTransport = {
      async call() {
        throw new Error("refused: robot is fallen/limp");
      },
      async state() {
        throw new Error("unreachable");
      },
      async ping() {
        return true;
      },
      async close() {},
    };
    await assert.rejects(() => walk(t, { vx: 0.1, vy: 0, vyaw: 0 }, 1), /fallen/);
  });
});

describe("BEHAVIORS wire table", () => {
  test("every behavior maps to an upstream method", () => {
    for (const b of BEHAVIOR_NAMES) {
      assert.match(BEHAVIORS[b].method, /^robot\.(do|init|sound)$/);
    }
    assert.deepEqual(BEHAVIORS.sit.params, { skill: "sit_toggle" });
    assert.deepEqual(BEHAVIORS.quack.params, { tag: "chirp" });
  });
});
