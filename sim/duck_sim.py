#!/usr/bin/env python3
"""
duck_sim.py — headless CPU-MuJoCo Microduck, speaking robotd's wire protocol.

JSON-RPC 2.0, one object per line, over stdio. The MCP server's `sim`
transport spawns this and talks to it exactly the way the `unix` transport
talks to /run/robotd.sock, which is the point: sim and hardware are
interchangeable behind `DuckTransport`.

What runs the duck is the *same* control chain as robotd (upstream
`robotd/src/control.rs`, commit 590b986), driving the *official* pretrained
ONNX policies vendored in `pollen-robotics/microduck/policies/`:

    skill windows ← advance / expire (roulade, kick, ground-pick, sit↔stand rise)
    command       ← EMA-smoothed caller command, re-encoded for the active skill
    net           ← roulade > kick > ground pick > sit/rise > stand-by-magnitude > walk
    action        ← ONNX   obs[1,61] → actions[1,14]
    targets       ← home pose + action_scale × action
    filters       ← first-order low-pass on head (0.5) and legs (0.7)

The MuJoCo side (scene, timestep, sensor names, projected gravity, initial
pose, 1.75 A current limit) follows `microduck_rl/scripts/infer_policy.py`
(commit d424a0c). Where the two disagree — infer_policy.py uses action scale
1.0 and no low-pass — robotd wins: it is what the real robot runs, and
CLAUDE.md says the doc that owns the mechanism wins.

Methods (see `handle()`):
    robot.health  robot.state  robot.intent|robot.move  robot.behavior|robot.do
    robot.head    robot.stop   system.version  update.list  sim.camera  sim.reset
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import math
import os
import queue
import sys
import threading
import time
from pathlib import Path

import numpy as np

# --------------------------------------------------------------------------
# Constants, with provenance
# --------------------------------------------------------------------------

# duck_control::model::DEFAULT_POSITION minus the mouth (index 9 there). The
# MuJoCo model has 14 actuators in exactly this order; verified at load.
JOINT_NAMES = [
    "left_hip_yaw", "left_hip_roll", "left_hip_pitch", "left_knee", "left_ankle",
    "neck_pitch", "head_pitch", "head_yaw", "head_roll",
    "right_hip_yaw", "right_hip_roll", "right_hip_pitch", "right_knee", "right_ankle",
]
DEFAULT_POSE = np.array([
    0.0, -0.0873, -0.4579, -0.0049, 0.4530,
    0.3491, 0.3491, 0.0, 0.0,
    0.0, 0.0873, 0.4579, 0.0049, -0.4530,
], dtype=np.float64)
HEAD = slice(5, 9)  # neck_pitch, head_pitch, head_yaw, head_roll

OBS_LEN, ACTION_LEN = 61, 14

# robotd Tuning::default() / SkillTuning::default()
ACTION_SCALE = 0.9
STANDING_ACTION_SCALE = 1.0
STANDING_GAIN_RATIO = 0.8
HEAD_LOWPASS = 0.5
LEGS_LOWPASS = 0.7
STANDING_THRESHOLD = 0.05        # duck_control::policy::DEFAULT_STANDING_THRESHOLD
CMD_ALPHA = 0.2                  # robotd.toml [control] cmd_alpha
HEAD_ALPHA = 0.2
GROUND_PICK_PERIOD = 4.0
GROUND_PICK_END_PHASE = 0.7
KICK_DURATION = 0.5
ROULADE_DURATION = 1.0
RISE_SECS = 1.0

# Velocity envelope the walking policy was trained on
# (microduck_rl tasks/microduck_velocity_env_cfg.py:648-650). robotd clamps
# to its own configured max and reports `limited_by: ["max_velocity"]`; we
# do the same with the training envelope.
MAX_VX, MAX_VY, MAX_VYAW = 0.4, 0.3, 1.0

# Battery: duck_control::model::battery_percent — 6.6 V empty, 8.2 V full.
BATTERY_EMPTY_V, BATTERY_FULL_V = 6.6, 8.2

# infer_policy.py: 5 ms physics, decimation 4 → 50 Hz policy
SIM_DT, DECIMATION = 0.005, 4
CONTROL_DT = SIM_DT * DECIMATION
INIT_Z = 0.125
# infer_policy.py --current-limit 1.75 (default on): forcerange = ±kt·1.75,
# kt from BAM xl330 m6 (Rhoban/bam bam/params/xl330/m6.json).
XL330_M6_KT = 0.3459739511711113
CURRENT_LIMIT_A = 1.75

# Fall: FallPredictorConfig tilt_z −0.90 is the predictor's arming tilt; the
# unambiguous "on the floor" condition we gate motion on is gravity_z above
# −0.5 (> 60° from upright) held for a few ticks.
FALLEN_GZ = -0.5
FALLEN_TICKS = 10

POLICY_FILES = {
    "walk": "alpha_walking.onnx",
    "stand": "alpha_stand.onnx",
    "sitstand": "alpha_sitstand.onnx",
    "ground_pick": "alpha_ground_pick.onnx",
    "kick_left": "ball_kick_left.onnx",
    "kick_right": "ball_kick_right.onnx",
    "roulade": "roulade.onnx",
}


def battery_percent(volts: float) -> float:
    if not math.isfinite(volts) or volts <= 0:
        return 0.0
    return max(0.0, min(1.0, (volts - BATTERY_EMPTY_V) / (BATTERY_FULL_V - BATTERY_EMPTY_V))) * 100.0


def quat_rotate_inverse(q: np.ndarray, v: np.ndarray) -> np.ndarray:
    """Rotate v by the inverse of scalar-first quaternion q (infer_policy.py)."""
    w, xyz = q[0], q[1:4]
    t = np.cross(xyz, v) * 2
    return v - w * t + np.cross(xyz, t)


def quat_yaw(q: np.ndarray) -> float:
    w, x, y, z = q
    return math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))


# --------------------------------------------------------------------------
# The simulated robot
# --------------------------------------------------------------------------

class DuckSim:
    def __init__(self, scene_xml: Path, policy_dir: Path, battery_v: float, deadman_s: float):
        import mujoco
        import onnxruntime as ort

        self.mujoco = mujoco
        self.model = mujoco.MjModel.from_xml_path(str(scene_xml))
        self.data = mujoco.MjData(self.model)
        self.model.opt.timestep = SIM_DT

        names = [self.model.actuator(i).name for i in range(self.model.nu)]
        if names != JOINT_NAMES:
            raise RuntimeError(f"actuator order {names} != expected {JOINT_NAMES}")
        self.qpos_idx = [int(self.model.jnt_qposadr[self.model.actuator_trnid[i, 0]]) for i in range(self.model.nu)]
        self.qvel_idx = [int(self.model.jnt_dofadr[self.model.actuator_trnid[i, 0]]) for i in range(self.model.nu)]
        self.trunk = mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_BODY, "trunk_base")
        gyro = mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_SENSOR, "imu_ang_vel")
        self.gyro_adr = int(self.model.sensor_adr[gyro])
        free = mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_JOINT, "trunk_base_freejoint")
        self.free_adr = int(self.model.jnt_qposadr[free])

        limit = XL330_M6_KT * CURRENT_LIMIT_A
        self.model.actuator_forcerange[:] = [-limit, limit]
        self.model.actuator_forcelimited[:] = 1
        self.kp = self.model.actuator_gainprm[:, 0].copy()

        self.nets: dict[str, ort.InferenceSession] = {}
        for role, fname in POLICY_FILES.items():
            p = policy_dir / fname
            if p.exists():
                s = ort.InferenceSession(str(p), providers=["CPUExecutionProvider"])
                i, o = s.get_inputs()[0], s.get_outputs()[0]
                if list(i.shape) != [1, OBS_LEN] or list(o.shape) != [1, ACTION_LEN]:
                    raise RuntimeError(f"{fname}: expected obs[1,{OBS_LEN}]→actions[1,{ACTION_LEN}], got {i.shape}→{o.shape}")
                self.nets[role] = s
        if "walk" not in self.nets:
            raise RuntimeError(f"no walking policy at {policy_dir / POLICY_FILES['walk']}")
        self.in_name = self.nets["walk"].get_inputs()[0].name
        self.out_name = self.nets["walk"].get_outputs()[0].name

        self.battery_v = battery_v
        self.deadman_s = deadman_s
        self.renderers: dict[tuple[int, int], object] = {}
        self.t0 = time.monotonic()
        self.reset()

    # ---- state -----------------------------------------------------------

    def reset(self):
        d, m = self.data, self.model
        self.mujoco.mj_resetData(m, d)
        d.qpos[self.free_adr:self.free_adr + 3] = [0.0, 0.0, INIT_Z]
        d.qpos[self.free_adr + 3:self.free_adr + 7] = [1, 0, 0, 0]
        for i, qi in enumerate(self.qpos_idx):
            d.qpos[qi] = DEFAULT_POSE[i]
        d.ctrl[:] = DEFAULT_POSE
        self._set_gain(1.0)
        self.mujoco.mj_forward(m, d)

        self.last_action = np.zeros(ACTION_LEN, dtype=np.float32)
        self.previous: np.ndarray | None = None
        self.requested = np.zeros(3)      # what the caller asked for
        self.target_twist = np.zeros(3)   # after envelope clamp
        self.twist = np.zeros(3)          # after EMA
        self.limited_by: list[str] = []
        self.intent_at = -1e9
        self.intent_ttl = 0.0
        self.head_target = np.zeros(4)
        self.head = np.zeros(4)
        self.ground_pick: float | None = None
        self.kick: tuple[bool, float] | None = None
        self.roulade: float | None = None
        self.sit = "up"                    # up | sitting | rising
        self.rise_left = 0.0
        self.fallen = False
        self.fall_ticks = 0
        self.label = "walk"
        self.tick_count = 0
        self.missed = 0
        self.hz_est = 1.0 / CONTROL_DT
        self.enabled = True

    def _set_gain(self, ratio: float):
        self.model.actuator_gainprm[:, 0] = self.kp * ratio
        self.model.actuator_biasprm[:, 1] = -self.kp * ratio

    def now(self) -> float:
        return time.monotonic() - self.t0

    # ---- sensors ---------------------------------------------------------

    def gravity(self) -> np.ndarray:
        q = self.data.xquat[self.trunk].copy()
        return quat_rotate_inverse(q, np.array([0.0, 0.0, -1.0]))

    def gyro(self) -> np.ndarray:
        return self.data.sensordata[self.gyro_adr:self.gyro_adr + 3].copy()

    def joint_pos(self) -> np.ndarray:
        return self.data.qpos[self.qpos_idx].copy()

    def joint_vel(self) -> np.ndarray:
        return self.data.qvel[self.qvel_idx].copy()

    def odom(self) -> dict:
        p = self.data.xpos[self.trunk]
        return {"x_m": round(float(p[0]), 4), "y_m": round(float(p[1]), 4), "z_m": round(float(p[2]), 4),
                "yaw_rad": round(quat_yaw(self.data.xquat[self.trunk]), 4)}

    # ---- one 50 Hz tick: a port of robotd Controller::step ---------------

    def tick(self):
        dt = CONTROL_DT
        self.tick_count += 1

        # Deadman: intents expire; robotd zeroes a stale slot the same way.
        if self.now() - self.intent_at > self.intent_ttl:
            self.target_twist[:] = 0.0
        self.twist += CMD_ALPHA * (self.target_twist - self.twist)
        self.head += HEAD_ALPHA * (self.head_target - self.head)

        # Fall detection → limp. Motion is refused until getup/reset.
        gz = self.gravity()[2]
        self.fall_ticks = self.fall_ticks + 1 if gz > FALLEN_GZ else 0
        if self.fall_ticks >= FALLEN_TICKS and not self.fallen:
            self.fallen = True
            self._set_gain(0.0)
            self.target_twist[:] = 0.0
            self.kick = self.roulade = self.ground_pick = None
        if self.fallen:
            for _ in range(DECIMATION):
                self.mujoco.mj_step(self.model, self.data)
            self.label = "limp"
            return

        # Expire windows first (control.rs).
        if self.kick and self.kick[1] <= 0:
            self.kick = None
        if self.roulade is not None and self.roulade <= 0:
            self.roulade = None
        if self.sit == "rising" and self.rise_left <= 0:
            self.sit = "up"

        cmd = np.zeros(13, dtype=np.float32)
        cmd[3:7] = self.head
        twist_mag = float(np.linalg.norm(self.twist))
        if self.roulade is not None:
            net, label = "roulade", "roulade"
            cmd[3:7] = 0.0
        elif self.kick:
            net = "kick_left" if self.kick[0] else "kick_right"
            label = net
            cmd[3:7] = 0.0
        elif self.ground_pick is not None:
            a = 2 * math.pi * self.ground_pick
            cmd[0:3] = [math.cos(a), math.sin(a), 0.0]
            cmd[3:7] = 0.0
            net, label = "ground_pick", "ground_pick"
        elif self.sit == "sitting":
            cmd[0] = 1.0
            net, label = "sitstand", "sit"
        elif self.sit == "rising":
            net, label = "sitstand", "rise"
        else:
            cmd[0:3] = self.twist
            if "stand" in self.nets and twist_mag <= STANDING_THRESHOLD:
                net, label = "stand", "stand"
            else:
                net, label = "walk", "walk"

        obs = np.concatenate([
            self.gyro(), self.gravity(),
            self.joint_pos() - DEFAULT_POSE, self.joint_vel(),
            self.last_action, cmd,
        ]).astype(np.float32).reshape(1, -1)
        action = self.nets[net].run([self.out_name], {self.in_name: obs})[0].squeeze(0).astype(np.float32)
        self.last_action = action.copy()

        eff_mag = float(np.linalg.norm(cmd[0:3]))
        standing_tuned = net == "stand" or (
            net in ("kick_left", "kick_right", "sitstand") and "stand" in self.nets and eff_mag <= STANDING_THRESHOLD)
        if net in ("roulade", "ground_pick"):
            scale, gain = 1.0, 1.0
        elif net == "sitstand":
            scale, gain = 1.0, (STANDING_GAIN_RATIO if standing_tuned else 1.0)
        elif standing_tuned:
            scale, gain = STANDING_ACTION_SCALE, STANDING_GAIN_RATIO
        else:
            scale, gain = ACTION_SCALE, 1.0

        targets = DEFAULT_POSE + scale * action.astype(np.float64)
        if self.previous is not None:
            t = targets.copy()
            t[HEAD] = HEAD_LOWPASS * targets[HEAD] + (1 - HEAD_LOWPASS) * self.previous[HEAD]
            legs = np.ones(ACTION_LEN, dtype=bool)
            legs[HEAD] = False
            t[legs] = LEGS_LOWPASS * targets[legs] + (1 - LEGS_LOWPASS) * self.previous[legs]
            targets = t
        self.previous = targets.copy()

        self._set_gain(gain)
        self.data.ctrl[:] = targets
        for _ in range(DECIMATION):
            self.mujoco.mj_step(self.model, self.data)

        # Advance windows after the tick that used them.
        if self.ground_pick is not None:
            self.ground_pick += dt / GROUND_PICK_PERIOD
            if self.ground_pick >= GROUND_PICK_END_PHASE:
                self.ground_pick = None
        if self.kick:
            self.kick = (self.kick[0], self.kick[1] - dt)
        if self.roulade is not None:
            self.roulade -= dt
        if self.sit == "rising":
            self.rise_left -= dt
        self.label = label

    def busy(self) -> bool:
        return self.ground_pick is not None or self.kick is not None or self.roulade is not None or self.sit == "rising"

    def mode(self) -> str:
        if self.fallen:
            return "fallen"
        if self.sit == "sitting":
            return "sitting"
        if self.busy():
            return self.label
        return "walking" if self.label == "walk" and np.linalg.norm(self.twist) > STANDING_THRESHOLD else "standing"

    # ---- RPC handlers ------------------------------------------------------

    def health(self) -> dict:
        v = self.battery_v
        pct = battery_percent(v)
        healthy = not self.fallen and self.hz_est >= 0.9 / CONTROL_DT
        out = {
            "healthy": healthy,
            "degraded": False,
            "mode": self.mode(),
            "battery": {"volts": round(v, 2), "percent": round(pct, 1), "fraction": round(pct / 100, 3)},
            "control_loop": {"hz": round(self.hz_est, 1), "missed": self.missed},
            "loop_hz": round(self.hz_est, 1),
            "policy": self.label,
            "policies": sorted(self.nets),
            "sim": True,
        }
        if self.fallen:
            out["reason"] = "fallen: torque off (limp). Run behavior 'getup' (sim: teleport upright) or sim.reset."
        elif not healthy:
            out["reason"] = f"control loop at {self.hz_est:.1f} Hz"
        return out

    def state(self) -> dict:
        pos, vel = self.joint_pos(), self.joint_vel()
        g = self.gravity()
        return {
            "t": round(self.now(), 3),
            "mode": self.mode(),
            "policy": self.label,
            "move": {"requested": [round(float(x), 3) for x in self.requested],
                     "applied": [round(float(x), 3) for x in self.twist],
                     "limited_by": list(self.limited_by)},
            "head": [round(float(x), 3) for x in self.head],
            "gravity": [round(float(x), 3) for x in g],
            "gyro_rad_s": [round(float(x), 3) for x in self.gyro()],
            "joints": {n: {"pos_rad": round(float(pos[i]), 4), "vel_rad_s": round(float(vel[i]), 3)}
                       for i, n in enumerate(JOINT_NAMES)},
            "targets": [round(float(x), 4) for x in self.data.ctrl],
            "odometry": self.odom(),
            "intent": {"vx": round(float(self.target_twist[0]), 3), "vy": round(float(self.target_twist[1]), 3),
                       "wz": round(float(self.target_twist[2]), 3)},
            "safety": {"fallen": self.fallen, "limp": self.fallen, "busy": self.busy()},
            "loop": {"hz": round(self.hz_est, 1), "missed": self.missed},
            "sim": True,
        }

    def intent(self, p: dict) -> dict:
        vx = float(p.get("vx", 0.0))
        vy = float(p.get("vy", 0.0))
        wz = float(p.get("wz", p.get("vyaw", 0.0)))
        if not all(math.isfinite(v) for v in (vx, vy, wz)):
            raise RpcError(-32602, "non-finite velocity refused")
        if self.fallen:
            raise RpcError(-32000, "refused: robot is fallen/limp; run behavior 'getup' first")
        self.requested[:] = [vx, vy, wz]
        clamped = [max(-MAX_VX, min(MAX_VX, vx)), max(-MAX_VY, min(MAX_VY, vy)), max(-MAX_VYAW, min(MAX_VYAW, wz))]
        self.limited_by = ["max_velocity"] if clamped != [vx, vy, wz] else []
        self.target_twist[:] = clamped
        self.intent_at = self.now()
        self.intent_ttl = float(p.get("ttl_s", self.deadman_s))
        return {"applied": {"vx": clamped[0], "vy": clamped[1], "wz": clamped[2]},
                "clamped": bool(self.limited_by), "limited_by": self.limited_by,
                "ttl_s": self.intent_ttl, "sim": True}

    def head_cmd(self, p: dict) -> dict:
        for i, k in enumerate(("neck_pitch", "head_pitch", "head_yaw", "head_roll")):
            if k in p:
                self.head_target[i] = float(p[k])
        return {"head": [float(x) for x in self.head_target], "sim": True}

    def behavior(self, p: dict) -> dict:
        name = str(p.get("name") or p.get("skill") or "")
        note = None
        if name == "quack":
            return {"behavior": "quack", "started": True, "note": "no speaker in sim", "sim": True}
        if name == "getup":
            # No stand-up policy in the vendored set and robotd has no getup skill
            # (fall → limp, a human picks it up). Sim stands in for the human.
            xy = self.data.xpos[self.trunk][:2].copy()
            self.reset()
            self.data.qpos[self.free_adr:self.free_adr + 2] = xy
            self.mujoco.mj_forward(self.model, self.data)
            return {"behavior": "getup", "started": True, "note": "sim: teleported upright in place", "sim": True}
        if self.fallen:
            raise RpcError(-32000, "refused: robot is fallen/limp; run behavior 'getup' first")
        if name in ("sit", "stand", "sit_toggle"):
            if "sitstand" not in self.nets:
                raise RpcError(-32000, "no sitstand policy loaded")
            if name == "sit" and self.sit == "sitting":
                return {"behavior": "sit", "started": False, "note": "already sitting", "sim": True}
            if name == "stand" and self.sit == "up":
                return {"behavior": "stand", "started": False, "note": "already standing", "sim": True}
            if self.sit == "rising":
                raise RpcError(-32000, "already standing up")
            if self.sit == "up":
                self.sit = "sitting"
                self.target_twist[:] = 0.0
            else:
                self.sit, self.rise_left = "rising", RISE_SECS
        elif name in ("pickup", "ground_pick"):
            if "ground_pick" not in self.nets:
                raise RpcError(-32000, "no ground-pick policy loaded")
            if self.ground_pick is not None:
                raise RpcError(-32000, "ground pick already running")
            self.ground_pick = 0.0
        elif name in ("kick", "kick_right", "kick_left"):
            left = name == "kick_left"
            role = "kick_left" if left else "kick_right"
            if role not in self.nets:
                raise RpcError(-32000, f"no {role} policy loaded")
            if self.busy():
                raise RpcError(-32000, "a scripted move is already running")
            self.kick = (left, KICK_DURATION)
            note = "kick is ball-blind; no ball in this scene"
        elif name == "roulade":
            if "roulade" not in self.nets:
                raise RpcError(-32000, "no roulade policy loaded")
            if self.ground_pick is not None:
                raise RpcError(-32000, "a ground pick is running")
            self.roulade = ROULADE_DURATION
        else:
            raise RpcError(-32602, f"unknown behavior {name!r}")
        out = {"behavior": name, "started": True, "sim": True}
        if note:
            out["note"] = note
        return out

    def stop(self) -> dict:
        self.target_twist[:] = 0.0
        self.requested[:] = 0.0
        self.intent_at = -1e9
        self.kick = self.roulade = self.ground_pick = None
        return {"stopped": True, "sim": True}

    def camera(self, p: dict) -> dict:
        import mujoco
        from PIL import Image
        w = int(p.get("width", 320))
        h = int(p.get("height", 240))
        w, h = max(64, min(640, w)), max(48, min(480, h))
        view = str(p.get("view", "follow"))
        key = (w, h)
        if key not in self.renderers:
            self.renderers[key] = mujoco.Renderer(self.model, h, w)
        r = self.renderers[key]
        if view == "head":
            # The MJCF `head_camera` sits inside the head shell and its quat
            # points MuJoCo's optical axis (−z) *into* the head — upstream never
            # renders from it. So take its world pose, look along +z (the
            # lens direction: forward and ~14° down, the pickup view), and
            # start 5 cm out so the shell isn't in frame.
            cid = mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_CAMERA, "head_camera")
            pos = self.data.cam_xpos[cid]
            d = self.data.cam_xmat[cid].reshape(3, 3)[:, 2]
            eye = pos + 0.05 * d
            cam = mujoco.MjvCamera()
            cam.type = mujoco.mjtCamera.mjCAMERA_FREE
            cam.lookat[:] = eye + d
            cam.distance = 1.0
            cam.azimuth = math.degrees(math.atan2(d[1], d[0]))
            cam.elevation = math.degrees(math.asin(max(-1.0, min(1.0, float(d[2])))))
            r.update_scene(self.data, camera=cam)
        else:
            cam = mujoco.MjvCamera()
            cam.type = mujoco.mjtCamera.mjCAMERA_FREE
            cam.lookat[:] = self.data.xpos[self.trunk]
            cam.distance = float(p.get("distance", 0.8))
            yaw_deg = math.degrees(quat_yaw(self.data.xquat[self.trunk]))
            # MuJoCo free camera sits at lookat − distance·forward(az, el), so
            # azimuth == robot yaw puts it behind the robot, looking forward.
            presets = {"follow": (yaw_deg, -20), "front": (yaw_deg + 180, -10),
                       "side": (yaw_deg + 90, -10), "top": (yaw_deg, -89)}
            if view not in presets:
                raise RpcError(-32602, f"unknown view {view!r}; use head|follow|front|side|top")
            cam.azimuth, cam.elevation = presets[view]
            r.update_scene(self.data, camera=cam)
        img = r.render()
        buf = io.BytesIO()
        Image.fromarray(img).save(buf, format="PNG")
        return {"png_base64": base64.b64encode(buf.getvalue()).decode("ascii"),
                "width": w, "height": h, "view": view, "t": round(self.now(), 3), "sim": True}


class RpcError(Exception):
    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code, self.message = code, message


# --------------------------------------------------------------------------
# JSON-RPC over stdio
# --------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    here = Path(__file__).resolve().parent
    ap.add_argument("--scene", default=os.environ.get(
        "DUCK_SIM_SCENE", str(here / "vendor/microduck_rl/src/mjlab_microduck/robot/microduck/scene.xml")))
    ap.add_argument("--policies", default=os.environ.get("DUCK_SIM_POLICIES", str(here / "vendor/microduck/policies")))
    ap.add_argument("--battery-v", type=float, default=float(os.environ.get("DUCK_SIM_BATTERY_V", "7.9")))
    ap.add_argument("--deadman-s", type=float, default=float(os.environ.get("DUCK_SIM_DEADMAN_S", "2.0")))
    ap.add_argument("--no-realtime", action="store_true", help="run as fast as possible (tests)")
    args = ap.parse_args()

    out_lock = threading.Lock()

    def send(obj: dict):
        with out_lock:
            sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
            sys.stdout.flush()

    scene, policies = Path(args.scene), Path(args.policies)
    if not scene.exists() or not policies.exists():
        send({"jsonrpc": "2.0", "method": "sim.error", "params": {
            "message": f"assets missing: scene={scene} policies={policies}. Run sim/setup.sh."}})
        sys.exit(2)

    t = time.time()
    sim = DuckSim(scene, policies, args.battery_v, args.deadman_s)
    send({"jsonrpc": "2.0", "method": "sim.ready", "params": {
        "policies": sorted(sim.nets), "hz": 1 / CONTROL_DT, "load_s": round(time.time() - t, 2)}})

    inbox: queue.Queue = queue.Queue()

    def reader():
        for line in sys.stdin:
            inbox.put(line)
        inbox.put(None)

    threading.Thread(target=reader, daemon=True).start()

    def handle(method: str, params: dict):
        if method == "robot.health":
            return sim.health()
        if method == "robot.state":
            return sim.state()
        if method in ("robot.intent", "robot.move"):
            return sim.intent(params)
        if method in ("robot.behavior", "robot.do"):
            return sim.behavior(params)
        if method == "robot.head":
            return sim.head_cmd(params)
        if method == "robot.stop":
            return sim.stop()
        if method == "robot.enable":
            sim.enabled = bool(params.get("on", True))
            return {"enabled": sim.enabled, "sim": True}
        if method == "sim.camera":
            return sim.camera(params)
        if method == "sim.reset":
            sim.reset()
            return {"reset": True, "sim": True}
        if method == "system.version":
            return {"release": "sim", "daemons": {"robotd": "duck_sim.py"}, "policies": sorted(sim.nets), "sim": True}
        if method == "update.list":
            return {"current": "sim", "installed": ["sim"], "sim": True}
        raise RpcError(-32601, f"method not found: {method}")

    next_tick = time.monotonic()
    last_tick = next_tick
    while True:
        # Service requests between ticks, on the loop thread (rendering needs it).
        while True:
            try:
                line = inbox.get_nowait()
            except queue.Empty:
                break
            if line is None:
                return
            try:
                req = json.loads(line)
            except json.JSONDecodeError:
                send({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse error"}})
                continue
            rid = req.get("id")
            try:
                result = handle(str(req.get("method")), req.get("params") or {})
                if rid is not None:
                    send({"jsonrpc": "2.0", "id": rid, "result": result})
            except RpcError as e:
                if rid is not None:
                    send({"jsonrpc": "2.0", "id": rid, "error": {"code": e.code, "message": e.message}})
            except Exception as e:  # noqa: BLE001
                if rid is not None:
                    send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32000, "message": f"{type(e).__name__}: {e}"}})

        sim.tick()
        now = time.monotonic()
        sim.hz_est += 0.05 * ((1.0 / max(now - last_tick, 1e-6)) - sim.hz_est)
        last_tick = now
        if args.no_realtime:
            sim.hz_est = 1.0 / CONTROL_DT
            continue
        next_tick += CONTROL_DT
        delay = next_tick - now
        if delay > 0:
            time.sleep(delay)
        elif delay < -CONTROL_DT:
            sim.missed += 1
            next_tick = now


if __name__ == "__main__":
    main()
