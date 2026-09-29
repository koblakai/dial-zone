// Call state for live-voice calls. ElevenLabs calls our reply endpoint from the
// outside, so on Vercel that request can land on a different instance than the
// browser's: state must live somewhere shared. With BLOB_READ_WRITE_TOKEN set it
// lives in Vercel Blob; otherwise in this process (fine for one local server).

const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN || "";
export const STORE_KIND = BLOB_TOKEN ? "blob" : "memory";

const mem = new Map();
const TTL_MS = 6 * 3600e3;
let blob = null;
async function blobApi() { return (blob ??= await import("@vercel/blob")); }
const key = (id) => `dialroom/state/${id}.json`;

export async function loadState(id) {
  if (!BLOB_TOKEN) {
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
  if (!BLOB_TOKEN) { mem.set(id, { at: Date.now(), state: structuredClone(state) }); return; }
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
