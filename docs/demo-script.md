# Recording the demo

The demo is a real agent — Claude Code in headless mode (`claude -p`) —
driving this MCP server with the simulator behind it, captured at 30 fps and
composited into a split-screen MP4 (transcript left, live duck right).
Nothing is staged: the agent decides which tools to call.

```bash
npm run setup-sim            # once
npm run build
npm run record-demo          # ~65 s take → demo-rec/{events.jsonl,frames/}
npm run compose-demo         # → demo-rec/demo.mp4  (1280x720, 30 fps, H.264), ~26 s
node dist/cli.js sim-python scripts/compose-demo.py demo-rec demo-rec/demo.mp4 --gif
                             # same, plus demo-rec/demo.gif (800 px, 10 fps) for the README
```

`record-demo` needs `claude` on PATH with a logged-in account; a take costs
roughly $0.40 of API usage. The session runs with `ENABLE_TOOL_SEARCH=false`
so the MCP tools are loaded up front; otherwise every turn opens with a
narrated "loading the walk tool" step. `DEMO_VIEW` (follow|front|side|top),
`DEMO_DISTANCE` and `DEMO_PAUSE_MS` tune the capture. Pass a JSON array of
user turns as the second argument to change the shot list.

## Shot list (default)

| # | User turn | What it shows |
|---|---|---|
| 1 | Check the duck's health and tell me if it's safe to move. | `duck_health` — battery, loop rate, policy |
| 2 | Walk forward for 6 seconds, then show me what the duck sees through its head camera. | `duck_walk` blocks for the walk; `duck_camera head` lands in the transcript |
| 3 | Now sprint forward at 2 m/s for 3 seconds. | the agent reads the 0.25 m/s cap from the tool description and says so |
| 4 | Do a forward roll and check whether it landed on its feet; if it didn't, get it back up. | roulade; `duck_monitor` reports fallen honestly; `getup` recovers |
| 5 | Stop the duck and give me a one-line summary of what it did. | `duck_stop`, wrap-up |

## Notes

- The sim under-tracks small commands (see README); 8 s at the cap is ~60 cm.
- The roulade fell in all four takes on 2026-10-16 (sim, policies at
  590b986). Shot 4 asks for recovery, so either outcome is good footage.
- `compose-demo` plays the duck at real speed whenever a tool is in flight
  (plus 3.5 s after a behavior starts) and the model's thinking time at 6×,
  with a "6x model thinking" badge on screen. The clock under the duck is
  always real time. `DEMO_IDLE_SPEED=1` turns the compression off.
- Read the transcript before using a take: the agent reports what
  `duck_monitor` says, so a sim problem shows up in its words. That is how
  the loop-rate misreport and the first-camera-call stall were found.
- The sidecar records from the moment it starts, i.e. the first tool call;
  the compositor shows "starting MuJoCo…" before that.
