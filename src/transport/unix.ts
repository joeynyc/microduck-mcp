import net from "node:net";
import { createInterface } from "node:readline";
import { M, RobotState } from "./protocol.js";
import {
  DuckService,
  DuckTransport,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  pingViaHealth,
  rpcErrorMessage,
  serviceFor,
} from "./types.js";

export const SOCKETS: Record<DuckService, string> = {
  robotd: "/run/robotd.sock",
  configd: "/run/configd.sock",
  updaterd: "/run/updaterd.sock",
};

type Inbound = JsonRpcResponse | JsonRpcNotification;

/**
 * Direct Unix-socket transport — for running the MCP server on the robot
 * itself, or against sockets forwarded to other paths (see SshTransport).
 * Opens a connection per call; the protocol is one JSON object per line.
 */
export class UnixTransport implements DuckTransport {
  private nextId = 1;

  constructor(
    private socketPaths: Record<DuckService, string> = SOCKETS,
    private timeoutMs = 5000,
  ) {}

  call(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    return this.exchange(serviceFor(method), { jsonrpc: "2.0", id, method, params }, (msg) => {
      if (!("id" in msg) || msg.id !== id) return undefined;
      if (msg.error) throw new Error(`${method}: ${rpcErrorMessage(msg.error)}`);
      return { value: msg.result };
    });
  }

  /** Subscribe, take the first robot.state frame, hang up. */
  state(): Promise<RobotState> {
    const id = this.nextId++;
    return this.exchange(
      "robotd",
      { jsonrpc: "2.0", id, method: M.robotSubscribe, params: { hz: 50 } },
      (msg) => {
        if ("id" in msg && msg.id === id && msg.error) {
          throw new Error(`${M.robotSubscribe}: ${rpcErrorMessage(msg.error)}`);
        }
        if ("method" in msg && msg.method === M.robotState) return { value: msg.params as RobotState };
        return undefined; // the subscribe ack, or a frame we don't model
      },
    );
  }

  /**
   * Connect, send one request, read lines until `pick` returns a value (or
   * throws), then close. `pick` sees every inbound message on the connection.
   */
  private exchange<T>(
    service: DuckService,
    req: JsonRpcRequest,
    pick: (msg: Inbound) => { value: T } | undefined,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const sock = net.createConnection(this.socketPaths[service]);
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sock.destroy();
        fn();
      };
      const timer = setTimeout(
        () => done(() => reject(new Error(`${req.method}: timed out after ${this.timeoutMs}ms`))),
        this.timeoutMs,
      );
      sock.on("connect", () => sock.write(JSON.stringify(req) + "\n"));
      createInterface({ input: sock })
        .on("line", (line) => {
          try {
            const picked = pick(JSON.parse(line) as Inbound);
            if (picked) done(() => resolve(picked.value));
          } catch (e) {
            done(() => reject(e));
          }
        })
        // readline re-emits the socket's errors; the socket handler below owns them.
        .on("error", () => {});
      sock.on("error", (e) => done(() => reject(e)));
      sock.on("close", () => done(() => reject(new Error(`${req.method}: connection closed without an answer`))));
    });
  }

  ping(): Promise<boolean> {
    return pingViaHealth(this);
  }

  async close(): Promise<void> {
    /* per-call connections; nothing held open */
  }
}
