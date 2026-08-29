#!/usr/bin/env bash
# One-time setup for DUCK_TRANSPORT=sim: a Python venv with CPU MuJoCo +
# ONNX Runtime, and the upstream assets the sidecar needs, pinned to the
# commits this port was verified against. Re-run to refresh; idempotent.
set -euo pipefail
cd "$(dirname "$0")"

MICRODUCK_RL_REV=d424a0c899f6b33cbd3daeb279913134349c0b63   # scene.xml + meshes
MICRODUCK_REV=590b986bd8c0d50ae02cb3ea2f59c463b6828168      # policies/*.onnx, robotd control chain

if ! command -v uv >/dev/null; then
  echo "uv not found — install from https://docs.astral.sh/uv/ (or: pip install uv)" >&2; exit 1
fi
[ -d .venv ] || uv venv -q .venv --python 3.10
uv pip install -q --python .venv/bin/python mujoco onnxruntime numpy pillow

fetch() { # name url rev
  if [ ! -d "vendor/$1/.git" ]; then
    git clone -q --filter=blob:none --no-checkout "$2" "vendor/$1"
  fi
  git -C "vendor/$1" fetch -q --depth 1 origin "$3"
  git -C "vendor/$1" checkout -q "$3"
}
mkdir -p vendor
fetch microduck_rl https://github.com/pollen-robotics/microduck_rl.git "$MICRODUCK_RL_REV"
fetch microduck    https://github.com/pollen-robotics/microduck.git    "$MICRODUCK_REV"

MUJOCO_GL="${MUJOCO_GL:-egl}" .venv/bin/python - <<'PY'
import mujoco, onnxruntime, pathlib
scene = pathlib.Path("vendor/microduck_rl/src/mjlab_microduck/robot/microduck/scene.xml")
pol = sorted(p.name for p in pathlib.Path("vendor/microduck/policies").glob("*.onnx"))
m = mujoco.MjModel.from_xml_path(str(scene))
print(f"ok: mujoco {mujoco.__version__}, onnxruntime {onnxruntime.__version__}, {m.nu} actuators, policies: {', '.join(pol)}")
PY
echo "sim ready — DUCK_TRANSPORT=sim npm start"
