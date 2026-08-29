# microduck-mcp 🦆 — by [MicroduckHub](https://microduckhub.com)

**The universal agent interface for the [Pollen Robotics Microduck](https://github.com/pollen-robotics/microduck).**

An MCP (Model Context Protocol) server that lets *any* AI agent — Claude,
ChatGPT, Cursor, Gemini CLI, smolagents — drive a Microduck: walk it, sit it,
make it pick things up, read its health, and stop it.

Part of [MicroduckHub](https://microduckhub.com).

Works today with **no robot** via a built-in mock transport, so you can build
and test agent workflows before your duck ships.

## Quick start

```bash
npm install
npm run build

# Mock duck (default — no hardware needed)
npm start

# Real duck over ssh
DUCK_TRANSPORT=ssh DUCK_HOST=duck@microduck.local npm start

# On the robot itself
DUCK_TRANSPORT=unix npm start
```

### Try it without a client

```bash
npm test      # safety-layer + mock unit tests
npm run demo  # health → walk → monitor → quack → stop, through a real MCP client
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
| `duck_version` | Running vs installed software per daemon | read-only |
| `duck_updates` | Installed releases | read-only |
| `duck_monitor` | One-shot state: joints, gravity, gyro, odometry, current intent | read-only |
| `duck_walk` | Velocity intent (vx/vy/wz) | clamped, battery-gated, rate-limited |
| `duck_behavior` | sit / stand / getup / pickup / kick / quack | gated (quack is free) |
| `duck_stop` | Zero all motion, immediately | **never** gated |

## Safety

`robotd` on the robot holds the only write handle to the motor bus and enforces
joint clamps, fall→limp, and an intent deadman. This server adds its own layer
on top — velocity caps, a 15% battery floor for motion, rate limiting — because
an agent-agnostic tool can't assume the calling model is careful. `duck_stop`
is always available.

## Status

Pre-hardware scaffold. RPC method names are inferred from upstream's
architecture docs and will be verified against the real contract before ducks
ship (~Dec 2026). See `CLAUDE.md` for the full technical context and roadmap.

Apache-2.0-friendly; upstream robot software is Apache 2.0.
