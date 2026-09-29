import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { timingSafeEqual } from "node:crypto";
import { findScenario, prospectSystem, gradePrompt, deliveryLine } from "../public/framework.js";
import { createVoice } from "./voice.js";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try { process.loadEnvFile(path.join(ROOT, ".env")); } catch { /* no .env: use the real environment */ }

export const PORT = Number(process.env.PORT) || 3000;
export const ON_VERCEL = !!process.env.VERCEL;
export const APP_PASSWORD = process.env.APP_PASSWORD || "";
// Without a password, stay on this machine unless HOST says otherwise.
export const HOST = process.env.HOST || (APP_PASSWORD ? "0.0.0.0" : "127.0.0.1");
export const LOOPBACK = /^(127\.|localhost$|::1$|\[::1\]$)/i.test(HOST);
const PROSPECT_MODEL = process.env.PROSPECT_MODEL || "claude-opus-5-5";
const GRADER_MODEL = process.env.GRADER_MODEL || "claude-opus-5-5";
const GRADER_EFFORT = process.env.GRADER_EFFORT || "high";        // the teardown is not real-time: depth over speed
const PROSPECT_EFFORT = process.env.PROSPECT_EFFORT || "low";   // spoken replies: speed over depth
// PROSPECT_THINKING=off is the fastest first word, and only Claude Sonnet 5.5 accepts it.
const PROSPECT_THINKING = process.env.PROSPECT_THINKING === "off" && PROSPECT_MODEL === "claude-sonnet-5-5" ? { thinking: { type: "between_tools" } } : {};
// Vercel's filesystem is read-only except /tmp (so the hosted call log is per-instance and temporary)
const DATA_FILE = path.resolve(ROOT, process.env.DATA_FILE || (ON_VERCEL ? "/tmp/calls.json" : "data/calls.json"));
export const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY || "";
const ELEVEN_MODEL = process.env.ELEVENLABS_MODEL || "eleven_turbo_v2_5";   // smoother than flash, still fast enough for a live line
const ELEVEN_BASE = (process.env.ELEVENLABS_BASE_URL || "https://api.elevenlabs.io").replace(/\/$/, "");
const TTS_TIMEOUT_MS = 8000;
export const HAS_BRAIN = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

// Server-side refusal fallback: a declined request is re-run on Anthropic's
// recommended substitute model inside the same call.
const FALLBACK = { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" };

const client = new Anthropic();
export const app = express();
app.disable("x-powered-by");
// Behind a local HTTPS proxy, rate-limit by the real client address (never trust remote X-Forwarded-For).
app.set("trust proxy", process.env.TRUST_PROXY || (ON_VERCEL ? true : "loopback"));

// ElevenLabs calls this route from outside for every prospect reply; it is keyed by a secret in the
// URL rather than the app password. Registered first so the password check below never sees it.
let voice = null;
app.use("/api/voice", express.json({ limit: "1mb" }), (req, res, next) => (voice ? voice.llm(req, res, next) : next()));
// Whether live voice is on, and why not: no secrets in it, so it needs no password (handy for checking a deployment).
app.get("/api/voice/status", (req, res, next) => (voice ? res.json(voice.status()) : next()));

// Optional shared password (HTTP Basic auth) so a deployed copy isn't an open door to your API keys.
if (APP_PASSWORD) {
  app.use((req, res, next) => {
    const [scheme, token] = String(req.headers.authorization || "").split(" ");
    const pass = scheme === "Basic" && token ? Buffer.from(token, "base64").toString().split(":").slice(1).join(":") : "";
    const a = Buffer.from(pass), b = Buffer.from(APP_PASSWORD);
    if (a.length === b.length && timingSafeEqual(a, b)) return next();
    res.set("WWW-Authenticate", 'Basic realm="The Dial Room"').status(401).send("Password required.");
  });
} else if (LOOPBACK && !ON_VERCEL) {
  // Local-only mode: refuse other Host names so a web page can't reach the API via DNS rebinding.
  app.use((req, res, next) => {
    const host = String(req.headers.host || "").replace(/:\d+$/, "").toLowerCase();
    const bound = HOST.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === bound || host === `[${bound}]`) return next();
    res.status(403).send("Open this app on localhost, or set APP_PASSWORD to share it.");
  });
}
app.use(express.json({ limit: "256kb" }));
app.use(express.static(path.join(ROOT, "public")));

// A small per-client rate limit on the paid endpoints.
function limit(perMinute) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now(), key = req.ip || "local";
    const recent = (hits.get(key) || []).filter((t) => now - t < 60000);
    if (recent.length >= perMinute) return res.status(429).json({ code: "rate_limited", message: "Too many requests." });
    recent.push(now); hits.set(key, recent);
    if (hits.size > 5000) hits.clear();
    next();
  };
}

/* ---------------- input shaping ---------------- */
const MAX_TURNS = 160, MAX_TEXT = 2000;
const clampDiff = (d) => Math.min(5, Math.max(1, parseInt(d, 10) || 3));
const clean = (s) => String(s ?? "").slice(0, MAX_TEXT).trim();
const num = (v, lo, hi) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null;
};
const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || null;

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

export function cleanTurns(turns) {
  if (!Array.isArray(turns)) return [];
  return turns.slice(-MAX_TURNS).map((t) => ({
    side: ["rep", "them", "director", "note"].includes(t?.side) ? t.side : null,
    text: clean(t?.text),
    cut: !!t?.cut,
    flagged: !!t?.flagged,
    meta: t?.side === "rep" ? cleanMeta(t.meta) : null,
    patience: t?.side === "them" ? num(t.patience, 0, 10) : null,
    objection: t?.side === "them" ? slug(t?.objection) : null,
    tag: t?.side === "them" && t?.tag ? {
      who: t.tag.who === "dm" ? "dm" : "gatekeeper",
      step: num(t.tag.step, 1, 5) ?? 1,
      ev: ["none", "transferred", "booked", "hangup"].includes(t.tag.ev) ? t.tag.ev : "none",
    } : null,
  })).filter((t) => t.side && t.text);
}

// Call transcript -> alternating user/assistant messages that start and end on a user turn.
// The history is append-only so the prompt-cache prefix stays stable turn to turn.
export function toMessages(turns) {
  const out = [{ role: "user", content: "[The phone rings at your practice. You answer it.]" }];
  const push = (role, text) => {
    const last = out[out.length - 1];
    if (last.role === role) last.content += "\n" + text;
    else out.push({ role, content: text });
  };
  let talkedOver = false, lastPat = null;
  for (const t of turns) {
    if (t.side === "rep") {
      const d = deliveryLine(t.meta);
      // "Caller:" keeps roles unmistakable: these are the salesperson's words, never the prospect's.
      push("user", (talkedOver ? "[the caller talked over you]\n" : "") + "Caller: " + t.text + (d ? "\n" + d : ""));
      talkedOver = false;
    } else if (t.side === "them") {
      // Keep the prospect's own control tag in history so its patience carries between turns.
      // A line cut off before its tag arrived goes in untagged; the prompt says to keep the last tag.
      if (t.patience != null) lastPat = t.patience;
      const pat = t.patience ?? lastPat;
      const tag = t.tag ? `\n[[${t.tag.who}|${t.tag.step}|${t.tag.ev}${pat != null ? "|" + pat : ""}|${t.objection || "none"}]]` : "";
      push("assistant", t.text + (t.cut ? " —" : "") + tag);
      talkedOver = t.cut;
    } else {
      push("user", t.text);            // director notes, silence, transfer pickup
    }
  }
  if (out[out.length - 1].role !== "user") push("user", "[silence: the caller says nothing]");
  return out;
}

function errorCode(e) {
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError
    || (e instanceof Anthropic.AnthropicError && !(e instanceof Anthropic.APIError) && /authentication/i.test(e.message))) {
    return { status: 500, code: "not_granted", message: "The server's Anthropic API key is missing or invalid." };
  }
  if (e instanceof Anthropic.RateLimitError) return { status: 429, code: "rate_limited", message: "Rate limited." };
  if (e instanceof Anthropic.APIUserAbortError) return { status: 499, code: "cancelled", message: "Cancelled." };
  if (e instanceof Anthropic.APIError) return { status: 502, code: "upstream", message: e.message };
  return { status: 500, code: "error", message: String(e?.message || e) };
}

/* ---------------- prospect: streamed as NDJSON ---------------- */
app.post("/api/prospect", limit(60), async (req, res) => {
  const sc = findScenario(req.body?.scenarioId);
  if (!sc) return res.status(400).json({ code: "bad_request", message: "Unknown scenario." });
  const who = req.body?.who === "dm" || !sc.gk ? "dm" : "gatekeeper";
  const messages = toMessages(cleanTurns(req.body?.turns));

  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Accel-Buffering", "no");
  const send = (obj) => { if (!res.writableEnded) res.write(JSON.stringify(obj) + "\n"); };

  const t0 = Date.now();
  let firstAt = 0;
  const stream = client.beta.messages.stream({
    model: PROSPECT_MODEL,
    max_tokens: 4000,
    output_config: { effort: PROSPECT_EFFORT },
    ...PROSPECT_THINKING,
    system: prospectSystem(sc, clampDiff(req.body?.diff), who, clean(req.body?.seed).slice(0, 40)),
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
    send({ error: err.code, message: err.message });
  }
  res.end();
});

/* ---------------- grading: structured output ---------------- */
// Structured outputs don't enforce enums, so grades are normalized after parsing.
const Teardown = z.object({
  steps: z.array(z.object({
    n: z.number().int(),
    name: z.string(),
    grade: z.string().describe("one letter: A, B, C, D or F"),
    hit: z.array(z.string()),
    miss: z.array(z.string()),
  })),
  worst: z.object({ said: z.string(), instead: z.string() }),
  fix: z.string(),
  verdict: z.string(),
  delivery: z.string(),
});

app.post("/api/grade", limit(12), async (req, res) => {
  const sc = findScenario(req.body?.scenarioId);
  if (!sc) return res.status(400).json({ code: "bad_request", message: "Unknown scenario." });
  const outcome = ["booked", "hangup", "hungup", "wrapped"].includes(req.body?.outcome) ? req.body.outcome : "hungup";
  const reached = Math.min(5, Math.max(1, parseInt(req.body?.reached, 10) || 1));
  const prompt = gradePrompt({ sc, diff: clampDiff(req.body?.diff), outcome, reached, turns: cleanTurns(req.body?.turns) });

  try {
    const msg = await client.beta.messages.parse({
      model: GRADER_MODEL,
      max_tokens: 16000,
      messages: [{ role: "user", content: prompt }],
      output_config: { format: betaZodOutputFormat(Teardown), effort: GRADER_EFFORT },
      ...FALLBACK,
    });
    const out = msg.parsed_output;
    if (msg.stop_reason === "refusal" || !out) {
      return res.status(502).json({ code: "upstream", message: "Grading didn't come back." });
    }
    // keep only steps the rep reached that carry a real letter grade
    out.steps = out.steps.filter((s) => /^[A-F]/i.test(String(s.grade).trim()) && s.n >= 1 && s.n <= reached);
    for (const s of out.steps) {
      const g = String(s.grade).trim()[0].toUpperCase();
      s.grade = g === "E" ? "F" : g;
    }
    res.json(out);
  } catch (e) {
    const err = errorCode(e);
    console.error("grade:", err.message);
    res.status(err.status).json({ code: err.code, message: err.message });
  }
});

/* ---------------- config ---------------- */
voice = createVoice({ client, elevenKey: ELEVEN_KEY, elevenBase: ELEVEN_BASE, onVercel: ON_VERCEL, port: PORT,
  prospectModel: PROSPECT_MODEL, prospectEffort: PROSPECT_EFFORT, prospectThinking: PROSPECT_THINKING, fallback: FALLBACK,
  toMessages, cleanTurns, cleanMeta, limit, clean, slug, num });
app.use("/api/voice", voice.api);
export const VOICE = voice;

app.get("/api/config", (_req, res) => {
  res.json({ brain: HAS_BRAIN, tts: ELEVEN_KEY ? "elevenlabs" : "browser", voice: voice.enabled ? "agent" : "pipeline" });
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

app.post("/api/tts", limit(240), async (req, res) => {
  if (!ELEVEN_KEY) return res.status(404).json({ code: "no_tts" });
  const sc = findScenario(req.body?.scenarioId);
  const role = ["dm", "gk", "rep"].includes(req.body?.role) ? req.body.role : "gk";
  const text = ttsText(req.body?.text);
  if (!sc || !text) return res.status(400).json({ code: "bad_request" });
  const ctl = new AbortController();
  res.on("close", () => { if (!res.writableFinished) ctl.abort(); });
  const stall = setTimeout(() => ctl.abort(), TTS_TIMEOUT_MS);   // a stalled upstream falls back to browser voice
  try {
    const r = await fetch(`${ELEVEN_BASE}/v1/text-to-speech/${encodeURIComponent(voiceFor(sc, role))}/stream?output_format=mp3_44100_96`, {
      method: "POST",
      signal: ctl.signal,
      headers: { "xi-api-key": ELEVEN_KEY, "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({
        text,
        model_id: ELEVEN_MODEL,
        previous_text: ttsText(req.body?.previous).slice(-300) || undefined,
        voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.3, use_speaker_boost: true, speed: 1.0 },
        apply_text_normalization: "auto",
      }),
    });
    if (!r.ok || !r.body) {
      const detail = await r.text().catch(() => "");
      clearTimeout(stall);
      console.error("tts:", r.status, detail.slice(0, 200));
      return res.status(502).json({ code: "tts_failed" });
    }
    res.setHeader("Content-Type", r.headers.get("content-type") || "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    // A failure mid-stream must fail the response (not end it cleanly), so the browser falls back.
    await pipeline(Readable.fromWeb(r.body), res);
    clearTimeout(stall);
  } catch (e) {
    clearTimeout(stall);
    if (e?.name !== "AbortError") console.error("tts:", e?.message || e);
    if (!res.headersSent) res.status(502).json({ code: "tts_failed" });
    else res.destroy();
  }
});

function voiceFor(sc, role) {
  if (role === "rep") return process.env.ELEVENLABS_VOICE_REP || "pNInz6obpgDQGcFmaJgB";
  const env = process.env[`ELEVENLABS_VOICE_${sc.id.toUpperCase()}_${role.toUpperCase()}`];
  return env || (role === "dm" ? sc.dmVoiceId : sc.gkVoiceId) || "21m00Tcm4TlvDq8ikWAM";
}

/* ---------------- call log: a small JSON file ---------------- */
let callsP = null, writing = Promise.resolve();
function loadCalls() {
  return (callsP ??= readFile(DATA_FILE, "utf8").then(JSON.parse)
    .then((v) => (v && typeof v === "object" && !Array.isArray(v) ? v : Promise.reject(new Error("not a call-log object"))))
    .catch(async (e) => {
    if (e.code === "ENOENT") return {};
    // Unreadable or corrupt: set it aside rather than overwrite it.
    const aside = `${DATA_FILE}.corrupt-${Date.now()}`;
    console.error(`call log ${DATA_FILE} unreadable (${e.message}); moved to ${aside}`);
    await rename(DATA_FILE, aside).catch(() => {});
    return {};
  }));
}
function saveCalls(calls) {
  writing = writing.then(async () => {
    await mkdir(path.dirname(DATA_FILE), { recursive: true });
    const tmp = DATA_FILE + ".tmp";
    await writeFile(tmp, JSON.stringify(calls, null, 1));
    await rename(tmp, DATA_FILE);
  });
  const done = writing;
  writing = writing.catch((e) => console.error("save calls:", e.message));
  return done;
}

app.get("/api/calls", async (_req, res) => {
  const all = Object.values(await loadCalls());
  all.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  // the newest 60, plus everything from the last day and a half so "Today" counts every dial
  const now = Date.now();
  res.json(all.filter((c, i) => i < 60 || now - Date.parse(c.at) < 36 * 3600e3));
});

app.put("/api/calls/:id", async (req, res) => {
  const id = String(req.params.id);
  if (!/^[a-z0-9]{1,32}$/i.test(id)) return res.status(400).json({ code: "bad_request" });
  const b = req.body || {};
  const rec = {
    id,
    at: typeof b.at === "string" ? b.at.slice(0, 40) : new Date().toISOString(),
    sid: /^[a-z0-9-]{1,40}$/.test(b.sid) ? b.sid : "",
    firm: clean(b.firm).slice(0, 80),
    diff: clampDiff(b.diff),
    reached: Math.min(5, Math.max(1, parseInt(b.reached, 10) || 1)),
    outcome: ["booked", "hangup", "hungup", "wrapped"].includes(b.outcome) ? b.outcome : "hungup",
    seconds: Math.max(0, parseInt(b.seconds, 10) || 0),
    peeks: Math.max(0, parseInt(b.peeks, 10) || 0),
    retries: Math.max(0, parseInt(b.retries, 10) || 0),
    grade: /^[ABCDF]$/.test(b.grade) ? b.grade : "",
    fix: clean(b.fix).slice(0, 300),
    // the conversation itself, so a call can be reviewed later (kept short)
    turns: Array.isArray(b.turns) ? b.turns.slice(-80).map((t) => ({
      side: ["rep", "them", "beat"].includes(t?.side) ? t.side : "beat",
      who: t?.who === "dm" ? "dm" : t?.who === "gatekeeper" ? "gatekeeper" : "",
      text: clean(t?.text).slice(0, 600),
      patience: t?.side === "them" ? num(t.patience, 0, 10) : null,
      objection: t?.side === "them" ? slug(t?.objection) : null,
    })).filter((t) => t.text) : [],
  };
  const calls = await loadCalls();
  calls[id] = rec;
  const ids = Object.keys(calls);
  if (ids.length > 2000) {                // keep the file small
    ids.sort((x, y) => String(calls[x].at).localeCompare(String(calls[y].at)));
    ids.slice(0, ids.length - 2000).forEach((k) => delete calls[k]);
  }
  try { await saveCalls(calls); res.json(rec); }
  catch { res.status(500).json({ code: "save_failed" }); }
});

// Vercel runs this module directly (its Express preset looks for src/app.js).
export default app;
