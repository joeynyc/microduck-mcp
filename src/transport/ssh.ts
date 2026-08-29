import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DuckService, DuckTransport } from "./types.js";

const exec = promisify(execFile);

/**
 * SSH transport — for running the MCP server on a laptop.
 *
 * v0 strategy: rather than reimplementing the socket protocol over an ssh
 * tunnel, shell out to `robotctl` on the robot, which already speaks to every
 * daemon and offers `--json` on the commands that matter. This trades latency
 * for correctness while the IPC contract is still settling (pre-1.0).
 *
 * A future v1 can forward the Unix sockets
 * (`ssh -L /tmp/robotd.sock:/run/robotd.sock duck@host`) and reuse
 * UnixTransport with remapped paths — see CLAUDE.md "Transport roadmap".
 */
export class SshTransport implements DuckTransport {
  constructor(
    private host: string, // e.g. "duck@microduck.local"
    private sshArgs: string[] = ["-o", "ConnectTimeout=5"],
  ) {}

  private async robotctl(args: string[]): Promise<string> {
    const { stdout } = await exec("ssh", [
      ...this.sshArgs,
      this.host,
      "robotctl",
      ...args,
    ]);
    return stdout;
  }

  async call(
    _service: DuckService,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    // Map the RPC namespace onto robotctl subcommands.
    switch (method) {
      case "robot.health": {
        const out = await this.robotctl(["health", "--json"]);
        return JSON.parse(out);
      }
      case "system.version": {
        const out = await this.robotctl(["version"]);
        return { raw: out.trim() };
      }
      case "update.list": {
        const out = await this.robotctl(["update", "list"]);
        return { raw: out.trim() };
      }
      default:
        throw new Error(
          `SshTransport has no robotctl mapping for ${method} yet ` +
            `(params: ${JSON.stringify(params ?? {})}). ` +
            `Add one in src/transport/ssh.ts.`,
        );
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.robotctl(["version"]);
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {}
}
