// Call state for live-voice calls. ElevenLabs calls our reply endpoint from the
// outside, so on Vercel that request can land on a different instance than the
// browser's: state must live somewhere shared. In order of preference it lives in
// Supabase (SUPABASE_URL + a service-role key, the shape Vercel's Supabase
// integration provides), Vercel Blob (BLOB_READ_WRITE_TOKEN), or this process
// (fine for one local server).
//
// Writes are compare-and-set on a `rev` counter kept inside the state JSON: two
// requests for the same call routinely overlap (ElevenLabs re-asks while the
// previous reply is still being recorded, the browser posts a note mid-reply),
// and a blind upsert lets the later load erase the earlier write.

const SB_URL = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || "";
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN || "";
export const STORE_KIND = SB_URL && SB_KEY ? "supabase" : BLOB_TOKEN ? "blob" : "memory";

const mem = new Map();
const TTL_MS = 6 * 3600e3;
const CAS_ATTEMPTS = 6;
let blob = null;
async function blobApi() { return (blob ??= await import("@vercel/blob")); }
const key = (id) => `dialroom/state/${id}.json`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- Supabase, through its REST API: no client library, no connection pool ---------- */
export const SB_TABLE = { state: "dialroom_state", calls: "dialroom_calls" };
export async function sb(path, init = {}) {
  const headers = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", ...(init.headers || {}) };
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { ...init, headers });
  const text = await r.text();
  if (!r.ok) throw new Error(`Supabase ${r.status} ${path.split("?")[0]}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

export async function loadState(id) {
  if (STORE_KIND === "supabase") {
    const rows = await sb(`${SB_TABLE.state}?id=eq.${encodeURIComponent(id)}&select=state&limit=1`);
    return rows?.[0]?.state ?? null;
  }
  if (STORE_KIND === "memory") {
    const hit = mem.get(id);
    if (hit && Date.now() - hit.at > TTL_MS) { mem.delete(id); return null; }
    return hit ? structuredClone(hit.state) : null;
  }
  const { get } = await blobApi();
  const r = await get(key(id), { access: "private", useCache: false });
  if (!r) return null;
  const text = r.blob ? await r.blob.text() : await new Response(r.stream).text();
  try { return JSON.parse(text); } catch { return null; }
}

// Write `state` only if the stored row still carries `expectRev` (null: only if there is no row).
// Returns false on a conflict. Blob has no conditional write, so there it is a plain put.
async function casSave(id, state, expectRev) {
  const row = { id, state, at: new Date().toISOString() };
  if (STORE_KIND === "supabase") {
    if (expectRev == null) {
      const rows = await sb(SB_TABLE.state, { method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=representation" }, body: JSON.stringify(row) });
      return Array.isArray(rows) && rows.length === 1;
    }
    // Plain filters only: PostgREST before 14.4 rejects or=() on a PATCH. A row written before
    // rev existed reads as rev 0, so an expected 0 is tried against a missing rev as well.
    const patch = async (revFilter) => {
      const rows = await sb(`${SB_TABLE.state}?id=eq.${encodeURIComponent(id)}&state->>rev=${revFilter}&select=id`,
        { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ state, at: row.at }) });
      return Array.isArray(rows) && rows.length === 1;
    };
    return (await patch(`eq.${expectRev}`)) || (expectRev === 0 && await patch("is.null"));
  }
  if (STORE_KIND === "memory") {
    const cur = mem.get(id);
    const curRev = cur ? (cur.state.rev ?? 0) : null;
    if (expectRev == null ? cur != null : curRev !== expectRev) return false;
    mem.set(id, { at: Date.now(), state: structuredClone(state) });
    return true;
  }
  const { put } = await blobApi();
  await put(key(id), JSON.stringify(state), { access: "private", addRandomSuffix: false, allowOverwrite: true, contentType: "application/json" });
  return true;
}

// Unconditional write: for a brand-new call. Live rows go through updateState.
export async function saveState(id, state) {
  state.rev = (state.rev ?? 0) + 1;
  if (STORE_KIND === "supabase") {
    await sb(SB_TABLE.state, { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ id, state, at: new Date().toISOString() }) });
    return;
  }
  if (STORE_KIND === "memory") { mem.set(id, { at: Date.now(), state: structuredClone(state) }); return; }
  await casSave(id, state, null);
}

// Read-modify-write with retry. `fn` mutates the freshly loaded state (or returns a
// replacement); a null state means "not found" unless `create` is set, in which case
// `fn` gets an empty object to fill. `fn` returning false means "nothing to write":
// the current state comes back untouched. Throws after CAS_ATTEMPTS conflicts.
export async function updateState(id, fn, { create = false } = {}) {
  for (let i = 0; i < CAS_ATTEMPTS; i++) {
    const cur = await loadState(id);
    if (!cur && !create) return null;
    const expect = cur ? (cur.rev ?? 0) : null;
    const stored = cur ? structuredClone(cur) : null;
    const draft = cur || {};
    const out = await fn(draft);
    if (out === false) return stored;
    const next = out || draft;
    next.rev = (expect ?? 0) + 1;
    if (await casSave(id, next, expect)) return next;
    await sleep(40 + Math.floor(Math.random() * 80));
  }
  throw new Error(`state conflict ${id}`);
}

// Occasional sweep so a long-running local server doesn't hold every call forever.
export function sweepMemory() {
  const now = Date.now();
  for (const [id, hit] of mem) if (now - hit.at > TTL_MS) mem.delete(id);
}
