/**
 * Transport abstraction for reaching a Microduck.
 *
 * The robot speaks JSON-RPC 2.0, one object per line, over per-daemon Unix
 * sockets (/run/robotd.sock, /run/configd.sock, /run/updaterd.sock).
 * This MCP server may run:
 *   - on the robot itself  -> UnixTransport (direct socket)
 *   - on a laptop           -> SshTransport (sockets forwarded over ssh)
 *   - against a simulator   -> SimTransport (CPU MuJoCo sidecar, same protocol)
 *   - with no robot at all  -> MockTransport (canned responses for dev)
 *
 * Method names are upstream's — see ./protocol.ts.
 */
import { M, RobotState } from "./protocol.js";

export type DuckService = "robotd" | "configd" | "updaterd";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Server → client, no id (robot.state frames, sim.ready, ...). */
export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export interface SnapshotRequest {
  view: "head" | "follow" | "front" | "side" | "top";
  width: number;
  height: number;
}

export interface Snapshot {
  png_base64: string;
  width: number;
  height: number;
  view: string;
  note?: string;
}

export interface DuckTransport {
  /** Send one JSON-RPC request to the daemon that owns the method's namespace. */
  call(
    service: DuckService,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown>;
  /**
   * One robot.state frame. Upstream publishes state only as a subscription
   * stream, so "one sample" is a transport concern: the socket transports
   * subscribe and take the first frame; the sidecar and mock answer directly.
   */
  state(): Promise<RobotState>;
  /**
   * A still frame, if this transport can produce one. Not a robotd RPC — on
   * hardware it will come from mediad's WebRTC stream, in sim from the
   * renderer — so it is a capability on the transport, not a method name.
   * Absent means "no camera on this transport".
   */
  snapshot?(req: SnapshotRequest): Promise<Snapshot>;
  /** True if the robot is reachable right now. */
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

/** Route a method namespace to the daemon that owns it (per architecture.md). */
export function serviceFor(method: string): DuckService {
  if (method.startsWith("robot.")) return "robotd";
  if (method.startsWith("update.")) return "updaterd";
  // net.*, pad.*, system.* live on configd
  return "configd";
}

/** The health probe every transport uses for `ping()`. */
export async function pingViaHealth(t: Pick<DuckTransport, "call">): Promise<boolean> {
  try {
    await t.call("robotd", M.robotHealth);
    return true;
  } catch {
    return false;
  }
}

/** One spelling for a JSON-RPC error, whichever transport carried it. */
export function rpcErrorMessage(e: NonNullable<JsonRpcResponse["error"]>): string {
  return `${e.message} (code ${e.code})`;
}
