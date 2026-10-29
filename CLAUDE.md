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
5. **Policy channel: list + search + load + reset** (`src/policy.ts`, upstream's
   `policy-channel-design.md`, shipped in daemon 0.13 = API_VERSION 18–20).
   `duck_policy_list` / `duck_policy_search` / `duck_policy_load` /
   `duck_policy_reset`. `policy.check` and `policy.install` (the official set's
   update path) are excluded by the same rule as (4): nothing that fetches "the
   newest" and applies it. Load and reset are the safe pair because reset is a
   one-word undo, and a load is a config edit that survives a reboot (§3) so it
   needs one. On the wire a load of a Hub repo is `policy.fetch` (updaterd,
   downloads into `/var/lib/robot/policies/` and reads the manifest) then
   `robot.loadPolicy {slot, path}` (robotd); an absolute path skips the fetch.
   `LoadPolicyParams` is `deny_unknown_fields`: only `slot` and `path` ever go
   on the wire. Reset = same method, no path; reset-all = neither field, one
   call. An older daemon's METHOD_NOT_FOUND is translated into "your daemon is
   too old". Origin (`pollen-robotics/*` official, any other HF repo community,
   a path local) is decided by the daemon and reported back; our constant in
   `protocol.ts` is only for what we say before asking. `walk = "none"` is
   refused (by us first, by the daemon too). We do NOT read manifests
   ourselves any more: `policy.fetch` answers with the daemon's reading of it.

## Wire protocol: upstream's, verbatim (since 2026-08-29)

Upstream publishes the contract in `duck-ipc-proto/src/lib.rs`. Motion,
health and state were verified at commit 590b986 (API_VERSION 16) and
re-checked unchanged at 2703e09 (daemon 0.13.0, API_VERSION 28); the policy
channel is written against 2703e09. **Re-audited at d7560ef (daemon 0.17.4,
API_VERSION 44, 2026-10-16):** every method and every `deny_unknown_fields`
params struct we send is unchanged; the changes were additive and two were
adopted (`robot.policies.sitting`, `safety.picked_up` — see below). The sim vendors 590b986 because the
`.onnx` files left the repo for the Hub after it. **`src/transport/protocol.ts` is the only place method names and
enum spellings live**; every transport, the sidecar and the tools use it.
The shapes that needed adapting, and where the adapter is:

| agent-facing                | on the wire                                              | adapter |
|-----------------------------|----------------------------------------------------------|---------|
| `duck_walk {vx,vy,wz}`      | `robot.move {vx,vy,vyaw}` re-sent every 200 ms on a fixed grid (deadman is 500 ms), then `robot.stop` | `walk()` in safety.ts (intents are deadman-stamped; a walk is a stream) |
| `duck_behavior sit/stand`   | `robot.do {skill:"sit_toggle"}`                          | `isSeated()` in safety.ts asks `robot.policies.sitting` first (v44; falls back to the frame's `policy === "sit"` on older daemons and the sim), so sit-while-seated is a no-op |
| `duck_behavior getup`       | `robot.init` (power joints, ramp to home)                | gate "recovery"; on hardware a human rights the duck first |
| `duck_behavior pickup/kick/roulade` | `robot.do {skill: ground_pick / kick_right / roulade}` | `BEHAVIORS` table in safety.ts |
| `duck_behavior quack`       | `robot.sound {tag:"chirp"}`                              | (what `robotctl quack` plays) |
| battery floor               | `robot.health` → `battery:{volts,percent}`               | `preMotionCheck` reads `percent` |
| `duck_monitor`              | `robot.subscribe {hz:50}` → first `robot.state` frame    | `DuckTransport.state()`: unix/ssh subscribe-and-take-one; sim/mock answer `robot.state` directly |
| `duck_policy_list`          | `robot.policies` → `{mode, enabled, slots[{slot,path,origin,overridden,error}], skills, change_error}` | passed through |
| `duck_policy_search`        | `policy.search {query}` (updaterd) → `{models[{id,origin,likes,downloads}]}` | unwrapped |
| `duck_policy_load`          | HF repo: `policy.fetch {repo, revision?}` (updaterd) → `robot.loadPolicy {slot, path}`; path: just the load | `policy.ts`: walk≠none, gated like motion (a load homes the robot and rebuilds all seven sessions) |
| `duck_policy_reset`         | `robot.loadPolicy {slot}` / `{}`                          | no path = remove the config key (§3); no slot = all seven in one call |
| `duck_version`              | `system.info` (configd)                                  | |
| `duck_updates`              | `update.listInstalled {component:"daemon"}`              | |

Intents sent as *requests* (with an id) are answered with `IntentResult`
(`robotd/src/main.rs:2682`), so no notification path is needed;
`robot.loadPolicy` answers the same way and a refusal is raised. Not exposed
yet: `robot.head`, `robot.look`, `robot.pose`, `robot.mouth`, `robot.enable`,
`robot.relax`, `robot.shutdown`, `robot.setMode`, `robot.skills` /
`robot.setSkill` (skills are config since v22; `robot.policies.skills` lists
them). New by v44 and also not exposed: `robot.rest` (sit, ease down, torque
off — shutdown without the power-off), `robot.flashlight {on,toggle,color}`,
the vetbook (`robot.vetbook*`, `vetbook.share` publishes to the Hub), and
`robot.health` extras (`cpu_throttle`, servo-bus `missing` ids).

**Camera on hardware** (`src/transport/media.ts`): `duck_camera` fetches
`GET /frame` from mediad's console (`:8080`, always served) — mediad's own
consumer of the raw `media.frame` socket, which does the hello handshake,
the UYVY decode and the mount rotation and answers an upright `image/png`
(503 + a sentence when capture is down). We deliberately do not speak
`media.frame` itself (`/run/mediad/media.sock`, group `robot`, JSON header
then raw UYVY): a picture for an agent needs none of the pixel work, and the
console is where upstream put it. On the robot the endpoint is
`127.0.0.1:8080` (`DUCK_MEDIA_PORT` overrides); over ssh it is forwarded to
`<tmp>/media.http.sock` next to the daemon sockets, hence node:http with a
`socketPath` rather than fetch. Hardware has one camera at native size: a
sim-only `view` or a requested size is answered with the head camera and a
note saying so.

## Sim transport (`DUCK_TRANSPORT=sim`)

- `sim/duck_sim.py` = headless CPU MuJoCo (scene from `microduck_rl`) driving
  the vendored `pollen-robotics/microduck/policies/*.onnx` with a port of
  robotd's `control.rs` (action scale 0.9, head/leg low-pass 0.5/0.7, standing
  net at |twist| ≤ 0.05, skill windows, cmd EMA 0.2, fall → limp). 200 Hz
  physics × 4 = 50 Hz policy, same as the robot.
- `microduck-mcp setup-sim` (`src/sim-setup.ts`; `npm run setup-sim` from a
  checkout) builds everything in the **sim home** (`src/sim-home.ts`:
  `DUCK_SIM_HOME`, else `~/.local/share/microduck-mcp/sim`, macOS Application
  Support, Windows LOCALAPPDATA) — never inside the package, because under
  `npx` that is npm's cache. Python: uv if on PATH (fetches 3.10 itself), else
  a system 3.10–3.13 + venv/pip; packages pinned exactly. Assets: the 127
  files listed in `sim/assets.json` (scene dir at microduck_rl d424a0c,
  policies at microduck 590b986, ~33 MB), fetched from raw.githubusercontent
  and sha256-checked — no git; intact files are kept, so re-runs repair. Ends
  with a smoke test (robot.health + one rendered frame). `sim/assets.json` is
  generated by `npm run gen-sim-assets` (dev-only, needs git) — re-run it after
  changing a pin there. Assets live under `<repo>@<rev7>/`, so a re-pin never
  mixes revisions. `MUJOCO_GL=egl` is set by the transport on Linux only;
  works headless on WSL2. macOS/Windows rendering is untested.
- The `bin` is `src/cli.ts`: no args = the MCP server (`index.ts`), plus
  `setup-sim` and `sim-python …` (runs the sim venv's interpreter).
- Speaks robotd's wire protocol over stdio, so `SimTransport` is
  `UnixTransport` with a child process where the socket is. Extra methods:
  `sim.camera {view,width,height}` → base64 PNG, `sim.reset`, `sim.stats`
  (loop-timing diagnostics since the last call: max tick gap, min hz,
  missed, worst serve/tick/overshoot — used by `bench/camera-stall.sh`).
- `loop.hz` is the achieved rate over the last second of wall time (what
  robotd's means), not 1/(last tick interval): catch-up ticks after a stall
  run back to back and read as ~500 Hz each.
- Camera frames render on a `RenderWorker` thread that owns the GL context:
  the loop thread only copies `MjData` (`mj_copyData`, ~0.1 ms, pooled
  snapshots) and moves on, and the worker answers `sim.camera` itself. A
  frame shows the state at request time. Before this a render (~50 ms) ran
  between ticks: 19 missed ticks and a 115 ms worst gap per 10 s walk at
  2 Hz camera; now 0 and ~20.4 ms. At most 8 frames queue (`camera busy`
  after that). The default 320×240 renderer is built on the worker before
  `sim.ready`. While idle the loop waits on its inbox, so a request is
  served when it lands rather than at the next tick.
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
- [x] `duck_camera` tool — sim renders; hardware via mediad's console `/frame` (fake-console tests only until Dec)
- [ ] `duck_head` tool (`robot.head`) — sim already handles it
- [ ] `duck_depth` tool — tofd's 8×8 matrix via `tof.stream` subscription
- [x] `duck_monitor` — one-shot state sample (joints, gravity, odometry)
- [x] Tests: safety layer unit tests (`npm test`, node:test on dist)
- [x] Tests: sim transport contract tests (fake stdio sidecar, no MuJoCo)
- [x] Tests: unix contract tests against a fake robotd socket (incl.
      subscribe → first frame); ssh forwarding argv
- [ ] Publish: npm + MCP registries/directories once validated on hardware
- [x] Integration guide per client — `docs/clients.md`. Claude Code / Gemini
      CLI / Codex configs were written by each CLI's own `mcp add`; smolagents
      ran for real (needs `mcp<2`: mcpadapt 0.1.20 imports a name mcp 2.x
      renamed; `structured_output=True` gives the agent dicts); the WSL
      `wsl.exe -e bash -lc` route ran. Desktop/Cursor/VS Code from docs only.
- [ ] ChatGPT: it only connects to remote HTTPS MCP servers, so it needs a
      streamable-HTTP mode for this server + a tunnel. Codex CLI is the OpenAI
      path until then.
- [x] Tool annotations — required by `tool()` in `index.ts`: `READ_ONLY` for
      the read tools, `MOTION` for walk/behavior, policy load/reset marked
      destructive (they rewrite config; reset is the undo)

## Dev loop

- `npm test` — builds then runs `node --test` over `dist/**/*.test.js`.
- `npm run demo` — `scripts/demo.mjs` drives the server through the MCP SDK
  client (the "health, walk, quack" conversation, scripted). With
  `DUCK_TRANSPORT=sim` it also grabs camera frames into `demo-out/`.
- `npm run setup-sim` once, then `DUCK_TRANSPORT=sim npm start`. Sidecar tuning
  via `DUCK_SIM_BATTERY_V` (test the battery floor), `DUCK_SIM_DEADMAN_S`
  (default 0.5 = robotd's, so a resend regression stalls the sim too),
  `DUCK_SIM_ARGS="--no-realtime"`.
- Tests use `resetMotionCooldown()` from `src/safety.ts` to clear module
  state between cases; never call it from a tool.
- `bash bench/camera-stall.sh` — physics parity check (`bench/parity.py`:
  fixed command script on a tick-count clock, sha256 of every tick's
  qpos+qvel+action vs `bench/parity-hash.txt`) then the camera-during-walk
  timing bench. Any sim refactor that changes the hash changed behaviour.
- `node bench/cold-start.mjs` — SimTransport construction → first
  `robot.health` and first frame, median of 5. The ONNX sessions run
  single-threaded on purpose (default per-session pools cost ~1 s of
  startup and ~4× tick time on a many-core box; outputs are bit-identical).
  `sim.ready` waits for the GL context on purpose: built beside a running
  loop it holds the GIL ~0.55 s and stalls a walk past the deadman.

## Conventions

- TypeScript strict, ESM, Node16 module resolution. `npm run build` must pass.
- Every motion tool goes through `preMotionCheck`. `duck_stop` is never
  gated. It refuses while `safety.picked_up` (someone is holding the duck):
  robotd pauses the policy but keeps the intent and resumes ~0.2 s after
  set-down, so a walk would carry on out of their hands. Recovery (getup)
  is exempt. An in-flight `walk()` watches for a pick-up on a held-open
  `robot.subscribe` stream (`DuckTransport.watchState?`, unix and ssh) and
  falls back to sampling `state()` every 100 ms (`HELD_WATCH_MS`; robotd
  holds a pause ≥300 ms) when the transport has no stream or it goes quiet
  for 0.5 s; a pick-up ends it with `robot.stop` at once, never waiting on
  a slow sample. Behaviors are gated by the `BEHAVIOR_GATES` table in `safety.ts`
  (quack: none; getup: recovery = allowUnhealthy, battery + rate limit still
  apply); the tool enum derives from that table — add behaviors there.
- `duck_walk` is transport-independent: `walk()` in `safety.ts` sends
  `robot.move` every 200 ms on a fixed grid of the monotonic clock (under
  the 500 ms deadman) for `duration_s`, because upstream's intents are
  deadman-stamped. Sends are pipelined, not awaited: a slow round trip must
  not push the next one off the grid. Every way a walk ends (duration,
  pick-up, failed intent, `duck_stop` via `stopMotion()`) sends `robot.stop`
  at once and again once every intent still on the wire has been answered
  (per-call connections don't order them). The rate-limit slot is taken
  before the health round trip, so parallel motion calls can't both pass.
- `node bench/walk-link.mjs` (after `npx tsc`) — `walk()`/`stopMotion()`
  over a seeded lossy link (5–40 ms, 10% spikes to 350 ms, reordering):
  intent arrival gaps vs the deadman, stop and pick-up latency, and
  ordering violations.
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
  name: sim renders, mock returns a placeholder, unix/ssh fetch mediad's
  console `/frame` (see "Camera on hardware" above).
- Tool descriptions state their safety behavior explicitly (agents read them).
