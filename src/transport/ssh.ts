import { spawn, ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RobotState } from "./protocol.js";
import { DuckService, DuckTransport, Snapshot, SnapshotRequest, pingViaHealth } from "./types.js";
import { SOCKETS, UnixTransport } from "./unix.js";

/**
 * SSH transport — for running the MCP server on a laptop.
 *
 * Forwards the robot's three daemon sockets to local paths
 * (`ssh -N -L <tmp>/robotd.sock:/run/robotd.sock ...`) and speaks to them
 * through UnixTransport. Same protocol, same code path as on the robot; the
 * only ssh-specific part is the tunnel. (The v0 design shelled out to
 * `robotctl`, which has no motion subcommands — a dead end for walking.)
 */
export class SshTransport implements DuckTransport {
  private proc?: ChildProcess;
  private dir?: string;
  private inner?: Promise<UnixTransport>;

  constructor(
    private host: string, // e.g. "duck@microduck.local"
    private sshArgs: string[] = ["-o", "ConnectTimeout=5", "-o", "ExitOnForwardFailure=yes"],
    private readyTimeoutMs = 15_000,
  ) {}

  /** Local socket paths for a forwarding directory. */
  static localPaths(dir: string): Record<DuckService, string> {
    return {
      robotd: join(dir, "robotd.sock"),
      configd: join(dir, "configd.sock"),
      updaterd: join(dir, "updaterd.sock"),
    };
  }

  /** The ssh argv that forwards all three sockets into `dir`. */
  static forwardArgs(host: string, sshArgs: string[], dir: string): string[] {
    const local = SshTransport.localPaths(dir);
    const forwards = (Object.keys(SOCKETS) as DuckService[]).flatMap((s) => ["-L", `${local[s]}:${SOCKETS[s]}`]);
    return ["-N", ...sshArgs, ...forwards, host];
  }

  private start(): Promise<UnixTransport> {
    if (this.inner) return this.inner;
    this.inner = new Promise<UnixTransport>((resolve, reject) => {
      const dir = (this.dir = mkdtempSync(join(tmpdir(), "duck-ssh-")));
      const local = SshTransport.localPaths(dir);
      const proc = (this.proc = spawn("ssh", SshTransport.forwardArgs(this.host, this.sshArgs, dir), {
        stdio: ["ignore", "ignore", "pipe"],
      }));
      let stderr = "";
      proc.stderr?.on("data", (d) => (stderr += d));
      const deadline = Date.now() + this.readyTimeoutMs;
      const fail = (why: string) => {
        clearInterval(poll);
        reject(new Error(`ssh to ${this.host}: ${why}${stderr ? `\n${stderr.trim()}` : ""}`));
      };
      proc.on("error", (e) => fail(e.message));
      proc.on("exit", (code) => fail(`exited with code ${code} before the sockets came up`));
      const poll = setInterval(() => {
        if (Object.values(local).every(existsSync)) {
          clearInterval(poll);
          resolve(new UnixTransport(local));
        } else if (Date.now() > deadline) {
          proc.kill();
          fail(`sockets not forwarded within ${this.readyTimeoutMs}ms`);
        }
      }, 100);
    });
    return this.inner;
  }

  async call(service: DuckService, method: string, params?: Record<string, unknown>): Promise<unknown> {
    return (await this.start()).call(service, method, params);
  }

  async state(): Promise<RobotState> {
    return (await this.start()).state();
  }

  ping(): Promise<boolean> {
    return pingViaHealth(this);
  }

  // No snapshot: on hardware frames come from mediad's WebRTC stream (TODO).
  declare snapshot?: (req: SnapshotRequest) => Promise<Snapshot>;

  async close(): Promise<void> {
    this.proc?.kill();
    this.proc = undefined;
    this.inner = undefined;
    if (this.dir) rmSync(this.dir, { recursive: true, force: true });
    this.dir = undefined;
  }
}
