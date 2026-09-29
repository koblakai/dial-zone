// Live voice calls through ElevenLabs Agents. ElevenLabs runs the ear, the
// turn-taking and the mouth in one audio stream; every reply still comes from
// Claude, through the "custom LLM" endpoint below. The browser starts sessions
// with a token from this server, sends director notes and delivery readings
// here, and polls the call's state (step, patience, hang-up, transfer).
import express from "express";
import { createHmac } from "node:crypto";
import { SCENARIOS, findScenario, prospectSystem } from "../public/framework.js";
import { loadState, saveState, updateState, STORE_KIND } from "./store.js";

const AGENT_NAME = "The Dial Room prospect";
const TURN_TIMEOUT_S = 12;            // ElevenLabs re-engages after this much silence; the browser asks at 6s
const TAG = /\[\[\s*(gatekeeper|dm)\s*\|\s*([1-5])\s*\|\s*(none|transferred|booked|hangup)\s*(?:\|\s*(\d{1,2})?\s*)?(?:\|\s*([^\]|]*?)\s*)?\]\]/i;
export const PICKUP_NOTE = "[pickup]";
export const TRANSFER_NOTE = "[Your front desk just put the Levitate caller through to you. You pick up the phone.]";

export function createVoice({ client, elevenKey, elevenBase, onVercel, port, prospectModel, prospectEffort, prospectThinking, fallback,
  toMessages, cleanTurns, cleanMeta, limit, clean, slug, num }) {
  const publicUrl = (process.env.PUBLIC_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "")).replace(/\/$/, "");
  const ttsModel = process.env.ELEVENLABS_AGENT_TTS_MODEL || "eleven_turbo_v2";   // English agents take turbo v2 or flash v2
  const secret = elevenKey ? createHmac("sha256", elevenKey).update("dialroom-custom-llm").digest("hex").slice(0, 40) : "";
  const llmUrl = publicUrl ? `${publicUrl}/api/voice/llm/${secret}` : "";
  // The live stack needs a public HTTPS address ElevenLabs can call, a key, and shared state on Vercel.
  const reasons = [];
  if (!elevenKey) reasons.push("no ELEVENLABS_API_KEY");
  if (!/^https:\/\//.test(publicUrl)) reasons.push("no public HTTPS address (set PUBLIC_URL)");
  // Without a Blob store, call state lives in the running instance. On Vercel that holds while one
  // warm instance serves the call (the usual case for one caller); a Blob store makes it certain.
  const warnings = [];
  if (onVercel && STORE_KIND !== "blob") warnings.push("call state is held in memory: connect a Blob store (BLOB_READ_WRITE_TOKEN) to make it durable across instances");
  if (process.env.VOICE_STACK === "off") reasons.push("VOICE_STACK=off");
  const enabled = reasons.length === 0;

  const H = { "xi-api-key": elevenKey, "Content-Type": "application/json" };
  const el = async (path, init = {}) => {
    const r = await fetch(`${elevenBase}${path}`, { ...init, headers: { ...H, ...(init.headers || {}) } });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    if (!r.ok) throw Object.assign(new Error(`ElevenLabs ${r.status} ${path}: ${text.slice(0, 200)}`), { status: r.status });
    return json;
  };

  /* ---------- the agent (one for the whole app; voice and names vary per call) ---------- */
  const allNames = [...new Set(["Levitate", ...SCENARIOS.flatMap((s) => [s.dm.replace(/^Dr\.?\s+/, ""), s.gk, s.firm].filter(Boolean))])];
  function agentConfig() {
    return {
      name: AGENT_NAME,
      conversation_config: {
        agent: {
          first_message: "",                       // the browser cues the pickup; the LLM speaks first
          language: "en",
          prompt: {
            prompt: "You are the practice being cold-called. Your replies come from the connected model.",
            llm: "custom-llm",
            custom_llm: { url: llmUrl, model_id: "dialroom", api_type: "chat_completions" },
            temperature: null,
          },
        },
        tts: { model_id: ttsModel, voice_id: SCENARIOS[0].gkVoiceId || SCENARIOS[0].dmVoiceId, stability: 0.5, similarity_boost: 0.8, speed: 1.0 },
        turn: { turn_timeout: TURN_TIMEOUT_S, initial_wait_time: 45, silence_end_call_timeout: 120, turn_eagerness: "normal", speculative_turn: true },
        asr: { provider: "scribe_realtime", quality: "high", keywords: allNames.slice(0, 100) },
        conversation: { client_events: ["conversation_initiation_metadata", "ping", "audio", "interruption", "user_transcript", "agent_response", "agent_response_correction", "vad_score", "agent_tool_response"] },
      },
      platform_settings: {
        auth: { enable_auth: true },               // sessions start only with a token from this server
        overrides: {
          conversation_config_override: { agent: { first_message: true }, tts: { voice_id: true, stability: true, speed: true, similarity_boost: true }, asr: { keywords: true } },
          custom_llm_extra_body: true,
        },
      },
    };
  }
  const cfgHash = () => createHmac("sha256", "cfg").update(JSON.stringify(agentConfig())).digest("hex").slice(0, 12);
  let agentP = null, agentAt = 0;
  function ensureAgent() {
    if (agentP && Date.now() - agentAt < 3600e3) return agentP;
    agentAt = Date.now();
    agentP = (async () => {
      const cfg = agentConfig(), tag = `cfg:${cfgHash()}`;
      const list = await el(`/v1/convai/agents?page_size=100&search=${encodeURIComponent(AGENT_NAME)}`);
      const found = (list?.agents || []).find((a) => a.name === AGENT_NAME);
      if (!found) {
        const made = await el("/v1/convai/agents/create", { method: "POST", body: JSON.stringify({ ...cfg, tags: ["dialroom", tag] }) });
        return made.agent_id;
      }
      if (!(found.tags || []).includes(tag)) {
        await el(`/v1/convai/agents/${found.agent_id}`, { method: "PATCH", body: JSON.stringify({ ...cfg, tags: ["dialroom", tag] }) });
      }
      return found.agent_id;
    })().catch((e) => { agentP = null; throw e; });
    return agentP;
  }

  /* ---------- state helpers ---------- */
  const newId = () => "v" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  function keywordsFor(sc) {
    return [...new Set(["Levitate", sc.dm.replace(/^Dr\.?\s+/, ""), sc.dm.replace(/^Dr\.?\s+/, "").split(" ").pop(), sc.gk, sc.firm.replace(/&/g, "and")].filter(Boolean))];
  }
  function publicState(s) {
    return {
      id: s.id, scenarioId: s.scenarioId, diff: s.diff, who: s.who, step: s.step, reached: s.reached,
      ended: s.ended, outcome: s.outcome || null, pendingEvent: s.pendingEvent || null, busy: !!s.busy, n: s.turns.length,
      turns: s.turns.filter((t) => t.side !== "director").map((t) => ({
        side: t.side, who: t.who || "", text: t.side === "note" ? (t.shown || "") : t.text, cut: !!t.cut, flagged: !!t.flagged,
        patience: t.patience ?? null, objection: t.objection || null, meta: t.meta || null, tag: t.tag || null,
      })),
    };
  }

  /* ---------- routes the browser calls (behind the app password) ---------- */
  const api = express.Router();

  const status = () => ({ enabled, reasons, warnings, store: STORE_KIND, tts: ttsModel });
  api.get("/status", (_req, res) => res.json(status()));

  // Start (or, on a transfer, continue) a call: returns the session token and per-call overrides.
  api.post("/session", limit(30), async (req, res) => {
    if (!enabled) return res.status(503).json({ code: "voice_off", reasons });
    const sc = findScenario(req.body?.scenarioId);
    if (!sc) return res.status(400).json({ code: "bad_request", message: "Unknown scenario." });
    const diff = Math.min(5, Math.max(1, parseInt(req.body?.diff, 10) || 3));
    let state = req.body?.callId ? await loadState(String(req.body.callId).slice(0, 40)) : null;
    const transfer = !!state && state.pendingEvent === "transferred";
    if (!state) {
      state = { id: newId(), scenarioId: sc.id, diff, who: sc.open === "dm" ? "dm" : "gatekeeper", step: sc.open === "dm" ? 2 : 1, reached: 1,
        turns: [], notes: [], pendingMeta: null, elUserCount: 0, ended: false, outcome: null, pendingEvent: null, busy: false,
        seed: newId(), createdAt: new Date().toISOString(), lastAgentEnd: 0 };
    } else if (transfer) {
      state.who = "dm"; state.pendingEvent = null; state.elUserCount = 0; state.busy = false;
    }
    try {
      const agentId = await ensureAgent();
      const tok = await el(`/v1/convai/conversation/token?agent_id=${encodeURIComponent(agentId)}`);
      state.sessions = (state.sessions || 0) + 1;
      await saveState(state.id, state);
      const role = state.who === "dm" ? "dm" : "gk";
      res.json({
        callId: state.id, token: tok.token, conversationId: tok.conversation_id || null, who: state.who, transfer,
        overrides: { agent: { firstMessage: "" }, tts: { voiceId: role === "dm" ? sc.dmVoiceId : (sc.gkVoiceId || sc.dmVoiceId) }, asr: { keywords: keywordsFor(sc) } },
        extraBody: { dialroom: { callId: state.id } },
      });
    } catch (e) {
      console.error("voice session:", e.message);
      const detail = String(e.message || "").replace(/^ElevenLabs \d+ \S+: /, "").slice(0, 160);
      res.status(502).json({ code: "voice_failed", message: e.status === 401 ? "ElevenLabs refused the key: it needs Agents access." : "Couldn't start the voice session: " + detail });
    }
  });

  api.get("/:id/state", async (req, res) => {
    const s = await loadState(String(req.params.id).slice(0, 40));
    if (!s) return res.status(404).json({ code: "not_found" });
    res.setHeader("Cache-Control", "no-store");
    res.json(publicState(s));
  });

  // Silent channel from the browser: director notes, how the rep sounded, what was cut off, flags, the rep hanging up.
  api.post("/:id/note", limit(240), async (req, res) => {
    const kind = String(req.body?.kind || "");
    const s = await updateState(String(req.params.id).slice(0, 40), (st) => {
      if (kind === "director") { st.diff = Math.min(5, Math.max(1, parseInt(req.body.diff, 10) || st.diff)); st.notes.push({ side: "director", text: clean(req.body.text) }); }
      else if (kind === "delivery") st.pendingMeta = cleanMeta(req.body.meta);
      else if (kind === "correction") {                       // the caller talked over the prospect: keep what was heard
        const last = [...st.turns].reverse().find((t) => t.side === "them");
        const said = clean(req.body.text);
        if (last) { last.cut = true; if (said && said.length < last.text.length) last.text = said; }
      }
      else if (kind === "flag") { const last = [...st.turns].reverse().find((t) => t.side === "rep"); if (last) last.flagged = !last.flagged; }
      else if (kind === "hungup") { st.ended = true; st.outcome = st.outcome || "hungup"; }
      else if (kind === "agentEnd") st.lastAgentEnd = Date.now();
    });
    if (!s) return res.status(404).json({ code: "not_found" });
    res.json({ ok: true });
  });

  /* ---------- the endpoint ElevenLabs calls for every reply (no app password: the URL carries a secret) ---------- */
  const llm = express.Router();
  const textOf = (c) => typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (typeof p === "string" ? p : p?.text || "")).join("") : "";

  async function handleTurn(req, res) {
    if (!secret || req.params.secret !== secret) return res.status(404).end();
    const body = req.body || {};
    const callId = body.dialroom?.callId || body.custom_llm_extra_body?.dialroom?.callId || body.extra_body?.dialroom?.callId || "";
    let state = callId ? await loadState(String(callId).slice(0, 40)) : null;
    if (!state) return res.status(400).json({ error: { message: "unknown call" } });
    const sc = findScenario(state.scenarioId);
    if (!sc) return res.status(400).json({ error: { message: "unknown scenario" } });
    if (state.ended) return finish(res, body, "", null);

    // What's new since the last reply: ElevenLabs sends its whole history every time.
    const users = (body.messages || []).filter((m) => m.role === "user").map((m) => textOf(m.content).trim());
    const fresh = users.slice(state.elUserCount);
    state.elUserCount = users.length;
    let repLine = null;
    for (const u of fresh) {
      if (!u) continue;
      if (u === PICKUP_NOTE) continue;                           // the connect note is already the first message
      if (/^\[[\s\S]*\]$/.test(u)) state.turns.push({ side: "note", text: u, shown: u === TRANSFER_NOTE ? "" : /^\[silence/.test(u) ? "Dead air — " + (u.match(/(\d+) seconds/)?.[1] || "6") + "s" : u });
      else repLine = u;
    }
    if (!fresh.length && !repLine) {                             // ElevenLabs re-engaging after silence
      state.turns.push({ side: "note", text: `[silence: the rep has said nothing for ${TURN_TIMEOUT_S} seconds]`, shown: `Dead air — ${TURN_TIMEOUT_S}s` });
    }
    if (repLine) {
      // The delivery reading races this request; give it a moment to land.
      let meta = state.pendingMeta;
      for (let i = 0; !meta && i < 2; i++) { await new Promise((r) => setTimeout(r, 200)); meta = (await loadState(state.id))?.pendingMeta; }
      state.pendingMeta = null;
      state.turns.push(...state.notes.splice(0), { side: "rep", text: repLine, meta: meta || null });
    } else {
      state.turns.push(...state.notes.splice(0));
    }
    state.busy = true;
    await saveState(state.id, state);

    const messages = toMessages(cleanTurns(state.turns));
    const stream = client.beta.messages.stream({
      model: prospectModel, max_tokens: 4000, output_config: { effort: prospectEffort }, ...prospectThinking,
      system: prospectSystem(sc, state.diff, state.who, state.seed), messages,
      cache_control: { type: "ephemeral" }, ...fallback,
    });
    res.on("close", () => { if (!res.writableFinished) stream.abort(); });

    // Speak everything before the control tag; hold back a lone "[" in case a tag is starting.
    const streaming = body.stream !== false;
    let raw = "", sent = 0, tagSeen = false;
    const head = () => { if (!streaming) return; res.status(200); res.setHeader("Content-Type", "text/event-stream"); res.setHeader("Cache-Control", "no-store"); res.flushHeaders?.(); };
    const chunk = (content, done) => {
      if (!streaming) return;
      const payload = { id: "chatcmpl-" + state.id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "dialroom",
        choices: [{ index: 0, delta: done ? {} : { role: "assistant", content }, finish_reason: done ? "stop" : null }] };
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    head();
    const feed = () => {
      if (tagSeen) return;
      const at = raw.indexOf("[[");
      let speakable = at >= 0 ? raw.slice(0, at).replace(/\s+$/, "") : raw.replace(/\[$/, "");
      if (at >= 0) tagSeen = true;
      if (speakable.length > sent) { chunk(speakable.slice(sent), false); sent = speakable.length; }
    };
    stream.on("text", (delta) => { raw += delta; feed(); });
    let spoken = "";
    try {
      const msg = await stream.finalMessage();
      if (msg.stop_reason === "refusal") raw = raw || "Sorry, you cut out?";
      tagSeen = false; feed(); tagSeen = true;
      spoken = raw.replace(/\[\[[\s\S]*$/, "").trim();
    } catch (e) {
      console.error("voice llm:", e?.message || e);
      if (!res.writableEnded && !res.headersSent) return res.status(502).json({ error: { message: "reply failed" } });
    }
    const tag = TAG.exec(raw);
    if (streaming) { chunk("", true); res.write("data: [DONE]\n\n"); res.end(); }
    else finish(res, body, spoken, null);

    // Record the reply and apply its events, merging any notes that arrived meanwhile.
    await updateState(state.id, (st) => {
      st.busy = false;
      const who = tag ? tag[1].toLowerCase() : st.who;
      const stp = Math.min(5, Math.max(1, tag ? parseInt(tag[2], 10) : st.step));
      let ev = tag ? tag[3].toLowerCase() : "none";
      const pat = tag && tag[4] != null ? Math.min(10, Math.max(0, parseInt(tag[4], 10))) : null;
      const obj = tag ? slug(tag[5]) : null;
      if (ev === "booked" && st.who !== "dm" && !sc.gkBooks) ev = "none";
      if (ev === "transferred" && (st.who !== "gatekeeper" || !sc.gk)) ev = "none";
      if (pat === 0 && ev === "none") ev = "hangup";
      if (ev === "hangup" && obj === "rep-ended") ev = "rep-ended";
      if (spoken || ev !== "none") st.turns.push({ side: "them", who: st.who, text: spoken, patience: pat, objection: ev === "rep-ended" ? null : obj,
        tag: tag ? { who, step: stp, ev: ev === "rep-ended" ? "hangup" : ev } : null });
      st.who = sc.gk ? who : "dm"; st.step = stp; st.reached = Math.max(st.reached, stp);
      if (ev === "transferred") st.pendingEvent = "transferred";
      else if (ev !== "none") { st.ended = true; st.outcome = ev === "rep-ended" ? "wrapped" : ev; }
      st.lastAgentEnd = Date.now();
    });
  }
  function finish(res, body, text, _tag) {
    if (body.stream !== false) {
      res.status(200); res.setHeader("Content-Type", "text/event-stream");
      if (text) res.write(`data: ${JSON.stringify({ id: "chatcmpl-x", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "dialroom", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: "chatcmpl-x", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "dialroom", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.write("data: [DONE]\n\n"); return res.end();
    }
    res.json({ id: "chatcmpl-x", object: "chat.completion", created: Math.floor(Date.now() / 1000), model: "dialroom",
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
  }
  for (const p of ["/llm/:secret", "/llm/:secret/chat/completions", "/llm/:secret/v1/chat/completions"]) llm.post(p, limit(120), handleTurn);
  llm.get("/llm/:secret/models", (req, res) => { if (req.params.secret !== secret) return res.status(404).end(); res.json({ object: "list", data: [{ id: "dialroom", object: "model" }] }); });

  return { api, llm, enabled, reasons, ttsModel, status };
}
