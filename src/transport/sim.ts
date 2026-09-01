import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { M, POLICY_SLOTS, RobotState } from "./protocol.js";
import {
  DuckService,
  DuckTransport,
  JsonRpcRequest,
  JsonRpcResponse,
  Snapshot,
  SnapshotRequest,
  pingViaHealth,
  rpcErrorMessage,
} from "./types.js";

/**
 * Sim transport — a headless CPU-MuJoCo Microduck running the official
 * pretrained ONNX policies, in a Python sidecar (`sim/duck_sim.py`).
 *
 * The sidecar speaks robotd's wire protocol (JSON-RPC 2.0, one object per
 * line) over stdio, so this class is the same shape as UnixTransport with a
 * child process where the socket would be. Nothing above the transport knows
 * whether it is talking to a simulation or to a robot — that is the contract.
 *
 * Env:
 *   DUCK_SIM_PYTHON   interpreter (default: <repo>/sim/.venv/bin/python)
 *   DUCK_SIM_SCRIPT   sidecar path (default: <repo>/sim/duck_sim.py)
 *   DUCK_SIM_ARGS     extra args, space-separated (e.g. "--no-realtime")
 *   DUCK_SIM_BATTERY_V, DUCK_SIM_DEADMAN_S, MUJOCO_GL — passed through.
 */
export interface SimTransportOptions {
  python?: string;
  script?: string;
  args?: string[];
  /** ms to wait for the sidecar's `sim.ready` notification. */
  readyTimeoutMs?: number;
  /** Per-call timeout, ms. Snapshots get their own, longer one. */
  callTimeoutMs?: number;
}

/** A notification from the sidecar (no id) or a response (with id). */
type SidecarMessage = JsonRpcResponse | { method: string; params?: Record<string, unknown> };

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SNAPSHOT_TIMEOUT_MS = 30_000;

export class SimTransport implements DuckTransport {
  private readonly python: string;
  private readonly script: string;
  private readonly args: string[];
  private readonly readyTimeoutMs: number;
  private readonly callTimeoutMs: number;

  private proc?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private exited?: Error;

  constructor(opts: SimTransportOptions = {}) {
    this.python = opts.python ?? process.env.DUCK_SIM_PYTHON ?? join(repoRoot, "sim", ".venv", "bin", "python");
    this.script = opts.script ?? process.env.DUCK_SIM_SCRIPT ?? join(repoRoot, "sim", "duck_sim.py");
    this.args = opts.args ?? (process.env.DUCK_SIM_ARGS?.split(/\s+/).filter(Boolean) ?? []);
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 60_000;
    this.callTimeoutMs = opts.callTimeoutMs ?? 10_000;
  }

  /** Spawn the sidecar (once) and wait for `sim.ready`. */
  start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      if (!existsSync(this.script)) {
        reject(new Error(`sim sidecar not found at ${this.script}`));
        return;
      }
      if (!existsSync(this.python)) {
        reject(new Error(`sim python not found at ${this.python} — run sim/setup.sh (or set DUCK_SIM_PYTHON)`));
        return;
      }
      const proc = spawn(this.python, [this.script, ...this.args], {
        env: { MUJOCO_GL: "egl", ...process.env },
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.proc = proc;
      const timer = setTimeout(
        () => reject(new Error(`sim sidecar did not report ready within ${this.readyTimeoutMs}ms`)),
        this.readyTimeoutMs,
      );
      const fail = (e: Error) => {
        clearTimeout(timer);
        this.exited = e;
        reject(e);
        this.failAll(e);
      };

      createInterface({ input: proc.stdout }).on("line", (line) => {
        let msg: SidecarMessage;
        try {
          msg = JSON.parse(line);
        } catch {
          console.error(`[sim] unparseable line: ${line}`);
          return;
        }
        if ("method" in msg) {
          if (msg.method === "sim.ready") {
            clearTimeout(timer);
            console.error(`[sim] ready: ${JSON.stringify(msg.params)}`);
            resolve();
          } else if (msg.method === "sim.error") {
            clearTimeout(timer);
            reject(new Error(String(msg.params?.message ?? "sim error")));
          }
          return;
        }
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(rpcErrorMessage(msg.error)));
        else p.resolve(msg.result);
      });
      createInterface({ input: proc.stderr }).on("line", (l) => console.error(`[sim] ${l}`));
      proc.on("error", fail);
      proc.on("exit", (code, signal) => fail(new Error(`sim sidecar exited (code ${code}, signal ${signal})`)));
    });
    return this.ready;
  }

  private failAll(e: Error) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(e);
      this.pending.delete(id);
    }
  }

  private async send(method: string, params: Record<string, unknown> | undefined, timeoutMs: number): Promise<unknown> {
    await this.start();
    if (this.exited) throw this.exited;
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params: params ?? {} };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`sim call ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc!.stdin.write(JSON.stringify(req) + "\n", (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  call(_service: DuckService, method: string, params?: Record<string, unknown>): Promise<unknown> {
    // The policy channel has no meaning here and saying so is the honest
    // answer. The sidecar loads one fixed ONNX per role out of a vendored
    // directory (`sim/duck_sim.py`); there is no robotd.toml to edit, no
    // library to fetch into, and no origin to report. Answering with a
    // plausible-looking slot table would be a lie about what is running, which
    // is precisely the confusion `robot.policies` exists to end — so refuse.
    if (method === M.robotPolicies || method === M.robotLoadPolicy) {
      return Promise.reject(
        new Error(
          `${method} is not supported on the sim transport: the sidecar runs a ` +
            `fixed set of vendored policies (${POLICY_SLOTS.length} roles, no config ` +
            `file and no policy library), so it has no slots to report or override. ` +
            `Use DUCK_TRANSPORT=mock to exercise the policy tools, or unix/ssh ` +
            `against a real daemon.`,
        ),
      );
    }
    return this.send(method, params, this.callTimeoutMs);
  }

  /** The sidecar answers robot.state one-shot (no subscription needed). */
  state(): Promise<RobotState> {
    return this.send(M.robotState, {}, this.callTimeoutMs) as Promise<RobotState>;
  }

  snapshot(req: SnapshotRequest): Promise<Snapshot> {
    return this.send("sim.camera", { ...req }, SNAPSHOT_TIMEOUT_MS) as Promise<Snapshot>;
  }

  ping(): Promise<boolean> {
    return pingViaHealth(this);
  }

  async close(): Promise<void> {
    const p = this.proc;
    if (!p) return;
    this.proc = undefined;
    this.ready = undefined;
    this.failAll(new Error("sim transport closed"));
    p.stdin.end();
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        p.kill("SIGKILL");
        resolve();
      }, 2000);
      p.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}
