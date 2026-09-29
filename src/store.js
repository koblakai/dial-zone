// Call state for live-voice calls. ElevenLabs calls our reply endpoint from the
// outside, so on Vercel that request can land on a different instance than the
// browser's: state must live somewhere shared. In order of preference it lives in
// Supabase (SUPABASE_URL + a service-role key, the shape Vercel's Supabase
// integration provides), Vercel Blob (BLOB_READ_WRITE_TOKEN), or this process
// (fine for one local server).

const SB_URL = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || "";
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN || "";
export const STORE_KIND = SB_URL && SB_KEY ? "supabase" : BLOB_TOKEN ? "blob" : "memory";

const mem = new Map();
const TTL_MS = 6 * 3600e3;
let blob = null;
async function blobApi() { return (blob ??= await import("@vercel/blob")); }
const key = (id) => `dialroom/state/${id}.json`;

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

export async function saveState(id, state) {
  if (STORE_KIND === "supabase") {
    await sb(SB_TABLE.state, { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ id, state, at: new Date().toISOString() }) });
    return;
  }
  if (STORE_KIND === "memory") { mem.set(id, { at: Date.now(), state: structuredClone(state) }); return; }
  const { put } = await blobApi();
  await put(key(id), JSON.stringify(state), {
    access: "private", addRandomSuffix: false, allowOverwrite: true, contentType: "application/json",
  });
}

// Read-modify-write. `fn` mutates or returns the state; a null state means "not found".
export async function updateState(id, fn) {
  const state = await loadState(id);
  if (!state) return null;
  const next = (await fn(state)) || state;
  await saveState(id, next);
  return next;
}

// Occasional sweep so a long-running local server doesn't hold every call forever.
export function sweepMemory() {
  const now = Date.now();
  for (const [id, hit] of mem) if (now - hit.at > TTL_MS) mem.delete(id);
}
