import http from "node:http";
import { MEDIA } from "./protocol.js";
import { Snapshot, SnapshotRequest } from "./types.js";

/**
 * The hardware camera: one upright PNG from mediad's console, `GET /frame`.
 *
 * On the robot the console is `127.0.0.1:8080`; over ssh it is forwarded to a
 * local Unix socket (`ssh -L <dir>/media.http.sock:127.0.0.1:8080`), which is
 * why this speaks node:http rather than fetch — fetch cannot dial a socket
 * path. Either way it is the same HTTP.
 */
export type MediaEndpoint = { host: string; port: number } | { socketPath: string };

/** Where the console is on the robot itself. `DUCK_MEDIA_PORT` overrides `--port`. */
export function localConsole(): MediaEndpoint {
  return { host: "127.0.0.1", port: Number(process.env.DUCK_MEDIA_PORT ?? MEDIA.consolePort) };
}

const PNG_MAGIC = "\x89PNG\r\n\x1a\n";

/** Width and height from a PNG's IHDR, which is always the first chunk. */
export function pngSize(png: Buffer): { width: number; height: number } {
  if (png.length < 24 || png.subarray(0, 8).toString("latin1") !== PNG_MAGIC) {
    throw new Error("mediad answered with something that is not a PNG");
  }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** GET one frame. Resolves the PNG bytes; rejects with mediad's own sentence on 503. */
export function fetchFrame(at: MediaEndpoint, timeoutMs = 5000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { ...at, path: MEDIA.framePath, method: "GET", timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          if (res.statusCode !== 200) {
            reject(new Error(`mediad ${MEDIA.framePath}: HTTP ${res.statusCode} ${body.toString().trim()}`));
          } else if (!/^image\/png/.test(String(res.headers["content-type"] ?? ""))) {
            reject(new Error(`mediad ${MEDIA.framePath}: expected image/png, got ${res.headers["content-type"]}`));
          } else {
            resolve(body);
          }
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error(`mediad ${MEDIA.framePath}: timed out after ${timeoutMs}ms`)));
    req.on("error", (e) => reject(new Error(`mediad ${MEDIA.framePath}: ${e.message}`)));
    req.end();
  });
}

/**
 * `DuckTransport.snapshot` for hardware. The robot has one camera, in its
 * head, at its native size: the sim's third-person views and requested
 * dimensions have no meaning here, and the result says so rather than
 * silently returning something else.
 */
export async function mediaSnapshot(at: MediaEndpoint, req: SnapshotRequest): Promise<Snapshot> {
  const png = await fetchFrame(at);
  const { width, height } = pngSize(png);
  const notes = ["head camera via mediad /frame, upright, native resolution"];
  if (req.view !== "head") notes.push(`view='${req.view}' is a sim-only third-person view; hardware has only the head camera`);
  if (req.width !== width || req.height !== height) notes.push(`requested ${req.width}x${req.height} not applied`);
  return { png_base64: png.toString("base64"), width, height, view: "head", note: notes.join("; ") };
}
