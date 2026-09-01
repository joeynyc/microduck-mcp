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
   sidecar), `unix` (on-robot), `ssh` (laptop → the robot's sockets forwarded
   over `ssh -L`, then `unix`). Selected via `DUCK_TRANSPORT` env. Mock-first because nobody has hardware until
   ~Dec; sim is where behaviour gets validated before then.
3. **Server-side safety layer** (`src/safety.ts`) on top of robotd's own:
   velocity clamps, battery floor (15%) for motion, rate limiting, and a
   `duck_stop` tool that is NEVER gated. Rationale: we can't assume any
   calling agent is careful, and this moves physical hardware.
4. **Deliberately excluded (for now):** `update.apply` / rollback as tools.
   An agent auto-updating robot firmware is a footgun; revisit once the M8
   Hub policy channel ships, because that's when it becomes DuckHub's deploy
   backend (see sibling repo `duckhub`).
5. **Policy channel: load + reset only** (`src/policy.ts`, upstream's
   `policy-channel-design.md`). `duck_policy_list` / `duck_policy_load` /
   `duck_policy_reset`. `policy update` and `policy check` are excluded by the
   same rule as (4): nothing that fetches "the newest" and applies it. Load and
   reset are the safe pair because reset is a one-word undo, and a load is a
   config edit that survives a reboot (§3) so it needs one. Needs upstream
   API_VERSION 17; a v16 daemon's METHOD_NOT_FOUND is translated into "your
   daemon is too old". Origin (`pollen-robotics/*` official, any other HF repo
   community, a path local) is a constant in `protocol.ts` and never a config
   key. `walk = "none"` is refused: everything falls back to it. The HF
   `manifest.json` pre-check can only REFUSE (wrong obs/action width, newer
   `model_api`) — a missing or partial manifest still loads, because most of
   the Hub publishes none and robotd's shape gate is the real check.

## Wire protocol: upstream's, verbatim (since 2026-08-29)

Upstream publishes the contract in `duck-ipc-proto/src/lib.rs` (commit
590b986). **`src/transport/protocol.ts` is the only place method names and
enum spellings live**; every transport, the sidecar and the tools use it.
The shapes that needed adapting, and where the adapter is:

| agent-facing                | on the wire                                              | adapter |
|-----------------------------|----------------------------------------------------------|---------|
| `duck_walk {vx,vy,wz}`      | `robot.move {vx,vy,vyaw}` re-sent every 200 ms on a fixed grid (deadman is 500 ms), then `robot.stop` | `walk()` in safety.ts (intents are deadman-stamped; a walk is a stream) |
| `duck_behavior sit/stand`   | `robot.do {skill:"sit_toggle"}`                          | tool checks `state().policy === "sit"` first, so sit-while-seated is a no-op |
| `duck_behavior getup`       | `robot.init` (power joints, ramp to home)                | gate "recovery"; on hardware a human rights the duck first |
| `duck_behavior pickup/kick/roulade` | `robot.do {skill: ground_pick / kick_right / roulade}` | `BEHAVIORS` table in safety.ts |
| `duck_behavior quack`       | `robot.sound {tag:"chirp"}`                              | (what `robotctl quack` plays) |
| battery floor               | `robot.health` → `battery:{volts,percent}`               | `preMotionCheck` reads `percent` |
| `duck_monitor`              | `robot.subscribe {hz:50}` → first `robot.state` frame    | `DuckTransport.state()`: unix/ssh subscribe-and-take-one; sim/mock answer `robot.state` directly |
| `duck_policy_list`          | `robot.policies`                                          | origin filled in from the source string when the daemon omits it |
| `duck_policy_load`          | `robot.loadPolicy {slot, source}`                        | `policy.ts`: walk≠none, manifest pre-check, gated like motion (a load homes the robot and rebuilds all seven sessions) |
| `duck_policy_reset`         | `robot.loadPolicy {slot, source: null}`                  | null = remove the config key (§3); no slot = all seven |
| `duck_version`              | `system.info` (configd)                                  | |
| `duck_updates`              | `update.listInstalled {component:"daemon"}`              | |

Intents sent as *requests* (with an id) are answered with `IntentResult`
(`robotd/src/main.rs:2682`), so no notification path is needed. Not exposed
yet: `robot.head`, `robot.look`, `robot.pose`, `robot.mouth`, `robot.enable`,
`robot.relax`, `robot.shutdown`, `robot.setMode`.

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

- ~~v0 ssh transport shells out to `robotctl`~~ — dead end: robotctl has no
  motion subcommands.
- v1 (current): `SshTransport` forwards the three Unix sockets over
  `ssh -N -L` into a temp dir and delegates to `UnixTransport`. Needs
  OpenSSH ≥ 6.7 on both ends; no robot-side install.
- v2 (maybe): WebRTC data-channel transport via mediad — same calls, works
  from a browser, no ssh. This is the interesting one for demos.

## Roadmap / TODO

- [x] Verify RPC method names against upstream and speak them verbatim —
      done, `protocol.ts` + table above. Untested on hardware, obviously.
- [x] `sim` transport: CPU MuJoCo + official ONNX policies (`sim/duck_sim.py`)
- [x] `duck_camera` tool — sim renders; hardware path via mediad WebRTC still TODO
- [ ] `duck_head` tool (`robot.head`) — sim already handles it
- [ ] `duck_depth` tool — tofd's 8×8 matrix via `tof.stream` subscription
- [x] `duck_monitor` — one-shot state sample (joints, gravity, odometry)
- [x] Tests: safety layer unit tests (`npm test`, node:test on dist)
- [x] Tests: sim transport contract tests (fake stdio sidecar, no MuJoCo)
- [x] Tests: unix contract tests against a fake robotd socket (incl.
      subscribe → first frame); ssh forwarding argv
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
- Every motion tool goes through `preMotionCheck`. `duck_stop` is never
  gated. Behaviors are gated by the `BEHAVIOR_GATES` table in `safety.ts`
  (quack: none; getup: recovery = allowUnhealthy, battery + rate limit still
  apply); the tool enum derives from that table — add behaviors there.
- `duck_walk` is transport-independent: `walk()` in `safety.ts` re-sends
  `robot.move` every 200 ms (on a fixed grid, under the 500 ms deadman) for `duration_s` then sends `robot.stop`, because
  upstream's intents are deadman-stamped. `duck_stop` interrupts it via
  `stopWalk()`.
- Never spell a wire method inline — import `M` from `transport/protocol.ts`.
  `DuckTransport.call(method, params)` routes to the daemon by the method's
  namespace (`serviceFor` in `types.ts`); there is no service argument.
- Every tool is registered through `tool()` in `index.ts`, which turns a
  thrown error into an `isError` result. Don't call `server.registerTool`
  directly. The server closes its transport on SIGINT/SIGTERM/SIGHUP and when
  the client disconnects (kills the ssh tunnel / sim sidecar, removes temp
  dirs); `SshTransport` forgets a failed or dead tunnel so the next call
  reconnects.
- Camera is a transport *capability* (`DuckTransport.snapshot?`), not an RPC
  name: sim renders, mock returns a placeholder, unix/ssh have none until
  mediad is wired.
- Tool descriptions state their safety behavior explicitly (agents read them).
