// The live-voice server routes against the stand-in Claude and ElevenLabs APIs:
// a session, the reply endpoint ElevenLabs calls, state polling, a transfer.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { startMock } from "./e2e/mock-apis.mjs";
import * as store from "../src/store.js";

let mock, base, app, srv, secret, mockUrl;
before(async () => {
  mock = await startMock(0);
  mockUrl = `http://127.0.0.1:${mock.address().port}`;
  Object.assign(process.env, { ANTHROPIC_API_KEY: "test", ANTHROPIC_BASE_URL: mockUrl, ELEVENLABS_API_KEY: "test-key",
    ELEVENLABS_BASE_URL: mockUrl, PUBLIC_URL: "https://dial.example.test", APP_PASSWORD: "", HOST: "127.0.0.1", DATA_FILE: "/tmp/dial-voice-test.json" });
  ({ app } = await import("../src/app.js"));
  srv = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}`;
  secret = createHmac("sha256", "test-key").update("dialroom-custom-llm").digest("hex").slice(0, 40);
});
after(() => { srv?.close(); mock?.close(); });

const post = (p, body) => fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const sse = async (r) => {
  assert.equal(r.status, 200); assert.match(r.headers.get("content-type"), /text\/event-stream/);
  const text = await r.text(), parts = text.split("\n\n").filter(Boolean);
  assert.equal(parts.at(-1), "data: [DONE]");
  return parts.slice(0, -1).map((l) => JSON.parse(l.replace(/^data: /, ""))).map((c) => c.choices[0].delta.content || "").join("");
};

test("voice stack is on with a key, a public https address and a store", async () => {
  const j = await (await fetch(base + "/api/voice/status")).json();
  assert.equal(j.enabled, true, JSON.stringify(j));
  assert.equal((await (await fetch(base + "/api/config")).json()).voice, "agent");
});

test("a call: session, greeting, a rep line with its delivery note, transfer, pickup", async () => {
  const s = await (await post("/api/voice/session", { scenarioId: "meridian", diff: 3 })).json();
  assert.equal(s.token, "tok_test"); assert.equal(s.who, "gatekeeper");
  assert.equal(s.overrides.tts.voiceId, "cgSgspJ2msm6clMCkdW9");
  assert.ok(s.overrides.asr.keywords.includes("Marsh"));
  const llm = (msgs, extra = {}) => post(`/api/voice/llm/${secret}/chat/completions`, { model: "dialroom", stream: true, messages: msgs, dialroom: { callId: s.callId }, ...extra });

  // the pickup cue is not a line of the rep's; the greeting comes back as SSE without its control tag
  let spoken = await sse(await llm([{ role: "system", content: "x" }, { role: "user", content: "[pickup]" }]));
  assert.match(spoken, /this is Kayla/); assert.doesNotMatch(spoken, /\[\[/);
  await new Promise((r) => setTimeout(r, 50));
  let st = await (await fetch(`${base}/api/voice/${s.callId}/state`)).json();
  assert.equal(st.turns.length, 1); assert.equal(st.turns[0].patience, 8); assert.equal(st.step, 1);

  // the browser posts how the rep sounded right as ElevenLabs asks for the reply
  await post(`/api/voice/${s.callId}/note`, { kind: "delivery", meta: { startedAfterMs: 900, fillers: ["um"], restarts: 0, pauses: 1, wpm: 140, words: 9 } });
  spoken = await sse(await llm([{ role: "user", content: "[pickup]" }, { role: "assistant", content: "hi" }, { role: "user", content: "Hey it's Sam, is Dr Marsh in?" }]));
  assert.match(spoken, /what this is regarding/);
  await new Promise((r) => setTimeout(r, 50));
  st = await (await fetch(`${base}/api/voice/${s.callId}/state`)).json();
  const rep = st.turns.find((t) => t.side === "rep");
  assert.equal(rep.text, "Hey it's Sam, is Dr Marsh in?"); assert.equal(rep.meta.fillers[0], "um");
  const log = await (await fetch(`http://127.0.0.1:${mock.address().port}/__log`)).json();
  const last = log.filter((x) => x.body?.messages).at(-1).body.messages.at(-1).content;
  assert.match(last, /Caller: Hey it's Sam/); assert.match(last, /\[delivery: started 0\.9s/);

  // a director note lands before the next line; the gatekeeper transfers
  await post(`/api/voice/${s.callId}/note`, { kind: "director", diff: 4, text: "[DIRECTOR: resistance goes from 3 to 4 of 5 (tougher). Adjust from your next line on.]" });
  spoken = await sse(await llm([{ role: "user", content: "[pickup]" }, { role: "assistant", content: "a" }, { role: "user", content: "Hey" }, { role: "assistant", content: "b" }, { role: "user", content: "It's Sam from Levitate" }]));
  assert.match(spoken, /put you through/);
  await new Promise((r) => setTimeout(r, 50));
  st = await (await fetch(`${base}/api/voice/${s.callId}/state`)).json();
  assert.equal(st.pendingEvent, "transferred"); assert.equal(st.diff, 4);

  // the transfer: a second session on the same call, the doctor's voice, the doctor speaks first
  const s2 = await (await post("/api/voice/session", { scenarioId: "meridian", diff: 3, callId: s.callId })).json();
  assert.equal(s2.callId, s.callId); assert.equal(s2.who, "dm"); assert.equal(s2.transfer, true);
  assert.equal(s2.overrides.tts.voiceId, "iP95p4xoKVk53GoZ742B");
  spoken = await sse(await llm([{ role: "user", content: "[Your front desk just put the Levitate caller through to you. You pick up the phone.]" }]));
  assert.match(spoken, /This is Evan/);
  await new Promise((r) => setTimeout(r, 50));
  st = await (await fetch(`${base}/api/voice/${s.callId}/state`)).json();
  assert.equal(st.who, "dm"); assert.equal(st.pendingEvent, null); assert.equal(st.turns.at(-1).who, "dm");
  assert.ok(!st.turns.some((t) => t.text && /front desk just put/.test(t.text)), "the transfer note is hidden");

  // the wrong secret is a 404; a hung-up call answers with an empty reply
  assert.equal((await post(`/api/voice/llm/nope/chat/completions`, {})).status, 404);
  await post(`/api/voice/${s.callId}/note`, { kind: "hungup" });
  spoken = await sse(await llm([{ role: "user", content: "still there?" }]));
  assert.equal(spoken, "");
});

test("without the store, a call is rebuilt from ElevenLabs' history and the tag rides back as a tool call", async () => {
  const dr = { callId: "vghost", scenarioId: "meridian", diff: 3, who: "gatekeeper", seed: "s" };
  const tools = [{ type: "function", function: { name: "dialroom_state", parameters: {} } }];
  // the extra body arrives the way ElevenLabs really sends it: nested under elevenlabs_extra_body
  const llm = (msgs) => post(`/api/voice/llm/${secret}/chat/completions`, { model: "dialroom", stream: true, messages: msgs, elevenlabs_extra_body: { dialroom: dr }, tools });
  // greeting: no state anywhere, only the extra body
  let r = await llm([{ role: "user", content: "[pickup]" }]);
  let text = await r.text();
  const deltas = text.split("\n\n").map((l) => l.replace(/^data: /, "")).filter((l) => l.startsWith("{")).map((l) => JSON.parse(l).choices[0].delta);
  assert.match(deltas.map((d) => d.content || "").join(""), /this is Kayla/);
  const call = deltas.map((d) => d.tool_calls?.[0]).find(Boolean);
  assert.ok(call, "a dialroom_state tool call is streamed"); assert.equal(call.function.name, "dialroom_state");
  const args = JSON.parse(call.function.arguments);
  assert.equal(args.patience, 8); assert.equal(args.who, "gatekeeper");
  // ElevenLabs reports the tool call back: nothing new is said
  r = await llm([{ role: "user", content: "[pickup]" }, { role: "assistant", content: "hi", tool_calls: [{ id: call.id, type: "function", function: call.function }] }, { role: "tool", tool_call_id: call.id, content: "ok" }]);
  assert.equal(await sse(r), "");
  // next turn on a cold instance: the history carries the tag, the rep line is answered in context
  r = await llm([{ role: "user", content: "[pickup]" }, { role: "assistant", content: "hi", tool_calls: [{ id: call.id, type: "function", function: call.function }] },
    { role: "tool", tool_call_id: call.id, content: "ok" }, { role: "user", content: "It's Sam from Levitate" }]);
  assert.match(await sse(r), /put you through/);
  const log = await (await fetch(`http://127.0.0.1:${mock.address().port}/__log`)).json();
  const msgs = log.filter((x) => x.body?.messages).at(-1).body.messages;
  assert.match(msgs[1].content, /\[\[gatekeeper\|1\|none\|8\|none\]\]$/, "the rebuilt history keeps the earlier tag");
  assert.match(msgs.at(-1).content, /^Caller: It's Sam from Levitate/);
});

/* ---------- what ElevenLabs really does between the rep's lines ---------- */
const TOOLS = [{ type: "function", function: { name: "dialroom_state", parameters: {} } }];
const llmFor = (callId, dr = {}) => (msgs, init = {}) => fetch(base + `/api/voice/llm/${secret}/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ model: "dialroom", stream: true, messages: msgs, dialroom: { callId, ...dr }, tools: TOOLS }), ...init });
const slow = (ms, gap = 15) => fetch(mockUrl + `/__slow?ms=${ms}&gap=${gap}`);
const TRANSFER = "[Your front desk just put the Levitate caller through to you. You pick up the phone.]";
const deltasOf = async (r) => { assert.equal(r.status, 200); const text = await r.text(); assert.match(text, /data: \[DONE\]\s*$/);
  return text.split("\n\n").map((l) => l.replace(/^data: /, "")).filter((l) => l.startsWith("{")).map((l) => JSON.parse(l).choices[0].delta); };
const spokenOf = (d) => d.map((x) => x.content || "").join("");
const toolOf = (d) => d.map((x) => x.tool_calls?.[0]).find(Boolean);
const asHistory = (d) => { const c = toolOf(d); return [{ role: "assistant", content: spokenOf(d), ...(c ? { tool_calls: [{ id: c.id, type: "function", function: c.function }] } : {}) }, ...(c ? [{ role: "tool", tool_call_id: c.id, content: "ok" }] : [])]; };
const mockCalls = async () => (await (await fetch(mockUrl + "/__log")).json()).filter((x) => x.body?.messages).length;
const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));
const stateOf = async (id) => (await fetch(`${base}/api/voice/${id}/state`)).json();
const notesIn = (st) => st.turns.filter((t) => t.side === "note" && /Dead air/.test(t.text));
async function openCall() {
  const s = await (await post("/api/voice/session", { scenarioId: "meridian", diff: 3 })).json();
  const llm = llmFor(s.callId);
  const H = [{ role: "user", content: "[pickup]" }];
  const d = await deltasOf(await llm(H)); await settle();
  return { callId: s.callId, llm, H: [...H, ...asHistory(d)] };
}

test("a re-sent history replays the recorded reply verbatim: no new line, no silence note, no model call", async () => {
  const { callId, llm, H } = await openCall();
  const H2 = [...H, { role: "user", content: "Hey it's Sam, is Dr Marsh in?" }];
  const d1 = await deltasOf(await llm(H2)); await settle();
  assert.match(spokenOf(d1), /what this is regarding/);
  const st1 = await stateOf(callId), calls = await mockCalls();
  const d2 = await deltasOf(await llm(H2));                 // ElevenLabs dropped our reply and asks again, same history
  assert.equal(spokenOf(d2), spokenOf(d1)); assert.equal(toolOf(d2).function.name, "dialroom_state");
  assert.deepEqual(JSON.parse(toolOf(d2).function.arguments).patience, 7);
  assert.equal(await mockCalls(), calls, "the prospect was not asked twice");
  const st2 = await stateOf(callId);
  assert.equal(st2.turns.length, st1.turns.length); assert.equal(notesIn(st2).length, 0);
  const d3 = await deltasOf(await llm(H2));                 // a third identical ask is a follow-up: nothing more to say
  assert.equal(spokenOf(d3), "");
  assert.equal((await stateOf(callId)).turns.length, st1.turns.length);
});

test("a follow-up ending on our own message says nothing and writes nothing", async () => {
  const { callId, llm, H } = await openCall();
  const d = await deltasOf(await llm([...H, { role: "user", content: "Hey it's Sam, is Dr Marsh in?" }])); await settle();
  const H3 = [...H, { role: "user", content: "Hey it's Sam, is Dr Marsh in?" }, { role: "assistant", content: spokenOf(d), tool_calls: [{ id: toolOf(d).id, type: "function", function: toolOf(d).function }] }];
  const rev = (await store.loadState(callId)).rev;
  assert.equal(spokenOf(await deltasOf(await llm(H3))), "");
  assert.equal((await store.loadState(callId)).rev, rev, "no write");
  assert.equal(notesIn(await stateOf(callId)).length, 0);
});

test("real silence is measured, noted once, and answered", async () => {
  const { callId, llm, H } = await openCall();
  const d = await deltasOf(await llm([...H, { role: "user", content: "Hey it's Sam, is Dr Marsh in?" }])); await settle();
  const H3 = [...H, { role: "user", content: "Hey it's Sam, is Dr Marsh in?" }, ...asHistory(d)];
  await store.updateState(callId, (st) => { for (const k of ["lastReplyAt", "lastAgentEnd", "lastReqAt"]) st[k] -= 14000; st.turns.forEach((t) => { t.at -= 14000; }); });
  const hello = await deltasOf(await llm(H3)); await settle();
  assert.match(spokenOf(hello), /Hello\? Anyone there/);
  let st = await stateOf(callId);
  // 14 s since the reply was generated, less the ~3 s it took to say: measured from the end of speech
  assert.equal(notesIn(st).length, 1); assert.match(notesIn(st)[0].text, /^Dead air — 1[0-2]s$/);
  const last = (await (await fetch(mockUrl + "/__log")).json()).filter((x) => x.body?.messages).at(-1).body.messages.at(-1).content;
  assert.match(last, /^\[silence: the rep has said nothing for 1[0-2] seconds\]$/);
  assert.equal(spokenOf(await deltasOf(await llm([...H3, ...asHistory(hello)]))), "", "the follow-up right after is not a second silence");
  st = await stateOf(callId); assert.equal(notesIn(st).length, 1);
});

test("a revised transcript for the same turn replaces the line and is answered once, without a note", async () => {
  const { callId, llm, H } = await openCall();
  await deltasOf(await llm([...H, { role: "user", content: "Hey it's Sam, is Dr" }])); await settle();   // the speculative cut
  const d = await deltasOf(await llm([...H, { role: "user", content: "Hey it's Sam, is Dr Marsh in today?" }])); await settle();
  assert.match(spokenOf(d), /what this is regarding/);
  const st = await stateOf(callId);
  const reps = st.turns.filter((t) => t.side === "rep");
  assert.equal(reps.length, 1); assert.equal(reps[0].text, "Hey it's Sam, is Dr Marsh in today?");
  assert.equal(st.turns.filter((t) => t.side === "them").length, 2); assert.equal(notesIn(st).length, 0);
  const last = (await (await fetch(mockUrl + "/__log")).json()).filter((x) => x.body?.messages).at(-1).body.messages.at(-1).content;
  assert.match(last, /^Caller: Hey it's Sam, is Dr Marsh in today\?/);
});

test("a withdrawn transcript takes its answer with it; the line can come back later", async () => {
  const { callId, llm, H } = await openCall();
  const d = await deltasOf(await llm([...H, { role: "user", content: "Hey it's Sam, is Dr Marsh in?" }])); await settle();
  assert.match(spokenOf(d), /regarding/);
  assert.equal(spokenOf(await deltasOf(await llm(H))), "");                          // ElevenLabs no longer lists the line
  let st = await stateOf(callId); assert.equal(st.turns.length, 1); assert.equal(notesIn(st).length, 0);
  await deltasOf(await llm([...H, { role: "user", content: "Hey it's Sam, is Dr Marsh in?" }])); await settle();
  st = await stateOf(callId); assert.equal(st.turns.filter((t) => t.side === "rep").length, 1); assert.equal(st.turns.length, 3);
});

test("an aborted reply leaves the line unanswered, and the retry answers it without a note", async () => {
  const { callId, llm, H } = await openCall();
  const H2 = [...H, { role: "user", content: "Hey it's Sam, is Dr Marsh in?" }];
  await fetch(mockUrl + "/__slow?ms=900");
  const ctl = new AbortController(); setTimeout(() => ctl.abort(), 250);
  const r = await llm(H2, { signal: ctl.signal });          // headers arrive at once; the body is cut off mid-reply
  await assert.rejects(r.text());
  await settle(400); await fetch(mockUrl + "/__slow?ms=0");
  let st = await store.loadState(callId);
  assert.equal(st.turns.at(-1).side, "rep"); assert.equal(st.busy, false); assert.ok(st.partial, "the abort is remembered");
  const d = await deltasOf(await llm(H2)); await settle();
  assert.match(spokenOf(d), /regarding/);
  st = await stateOf(callId);
  assert.equal(st.turns.filter((t) => t.side === "them").length, 2); assert.equal(notesIn(st).length, 0);
});

test("a reply with a tag and no words gets a spoken fallback", async () => {
  const { callId, llm, H } = await openCall();
  const d = await deltasOf(await llm([...H, { role: "user", content: "tag only please" }])); await settle();
  assert.equal(spokenOf(d), "Sorry, say that again?");
  assert.equal(JSON.parse(toolOf(d).function.arguments).patience, 6);
  const st = await stateOf(callId); assert.equal(st.turns.at(-1).text, "Sorry, say that again?"); assert.equal(st.turns.at(-1).patience, 6);
});

test("a delivery reading lands on the line it measured, however late it arrives", async () => {
  const { callId, llm, H } = await openCall();
  const H2 = [...H, { role: "user", content: "Hey it's Sam, is Dr Marsh in?" }];
  const d = await deltasOf(await llm(H2)); await settle();
  await post(`/api/voice/${callId}/note`, { kind: "delivery", text: "Hey it's Sam, is Dr Marsh in?", meta: { startedAfterMs: 1000, fillers: [], restarts: 0, pauses: 0, wpm: 150, words: 8 } });
  let st = await stateOf(callId);
  assert.equal(st.turns.find((t) => t.side === "rep").meta.wpm, 150, "attached to its own line after the fact");
  // a reading for a line the server has not seen yet waits for that line, and only that line
  await post(`/api/voice/${callId}/note`, { kind: "delivery", text: "It's Sam from Levitate", meta: { startedAfterMs: 500, fillers: ["um"], restarts: 0, pauses: 0, wpm: 120, words: 5 } });
  await deltasOf(await llm([...H2, ...asHistory(d), { role: "user", content: "Something else entirely" }])); await settle();
  st = await stateOf(callId);
  assert.equal(st.turns.filter((t) => t.side === "rep").at(-1).meta, null, "not this line's reading");
  await store.updateState(callId, (s) => { s.pendingMeta.at -= 20000; });
  const d3 = await deltasOf(await llm([...H2, ...asHistory(d), { role: "user", content: "Something else entirely" }, { role: "assistant", content: "x" }, { role: "user", content: "It's Sam from Levitate" }])); await settle();
  assert.match(spokenOf(d3), /put you through/);
  st = await stateOf(callId);
  assert.equal(st.turns.filter((t) => t.side === "rep").at(-1).meta, null, "a stale reading is dropped");
});

test("a second request for a line still being answered waits for that answer and repeats it", async () => {
  const { callId, llm, H } = await openCall();
  const H2 = [...H, { role: "user", content: "Hey it's Sam, is Dr Marsh in?" }];
  await fetch(mockUrl + "/__slow?ms=700");
  const calls = await mockCalls();
  const first = llm(H2); await settle(150);
  const second = llm(H2);
  const [d1, d2] = await Promise.all([first.then(deltasOf), second.then(deltasOf)]);
  await fetch(mockUrl + "/__slow?ms=0"); await settle();
  assert.match(spokenOf(d1), /regarding/); assert.equal(spokenOf(d2), spokenOf(d1));
  assert.equal(await mockCalls(), calls + 1, "one model call for one line");
  const st = await stateOf(callId);
  assert.equal(st.turns.filter((t) => t.side === "them").length, 2); assert.equal(notesIn(st).length, 0);
});

test("every request logs one 'voice turn' line with its decision and no transcript", async () => {
  const lines = []; const orig = console.log; console.log = (...a) => { if (a[0] === "voice turn") lines.push(JSON.parse(a[1])); else orig(...a); };
  try {
    const { callId, llm, H } = await openCall();
    const H2 = [...H, { role: "user", content: "Hey it's Sam, is Dr Marsh in?" }];
    const d = await deltasOf(await llm(H2)); await settle();
    await deltasOf(await llm(H2)); await deltasOf(await llm([...H2, ...asHistory(d)]));
    const st = await store.loadState(callId);
    assert.deepEqual(lines.map((l) => l.decision), ["new", "new", "replay", "continuation"]);
    assert.ok(lines.every((l) => l.callId === callId && typeof l.totalMs === "number" && !/Sam|Marsh/.test(JSON.stringify(l))));
    assert.ok(lines[1].ttftMs >= 0 && lines[1].words > 0);
    const entry = st.log.find((l) => l.reqId === lines[1].reqId);
    assert.equal(entry.decision, "new"); assert.ok(entry.totalMs > 0 && entry.words > 0);
    assert.deepEqual(st.log.map((l) => l.decision), ["new", "new", "replay"], "the row keeps every request that changed it");
    assert.equal(st.turns.at(-1).reqId, lines[1].reqId);
  } finally { console.log = orig; }
});

/* ---------- what the review found ---------- */
const LINE = "Hey it's Sam, is Dr Marsh in?";

test("a lost greeting is still owed: the re-ask regenerates it and no silence is ever charged for it", async () => {
  const sess = await (await post("/api/voice/session", { scenarioId: "meridian", diff: 3 })).json();
  const llm = llmFor(sess.callId), H = [{ role: "user", content: "[pickup]" }];
  await slow(900);
  const ctl = new AbortController(); setTimeout(() => ctl.abort(), 250);
  const r = await llm(H, { signal: ctl.signal }); await assert.rejects(r.text());
  await settle(400); await slow(0);
  let st = await store.loadState(sess.callId);
  assert.equal(st.turns.length, 0); assert.equal(st.busy, false); assert.ok(st.partial, "the abort is remembered");
  await store.updateState(sess.callId, (x) => { x.lastReqAt -= 13000; x.partial.at -= 13000; });   // even a late re-engagement
  const d = await deltasOf(await llm(H)); await settle();
  assert.match(spokenOf(d), /this is Kayla/); assert.ok(toolOf(d));
  st = await stateOf(sess.callId); assert.equal(notesIn(st).length, 0); assert.equal(st.turns.length, 1);
});

test("a request from the session the browser already closed is ignored, and the doctor still picks up", async () => {
  const { callId, llm, H } = await openCall();
  const d = await deltasOf(await llm([...H, { role: "user", content: "It's Sam from Levitate" }])); await settle();
  assert.equal((await stateOf(callId)).pendingEvent, "transferred");
  const s2 = await (await post("/api/voice/session", { scenarioId: "meridian", diff: 3, callId })).json();
  assert.equal(s2.extraBody.dialroom.session, 2);
  // the front-desk session's tool follow-up lands after the reset
  const stale = await deltasOf(await llmFor(callId, { session: 1 })([...H, { role: "user", content: "It's Sam from Levitate" }, ...asHistory(d)]));
  assert.equal(spokenOf(stale), "");
  let st = await stateOf(callId);
  assert.equal(st.turns.filter((t) => t.side === "rep").length, 1); assert.equal(st.who, "dm"); assert.equal(st.turns.length, 3);
  const d2 = await deltasOf(await llmFor(callId, { session: 2 })([{ role: "user", content: TRANSFER }])); await settle();
  assert.match(spokenOf(d2), /This is Evan/);
  st = await stateOf(callId); assert.equal(st.turns.at(-1).who, "dm"); assert.equal(notesIn(st).length, 0);
});

test("a barge-in correction lands on the reply it cut, never on the one before", async () => {
  const { callId, llm, H } = await openCall();
  const H2 = [...H, { role: "user", content: LINE }];
  await slow(300, 100);                                          // deltas 100 ms apart: an abort at 700 ms lands mid-reply
  const ctl = new AbortController(); setTimeout(() => ctl.abort(), 700);
  const r = await llm(H2, { signal: ctl.signal }); await assert.rejects(r.text());
  await settle(300); await slow(0);
  let st = await store.loadState(callId);
  assert.ok(st.partial && st.partial.text.length > 0, "part of the reply was streamed: " + JSON.stringify(st.partial));
  const heard = st.partial.text.split(" ").slice(0, 2).join(" ");
  await post(`/api/voice/${callId}/note`, { kind: "correction", text: heard });
  st = await store.loadState(callId);
  assert.match(st.turns[0].text, /this is Kayla/); assert.ok(!st.turns[0].cut, "the greeting is untouched");
  assert.equal(st.partial.text, heard);
  const d = await deltasOf(await llm([...H2, { role: "assistant", content: heard }, { role: "user", content: "It's Sam from Levitate" }])); await settle();
  assert.match(spokenOf(d), /put you through/);
  st = await stateOf(callId);
  const cutTurn = st.turns.find((t) => t.side === "them" && t.cut);
  assert.equal(cutTurn.text, heard); assert.equal(st.turns.indexOf(cutTurn), 2, "right after the line it answered");
});

test("a correction that arrives while the reply is still generating is applied when that reply is recorded", async () => {
  const { callId, llm, H } = await openCall();
  const H2 = [...H, { role: "user", content: LINE }];
  await slow(300, 60);
  const A = llm(H2); await settle(500);                           // a few deltas in, ElevenLabs reports the cut
  await post(`/api/voice/${callId}/note`, { kind: "correction", text: "Can I ask" });
  const st0 = await store.loadState(callId); assert.ok(st0.pendingCut, "held until the commit"); assert.ok(!st0.turns[0].cut);
  const d = await deltasOf(await A); await settle(); await slow(0);
  assert.match(spokenOf(d), /regarding/);
  const st = await stateOf(callId);
  assert.deepEqual([st.turns.at(-1).cut, st.turns.at(-1).text, st.turns[0].cut], [true, "Can I ask", false]);
});

test("a re-ask waiting on a line whose first attempt was cut off answers at once, not after the full wait", async () => {
  const { callId, llm, H } = await openCall();
  const H2 = [...H, { role: "user", content: LINE }];
  await slow(900);
  const ctlA = new AbortController();
  const A = llm(H2, { signal: ctlA.signal }); await settle(150);
  const t0 = Date.now(); const B = llm(H2);                      // waits on A
  setTimeout(() => ctlA.abort(), 150);
  const rA = await A; await assert.rejects(rA.text());
  await slow(0);
  const d = await deltasOf(await B); const total = Date.now() - t0; await settle();
  assert.match(spokenOf(d), /regarding/); assert.ok(total < 2500, "answered in " + total + " ms");
  const st = await stateOf(callId);
  assert.equal(st.turns.filter((t) => t.side === "them").length, 2); assert.equal(notesIn(st).length, 0);
});

test("a short speculative transcript that arrives after the full one is ignored", async () => {
  const { callId, llm, H } = await openCall();
  const full = "It's Sam calling from Levitate";
  const d = await deltasOf(await llm([...H, { role: "user", content: full }])); await settle();
  assert.match(spokenOf(d), /put you through/);
  const rev = (await store.loadState(callId)).rev;
  assert.equal(spokenOf(await deltasOf(await llm([...H, { role: "user", content: "It's Sam" }]))), "");
  const st = await store.loadState(callId);
  assert.equal(st.rev, rev, "no write"); assert.equal(lastRep(st).text, full); assert.equal(st.pendingEvent, "transferred");
  // and while the full one is still in flight
  const c2 = await openCall();
  await slow(700);
  const F = c2.llm([...c2.H, { role: "user", content: full }]); await settle(150);
  assert.equal(spokenOf(await deltasOf(await c2.llm([...c2.H, { role: "user", content: "It's Sam" }]))), "");
  await slow(0);
  assert.match(spokenOf(await deltasOf(await F)), /put you through/); await settle();
  const st2 = await stateOf(c2.callId);
  assert.equal(lastRep(st2).text, full); assert.equal(st2.turns.filter((t) => t.side === "them").length, 2);
});
const lastRep = (st) => [...st.turns].reverse().find((t) => t.side === "rep");

test("a browser silence prod that lands while the line is still being answered is not charged", async () => {
  const { callId, llm, H } = await openCall();
  const H2 = [...H, { role: "user", content: LINE }];
  await slow(900);
  const A = llm(H2); await settle(150);
  const prod = llm([...H2, { role: "user", content: "[silence: the rep has said nothing for 6 seconds]" }]);
  const [dA, dP] = await Promise.all([A.then(deltasOf), prod.then(deltasOf)]); await settle(); await slow(0);
  assert.match(spokenOf(dA), /regarding/); assert.equal(spokenOf(dP), spokenOf(dA), "the prod hears the same answer");
  const st = await stateOf(callId);
  assert.equal(notesIn(st).length, 0); assert.equal(st.turns.filter((t) => t.side === "them").length, 2);
  assert.equal((await store.loadState(callId)).elUserCount, 3, "the prod was consumed");
});

test("a closing line ElevenLabs dropped is said again; nothing after it is", async () => {
  const { callId, llm, H } = await openCall();
  const line = "um so uh basically we um help law firms";
  await post(`/api/voice/${callId}/note`, { kind: "delivery", text: line, meta: { startedAfterMs: 3000, fillers: ["um", "uh", "um"], restarts: 0, pauses: 0, wpm: 120, words: 8 } });
  const H2 = [...H, { role: "user", content: line }];
  const d = await deltasOf(await llm(H2)); await settle();
  assert.match(spokenOf(d), /stop you there/); assert.equal(JSON.parse(toolOf(d).function.arguments).event, "hangup");
  assert.equal((await stateOf(callId)).ended, true);
  const again = await deltasOf(await llm(H2));
  assert.equal(spokenOf(again), spokenOf(d)); assert.equal(JSON.parse(toolOf(again).function.arguments).event, "hangup");
  assert.equal(spokenOf(await deltasOf(await llm([...H2, ...asHistory(d)]))), "");
  assert.equal(spokenOf(await deltasOf(await llm(H2))), "", "said again once, not forever");
});

test("a reply the rep talked over, that ran to its end anyway, is kept as the cut line it was", async () => {
  const { callId, llm, H } = await openCall();
  const H2 = [...H, { role: "user", content: LINE }];
  await slow(700);
  const A = llm(H2); await settle(200);
  const B = llm([...H2, { role: "assistant", content: "Can I" }, { role: "user", content: "It's Sam from Levitate" }]);
  const [dA, dB] = await Promise.all([A.then(deltasOf), B.then(deltasOf)]); await settle(); await slow(0);
  assert.match(spokenOf(dA), /regarding/); assert.match(spokenOf(dB), /put you through/);
  const st = await stateOf(callId);
  assert.deepEqual(st.turns.map((t) => t.side), ["them", "rep", "them", "rep", "them"]);
  assert.equal(st.turns[2].cut, true); assert.match(st.turns[2].text, /regarding/); assert.equal(st.turns[4].cut, false);
});
