#!/usr/bin/env bash
# Sim control-loop stalls from camera renders (`bash bench/camera-stall.sh`).
#
# 1. Rebuild dist/ (the bench spawns the sidecar through SimTransport).
# 2. Physics parity: fixed-script DuckSim drive, sha256 of every tick's
#    qpos+qvel+last_action, compared to bench/parity-hash.txt. A changed
#    hash is a behaviour change, not an optimisation → fail.
# 3. Timing: realtime sidecar, robot.move vx=0.25 re-sent every 200 ms for
#    10 s, sim.camera follow 320×240 every 500 ms (burst variant: head
#    640×480 every 200 ms), 3 runs each, median reported as METRIC lines.
#    Pinned to BENCH_CPUS (default 0-3) so numbers are comparable.
set -euo pipefail
cd "$(dirname "$0")/.."

CPUS="${BENCH_CPUS:-0-3}"
export MUJOCO_GL=egl

npx tsc

# Asset paths from sim/assets.json via the same resolver the transport uses.
read -r SCENE POLICIES < <(node -e '
  import("./dist/sim-home.js").then((m) => {
    const a = m.sidecarAssets(m.simHome());
    console.log(a.scene, a.policies);
  });')
export DUCK_SIM_SCENE="$SCENE" DUCK_SIM_POLICIES="$POLICIES"

hash=$(taskset -c "$CPUS" node dist/cli.js sim-python bench/parity.py "$SCENE" "$POLICIES" | tail -1 | cut -d' ' -f2)
baseline=$(cat bench/parity-hash.txt)
if [ "$hash" != "$baseline" ]; then
  echo "PHYSICS PARITY FAILED: got $hash, want $baseline" >&2
  exit 1
fi

taskset -c "$CPUS" node bench/bench.mjs
