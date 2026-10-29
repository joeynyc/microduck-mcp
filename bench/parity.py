#!/usr/bin/env python3
"""Physics parity hash for the sim control loop (autoresearch gate).

Imports DuckSim directly — no stdio loop, no realtime — and drives a fixed
command script with sim.now replaced by a tick-count clock so wall time can
never leak in. sha256 over every tick's qpos+qvel+last_action. Any change
that alters the control output changes the hash; that is a behaviour
change, not an optimisation (microduck-ar-briefs/common.md).
"""
import hashlib
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "sim"))
from duck_sim import CONTROL_DT, DuckSim  # noqa: E402

scene = Path(sys.argv[1])
policies = Path(sys.argv[2])

sim = DuckSim(scene, policies, battery_v=7.9, deadman_s=1e9)

ticks = [0]
sim.now = lambda: ticks[0] * CONTROL_DT

h = hashlib.sha256()
for tick in range(1600):
    t = ticks[0]
    if t == 50:
        sim.intent({"vx": 0.25})
    elif t == 350:
        sim.intent({"vx": 0.25, "vyaw": 0.5})
    elif t == 650:
        sim.intent({"vx": 0.25, "vyaw": 0.5, "vy": -0.1})
    elif t == 900:
        sim.stop({})
    elif t == 1000:
        sim.do({"skill": "sit_toggle"})
    elif t == 1250:
        sim.do({"skill": "sit_toggle"})
    elif t == 1400:
        sim.do({"skill": "kick_right"})
    sim.tick()
    h.update(sim.data.qpos.tobytes())
    h.update(sim.data.qvel.tobytes())
    h.update(sim.last_action.tobytes())
    ticks[0] += 1

print(f"PARITY {h.hexdigest()}")
