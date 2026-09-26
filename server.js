import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Readable } from "node:stream";
import { findScenario, prospectSystem, gradePrompt, deliveryLine } from "./public/framework.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(ROOT, ".env")); } catch { /* no .env: use the real environment */ }
const PORT = Number(process.env.PORT) || 3000;
const PROSPECT_MODEL = process.env.PROSPECT_MODEL || "claude-opus-5";
const GRADER_MODEL = process.env.GRADER_MODEL || "claude-opus-5";
const PROSPECT_EFFORT = process.env.PROSPECT_EFFORT || "low";   // spoken replies: speed over depth
const DATA_FILE = process.env.DATA_FILE || path.join(ROOT, "data", "calls.json");
const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY || "";
const ELEVEN_MODEL = process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5";
const ELEVEN_BASE = (process.env.ELEVENLABS_BASE_URL || "https://api.elevenlabs.io").replace(/\/$/, "");
const HAS_BRAIN = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_BASE_URL);

// Server-side refusal fallback: a declined request is re-run on Anthropic's
// recommended substitute model inside the same call.
const FALLBACK = { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" };

const client = new Anthropic();
const app = express();
app.use(express.json({ limit: "256kb" }));
app.use(express.static(path.join(ROOT, "public")));

/* ---------------- input shaping ---------------- */
const MAX_TURNS = 120, MAX_TEXT = 2000;
const clampDiff = (d) => Math.min(5, Math.max(1, parseInt(d, 10) || 3));
const clean = (s) => String(s ?? "").slice(0, MAX_TEXT).trim();
const num = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null; };

function cleanMeta(m) {
  if (!m || typeof m !== "object") return null;
  if (m.typed) return { typed: true };
  return {
    barged: !!m.barged,
    startedAfterMs: num(m.startedAfterMs, 0, 120000),
    fillers: Array.isArray(m.fillers) ? m.fillers.slice(0, 20).map((f) => clean(f).slice(0, 20)).filter(Boolean) : [],
    restarts: num(m.restarts, 0, 50) ?? 0,
    pauses: num(m.pauses, 0, 50) ?? 0,
    wpm: num(m.wpm, 0, 400),
    words: num(m.words, 0, 2000),
  };
}

function cleanTurns(turns) {
  if (!Array.isArray(turns)) return [];
  return turns.slice(-MAX_TURNS).map((t) => ({
    side: ["rep", "them", "director", "note"].includes(t?.side) ? t.side : null,
    text: clean(t?.text),
    cut: !!t?.cut,
    flagged: !!t?.flagged,
    meta: t?.side === "rep" ? cleanMeta(t.meta) : null,
    patience: t?.side === "them" ? num(t.patience, 0, 10) : null,
    objection: t?.side === "them" && /^[a-z0-9-]{1,40}$/.test(t?.objection || "") ? t.objection : null,
    tag: t?.side === "them" && t?.tag ? {
      who: t.tag.who === "dm" ? "dm" : "gatekeeper",
      step: num(t.tag.step, 1, 5) ?? 1,
      ev: ["none", "transferred", "booked", "hangup"].includes(t.tag.ev) ? t.tag.ev : "none",
    } : null,
  })).filter((t) => t.side && t.text);
}

// Call transcript -> alternating user/assistant messages that start and end on a user turn.
export function toMessages(turns) {
  const out = [];
  const push = (role, text) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += "\n" + text;
    else out.push({ role, content: text });
  };
  let talkedOver = false;
  for (const t of turns.slice(-40)) {
    if (t.side === "rep") {
      const d = deliveryLine(t.meta);
      push("user", (talkedOver ? "[the rep talked over you]\n" : "") + t.text + (d ? "\n" + d : ""));
      talkedOver = false;
    } else if (t.side === "them") {
      // keep the prospect's own control tag in history so its patience carries between turns
      const tag = t.tag ? `\n[[${t.tag.who}|${t.tag.step}|${t.tag.ev}|${t.patience ?? ""}|${t.objection || "none"}]]` : "";
      push("assistant", t.text + (t.cut ? " —" : "") + tag);
      talkedOver = t.cut;
    } else {
      push("user", t.text);            // director notes, silence, transfer pickup
    }
  }
  if (!out.length || out[0].role !== "user") out.unshift({ role: "user", content: "[The rep's call connects. You answer the phone.]" });
  if (out[out.length - 1].role !== "user") push("user", "[silence: the rep says nothing]");
  return out;
}

function errorCode(e) {
  if (e instanceof Anthropic.AuthenticationError) return { status: 500, code: "not_granted", message: "The server's Anthropic API key is missing or invalid." };
  if (e instanceof Anthropic.RateLimitError) return { status: 429, code: "rate_limited", message: "Rate limited." };
  if (e instanceof Anthropic.APIUserAbortError) return { status: 499, code: "cancelled", message: "Cancelled." };
  if (e instanceof Anthropic.APIError) return { status: 502, code: "upstream", message: e.message };
  return { status: 500, code: "error", message: String(e?.message || e) };
}

/* ---------------- prospect: streamed as NDJSON ---------------- */
app.post("/api/prospect", async (req, res) => {
  const sc = findScenario(req.body?.scenarioId);
  if (!sc) return res.status(400).json({ code: "bad_request", message: "Unknown scenario." });
  const who = req.body?.who === "dm" ? "dm" : "gatekeeper";
  const messages = toMessages(cleanTurns(req.body?.turns));

  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Accel-Buffering", "no");
  const send = (obj) => res.write(JSON.stringify(obj) + "\n");

  const t0 = Date.now();
  let firstAt = 0;
  const stream = client.beta.messages.stream({
    model: PROSPECT_MODEL,
    max_tokens: 4000,
    output_config: { effort: PROSPECT_EFFORT },
    system: prospectSystem(sc, clampDiff(req.body?.diff), who),
    messages,
    cache_control: { type: "ephemeral" },
    ...FALLBACK,
  });
  res.on("close", () => { if (!res.writableFinished) stream.abort(); });
  stream.on("text", (delta) => { if (!firstAt) firstAt = Date.now(); send({ delta }); });

  try {
    const msg = await stream.finalMessage();
    if (process.env.LOG_LATENCY) console.log(`prospect: first text ${firstAt ? firstAt - t0 : "-"}ms, done ${Date.now() - t0}ms, cache read ${msg.usage?.cache_read_input_tokens ?? 0}`);
    if (msg.stop_reason === "refusal") send({ error: "refusal", message: "The prospect declined to answer." });
    else send({ done: true });
  } catch (e) {
    const err = errorCode(e);
    if (err.code !== "cancelled") console.error("prospect:", err.message);
    if (!res.writableEnded) send({ error: err.code, message: err.message });
  }
  res.end();
});

/* ---------------- grading: structured output ---------------- */
const Teardown = z.object({
  steps: z.array(z.object({
    n: z.number().int(),
    name: z.string(),
    grade: z.enum(["A", "B", "C", "D", "F"]),
    hit: z.array(z.string()),
    miss: z.array(z.string()),
  })),
  worst: z.object({ said: z.string(), instead: z.string() }),
  fix: z.string(),
  verdict: z.string(),
  delivery: z.string(),
});

app.post("/api/grade", async (req, res) => {
  const sc = findScenario(req.body?.scenarioId);
  if (!sc) return res.status(400).json({ code: "bad_request", message: "Unknown scenario." });
  const outcome = ["booked", "hangup", "hungup"].includes(req.body?.outcome) ? req.body.outcome : "hungup";
  const reached = Math.min(5, Math.max(1, parseInt(req.body?.reached, 10) || 1));
  const prompt = gradePrompt({ sc, diff: clampDiff(req.body?.diff), outcome, reached, turns: cleanTurns(req.body?.turns) });

  try {
    const msg = await client.beta.messages.parse({
      model: GRADER_MODEL,
      max_tokens: 16000,
      messages: [{ role: "user", content: prompt }],
      output_config: { format: betaZodOutputFormat(Teardown) },
      ...FALLBACK,
    });
    if (msg.stop_reason === "refusal" || !msg.parsed_output) {
      return res.status(502).json({ code: "upstream", message: "Grading didn't come back." });
    }
    res.json(msg.parsed_output);
  } catch (e) {
    const err = errorCode(e);
    console.error("grade:", err.message);
    res.status(err.status).json({ code: err.code, message: err.message });
  }
});

/* ---------------- config ---------------- */
app.get("/api/config", (_req, res) => {
  res.json({ brain: HAS_BRAIN, tts: ELEVEN_KEY ? "elevenlabs" : "browser" });
});

/* ---------------- premium voices (optional): ElevenLabs ---------------- */
function ttsText(s) {
  return String(s ?? "")
    .replace(/\[\[[\s\S]*$/, "")          // never voice a control tag
    .replace(/[*_~`#<>{}\[\]|]/g, "")
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

app.post("/api/tts", async (req, res) => {
  if (!ELEVEN_KEY) return res.status(404).json({ code: "no_tts" });
  const sc = findScenario(req.body?.scenarioId);
  const role = ["dm", "gk", "rep"].includes(req.body?.role) ? req.body.role : "gk";
  const text = ttsText(req.body?.text);
  if (!sc || !text) return res.status(400).json({ code: "bad_request" });
  const voice = voiceFor(sc, role);
  const ctl = new AbortController();
  res.on("close", () => { if (!res.writableFinished) ctl.abort(); });
  try {
    const r = await fetch(`${ELEVEN_BASE}/v1/text-to-speech/${encodeURIComponent(voice)}/stream?output_format=mp3_44100_64`, {
      method: "POST",
      signal: ctl.signal,
      headers: { "xi-api-key": ELEVEN_KEY, "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({
        text,
        model_id: ELEVEN_MODEL,
        previous_text: ttsText(req.body?.previous).slice(-300) || undefined,
        voice_settings: { stability: 0.45, similarity_boost: 0.75, style: 0.15, use_speaker_boost: true },
      }),
    });
    if (!r.ok || !r.body) {
      const detail = await r.text().catch(() => "");
      console.error("tts:", r.status, detail.slice(0, 200));
      return res.status(502).json({ code: "tts_failed" });
    }
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    Readable.fromWeb(r.body).on("error", () => res.end()).pipe(res);
  } catch (e) {
    if (e?.name !== "AbortError") console.error("tts:", e?.message || e);
    if (!res.headersSent) res.status(502).json({ code: "tts_failed" });
  }
});

function voiceFor(sc, role) {
  if (role === "rep") return process.env.ELEVENLABS_VOICE_REP || "pNInz6obpgDQGcFmaJgB";
  const env = process.env[`ELEVENLABS_VOICE_${sc.id.toUpperCase()}_${role.toUpperCase()}`];
  return env || (role === "dm" ? sc.dmVoiceId : sc.gkVoiceId) || "21m00Tcm4TlvDq8ikWAM";
}

/* ---------------- call log: a small JSON file ---------------- */
let calls = null, writing = Promise.resolve();
async function loadCalls() {
  if (calls) return calls;
  try { calls = JSON.parse(await readFile(DATA_FILE, "utf8")); } catch { calls = {}; }
  return calls;
}
function saveCalls() {
  writing = writing.then(async () => {
    await mkdir(path.dirname(DATA_FILE), { recursive: true });
    const tmp = DATA_FILE + ".tmp";
    await writeFile(tmp, JSON.stringify(calls, null, 1));
    await rename(tmp, DATA_FILE);
  }).catch((e) => console.error("save calls:", e.message));
  return writing;
}

app.get("/api/calls", async (_req, res) => {
  const all = Object.values(await loadCalls());
  all.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  res.json(all.slice(0, 60));
});

app.put("/api/calls/:id", async (req, res) => {
  const id = String(req.params.id);
  if (!/^[a-z0-9]{1,32}$/i.test(id)) return res.status(400).json({ code: "bad_request" });
  const b = req.body || {};
  const rec = {
    id,
    at: typeof b.at === "string" ? b.at.slice(0, 40) : new Date().toISOString(),
    firm: clean(b.firm).slice(0, 80),
    diff: clampDiff(b.diff),
    reached: Math.min(5, Math.max(1, parseInt(b.reached, 10) || 1)),
    outcome: ["booked", "hangup", "hungup"].includes(b.outcome) ? b.outcome : "hungup",
    seconds: Math.max(0, parseInt(b.seconds, 10) || 0),
    peeks: Math.max(0, parseInt(b.peeks, 10) || 0),
    retries: Math.max(0, parseInt(b.retries, 10) || 0),
    grade: /^[ABCDF]$/.test(b.grade) ? b.grade : "",
    fix: clean(b.fix).slice(0, 300),
  };
  (await loadCalls())[id] = rec;
  await saveCalls();
  res.json(rec);
});

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) app.listen(PORT, () => {
  console.log(`The Dial Room is on http://localhost:${PORT}`);
  if (!HAS_BRAIN) console.warn("No ANTHROPIC_API_KEY set — the prospect can't answer until you set one.");
  console.log(ELEVEN_KEY ? "Voices: ElevenLabs" : "Voices: browser speech (set ELEVENLABS_API_KEY for realistic voices)");
});

export { app };
