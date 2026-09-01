import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  ManifestFetcher,
  checkManifest,
  listPolicies,
  loadPolicy,
  originOf,
  parseSource,
  resetPolicy,
} from "../policy.js";
import { POLICY_SLOTS } from "../transport/protocol.js";
import { MockTransport } from "../transport/mock.js";
import { SimTransport } from "../transport/sim.js";
import { DuckTransport } from "../transport/types.js";

/** Transport stub: records every policy call, answers whatever it is given. */
function stub(answers: Record<string, unknown> = {}): DuckTransport & {
  calls: { method: string; params?: Record<string, unknown> }[];
} {
  return {
    calls: [],
    async state() {
      return { policy: "stand" } as any;
    },
    async call(method: string, params?: Record<string, unknown>) {
      this.calls.push({ method, params });
      if (method in answers) {
        const a = answers[method];
        if (a instanceof Error) throw a;
        return a;
      }
      return { accepted: true };
    },
    async ping() {
      return true;
    },
    async close() {},
  };
}

/** A fetcher that hands back one manifest, or none at all. */
const manifests = (m?: Record<string, unknown>): ManifestFetcher => async () => m as any;

describe("the origin rule", () => {
  test("pollen-robotics is official — and only that org", () => {
    assert.equal(originOf("pollen-robotics/microduck-walk"), "official");
    assert.equal(originOf("pollen-robotics/microduck-walk@v1.2.0"), "official");
    // The near-misses that a configurable trust org would have let through.
    assert.equal(originOf("pollen-robotics-inc/microduck-walk"), "community");
    assert.equal(originOf("Pollen-Robotics/microduck-walk"), "community");
    assert.equal(originOf("evil/pollen-robotics"), "community");
  });

  test("every other HF repo is community", () => {
    assert.equal(originOf("RemiFabre/microduck-flamingo-cycle"), "community");
    assert.equal(originOf("apirrone/microduck_runtime@5f3b314"), "community");
  });

  test("a path on the board is local", () => {
    assert.equal(originOf("/home/radxa/policies/flamingo/policy.onnx"), "local");
    assert.equal(originOf("~/policies/try.onnx"), "local");
    assert.equal(originOf("./out/policy.onnx"), "local");
    assert.equal(originOf("policy.onnx"), "local");
  });

  test("a bare library name claims nothing — the daemon knows, we do not", () => {
    assert.equal(originOf("flamingo-cycle"), "unknown");
    assert.equal(parseSource("flamingo-cycle").kind, "library");
  });

  test("the revision travels with the repo, defaulting to main", () => {
    assert.deepEqual(
      { ...parseSource("RemiFabre/microduck-flamingo-cycle@bouncy-2") },
      {
        kind: "hf",
        origin: "community",
        repo: "RemiFabre/microduck-flamingo-cycle",
        org: "RemiFabre",
        name: "microduck-flamingo-cycle",
        rev: "bouncy-2",
      },
    );
    assert.equal(parseSource("RemiFabre/microduck-flamingo-cycle").rev, "main");
  });
});

describe("walk can never be switched off", () => {
  test("walk = none is refused with a reason, before any wire traffic", async () => {
    const t = stub();
    await assert.rejects(
      () => loadPolicy(t, "walk", "none", manifests()),
      /walk cannot be set to "none"/,
    );
    assert.deepEqual(t.calls, [], "nothing reached the daemon");
  });

  test("every other slot may be switched off", async () => {
    for (const slot of POLICY_SLOTS.filter((s) => s !== "walk")) {
      const t = stub();
      const r = await loadPolicy(t, slot, "none", manifests());
      assert.equal(r.source, "none");
      assert.deepEqual(t.calls[0].params, { slot, source: "none" });
    }
  });
});

describe("the manifest pre-check", () => {
  const repo = parseSource("RemiFabre/microduck-flamingo-cycle");

  test("refuses a 51-D policy by naming both widths", async () => {
    const v = await checkManifest(repo, manifests({ obs_len: 51, action_len: 14, model_api: 1 }));
    assert.equal(v.ok, false);
    assert.match(v.reason!, /observation width 51.*builds 61/);
  });

  test("refuses a wrong action width", async () => {
    const v = await checkManifest(repo, manifests({ obs_len: 61, action_len: 12 }));
    assert.equal(v.ok, false);
    assert.match(v.reason!, /action width 12/);
  });

  test("refuses a policy that needs a newer daemon", async () => {
    const v = await checkManifest(repo, manifests({ obs_len: 61, action_len: 14, model_api: 2 }));
    assert.equal(v.ok, false);
    assert.match(v.reason!, /model_api 2/);
  });

  test("an older model_api is not a refusal — only a newer one is", async () => {
    assert.equal((await checkManifest(repo, manifests({ model_api: 0 }))).ok, true);
  });

  test("a matching manifest passes, and is never treated as a blessing", async () => {
    const v = await checkManifest(repo, manifests({ obs_len: 61, action_len: 14, model_api: 1 }));
    assert.equal(v.ok, true);
    assert.equal(v.absent, false);
  });

  // ABSENCE IS NOT EVIDENCE (§9.2). Most of the Hub publishes no manifest of
  // ours, so every one of these must LOAD, not refuse.
  test("a repo with no manifest still loads", async () => {
    const v = await checkManifest(repo, manifests(undefined));
    assert.equal(v.ok, true);
    assert.equal(v.absent, true);
  });

  test("a manifest omitting the fields we act on still loads", async () => {
    const v = await checkManifest(repo, manifests({ name: "flamingo-cycle", kind: "perpetual" }));
    assert.equal(v.ok, true);
    assert.equal(v.absent, true);
  });

  test("fields of the wrong type read as absent, not as a contradiction", async () => {
    const v = await checkManifest(repo, manifests({ obs_len: "61", action_len: null }));
    assert.equal(v.ok, true);
  });

  test("an unreachable Hub still loads — a network fault is not a claim", async () => {
    const v = await checkManifest(repo, async () => {
      throw new Error("getaddrinfo ENOTFOUND huggingface.co");
    });
    assert.equal(v.ok, true);
    assert.equal(v.absent, true);
  });

  test("a path and a library name have no manifest to read and are accepted", async () => {
    for (const s of ["/home/radxa/policies/x.onnx", "flamingo-cycle"]) {
      assert.equal((await checkManifest(parseSource(s), manifests({ obs_len: 51 }))).ok, true);
    }
  });
});

describe("loadPolicy", () => {
  test("a bad manifest stops the load before the daemon is called", async () => {
    const t = stub();
    await assert.rejects(
      () => loadPolicy(t, "walk", "RemiFabre/legacy-51d", manifests({ obs_len: 51 })),
      /Refused before downloading.*observation width 51/s,
    );
    assert.deepEqual(t.calls, []);
  });

  test("a missing manifest loads, reports community, and says why it was accepted", async () => {
    const t = stub();
    const r = await loadPolicy(t, "walk", "RemiFabre/microduck-flamingo-cycle", manifests(undefined));
    assert.equal(r.origin, "community");
    assert.equal(r.manifest_checked, false);
    assert.match(r.note!, /absence is not evidence/);
    assert.deepEqual(t.calls, [
      { method: "robot.loadPolicy", params: { slot: "walk", source: "RemiFabre/microduck-flamingo-cycle" } },
    ]);
  });

  test("origin is reported on the load itself, not only by list", async () => {
    const official = await loadPolicy(stub(), "stand", "pollen-robotics/microduck-stand", manifests());
    assert.equal(official.origin, "official");
    const local = await loadPolicy(stub(), "stand", "/home/radxa/p.onnx", manifests());
    assert.equal(local.origin, "local");
  });

  test("a v16 daemon's METHOD_NOT_FOUND becomes 'your daemon is too old'", async () => {
    const t = stub({ "robot.loadPolicy": new Error("method not found: robot.loadPolicy (code -32601)") });
    await assert.rejects(
      () => loadPolicy(t, "walk", "pollen-robotics/microduck-walk", manifests()),
      /daemon is too old.*API_VERSION 17/s,
    );
  });

  test("an ordinary refusal is passed through untouched", async () => {
    const t = stub({ "robot.loadPolicy": new Error("refused: repo carries two .onnx files") });
    await assert.rejects(
      () => loadPolicy(t, "walk", "pollen-robotics/microduck-walk", manifests()),
      /two \.onnx files/,
    );
  });
});

describe("resetPolicy", () => {
  test("one slot removes exactly one config key", async () => {
    const t = stub();
    const r = await resetPolicy(t, "stand");
    assert.deepEqual(r.reset, ["stand"]);
    assert.deepEqual(t.calls, [{ method: "robot.loadPolicy", params: { slot: "stand", source: null } }]);
  });

  test("no slot resets all seven, in upstream's order", async () => {
    const t = stub();
    const r = await resetPolicy(t);
    assert.deepEqual(r.reset, [...POLICY_SLOTS]);
    assert.deepEqual(
      t.calls.map((c) => c.params?.slot),
      [...POLICY_SLOTS],
    );
    assert.ok(t.calls.every((c) => c.params?.source === null), "reset removes the key; it names no file");
  });
});

describe("listPolicies", () => {
  test("fills in an origin the daemon did not report, by the same rule", async () => {
    const t = stub({
      "robot.policies": [
        { slot: "walk", policy: "flamingo", source: "RemiFabre/microduck-flamingo-cycle" },
        { slot: "stand", policy: "alpha_stand.onnx", source: "pollen-robotics/microduck-policies" },
        { slot: "roulade", policy: "x.onnx", source: "/home/radxa/x.onnx" },
      ],
    });
    assert.deepEqual(
      (await listPolicies(t)).map((r) => r.origin),
      ["community", "official", "local"],
    );
  });

  test("a daemon that reports its own origin is believed", async () => {
    const t = stub({ "robot.policies": { slots: [{ slot: "walk", origin: "official", source: "whatever" }] } });
    assert.equal((await listPolicies(t))[0].origin, "official");
  });
});

describe("MockTransport policy channel", () => {
  let m: MockTransport;
  beforeEach(() => {
    m = new MockTransport();
  });

  test("all seven slots start on the official set", async () => {
    const rows = await listPolicies(m);
    assert.deepEqual(rows.map((r) => r.slot), [...POLICY_SLOTS]);
    assert.ok(rows.every((r) => r.origin === "official"), "an untouched robot is entirely official");
    assert.equal(rows.find((r) => r.slot === "walk")!.policy, "alpha_walking.onnx");
  });

  test("a load shows up in the list with its origin and revision", async () => {
    await loadPolicy(m, "walk", "RemiFabre/microduck-flamingo-cycle@bouncy-2", manifests());
    const walk = (await listPolicies(m)).find((r) => r.slot === "walk")!;
    assert.equal(walk.origin, "community");
    assert.equal(walk.version, "bouncy-2");
    assert.equal(walk.policy, "RemiFabre/microduck-flamingo-cycle:policy.onnx");
  });

  test("reset puts the official policy back", async () => {
    await loadPolicy(m, "stand", "none", manifests());
    assert.equal((await listPolicies(m)).find((r) => r.slot === "stand")!.policy, null);
    await resetPolicy(m, "stand");
    const stand = (await listPolicies(m)).find((r) => r.slot === "stand")!;
    assert.equal(stand.policy, "alpha_stand.onnx");
    assert.equal(stand.origin, "official");
  });

  test("a request already satisfied queues no work (§4)", async () => {
    const untouched = (await m.call("robot.loadPolicy", { slot: "roulade", source: null })) as any;
    assert.equal(untouched.queued, false);
    await loadPolicy(m, "roulade", "someone/roulade", manifests());
    const again = (await m.call("robot.loadPolicy", { slot: "roulade", source: "someone/roulade" })) as any;
    assert.equal(again.queued, false);
  });

  test("an unknown slot is refused", async () => {
    await assert.rejects(() => m.call("robot.loadPolicy", { slot: "backflip", source: "x" }), /no such policy slot/);
  });
});

describe("SimTransport policy channel", () => {
  test("says it is unsupported rather than inventing slots", async () => {
    const t = new SimTransport({ python: process.execPath, script: "/nonexistent" });
    for (const method of ["robot.policies", "robot.loadPolicy"]) {
      await assert.rejects(() => t.call(method), /not supported on the sim transport/);
    }
    await t.close();
  });
});
