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
  // Without a shared store, call state lives in the running instance. On Vercel that holds while one
  // warm instance serves the call (the usual case for one caller); a shared store makes it certain.
  const warnings = [];
  if (onVercel && STORE_KIND === "memory") warnings.push("call state is held in memory: connect Supabase (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY) or a Blob store (BLOB_READ_WRITE_TOKEN) to share it across instances");
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
            tools: [{ type: "client", name: "dialroom_state", description: "Reports the call's state to the app after each reply. The app calls it; never mention it.",
              // ElevenLabs rejects a tool parameter that has no description.
              expects_response: false, parameters: { type: "object", description: "The call's state after this reply.", required: [], properties: {
                who: { type: "string", description: "Who speaks next: gatekeeper or dm." },
                step: { type: "integer", description: "The rep's current stage, 1-5." },
                event: { type: "string", description: "none, transferred, booked or hangup." },
                patience: { type: "integer", description: "The prospect's remaining patience." },
                objection: { type: "string", description: "The objection just raised, if any." },
              } } }],
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
        patience: t.patience ?? null, objection: t.objection || null, meta: t.meta || null, tag: t.tag || null, at: t.at || null,
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
    const transfer = !!state && (state.pendingEvent === "transferred" || req.body?.transfer === true);
    try {
      const agentId = await ensureAgent();
      const tok = await el(`/v1/convai/conversation/token?agent_id=${encodeURIComponent(agentId)}`);
      if (!state) {
        state = { id: newId(), scenarioId: sc.id, diff, who: sc.open === "dm" ? "dm" : "gatekeeper", step: sc.open === "dm" ? 2 : 1, reached: 1,
          turns: [], notes: [], pendingMeta: null, elUserCount: 0, ended: false, outcome: null, pendingEvent: null, busy: false, inflight: null, partial: null,
          seed: newId(), createdAt: new Date().toISOString(), lastAgentEnd: 0, lastReqAt: 0, lastReplyAt: 0, log: [], sessions: 1 };
        await saveState(state.id, state);
      } else {
        state = (await updateState(state.id, (st) => {           // a live row is only ever changed under compare-and-set
          if (transfer) { st.who = "dm"; st.pendingEvent = null; st.elUserCount = 0; st.partial = null; st.pendingCut = null; }   // the transfer reply may still be committing: its lease stays
          st.sessions = (st.sessions || 0) + 1;
        })) || state;
      }
      const role = state.who === "dm" ? "dm" : "gk";
      res.json({
        callId: state.id, token: tok.token, conversationId: tok.conversation_id || null, who: state.who, transfer,
        overrides: { agent: { firstMessage: "" }, tts: { voiceId: role === "dm" ? sc.dmVoiceId : (sc.gkVoiceId || sc.dmVoiceId) }, asr: { keywords: keywordsFor(sc) } },
        extraBody: { dialroom: { callId: state.id, scenarioId: sc.id, diff: state.diff, who: state.who, seed: state.seed, session: state.sessions } },
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
      else if (kind === "delivery") {                          // matched to its line by text: the reading lands seconds after the line was answered
        const meta = cleanMeta(req.body.meta), text = clean(req.body.text);
        const rep = text ? [...st.turns].reverse().find((t) => t.side === "rep" && norm(t.text) === norm(text)) : null;
        if (rep) rep.meta = meta; else st.pendingMeta = { meta, text, at: Date.now() };
      }
      else if (kind === "correction") {                       // the caller talked over the prospect: keep what was heard
        const said = clean(req.body.text), lastTurn = st.turns.at(-1);
        const cutTo = (t) => { t.cut = true; if (said && said.length < (t.text || "").length) t.text = said; };
        if (st.partial) cutTo(st.partial);                                   // the aborted reply, not a turn yet
        else if (st.busy && st.inflight && lastTurn && lastTurn.side !== "them") st.pendingCut = { text: said, at: Date.now(), reqId: st.inflight.reqId };   // still generating: applied at its commit
        else { const last = [...st.turns].reverse().find((t) => t.side === "them"); if (last && (!said || norm(last.text).startsWith(norm(said)))) cutTo(last); }
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
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
  const isNote = (u) => /^\[[\s\S]*\]$/.test(u);
  const wordsIn = (s) => String(s || "").split(/\s+/).filter(Boolean).length;
  const GATE_MS = (TURN_TIMEOUT_S - 2) * 1000;   // a same-history request sooner than this after we spoke is a replay or a follow-up, never silence
  const RETRY_WAIT_MS = 15000;                   // a re-ask waits for the reply already being generated: a fresh generation would only restart the clock
  const META_TTL_MS = 15000;                     // a delivery reading older than this belongs to no line
  const EMPTY_REPLY = "Sorry, say that again?";  // when the model returns a tag and nothing to say out loud
  const LOG_KEEP = 40;
  const toolCall = (tagObj) => ({ index: 0, id: "call_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), type: "function",
    function: { name: "dialroom_state", arguments: JSON.stringify(tagObj) } });

  // The latest moment we know the prospect was still talking: the browser's end-of-speech note
  // when it has arrived, else our stream end plus a speaking-rate estimate for the line.
  function quietSince(st) {
    const last = [...st.turns].reverse().find((t) => t.side === "them");
    const est = st.lastReplyAt ? st.lastReplyAt + 500 + 400 * wordsIn(last?.text) : 0;
    return Math.max(est, st.lastAgentEnd || 0, st.lastReqAt || 0);
  }
  const lastRepTurn = (st) => [...st.turns].reverse().find((t) => t.side === "rep");
  const tagOf = (turn, st) => ({ who: turn.tag?.who || st.who, step: turn.tag?.step || st.step, event: turn.tag?.ev || "none",
    patience: turn.patience ?? null, objection: turn.objection || "none" });
  // The browser's delivery reading for a line arrives seconds after ElevenLabs has asked us to
  // answer it, so it is matched by text, never by arrival order.
  function takeMeta(st, repText) {
    const pm = st.pendingMeta;
    if (!pm) return null;
    const fresh = Date.now() - (pm.at || 0) < META_TTL_MS;
    const mine = !pm.text || norm(pm.text) === norm(repText);
    if (mine || !fresh) st.pendingMeta = null;
    return mine && fresh ? pm.meta : null;
  }

  // What this request is, read off the recorded turns and the request's own tail. ElevenLabs
  // re-sends the same history for a tool follow-up, a discarded slow reply, a revised
  // transcript and (much later) real silence; only the last of those is the rep's doing.
  const running = (st, reqId) => !!(st.busy && st.inflight && st.inflight.reqId !== reqId && Date.now() - st.inflight.at < 15000);
  function classify(st, ctx) {
    if (ctx.gen && (st.sessions || 1) > ctx.gen) return { decision: "continuation", stale: true };   // a request from a session the browser already closed
    if (st.ended) {                                            // only the closing line itself, dropped and asked for again, is worth repeating
      const lt = st.turns.at(-1);
      const closing = ctx.lastRole === "user" && ctx.n === st.elUserCount && lt?.side === "them" && lt.tag && lt.tag.ev !== "none" && !lt.replayedAt && Date.now() - quietSince(st) < GATE_MS;
      return closing ? { decision: "replay", turn: lt } : { decision: "continuation", ended: true };
    }
    if (ctx.n > st.elUserCount) {
      const fresh = ctx.users.slice(st.elUserCount).filter((u) => u && u !== PICKUP_NOTE);
      const lt = st.turns.at(-1);
      if (fresh.length && fresh.every((u) => /^\[silence/.test(u)) && lt && lt.side === "rep") {   // the browser prodded while the line was still being answered: not the rep's silence
        st.elUserCount = ctx.n;
        return running(st, ctx.reqId) ? { decision: "wait", on: st.inflight.reqId, consumed: true } : { decision: "retry", consumed: true };
      }
      return { decision: "new" };
    }
    const trimmed = ctx.n < st.elUserCount && withdraw(st, ctx);
    const plan = decide(st, ctx);
    if (trimmed) plan.trimmed = true;                          // the correction is kept even when nothing is said
    return plan;
  }
  // A transcript ElevenLabs no longer lists: drop it and whatever answered it.
  function withdraw(st, { n, users, sc }) {
    const keep = new Set(users.map(norm));
    const kept = (t) => t && t.side !== "them" && keep.has(norm(t.text));
    while (st.turns.length) {
      const t = st.turns.at(-1);
      if (t.session && t.session < (st.sessions || 1)) break;   // an earlier session's record is not this session's to withdraw
      if (t.side === "them" ? (st.turns.length === 1 || kept(st.turns.at(-2))) : kept(t)) break;
      if (t.side === "them" && t.tag && t.tag.ev === "transferred") st.pendingEvent = null;   // the transfer it announced goes with it
      st.turns.pop();
    }
    st.elUserCount = n; resync(st, sc);
    return true;
  }
  function decide(st, { users, lastRole, reqId }) {
    const lastTurn = st.turns.at(-1);
    // an empty transcript is the greeting, still owed while it is generating or was aborted
    const answered = lastTurn ? lastTurn.side === "them" : !(st.busy || st.partial);
    const busyElsewhere = running(st, reqId);
    if (lastRole !== "user") {                                 // our own reply or its tool report is the tail: nothing to answer, maybe silence
      if (!lastTurn && !answered && !busyElsewhere) return { decision: "retry" };   // a greeting that never landed
      const quiet = answered ? Date.now() - quietSince(st) : 0;
      return answered && quiet >= GATE_MS ? { decision: "silence", quiet } : { decision: "continuation", quiet };
    }
    const lastUser = users.at(-1) || "";
    const rep = lastRepTurn(st);
    if (lastUser && !isNote(lastUser) && rep && norm(rep.text) !== norm(lastUser)) {
      // a shorter transcript that is a prefix of the line we hold is the speculative cut arriving late: superseded
      if (norm(rep.text).startsWith(norm(lastUser))) return { decision: "continuation", superseded: true };
      return { decision: "revised", rep, answered };
    }
    if (!answered) return busyElsewhere ? { decision: "wait", on: st.inflight.reqId } : { decision: "retry" };
    const quiet = Date.now() - quietSince(st);
    if (quiet < GATE_MS) return !lastTurn ? { decision: "retry" } : !lastTurn.replayedAt ? { decision: "replay", turn: lastTurn } : { decision: "continuation", quiet };
    return { decision: "silence", quiet };
  }
  // Who is on the line and which step the rep is on follow the last tagged reply; recomputed after one is dropped.
  function resync(st, sc) {
    const last = [...st.turns].reverse().find((t) => t.side === "them" && t.tag);
    if (last) { st.who = sc.gk ? last.tag.who : "dm"; st.step = last.tag.step; }
  }

  // Mutate the state for a decision that goes on to generate a reply; false when nothing is written.
  function apply(st, plan, ctx) {
    const { n, users, reqId, now } = ctx;
    const noteTurn = (u) => ({ side: "note", text: u, at: now, reqId, session: st.sessions || 1,
      shown: u === TRANSFER_NOTE ? "" : /^\[silence/.test(u) ? "Dead air — " + (u.match(/(\d+) seconds/)?.[1] || "6") + "s" : u });
    const lastIsNote = () => st.turns.length > 0 && st.turns.at(-1).side === "note";
    if (plan.decision === "new") {
      if (st.partial) {                                        // the barge-in that cut the last reply short
        if (st.partial.text) st.turns.push({ side: "them", who: st.who, text: st.partial.text, cut: true, at: st.partial.at, reqId: st.partial.reqId });
        st.partial = null;
      }
      let repLine = null;
      for (const u of users.slice(st.elUserCount)) {
        if (!u || u === PICKUP_NOTE) continue;                 // the connect note is already the first message
        if (isNote(u)) { if (!(/^\[silence/.test(u) && lastIsNote())) st.turns.push(noteTurn(u)); }
        else repLine = u;
      }
      st.elUserCount = n;
      if (repLine) st.turns.push(...st.notes.splice(0), { side: "rep", text: repLine, meta: takeMeta(st, repLine), at: now, reqId, session: st.sessions || 1 });
      else st.turns.push(...st.notes.splice(0));
    } else if (plan.decision === "revised") {                  // same turn, longer or corrected transcript
      plan.rep.text = users.at(-1); plan.rep.meta = plan.rep.meta || takeMeta(st, plan.rep.text);
      if (plan.answered) {                                     // ElevenLabs never voiced the reply to the old text
        const dropped = st.turns.splice(st.turns.indexOf(plan.rep) + 1);
        if (dropped.some((t) => t.side === "them" && t.tag && t.tag.ev === "transferred")) st.pendingEvent = null;
        resync(st, ctx.sc);
      }
      st.partial = null; st.pendingCut = null;
    } else if (plan.decision === "retry") {
      st.partial = null; st.pendingCut = null;                 // the aborted attempt is superseded by this one
    } else if (plan.decision === "wait") {
      return !!plan.consumed;                                  // nothing of ours to write, unless a browser prod was folded in
    } else if (plan.decision === "replay") {                   // said again, at most once; nothing is generated
      plan.turn.replayedAt = now;
      (st.log ||= []).push({ reqId, at: now, decision: "replay", n, tail: ctx.lastRole, words: wordsIn(plan.turn.text) });
      if (st.log.length > LOG_KEEP) st.log.splice(0, st.log.length - LOG_KEEP);
      return true;
    } else if (plan.decision === "silence") {
      const lastThem = [...st.turns].reverse().find((t) => t.side === "them");
      const before = lastThem ? st.turns[st.turns.indexOf(lastThem) - 1] : null;
      const justAnsweredSilence = before && before.side === "note" && /^\[silence/.test(before.text) && now - (lastThem.at || 0) < TURN_TIMEOUT_S * 1000;
      if (justAnsweredSilence) { plan.decision = "continuation"; return false; }   // one pause, one note
      st.turns.push(...st.notes.splice(0), noteTurn(`[silence: the rep has said nothing for ${Math.max(1, Math.round(plan.quiet / 1000))} seconds]`));
    } else return false;
    st.busy = true; st.lastReqAt = now; st.inflight = { reqId, n, at: now };
    (st.log ||= []).push({ reqId, at: now, decision: plan.decision, n, tail: ctx.lastRole, quietMs: plan.quiet ?? null });
    if (st.log.length > LOG_KEEP) st.log.splice(0, st.log.length - LOG_KEEP);
    return true;
  }

  async function handleTurn(req, res) {
    if (!secret || req.params.secret !== secret) return res.status(404).end();
    const t0 = Date.now(), reqId = newId().slice(-6);
    const body = req.body || {};
    // ElevenLabs delivers the browser's customLlmExtraBody under `elevenlabs_extra_body` (seen in production logs).
    const extra = body.elevenlabs_extra_body ?? body.custom_llm_extra_body ?? body.extra_body ?? null;
    const dr = body.dialroom || extra?.dialroom || null;
    const callId = dr?.callId || "";
    let state = callId ? await loadState(String(callId).slice(0, 40)) : null;
    const toolsOffered = (body.tools || []).some((t) => (t?.function?.name || t?.name) === "dialroom_state");
    // The store can miss (a call started before this store was connected): rebuild the call from the
    // history ElevenLabs sends, where our earlier replies carry their control tags as dialroom_state tool calls.
    const rebuilt = !state && dr?.scenarioId && findScenario(dr.scenarioId) ? rebuildState(dr, body.messages || []) : null;
    if (rebuilt) state = rebuilt;
    if (!state || process.env.LOG_VOICE) {
      // What ElevenLabs actually sends (shape only, first words of each message).
      const shape = { reqId, keys: Object.keys(body), callId: callId || null, found: !!state && !rebuilt, store: STORE_KIND,
        tools: Array.isArray(body.tools) ? body.tools.map((t) => t?.function?.name || t?.name || t?.type) : undefined,
        extra, dyn: body.dynamic_variables ?? null,
        messages: (body.messages || []).map((m) => m.role + (m.tool_calls ? "+tools" : "") + ":" + textOf(m.content).slice(0, 40).replace(/\n/g, " ")) };
      console.log("voice llm request", JSON.stringify(shape).slice(0, 1500));
    }
    if (!state) return res.status(400).json({ error: { message: "unknown call" } });
    const sc = findScenario(state.scenarioId);
    if (!sc) return res.status(400).json({ error: { message: "unknown scenario" } });

    const messages = body.messages || [];
    const lastRole = messages.at(-1)?.role || "";
    const users = messages.filter((m) => m.role === "user").map((m) => textOf(m.content).trim());
    const n = users.length;
    // One line per request, no transcript: enough to replay a call from the log and the state row.
    const line = { reqId, callId: state.id, n, el: state.elUserCount, tail: lastRole, store: STORE_KIND };
    const logTurn = (decision, more = {}) => console.log("voice turn", JSON.stringify({ ...line, decision, totalMs: Date.now() - t0, ...more }));
    const silent = (decision, more) => { logTurn(decision, more); return finish(res, body, "", null, toolsOffered); };
    const gen = parseInt(dr?.session, 10) || 0;
    if (gen && (state.sessions || 1) > gen) return silent("stale", { gen, sessions: state.sessions });   // the browser has moved on to a later session of this call

    const ctx = { n, users, lastRole, reqId, now: t0, sc, gen };
    let plan = null;
    const written = await updateState(state.id, (st) => {
      if (!st.id) Object.assign(st, state);                    // first write for a call rebuilt from the history
      ctx.now = Date.now();
      plan = classify(st, ctx);
      const wrote = apply(st, plan, ctx);
      return wrote || plan.trimmed ? st : false;
    }, { create: true });
    if (written) state = written;

    if (plan.decision === "continuation") return silent(plan.stale ? "stale" : plan.superseded ? "superseded" : plan.ended ? "ended" : "continuation", { quietMs: plan.quiet ?? null });
    if (plan.decision === "replay") {                          // ElevenLabs dropped the reply we already made: say it again, verbatim
      finish(res, body, plan.turn.text, tagOf(plan.turn, state), toolsOffered);
      return logTurn("replay", { words: wordsIn(plan.turn.text) });
    }
    let aborted = false, stream = null;
    res.on("close", () => { if (!res.writableFinished) { aborted = true; stream?.abort(); } });
    if (plan.decision === "wait") {                            // another request is answering this line: wait for it, then say the same thing
      const until = Date.now() + RETRY_WAIT_MS;
      let got = null, on = plan.on;
      while (Date.now() < until && !got && !aborted) {
        await new Promise((r) => setTimeout(r, 250));
        const st = await loadState(state.id);
        if (!st) break;
        if (!st.busy && st.turns.at(-1)?.side === "them") { got = st; break; }
        if (!st.busy || !st.inflight || Date.now() - st.inflight.at >= 15000) break;   // released without an answer, or stuck: take over now
        if (st.inflight.reqId !== on) on = st.inflight.reqId;  // a newer request took the line: wait for that one
      }
      if (aborted) return logTurn("wait", { waitedMs: Date.now() - t0, abortedWhileWaiting: true });
      if (got) {
        const t = got.turns.at(-1);
        finish(res, body, t.text, tagOf(t, got), toolsOffered);
        return logTurn("wait", { waitedMs: Date.now() - t0, replayed: true, words: wordsIn(t.text) });
      }
      let take = null;                                         // take the line over only if nobody newer holds it
      state = (await updateState(state.id, (st) => {
        const now = Date.now(), d = decide(st, { ...ctx, now });
        take = d.decision === "retry" || (d.decision === "wait" && d.on === on) ? { decision: "retry" } : d;
        return apply(st, take, { ...ctx, now }) ? st : false;
      })) || state;
      if (take.decision === "replay") { finish(res, body, take.turn.text, tagOf(take.turn, state), toolsOffered); return logTurn("wait", { waitedMs: Date.now() - t0, replayed: true }); }
      if (take.decision !== "retry") return silent("continuation", { waitedMs: Date.now() - t0, yieldedTo: state.inflight?.reqId || null });
      plan = take;
      logTurn("wait", { waitedMs: Date.now() - t0, tookOver: true });
    }

    // new / revised / retry / silence: ask the prospect.
    stream = client.beta.messages.stream({
      model: prospectModel, max_tokens: 4000, output_config: { effort: prospectEffort }, ...prospectThinking,
      system: prospectSystem(sc, state.diff, state.who, state.seed), messages: toMessages(cleanTurns(state.turns)),
      cache_control: { type: "ephemeral" }, ...fallback,
    });
    if (aborted) stream.abort();

    // Speak everything before the control tag; hold back a lone "[" in case a tag is starting.
    const streaming = body.stream !== false;
    let raw = "", sent = 0, tagSeen = false, firstAt = 0;
    const chunk = (content, done) => {
      if (!streaming) return;
      if (content && !firstAt) firstAt = Date.now();
      const payload = { id: "chatcmpl-" + state.id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "dialroom",
        choices: [{ index: 0, delta: done ? {} : { role: "assistant", content }, finish_reason: done ? "stop" : null }] };
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    if (streaming) {
      res.status(200); res.setHeader("Content-Type", "text/event-stream"); res.setHeader("Cache-Control", "no-store"); res.flushHeaders?.();
      chunk("", false);                                        // bytes on the wire at once: the reply is live while the model thinks
    }
    const feed = () => {
      if (tagSeen) return;
      const at = raw.indexOf("[[");
      const speakable = at >= 0 ? raw.slice(0, at).replace(/\s+$/, "") : raw.replace(/\[$/, "");
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
      if (aborted) console.warn("voice llm abort", JSON.stringify({ reqId, callId: state.id, decision: plan.decision }));
      else console.error("voice llm:", e?.message || e);
      if (!res.writableEnded && !res.headersSent) return res.status(502).json({ error: { message: "reply failed" } });
    }
    const tag = TAG.exec(raw);
    const tagObj = tag ? { who: tag[1].toLowerCase(), step: parseInt(tag[2], 10), event: tag[3].toLowerCase(), patience: tag[4] != null ? parseInt(tag[4], 10) : null, objection: slug(tag[5]) || "none" } : null;
    let fallbackLine = false;
    if (!aborted && !spoken && (!tagObj || tagObj.event === "none")) {   // a tag and nothing to say: the line must not go unanswered
      spoken = EMPTY_REPLY; fallbackLine = true; chunk(spoken, false);
    }
    if (streaming) {
      if (toolsOffered && tagObj) res.write(`data: ${JSON.stringify({ id: "chatcmpl-" + state.id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "dialroom", choices: [{ index: 0, delta: { tool_calls: [toolCall(tagObj)] }, finish_reason: null }] })}\n\n`);
      chunk("", true); res.write("data: [DONE]\n\n"); res.end();
    }
    else finish(res, body, spoken, tagObj, toolsOffered);

    // Record the reply and apply its events, unless a retry took this line over while we were generating.
    const done = Date.now(), whoThen = state.who, sessionThen = state.sessions || 1;
    const stats = { ttftMs: firstAt ? firstAt - t0 : null, totalMs: done - t0, words: wordsIn(spoken), aborted, fallbackLine };
    const partialText = raw.replace(/\[\[[\s\S]*$/, "").trim();
    try {
      await updateState(state.id, (st) => {
        const mine = !!st.inflight && st.inflight.reqId === reqId;
        const entry = (st.log || []).find((l) => l.reqId === reqId);
        if (entry) Object.assign(entry, stats, { superseded: !mine });
        const who = tag ? tag[1].toLowerCase() : st.who;
        const stp = Math.min(5, Math.max(1, tag ? parseInt(tag[2], 10) : st.step));
        let ev = tag ? tag[3].toLowerCase() : "none";
        const pat = tag && tag[4] != null ? Math.min(10, Math.max(0, parseInt(tag[4], 10))) : null;
        const obj = tag ? slug(tag[5]) : null;
        if (!mine) {                                           // the rep's next line took the lease: keep what was said as the cut line it was
          const i = st.turns.findIndex((t, k) => t.side === "rep" && k + 1 < st.turns.length && st.turns[k + 1].side !== "them");
          if (!aborted && spoken && i >= 0) st.turns.splice(i + 1, 0, { side: "them", who: whoThen, text: spoken, cut: true, patience: pat, objection: obj, tag: null, at: done, reqId, session: sessionThen });
          return;
        }
        const moved = (st.sessions || 1) > sessionThen;        // the transfer this reply announced has already happened
        st.busy = false; st.inflight = null;
        const pc = st.pendingCut; st.pendingCut = null;        // a barge-in the browser reported while this reply was still generating
        const cutTo = pc && pc.reqId === reqId && done - pc.at < META_TTL_MS && pc.text && norm(aborted ? partialText : spoken).startsWith(norm(pc.text)) ? pc.text : null;
        if (aborted) { st.partial = { n, text: cutTo || partialText, at: done, reqId }; return; }   // ElevenLabs did not take this reply
        if (ev === "booked" && whoThen !== "dm" && !sc.gkBooks) ev = "none";
        if (ev === "transferred" && (whoThen !== "gatekeeper" || !sc.gk)) ev = "none";
        if (pat === 0 && ev === "none") ev = "hangup";
        if (ev === "hangup" && obj === "rep-ended") ev = "rep-ended";
        if (spoken || ev !== "none") st.turns.push({ side: "them", who: whoThen, text: cutTo && cutTo.length < spoken.length ? cutTo : spoken, cut: !!cutTo, patience: pat,
          objection: ev === "rep-ended" ? null : obj, tag: tag ? { who, step: stp, ev: ev === "rep-ended" ? "hangup" : ev } : null, at: done, reqId, session: sessionThen });
        st.reached = Math.max(st.reached, stp);
        if (moved) return;                                     // who is on the line and the step were reset for the new session
        st.who = sc.gk ? who : "dm"; st.step = stp;
        if (ev === "transferred") st.pendingEvent = "transferred";
        else if (ev !== "none") { st.ended = true; st.outcome = ev === "rep-ended" ? "wrapped" : ev; }
        st.lastReplyAt = done; st.lastAgentEnd = Math.max(st.lastAgentEnd || 0, done);
      });
    } catch (e) { console.error("voice state conflict", JSON.stringify({ reqId, callId: state.id, decision: plan.decision, error: String(e?.message || e) })); }
    logTurn(plan.decision, { ...stats, tag: tagObj });
  }
  // A call as ElevenLabs remembers it: user lines, our replies, and the tags we sent back as tool calls.
  function rebuildState(dr, messages) {
    const sc = findScenario(dr.scenarioId);
    const st = { id: String(dr.callId || newId()).slice(0, 40), scenarioId: sc.id, diff: Math.min(5, Math.max(1, parseInt(dr.diff, 10) || 3)),
      who: dr.who === "dm" || !sc.gk ? "dm" : "gatekeeper", step: dr.who === "dm" || sc.open === "dm" ? 2 : 1, reached: 1,
      turns: [], notes: [], pendingMeta: null, elUserCount: 0, ended: false, outcome: null, pendingEvent: null, busy: false, inflight: null, partial: null,
      seed: String(dr.seed || dr.callId || "x").slice(0, 40), createdAt: new Date().toISOString(), lastAgentEnd: 0, lastReqAt: Date.now(), lastReplyAt: 0, log: [],
      sessions: parseInt(dr.session, 10) || 1, rebuilt: true };
    let users = 0;
    for (const m of messages) {
      if (m.role === "user") {
        users++;
        const u = textOf(m.content).trim();
        if (!u || u === PICKUP_NOTE) continue;
        if (/^\[[\s\S]*\]$/.test(u)) st.turns.push({ side: "note", text: u, shown: u === TRANSFER_NOTE ? "" : u });
        else st.turns.push({ side: "rep", text: u, meta: null });
      } else if (m.role === "assistant") {
        const text = textOf(m.content).trim();
        const tc = (m.tool_calls || []).find((c) => c?.function?.name === "dialroom_state");
        let tag = null;
        if (tc) { try { const a = JSON.parse(tc.function.arguments || "{}"); tag = { who: a.who === "dm" ? "dm" : "gatekeeper", step: Math.min(5, Math.max(1, parseInt(a.step, 10) || st.step)), ev: ["transferred", "booked", "hangup"].includes(a.event) ? a.event : "none", patience: a.patience ?? null, objection: a.objection || null }; } catch { /* ignore */ } }
        if (text || tag) st.turns.push({ side: "them", who: st.who, text, patience: tag?.patience ?? null, objection: tag?.objection || null, tag: tag ? { who: tag.who, step: tag.step, ev: tag.ev } : null });
        if (tag) { st.step = tag.step; st.reached = Math.max(st.reached, tag.step); if (tag.ev === "transferred") st.who = "dm"; else st.who = sc.gk ? tag.who : "dm"; }
      }
    }
    // the last user line is the one we're answering now: leave it for handleTurn
    if (messages.at(-1)?.role === "user") { users--; const last = st.turns.at(-1); if (last && (last.side === "rep" || last.side === "note")) st.turns.pop(); }
    st.elUserCount = users;
    if (dr.who === "dm") st.who = "dm";
    return st;
  }
  function finish(res, body, text, tagObj, toolsOffered) {
    if (body.stream !== false) {
      res.status(200); res.setHeader("Content-Type", "text/event-stream"); res.setHeader("Cache-Control", "no-store");
      const chunk = (delta, fin) => res.write(`data: ${JSON.stringify({ id: "chatcmpl-x", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "dialroom", choices: [{ index: 0, delta, finish_reason: fin || null }] })}\n\n`);
      if (text) chunk({ role: "assistant", content: text });
      if (tagObj && toolsOffered) chunk({ tool_calls: [toolCall(tagObj)] });
      chunk({}, "stop"); res.write("data: [DONE]\n\n"); return res.end();
    }
    res.json({ id: "chatcmpl-x", object: "chat.completion", created: Math.floor(Date.now() / 1000), model: "dialroom",
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
  }
  for (const p of ["/llm/:secret", "/llm/:secret/chat/completions", "/llm/:secret/v1/chat/completions"]) llm.post(p, limit(120), handleTurn);
  llm.get("/llm/:secret/models", (req, res) => { if (req.params.secret !== secret) return res.status(404).end(); res.json({ object: "list", data: [{ id: "dialroom", object: "model" }] }); });

  return { api, llm, enabled, reasons, ttsModel, status };
}
