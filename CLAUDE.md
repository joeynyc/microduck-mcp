# microduck-mcp — agent context

Agent-agnostic MCP server for the Pollen Robotics Microduck (~25cm, 800g biped,
$399, ships ~Christmas 2026). Published under the MicroduckHub brand
(microduckhub.com) but named for what it is: repo + npm are `microduck-mcp`.
Decided 2026-08-29 — brand is the umbrella, product is named for search. This file is the working context for AI coding
sessions on this repo.

## The robot's actual architecture (verified against upstream docs, Aug 2026)

- Seven Rust daemons on a Rockchip RK3566, talking **JSON-RPC 2.0, one object
  per line, over per-daemon Unix sockets**:
  - `robotd` (`/run/robotd.sock`) — `robot.*` — the ONLY thing that touches
    motors. 50 Hz loop, safety authority: joint clamps, fall→limp, intent
    deadman. Clients send *intents*, not motor commands.
  - `configd` (`/run/configd.sock`) — `net.*`, `pad.*`, `system.*`
  - `updaterd` (`/run/updaterd.sock`) — `update.*` — signed releases, atomic
    swap, health gate, auto-rollback
  - `btd`/`padd`/`mediad`/`tofd` are transports/sensors; mediad serves WebRTC
    (console :8080, signalling :8443)
- `robotctl` is the on-robot CLI; `robotctl health --json` gives a support
  bundle and exits non-zero when unhealthy (script-gateable).
- Upstream: github.com/pollen-robotics/microduck (Apache 2.0). Design docs in
  `docs/design/` are authoritative; when code and doc disagree, the doc that
  owns the mechanism wins.

## Design decisions already made — don't relitigate without reason

1. **Agent-agnostic.** No Claude-specific assumptions. Tool descriptions must
   be self-sufficient for any model. Target clients: Claude, ChatGPT, Cursor,
   Gemini CLI, smolagents (HF's own stack — strategic given the duck is a HF
   product).
2. **Transport abstraction** (`src/transport/`): `mock` (default, no hardware),
   `sim` (CPU MuJoCo + the official pretrained ONNX policies, via a Python
   sidecar), `unix` (on-robot), `ssh` (laptop → robotctl over ssh). Selected
   via `DUCK_TRANSPORT` env. Mock-first because nobody has hardware until
   ~Dec; sim is where behaviour gets validated before then.
3. **Server-side safety layer** (`src/safety.ts`) on top of robotd's own:
   velocity clamps, battery floor (15%) for motion, rate limiting, and a
   `duck_stop` tool that is NEVER gated. Rationale: we can't assume any
   calling agent is careful, and this moves physical hardware.
4. **Deliberately excluded (for now):** `update.apply` / rollback as tools.
   An agent auto-updating robot firmware is a footgun; revisit once the M2
   Hub policy channel ships, because that's when it becomes DuckHub's deploy
   backend (see sibling repo `duckhub`).

## Method names: ours vs upstream's (verified 2026-08-29)

Upstream now publishes the contract in `duck-ipc-proto/src/lib.rs` (commit
590b986). Our internal names predate it and **do not match**. The sim sidecar
accepts both; `unix`/`ssh` still send ours and must be renamed before hardware:

| ours (transport calls)        | upstream wire method                     | notes |
|-------------------------------|------------------------------------------|-------|
| `robot.intent {vx,vy,wz}`     | `robot.move {vx,vy,vyaw}` (notification) | continuous, last-writer-wins, deadman-stamped |
| `robot.behavior {name}`       | `robot.do {skill}` skill ∈ ground_pick, kick_left, kick_right, sit_toggle, roulade | no `getup`, no `stand`; sit↔stand is one toggle |
| —                             | `robot.head {neck_pitch,head_pitch,head_yaw,head_roll}` | sim implements it; no tool yet |
| `robot.stop`                  | `robot.stop`                             | same |
| `robot.health`                | `robot.health` → `HealthResult`          | `battery:{volts,percent}` — **percent, not fraction**; safety.ts reads `battery.fraction`, so the unix/ssh path needs an adapter |
| `robot.state` (duck_monitor)  | `robot.state` frame via `robot.subscribe` | upstream is a subscription stream; one-shot = subscribe, take one, close |
| `update.list`                 | `update.listInstalled`                   | |
| `system.version`              | `system.info` (+ updaterd `hello`)       | |

Also: `quack` is `robot.sound {tag}`, and bring-up (`robot.enable/init/relax`)
is not exposed at all yet. Obs layout, control chain and battery mapping are
ported verbatim in `sim/duck_sim.py` with line-level provenance.

## Sim transport (`DUCK_TRANSPORT=sim`)

- `sim/duck_sim.py` = headless CPU MuJoCo (scene from `microduck_rl`) driving
  the vendored `pollen-robotics/microduck/policies/*.onnx` with a port of
  robotd's `control.rs` (action scale 0.9, head/leg low-pass 0.5/0.7, standing
  net at |twist| ≤ 0.05, skill windows, cmd EMA 0.2, fall → limp). 200 Hz
  physics × 4 = 50 Hz policy, same as the robot.
- `sim/setup.sh` makes the venv and vendors both upstream repos at pinned
  SHAs into `sim/vendor/` (gitignored, ~30 MB). `MUJOCO_GL=egl` is set by the
  transport; works headless on WSL2.
- Speaks robotd's wire protocol over stdio, so `SimTransport` is
  `UnixTransport` with a child process where the socket is. Extra methods:
  `sim.camera {view,width,height}` → base64 PNG, `sim.reset`.
- **Known sim fidelity limit:** the reference scene's position actuators
  under-track small commands. Verified against upstream's own
  `infer_policy.py` (identical numbers, bit-identical obs): vx 0.2 → ~0
  m/s, 0.25 → 0.08, 0.4 → 0.16; yaw ~5% of commanded. Not a port bug;
  don't retune the scene to hide it. Our 0.25 m/s cap walks visibly.
- No stand-up policy ships, and robotd has no getup skill (fall → limp, a
  human rights it). In sim, `getup` teleports upright in place. It is the one
  motion tool allowed through `preMotionCheck` while unhealthy.
- Prior art: aj-dev-smith/microduck-mcp (Glama "duck-mcp") is sim-only and
  returns camera frames as file paths. Ours returns an MCP image block and
  keeps the transport contract so the same tools drive hardware.

## Transport roadmap

- v0 ssh transport shells out to `robotctl` (correct but slow).
- v1: forward the Unix sockets over ssh
  (`ssh -L /tmp/robotd.sock:/run/robotd.sock ...`) and reuse UnixTransport
  with remapped paths.
- v2 (maybe): WebRTC data-channel transport via mediad — same calls, works
  from a browser, no ssh. This is the interesting one for demos.

## Roadmap / TODO

- [x] Verify RPC method names against upstream — done, table above. **Next:**
      rename in `unix.ts`/`ssh.ts` and adapt `battery.percent` → fraction.
- [x] `sim` transport: CPU MuJoCo + official ONNX policies (`sim/duck_sim.py`)
- [x] `duck_camera` tool — sim renders; hardware path via mediad WebRTC still TODO
- [ ] `duck_head` tool (`robot.head`) — sim already handles it
- [ ] `duck_depth` tool — tofd's 8×8 matrix via `tof.stream` subscription
- [x] `duck_monitor` — one-shot state sample (joints, gravity, odometry) — mock `robot.state`; method name provisional like the rest
- [x] Tests: safety layer unit tests (`npm test`, node:test on dist)
- [x] Tests: sim transport contract tests (fake stdio sidecar, no MuJoCo)
- [ ] Tests: unix/ssh contract tests against a fake JSON-RPC socket
- [ ] Publish: npm + MCP registries/directories once validated on hardware
- [ ] Integration guide per client (Claude Desktop config, Cursor, smolagents)

## Dev loop

- `npm test` — builds then runs `node --test` over `dist/**/*.test.js`.
- `npm run demo` — `scripts/demo.mjs` drives the server through the MCP SDK
  client (the "health, walk, quack" conversation, scripted). With
  `DUCK_TRANSPORT=sim` it also grabs camera frames into `demo-out/`.
- `sim/setup.sh` once, then `DUCK_TRANSPORT=sim npm start`. Sidecar tuning
  via `DUCK_SIM_BATTERY_V` (test the battery floor), `DUCK_SIM_DEADMAN_S`,
  `DUCK_SIM_ARGS="--no-realtime"`.
- Tests use `resetMotionCooldown()` from `src/safety.ts` to clear module
  state between cases; never call it from a tool.

## Conventions

- TypeScript strict, ESM, Node16 module resolution. `npm run build` must pass.
- Every motion tool goes through `preMotionCheck`. No exceptions except
  `duck_stop` and `quack`; `getup` passes `allowUnhealthy` (battery + rate
  limit still apply).
- Tool descriptions state their safety behavior explicitly (agents read them).
