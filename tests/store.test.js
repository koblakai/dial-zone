// The call-state store: compare-and-set writes against a PostgREST stand-in, and the
// same contract on the in-process memory backend (a different import URL is a
// different module instance, so both can be loaded in one process).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

const tables = new Map();
const tbl = (t) => tables.get(t) || tables.set(t, new Map()).get(t);
const srv = createServer((req, res) => {
  let body = ""; req.on("data", (d) => (body += d));
  req.on("end", () => {
    const url = new URL(req.url, "http://x");
    const rows = tbl(url.pathname.replace("/rest/v1/", ""));
    assert.equal(req.headers.apikey, "svc"); assert.equal(req.headers.authorization, "Bearer svc");
    const idEq = url.searchParams.get("id"), revEq = url.searchParams.get("state->>rev"), prefer = req.headers.prefer || "";
    assert.equal(url.searchParams.get("or"), null, "no or=() on mutations: PostgREST < 14.4 rejects it");
    const revOf = (r) => r.state.rev == null ? null : String(r.state.rev);
    const revOk = (r) => !revEq || (revEq === "is.null" ? revOf(r) === null : "eq." + (revOf(r) ?? "") === revEq);
    const match = (r) => (!idEq || "eq." + r.id === idEq) && revOk(r);
    const send = (code, out) => { res.writeHead(code, { "content-type": "application/json" }); res.end(req.method === "GET" || prefer.includes("return=representation") ? JSON.stringify(out) : ""); };
    if (req.method === "GET") return send(200, [...rows.values()].filter(match).map((r) => ({ state: r.state })));
    if (req.method === "POST") {
      const row = JSON.parse(body), exists = rows.has(row.id);
      if (exists && prefer.includes("ignore-duplicates")) return send(201, []);
      if (exists && !prefer.includes("merge-duplicates")) return send(409, { message: "duplicate key" });
      rows.set(row.id, row); return send(201, [row]);
    }
    if (req.method === "PATCH") {
      const patch = JSON.parse(body), hit = [...rows.values()].filter(match);
      hit.forEach((r) => Object.assign(r, patch));
      return send(200, hit.map((r) => ({ id: r.id })));
    }
    send(405, {});
  });
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
after(() => srv.close());

process.env.SUPABASE_URL = `http://127.0.0.1:${srv.address().port}`;
process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
const supa = await import("../src/store.js?backend=supabase");
delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_ROLE_KEY;
const memory = await import("../src/store.js?backend=memory");
assert.equal(supa.STORE_KIND, "supabase"); assert.equal(memory.STORE_KIND, "memory");

for (const [name, store] of [["supabase", supa], ["memory", memory]]) {
  const id = (s) => `${name}-${s}`;

  test(`${name}: save, load, update, miss`, async () => {
    assert.equal(await store.loadState(id("nope")), null);
    await store.saveState(id("v1"), { turns: [], step: 1 });
    assert.deepEqual(await store.loadState(id("v1")), { turns: [], step: 1, rev: 1 });
    const next = await store.updateState(id("v1"), (s) => { s.step = 2; });
    assert.equal(next.step, 2); assert.equal(next.rev, 2);
    assert.equal((await store.loadState(id("v1"))).step, 2, "the conditional write landed");
    assert.equal(await store.updateState(id("ghost"), () => {}), null);
  });

  test(`${name}: two overlapping updates both land (the stale one retries onto the newer row)`, async () => {
    await store.updateState(id("c1"), (s) => { s.a = 0; s.b = 0; }, { create: true });
    let release; const gate = new Promise((r) => (release = r));
    let runs = 0;
    const slow = store.updateState(id("c1"), async (s) => { runs++; await gate; s.a = 1; });   // loads rev 1, saves after the fast one
    await new Promise((r) => setTimeout(r, 30));
    const fast = await store.updateState(id("c1"), (s) => { s.b = 1; });
    assert.equal(fast.rev, 2);
    release();
    const out = await slow;
    assert.deepEqual([out.a, out.b, out.rev], [1, 1, 3], "neither mutation was lost");
    assert.equal(runs, 2, "the stale attempt was re-run against the fresh row");
    assert.deepEqual((await store.loadState(id("c1"))), out);
  });

  test(`${name}: a row written before rev existed can still be updated`, async () => {
    if (name === "supabase") tbl("dialroom_state").set(id("legacy"), { id: id("legacy"), state: { turns: [], step: 1 }, at: "x" });
    else await store.saveState(id("legacy"), { turns: [], step: 1 }).then(() => store.updateState(id("legacy"), (s) => { delete s.rev; }));
    const before = await store.loadState(id("legacy"));
    if (name === "supabase") assert.equal(before.rev, undefined);
    const next = await store.updateState(id("legacy"), (s) => { s.step = 2; });
    assert.equal(next.step, 2); assert.ok(next.rev >= 1);
    assert.equal((await store.loadState(id("legacy"))).step, 2);
  });

  test(`${name}: fn returning false writes nothing`, async () => {
    await store.updateState(id("ro"), (s) => { s.x = 1; }, { create: true });
    const before = await store.loadState(id("ro"));
    const same = await store.updateState(id("ro"), (s) => { s.x = 99; return false; });
    assert.deepEqual(same, before); assert.deepEqual(await store.loadState(id("ro")), before);
  });

  test(`${name}: create inserts once; a second creator merges into the existing row`, async () => {
    const a = await store.updateState(id("new"), (s) => { if (!s.id) Object.assign(s, { id: "new", from: "a" }); s.seenA = true; }, { create: true });
    assert.equal(a.rev, 1);
    const b = await store.updateState(id("new"), (s) => { if (!s.id) Object.assign(s, { id: "new", from: "b" }); s.seenB = true; }, { create: true });
    assert.deepEqual([b.from, b.seenA, b.seenB, b.rev], ["a", true, true, 2]);
  });

  test(`${name}: an update that keeps losing the race gives up with a conflict error`, async () => {
    await store.updateState(id("hot"), (s) => { s.n = 0; }, { create: true });
    // every attempt loses to a write that lands between its load and its save
    await assert.rejects(
      store.updateState(id("hot"), async (s) => { await store.updateState(id("hot"), (t) => { t.n = (t.n || 0) + 100; }); s.n = -1; }),
      /state conflict/);
    assert.equal((await store.loadState(id("hot"))).n, 600, "six attempts, six interfering writes, none of ours");
  });
}
