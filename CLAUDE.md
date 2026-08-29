# microduck-mcp — agent context

Agent-agnostic MCP server for the Pollen Robotics Microduck (~25cm, 800g biped,
$399, ships ~Christmas 2026). This file is the working context for AI coding
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
   `unix` (on-robot), `ssh` (laptop → robotctl over ssh). Selected via
   `DUCK_TRANSPORT` env. Mock-first because nobody has hardware until ~Dec.
3. **Server-side safety layer** (`src/safety.ts`) on top of robotd's own:
   velocity clamps, battery floor (15%) for motion, rate limiting, and a
   `duck_stop` tool that is NEVER gated. Rationale: we can't assume any
   calling agent is careful, and this moves physical hardware.
4. **Deliberately excluded (for now):** `update.apply` / rollback as tools.
   An agent auto-updating robot firmware is a footgun; revisit once the M2
   Hub policy channel ships, because that's when it becomes DuckHub's deploy
   backend (see sibling repo `duckhub`).

## Method names are provisional

The exact RPC method names (`robot.intent`, `robot.behavior`, `robot.stop`)
are inferred from the architecture doc's namespaces, NOT from a published
schema — the IPC contract is pre-1.0. **Before hardware ships:** diff against
upstream (their `docs/design/architecture.md` §2 and the robotctl source) and
correct `src/transport/*.ts` + tool wiring. Track upstream issues/releases.

## Transport roadmap

- v0 ssh transport shells out to `robotctl` (correct but slow).
- v1: forward the Unix sockets over ssh
  (`ssh -L /tmp/robotd.sock:/run/robotd.sock ...`) and reuse UnixTransport
  with remapped paths.
- v2 (maybe): WebRTC data-channel transport via mediad — same calls, works
  from a browser, no ssh. This is the interesting one for demos.

## Roadmap / TODO

- [ ] Verify RPC method names against upstream once schema stabilizes
- [ ] `duck_camera_snapshot` tool via mediad WebRTC (needs v2 transport work)
- [ ] `duck_depth` tool — tofd's 8×8 matrix via `tof.stream` subscription
- [x] `duck_monitor` — one-shot state sample (joints, gravity, odometry) — mock `robot.state`; method name provisional like the rest
- [x] Tests: safety layer unit tests (`npm test`, node:test on dist)
- [ ] Tests: transport contract tests (unix/ssh against a fake JSON-RPC socket)
- [ ] Publish: npm + MCP registries/directories once validated on hardware
- [ ] Integration guide per client (Claude Desktop config, Cursor, smolagents)

## Dev loop

- `npm test` — builds then runs `node --test` over `dist/**/*.test.js`.
- `npm run demo` — `scripts/demo.mjs` drives the server through the MCP SDK
  client in mock mode (the "health, walk, quack" conversation, scripted).
- Tests use `resetMotionCooldown()` from `src/safety.ts` to clear module
  state between cases; never call it from a tool.

## Conventions

- TypeScript strict, ESM, Node16 module resolution. `npm run build` must pass.
- Every motion tool goes through `preMotionCheck`. No exceptions except
  `duck_stop` and `quack`.
- Tool descriptions state their safety behavior explicitly (agents read them).
