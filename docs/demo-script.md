# Recording the demo

The demo is a real agent — Claude Code in headless mode (`claude -p`) —
driving this MCP server with the simulator behind it, captured at 30 fps and
composited into a split-screen MP4 (transcript left, live duck right).
Nothing is staged: the agent decides which tools to call.

```bash
sim/setup.sh                 # once
npm run build
npm run record-demo          # ~70 s take → demo-rec/{events.jsonl,frames/}
npm run compose-demo         # → demo-rec/demo.mp4  (1280x720, 30 fps, H.264)
```

`record-demo` needs `claude` on PATH with a logged-in account; a take costs
roughly $0.50 of API usage. `DEMO_VIEW` (follow|front|side|top),
`DEMO_DISTANCE` and `DEMO_PAUSE_MS` tune the capture. Pass a JSON array of
user turns as the second argument to change the shot list.

## Shot list (default)

| # | User turn | What it shows |
|---|---|---|
| 1 | Check the duck's health and tell me if it's safe to move. | `duck_health` — battery, loop rate, policy |
| 2 | Walk forward for 8 seconds, then show me what the duck sees through its head camera. | `duck_walk` blocks for the walk; `duck_camera head` lands in the transcript |
| 3 | Now sprint forward at 2 m/s for 3 seconds. | the safety layer clamps to 0.25 m/s and says so |
| 4 | Sit down, then quack. | `robot.do sit_toggle`, `robot.sound chirp` |
| 5 | Stand up, then do a forward roll and check whether it landed on its feet. | roulade; `duck_monitor` reports fallen/upright honestly |
| 6 | Stop the duck and give me a one-line summary of what it did. | `duck_stop`, wrap-up |

## Notes

- The sim under-tracks small commands (see README); 8 s at the cap is ~60 cm.
- The roulade lands or it doesn't. Both are good footage; if it falls, a
  follow-up turn "get up" demonstrates `robot.init` recovery.
- The sidecar records from the moment it starts, i.e. the first tool call;
  the compositor shows "starting MuJoCo…" before that.
