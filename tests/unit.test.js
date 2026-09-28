import { test } from "node:test";
import assert from "node:assert/strict";

process.env.ANTHROPIC_API_KEY ||= "test";
const { toMessages, cleanTurns } = await import("../src/app.js");
const { deliveryLine, prospectSystem, SCENARIOS, gradePrompt } = await import("../public/framework.js");

test("deliveryLine describes how the rep sounded", () => {
  assert.equal(
    deliveryLine({ startedAfterMs: 2400, fillers: ["um", "uh", "um"], restarts: 1, pauses: 2, wpm: 118.3, words: 22 }),
    "[delivery: started 2.4s after you stopped · 3 fillers (um, uh) · 1 restart · 2 pauses mid-sentence · 118 wpm · 22 words]");
  assert.equal(deliveryLine({ barged: true, fillers: [], words: 3 }), "[delivery: started while you were still talking · no fillers · 3 words]");
  assert.equal(deliveryLine({ typed: true }), "");
});

test("prospectSystem fills every placeholder and keeps a call's shuffle stable", () => {
  for (const sc of SCENARIOS) {
    for (const who of ["gatekeeper", "dm"]) {
      const t = prospectSystem(sc, 3, who, "c1");
      assert.equal(t.match(/\{[A-Z_]+\}/g), null, `${sc.id}/${who} has unfilled placeholders`);
      assert.match(t, /\[\[who\|step\|event\|patience\|objection\]\]/);
    }
  }
  const sc = SCENARIOS[0];
  assert.equal(prospectSystem(sc, 3, "gatekeeper", "c1"), prospectSystem(sc, 3, "gatekeeper", "c1"));
  const variants = new Set(["a", "b", "c", "d", "e", "f"].map((s) => prospectSystem(sc, 3, "gatekeeper", s)));
  assert.ok(variants.size > 1, "different calls should shuffle objections differently");
  assert.match(prospectSystem(SCENARIOS.find((s) => !s.gk), 2, "dm", "x"), /Gatekeeper: none/);
});

test("toMessages starts with the connect note, alternates roles and ends on a user turn", () => {
  const m = toMessages(cleanTurns([
    { side: "them", text: "Meridian Spine and Performance, this is Kayla.", tag: { who: "gatekeeper", step: 1, ev: "none" }, patience: 6 },
    { side: "rep", text: "Is Dr. Marsh in?", meta: { startedAfterMs: 800, fillers: [], words: 3 } },
    { side: "them", text: "May I ask", cut: true },
    { side: "rep", text: "It's Sam", meta: { barged: true, fillers: [], words: 2 } },
  ]));
  assert.equal(m[0].content, "[The phone rings at your practice. You answer it.]");
  for (let i = 1; i < m.length; i++) assert.notEqual(m[i].role, m[i - 1].role);
  assert.equal(m.at(-1).role, "user");
  assert.match(m[1].content, /\[\[gatekeeper\|1\|none\|6\|none\]\]$/);
  assert.equal(m[3].content, "May I ask —", "a line cut off before its tag stays untagged");
  assert.match(m[4].content, /^\[the caller talked over you\]\nCaller: It's Sam/);
});

test("missing patience never becomes 0", () => {
  const [t] = cleanTurns([{ side: "them", text: "x", patience: null, objection: "Who's Calling?" }]);
  assert.equal(t.patience, null);
  assert.equal(t.objection, "who-s-calling");
  const m = toMessages(cleanTurns([
    { side: "them", text: "Hi.", tag: { who: "gatekeeper", step: 1, ev: "none" }, patience: 6 },
    { side: "rep", text: "x", meta: { typed: true } },
    { side: "them", text: "Hm.", tag: { who: "gatekeeper", step: 1, ev: "none" }, patience: null },
  ]));
  assert.match(m[3].content, /\[\[gatekeeper\|1\|none\|6\|none\]\]$/, "patience carries forward");
  assert.doesNotMatch(gradePrompt({ sc: SCENARIOS[0], diff: 3, outcome: "hangup", reached: 1,
    turns: cleanTurns([{ side: "them", text: "Hm.", patience: null }]) }), /patience 0/);
});

test("the prospect pool: public contact card fields, unique numbers, sound persona text", async () => {
  const PROSPECTS = (await import("../public/prospects.js")).default;
  assert.ok(PROSPECTS.length >= 24);
  for (const v of ["Chiropractic", "Med spa", "Acupuncture"]) assert.ok(PROSPECTS.filter((p) => p.vertical === v).length >= 8, v);
  assert.equal(new Set(PROSPECTS.map((p) => p.id)).size, PROSPECTS.length, "ids are unique");
  assert.equal(new Set(PROSPECTS.map((p) => p.phone.slice(-4))).size, PROSPECTS.length, "keypad can dial by last four digits");
  for (const p of PROSPECTS) {
    for (const k of ["firm", "city", "phone", "detail", "dm", "dmRole", "dmVoiceId"]) assert.ok(p[k], `${p.id}.${k}`);
    assert.match(p.phone, /^\(\d{3}\) 555-01\d{2}$/, `${p.id} uses a fictional number`);
    assert.ok(p.years === null || Number.isInteger(p.years), `${p.id}.years`);
    assert.ok(Array.isArray(p.services) && p.services.length >= 3, `${p.id}.services`);
    assert.ok(p.open === "dm" ? !p.gk : p.gk && p.gkVoiceId, `${p.id} who answers`);
    const text = p.persona.join("\n");
    assert.equal(p.persona.filter((l) => /^(Hook|Pitch|Close): /.test(l)).length, 3, `${p.id} objection lines`);
    if (p.gkBooks) assert.match(text, /^Authority: /m, `${p.id} says when the office manager decides`);
  }
});

test("the prospect is always the customer, never the seller", () => {
  for (const sc of SCENARIOS) {
    const t = prospectSystem(sc, 3, sc.open, "x");
    assert.match(t, /^YOUR ROLE, ALWAYS: you are the potential customer/);
    assert.doesNotMatch(t, /^(Hook|Pitch|Close): /m, `${sc.id}: objection lines are labeled as the prospect's`);
    assert.match(t, /Your objections while the caller pitches you: /);
  }
  const m = toMessages(cleanTurns([{ side: "rep", text: "Hi, it's Sam from Levitate.", meta: { typed: true } }]));
  assert.equal(m[0].content, "[The phone rings at your practice. You answer it.]\nCaller: Hi, it's Sam from Levitate.");
});

test("an office manager with authority can run the call and book; a receptionist can't", () => {
  const books = SCENARIOS.find((s) => s.gkBooks), screens = SCENARIOS.find((s) => s.gk && !s.gkBooks);
  assert.ok(books && screens);
  const a = prospectSystem(books, 3, "gatekeeper", "x"), b = prospectSystem(screens, 3, "gatekeeper", "x");
  assert.match(a, new RegExp(books.gk + " can book vendor meetings"));
  assert.match(a, new RegExp("step: 1 until .* or " + books.gk + " starts hearing the caller out"));
  assert.match(b, /You never book/);
  assert.match(b, new RegExp(screens.city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
