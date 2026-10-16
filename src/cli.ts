#!/usr/bin/env node
/**
 * The `microduck-mcp` command. With no arguments it is the MCP server (what
 * every client config runs); the subcommands are for the person setting it up.
 * Each branch imports only what it needs, so the server starts no faster or
 * slower for the subcommands existing.
 */
import { spawn } from "node:child_process";

const USAGE = `usage:
  microduck-mcp                 run the MCP server (stdio; DUCK_TRANSPORT picks the robot)
  microduck-mcp setup-sim       one-time setup for DUCK_TRANSPORT=sim
  microduck-mcp sim-python ...  run the sim's Python (debugging, scripts/compose-demo.py)`;

const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case undefined:
    await import("./index.js");
    break;
  case "setup-sim": {
    const { setupSim } = await import("./sim-setup.js");
    process.exitCode = await setupSim(rest);
    break;
  }
  case "sim-python": {
    const { simHome, venvPython, SETUP_HINT } = await import("./sim-home.js");
    const { existsSync } = await import("node:fs");
    const py = process.env.DUCK_SIM_PYTHON ?? venvPython(simHome());
    if (!existsSync(py)) {
      console.error(SETUP_HINT);
      process.exitCode = 1;
      break;
    }
    const child = spawn(py, rest, { stdio: "inherit" });
    child.on("close", (code) => (process.exitCode = code ?? 1));
    break;
  }
  case "-h":
  case "--help":
    console.log(USAGE);
    break;
  default:
    console.error(`unknown command: ${cmd}\n\n${USAGE}`);
    process.exitCode = 2;
}
