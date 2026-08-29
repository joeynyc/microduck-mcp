import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { MockTransport } from "../transport/mock.js";

describe("MockTransport", () => {
  test("health is healthy and charged out of the box", async () => {
    const m = new MockTransport();
    const h = (await m.call("robotd", "robot.health")) as any;
    assert.equal(h.healthy, true);
    assert.ok(h.battery.fraction > 0.5);
  });

  test("robot.state reflects walking and advances odometry", async () => {
    const m = new MockTransport();
    let s = (await m.call("robotd", "robot.state")) as any;
    assert.equal(s.mode, "standing");
    assert.deepEqual(s.odometry, { x_m: 0, y_m: 0, yaw_rad: 0 });
    assert.equal(Object.keys(s.joints).length, 12);

    await m.call("robotd", "robot.intent", { vx: 0.2, vy: 0, wz: 0 });
    await new Promise((r) => setTimeout(r, 120));
    s = await m.call("robotd", "robot.state");
    assert.equal(s.mode, "walking");
    assert.ok(s.odometry.x_m > 0, "x should advance while walking forward");
    assert.deepEqual(s.intent, { vx: 0.2, vy: 0, wz: 0 });

    await m.call("robotd", "robot.stop");
    s = await m.call("robotd", "robot.state");
    assert.equal(s.mode, "standing");
    assert.deepEqual(s.intent, { vx: 0, vy: 0, wz: 0 });
  });
});
