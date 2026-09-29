// The browser side of a live-voice call: one ElevenLabs session per person on
// the line (a transfer starts a second one), the delivery readings the prospect
// gets, and the silent channel to the server. The SDK is the vendored bundle.

const VAD_ON = 0.5, PAUSE_MS = 700, SR_LAG_MS = 250;
const FILLER = /\b(u+m+|u+h+|uhm|erm|er+|ah+|hmm+|mm+|you know|i mean|kind of|sort of|like,|basically)\b/gi;

export function sdk() { return window.ElevenLabsClient; }

// The SDK is 1 MB, so it loads only when a live call starts.
let sdkP = null;
export function loadSdk() {
  if (window.ElevenLabsClient) return Promise.resolve(window.ElevenLabsClient);
  return (sdkP ??= new Promise((resolve, reject) => {
    const el = document.createElement("script"); el.src = "vendor/elevenlabs-client.js"; el.async = true;
    el.onload = () => (window.ElevenLabsClient ? resolve(window.ElevenLabsClient) : reject(new Error("voice SDK missing")));
    el.onerror = () => { sdkP = null; reject(new Error("voice SDK failed to load")); };
    document.head.appendChild(el);
  }));
}

export async function api(path, body) {
  const r = await fetch("api/voice" + path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.message || "HTTP " + r.status), { code: j.code || "error" });
  return j;
}

// One live session. `on` gets: connected, them(text), rep(text), correction(text), mode(speaking|listening), vad(score), ended(details), error(msg)
export async function openSession({ token, overrides, extraBody, on }) {
  const { Conversation } = sdk();
  const conv = await Conversation.startSession({
    conversationToken: token, connectionType: "webrtc",
    overrides, customLlmExtraBody: extraBody, useWakeLock: false,
    onConnect: () => on.connected && on.connected(),
    onDisconnect: (d) => on.ended && on.ended(d),
    onError: (m) => on.error && on.error(m),
    onMessage: (m) => { if (m.role === "agent") on.them && on.them(m.message); else on.rep && on.rep(m.message); },
    onAgentResponseCorrection: (c) => on.correction && on.correction(c.corrected_agent_response),
    onModeChange: (m) => on.mode && on.mode(m.mode),
    onVadScore: (v) => on.vad && on.vad(v.vadScore),
  });
  return conv;
}

// Measures how the caller sounds from voice activity and the transcript, the way the
// old microphone loop did: latency after the prospect stopped, pauses, pace, fillers.
export function makeMeter() {
  const m = { talking: false, firstAt: 0, lastAt: 0, pauses: 0, agentEnd: 0, barged: false, agentSpeaking: false };
  return {
    agentMode(mode) {
      if (mode === "speaking") m.agentSpeaking = true;
      else { m.agentSpeaking = false; m.agentEnd = Date.now(); }
    },
    vad(score) {
      const now = Date.now();
      if (score >= VAD_ON) {
        if (!m.firstAt) { m.firstAt = now; m.barged = m.agentSpeaking; }
        else if (!m.talking && now - m.lastAt > PAUSE_MS) m.pauses++;
        m.talking = true; m.lastAt = now;
      } else m.talking = false;
    },
    // The transcript landed: turn the readings into the prospect's delivery note and reset.
    take(text) {
      const words = String(text || "").toLowerCase().replace(/[^a-z0-9' ]/g, " ").split(/\s+/).filter(Boolean);
      const fillers = (String(text || "").match(FILLER) || []).map((f) => f.toLowerCase().replace(/,$/, "")).map((f) => (/^[aeiouhmr]+$/.test(f) ? f.replace(/(.)\1+/g, "$1") : f));
      let restarts = 0;
      for (let i = 1; i < words.length; i++) if (words[i] === words[i - 1] && words[i].length <= 4 && !/^(no|very|ha)$/.test(words[i])) restarts++;
      const dur = Math.max(400, (m.lastAt - m.firstAt) + SR_LAG_MS);
      const meta = {
        barged: m.barged,
        startedAfterMs: m.barged || !m.firstAt || !m.agentEnd ? null : Math.max(0, m.firstAt - m.agentEnd),
        fillers, restarts, pauses: m.pauses, words: words.length,
        wpm: words.length >= 4 && m.firstAt ? Math.round(words.length / (dur / 60000)) : null,
      };
      m.firstAt = 0; m.lastAt = 0; m.pauses = 0; m.barged = false; m.talking = false;
      return meta;
    },
    reset() { m.firstAt = 0; m.lastAt = 0; m.pauses = 0; m.barged = false; m.talking = false; },
    speaking() { return m.talking; },
  };
}
