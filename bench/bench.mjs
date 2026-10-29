#!/usr/bin/env node
/**
 * Camera-stall benchmark (autoresearch harness).
 *
 * Spawns the sim sidecar through SimTransport — the same spawn/env/path as
 * the MCP server — in realtime mode (the stall only exists against the wall
 * clock). Two workloads, each repeated BENCH_RUNS times:
 *
 *   walk   10 s of `robot.move {vx:0.25}` re-sent every 200 ms (the safety
 *          layer's resend grid), `sim.camera` follow 320×240 every 500 ms —
 *          what `duck_walk` + periodic `duck_camera` does to the loop.
 *   burst  same walk, `sim.camera` head 640×480 every 200 ms.
 *
 * Loop timing is read back through the sidecar's `sim.stats` diagnostic
 * (max tick-end-to-tick-end gap, min achieved hz, missed delta — each call
 * covers the window since the previous one). Camera latency is measured
 * client-side per call. Primary metric is the median over runs of the
 * walk variant's max tick gap.
 */
import { SimTransport } from "../dist/transport/sim.js";

const DURATION_MS = Number(process.env.BENCH_DURATION_MS ?? 10_000);
const RUNS = Number(process.env.BENCH_RUNS ?? 3);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const p50 = median;

async function runWorkload(t, cam, camEveryMs) {
  // Re-arm the diagnostic window and start from a clean sim.
  await t.call("robot.stop");
  await t.call("sim.reset");
  // Build this variant's renderer now — first use is a one-time GL setup of
  // ~a second, not the per-frame cost this measures. The default duck_camera
  // size is prebuilt by the sidecar itself at startup; larger sizes are not.
  await t.snapshot(cam);
  // Settle long enough that the init churn (sim.reset clearing tick_times,
  // GL setup contention) has fully left the sidecar's trailing 1 s hz
  // window, then re-arm the diagnostic window and start measuring.
  await sleep(1400);
  await t.call("sim.stats");

  const errors = [];
  const camLat = [];
  t.call("robot.move", { vx: 0.25 }).catch((e) => errors.push(e));
  const moveTimer = setInterval(
    () => t.call("robot.move", { vx: 0.25 }).catch((e) => errors.push(e)),
    200,
  );
  const camTimer = setInterval(() => {
    const start = performance.now();
    t.snapshot(cam)
      .then(() => camLat.push(performance.now() - start))
      .catch((e) => errors.push(e));
  }, camEveryMs);
  await sleep(DURATION_MS);
  clearInterval(moveTimer);
  clearInterval(camTimer);
  await t.call("robot.stop").catch((e) => errors.push(e));
  await sleep(300); // drain the last in-flight frame
  const stats = await t.call("sim.stats");
  if (errors.length) throw errors[0];
  return { stats, camLat };
}

const t = new SimTransport();
await t.start();

const variants = [
  { name: "walk", cam: { view: "follow", width: 320, height: 240 }, camEveryMs: 500 },
  { name: "burst", cam: { view: "head", width: 640, height: 480 }, camEveryMs: 200 },
];

const results = {};
for (const v of variants) {
  results[v.name] = [];
  for (let i = 0; i < RUNS; i++) {
    const { stats, camLat } = await runWorkload(t, v.cam, v.camEveryMs);
    results[v.name].push({ stats, latP50: p50(camLat), frames: camLat.length });
    console.error(
      `[bench] ${v.name} run ${i + 1}/${RUNS}: ${JSON.stringify(stats)} cam_p50=${p50(camLat).toFixed(1)}ms frames=${camLat.length}`,
    );
  }
}
await t.close();

const emit = (name, v) => console.log(`METRIC ${name}=${typeof v === "number" ? +v.toFixed(3) : v}`);
for (const v of variants) {
  const rs = results[v.name];
  const p = v.name === "walk" ? "" : "burst_";
  emit(`${p}max_tick_gap_ms`, median(rs.map((r) => r.stats.max_tick_gap_ms)));
  emit(`${p}missed_ticks`, median(rs.map((r) => r.stats.missed_ticks)));
  emit(`${p}camera_latency_ms_p50`, median(rs.map((r) => r.latP50)));
  emit(`${p}loop_hz_min`, median(rs.map((r) => r.stats.loop_hz_min)));
}
