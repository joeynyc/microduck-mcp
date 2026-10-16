import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  BEHAVIOR_NAMES,
  BEHAVIORS,
  clampVelocity,
  isSeated,
  LIMITS,
  preBehaviorCheck,
  preMotionCheck,
  resetMotionCooldown,
  stopWalk,
  walk,
} from "../safety.js";
import { DuckTransport } from "../transport/types.js";

/** Transport stub: returns a fixed health payload (and frame), records every call. */
function stub(health: unknown, frame: unknown = { policy: "stand" }): DuckTransport & { calls: string[] } {
  return {
    calls: [],
    async state() {
      return frame as any;
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

describe("preMotionCheck: held", () => {
  beforeEach(() => resetMotionCooldown());
  const HELD = { policy: "held", safety: { fallen: false, limp: false, picked_up: true } };

  test("refuses motion while someone is holding the duck", async () => {
    await assert.rejects(preMotionCheck(stub(OK, HELD)), /holding the duck/);
  });

  test("a refusal for being held does not consume the cooldown", async () => {
    await assert.rejects(preMotionCheck(stub(OK, HELD)));
    await preMotionCheck(stub(OK));
  });

  test("recovery is allowed while held (a human rights the duck)", async () => {
    await preMotionCheck(stub(OK, HELD), { allowUnhealthy: true });
  });

  test("a robotd too old to report picked_up reads as not held", async () => {
    await preMotionCheck(stub(OK, { policy: "stand", safety: { fallen: false, limp: false } }));
  });
});

describe("isSeated", () => {
  /** A transport whose robot.policies answer (or throw) is `policies`, and whose frame is `policy`. */
  function seatStub(policies: unknown, policy: string): DuckTransport {
    return {
      async state() {
        return { policy } as any;
      },
      async call(method: string) {
        if (method !== "robot.policies") return {};
        if (policies instanceof Error) throw policies;
        return policies;
      },
      async ping() {
        return true;
      },
      async close() {},
    };
  }

  test("trusts robot.policies.sitting over the frame label", async () => {
    // Mid-rise or held, the label is not "sit" though the duck is still seated.
    assert.equal(await isSeated(seatStub({ sitting: true }, "held")), true);
    assert.equal(await isSeated(seatStub({ sitting: false }, "sit")), false);
  });

  test("falls back to the frame when the daemon does not say", async () => {
    assert.equal(await isSeated(seatStub({ mode: "walk", slots: [] }, "sit")), true);
    assert.equal(await isSeated(seatStub({ mode: "walk", slots: [] }, "stand")), false);
  });

  test("falls back to the frame on a daemon without the policy channel", async () => {
    const tooOld = new Error("Method not found: robot.policies");
    assert.equal(await isSeated(seatStub(tooOld, "sit")), true);
    assert.equal(await isSeated(seatStub(tooOld, "walk")), false);
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

  /** A transport whose frame reports picked_up once `heldAfterMs` has passed. */
  function liftedAfter(heldAfterMs: number, moveMs = 0) {
    const events: string[] = [];
    const t0 = Date.now();
    const t: DuckTransport = {
      async state() {
        const held = Date.now() - t0 >= heldAfterMs;
        return { policy: held ? "held" : "walk", safety: { fallen: false, limp: false, picked_up: held } } as any;
      },
      async call(method: string) {
        if (method === "robot.move") {
          events.push("move>");
          await new Promise((r) => setTimeout(r, moveMs));
          events.push("<move");
        } else events.push(method);
        return {};
      },
      async ping() {
        return true;
      },
      async close() {},
    };
    return { t, events };
  }

  test("a pick-up mid-walk ends it with a robot.stop", async () => {
    const { t, events } = liftedAfter(80);
    const began = Date.now();
    const r = await walk(t, { vx: 0.1, vy: 0, vyaw: 0 }, 5, 20, 10);
    assert.equal(r.stopped_because, "picked_up");
    assert.equal(r.interrupted, false);
    assert.equal(events.at(-1), "robot.stop");
    assert.ok(Date.now() - began < 500, "ended at the pick-up, not after the 5 s walk");
  });

  test("the stop never overtakes an intent still in flight", async () => {
    // Each intent takes 30 ms; the pick-up lands while one is out.
    const { t, events } = liftedAfter(45, 30);
    await walk(t, { vx: 0.1, vy: 0, vyaw: 0 }, 5, 20, 5);
    assert.deepEqual(events.slice(-2), ["<move", "robot.stop"]);
  });

  test("a sample that never answers does not hold up the stop", async () => {
    const t = stub(OK);
    const hung: DuckTransport = { ...t, state: () => new Promise(() => {}) };
    const began = Date.now();
    const r = await walk(hung, { vx: 0.1, vy: 0, vyaw: 0 }, 0.1, 20, 10);
    assert.equal(t.calls.at(-1), "robot.stop");
    assert.equal(r.stopped_because, undefined);
    assert.ok(Date.now() - began < 300, `walk took ${Date.now() - began} ms`);
  });

  test("a failed sample does not end the walk", async () => {
    const t = stub(OK);
    const flaky: DuckTransport = {
      ...t,
      async state() {
        throw new Error("subscribe timed out");
      },
    };
    const r = await walk(flaky, { vx: 0.1, vy: 0, vyaw: 0 }, 0.15, 30, 10);
    assert.equal(r.interrupted, false);
    assert.equal(r.stopped_because, undefined);
    assert.equal(t.calls.at(-1), "robot.stop");
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
