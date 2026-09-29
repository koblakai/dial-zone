// The Supabase store talks to PostgREST over plain fetch: check the shape of what it sends and reads.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

const rows = new Map();
const srv = createServer((req, res) => {
  let body = ""; req.on("data", (d) => (body += d));
  req.on("end", () => {
    const url = new URL(req.url, "http://x");
    assert.equal(req.headers.apikey, "svc"); assert.equal(req.headers.authorization, "Bearer svc");
    const table = url.pathname.replace("/rest/v1/", "");
    if (req.method === "POST") {
      assert.match(req.headers.prefer || "", /merge-duplicates/);
      const rec = JSON.parse(body); rows.set(table + ":" + rec.id, rec);
      res.writeHead(201); return res.end();
    }
    const eq = url.searchParams.get("id");
    const out = [...rows.entries()].filter(([k]) => k.startsWith(table + ":")).map(([, v]) => v)
      .filter((v) => !eq || "eq." + v.id === eq);
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify(out));
  });
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
process.env.SUPABASE_URL = `http://127.0.0.1:${srv.address().port}`;
process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
const store = await import("../src/store.js");

test("supabase store: save, load, update, miss", async (t) => {
  t.after(() => srv.close());
  assert.equal(store.STORE_KIND, "supabase");
  assert.equal(await store.loadState("nope"), null);
  await store.saveState("v1", { turns: [], step: 1 });
  assert.deepEqual(await store.loadState("v1"), { turns: [], step: 1 });
  const next = await store.updateState("v1", (s) => { s.step = 2; });
  assert.equal(next.step, 2);
  assert.equal((await store.loadState("v1")).step, 2, "the upsert overwrote the row");
  assert.equal(await store.updateState("ghost", () => {}), null);
});
