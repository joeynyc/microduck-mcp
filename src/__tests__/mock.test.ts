import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { MockTransport } from "../transport/mock.js";

describe("MockTransport", () => {
  test("health is healthy and charged out of the box", async () => {
    const m = new MockTransport();
    const h = (await m.call("robotd", "robot.health")) as any;
    assert.equal(h.healthy, true);
    assert.ok(h.battery.percent > 50);
  });

  test("robot.state reflects walking and advances odometry", async () => {
    const m = new MockTransport();
    let s = (await m.state()) as any;
    assert.equal(s.mode, "standing");
    assert.deepEqual(s.odometry, { x_m: 0, y_m: 0, yaw_rad: 0 });
    assert.equal(Object.keys(s.joints).length, 12);

    await m.call("robotd", "robot.move", { vx: 0.2, vy: 0, vyaw: 0 });
    await new Promise((r) => setTimeout(r, 120));
    s = await m.state();
    assert.equal(s.mode, "walking");
    assert.ok(s.odometry.x_m > 0, "x should advance while walking forward");
    assert.deepEqual(s.move.applied, [0.2, 0, 0]);

    await m.call("robotd", "robot.stop");
    s = await m.state();
    assert.equal(s.mode, "standing");
    assert.deepEqual(s.move.applied, [0, 0, 0]);
  });
});

describe("MockTransport upstream vocabulary", () => {
  test("sit_toggle flips posture and the state frame's policy says so", async () => {
    const m = new MockTransport();
    await m.call("robotd", "robot.do", { skill: "sit_toggle" });
    assert.equal((await m.state()).policy, "sit");
    await m.call("robotd", "robot.do", { skill: "sit_toggle" });
    assert.equal((await m.state()).policy, "stand");
  });
});
