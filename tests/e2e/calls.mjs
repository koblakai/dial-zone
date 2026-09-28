// Drives full calls in headless Chromium with a scripted microphone (fake-mic.js)
// against the app running on top of the mock APIs.
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
const FAKE_MIC = fileURLToPath(new URL("./fake-mic.js", import.meta.url));

export async function runCalls({ mode, appUrl, mockUrl, executablePath, log: verbose = false }){
const b=await chromium.launch({executablePath,args:["--autoplay-policy=no-user-gesture-required"]});
const p=await b.newPage({viewport:{width:1280,height:860}});
const errs=[]; p.on("pageerror",e=>errs.push("PAGEERR "+e.message)); p.on("console",m=>{ if(m.type()==="error"&&!/fonts|ERR_CERT|favicon/.test(m.text())) errs.push("CONSOLE "+m.text()); });
if(mode!=="premium") await p.addInitScript("window.__FAKE_TTS=true");
await p.addInitScript({path:FAKE_MIC});
await fetch(mockUrl+"/__reset");
const stage=()=>p.$eval("#stage",e=>e.innerText);
const state=()=>p.$eval("#stateTxt",e=>e.textContent);
const waitText=async(re,ms=20000)=>{ const t0=Date.now(); while(Date.now()-t0<ms){ if(re.test(await stage())) return true; await p.waitForTimeout(120);} throw new Error("timeout waiting for "+re+"\nSTAGE:\n"+await stage()); };
const waitListening=async(ms=20000)=>{ const t0=Date.now(); while(Date.now()-t0<ms){ if(/Your turn/.test(await state())) return; await p.waitForTimeout(100);} throw new Error("never listening; state="+await state()); };
const count=async(re)=>((await stage()).match(re)||[]).length;
let pass=0, fail=0; const ok=(c,m)=>{ if(c){pass++; console.log(`[${mode}] PASS ${m}`);} else {fail++; console.log(`[${mode}] FAIL ${m}`);} };
try{
  await p.goto(appUrl);
  await p.waitForTimeout(600);
  await p.click("button.go");
  await waitText(/Meridian Spine and Performance, this is Kayla/i);
  ok(true,"ring + pickup");
  if(mode!=="premium"){
    // the mic hears their greeting while it plays; the final lands ~0.9 s after it ends (fake TTS ~2.7 s)
    await p.evaluate(()=>__echoStream("Meridian Spine and Performance this is Kayla how can I help you".split(" "),220,3600));
  }
  if(mode==="premium"){
    await waitListening();
    // late final: Chrome marks the result final 1.6 s after the last word (after end of turn)
    await p.evaluate(()=>__speak("Hey it's Sam I needed to speak with Dr Marsh is he in between patients".split(" "),120,1600));
    await waitText(/what this is regarding/);
    await p.waitForTimeout(2500);
    ok(await count(/I needed to speak with Dr Marsh/g)===1, "late final does not duplicate the rep line (count="+await count(/I needed to speak with Dr Marsh/g)+")");
    ok((await p.evaluate(()=>window.__sessions))>=2, "unfinished words at end of turn restart the recognition session");
    await waitListening();
    await p.evaluate(()=>__speak("It's Sam calling from Levitate".split(" "),[120,650,120,120,120]));
    await waitText(/put you through/);
    ok(!/Go on/.test(await stage()),"mid-sentence pause: no stray speculative reply");
    // retry while the transfer line plays: transfer must be cancelled
    await p.keyboard.press("r");
    await p.waitForTimeout(4500);
    const s1=await stage();
    ok(/Take two/i.test(s1) && !/Dr. Evan Marsh picks up/i.test(s1), "retry during transfer cancels it");
    await waitListening();
    await p.evaluate(()=>__speak("It's Sam calling from Levitate".split(" "),120));
    await waitText(/This is Evan/,25000);
    ok(!/put the Levitate caller through/.test(await stage()),"transfer note hidden from live transcript");
    await waitListening();
    await p.waitForTimeout(2200);
    await p.evaluate(()=>__speak("um so uh basically we um help law firms".split(" "),[150,900,150,150,150,150,150,150,150]));
    await waitText(/hung up on you/i,25000);
    ok(true,"hesitant rep -> hang up");
    // grade, then leave before it would matter
    await p.click("text=Grade this call");
    await p.waitForSelector(".delivery",{timeout:10000});
    ok(true,"teardown renders");
      } else {
    await waitListening();
    await p.waitForTimeout(2600);
    ok(!/YOU\s*\n\s*Meridian Spine/i.test(await stage()),"late echo of the prospect is ignored");
    await waitText(/Anyone there/,15000);
    ok(/DEAD AIR/i.test(await stage()),"dead air -> 'Hello? Anyone there?'");
    // B cuts them off and dead air re-arms
    await p.waitForTimeout(150);
    await p.keyboard.press("b");
    await p.waitForTimeout(400);
    ok(/Your turn/.test(await state()),"after B: back to listening (state="+await state()+")");
    await p.waitForTimeout(6800);
    ok((await count(/DEAD AIR/gi))>=2,"dead air re-arms after B");
    // typing capitals in the box must not fire shortcuts
    await p.keyboard.press("m");                        // mute -> typing box shown, focus NOT stolen
    await p.waitForTimeout(200);
    ok(await p.evaluate(()=>document.activeElement?.id!=="say"),"muting doesn't move focus into the text box");
    await p.click("#say");
    await p.keyboard.type("Xavier? Robert Tells Hank.");
    const typed=await p.$eval("#say",e=>e.value); ok(typed==="Xavier? Robert Tells Hank.","Shift+letters type text, no shortcuts (box="+JSON.stringify(typed)+", state="+await state()+")");
    ok((await p.$eval("#bar",e=>!e.hidden)),"call still live after typing capitals");
    await p.click("#sendBtn");
    ok(await p.evaluate(()=>document.activeElement&&document.activeElement.id==="say"),"focus returns to the box after Send");
    await p.waitForTimeout(1500);
    await p.keyboard.press("Escape"); await p.keyboard.press("x");
    await waitText(/You ended it/);
    ok(true,"Esc then X hangs up");
  }
}catch(e){ fail++; console.log(`[${mode}] FAIL`,e.message); }
if(errs.length){ fail++; console.log(`[${mode}] FAIL page errors:`,errs); }
if(verbose){
  const log=await (await fetch(mockUrl+"/__log")).json();
  for(const x of log){ if(x.body?.messages){ const m=x.body.messages; console.log("  LLM", x.body.stream?"stream":"parse", JSON.stringify(m[m.length-1].content).slice(0,160)); } }
}
await b.close();
return { pass, fail };
}
