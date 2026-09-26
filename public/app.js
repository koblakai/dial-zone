import { STEPS, SCENARIOS, DIALS_TARGET, CONNECT_TARGET } from "./framework.js";

  const SILENCE_MS=1100;              // end-of-turn after this much quiet
  const ECHO_TAIL_MS=350;             // ignore mic for this long after they stop talking

  /* ================= state ================= */
  const S={
    phase:"setup", scen:SCENARIOS[0], diff:3, who:"gatekeeper", step:1, reached:1,
    turns:[], startedAt:0, tick:null, busy:false, peeks:0, retries:0, peekStep:null,
    outcome:null, teardown:null, calls:[], lastId:"", callAt:"",
    mic:"idle",           // idle | live | denied | unsupported
    speaking:false, spokenNow:"", spokenIdx:0,
    heard:"", interim:"", vadAt:0, vadTimer:null, ctl:null
  };
  const $=(s)=>document.querySelector(s);
  const el=(t,c,x)=>{const n=document.createElement(t); if(c)n.className=c; if(x!=null)n.textContent=x; return n;};

  const SR = window.SpeechRecognition||window.webkitSpeechRecognition;
  const TTS = window.speechSynthesis;
  const voiceOK = !!TTS, srOK = !!SR;

  /* ================= voices ================= */
  let voices=[];
  function loadVoices(){ try{ voices=TTS?TTS.getVoices():[]; }catch(e){ voices=[]; } }
  loadVoices();
  try{ TTS.onvoiceschanged=loadVoices; }catch(e){}
  const FEM=/(samantha|victoria|karen|moira|tessa|fiona|serena|zira|susan|allison|ava|joanna|female|google uk english female|google us english)/i;
  const MASC=/(daniel|alex|fred|oliver|thomas|david|mark|matthew|male|google uk english male)/i;
  function pickVoice(sex){
    const en=voices.filter(v=>/^en([-_]|$)/i.test(v.lang||""));
    if(!en.length) return null;
    const nice=en.filter(v=>/google|natural|premium|enhanced|siri/i.test(v.name||""));
    const pool=nice.length?nice:en;
    const want = sex==="m"?MASC:FEM, avoid = sex==="m"?FEM:MASC;
    return pool.find(v=>want.test(v.name||"")) || pool.find(v=>!avoid.test(v.name||"")) || pool[0];
  }

  /* ================= board ================= */
  function paintBoard(){
    const live=S.phase==="live";
    $("#notchBox").hidden=!live; $("#notch").textContent=S.diff;
    const lad=$("#ladder"); lad.textContent="";
    STEPS.forEach((st)=>{
      const b=el("span","rung",st.n+" "+st.name.toUpperCase());
      if(live&&st.n===S.step) b.className="rung now";
      else if(st.n<S.reached) b.className="rung done";
      lad.appendChild(b);
    });
    $("#bar").hidden=!live;
  }
  function startClock(){
    S.startedAt=Date.now(); clearInterval(S.tick);
    S.tick=setInterval(()=>{
      const s=Math.floor((Date.now()-S.startedAt)/1000);
      $("#clock").textContent=Math.floor(s/60)+":"+String(s%60).padStart(2,"0");
    },250);
  }
  function elapsed(){ return S.startedAt?Math.floor((Date.now()-S.startedAt)/1000):0; }
  function fmt(s){ return Math.floor(s/60)+":"+String(s%60).padStart(2,"0"); }

  function paintState(){
    const orb=$("#orb"), txt=$("#stateTxt");
    let cls="off", label="Off hook";
    if(S.phase==="live"){
      if(S.speaking){ cls="talk"; label=(S.who==="dm"?first(S.scen.dm):S.scen.gk||"They")+" is talking"; }
      else if(S.busy){ cls="think"; label="…"; }
      else if(S.mic==="live"){ cls="listen"; label="Your turn — talk"; }
      else if(S.mic==="denied"){ cls="off"; label="Mic blocked — type instead"; }
      else if(S.mic==="unsupported"){ cls="off"; label="No mic here — type instead"; }
      else { cls="off"; label="Mic off"; }
    }
    orb.className="orb "+cls; txt.textContent=label;
    updateMouth();
  }
  function first(n){ return String(n||"").split(" ")[0]; }

  /* ================= setup ================= */
  function renderSetup(){
    if(S.phase!=="setup") return;
    const w=$("#stage"); w.textContent="";
    const box=el("div","setup");
    box.appendChild(el("p","eyebrow","Levitate SDR · cold call reps"));
    box.appendChild(el("h1","","Pick up the phone."));
    box.appendChild(el("p","sub","You talk, they talk back. They screen you, stall, and hang up when you earn it. Keys are a silent channel — nothing you press is heard on the line."));

    // mic check
    const mc=el("fieldset");
    mc.appendChild(el("p","eyebrow","Line check"));
    const row=el("div","checkline");
    const d1=el("span","dot "+(srOK?"":"bad"));
    const t1=el("span","",srOK?"Mic — not tested":"This browser can’t hear you (use Chrome)");
    const d2=el("span","dot "+(voiceOK?"ok":"bad"));
    const t2=el("span","",voiceOK?"Voice out ready":"No voice out here");
    row.appendChild(d1); row.appendChild(t1);
    row.appendChild(el("span","hint","·"));
    row.appendChild(d2); row.appendChild(t2);
    mc.appendChild(row);
    const test=el("button","ghostbtn","Test the line"); test.type="button";
    test.onclick=async()=>{
      test.disabled=true; t1.textContent="Asking for the mic…"; d1.className="dot wait";
      const ok=await askMic();
      d1.className="dot "+(ok?"ok":"bad");
      t1.textContent= ok?"Mic ready":(S.mic==="denied"?"Mic blocked — allow it in the address bar":"Mic unavailable");
      if(voiceOK) say("Harlow and Pierce, this is Dana.","f",()=>{});
      test.disabled=false;
    };
    mc.appendChild(test);
    box.appendChild(mc);

    const f1=el("fieldset");
    f1.appendChild(el("p","eyebrow","Who you’re calling"));
    const cards=el("div","cards");
    SCENARIOS.forEach((sc)=>{
      const b=el("button","card"); b.type="button";
      b.setAttribute("aria-pressed",String(sc.id===S.scen.id));
      b.appendChild(el("em","",sc.tag));
      b.appendChild(el("b","",sc.firm));
      b.appendChild(el("span","",sc.detail));
      b.onclick=()=>{ S.scen=sc; renderSetup(); };
      cards.appendChild(b);
    });
    f1.appendChild(cards); box.appendChild(f1);

    const f2=el("fieldset");
    f2.appendChild(el("p","eyebrow","Resistance"));
    const dial=el("div","dial");
    ["Warm","Normal","Busy","Curt","Brutal"].forEach((lbl,i)=>{
      const b=el("button","",(i+1)+" · "+lbl); b.type="button";
      b.setAttribute("aria-pressed",String(S.diff===i+1));
      b.onclick=()=>{ S.diff=i+1; renderSetup(); paintBoard(); };
      dial.appendChild(b);
    });
    f2.appendChild(dial);
    f2.appendChild(el("p","hint","Day one, run it verbatim at 2–3. Raise it once the script is muscle."));
    box.appendChild(f2);

    const go=el("button","go","Dial"); go.type="button";
    go.onclick=startCall;
    box.appendChild(go);
    box.appendChild(el("p","hint","Headphones help — without them the mic can hear the prospect."));
    w.appendChild(box); paintBoard(); paintState();
  }

  /* ================= mic ================= */
  let rec=null, restarting=false;
  async function askMic(){
    if(!srOK){ S.mic="unsupported"; paintState(); return false; }
    try{
      if(navigator.mediaDevices&&navigator.mediaDevices.getUserMedia){
        const st=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
        st.getTracks().forEach(t=>t.stop());
      }
      S.mic="idle"; paintState(); return true;
    }catch(e){
      // only a refusal is final; anything else, let the recognizer decide
      const n=e&&e.name;
      if(n==="NotAllowedError"||n==="SecurityError"){ S.mic="denied"; paintState(); return false; }
      S.mic="idle"; paintState(); return false;
    }
  }

  function startMic(){
    if(!srOK){ S.mic="unsupported"; showFallback(); paintState(); return; }
    try{
      rec=new SR();
      rec.continuous=true; rec.interimResults=true; rec.lang="en-US"; rec.maxAlternatives=1;
      rec.onresult=onHeard;
      rec.onerror=(e)=>{
        const c=e&&e.error;
        if(c==="no-speech"||c==="aborted"||c==="audio-capture") return;
        if(c==="not-allowed"||c==="service-not-allowed"){ S.mic="denied"; showFallback(); paintState(); }
      };
      rec.onend=()=>{
        if(S.phase==="live"&&S.mic==="live"&&!restarting){
          restarting=true;
          setTimeout(()=>{ restarting=false; try{ rec&&rec.start(); }catch(e){} },120);
        }
      };
      rec.start(); S.mic="live"; paintState();
    }catch(e){ S.mic="denied"; showFallback(); paintState(); }
  }
  function stopMic(){
    S.mic="idle"; clearTimeout(S.vadTimer); S.heard=""; S.interim="";
    try{ rec&&(rec.onend=null,rec.stop()); }catch(e){} rec=null; paintState();
  }
  function showFallback(){ $("#fallback").hidden=false; }

  /* --- echo rejection: is what we just heard actually the prospect's own voice? --- */
  function norm(s){ return String(s||"").toLowerCase().replace(/[^a-z0-9 ]/g," ").replace(/\s+/g," ").trim(); }
  function isEcho(text){
    if(!S.speaking && Date.now()-S.lastSpokeEnd > ECHO_TAIL_MS) return false;
    const heard=norm(text), src=norm(S.spokenNow);
    if(!heard||!src) return false;
    const hw=heard.split(" ").filter(w=>w.length>2);
    if(!hw.length) return true;                       // filler while they talk: drop it
    let hit=0; hw.forEach(w=>{ if(src.indexOf(w)>=0) hit++; });
    return (hit/hw.length) >= 0.6;                     // mostly their words coming back
  }

  function onHeard(e){
    if(S.phase!=="live") return;
    let fin="", inter="";
    for(let i=e.resultIndex;i<e.results.length;i++){
      const r=e.results[i];
      if(r.isFinal) fin+=r[0].transcript; else inter+=r[0].transcript;
    }
    const all=(fin+" "+inter).trim();
    if(!all) return;

    if(isEcho(all)) return;                            // their voice in our mic — ignore

    if(S.speaking){                                    // real barge-in
      const words=norm(all).split(" ").filter(Boolean);
      if(words.length<2) return;                       // a cough isn't an interruption
      cutThemOff();
    }

    if(fin) S.heard=(S.heard+" "+fin).trim();
    S.interim=inter.trim();
    S.vadAt=Date.now();
    updateMouth();
    clearTimeout(S.vadTimer);
    S.vadTimer=setTimeout(endOfTurn,SILENCE_MS);
  }

  function endOfTurn(){
    const text=(S.heard+" "+S.interim).trim();
    S.heard=""; S.interim="";
    if(!text||S.phase!=="live"){ updateMouth(); return; }
    sendLine(text);
  }

  /* ================= speaking ================= */
  let queue=[], speakingChain=false, gen=0;   // gen: bumped on barge-in so late chunks die
  S.lastSpokeEnd=0;
  function say(text,sex,done){
    if(!TTS){ done&&done(); return null; }
    const u=new SpeechSynthesisUtterance(text);
    const v=pickVoice(sex); if(v) u.voice=v;
    u.rate=1.07; u.pitch = sex==="m"?0.95:1.03;
    u.onend=()=>{ done&&done(); };
    u.onerror=()=>{ done&&done(); };
    try{ TTS.speak(u); }catch(e){ done&&done(); }
    return u;
  }
  function beginSpeaking(){ S.speaking=true; S.spokenNow=""; paintState(); }
  function speakChunk(chunk,sex,myGen){
    if(!chunk.trim()||myGen!==gen) return;
    S.spokenNow += " "+chunk;
    if(!S.speaking){ S.speaking=true; paintState(); }
    queue.push({t:chunk,sex:sex,g:myGen});
    drain();
  }
  function drain(){
    if(speakingChain||!queue.length) return;
    const item=queue.shift();
    if(item.g!==gen){ drain(); return; }
    speakingChain=true;
    say(item.t,item.sex,()=>{
      speakingChain=false;
      if(queue.length) drain(); else finishSpeaking();
    });
  }
  function finishSpeaking(){
    if(queue.length||speakingChain) return;
    if(!S.speaking) return;
    S.speaking=false; S.lastSpokeEnd=Date.now(); paintState(); updateMouth();
  }
  function cutThemOff(){
    if(!S.speaking&&!queue.length&&!speakingChain) return false;
    gen++; queue=[]; speakingChain=false;
    try{ TTS&&TTS.cancel(); }catch(e){}
    for(let i=S.turns.length-1;i>=0;i--){
      if(S.turns[i].side==="them"){ S.turns[i].cut=true; break; }
    }
    S.speaking=false; S.lastSpokeEnd=Date.now();
    paintState(); renderCall();
    return true;
  }

  /* ================= the call ================= */
  function startCall(){
    S.phase="live"; S.who=S.scen.open; S.step=S.scen.open==="dm"?2:1; S.reached=S.step;
    S.turns=[]; S.peeks=0; S.retries=0; S.outcome=null; S.teardown=null;
    S.lastId="c"+Date.now().toString(36); S.callAt=""; S.peekStep=null; S.heard=""; S.interim="";
    startClock(); renderKeys(); paintBoard(); renderCall(); renderRail();
    $("#fallback").hidden = srOK && S.mic!=="denied";
    startMic();
    beat(S.scen.open==="dm"?"Line picks up. Someone answers directly.":"Line picks up. Front desk.");
    askProspect(true);
  }

  function beat(txt,dir){ S.turns.push({side:"beat",text:txt,dir:!!dir}); renderCall(); }

  function whoLabel(who){
    return who==="dm" ? S.scen.dm.toUpperCase() : (S.scen.gk||"FRONT DESK").toUpperCase();
  }

  let mouthBox=null, mouthLine=null, vadBar=null;

  function renderCall(){
    if(S.phase!=="live") { mouthBox=null; return; }
    const w=$("#stage"); w.textContent="";
    const c=el("div","call");
    const slug=el("div","slug");
    slug.textContent="INT. "+S.scen.firm.toUpperCase()+" — OUTBOUND · RESIST "+S.diff;
    c.appendChild(slug);

    S.turns.forEach((t)=>{
      if(t.side==="beat"){ c.appendChild(el("div","beat"+(t.dir?" dir":""),t.text)); return; }
      const d=el("div","turn "+t.side+(t.flagged?" flagged":""));
      d.appendChild(el("span","cue",t.side==="rep"?"YOU":whoLabel(t.who)));
      const p=el("p","said"); p.textContent=t.text;
      if(t.cut) p.appendChild(el("span","cut"," ——"));
      d.appendChild(p); c.appendChild(d);
    });

    const m=el("div","mouth");
    mouthBox=el("div","mouthbox idle");
    mouthBox.appendChild(el("span","cue","YOU"));
    mouthLine=el("p","waiting","");
    mouthBox.appendChild(mouthLine);
    const vad=el("div","vad"); vadBar=el("i"); vad.appendChild(vadBar);
    mouthBox.appendChild(vad);
    m.appendChild(mouthBox); c.appendChild(m);

    w.appendChild(c); updateMouth(); w.scrollTop=w.scrollHeight;
  }

  /* the only thing that repaints while you are mid-sentence */
  function updateMouth(){
    if(!mouthBox||S.phase!=="live") return;
    const live=(S.heard+" "+S.interim).trim();
    mouthBox.className="mouthbox"+(live?"":" idle");
    if(live){ mouthLine.className="said"; mouthLine.textContent=live; }
    else{
      mouthLine.className="waiting";
      mouthLine.textContent =
        S.speaking?"They’re talking — cut in whenever you like."
        :S.busy?"…"
        :S.mic==="live"?"Listening…"
        :"Type your line below.";
    }
    if(!vadBar) return;
    vadBar.style.transition="none";
    vadBar.style.transform=live?"scaleX(1)":"scaleX(0)";
    if(live) requestAnimationFrame(()=>{
      if(!vadBar) return;
      vadBar.style.transition="transform "+SILENCE_MS+"ms linear";
      vadBar.style.transform="scaleX(0)";
    });
  }

  function sendLine(text){
    text=String(text||"").trim();
    if(!text||S.phase!=="live") return;
    if(S.busy){ try{S.ctl&&S.ctl.abort();}catch(e){} gen++; S.busy=false; }
    cutThemOff();
    S.turns.push({side:"rep",text:text});
    $("#say").value=""; renderCall();
    askProspect(false);
  }
  function lastRepIndex(){
    for(let i=S.turns.length-1;i>=0;i--) if(S.turns[i].side==="rep") return i;
    return -1;
  }

  /* ================= prospect ================= */
  // what the server needs to rebuild the conversation: spoken lines and director notes only
  function transcript(){
    const out=[];
    S.turns.forEach((t)=>{
      if(t.side==="rep"||t.side==="them") out.push({side:t.side,text:t.text,cut:!!t.cut,flagged:!!t.flagged});
      else if(t.side==="beat"&&t.director) out.push({side:"director",text:t.text});
    });
    return out;
  }

  // POST and read the NDJSON stream; onText gets the whole text so far.
  async function streamProspect(body,signal,onText){
    const r=await fetch("api/prospect",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify(body),signal});
    if(!r.ok||!r.body){
      let j={}; try{ j=await r.json(); }catch(e){}
      throw Object.assign(new Error(j.message||"HTTP "+r.status),{code:j.code||(r.status===429?"rate_limited":"error")});
    }
    const rd=r.body.getReader(), dec=new TextDecoder();
    let buf="", text="";
    for(;;){
      const {value,done}=await rd.read();
      if(done) break;
      buf+=dec.decode(value,{stream:true});
      let nl;
      while((nl=buf.indexOf("\n"))>=0){
        const line=buf.slice(0,nl).trim(); buf=buf.slice(nl+1);
        if(!line) continue;
        const m=JSON.parse(line);
        if(m.delta){ text+=m.delta; onText(text); }
        else if(m.error) throw Object.assign(new Error(m.message||m.error),{code:m.error});
      }
    }
    return text;
  }

  async function askProspect(first){
    S.busy=true; paintState(); renderCall();

    const sex = S.who==="dm" ? (S.scen.dmVoice||"f") : (S.scen.gkVoice||"f");
    const sayer = S.who;
    S.ctl=new AbortController();
    const myGen=gen;

    let spokenUpTo=0, started=false, idx=-1, tagSeen=false, liveP=null;
    const feed=(whole)=>{
      if(myGen!==gen) return;                       // you cut in; stop feeding
      const tagAt=whole.indexOf("[[");
      const speakable = tagAt>=0 ? whole.slice(0,tagAt) : whole;
      if(tagAt>=0) tagSeen=true;

      // voice each clause the moment it lands, so there's no dead air
      const rest=speakable.slice(spokenUpTo);
      const m=/[.!?…,;](\s|$)/g; let mm, last=-1;
      while((mm=m.exec(rest))!==null) last=mm.index+1;
      let cut = last>0 ? spokenUpTo+last : (tagSeen&&speakable.length>spokenUpTo ? speakable.length : -1);
      if(cut>spokenUpTo){
        const chunk=speakable.slice(spokenUpTo,cut).trim();
        spokenUpTo=cut;
        if(chunk){
          if(!started){ started=true; beginSpeaking(); }
          speakChunk(chunk,sex,myGen);
        }
      }

      const shown=speakable.trim();
      if(!shown) return;
      if(idx<0){
        S.turns.push({side:"them",text:shown,who:sayer});
        idx=S.turns.length-1;
        renderCall();
        const all=$("#stage").querySelectorAll(".turn.them .said");
        liveP=all[all.length-1]||null;
      }else{
        S.turns[idx].text=shown;
        if(liveP) liveP.textContent=shown; else renderCall();
      }
    };

    try{
      const raw=await streamProspect({scenarioId:S.scen.id,diff:S.diff,who:S.who,
        turns:first?[]:transcript()},S.ctl.signal,feed);
      S.busy=false;
      if(myGen!==gen){ paintState(); return; }        // you talked over the whole thing
      const tag=/\[\[\s*(gatekeeper|dm)\s*\|\s*([1-5])\s*\|\s*(none|transferred|booked|hangup)\s*\]\]/i.exec(raw);
      const spoken=raw.replace(/\[\[[\s\S]*$/,"").trim();
      if(!spoken){ beat("Line noise. Press R and say that again.","dir"); paintState(); return; }
      tagSeen=true; feed(raw+(raw.includes("[[")?"":"[["));   // voice whatever's still unsaid
      if(idx<0){ S.turns.push({side:"them",text:spoken,who:sayer}); idx=S.turns.length-1; }
      else S.turns[idx].text=spoken;
      finishSpeakingSoon();

      const who = tag?tag[1].toLowerCase():S.who;
      const stp = tag?parseInt(tag[2],10):S.step;
      const ev  = tag?tag[3].toLowerCase():"none";
      S.who=who; S.step=Math.min(5,Math.max(1,stp)); S.reached=Math.max(S.reached,S.step);
      renderCall(); paintBoard(); paintState(); renderRail();

      if(ev==="transferred") beat("Transferred. "+S.scen.dm+" picks up.");
      if(ev==="booked"){ S.outcome="booked"; whenQuiet(()=>endCall("booked")); }
      if(ev==="hangup"){ S.outcome="hangup"; whenQuiet(()=>endCall("hangup")); }
    }catch(e){
      S.busy=false; paintState();
      if((e&&e.name==="AbortError")||(e&&e.code==="cancelled")||myGen!==gen){ renderCall(); return; }
      const msg = e&&e.code==="not_granted" ? "The server has no working Anthropic API key — the prospect can’t speak."
        : e&&e.code==="rate_limited" ? "Too many calls too fast. Give it a minute."
        : "The line dropped. Press R to run that line again.";
      beat(msg,"dir"); renderCall();
    }
  }
  function finishSpeakingSoon(){ if(!queue.length&&!speakingChain) finishSpeaking(); }
  function whenQuiet(fn){
    let n=0;
    const t=setInterval(()=>{
      n++;
      if((!S.speaking&&!queue.length&&!speakingChain)||n>60){ clearInterval(t); fn(); }
    },250);
  }

  /* ================= silent channel ================= */
  const KEYS=[
    {k:"R",label:"Retry line",fn:retryLine},
    {k:"B",label:"Cut in",fn:()=>{ if(!cutThemOff()) flash("Nobody’s talking."); }},
    {k:"H",label:"Harder",fn:()=>nudge(1)},
    {k:"E",label:"Easier",fn:()=>nudge(-1)},
    {k:"F",label:"Flag",fn:flagLine},
    {k:"M",label:"Mute mic",fn:toggleMic},
    {k:"/",label:"Peek script",fn:peek},
    {k:"X",label:"Hang up",fn:()=>endCall("hungup"),danger:true}
  ];
  function renderKeys(){
    const w=$("#keys"); w.textContent="";
    KEYS.forEach((it)=>{
      const b=el("button","key"+(it.danger?" danger":"")); b.type="button";
      b.appendChild(el("kbd","",it.k)); b.appendChild(el("span","",it.label));
      b.onclick=(ev)=>{ ev.preventDefault(); it.fn(); };
      w.appendChild(b);
    });
    flash(HINT);
  }
  const HINT="Silent — the line never hears these.";
  let hintT=null;
  function flash(msg){
    const h=$("#hint"); if(!h) return;
    h.textContent=msg; clearTimeout(hintT);
    if(msg!==HINT) hintT=setTimeout(()=>{ h.textContent=HINT; },2200);
  }

  document.addEventListener("keydown",(e)=>{
    if(S.phase!=="live") return;
    if(e.metaKey||e.ctrlKey||e.altKey) return;
    const inField=e.target&&/^(INPUT|TEXTAREA)$/.test(e.target.tagName);
    if(inField){
      if(e.key==="Enter"){ e.preventDefault(); sendLine($("#say").value); return; }
      if(!e.shiftKey) return;                       // typing wins; Shift+key still signals
    }
    const k=e.key.toUpperCase();
    const hit=KEYS.find(it=>it.k===k||(it.k==="/"&&(e.key==="/"||e.key==="?")));
    if(hit){ e.preventDefault(); hit.fn(); }
  });

  function retryLine(){
    if(S.busy){ try{S.ctl&&S.ctl.abort();}catch(e){} S.busy=false; }
    cutThemOff();
    const i=lastRepIndex();
    if(i<0){ flash("Nothing to retry yet."); return; }
    const said=S.turns[i].text;
    S.turns=S.turns.slice(0,i); S.retries++;
    beat("Take two.","dir");
    if(!$("#fallback").hidden){ $("#say").value=said; }
    flash("Say it again.");
    paintState(); renderCall(); renderRail();
  }
  function nudge(d){
    const was=S.diff; S.diff=Math.min(5,Math.max(1,S.diff+d));
    if(S.diff===was){ flash(d>0?"Already brutal.":"Already warm."); return; }
    S.turns.push({side:"beat",text:"[DIRECTOR: resistance is now "+S.diff+" of 5. Adjust from your next line on.]",dir:true,director:true}); renderCall();
    paintBoard();
  }
  function flagLine(){
    const i=lastRepIndex(); if(i<0){ flash("Nothing to flag."); return; }
    S.turns[i].flagged=!S.turns[i].flagged; renderCall();
    flash(S.turns[i].flagged?"Flagged for the teardown.":"Unflagged.");
  }
  function toggleMic(){
    if(S.mic==="live"){ stopMic(); showFallback(); flash("Mic muted."); }
    else if(srOK){ startMic(); flash("Mic live."); }
    else flash("No mic in this browser.");
  }
  function peek(){
    S.peeks++; S.peekStep=STEPS[S.step-1]; renderRail();
    flash("Peeked — "+S.peeks+" so far.");
  }

  $("#sendBtn").onclick=()=>sendLine($("#say").value);

  /* ================= end ================= */
  function endCall(how){
    if(S.phase!=="live") return;
    try{ S.ctl&&S.ctl.abort(); }catch(e){}
    queue=[]; speakingChain=false; S.speaking=false;
    try{ TTS&&TTS.cancel(); }catch(e){}
    stopMic(); clearInterval(S.tick); S.tick=null;
    S.phase="ended"; S.outcome=S.outcome||how; S.busy=false;
    beat(how==="booked"?"Meeting booked. Call over.":how==="hangup"?"They hung up.":"You hung up.");
    paintBoard(); paintState(); renderEnd(); renderRail(); logCall(null);
  }

  function renderEnd(){
    const w=$("#stage"); w.textContent="";
    const s=el("div","sheet");
    s.appendChild(el("p","eyebrow",S.scen.firm+" · resist "+S.diff+" · "+fmt(elapsed())));
    s.appendChild(el("p","verdict",
      S.outcome==="booked"?"Thirty minutes on the calendar.":S.outcome==="hangup"?"They ended it.":"You ended it."));
    s.appendChild(el("p","sub","Reached step "+S.reached+" of 5"
      +(S.retries?" · "+S.retries+" retr"+(S.retries>1?"ies":"y"):"")
      +(S.peeks?" · "+S.peeks+" peek"+(S.peeks>1?"s":""):"")+"."));

    const acts=el("div","acts");
    const grade=el("button","go","Grade this call"); grade.type="button";
    grade.onclick=()=>getTeardown(grade);
    const again=el("button","ghostbtn","Dial again"); again.type="button";
    again.onclick=()=>{ S.phase="setup"; $("#clock").textContent="0:00"; renderSetup(); renderRail(); };
    acts.appendChild(grade); acts.appendChild(again); s.appendChild(acts);

    const hold=el("div"); hold.id="tdown"; s.appendChild(hold);
    if(S.teardown) paintTeardown(S.teardown,hold);

    const t=el("div");
    t.appendChild(el("p","eyebrow","The call"));
    const sc=el("div","call");
    S.turns.forEach((x)=>{
      if(x.side==="beat"){ sc.appendChild(el("div","beat"+(x.dir?" dir":""),x.text)); return; }
      const d=el("div","turn "+x.side+(x.flagged?" flagged":""));
      d.appendChild(el("span","cue",x.side==="rep"?"YOU":whoLabel(x.who)));
      const p=el("p","said"); p.textContent=x.text;
      if(x.cut) p.appendChild(el("span","cut"," ——"));
      d.appendChild(p); sc.appendChild(d);
    });
    t.appendChild(sc); s.appendChild(t);
    w.appendChild(s);
  }

  async function getTeardown(btn){
    btn.disabled=true; btn.textContent="Grading…";
    try{
      const r=await fetch("api/grade",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({scenarioId:S.scen.id,diff:S.diff,outcome:S.outcome||"hungup",
          reached:S.reached,turns:transcript()})});
      const j=await r.json().catch(()=>({}));
      if(!r.ok) throw Object.assign(new Error(j.message||"HTTP "+r.status),{code:j.code});
      S.teardown=j; paintTeardown(j,$("#tdown")); logCall(j); btn.remove();
    }catch(e){
      btn.disabled=false; btn.textContent="Grade this call";
      $("#tdown").textContent="";
      $("#tdown").appendChild(el("div","warnbox", e&&e.code==="not_granted"
        ? "The server has no working Anthropic API key, so it can’t grade the call."
        : e&&e.code==="rate_limited" ? "Too many requests. Give it a minute and try again."
        : "Grading didn’t come back. Try once more."));
    }
  }

  function paintTeardown(r,hold){
    hold.textContent="";
    const g=el("div"); g.style.display="flex"; g.style.flexDirection="column"; g.style.gap="18px";
    g.style.marginTop="8px";
    if(r.fix){
      const f=el("div","fix");
      f.appendChild(el("p","eyebrow","Next call, change this"));
      f.appendChild(el("p","",String(r.fix)));
      g.appendChild(f);
    }
    if(r.verdict) g.appendChild(el("p","verdict",String(r.verdict)));
    if(Array.isArray(r.steps)&&r.steps.length){
      const wrap=el("div","grades");
      r.steps.forEach((st)=>{
        const row=el("div","gr");
        const gr=String(st.grade||"").toUpperCase().slice(0,1)||"–";
        row.appendChild(el("div","mk "+gr,gr));
        const body=el("div");
        body.appendChild(el("h4","",(st.n?st.n+" ":"")+String(st.name||"")));
        const ul=el("ul");
        (st.hit||[]).slice(0,3).forEach(x=>ul.appendChild(el("li","plus",String(x))));
        (st.miss||[]).slice(0,3).forEach(x=>ul.appendChild(el("li","minus",String(x))));
        body.appendChild(ul); row.appendChild(body); wrap.appendChild(row);
      });
      g.appendChild(wrap);
    }
    if(r.worst&&(r.worst.said||r.worst.instead)){
      const sw=el("div","swap");
      const a=el("div","bad"); a.appendChild(el("span","k","You said"));
      a.appendChild(el("p","said",String(r.worst.said||"")));
      const b=el("div","good"); b.appendChild(el("span","k","Say this"));
      b.appendChild(el("p","said",String(r.worst.instead||"")));
      const hear=el("button","ghostbtn","Hear it"); hear.type="button";
      hear.onclick=()=>{ try{TTS&&TTS.cancel();}catch(e){} say(String(r.worst.instead||""),"m",()=>{}); };
      if(voiceOK) b.appendChild(hear);
      sw.appendChild(a); sw.appendChild(b); g.appendChild(sw);
    }
    hold.appendChild(g);
  }

  /* ================= log ================= */
  function avgGrade(r){
    if(!r||!Array.isArray(r.steps)||!r.steps.length) return "";
    const map={A:4,B:3,C:2,D:1,F:0}; let sum=0,n=0;
    r.steps.forEach(s=>{const k=String(s.grade||"").toUpperCase().slice(0,1); if(k in map){sum+=map[k];n++;}});
    return n?["F","D","C","B","A"][Math.round(sum/n)]:"";
  }
  function logCall(r){
    if(!S.callAt) S.callAt=new Date().toISOString();
    const rec={id:S.lastId,at:S.callAt,firm:S.scen.firm,diff:S.diff,reached:S.reached,
      outcome:S.outcome||"hungup",seconds:elapsed(),peeks:S.peeks,retries:S.retries,
      grade:avgGrade(r)||"",fix:r&&r.fix?String(r.fix):""};
    const i=S.calls.findIndex(c=>c.id===S.lastId);
    if(i>=0) S.calls[i]=rec; else S.calls.unshift(rec);
    renderRail();
    fetch("api/calls/"+encodeURIComponent(S.lastId),{method:"PUT",headers:{"Content-Type":"application/json"},
      body:JSON.stringify(rec)}).catch(()=>{});
  }
  function dayOf(iso){ const d=new Date(iso); return isNaN(d)?"":d.toLocaleDateString("en-CA"); }
  function today(){ return dayOf(new Date().toISOString()); }
  function stats(){
    const t=S.calls.filter(c=>dayOf(c.at)===today());
    const dials=t.length, connects=t.filter(c=>(c.reached||1)>=2).length;
    return {dials,connects,convos:t.filter(c=>(c.reached||1)>=3).length,
      booked:t.filter(c=>c.outcome==="booked").length,rate:dials?connects/dials:0};
  }

  function renderRail(){
    const w=$("#rail"); w.textContent="";
    const peekStep=(S.peekStep&&S.peekStep.n===S.step)?S.peekStep:null;

    const s1=el("section");
    s1.appendChild(el("p","rtitle","Today"));
    const st=stats(); const grid=el("div","stats");
    [["Dials",st.dials],["Connects",st.connects],["Convos",st.convos],["Booked",st.booked]].forEach(([k,v])=>{
      const c=el("div","stat"); c.appendChild(el("b","",String(v))); c.appendChild(el("span","",k)); grid.appendChild(c);
    });
    s1.appendChild(grid);

    const m1=el("div","meter"); const l1=el("div","lbl");
    l1.appendChild(el("span","","Dials")); l1.appendChild(el("span","",st.dials+" / "+DIALS_TARGET));
    m1.appendChild(l1);
    const t1=el("div","track"); const f1=el("div","fill");
    f1.style.width=Math.min(100,(st.dials/DIALS_TARGET)*100)+"%"; t1.appendChild(f1); m1.appendChild(t1);
    s1.appendChild(m1);

    const m2=el("div","meter"); const l2=el("div","lbl");
    l2.appendChild(el("span","","Connect rate"));
    l2.appendChild(el("span","",(st.rate*100).toFixed(0)+"% · target 17%"));
    m2.appendChild(l2);
    const t2=el("div","track"); const f2=el("div","fill");
    f2.style.width=Math.min(100,(st.rate/0.40)*100)+"%";
    const tk=el("div","tick"); tk.style.left=(CONNECT_TARGET/0.40*100)+"%";
    t2.appendChild(f2); t2.appendChild(tk); m2.appendChild(t2); s1.appendChild(m2);
    w.appendChild(s1);

    if(S.phase==="live"){
      const stp=STEPS[S.step-1]; const s2=el("section");
      s2.appendChild(el("p","rtitle","Step "+stp.n+" · "+stp.goal));
      const cl=el("div","checks");
      stp.rules.forEach((r)=>{
        const d=el("div","chk"); d.appendChild(el("i","","—")); d.appendChild(el("span","",r)); cl.appendChild(d);
      });
      s2.appendChild(cl);
      if(peekStep) s2.appendChild(el("div","peek",peekStep.line));
      w.appendChild(s2);
    }

    const s3=el("section");
    s3.appendChild(el("p","rtitle","Call log"));
    if(!S.calls.length) s3.appendChild(el("p","empty","No calls logged yet."));
    else{
      const box=el("div","log");
      S.calls.slice(0,14).forEach((c)=>{
        const r=el("div","logrow");
        const g=String(c.grade||"·").toUpperCase();
        r.appendChild(el("span","g "+g,g));
        r.appendChild(el("span","",first(c.firm)));
        r.appendChild(el("span","w",(c.outcome==="booked"?"booked":"step "+(c.reached||1))+" · "+String(c.at||"").slice(5,10)));
        box.appendChild(r);
      });
      s3.appendChild(box);
    }
    w.appendChild(s3);
  }

  /* ================= boot ================= */
  renderSetup(); renderRail(); paintBoard();

  (async function(){
    try{
      const r=await fetch("api/calls");
      if(r.ok){ S.calls=await r.json(); renderRail(); }
    }catch(e){}
  })();
