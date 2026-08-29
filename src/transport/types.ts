/**
 * Transport abstraction for reaching a Microduck.
 *
 * The robot speaks JSON-RPC 2.0, one object per line, over per-daemon Unix
 * sockets (/run/robotd.sock, /run/configd.sock, /run/updaterd.sock).
 * This MCP server may run:
 *   - on the robot itself  -> UnixTransport (direct socket)
 *   - on a laptop           -> SshTransport (socket forwarded over ssh)
 *   - with no robot at all  -> MockTransport (canned responses for dev)
 */

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

export interface DuckTransport {
  /** Send one JSON-RPC call to the daemon that owns the method's namespace. */
  call(
    service: DuckService,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown>;
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
