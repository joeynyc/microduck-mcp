import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { listPolicies, loadPolicy, originOf, parseSource, resetPolicy, searchPolicies } from "../policy.js";
import { POLICY_SLOTS } from "../transport/protocol.js";
import { MockTransport } from "../transport/mock.js";
import { SimTransport } from "../transport/sim.js";
import { DuckTransport } from "../transport/types.js";

/** Transport stub: records every call, answers whatever it is given. */
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
      if (method === "policy.fetch") {
        return { path: `/var/lib/robot/policies/${params!.repo}/${params!.revision ?? "main"}/policy.onnx`, origin: "community" };
      }
      return { accepted: true };
    },
    async ping() {
      return true;
    },
    async close() {},
  };
}

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

  test("an absolute path on the board is local", () => {
    assert.equal(originOf("/home/radxa/policies/flamingo/policy.onnx"), "local");
    assert.equal(originOf("none"), "local");
  });

  test("a relative path is refused with the reason, not sent for the daemon to reject", () => {
    for (const s of ["~/policies/try.onnx", "./out/policy.onnx", "policy.onnx"]) {
      assert.throws(() => parseSource(s), /not absolute/);
    }
  });

  test("anything else is not a source", () => {
    assert.throws(() => parseSource("flamingo-cycle"), /not a policy source/);
    assert.throws(() => parseSource("a/b/c"), /not a policy source/);
  });

  test("the revision travels with the repo", () => {
    assert.deepEqual(parseSource("RemiFabre/microduck-flamingo-cycle@bouncy-2"), {
      kind: "hf",
      origin: "community",
      repo: "RemiFabre/microduck-flamingo-cycle",
      org: "RemiFabre",
      name: "microduck-flamingo-cycle",
      rev: "bouncy-2",
    });
    const noRev = parseSource("RemiFabre/microduck-flamingo-cycle");
    assert.equal(noRev.kind === "hf" ? noRev.rev : "?", undefined, "the daemon defaults to main");
  });
});

describe("walk can never be switched off", () => {
  test("walk = none is refused with a reason, before any wire traffic", async () => {
    const t = stub();
    await assert.rejects(() => loadPolicy(t, "walk", "none"), /walk cannot be set to "none"/);
    assert.deepEqual(t.calls, [], "nothing reached the daemon");
  });

  test("every other slot may be switched off, as path 'none'", async () => {
    for (const slot of POLICY_SLOTS.filter((s) => s !== "walk")) {
      const t = stub();
      const r = await loadPolicy(t, slot, "none");
      assert.equal(r.path, "none");
      assert.deepEqual(t.calls, [{ method: "robot.loadPolicy", params: { slot, path: "none" } }]);
    }
  });
});

describe("loadPolicy", () => {
  test("a Hub repo is fetched on updaterd, then the returned path is loaded on robotd", async () => {
    const t = stub();
    const r = await loadPolicy(t, "walk", "RemiFabre/microduck-flamingo-cycle@bouncy-2");
    assert.deepEqual(t.calls, [
      { method: "policy.fetch", params: { repo: "RemiFabre/microduck-flamingo-cycle", revision: "bouncy-2" } },
      {
        method: "robot.loadPolicy",
        params: { slot: "walk", path: "/var/lib/robot/policies/RemiFabre/microduck-flamingo-cycle/bouncy-2/policy.onnx" },
      },
    ]);
    assert.equal(r.origin, "community");
    assert.equal(r.fetched?.path, r.path);
  });

  test("no revision means none is sent — the daemon's default is main", async () => {
    const t = stub();
    await loadPolicy(t, "walk", "pollen-robotics/microduck-walk");
    assert.deepEqual(t.calls[0].params, { repo: "pollen-robotics/microduck-walk" });
  });

  test("the daemon's origin is believed over ours", async () => {
    const t = stub({ "policy.fetch": { path: "/var/lib/robot/policies/x/y/main/policy.onnx", origin: "official" } });
    assert.equal((await loadPolicy(t, "stand", "x/y")).origin, "official");
  });

  test("a community refusal (daemon 0.18+, allow_community off) says it is the owner's call", async () => {
    const refusal = new Error(
      "nocrab/microduck-flamingo is a community policy, and this robot only fetches from pollen-robotics: " +
        "set allow_community = true under [policy] with sudo robotctl configure (code 14)",
    );
    const t = stub({ "policy.fetch": refusal });
    await assert.rejects(() => loadPolicy(t, "walk", "nocrab/microduck-flamingo"), (e: Error) => {
      assert.match(e.message, /owner's decision/);
      assert.match(e.message, /do not change it yourself/);
      assert.match(e.message, /underlying: .*code 14/);
      return true;
    });
    assert.equal(t.calls.length, 1, "nothing is loaded after a refused fetch");
  });

  test("other permission refusals pass through untouched", async () => {
    const t = stub({ "policy.fetch": new Error("not allowed (code 14)") });
    await assert.rejects(() => loadPolicy(t, "walk", "x/y"), /^Error: not allowed \(code 14\)$/);
  });

  test("an absolute path skips the fetch and is loaded as-is", async () => {
    const t = stub();
    const r = await loadPolicy(t, "stand", "/home/radxa/p.onnx");
    assert.equal(r.origin, "local");
    assert.equal(r.fetched, undefined);
    assert.deepEqual(t.calls, [{ method: "robot.loadPolicy", params: { slot: "stand", path: "/home/radxa/p.onnx" } }]);
  });

  test("only slot and path ever go on the wire (LoadPolicyParams is deny_unknown_fields)", async () => {
    const t = stub();
    await loadPolicy(t, "stand", "/home/radxa/p.onnx");
    await resetPolicy(t, "stand");
    await resetPolicy(t);
    for (const c of t.calls) {
      assert.ok(Object.keys(c.params ?? {}).every((k) => k === "slot" || k === "path"), JSON.stringify(c));
    }
  });

  test("a refused load is raised with the daemon's reason", async () => {
    const t = stub({ "robot.loadPolicy": { accepted: false, reason: "obs[1,51] does not match [1,61]" } });
    await assert.rejects(() => loadPolicy(t, "walk", "/home/radxa/legacy.onnx"), /refused: obs\[1,51\]/);
  });

  test("a fetch failure stops before robotd is asked anything", async () => {
    const t = stub({ "policy.fetch": new Error("refused: repo carries two .onnx files") });
    await assert.rejects(() => loadPolicy(t, "walk", "someone/two-files"), /two \.onnx files/);
    assert.equal(t.calls.length, 1);
  });

  test("an old daemon's METHOD_NOT_FOUND becomes 'your daemon is too old'", async () => {
    const t = stub({ "robot.loadPolicy": new Error("method not found: robot.loadPolicy (code -32601)") });
    await assert.rejects(() => loadPolicy(t, "walk", "/home/radxa/p.onnx"), /daemon is too old.*API_VERSION 18/s);
  });
});

describe("resetPolicy", () => {
  test("one slot is the same method with no path", async () => {
    const t = stub();
    const r = await resetPolicy(t, "stand");
    assert.deepEqual(r.reset, ["stand"]);
    assert.deepEqual(t.calls, [{ method: "robot.loadPolicy", params: { slot: "stand" } }]);
  });

  test("no slot is one call with neither field — 'put it all back'", async () => {
    const t = stub();
    const r = await resetPolicy(t);
    assert.deepEqual(r.reset, [...POLICY_SLOTS]);
    assert.deepEqual(t.calls, [{ method: "robot.loadPolicy", params: {} }]);
  });
});

describe("listPolicies / searchPolicies", () => {
  test("list passes the daemon's PoliciesResult through", async () => {
    const answer = { mode: "walk", enabled: true, slots: [{ slot: "walk", path: "/x", origin: "official", overridden: false }], skills: ["bow"] };
    assert.deepEqual(await listPolicies(stub({ "robot.policies": answer })), answer);
  });

  test("search asks updaterd and unwraps the models", async () => {
    const t = stub({ "policy.search": { models: [{ id: "a/b", origin: "community" }] } });
    assert.deepEqual(await searchPolicies(t, "duck"), [{ id: "a/b", origin: "community" }]);
    assert.deepEqual(t.calls, [{ method: "policy.search", params: { query: "duck" } }]);
  });
});

describe("MockTransport policy channel", () => {
  let m: MockTransport;
  beforeEach(() => {
    m = new MockTransport();
  });

  test("all seven slots start on the official set, nothing overridden", async () => {
    const r = await listPolicies(m);
    assert.deepEqual(r.slots.map((s) => s.slot), [...POLICY_SLOTS]);
    assert.ok(r.slots.every((s) => s.origin === "official" && !s.overridden));
    assert.match(r.slots[0].path!, /alpha_walking\.onnx$/);
    assert.ok(r.skills!.includes("sit_toggle"));
  });

  test("a load shows up in the list with its origin and library path", async () => {
    await loadPolicy(m, "walk", "RemiFabre/microduck-flamingo-cycle@bouncy-2");
    const walk = (await listPolicies(m)).slots.find((s) => s.slot === "walk")!;
    assert.equal(walk.origin, "community");
    assert.equal(walk.overridden, true);
    assert.equal(walk.path, "/var/lib/robot/policies/RemiFabre/microduck-flamingo-cycle/bouncy-2/policy.onnx");
  });

  test("reset puts the official policy back", async () => {
    await loadPolicy(m, "stand", "none");
    assert.equal((await listPolicies(m)).slots.find((s) => s.slot === "stand")!.path, undefined);
    await resetPolicy(m, "stand");
    const stand = (await listPolicies(m)).slots.find((s) => s.slot === "stand")!;
    assert.match(stand.path!, /alpha_stand\.onnx$/);
    assert.equal(stand.overridden, false);
  });

  test("reset with no slot clears every override in one call", async () => {
    await loadPolicy(m, "stand", "/home/radxa/a.onnx");
    await loadPolicy(m, "roulade", "/home/radxa/b.onnx");
    await resetPolicy(m);
    assert.ok((await listPolicies(m)).slots.every((s) => !s.overridden));
  });

  test("the mock is as strict as the daemon about the params shape", async () => {
    await assert.rejects(() => m.call("robot.loadPolicy", { slot: "walk", source: "x" }), /unknown field `source`/);
    const noSlot = (await m.call("robot.loadPolicy", { path: "/x.onnx" })) as any;
    assert.equal(noSlot.accepted, false);
    const badSlot = (await m.call("robot.loadPolicy", { slot: "backflip", path: "/x.onnx" })) as any;
    assert.match(badSlot.reason, /no policy slot named "backflip"/);
    const relative = (await m.call("robot.loadPolicy", { slot: "walk", path: "x.onnx" })) as any;
    assert.match(relative.reason, /not absolute/);
  });

  test("search is served from updaterd's namespace", async () => {
    const hits = await searchPolicies(m, "flamingo");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].origin, "community");
  });
});

describe("SimTransport policy channel", () => {
  test("says it is unsupported rather than inventing slots", async () => {
    const t = new SimTransport({ python: process.execPath, script: "/nonexistent" });
    for (const method of ["robot.policies", "robot.loadPolicy", "policy.fetch", "policy.search"]) {
      await assert.rejects(() => t.call(method), /not supported on the sim transport/);
    }
    await t.close();
  });
});
