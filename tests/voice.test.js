// The live-voice server routes against the stand-in Claude and ElevenLabs APIs:
// a session, the reply endpoint ElevenLabs calls, state polling, a transfer.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { startMock } from "./e2e/mock-apis.mjs";

let mock, base, app, srv, secret;
before(async () => {
  mock = await startMock(0);
  const mockUrl = `http://127.0.0.1:${mock.address().port}`;
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
  const llm = (msgs) => post(`/api/voice/llm/${secret}/chat/completions`, { model: "dialroom", stream: true, messages: msgs, dialroom: dr, tools });
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
