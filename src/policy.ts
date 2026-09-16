import {
  M,
  OFFICIAL_HF_ORG,
  POLICY_NONE,
  POLICY_API_VERSION,
  POLICY_SLOTS,
  PoliciesResult,
  PolicyFetchResult,
  PolicyOrigin,
  PolicySearchHit,
  PolicySlot,
} from "./transport/protocol.js";
import { DuckTransport } from "./transport/types.js";

/**
 * The policy channel — which ONNX file fills a slot, who published it, and the
 * commands that change that. Upstream's `policy-channel-design.md`, as shipped
 * in daemon 0.13 (API_VERSION 18–20).
 *
 * Two tools mutate, and they are a pair on purpose: `load` is speculative, and
 * `reset` is the one-word undo that makes trying a stranger's gait a safe
 * thing for an agent to do. Deliberately NOT here: `policy.check` and
 * `policy.install`, which fetch-and-apply the newest official set. This server
 * already refuses to expose `update.apply` for the same reason — an agent that
 * can fetch-and-apply the newest anything onto hardware is a footgun, and "the
 * newest" is a decision a human makes.
 *
 * On the wire a load is two calls: `policy.fetch` on updaterd downloads a Hub
 * repo into the library and answers with the path it landed at (and the
 * manifest's claims, which the daemon read so we do not have to), then
 * `robot.loadPolicy {slot, path}` on robotd swaps it in and writes the config
 * key. A path already on the board skips the fetch.
 */

/** How a `source` string was written, before anything is fetched. */
export type ParsedSource =
  | { kind: "none"; origin: "local" }
  | { kind: "path"; origin: "local"; path: string }
  | { kind: "hf"; origin: PolicyOrigin; repo: string; org: string; name: string; rev?: string };

/** `org/name`, optionally `@rev`. Hub names allow letters, digits, `._-`. */
const HF_REPO = /^([A-Za-z0-9][\w.-]*)\/([\w.-]+)(?:@([\w./-]+))?$/;

/**
 * Classify what `load` was handed: the literal "none", a path on the board,
 * or a Hub repo. Anything else is refused here with a sentence, rather than
 * by the daemon with a parse error.
 *
 * ORIGIN (§2): the HF org decides. `pollen-robotics/*` is official and every
 * other Hub repo is community; a path is local. The daemon applies the same
 * rule and reports the origin in `policy.fetch` and `robot.policies`, so this
 * is only what we can say before asking it.
 */
export function parseSource(source: string): ParsedSource {
  const s = source.trim();
  if (s === POLICY_NONE) return { kind: "none", origin: "local" };
  if (s.startsWith("/")) return { kind: "path", origin: "local", path: s };
  if (s.startsWith("./") || s.startsWith("../") || s.startsWith("~") || s.endsWith(".onnx")) {
    throw new Error(
      `"${s}" looks like a path but is not absolute. robotd resolves nothing relative — its ` +
        `working directory is not yours — so give the full path on the board, e.g. /home/radxa/policies/x.onnx.`,
    );
  }
  const m = HF_REPO.exec(s);
  if (!m) {
    throw new Error(
      `"${s}" is not a policy source. Use a Hugging Face repo as 'org/name' (optionally ` +
        `'org/name@revision'), an absolute path to a .onnx on the board, or 'none' to switch a slot off.`,
    );
  }
  const [, org, name, rev] = m;
  return { kind: "hf", origin: org === OFFICIAL_HF_ORG ? "official" : "community", repo: `${org}/${name}`, org, name, rev };
}

/** The origin alone, for anywhere a policy is named (§2: it travels with it). */
export function originOf(source: string): PolicyOrigin {
  return parseSource(source).origin;
}

/**
 * `walk` is what every other slot falls back to, so it can never be empty
 * (§9.2). The daemon refuses this too; refusing here first means no wire
 * traffic and a sentence the agent can act on.
 */
export function assertSlotCanTakeSource(slot: PolicySlot, source: string): void {
  if (source.trim() === POLICY_NONE && slot === "walk") {
    throw new Error(
      `walk cannot be set to "none": every other slot falls back to the walking ` +
        `policy, so it is the one slot that must always be filled. Switch off ` +
        `stand/sitstand/ground_pick/kick_left/kick_right/roulade instead, or load ` +
        `a different walk.`,
    );
  }
}

// ---- Calling the daemon ----------------------------------------------------

/**
 * A daemon older than API_VERSION 18 answers METHOD_NOT_FOUND naming the
 * method — the designed skew behaviour rather than a handshake refusal — so
 * translate it into the sentence that actually tells the caller what to do.
 */
function daemonTooOld(method: string, e: unknown): Error {
  const msg = (e as Error)?.message ?? String(e);
  if (/-32601|method not found|unknown method/i.test(msg) && msg.includes(method.split(".")[1])) {
    return new Error(
      `Your robot daemon is too old for the policy channel: it does not know ` +
        `${method}. The policy channel needs API_VERSION ${POLICY_API_VERSION} (daemon 0.13 ` +
        `or newer). Update the daemon, then retry. (underlying: ${msg})`,
    );
  }
  return e instanceof Error ? e : new Error(msg);
}

async function callPolicyMethod(t: DuckTransport, method: string, params?: Record<string, unknown>): Promise<unknown> {
  try {
    return await t.call(method, params);
  } catch (e) {
    throw daemonTooOld(method, e);
  }
}

/**
 * robot.loadPolicy answers like an intent: `{accepted, reason?}`. A refusal is
 * a normal answer on the wire, but to the agent it is a failure with a reason,
 * so it is raised.
 */
async function loadPolicyOnWire(t: DuckTransport, params: { slot?: string; path?: string }): Promise<unknown> {
  const r = (await callPolicyMethod(t, M.robotLoadPolicy, params)) as { accepted?: boolean; reason?: string } | null;
  if (r && r.accepted === false) {
    throw new Error(`robot.loadPolicy refused: ${r.reason ?? "no reason given"}`);
  }
  return r;
}

/** What each slot runs, with origin, plus the skills this robot has. Read-only. */
export async function listPolicies(t: DuckTransport): Promise<PoliciesResult> {
  return (await callPolicyMethod(t, M.robotPolicies)) as PoliciesResult;
}

/** Hub models matching a query (`policy.search`). Read-only; everything in a hit is the publisher's. */
export async function searchPolicies(t: DuckTransport, query: string): Promise<PolicySearchHit[]> {
  const r = (await callPolicyMethod(t, M.policySearch, { query })) as { models?: PolicySearchHit[] } | null;
  return r?.models ?? [];
}

export interface LoadOutcome {
  slot: PolicySlot;
  source: string;
  origin: PolicyOrigin | string;
  /** The path now in the slot (what `policy.fetch` returned, or the path given). */
  path: string;
  /** Present when a Hub repo was fetched: the daemon's reading of its manifest. */
  fetched?: PolicyFetchResult;
  result: unknown;
}

/**
 * Put `source` in `slot`: a Hub repo (`org/name[@rev]`), an absolute path on
 * the board, or the literal "none". A load is a config edit plus a live reload
 * (§3), so it survives a reboot — which is exactly why `duck_policy_reset`
 * exists and why the two ship together.
 */
export async function loadPolicy(t: DuckTransport, slot: PolicySlot, source: string): Promise<LoadOutcome> {
  const src = source.trim();
  assertSlotCanTakeSource(slot, src);
  const parsed = parseSource(src);
  if (parsed.kind === "hf") {
    // Fetch first. The daemon downloads into its library, reads the manifest
    // and reports origin and the publisher's claims; a repo with two .onnx
    // files or a wrong shape is refused here, before anything runs.
    const fetched = (await callPolicyMethod(t, M.policyFetch, {
      repo: parsed.repo,
      ...(parsed.rev ? { revision: parsed.rev } : {}),
    })) as PolicyFetchResult;
    if (!fetched?.path) throw new Error(`policy.fetch for ${parsed.repo} answered without a path`);
    const result = await loadPolicyOnWire(t, { slot, path: fetched.path });
    return { slot, source: src, origin: fetched.origin ?? parsed.origin, path: fetched.path, fetched, result };
  }
  const path = parsed.kind === "none" ? POLICY_NONE : parsed.path;
  const result = await loadPolicyOnWire(t, { slot, path });
  return { slot, source: src, origin: parsed.origin, path, result };
}

/**
 * Reset removes the config key so the slot resolves to its default again
 * (§3): the same method with no path. No slot = one call with neither field,
 * "put it all back".
 */
export async function resetPolicy(t: DuckTransport, slot?: PolicySlot): Promise<{ reset: PolicySlot[]; result: unknown }> {
  const result = await loadPolicyOnWire(t, slot ? { slot } : {});
  return { reset: slot ? [slot] : [...POLICY_SLOTS], result };
}
