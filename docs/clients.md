# Connecting a client

microduck-mcp is a local **stdio** MCP server: the client starts it with
`npx -y microduck-mcp` and talks to it over stdin/stdout. Any client that can
launch a local MCP server can drive the duck. Below are copy-paste configs for
the common ones.

## First: pick a duck

Every config below sets `DUCK_TRANSPORT`. Choose one:

| You have | `env` | Before you start |
|---|---|---|
| No robot, just trying it | `"DUCK_TRANSPORT": "mock"` | nothing |
| No robot, want real physics + camera | `"DUCK_TRANSPORT": "sim"` | `npx -y microduck-mcp setup-sim` once |
| A duck on your network | `"DUCK_TRANSPORT": "ssh"`, `"DUCK_HOST": "duck@microduck.local"` | ssh access to the duck |
| This server running on the duck | `"DUCK_TRANSPORT": "unix"` | nothing |

The examples use `sim`. Swap the `env` block for any row above.

`setup-sim` prints a ready-to-paste config when it finishes. If you set
`DUCK_SIM_HOME` for it, put the same `DUCK_SIM_HOME` in the client's `env`.

The first launch downloads the package, which can take longer than a client's
startup timeout. If a client reports that the server failed to start, run
`npx -y microduck-mcp --help` once in a terminal to warm the cache, then retry.

## Claude Desktop

Settings → Developer → **Edit Config**, which opens
`claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "microduck": {
      "command": "npx",
      "args": ["-y", "microduck-mcp"],
      "env": { "DUCK_TRANSPORT": "sim" }
    }
  }
}
```

Quit and restart Claude Desktop completely. The tools appear under the
connectors menu in the chat input. Server logs are in `~/Library/Logs/Claude`
(macOS) or `%APPDATA%\Claude\logs` (Windows), in `mcp-server-microduck.log`.

**Windows with the sim in WSL:** the sim runs on Linux, so run the server in
WSL too:

```json
"microduck": {
  "command": "wsl.exe",
  "args": ["-e", "bash", "-lc", "DUCK_TRANSPORT=sim npx -y microduck-mcp"]
}
```

## Claude Code

```bash
claude mcp add microduck -s user -e DUCK_TRANSPORT=sim -- npx -y microduck-mcp
```

`-s user` makes it available in every project. Use `-s project` to write a
`.mcp.json` you can commit, so everyone on the repo gets the duck. Check it
with `claude mcp list`, or `/mcp` inside a session.

## Cursor

`~/.cursor/mcp.json` (every project) or `.cursor/mcp.json` (this project):

```json
{
  "mcpServers": {
    "microduck": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "microduck-mcp"],
      "env": { "DUCK_TRANSPORT": "sim" }
    }
  }
}
```

## VS Code (Copilot agent mode)

`.vscode/mcp.json` in the workspace, or **MCP: Open User Configuration** for
every workspace. Note the top-level key is **`servers`**, not `mcpServers`:

```json
{
  "servers": {
    "microduck": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "microduck-mcp"],
      "env": { "DUCK_TRANSPORT": "sim" }
    }
  }
}
```

## Gemini CLI

```bash
gemini mcp add -s user -e DUCK_TRANSPORT=sim microduck npx -y microduck-mcp
```

This writes `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "microduck": {
      "command": "npx",
      "args": ["-y", "microduck-mcp"],
      "env": { "DUCK_TRANSPORT": "sim" }
    }
  }
}
```

Use `-s user`. Gemini CLI's default is `-s project`, and it does not start
project-level servers in a folder you haven't trusted: `gemini mcp list` shows
them as **Disabled**. Either add it at user scope or trust the folder.

## Codex CLI (OpenAI)

```bash
codex mcp add microduck --env DUCK_TRANSPORT=sim -- npx -y microduck-mcp
```

Then raise the startup timeout in `~/.codex/config.toml`. The default is 10 s,
which a first `npx` download can exceed:

```toml
[mcp_servers.microduck]
command = "npx"
args = ["-y", "microduck-mcp"]
startup_timeout_sec = 30

[mcp_servers.microduck.env]
DUCK_TRANSPORT = "sim"
```

The default `tool_timeout_sec` of 60 s is fine. The longest call, a 10 s
`duck_walk`, returns well inside it.

## smolagents (Hugging Face)

```bash
pip install "smolagents[mcp]" "mcp<2"
```

The `mcp<2` pin is needed for now: smolagents' MCP adapter (`mcpadapt`
0.1.20) imports a function that the `mcp` 2.x SDK renamed, so an unpinned
install fails with `ImportError: cannot import name 'streamablehttp_client'`.

```python
import os
from mcp import StdioServerParameters
from smolagents import CodeAgent, InferenceClientModel, MCPClient

params = StdioServerParameters(
    command="npx",
    args=["-y", "microduck-mcp"],
    env={**os.environ, "DUCK_TRANSPORT": "sim"},
)

with MCPClient(params, structured_output=True) as tools:
    agent = CodeAgent(tools=tools, model=InferenceClientModel())
    agent.run("Check the duck's health, then walk it forward for two seconds and quack.")
```

`structured_output=True` hands the agent each result as a Python dict rather
than a JSON string, so its code can read `health["battery"]["percent"]`
directly. `duck_camera` comes back as a PIL image. smolagents keeps only the
first content item of a result, and the image is first, so the agent gets the
picture but not the short text note beside it.

The tools are ordinary smolagents tools, so you can also call them without a
model: `{t.name: t for t in tools}["duck_health"]()`.

## ChatGPT

Not directly. ChatGPT connects only to **remote** MCP servers over HTTPS, and
microduck-mcp is a local stdio server. Running it for ChatGPT would need an
HTTP transport plus a tunnel to your machine, and neither is built yet. For an
OpenAI model today, use the Codex CLI above.

## Safety in every client

The server applies its own limits whichever client calls it: velocity caps, a
15 % battery floor, rate limiting, and a refusal to move while someone is
holding the duck. `duck_stop` is never gated. If your client asks for approval
on each tool call, consider pre-approving `duck_stop`, so that stopping the
duck never waits on a click. In Claude Code, for example, add
`"mcp__microduck__duck_stop"` to `permissions.allow` in your settings.

## Troubleshooting

- **Run it by hand.** `DUCK_TRANSPORT=sim npx -y microduck-mcp` should print
  `microduck-mcp … up (transport: sim)` on stderr, then wait for a client.
  Press Ctrl-C to quit.
- **"The sim isn't set up yet."** Run `npx -y microduck-mcp setup-sim`.
- **The server starts, but the first sim call is slow.** The sim starts on the
  first tool call, not when the server launches. That takes about a second
  after setup-sim, longer on a cold disk.
- **`npx` not found** (often a GUI app on macOS that doesn't see your shell's
  PATH): use the full path from `which npx` as `command`.

---

Tested 2026-10-16 on Linux (WSL2), Node 22, against microduck-mcp 0.1.0 from a
packed tarball:

- **Claude Code 2.1.301, Gemini CLI 0.49.0, Codex CLI 0.163.0:** each CLI's
  own `mcp add` wrote the configs shown above.
- **smolagents 1.26.0 (mcp 1.30.0):** loaded all 12 tools, and health, walk,
  behavior and camera calls worked against the sim.
- **Windows → WSL launch:** the `wsl.exe -e bash -lc …` command, run from
  the Windows side, served all 12 tools against the sim.
- **Claude Desktop, Cursor and VS Code:** written from each client's current
  documentation, not run.
