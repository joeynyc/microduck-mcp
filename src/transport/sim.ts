import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DuckService, DuckTransport } from "./types.js";

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
  env?: NodeJS.ProcessEnv;
  /** ms to wait for the sidecar's `sim.ready` notification. */
  readyTimeoutMs?: number;
  /** Default per-call timeout, ms. */
  callTimeoutMs?: number;
}

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

export class SimTransport implements DuckTransport {
  private proc?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private exited?: Error;
  readonly opts: Required<Pick<SimTransportOptions, "python" | "script" | "args" | "readyTimeoutMs" | "callTimeoutMs">> &
    SimTransportOptions;

  constructor(opts: SimTransportOptions = {}) {
    this.opts = {
      python: opts.python ?? process.env.DUCK_SIM_PYTHON ?? join(repoRoot, "sim", ".venv", "bin", "python"),
      script: opts.script ?? process.env.DUCK_SIM_SCRIPT ?? join(repoRoot, "sim", "duck_sim.py"),
      args: opts.args ?? (process.env.DUCK_SIM_ARGS?.split(/\s+/).filter(Boolean) ?? []),
      readyTimeoutMs: opts.readyTimeoutMs ?? 60_000,
      callTimeoutMs: opts.callTimeoutMs ?? 10_000,
      env: opts.env,
    };
  }

  /** Spawn the sidecar (once) and wait for `sim.ready`. */
  start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      if (!existsSync(this.opts.script)) {
        reject(new Error(`sim sidecar not found at ${this.opts.script}`));
        return;
      }
      if (!existsSync(this.opts.python)) {
        reject(
          new Error(
            `sim python not found at ${this.opts.python} — run sim/setup.sh ` +
              `(or set DUCK_SIM_PYTHON)`,
          ),
        );
        return;
      }
      const proc = spawn(this.opts.python, [this.opts.script, ...this.opts.args], {
        env: { MUJOCO_GL: "egl", ...process.env, ...this.opts.env },
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.proc = proc;
      const timer = setTimeout(
        () => reject(new Error(`sim sidecar did not report ready within ${this.opts.readyTimeoutMs}ms`)),
        this.opts.readyTimeoutMs,
      );

      createInterface({ input: proc.stdout }).on("line", (line) => {
        let msg: {
          id?: number | null;
          method?: string;
          params?: Record<string, unknown>;
          result?: unknown;
          error?: { code: number; message: string };
        };
        try {
          msg = JSON.parse(line);
        } catch {
          console.error(`[sim] unparseable line: ${line}`);
          return;
        }
        if (msg.method === "sim.ready") {
          clearTimeout(timer);
          console.error(`[sim] ready: ${JSON.stringify(msg.params)}`);
          resolve();
          return;
        }
        if (msg.method === "sim.error") {
          clearTimeout(timer);
          reject(new Error(String(msg.params?.message ?? "sim error")));
          return;
        }
        if (typeof msg.id !== "number") return;
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(`${msg.error.message} (code ${msg.error.code})`));
        else p.resolve(msg.result);
      });
      createInterface({ input: proc.stderr }).on("line", (l) => console.error(`[sim] ${l}`));
      proc.on("error", (e) => {
        clearTimeout(timer);
        this.exited = e;
        reject(e);
        this.failAll(e);
      });
      proc.on("exit", (code, signal) => {
        const e = new Error(`sim sidecar exited (code ${code}, signal ${signal})`);
        this.exited = e;
        clearTimeout(timer);
        reject(e);
        this.failAll(e);
      });
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

  async call(
    _service: DuckService,
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = method === "sim.camera" ? 30_000 : this.opts.callTimeoutMs,
  ): Promise<unknown> {
    await this.start();
    if (this.exited) throw this.exited;
    const id = this.nextId++;
    const req = { jsonrpc: "2.0", id, method, params: params ?? {} };
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

  async ping(): Promise<boolean> {
    try {
      await this.call("robotd", "robot.health");
      return true;
    } catch {
      return false;
    }
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
