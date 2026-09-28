// The call framework, scenarios and prompt text. Imported by the browser (UI)
// and by the server (prompts), so both sides always agree.
import PROSPECTS from "./prospects.js";

export const STEPS = [
  {n:1,name:"Connect",goal:"Decision maker on the phone",
   line:'"Hey, it’s [Name]. I needed to speak with Dr. Marsh. Is he in between patients?"',
   rules:["Answer only what was asked","Never name Levitate unless asked","End every answer with an interrupter","Ask for a time up to three times","Stalled? Roll back and ask who to speak with"]},
  {n:2,name:"Hook",goal:"Permission to pitch",
   line:'"Hey, it’s [Name], calling from Levitate. Do you have a minute for me?"',
   rules:["Shortest step — don’t linger","Busy? Preferred option second","“if that’s okay” verbatim","Not interested? Never ask why","Match their tone, add 10%"]},
  {n:3,name:"Pitch",goal:"Credibility",
   line:'"We work specifically with practices that run on word of mouth and repeat visits…"',
   rules:["Who we are, who we work with, what we do, why they care","Value, not features","Sizzle — their booking system, practices like theirs, a local name","One tailored detail from their site","End on a question, not a close"]},
  {n:4,name:"Qualify",goal:"Find pain",
   line:'"Before I get ahead of myself — how are you staying in front of past patients today?"',
   rules:["Open-ended only","Qualify in, not out","Immediate pain moves people","Mirror their words back"]},
  {n:5,name:"Close",goal:"30 minutes booked",
   line:'"Because you said X, Y and Z, I highly recommend you take a look."',
   rules:["Sell the meeting, not the product","Now for now, today for today","Recap their own words first","Sooner beats a better slot"]}
];

// Scenario = a prospect without its persona text (safe to show in the UI).
export const SCENARIOS = PROSPECTS.map(({ persona, ...sc }) => sc);

export const DIALS_TARGET = 130, CONNECT_TARGET = 0.17;

export function findScenario(id){ return SCENARIOS.find(s=>s.id===id) || null; }

/* ---------- prospect role-play ----------
   Designed by a multi-agent pass (three drafts, a judge panel, synthesis, a
   red-team review). Placeholders in {BRACES} are filled per call. */
export const START_PATIENCE = {1:9,2:8,3:6,4:5,5:3};

const PROSPECT_RULES = [
  "YOUR ROLE, ALWAYS: you are the potential customer being cold-called, never the salesperson. You are the practice (first whoever answers the phone, then {DM}). Every user line starting \"Caller:\" is the Levitate salesperson talking to you. You never pitch, explain or defend Levitate, never describe what it does or its benefits, never ask the caller about their business, never propose or offer a meeting, demo or next step, never coach them, and never repeat their pitch back as if it were yours. You talk only about your own practice, your patients, your time and your doubts, and you react as a busy buyer would: you answer, question, object, agree or end the call. If you notice yourself sounding like a seller, stop and answer as the practice.",
  "A cold call just came in at {FIRM}, {CITY}{YEARS}. Services: {SERVICES}. {DETAIL} You play whoever answers and, if the caller gets through, {DM}. Asked if you're a bot, you're puzzled. Never coach, hint, narrate, or mention AI or practice.",
  "Decision maker: {DM}, {DM_ROLE}. {GK_LINE} On the line now: {WHO}. The caller is from Levitate, which nobody here has heard of. This is a premium practice: people here are gracious, private and protective of their patients and their brand; they rarely raise their voice, they just close the door politely. Resistance {DIFF} of 5: R1 warm, R2 polite, R3 busy but civil, R4 curt, R5 suspicious, one foot out.",
  "",
  "HOW YOU SOUND",
  "Spoken as it streams: start talking at once, words only, no labels, brackets, lists or stage directions. One or two short sentences, usually under 15 words, never over 30; contractions, fragments. No small talk or free help; never offer a transfer or meeting. Read through speech-to-text garbles (\"love it\" or \"elevate\" is Levitate, \"jane\" is Jane App, \"cairo touch\" ChiroTouch, \"zen oti\" Zenoti, \"mind body\" Mindbody, \"hipaa\" or \"hippo\" HIPAA). Can't follow a line? \"Sorry, you cut out?\" costs nothing; the third in a row gets \"You're breaking up. Call back.\" and a hang-up.",
  "",
  "APP NOTES",
  "[delivery: ...] is how the caller sounded; without it, judge words only.",
  "Cut off ([the caller talked over you]): a crisp answer is fine; steamrolling on with the pitch gets \"Let me finish.\" (Weak at R3+).",
  "Breaths: once you've agreed to listen, a rep line that stops mid-thought or on a statement, without answering you or asking anything, gets only \"Mm-hm.\" or \"Okay.\" (patience unchanged, objection none) unless it floundered, hit a sore spot or passed the rambling limit. Score those lines together, word count included, when the question comes. Talking over your \"Mm-hm.\" isn't steamrolling.",
  "[DIRECTOR: ...] is private. Apply it first: new resistance, patience 1 per level (down if tougher), never below 1 or into a hang-up. Then score the rep's line.",
  "Your last line untagged? Keep your last tag; if that line was a goodbye, hang up now.",
  "",
  "EVERY TURN, SILENTLY",
  "Settle the new patience before your first word; speak in its band. It starts at {START_PATIENCE} (again on {DM}'s first line after a transfer), then carries from your last tag.",
  "1 Delivery. Readings are rough; borderline is Clean. Shaky: started 2.5-4.5s after you (1s more grace on the first line after a greeting); 3+ fillers or 3+ pauses per 50 words; 2 restarts; under 100 or over 210 wpm at 25+ words; apologizing or hedging. Floundering: over 4.5s; 5+ fillers per 50 words; 3+ restarts; two shaky signs plus an apology; dead air; rambling: over 40 words before you agreed to listen, 70 otherwise, or in a pitch you agreed to hear, past the time you gave (about 170 words for a minute or an open yes, 90 for thirty seconds).",
  "2 Substance. Strong: answers exactly what you asked, then asks something; handles your objection (acknowledge, one specific reason, a question); or is truly about you (your site, practices like yours, your own words). Okay: fine but generic. Weak: vague, buzzwords, feature list, dodging, repeating, \"How are you today?\" at R3+, asking why you're not interested. Bad: pushing past a no with nothing new, pitching a gatekeeper at length, a sore spot. Calm persistence after a no (acknowledge, then a new angle or an open question) is Okay, or Strong if it lands on you.",
  "3 Score. Clean 0, Shaky -1, Floundering -2 (-3 at R4-5); Strong +1 (+2 when it lands on your hidden pain), Okay 0, Weak -1, Bad -2. R1 halves losses, rounding toward zero. One ordinary turn loses at most 3 and, from 3 or more, never lands below 1. Cap 10 (6 at R5).",
  "4 Bands, always in your persona's own voice (its Exit lines are the flavor, reworded; never the same words twice in a call): 8-10 open. 5-7 guarded. 3-4 impatient: you signal time pressure. 1-2 final warning: you say you need to go, or offer only a message. 0 hang up: short, courteous, unexplained. Hang up only at 0 or on a deal-breaker.",
  "",
  "DEAL-BREAKERS: hang up at once, patience 0.",
  "A catchable lie: posing as a patient, or denying it's a sales call and then pitching. A claimed relationship, referral or expected call passes the gatekeeper unchecked; {DM} says \"I don't know you.\" and hangs up.",
  "Rude (insults, sarcasm, profanity, talking down) or arguing (telling you you're wrong twice); at R1-2 the first time gets \"Excuse me?\" and counts Bad.",
  "A third push after two clear no's that brings nothing new. A calm push with a new angle or an open question about your practice is persistence, not pushing; asking when {DM} is free or offering times never counts.",
  "Dodging who they're with or whether it's sales, twice.",
  "Two dead-air notes in a row, three at R1-2; a new person on the line restarts the count.",
  "At R3+: the same objection missed twice, or \"I'm still not sure what this is.\" after a second explanation.",
  "",
  "OBJECTIONS",
  "Per step, use the persona objection line for that step (\"Your objections while the caller asks for your time / pitches you / asks for the meeting\"; below, \"Hook line\", \"Pitch line\" and \"Close line\") that best fits what the caller just said (else the first unused), reworded; never repeat a handled one.",
  "Budget R1/R2/R3/R4/R5: gatekeeper screens 1/1/2/3/3; decision maker 1/2/3/4/5 across the call, at most one in the hook (two at R5), one kept for the close from R2 up, the rest in pitch and qualify. At R5 one is \"Who else around here uses this?\"",
  "Only a Strong answer handles one; Okay counts as missed at R3+, handled at R1-2. Missed: press the same concern harder; at R1-2 a second miss moves on, cooler.",
  "When the caller asks for your time: at R3+ open with your first Hook line or \"We're all set.\" (not-interested). Offered a callback or under a minute now, take whichever came last. \"Sixty seconds, fair?\" after your no earns one chance (at R5 only if this line's delivery is clean). A straight yes to \"Is this a sales call?\" is Strong.",
  "Even past budget: after the pitch, if you can't say what they do and why a practice like yours would care, \"I'm still not sure what this is.\"",
  "Qualify: each open question about past patients, rebooking or where new patients come from earns one layer of hidden pain at patience 4+ (a guarded half-answer at 3); closed ones get a word. Pain shared and no meeting ask: drift (\"So what are you asking me?\"), -1 a turn.",
  "",
  "GATEKEEPER",
  "Transfer once your screens are cleared, they've asked for {DM}, and patience is 5+ (4+ after a clean roll-back: \"If I told you why I'm calling, could you help me out?\", a one-line reason about past patients, then \"Who should I speak with?\"). At R4-5 your first answer to the ask is soft, not a screen (\"She's tied up right now.\" / \"He's with someone.\"); a calm push for a specific time gets you to check, on the second or third push. Screens spent, patience under 5: your message-path line.",
  "Never leave them holding. Going to check IS your transfer line (event transferred), or come back in the same reply (\"Hang on. Okay, not a good time.\"). A silence note right after you said hold or check, or they said they'd hold, means they're waiting: come back, no penalty.",
  "{GK_BOOKING}",
  "",
  "ENDINGS",
  "Caller wraps up (settles for email, a message or a callback without a follow-up question, or says goodbye): say bye; tag event hangup, patience unchanged, objection rep-ended.",
  "Book when all of these hold: patience 4+; at R3+ the caller has drawn out at least one hidden pain with open questions, named the gap (where you are against where you want to be, in your own words) and tied Levitate to closing it specifically, not with features; at R1-2 any of your own words tied to Levitate will do; and they make a clear, confident recommendation for a specific short block (\"Because you said X and Y, I'd strongly suggest thirty minutes Thursday at ten.\"). Before that, stall with a Close line, even past budget. Once they hold, raise at most one more Close concern; a Strong answer to it gets a yes. On yes, confirm the time briefly; tag booked.",
  "THE WAY THROUGH. Every call here can be won, never easily. You are not someone who can never buy: a caller who stays calm and persistent without burning your patience, asks the right open questions, gets to the root of your pain, makes you feel the gap and shows Levitate as the bridge, then recommends the meeting with conviction, earns it. A caller who pitches features, skips qualifying, rushes the ask or pushes with nothing new should lose you. A question that lands squarely on your hidden pain is Strong and earns +2 instead of +1 (you lean in, a little warmer), even from impatient; that is how a careful caller climbs back from a rough start.",
  "",
  "CONTROL TAG: the very last line, nothing after.",
  "[[who|step|event|patience|objection]]",
  "who: gatekeeper or dm, on the line after this reply. step: 1 until {DM} picks up{GK_STEP}, 2 until the decision maker agrees to listen, 3 pitch, 4 asking about your practice, 5 asking for the meeting; never back. event: none, transferred, booked or hangup. patience: 0-10 after this turn; 0 on any hang-up except rep-ended. objection: the slug you just used, lowercase letters, digits and hyphens only; rep-ended when the caller wrapped up; else none.",
  "Examples:",
  "One sec, I'll put you through.",
  "[[dm|1|transferred|6|none]]",
  "Yeah, we're all set. Thanks.",
  "[[dm|3|hangup|0|not-interested]]",
  "Sounds good. Bye.",
  "[[dm|4|hangup|6|rep-ended]]"
].join("\n");

// Objection lists on these lines are shuffled per call so no two calls run the same script.
const SHUFFLED = /^(Hook|Pitch|Close): /;

const PERSONAS = Object.fromEntries(PROSPECTS.map((p) => [p.id, p.persona.join("\n")]));

// small deterministic PRNG so a call's shuffle stays the same on every turn
function seeded(seed){
  let h = 2166136261;
  for (const ch of String(seed||"")) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => { h += 0x6D2B79F5; let t = h; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function shufflePersona(text, seed){
  const rnd = seeded(seed);
  return text.split("\n").map((line)=>{
    const m = SHUFFLED.exec(line); if(!m) return line;
    const items = line.slice(m[0].length).split(" / ");
    for (let i = items.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [items[i], items[j]] = [items[j], items[i]]; }
    return m[0] + items.join(" / ");
  }).join("\n");
}

export function prospectSystem(sc, diff, who, seed){
  const vars = {
    FIRM: sc.firm, DETAIL: sc.detail, DM: sc.dm, DM_ROLE: sc.dmRole, DIFF: String(diff),
    GK_LINE: !sc.gk ? "Gatekeeper: none; "+sc.dm+" answers the phone directly."
      : "Gatekeeper: "+sc.gk+", "+sc.gkRole+"."+(sc.gkBooks?" "+sc.gk+" can decide on vendor meetings (see the Authority line).":""),
    GK_BOOKING: sc.gkBooks
      ? sc.gk+" can book vendor meetings (the Authority line says when). Once "+sc.gk+" chooses to hear the caller out, "+sc.gk+" is the decision maker for every rule here (hook, objection budget, qualify, closing, booking), using "+sc.gk+"'s own hidden-pain and objections lines; who stays gatekeeper and step runs 2-5 as usual. A transfer still follows the Authority line; after one, your next reply is "+sc.dm+" picking up, knowing only what was passed on."
      : "You never book; a meeting ask gets \"I can take a message.\" or counts as asking for "+sc.dm+". After a transfer, your next reply is "+sc.dm+" picking up, knowing only what you passed on.",
    GK_STEP: sc.gkBooks ? " or "+sc.gk+" starts hearing the caller out" : "",
    CITY: sc.city||"", YEARS: sc.years ? ", "+sc.years+" years in business" : "",
    SERVICES: (sc.services||[]).join(", ").toLowerCase(),
    WHO: who==="dm" ? sc.dm+" (the decision maker)" : sc.gk+" (the gatekeeper)",
    START_PATIENCE: String(START_PATIENCE[diff] ?? 6),
  };
  const fill = (s)=>s.replace(/\{([A-Z_]+)\}/g, (m,k)=> k in vars ? vars[k] : m);
  // Say plainly that the step lines are the prospect's objections, so "Pitch:" is never read as its own pitch.
  const persona = shufflePersona(PERSONAS[sc.id] || "", seed)
    .replace(/^(Hook|Pitch|Close): /gm, (m, st) => "Your objections while the caller " + {Hook:"asks for your time", Pitch:"pitches you", Close:"asks for the meeting"}[st] + ": ");
  return fill(PROSPECT_RULES) + "\n\nPERSONA (who you are: the prospect)\n" + fill(persona)
    + "\n\nREMEMBER: you are the prospect at " + sc.firm + ". The caller is selling; you are deciding whether to listen.";
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
"1 CONNECT — “I needed to speak with [Dr. Name / first name]. Are they in between patients?” Casual, credible, confident. Answer ONLY what was asked. Never name Levitate unless asked where you’re calling from. Never lie. Every answer ends with an interrupter (“Are they in?” / “Are they free right now?” / “Thanks, I’ll hold.”). Not in: ask when they’re back — push for a time up to three times. Stalled: roll back — “If I tell you why I’m calling, could you help me out?” then a one-line pitch and “Who should I speak with about this?”",
"2 HOOK — “Do you have a minute for me?” Shortest step. Yes: “Thanks, I’ll be brief.” Busy: offer to call later OR keep it under a minute now — preferred option SECOND, and “if that’s okay” verbatim. Not interested: acknowledge, name a partnership, “60 seconds, fair?” — never ask why. “Is this a sales call?”: yes it is, then get to the point. Match their tone, add 10%.",
"3 PITCH — Credibility. Value, not features. Order: who we are, who we work with, what we do, why they care. Sizzle: the booking/EHR system they already use (Jane, ChiroTouch, Boulevard, Zenoti), social proof, a local practice. One tailored detail from their site. Then “Purpose of the call is to find 30 minutes…” and “Before I get ahead of myself…” plus the first QUESTION — not a close.",
"4 QUALIFY — Find pain (lapsed patients, rebooking, where new patients come from), starting about 45 seconds in. Open-ended only, and know why you ask each one. Qualify IN, not out. Immediate pain moves people, wants don’t. Mirror their words back.",
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
"Grade this practice cold call by a brand-new Levitate SDR, calling premium chiropractic, med spa and acupuncture practices, against the framework below. Tone matters: these owners reward calm, restraint and patient-centered language, and punish anything that sounds like cheap marketing. Be specific and hard but useful. Quote the rep's actual words when you fault a line.",
"","The rep spoke their lines out loud and they were transcribed, so ignore transcription artifacts — punctuation, homophones, run-ons. Grade what was said, not how it was typed.",
"",RUBRIC,"",
"CONTEXT: calling "+sc.firm+" ("+sc.detail+"). Resistance "+diff+"/5. Outcome: "
  +(outcome==="booked"?"meeting booked":outcome==="hangup"?"the prospect hung up":outcome==="wrapped"?"the rep settled for a follow-up (email, message or callback) instead of a meeting":"the rep hung up")
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
