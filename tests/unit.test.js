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
  assert.equal(m[0].content, "[The rep's call connects. You answer the phone.]");
  for (let i = 1; i < m.length; i++) assert.notEqual(m[i].role, m[i - 1].role);
  assert.equal(m.at(-1).role, "user");
  assert.match(m[1].content, /\[\[gatekeeper\|1\|none\|6\|none\]\]$/);
  assert.equal(m[3].content, "May I ask —", "a line cut off before its tag stays untagged");
  assert.match(m[4].content, /^\[the rep talked over you\]\nIt's Sam/);
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
