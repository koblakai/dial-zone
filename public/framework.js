// The call framework, scenarios and prompt text. Imported by the browser (UI)
// and by the server (prompts), so both sides always agree.

export const STEPS = [
  {n:1,name:"Connect",goal:"Decision maker on the phone",
   line:'"Hey, it’s [Name]. I needed to speak with Lindsay. Is she around?"',
   rules:["Answer only what was asked","Never name Levitate unless asked","End every answer with an interrupter","Ask for a time up to three times","Stalled? Roll back and ask who to speak with"]},
  {n:2,name:"Hook",goal:"Permission to pitch",
   line:'"Hey, it’s [Name], calling from Levitate. Do you have a minute for me?"',
   rules:["Shortest step — don’t linger","Busy? Preferred option second","“if that’s okay” verbatim","Not interested? Never ask why","Match their tone, add 10%"]},
  {n:3,name:"Pitch",goal:"Credibility",
   line:'"We work specifically with firms that run on word of mouth…"',
   rules:["Who we are, who we work with, what we do, why they care","Value, not features","Sizzle — Clio, MyCase, social proof","One tailored detail from their site","End on a question, not a close"]},
  {n:4,name:"Qualify",goal:"Find pain",
   line:'"Before I get ahead of myself — how are you staying in front of past clients today?"',
   rules:["Open-ended only","Qualify in, not out","Immediate pain moves people","Mirror their words back"]},
  {n:5,name:"Close",goal:"30 minutes booked",
   line:'"Because you said X, Y and Z, I highly recommend you take a look."',
   rules:["Sell the meeting, not the product","Now for now, today for today","Recap their own words first","Sooner beats a better slot"]}
];

export const SCENARIOS = [
  {id:"harlow",firm:"Harlow & Pierce",detail:"6 attorneys, family law, Durham. Site says they treat every client like family.",
   dm:"Lindsay Harlow",dmRole:"managing partner",dmVoice:"f",gk:"Dana",gkRole:"front desk",gkVoice:"f",open:"gatekeeper",tag:"Gatekeeper",
   gkVoiceId:"EXAVITQu4vr4xnSDxMaL",dmVoiceId:"XrExE9yKIg1WjnnlVkGX"},
  {id:"okafor",firm:"Okafor Injury Law",detail:"Solo personal-injury attorney, 22 years in Raleigh, runs on referrals.",
   dm:"Sam Okafor",dmRole:"owner",dmVoice:"m",gk:"Renee",gkRole:"paralegal who screens hard",gkVoice:"f",open:"gatekeeper",tag:"Hard screen",
   gkVoiceId:"cgSgspJ2msm6clMCkdW9",dmVoiceId:"nPczCjzI2devNBz1zQrb"},
  {id:"castellan",firm:"Castellan Estate Group",detail:"14 attorneys, estate planning, Cary. High-touch clients, long relationships.",
   dm:"Ruth Castellan",dmRole:"founding partner",dmVoice:"f",gk:"Marcus",gkRole:"office manager",gkVoice:"m",open:"gatekeeper",tag:"Bigger firm",
   gkVoiceId:"cjVigY5qzO86Huf0OWal",dmVoiceId:"21m00Tcm4TlvDq8ikWAM"},
  {id:"brandt",firm:"Brandt & Vo",detail:"4 attorneys, business formation, Chapel Hill. Partner answers his own phone.",
   dm:"Teddy Brandt",dmRole:"partner",dmVoice:"m",gk:"",gkRole:"",gkVoice:"",open:"dm",tag:"Straight to the DM",
   gkVoiceId:"",dmVoiceId:"iP95p4xoKVk53GoZ742B"}
];

export const DIALS_TARGET = 130, CONNECT_TARGET = 0.17;

export function findScenario(id){ return SCENARIOS.find(s=>s.id===id) || null; }

/* ---------- prospect role-play ---------- */
export function prospectSystem(sc, diff, who){
  return [
"You are role-playing the person on the other end of a cold call so a sales rep can practice out loud. You are on a phone call. Stay in character always. Never coach, never narrate, never mention being an AI.",
"",
"THE CALL",
"Firm: "+sc.firm+" — "+sc.detail,
"Decision maker: "+sc.dm+", "+sc.dmRole+".",
sc.gk?("Gatekeeper: "+sc.gk+", "+sc.gkRole+"."):"There is no gatekeeper — the decision maker answers the phone directly.",
"The rep is an SDR at Levitate, which sells software that helps firms running on word of mouth stay in touch with past clients. It integrates with Clio and MyCase. Neither character has heard of it.",
"RESISTANCE: "+diff+" of 5. 1 friendly and easily won. 3 busy but civil. 5 curt, suspicious, one foot out of the call.",
"You are currently the "+(who==="dm"?"DECISION MAKER":"GATEKEEPER")+".",
"",
"HOW TO TALK",
"- This is SPOKEN and latency-sensitive; begin your answer immediately. One or two sentences, max about 30 words. Contractions. Real phone speech.",
"- No stage directions, no asterisks, no narration, no emoji. Only words said out loud.",
"- The rep's words come from live speech-to-text, so they may be garbled or missing punctuation. Read through it. If it is truly incoherent, react like a real person: “Sorry, say again?”",
"- Make the rep earn every stage. Do not be helpful for free.",
"- At resistance 3+, use what people really say: what's this regarding, who are you with, send me an email, we're all set, is this a sales call, I'm with a client right now.",
"- Never offer to transfer on your own and never propose a meeting yourself. Only agree to a meeting if the rep asks for a specific short block of time AND ties it to something you actually said.",
"- Let the call fail when the rep is bad. Hang up if they are rude, dishonest, or floundering badly at resistance 4-5.",
"- Lines in square brackets from DIRECTOR are private instructions from the practice app, not words the rep said.",
"",
"THE FIVE STAGES the rep is working through: 1 CONNECT (get the decision maker on the phone) · 2 HOOK (permission to pitch) · 3 PITCH (credibility) · 4 QUALIFY (find pain) · 5 CLOSE (book 30 minutes).",
"",
"FORMAT — follow exactly:",
"Write ONLY the words your character says out loud. Then, on the very last line, a control tag and nothing after it:",
"[[who|step|event]]",
"who = gatekeeper or dm (who is speaking AFTER this reply) · step = 1-5 (the stage the rep is on now) · event = none, transferred, booked, or hangup.",
"Example:",
"She's with a client right now. What's this regarding?",
"[[gatekeeper|1|none]]"
  ].join("\n");
}

// How the rep sounded, as the prospect heard it.
export function deliveryLine(m) {
  if (!m || m.typed) return "";
  const parts = [];
  if (m.barged) parts.push("started while you were still talking");
  else if (m.startedAfterMs != null) parts.push(`started ${(m.startedAfterMs / 1000).toFixed(1)}s after you stopped`);
  const f = m.fillers || [];
  parts.push(f.length ? `${f.length} filler${f.length > 1 ? "s" : ""} (${[...new Set(f)].join(", ")})` : "no fillers");
  if (m.restarts) parts.push(`${m.restarts} restart${m.restarts > 1 ? "s" : ""}`);
  if (m.pauses) parts.push(`${m.pauses} pause${m.pauses > 1 ? "s" : ""} mid-sentence`);
  if (m.wpm) parts.push(`${Math.round(m.wpm)} wpm`);
  if (m.words != null) parts.push(`${m.words} words`);
  return `[delivery: ${parts.join(" · ")}]`;
}

/* ---------- grading ---------- */
export const RUBRIC = [
"THE FIVE STEPS AND THEIR RULES",
"1 CONNECT — “I needed to speak with [first name]. Is she around?” Casual, credible, confident. Answer ONLY what was asked. Never name Levitate unless asked where you’re calling from. Never lie. Every answer ends with an interrupter (“Is she in?” / “Is she free right now?” / “Thanks, I’ll hold.”). Not in: ask when she’s back — push for a time up to three times. Stalled: roll back — “If I tell you why I’m calling, could you help me out?” then a one-line pitch and “Who should I speak with about this?”",
"2 HOOK — “Do you have a minute for me?” Shortest step. Yes: “Thanks, I’ll be brief.” Busy: offer to call later OR keep it under a minute now — preferred option SECOND, and “if that’s okay” verbatim. Not interested: acknowledge, name a partnership, “60 seconds, fair?” — never ask why. “Is this a sales call?”: yes it is, then get to the point. Match their tone, add 10%.",
"3 PITCH — Credibility. Value, not features. Order: who we are, who we work with, what we do, why they care. Sizzle: an integration (Clio, MyCase), social proof, a local client. One tailored detail from their site. Then “Purpose of the call is to find 30 minutes…” and “Before I get ahead of myself…” plus the first QUESTION — not a close.",
"4 QUALIFY — Find pain, starting about 45 seconds in. Open-ended only, and know why you ask each one. Qualify IN, not out. Immediate pain moves people, wants don’t. Mirror their words back.",
"5 CLOSE — 30 minutes on the calendar. Selling the meeting, not the product. “Because you said X, Y and Z, I highly recommend you take a look.” Now for now, today for today."
].join("\n");

export function gradePrompt({sc, diff, outcome, reached, turns}){
  const lines = turns.map(t=>{
    if(t.side==="rep"){ const d=deliveryLine(t.meta); return "REP: "+t.text+(d?"\n     "+d:""); }
    if(t.side==="them") return "THEM: "+t.text+(t.cut?" [cut off]":"")
      +(t.patience!=null||t.objection?"   {patience "+(t.patience??"?")+"/10"+(t.objection&&t.objection!=="none"?", objection: "+t.objection:"")+"}":"");
    return t.text;
  }).join("\n");
  const flagged = turns.filter(t=>t.side==="rep"&&t.flagged).map(t=>t.text);
  return [
"Grade this practice cold call by a brand-new Levitate SDR against the framework below. Be specific and hard but useful. Quote the rep's actual words when you fault a line.",
"","The rep spoke their lines out loud and they were transcribed, so ignore transcription artifacts — punctuation, homophones, run-ons. Grade what was said, not how it was typed.",
"",RUBRIC,"",
"CONTEXT: calling "+sc.firm+" ("+sc.detail+"). Resistance "+diff+"/5. Outcome: "
  +(outcome==="booked"?"meeting booked":outcome==="hangup"?"the prospect hung up":"the rep hung up")
  +". Reached step "+reached+".",
flagged.length?("The rep flagged these of their own lines for review: "+flagged.join(" | ")):"",
"","THE CALL","---",lines,"---","",
"Grade only the steps the rep actually reached. For each: a letter grade A-F, up to three short phrases for what they hit and what they missed.",
"worst.said = the rep's single weakest exact line; worst.instead = the line they should have said, in the framework's voice.",
"fix = the one thing to change next call, under 20 words. verdict = one sentence, under 20 words.",
"delivery = one or two sentences on how the rep SOUNDED, from the [delivery: …] measurements (response latency, fillers, restarts, pauses, pace) and where hesitation cost them patience. If there are no delivery measurements, say it was a typed call.",
"The {patience n/10} after each prospect line is the prospect's remaining patience; use drops to pinpoint which rep lines hurt."
  ].join("\n");
}
