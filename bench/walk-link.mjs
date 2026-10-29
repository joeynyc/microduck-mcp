/**
 * autoresearch benchmark — walk()/stopMotion() under a slow, lossy link.
 *
 * Drives dist/safety.js against a fake DuckTransport whose per-call latency is
 * seeded (mulberry32 — no Math.random). Each call() draws an independent
 * one-way delay for the request leg and another for the response leg; the
 * request "arrives" at robotd at send+delay, so arrivals may reorder exactly
 * like the per-call connections unix/ssh open. Delay mix per the brief:
 * 5–40 ms typical, 10% spikes of 150–350 ms.
 *
 * state() samples draw from a SECOND rng stream so the call-leg delay sequence
 * is reproducible for a given seed no matter how many watcher samples ran.
 *
 * Scenarios (a) 10 s walk, (b) walk + stopMotion at a seeded time,
 * (c) pick-up at a seeded time — each over SEEDS, the whole suite REPS times;
 * printed metrics are the median across reps.
 */
import { performance } from "node:perf_hooks";
import { walk, stopMotion } from "../dist/safety.js";

const DEADMAN_MS = 500; // robotd's safety.deadman_ms default — gaps above this are stalls
const WALK_S = 10;
const REPS = 3;
const SEEDS = [0x0d1, 0x0d2, 0x0d3, 0x0d4];
// (b)/(c) end early so extra seeds are cheap; the in-flight-move stop tail
// only shows in a fraction of runs, so they get more samples than (a).
const EVENT_SEEDS = [...SEEDS, 0x0d5, 0x0d6, 0x0d7, 0x0d8];
const V = { vx: 0.2, vy: -0.05, vyaw: 0.4 };

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/** Seeded one-way delay model for the ssh-over-wifi link. */
class Link {
  constructor(seed) {
    this.rng = mulberry32(seed);
  }
  /** One-way transit, ms: 90% uniform 5–40, 10% uniform 150–350. */
  transit() {
    return this.rng() < 0.1 ? 150 + this.rng() * 200 : 5 + this.rng() * 35;
  }
}

/**
 * DuckTransport over the lossy link, per-call connections: every call gets an
 * independent delay draw, so arrivals reorder. Records {method, sentAt, at}
 * for robot.move / robot.stop; `at` is when robotd would process it.
 */
class LossyTransport {
  constructor(seed, { heldAt = Infinity } = {}) {
    this.link = new Link(seed);
    this.watchLink = new Link(seed ^ 0x5bd1); // state() has its own stream
    this.arrivals = [];
    this.heldAt = heldAt; // ms on this clock when the duck is lifted
    this.t0 = performance.now();
    this.violations = [];
  }
  now() {
    return performance.now() - this.t0;
  }
  call(method) {
    const sentAt = this.now();
    const out = this.link.transit();
    const back = this.link.transit();
    if (method === "robot.move" || method === "robot.stop") {
      this.arrivals.push({ method, sentAt, at: sentAt + out });
    }
    return sleep(out + back).then(() => ({}));
  }
  /**
   * The real transports hold a robot.subscribe stream open for pick-up
   * detection; model it: a frame every 20ms (daemon's 50Hz), generated at
   * robotd and delayed by one transit draw each — so a frame reflects the
   * robot as it was at generation, not at arrival.
   */
  watchState(onFrame) {
    let stopped = false;
    let gen = this.now();
    const tick = () => {
      if (stopped) return;
      gen += 20;
      const at = this.now();
      const d = this.watchLink.transit();
      const held = gen >= this.heldAt;
      setTimeout(() => {
        if (!stopped)
          onFrame({
            policy: held ? "held" : "walk",
            safety: { fallen: false, limp: false, picked_up: held },
          });
      }, Math.max(0, gen + d - at));
      setTimeout(tick, Math.max(0, gen + 20 - this.now()));
    };
    // Stream setup: the first frame waits out the subscribe handshake.
    gen = this.now() + this.watchLink.transit();
    setTimeout(tick, Math.max(0, gen - this.now()));
    return () => {
      stopped = true;
    };
  }
  async state() {
    // The frame reflects the robot as the daemon sees it when the request
    // arrives (sent + out leg), and answers one leg later.
    const sentAt = this.now();
    const out = this.watchLink.transit();
    const held = sentAt + out >= this.heldAt;
    await sleep(out + this.watchLink.transit());
    return {
      policy: held ? "held" : "walk",
      safety: { fallen: false, limp: false, picked_up: held },
    };
  }
  async ping() {
    return true;
  }
  async close() {}
}

/** Gaps between consecutive robot.move *arrivals* (sorted), ms. */
function gapsOf(t) {
  const at = t.arrivals
    .filter((a) => a.method === "robot.move")
    .map((a) => a.at)
    .sort((x, y) => x - y);
  const g = [];
  for (let i = 1; i < at.length; i++) g.push(at[i] - at[i - 1]);
  return g;
}

/**
 * The moment the duck is verifiably stopped: the earliest robot.stop arrival
 * strictly after every robot.move arrival. Undefined if no stop lands last —
 * a move still on the wire after the final stop means the duck is walking.
 */
function effectiveStopAt(t) {
  const moves = t.arrivals.filter((a) => a.method === "robot.move");
  const lastMove = moves.length ? Math.max(...moves.map((a) => a.at)) : -Infinity;
  const stops = t.arrivals
    .filter((a) => a.method === "robot.stop" && a.at > lastMove)
    .map((a) => a.at)
    .sort((a, b) => a - b);
  if (!stops.length) {
    t.violations.push("no robot.stop arrived after the last robot.move — duck still walking");
    return undefined;
  }
  return stops[0];
}

/** No intent may be sent after a stop for the same walk went out. */
function checkOrdering(t) {
  const firstStopSent = Math.min(
    ...t.arrivals.filter((a) => a.method === "robot.stop").map((a) => a.sentAt),
    Infinity,
  );
  for (const m of t.arrivals) {
    if (m.method === "robot.move" && m.sentAt > firstStopSent) {
      t.violations.push(
        `robot.move sent ${(m.sentAt - firstStopSent).toFixed(1)}ms after a robot.stop`,
      );
    }
  }
}

/** Send rate of the intent stream itself: (n-1)/span of robot.move sends. */
function movesPerSecond(runs) {
  let n = 0;
  let span = 0;
  for (const { t } of runs) {
    const s = t.arrivals
      .filter((a) => a.method === "robot.move")
      .sort((a, b) => a.sentAt - b.sentAt);
    if (s.length > 1) {
      n += s.length - 1;
      span += (s.at(-1).sentAt - s[0].sentAt) / 1000;
    }
  }
  return span > 0 ? n / span : NaN;
}

// (a) plain 10 s walk
async function runPlainWalk(seed) {
  const t = new LossyTransport(seed);
  const r = await walk(t, V, WALK_S);
  checkOrdering(t);
  effectiveStopAt(t);
  if (r.interrupted || r.stopped_because) {
    t.violations.push(`plain walk ended early: ${JSON.stringify(r)}`);
  }
  return { t };
}

// (b) walk + duck_stop (stopMotion) at a seeded time in (1s, 9s)
async function runEarlyStop(seed) {
  const stopAt = 1000 + mulberry32(seed ^ 0x7e57)() * 8000;
  const t = new LossyTransport(seed);
  const w = walk(t, V, WALK_S);
  await sleep(stopAt - t.now());
  const stopCalledAt = t.now();
  await stopMotion(t);
  const r = await w;
  if (r.interrupted !== true) t.violations.push("stopMotion did not interrupt the walk");
  checkOrdering(t);
  const eff = effectiveStopAt(t);
  return { t, stopEffectiveMs: eff === undefined ? NaN : eff - stopCalledAt };
}

// (c) pick-up at a seeded time in (1s, 9s)
async function runPickup(seed) {
  const heldAt = 1000 + mulberry32(seed ^ 0x7e57)() * 8000;
  const t = new LossyTransport(seed, { heldAt });
  const r = await walk(t, V, WALK_S);
  if (r.stopped_because !== "picked_up") {
    t.violations.push(`pick-up run did not report picked_up: ${JSON.stringify(r)}`);
  }
  checkOrdering(t);
  const eff = effectiveStopAt(t);
  return { t, pickupStopMs: eff === undefined ? NaN : eff - heldAt };
}

function quantile(xs, q) {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return NaN;
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}
const median = (xs) => quantile(xs, 0.5);

async function runSuite() {
  const runs = [];
  for (const seed of SEEDS) runs.push(await runPlainWalk(seed));
  for (const seed of EVENT_SEEDS) {
    runs.push(await runEarlyStop(seed));
    runs.push(await runPickup(seed));
  }
  const gaps = runs.flatMap((r) => gapsOf(r.t));
  const finite = (xs) => xs.filter(Number.isFinite);
  return {
    runs,
    p99: quantile(gaps, 0.99),
    max: gaps.length ? Math.max(...gaps) : NaN,
    stalls: gaps.filter((g) => g > DEADMAN_MS).length,
    // stop_effective / pickup_stop are guarantees, not typical cases: a
    // median across seeds would hide the in-flight-move runs a fix targets.
    stopEffectiveMs: Math.max(...finite(runs.map((r) => r.stopEffectiveMs))),
    pickupStopMs: Math.max(...finite(runs.map((r) => r.pickupStopMs))),
    movesPerS: movesPerSecond(runs),
  };
}

const reps = [];
for (let i = 0; i < REPS; i++) reps.push(await runSuite());

const metric = (k) => median(reps.map((r) => r[k]));
const fmt = (x) => (Number.isFinite(x) ? x.toFixed(1) : "NaN");
console.log(`METRIC p99_deadman_gap_ms=${fmt(metric("p99"))}`);
console.log(`METRIC max_deadman_gap_ms=${fmt(metric("max"))}`);
console.log(`METRIC stop_effective_ms=${fmt(metric("stopEffectiveMs"))}`);
console.log(`METRIC pickup_stop_ms=${fmt(metric("pickupStopMs"))}`);
console.log(`METRIC moves_per_s=${metric("movesPerS").toFixed(3)}`);
console.log(`METRIC deadman_stalls=${Math.round(metric("stalls"))}`);
console.log(`ASI harness=walk-link seeds=${SEEDS.length} reps=${REPS} duration_s=${WALK_S}`);

const violations = reps.flatMap((r) => r.runs.flatMap((run) => run.t.violations));
if (violations.length) {
  for (const v of violations) console.error(`VIOLATION: ${v}`);
  process.exit(1);
}
