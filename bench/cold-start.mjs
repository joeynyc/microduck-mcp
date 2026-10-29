/**
 * Cold-start benchmark: spawns the real Python sidecar through SimTransport
 * (realtime, default env) and times construction → first robot.health answer,
 * then one snapshot({view:"follow",320×240}), then close(). One discarded
 * warmup run warms the OS page cache; the metrics are medians over BENCH_REPS.
 *
 * METRIC lines go to stdout; per-run diagnostics to stderr.
 */
import { SimTransport } from "../dist/transport/sim.js";

const REPS = Number(process.env.BENCH_REPS ?? 5);
const WARMUP = Number(process.env.BENCH_WARMUP ?? 1);

// `load_s` is reported only inside the `sim.ready` notification, which the
// transport logs as `[sim] ready: {...}` on stderr. Intercept console.error
// to capture it for the current run; everything still reaches stderr.
let readyParams = null;
const origError = console.error;
console.error = (...args) => {
  const m = /^\[sim\] ready: (\{.*\})$/.exec(String(args[0]));
  if (m) {
    try {
      readyParams = JSON.parse(m[1]);
    } catch {
      /* leave readyParams as-is */
    }
  }
  origError(...args);
};

async function once() {
  readyParams = null;
  const t0 = performance.now();
  const t = new SimTransport();
  try {
    await t.call("robot.health");
    const cold = performance.now() - t0;
    const snap = await t.snapshot({ view: "follow", width: 320, height: 240 });
    const frame = performance.now() - t0;
    if (typeof snap?.png_base64 !== "string" || snap.png_base64.length === 0) {
      throw new Error("snapshot returned no PNG");
    }
    return { cold, frame, loadS: readyParams?.load_s ?? NaN };
  } finally {
    await t.close();
  }
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

for (let i = 0; i < WARMUP; i++) {
  const r = await once();
  origError(`[bench] warmup: cold=${r.cold.toFixed(0)}ms frame=${r.frame.toFixed(0)}ms load_s=${r.loadS}`);
}

const cold = [], frame = [], loadS = [];
for (let i = 0; i < REPS; i++) {
  const r = await once();
  cold.push(r.cold);
  frame.push(r.frame);
  loadS.push(r.loadS);
  origError(`[bench] run ${i + 1}: cold=${r.cold.toFixed(0)}ms frame=${r.frame.toFixed(0)}ms load_s=${r.loadS}`);
}

console.log(`METRIC cold_start_ms=${median(cold).toFixed(1)}`);
console.log(`METRIC first_frame_ms=${median(frame).toFixed(1)}`);
console.log(`METRIC sidecar_load_s=${median(loadS).toFixed(2)}`);
