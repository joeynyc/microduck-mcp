import {
  M,
  OFFICIAL_HF_ORG,
  POLICY_ACTION_LEN,
  POLICY_MODEL_API,
  POLICY_NONE,
  POLICY_OBS_LEN,
  POLICY_SLOTS,
  PolicyEntry,
  PolicyManifest,
  PolicyOrigin,
  PolicySlot,
} from "./transport/protocol.js";
import { DuckTransport } from "./transport/types.js";

/**
 * The policy channel — which ONNX file fills a slot, who published it, and the
 * two commands that change that. Upstream's `policy-channel-design.md`.
 *
 * Two tools mutate, and they are a pair on purpose: `load` is speculative, and
 * `reset` is the one-word undo that makes trying a stranger's gait a safe
 * thing for an agent to do. Deliberately NOT here: `policy update` and
 * `policy check` (§7). This server already refuses to expose `update.apply`
 * for the same reason — an agent that can fetch-and-apply the newest anything
 * onto hardware is a footgun, and "the newest" is a decision a human makes.
 * load + reset carries the whole trial loop without ever auto-applying.
 */

/** How a `source` string was written, before anything is fetched. */
export type SourceKind = "none" | "hf" | "library" | "path";

export interface ParsedSource {
  kind: SourceKind;
  origin: PolicyOrigin;
  /** HF only: the org/name and the revision it will resolve at. */
  repo?: string;
  org?: string;
  name?: string;
  rev?: string;
}

/** A path on the board: absolute, relative, `~`-rooted, or a bare .onnx file. */
function looksLikePath(s: string): boolean {
  return s.startsWith("/") || s.startsWith("./") || s.startsWith("../") || s.startsWith("~") || s.endsWith(".onnx");
}

/** `org/name`, optionally `@rev`. Hub names allow letters, digits, `._-`. */
const HF_REPO = /^([A-Za-z0-9][\w.-]*)\/([\w.-]+)(?:@([\w./-]+))?$/;

/**
 * Classify what `load` was handed. `load` takes an HF repo (`org/name[@rev]`),
 * a name already in the library, or a path on the board (§7) — three inputs
 * with three different provenances, so the shape of the string is what decides
 * the origin we report.
 *
 * ORIGIN (§2): the HF org decides. `pollen-robotics/*` is official, every
 * other Hub repo is community, a filesystem path is local. A bare library
 * name is `unknown` here and only here — the library entry knows the org it
 * was fetched from, so `robot.policies` answers it authoritatively and we do
 * not guess on its behalf.
 */
export function parseSource(source: string): ParsedSource {
  const s = source.trim();
  if (s === POLICY_NONE) return { kind: "none", origin: "local" };
  if (looksLikePath(s)) return { kind: "path", origin: "local" };
  const m = HF_REPO.exec(s);
  if (m) {
    const [, org, name, rev] = m;
    return {
      kind: "hf",
      origin: org === OFFICIAL_HF_ORG ? "official" : "community",
      repo: `${org}/${name}`,
      org,
      name,
      rev: rev ?? "main",
    };
  }
  return { kind: "library", origin: "unknown" };
}

/** The origin alone, for anywhere a policy is named (§2: it travels with it). */
export function originOf(source: string): PolicyOrigin {
  return parseSource(source).origin;
}

/**
 * `walk` is what every other slot falls back to, so it can never be empty
 * (§9.2). Refused here rather than at the daemon so the agent gets a sentence
 * it can act on instead of a config error.
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

// ---- The manifest pre-check (§9.2) ----------------------------------------

/** Fetches a repo's manifest.json, or resolves undefined if there isn't one. */
export type ManifestFetcher = (repo: string, rev: string) => Promise<PolicyManifest | undefined>;

export interface ManifestVerdict {
  /** Only ever false when the manifest positively contradicts the contract. */
  ok: boolean;
  reason?: string;
  manifest?: PolicyManifest;
  /** True when there was nothing to read — accepted, and said so. */
  absent: boolean;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * Read a repo's manifest against the daemon's contract, so "its manifest says
 * observation width 51, and this robot builds 61" arrives before 800 KB is
 * downloaded and before the robot is asked to run it.
 *
 * Three rules keep this from becoming a trap, and both halves matter:
 *
 * - The manifest is UNTRUSTED. It is a stranger's description of a stranger's
 *   file, so it is only ever a reason to REFUSE and never a reason to trust.
 *   Nothing downstream may treat a passing manifest as a blessing; robotd's
 *   obs[1,61] → actions[1,14] shape gate is where the real check has always
 *   been, and a manifest that lies is caught there.
 * - ABSENCE IS NOT EVIDENCE. A repo with no manifest, one that is unreachable,
 *   unparseable, or simply omits the fields we act on, is ACCEPTED. Most of
 *   the Hub follows no convention of ours and failing closed on silence would
 *   reject the majority of it.
 * - The numbers come from protocol.ts, which mirrors upstream's published
 *   `duck_ipc_proto` constants rather than duplicating them by hand.
 */
export async function checkManifest(
  parsed: ParsedSource,
  fetcher: ManifestFetcher = fetchHubManifest,
): Promise<ManifestVerdict> {
  // Only an HF repo has a manifest to read. A path on the board and a library
  // entry are both already-local bytes; the shape gate is their only check.
  if (parsed.kind !== "hf" || !parsed.repo) return { ok: true, absent: true };

  let manifest: PolicyManifest | undefined;
  try {
    manifest = await fetcher(parsed.repo, parsed.rev ?? "main");
  } catch {
    // A network failure is not a claim about the policy. Accept and let the
    // fetch itself fail loudly if the repo really is unreachable.
    return { ok: true, absent: true };
  }
  if (!manifest || typeof manifest !== "object") return { ok: true, absent: true };

  const obs = num(manifest.obs_len);
  if (obs !== undefined && obs !== POLICY_OBS_LEN) {
    return {
      ok: false,
      absent: false,
      manifest,
      reason:
        `${parsed.repo} says observation width ${obs}, and this robot builds ` +
        `${POLICY_OBS_LEN}. That is the 51-D legacy family; robotd would refuse it at load.`,
    };
  }
  const act = num(manifest.action_len);
  if (act !== undefined && act !== POLICY_ACTION_LEN) {
    return {
      ok: false,
      absent: false,
      manifest,
      reason: `${parsed.repo} says action width ${act}, and this robot drives ${POLICY_ACTION_LEN} joints.`,
    };
  }
  const api = num(manifest.model_api);
  if (api !== undefined && api > POLICY_MODEL_API) {
    return {
      ok: false,
      absent: false,
      manifest,
      reason:
        `${parsed.repo} needs model_api ${api}; this daemon implements ` +
        `${POLICY_MODEL_API}. Update the daemon before loading it.`,
    };
  }
  // Nothing contradicted the contract. That is NOT a blessing — see above.
  const absent = obs === undefined && act === undefined && api === undefined;
  return { ok: true, absent, manifest };
}

/**
 * The Hub's raw-file endpoint. A missing manifest is a 404, which is a normal
 * answer here and not an error — hence `undefined` rather than a throw.
 */
export async function fetchHubManifest(repo: string, rev: string): Promise<PolicyManifest | undefined> {
  const url = `https://huggingface.co/${repo}/resolve/${encodeURIComponent(rev)}/manifest.json`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: "follow" });
    if (!res.ok) return undefined;
    return (await res.json()) as PolicyManifest;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

// ---- Calling the daemon ----------------------------------------------------

/**
 * `robot.policies` and `robot.loadPolicy` arrived with upstream's API_VERSION
 * 17 (it went 16 → 17 for exactly these two, `policy-channel-design.md` §8). A
 * daemon still on v16 answers METHOD_NOT_FOUND naming the method — the
 * designed skew behaviour rather than a handshake refusal — so translate it
 * into the sentence that actually tells the caller what to do.
 */
function daemonTooOld(method: string, e: unknown): Error {
  const msg = (e as Error)?.message ?? String(e);
  if (/-32601|method not found|unknown method/i.test(msg) && msg.includes(method.split(".")[1])) {
    return new Error(
      `Your robot daemon is too old for the policy channel: it does not know ` +
        `${method}. The policy channel needs API_VERSION 17 (upstream went 16 → 17 ` +
        `for robot.policies and robot.loadPolicy). Update the daemon, then retry. ` +
        `(underlying: ${msg})`,
    );
  }
  return e instanceof Error ? e : new Error(msg);
}

async function callPolicyMethod(
  t: DuckTransport,
  method: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  try {
    return await t.call(method, params);
  } catch (e) {
    throw daemonTooOld(method, e);
  }
}

/**
 * What each slot is running, with origin and version. Read-only. Origin comes
 * from the daemon where it can (the path a policy lives at is made of the org
 * that published it, §9.2); where a daemon predates that field we fill it in
 * from the source string by the same rule, so an origin is never simply blank.
 */
export async function listPolicies(t: DuckTransport): Promise<PolicyEntry[]> {
  const raw = await callPolicyMethod(t, M.robotPolicies);
  const rows: PolicyEntry[] = Array.isArray(raw)
    ? (raw as PolicyEntry[])
    : Array.isArray((raw as { slots?: unknown })?.slots)
      ? ((raw as { slots: PolicyEntry[] }).slots)
      : [];
  return rows.map((r) => ({
    ...r,
    origin: r.origin ?? (typeof r.source === "string" ? originOf(r.source) : "unknown"),
  }));
}

export interface LoadOutcome {
  slot: PolicySlot;
  source: string;
  origin: PolicyOrigin;
  manifest_checked: boolean;
  note?: string;
  result: unknown;
}

/**
 * Put `source` in `slot`: an HF repo, a name in the library, a path on the
 * board, or the literal "none". A load is a config edit plus a live reload
 * (§3), so it survives a reboot — which is exactly why `duck_policy_reset`
 * exists and why the two ship together.
 */
export async function loadPolicy(
  t: DuckTransport,
  slot: PolicySlot,
  source: string,
  fetcher: ManifestFetcher = fetchHubManifest,
): Promise<LoadOutcome> {
  const src = source.trim();
  assertSlotCanTakeSource(slot, src);
  const parsed = parseSource(src);
  const verdict = await checkManifest(parsed, fetcher);
  if (!verdict.ok) {
    throw new Error(
      `Refused before downloading: ${verdict.reason} (Read from the repo's ` +
        `manifest.json, which is the publisher's own claim — this check can only ` +
        `refuse, never approve.)`,
    );
  }
  const result = await callPolicyMethod(t, M.robotLoadPolicy, { slot, source: src });
  return {
    slot,
    source: src,
    origin: parsed.origin,
    manifest_checked: parsed.kind === "hf" && !verdict.absent,
    note:
      parsed.kind === "hf" && verdict.absent
        ? "no manifest to read (or it omits obs_len/action_len/model_api) — accepted, " +
          "because absence is not evidence; robotd's shape gate is the real check"
        : undefined,
    result,
  };
}

/**
 * Reset removes the config key so the slot resolves to its official default
 * again (§3). No slot resets all seven: "put it back the way it came".
 *
 * INFERRED, NOT SPECIFIED: §8 names `robot.loadPolicy` (slot + source) but
 * does not say how a *removal* is spelled on the wire, and the daemon that
 * would settle it is not released. `source: null` is our reading of "nothing
 * overrides this slot". Verify it the day API_VERSION 17 ships; if upstream
 * spells it differently this is the one line to change.
 */
export async function resetPolicy(
  t: DuckTransport,
  slot?: PolicySlot,
): Promise<{ reset: PolicySlot[]; results: Record<string, unknown> }> {
  const slots = slot ? [slot] : [...POLICY_SLOTS];
  const results: Record<string, unknown> = {};
  for (const s of slots) {
    results[s] = await callPolicyMethod(t, M.robotLoadPolicy, { slot: s, source: null });
  }
  return { reset: slots, results };
}
