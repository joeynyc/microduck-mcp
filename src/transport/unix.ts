import net from "node:net";
import { DuckService, DuckTransport, JsonRpcResponse } from "./types.js";

const SOCKETS: Record<DuckService, string> = {
  robotd: "/run/robotd.sock",
  configd: "/run/configd.sock",
  updaterd: "/run/updaterd.sock",
};

/**
 * Direct Unix-socket transport — for running the MCP server on the robot
 * itself (or against sockets forwarded to the same paths).
 * Opens a connection per call; the protocol is one JSON object per line.
 */
export class UnixTransport implements DuckTransport {
  private nextId = 1;

  constructor(private socketPaths: Record<DuckService, string> = SOCKETS) {}

  call(
    service: DuckService,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    const id = this.nextId++;
    const payload =
      JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";

    return new Promise((resolve, reject) => {
      const sock = net.createConnection(this.socketPaths[service]);
      let buf = "";
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error(`${method}: timed out after 5s`));
      }, 5000);

      sock.on("connect", () => sock.write(payload));
      sock.on("data", (chunk) => {
        buf += chunk.toString();
        const nl = buf.indexOf("\n");
        if (nl === -1) return;
        clearTimeout(timer);
        sock.end();
        try {
          const res = JSON.parse(buf.slice(0, nl)) as JsonRpcResponse;
          if (res.error) {
            reject(new Error(`${method}: ${res.error.message}`));
          } else {
            resolve(res.result);
          }
        } catch (e) {
          reject(e);
        }
      });
      sock.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
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
    /* per-call connections; nothing held open */
  }
}
