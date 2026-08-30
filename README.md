# microduck-mcp 🦆 — by [MicroduckHub](https://microduckhub.com)

**The universal agent interface for the [Pollen Robotics Microduck](https://github.com/pollen-robotics/microduck).**

An MCP (Model Context Protocol) server that lets *any* AI agent — Claude,
ChatGPT, Cursor, Gemini CLI, smolagents — drive a Microduck: walk it, sit it,
make it pick things up, read its health, and stop it.

Part of [MicroduckHub](https://microduckhub.com).

Works today with **no robot**: a mock transport for instant canned state, and
a **simulator** — CPU MuJoCo running Pollen's official pretrained ONNX
policies — so agents can walk, sit, kick and *look at* a physically simulated
duck before yours ships.

## Quick start

```bash
npm install
npm run build

# Mock duck (default — no hardware needed)
npm start

# Simulated duck: CPU MuJoCo + official ONNX policies (one-time setup ~1 min)
sim/setup.sh            # needs uv (https://docs.astral.sh/uv/); vendors ~30 MB of assets
DUCK_TRANSPORT=sim npm start

# Real duck over ssh
DUCK_TRANSPORT=ssh DUCK_HOST=duck@microduck.local npm start

# On the robot itself
DUCK_TRANSPORT=unix npm start
```

### Try it without a client

```bash
npm test                         # safety layer, mock, sim-transport contract tests
npm run demo                     # health → walk → monitor → camera → quack → stop (mock)
DUCK_TRANSPORT=sim npm run demo  # same, in MuJoCo; frames land in demo-out/
```

### Claude Desktop / Claude Code config

```json
{
  "mcpServers": {
    "microduck": {
      "command": "node",
      "args": ["/path/to/microduck-mcp/dist/index.js"],
      "env": { "DUCK_TRANSPORT": "mock" }
    }
  }
}
```

If Claude Desktop runs on Windows and this repo lives in WSL, use
`"command": "wsl.exe", "args": ["-e", "/abs/path/to/node", "/home/you/microduck-mcp/dist/index.js"]`.
Or for Claude Code: `claude mcp add microduck -e DUCK_TRANSPORT=mock -- node /path/to/dist/index.js`.

## Tools

| Tool | What it does | Guarded? |
|---|---|---|
| `duck_health` | Battery, temps, loop rate, loaded policy | read-only |
| `duck_version` | Robot name, serial, uptime | read-only |
| `duck_updates` | Installed releases | read-only |
| `duck_monitor` | One-shot state: joints, gravity, gyro, odometry, current intent | read-only |
| `duck_camera` | PNG frame: head camera or follow/front/side/top view (sim today) | read-only |
| `duck_walk` | Velocity intent (vx/vy/wz) for `duration_s`, then auto-stops | clamped, battery-gated, rate-limited |
| `duck_behavior` | sit / stand / getup / pickup / kick / roulade / quack | gated (quack is free; getup allowed while fallen) |
| `duck_stop` | Zero all motion, immediately | **never** gated |

## Safety

`robotd` on the robot holds the only write handle to the motor bus and enforces
joint clamps, fall→limp, and an intent deadman. This server adds its own layer
on top — velocity caps, a 15% battery floor for motion, rate limiting — because
an agent-agnostic tool can't assume the calling model is careful. `duck_stop`
is always available.

## Transports

| `DUCK_TRANSPORT` | What | Needs |
|---|---|---|
| `mock` (default) | Canned state, instant | nothing |
| `sim` | Headless CPU MuJoCo running the official `alpha_*.onnx` policies with robotd's control chain, in a Python sidecar (`sim/duck_sim.py`) | `sim/setup.sh` |
| `unix` | The robot's own daemons over `/run/*.sock` | running on the duck |
| `ssh` | The same sockets forwarded over `ssh -L`, then `unix` | a duck on the network, ssh access |

All four sit behind one `DuckTransport` interface, so the tools — and the
safety layer — are identical whether the duck is simulated or real.

Sim fidelity note: the reference MuJoCo scene under-tracks small velocity
commands (verified identical to upstream's own `infer_policy.py`). Expect
~0.08 m/s at the 0.25 m/s cap and weak yaw. It walks, sits, stands, kicks
and rolls; it just isn't a speed benchmark.

## Ecosystem

- [MicroduckHub](https://microduckhub.com) — DuckHub, the community policy browser this server will back once upstream's M8 model channel ships.
- [awesome-microduck](https://github.com/joeynyc/awesome-microduck) — the curated ecosystem list.

## Status

Pre-hardware. Every transport speaks upstream's published wire protocol
(`duck-ipc-proto`, see `src/transport/protocol.ts`); the sim path is
validated end to end, the `unix`/`ssh` paths against a fake daemon only —
first contact with a real duck is ~Dec 2026.

Apache-2.0-friendly; upstream robot software is Apache 2.0.
