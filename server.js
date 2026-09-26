import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { findScenario, prospectSystem, gradePrompt } from "./public/framework.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const PROSPECT_MODEL = process.env.PROSPECT_MODEL || "claude-opus-5";
const GRADER_MODEL = process.env.GRADER_MODEL || "claude-opus-5";
const PROSPECT_EFFORT = process.env.PROSPECT_EFFORT || "low";   // spoken replies: speed over depth
const DATA_FILE = process.env.DATA_FILE || path.join(ROOT, "data", "calls.json");

// Server-side refusal fallback: a declined request is re-run on Anthropic's
// recommended substitute model inside the same call.
const FALLBACK = { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" };

const client = new Anthropic();
const app = express();
app.use(express.json({ limit: "256kb" }));
app.use(express.static(path.join(ROOT, "public")));

/* ---------------- input shaping ---------------- */
const MAX_TURNS = 80, MAX_TEXT = 2000;
const clampDiff = (d) => Math.min(5, Math.max(1, parseInt(d, 10) || 3));
const clean = (s) => String(s ?? "").slice(0, MAX_TEXT).trim();

function cleanTurns(turns) {
  if (!Array.isArray(turns)) return [];
  return turns.slice(-MAX_TURNS).map((t) => ({
    side: ["rep", "them", "director"].includes(t?.side) ? t.side : null,
    text: clean(t?.text),
    cut: !!t?.cut,
    flagged: !!t?.flagged,
  })).filter((t) => t.side && t.text);
}

// Call transcript -> alternating user/assistant messages that start and end on a user turn.
function toMessages(turns) {
  const out = [];
  const push = (role, text) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += "\n" + text;
    else out.push({ role, content: text });
  };
  for (const t of turns.slice(-24)) {
    if (t.side === "rep") push("user", t.text);
    else if (t.side === "them") push("assistant", t.text + (t.cut ? " —" : ""));
    else push("user", t.text);            // director notes
  }
  if (!out.length || out[0].role !== "user") out.unshift({ role: "user", content: "[The rep's call connects. You answer the phone.]" });
  if (out[out.length - 1].role !== "user") push("user", "[The rep says nothing.]");
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

  const stream = client.beta.messages.stream({
    model: PROSPECT_MODEL,
    max_tokens: 4000,
    output_config: { effort: PROSPECT_EFFORT },
    system: prospectSystem(sc, clampDiff(req.body?.diff), who),
    messages,
    ...FALLBACK,
  });
  res.on("close", () => { if (!res.writableFinished) stream.abort(); });
  stream.on("text", (delta) => send({ delta }));

  try {
    const msg = await stream.finalMessage();
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

app.listen(PORT, () => {
  console.log(`The Dial Room is on http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.warn("No ANTHROPIC_API_KEY set — the prospect can't answer until you set one.");
  }
});
