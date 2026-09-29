import { STEPS, SCENARIOS, DIALS_TARGET, CONNECT_TARGET, findScenario } from "./framework.js";
import * as phone from "./phone.js";

  const SILENCE_MS=800;               // end-of-turn after this much quiet…
  const SILENCE_PITCH_MS=1000;        // …a little more once you're pitching or qualifying (longer thoughts)
  const TRAILING_MS=1800;             // …or this much if you trailed off mid-thought ("so, um…")
  const ECHO_TAIL_MS=1800;            // speech-to-text finalizes late: keep checking for their voice this long
  const SR_LAG_MS=300;                // speech-to-text reports words roughly this late
  const PAUSE_MS=700;                 // a gap this long between words counts as a pause
  const SPEC_MS=250;                  // start thinking this early; only speak once the turn is really over
  const DEAD_AIR_MS=6000;             // prospect reacts to this much silence from you
  const DEAD_AIR_TYPED_MS=20000;      // …more slack when you're typing
  const FILLER_MS=600;                // no first word yet this long after your turn: a spoken "Mm-hm."
  const IS_ANDROID=/Android/i.test(navigator.userAgent);
  const NARROW=window.matchMedia("(max-width:860px)");

  /* ================= state ================= */
  const S={
    phase:"setup", scen:SCENARIOS[0], diff:3, who:"gatekeeper", step:1, reached:1,
    turns:[], startedAt:0, tick:null, busy:false, peeks:0, retries:0, peekStep:null, peekMood:false,
    outcome:null, teardown:null, calls:[], lastId:"", callAt:"",
    mic:"idle",           // idle | live | denied | failed | unsupported
    speaking:false,       // a reply is queued or playing
    audible:false,        // …and sound is actually coming out
    spokenNow:"", played:"", lastSpokeEnd:0, ringing:false,
    heard:"", heardSegs:[], interim:"", vadTimer:null, eotMs:SILENCE_MS, ctl:null,
    tm:null,              // measurements for the turn you're speaking right now
    sr:null, srFails:[],  // speech-recognition bookkeeping for the current session
    spec:null, reqSeq:0, cutReq:-1, queuedAsk:false,
    hold:false, pendingEv:null, evSeq:0, pendingQuiet:null, xferCtl:null,
    pendingNotes:[],
    deadAir:null, silences:0, callCtl:null,
    lineCheck:{busy:false,text:"",dot:""},
    view:"contacts", pane:"list", filter:"all", query:"", dial:"", padOpen:false,
    cfg:{brain:true,tts:"browser"}
  };
  const $=(s)=>document.querySelector(s);
  const el=(t,c,x)=>{const n=document.createElement(t); if(c)n.className=c; if(x!=null)n.textContent=x; return n;};

  const SR = window.SpeechRecognition||window.webkitSpeechRecognition;
  const TTS = window.speechSynthesis;
  const srOK = !!SR;
  const premium = ()=>S.cfg.tts==="elevenlabs";
  const voiceOK = ()=>premium()||!!TTS;

  /* ================= browser voices (fallback) ================= */
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
  // iOS only lets speech start later if it was first used inside a tap
  function unlockAudio(){
    phone.unlock();
    if(premium()) phone.primeAudio();
    try{ if(TTS){ const u=new SpeechSynthesisUtterance(" "); u.volume=0; TTS.speak(u); } }catch(e){}
  }

  /* ================= icons ================= */
  const ICONS={
    phone:'<path d="M5 4h3l2 5-2.5 1.5a11 11 0 0 0 6 6L15 14l5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>',
    hang:'<path d="M3 15.5c0-2 4-4.5 9-4.5s9 2.5 9 4.5l-.5 2.2a1 1 0 0 1-1.2.7l-3.3-.9a1 1 0 0 1-.7-.9l-.2-2c-2-.7-4.2-.7-6.2 0l-.2 2a1 1 0 0 1-.7.9l-3.3.9a1 1 0 0 1-1.2-.7z"/>',
    contacts:'<circle cx="12" cy="8" r="3.6"/><path d="M4.5 20c.8-3.6 3.8-5.6 7.5-5.6s6.7 2 7.5 5.6"/>',
    recents:'<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    keypad:'<circle cx="6" cy="5" r="1.3"/><circle cx="12" cy="5" r="1.3"/><circle cx="18" cy="5" r="1.3"/><circle cx="6" cy="11" r="1.3"/><circle cx="12" cy="11" r="1.3"/><circle cx="18" cy="11" r="1.3"/><circle cx="6" cy="17" r="1.3"/><circle cx="12" cy="17" r="1.3"/><circle cx="18" cy="17" r="1.3"/><circle cx="12" cy="22" r="1.3"/>',
    search:'<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
    mic:'<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
    retry:'<path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.5"/><path d="M4 4v4.5h4.5"/>',
    cut:'<path d="M7 11V6.5a1.5 1.5 0 0 1 3 0V11m0-1V5a1.5 1.5 0 0 1 3 0v5m0 0V6a1.5 1.5 0 0 1 3 0v6m0-3.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-1a7 7 0 0 1-5.4-2.6L3.8 15a1.6 1.6 0 0 1 2.4-2.1L7 14"/>',
    flag:'<path d="M5 21V4m0 0h11l-2 4 2 4H5"/>',
    script:'<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4M10 12h5M10 16h5"/>',
    room:'<path d="M3.5 16a8.5 8.5 0 1 1 17 0"/><path d="m12 16 4-5"/>',
    up:'<path d="m6 14 6-6 6 6"/>',
    down:'<path d="m6 10 6 6 6-6"/>',
    next:'<path d="M5 12h13m-5-5 5 5-5 5"/>',
    shuffle:'<path d="M3 7h3.5c4 0 5 10 9 10H21m0 0-3-3m3 3-3 3M3 17h3.5c1.5 0 2.5-1.4 3.4-3.2M21 7h-5.5c-1.5 0-2.5 1.4-3.4 3.2M21 7l-3-3m3 3-3 3"/>',
    back:'<path d="m14 6-6 6 6 6"/>'
  };
  function icon(name){
    const s=document.createElementNS("http://www.w3.org/2000/svg","svg");
    s.setAttribute("viewBox","0 0 24 24"); s.setAttribute("fill","none"); s.setAttribute("stroke","currentColor");
    s.setAttribute("stroke-width","1.8"); s.setAttribute("stroke-linecap","round"); s.setAttribute("stroke-linejoin","round");
    s.setAttribute("aria-hidden","true");
    s.innerHTML=ICONS[name]||"";                       // constant markup from ICONS only
    return s;
  }
  const vclass=(v)=>v==="Med spa"?"spa":v;
  function initials(name){
    const w=String(name||"").replace(/^(Dr\.?)\s+/i,"").split(/\s+/).filter(Boolean);
    return ((w[0]||"?")[0]+(w.length>1?w[w.length-1][0]:"")).toUpperCase();
  }
  function avatar(sc,big){ return el("span","av "+vclass(sc.vertical)+(big?" big":""),initials(sc.dm)); }
  const digits=(s)=>String(s||"").replace(/\D/g,"");

  /* ================= board: call header, ladder, panes ================= */
  function paintBoard(){
    const live=S.phase==="live", inCall=S.phase!=="setup";
    $("#app").dataset.pane = inCall ? "main" : S.pane;
    $("#callhead").hidden=!inCall;
    if(inCall){
      const av=$("#headAv"); av.className="av "+vclass(S.scen.vertical); av.textContent=initials(S.scen.dm);
      $("#headName").textContent=S.scen.dm;
      $("#headSub").textContent=S.scen.firm+" · "+S.scen.phone;
    }
    $("#notchBox").hidden=!live; $("#notch").textContent=S.diff;
    const lad=$("#ladder"); lad.textContent="";
    STEPS.forEach((st)=>{
      const b=el("span","rung",st.n+" "+st.name);
      if(live&&st.n===S.step) b.className="rung now";
      else if(st.n<S.reached||(!live&&st.n<=S.reached)) b.className="rung done";
      lad.appendChild(b);
    });
    $("#bar").hidden=!live;
    renderNav();
  }
  function startClock(){
    S.startedAt=Date.now(); clearInterval(S.tick);
    $("#clock").textContent="0:00";
    S.tick=setInterval(()=>{
      const s=Math.floor((Date.now()-S.startedAt)/1000);
      $("#clock").textContent=Math.floor(s/60)+":"+String(s%60).padStart(2,"0");
    },250);
  }
  function elapsed(){ return S.startedAt?Math.floor(((S.endedAt||Date.now())-S.startedAt)/1000):0; }
  function fmt(s){ return Math.floor(s/60)+":"+String(s%60).padStart(2,"0"); }

  function paintState(){
    const orb=$("#orb"), txt=$("#stateTxt");
    let cls="off", label="Off hook";
    if(S.phase==="live"){
      if(S.ringing){ cls="think"; label="Ringing…"; }
      else if(S.speaking){ cls="talk"; label=(S.who==="dm"?S.scen.dm:(S.scen.gk||"They"))+" is talking"; }
      else if(S.busy&&!S.spec){ cls="think"; label="…"; }
      else if(S.mic==="live"){ cls="listen"; label="Your turn — talk"; }
      else if(S.mic==="denied"){ cls="off"; label="Mic blocked — type instead"; }
      else if(S.mic==="failed"){ cls="off"; label="Speech service unavailable — type instead"; }
      else if(S.mic==="unsupported"){ cls="off"; label="No mic here — type instead"; }
      else { cls="off"; label="Mic muted — type instead"; }
    }
    orb.className="orb "+cls; txt.textContent=label;
    const mb=document.querySelector('.ctrl[data-k="M"]');
    if(mb){ mb.setAttribute("aria-pressed",String(S.mic!=="live")); mb.querySelector("span").textContent=S.mic==="live"?"Mute":"Unmute"; }
    updateMouth();
  }
  function first(n){ return String(n||"").split(" ")[0]; }

  /* ================= nav + contact list ================= */
  function renderNav(){
    const n=$("#nav"); n.textContent="";
    n.appendChild(el("div","brand","DR")).title="The Dial Room";
    [["contacts","Contacts"],["recents","Recents"],["keypad","Keypad"]].forEach(([v,label])=>{
      const b=el("button","navbtn"); b.type="button";
      b.setAttribute("aria-current",String(S.view===v));
      b.append(icon(v),el("span","",label));
      b.onclick=()=>{ S.view=v; if(S.phase==="setup") S.pane="list"; renderSide(); paintBoard(); };
      n.appendChild(b);
    });
    const foot=el("div","navfoot"); foot.appendChild(el("span","me","You")).title="Available";
    n.appendChild(foot);
  }

  function filtered(){
    const q=S.query.trim().toLowerCase(), qd=digits(q);
    return SCENARIOS.filter((sc)=>{
      if(S.filter!=="all"&&sc.vertical!==S.filter) return false;
      if(!q) return true;
      if(qd.length>=3&&digits(sc.phone).includes(qd)) return true;
      return [sc.dm,sc.firm,sc.city,sc.vertical,...(sc.services||[])].join(" ").toLowerCase().includes(q);
    }).sort((a,b)=>lastName(a.dm).localeCompare(lastName(b.dm)));
  }
  function lastName(n){ const w=String(n).split(" "); return w[w.length-1]; }

  function selectContact(sc){
    if(S.phase==="live") { flash("Finish this call first."); return; }
    S.scen=sc; S.pane="main";
    if(S.phase==="ended"){ S.phase="setup"; }
    S.lineCheck={busy:false,text:S.lineCheck.text&&!S.lineCheck.busy?S.lineCheck.text:"",dot:S.lineCheck.dot||""};
    renderSetup(); renderSide(); renderRail();
  }

  function renderSide(){
    const w=$("#side"); w.textContent="";
    if(S.view==="recents") return renderRecents(w);
    if(S.view==="keypad") return renderDialer(w);
    const head=el("div","sidehead");
    const h=el("h2","","Contacts"); h.appendChild(el("small","",String(SCENARIOS.length)));
    head.appendChild(h);
    const sb=el("label","search"); sb.appendChild(icon("search"));
    const inp=el("input"); inp.type="search"; inp.placeholder="Search name, practice, city"; inp.value=S.query;
    inp.setAttribute("aria-label","Search contacts");
    inp.oninput=()=>{ S.query=inp.value; paintList(); };
    sb.appendChild(inp); head.appendChild(sb);
    const chips=el("div","chips");
    [["all","All"],["Chiropractic","Chiropractic"],["Med spa","Med spa"],["Acupuncture","Acupuncture"]].forEach(([v,l])=>{
      const c=el("button","chip",l); c.type="button"; c.setAttribute("aria-pressed",String(S.filter===v));
      c.onclick=()=>{ S.filter=v; renderSide(); };
      chips.appendChild(c);
    });
    head.appendChild(chips); w.appendChild(head);
    const list=el("div","list"); list.id="clist"; w.appendChild(list);
    paintList();
  }
  function paintList(){
    const list=$("#clist"); if(!list) return;
    list.textContent="";
    const rows=filtered();
    if(!rows.length){ list.appendChild(el("p","empty","No contacts match.")); return; }
    let letter="";
    rows.forEach((sc)=>{
      const L=lastName(sc.dm)[0].toUpperCase();
      if(L!==letter){ letter=L; list.appendChild(el("div","group",L)); }
      const r=el("button","row"); r.type="button";
      r.setAttribute("aria-current",String(sc.id===S.scen.id));
      r.appendChild(avatar(sc));
      const t=el("span","txt"); t.appendChild(el("b","",sc.dm));
      t.appendChild(el("span","",sc.firm)); r.appendChild(t);
      const end=el("span","end"); const v=el("span"); v.appendChild(el("i","vdot "+vclass(sc.vertical)));
      v.append(sc.city.split(",")[1]?.trim()||""); end.appendChild(v); r.appendChild(end);
      r.onclick=()=>selectContact(sc);
      list.appendChild(r);
    });
  }

  function scenFor(c){ return (c.sid&&findScenario(c.sid))||SCENARIOS.find(s=>s.firm===c.firm)||null; }
  function outcomeText(c){
    return c.outcome==="booked"?"Meeting booked":c.outcome==="hangup"?"They hung up · step "+(c.reached||1)
      :c.outcome==="wrapped"?"Follow-up · step "+(c.reached||1):"You ended · step "+(c.reached||1);
  }
  function whenText(iso){
    const d=new Date(iso); if(isNaN(d)) return "";
    return dayOf(iso)===today()?d.toLocaleTimeString([], {hour:"numeric",minute:"2-digit"}):d.toLocaleDateString([], {month:"short",day:"numeric"});
  }
  function renderRecents(w){
    const head=el("div","sidehead"); head.appendChild(el("h2","","Recents")); w.appendChild(head);
    const list=el("div","list"); w.appendChild(list);
    if(!S.calls.length){ list.appendChild(el("p","empty","No calls yet. Pick a contact and call.")); return; }
    S.calls.slice(0,60).forEach((c)=>{
      const sc=scenFor(c);
      const r=el("button","row"); r.type="button";
      r.appendChild(sc?avatar(sc):el("span","av","?"));
      const t=el("span","txt"); t.appendChild(el("b","",sc?sc.dm:c.firm));
      t.appendChild(el("span","",outcomeText(c))); r.appendChild(t);
      const end=el("span","end"); end.appendChild(el("span","",whenText(c.at)));
      const g=String(c.grade||"").toUpperCase(); if(g) end.appendChild(el("span","g "+g,g));
      r.appendChild(end);
      r.onclick=()=>{ if(sc) selectContact(sc); };
      list.appendChild(r);
      if(c.turns&&c.turns.length){
        const tb=el("button","ghostbtn small","Transcript"); tb.type="button";
        tb.onclick=(ev)=>{ ev.stopPropagation(); showTranscript(c,sc); };
        r.appendChild(tb);
      }
    });
  }

  // a past call, as it was heard
  function showTranscript(c,sc){
    if(S.phase==="live"){ flash("Finish this call first."); return; }
    S.phase="setup"; S.pane="main"; if(sc) S.scen=sc;
    const w=$("#stage"); w.textContent="";
    const box=el("div","sheet");
    const back=el("button","backlink"); back.type="button"; back.append(icon("back"),el("span","","Recents"));
    back.onclick=()=>{ S.pane="list"; renderSetup(); };
    box.appendChild(back);
    box.appendChild(el("p","eyebrow",(sc?sc.dm+" · "+sc.firm:c.firm)+" · "+whenText(c.at)+" · resistance "+c.diff+" · "+fmt(c.seconds||0)));
    box.appendChild(el("p","verdict",outcomeText(c)));
    if(c.fix) box.appendChild(el("p","sub","Next call: "+c.fix));
    const call=el("div","call");
    c.turns.forEach((t)=>{
      if(t.side==="beat"){ call.appendChild(el("div","beat",t.text)); return; }
      const d=el("div","turn "+t.side);
      d.appendChild(el("span","cue",t.side==="rep"?"You":(t.who==="dm"?(sc?sc.dm:"Decision maker"):(sc&&sc.gk?sc.gk:"Front desk"))));
      d.appendChild(el("p","said",t.text));
      if(t.side==="them"&&t.patience!=null) d.appendChild(el("span","meta","patience "+t.patience+"/10"+(t.objection&&t.objection!=="none"?" · "+t.objection.replace(/-/g," "):"")));
      call.appendChild(d);
    });
    box.appendChild(call);
    w.appendChild(box); paintBoard(); paintState();
  }

  const PADKEYS=[["1",""],["2","ABC"],["3","DEF"],["4","GHI"],["5","JKL"],["6","MNO"],["7","PQRS"],["8","TUV"],["9","WXYZ"],["*",""],["0","+"],["#",""]];
  function keypadGrid(onKey){
    const g=el("div","keypad");
    PADKEYS.forEach(([k,sub])=>{
      const b=el("button","dk"); b.type="button"; b.dataset.key=k;
      b.append(el("b","",k),el("small","",sub));
      b.onmousedown=(e)=>e.preventDefault();
      b.onclick=()=>{ phone.dtmf(k); onKey(k); };
      g.appendChild(b);
    });
    return g;
  }
  function dialMatch(){
    const d=digits(S.dial); if(d.length<4) return null;
    return SCENARIOS.find(sc=>digits(sc.phone).endsWith(d)||digits(sc.phone)===d)||null;
  }
  function renderDialer(w){
    const head=el("div","sidehead"); head.appendChild(el("h2","","Keypad")); w.appendChild(head);
    const box=el("div","dialer");
    const num=el("input","dialnum"); num.value=S.dial; num.placeholder="Enter a number"; num.inputMode="tel";
    num.setAttribute("aria-label","Number to dial");
    const match=el("div","dialmatch");
    const show=()=>{ const m=dialMatch(); match.textContent=m?m.dm+" · "+m.firm:(digits(S.dial).length>=4?"No contact at that number":""); };
    num.oninput=()=>{ S.dial=num.value.replace(/[^\d()+\-\s*#]/g,""); show(); };
    num.onkeydown=(e)=>{ if(e.key==="Enter") dialNow(); };
    box.appendChild(num); box.appendChild(match);
    box.appendChild(keypadGrid((k)=>{ S.dial+=k; num.value=S.dial; show(); }));
    const go=el("button","dialgo"); go.type="button"; go.setAttribute("aria-label","Call"); go.appendChild(icon("phone"));
    go.onclick=dialNow; box.appendChild(go);
    const pd=el("button","ghostbtn"); pd.type="button"; pd.append(icon("shuffle"),el("span","","Power dial a random contact"));
    pd.onclick=()=>{ if(S.phase==="live") return; S.scen=pickNext(); S.phase="setup"; startCall(); };
    box.appendChild(pd);
    box.appendChild(el("p","hint","Every contact’s number is on their card. Type one in to dial it."));
    w.appendChild(box); show();
  }
  function dialNow(){
    if(S.phase==="live") return;
    const m=dialMatch();
    if(!m){ const d=$(".dialmatch"); if(d) d.textContent=digits(S.dial).length?"No contact at that number":"Enter a number"; return; }
    S.scen=m; S.dial=""; S.phase="setup"; startCall();
  }
  // a different contact, favouring ones you haven't called today
  function pickNext(){
    const pool=filtered().length>1?filtered():SCENARIOS;
    const calledToday=new Set(S.calls.filter(c=>dayOf(c.at)===today()).map(c=>c.sid||c.firm));
    const fresh=pool.filter(sc=>sc.id!==S.scen.id&&!calledToday.has(sc.id)&&!calledToday.has(sc.firm));
    const from=fresh.length?fresh:pool.filter(sc=>sc.id!==S.scen.id);
    return from[Math.floor(Math.random()*from.length)]||S.scen;
  }

  /* ================= contact card (before the call) ================= */
  function renderSetup(){
    if(S.phase!=="setup") return;
    const sc=S.scen;
    const w=$("#stage"); w.textContent="";
    const box=el("div","profile");
    const back=el("button","backlink"); back.type="button"; back.append(icon("back"),el("span","","Contacts"));
    back.onclick=()=>{ S.pane="list"; paintBoard(); };
    box.appendChild(back);

    const head=el("div","phead");
    head.appendChild(avatar(sc,true));
    const who=el("div","who");
    who.appendChild(el("h1","",sc.dm));
    who.appendChild(el("span","firm",sc.firm));
    const meta=el("span","meta"); meta.appendChild(el("i","vdot "+vclass(sc.vertical))); meta.append(sc.vertical+" · "+sc.city);
    who.appendChild(meta);
    head.appendChild(who);
    box.appendChild(head);

    const row=el("div","callrow");
    const go=el("button","go"); go.type="button"; go.append(icon("phone"),el("span","","Call "+sc.phone));
    go.disabled=!S.cfg.brain;
    go.onclick=startCall;
    row.appendChild(go);
    const nx=el("button","ghostbtn"); nx.type="button"; nx.append(icon("next"),el("span","","Next contact"));
    nx.onclick=()=>selectContact(pickNext());
    row.appendChild(nx);
    box.appendChild(row);

    if(!S.cfg.brain){
      const wb=el("div","warnbox");
      wb.appendChild(el("strong","","The prospect can’t answer yet."));
      wb.appendChild(el("div","","Start the server with ANTHROPIC_API_KEY set, then reload this page."));
      box.appendChild(wb);
    }

    const info=el("div","card");
    info.appendChild(el("h3","","Contact"));
    const dl=el("dl","facts");
    const fact=(k,v)=>{ dl.appendChild(el("dt","",k)); const dd=el("dd"); if(v instanceof Node) dd.appendChild(v); else dd.textContent=v; dl.appendChild(dd); };
    fact("Name",sc.dm);
    fact("Practice",sc.firm);
    fact("Phone",sc.phone);
    fact("Location",sc.city);
    fact("In business",sc.years?sc.years+" years":"Unknown");
    const tags=el("div","tags"); (sc.services||[]).forEach(s=>tags.appendChild(el("span","tag",s)));
    fact("Services",tags);
    info.appendChild(dl);
    box.appendChild(info);

    const set=el("div","card");
    set.appendChild(el("h3","","Practice settings"));
    const seg=el("div","seg");
    ["Warm","Normal","Busy","Curt","Brutal"].forEach((lbl,i)=>{
      const b=el("button","",(i+1)+" · "+lbl); b.type="button";
      b.setAttribute("aria-pressed",String(S.diff===i+1));
      b.onclick=()=>{ S.diff=i+1; renderSetup(); };
      seg.appendChild(b);
    });
    set.appendChild(el("span","hint","Resistance — day one, run it verbatim at 2–3. Raise it once the script is muscle."));
    set.appendChild(seg);

    const lc=S.lineCheck;
    const line=el("div","checkline");
    const micText = lc.text || (!srOK?"This browser can’t hear you (use Chrome or Edge) — you can type"
      : S.mic==="denied"?"Mic blocked — allow it in the address bar" : "Mic not tested");
    const micDot = lc.dot || (!srOK||S.mic==="denied"?"bad":"");
    line.appendChild(el("span","dot "+micDot)); line.appendChild(el("span","",micText));
    line.appendChild(el("span","hint","·"));
    line.appendChild(el("span","dot "+(voiceOK()?"ok":"bad")));
    line.appendChild(el("span","",premium()?"Studio voices on":voiceOK()?"Browser voices":"No voice out here"));
    set.appendChild(line);
    const test=el("button","ghostbtn"); test.type="button"; test.append(icon("mic"),el("span","",lc.busy?"Testing…":"Test the line"));
    test.disabled=lc.busy;
    test.onclick=async()=>{
      unlockAudio();
      S.lineCheck={busy:true,text:"Asking for the mic…",dot:"wait"}; renderSetup();
      const ok=await askMic();
      if(S.phase!=="setup"){ S.lineCheck={busy:false,text:"",dot:""}; return; }
      S.lineCheck={busy:true,
        text: ok===true?"Mic ready":ok===null?"The browser will ask for the mic when you call":S.mic==="denied"?"Mic blocked — allow it in the address bar":"Mic unavailable",
        dot: ok===true?"ok":ok===null?"wait":"bad"};
      renderSetup();
      try{ await speakOnce("Line check. This is how the other end will sound.","dm"); }
      finally{ S.lineCheck={...S.lineCheck,busy:false}; renderSetup(); }
    };
    set.appendChild(test);
    set.appendChild(el("p","hint","Headphones help — without them the mic can hear the prospect. Nothing you press on the call is heard on the line."));
    box.appendChild(set);

    w.appendChild(box); paintBoard(); paintState();
  }

  /* ================= mic ================= */
  let rec=null, restarting=false;
  // true: mic ready · false: blocked/unavailable · null: can't check here, the recognizer will ask
  async function askMic(){
    if(!srOK){ S.mic="unsupported"; paintState(); return false; }
    if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia) return null;
    try{
      const st=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
      st.getTracks().forEach(t=>t.stop());
      if(S.mic==="denied") S.mic="idle";
      paintState(); return true;
    }catch(e){
      const n=e&&e.name;
      if(n==="NotAllowedError"||n==="SecurityError"){ S.mic="denied"; paintState(); return false; }
      paintState(); return false;
    }
  }

  // Result indices restart with every recognition session. `skip` marks results already
  // used; `seen` records when each result first appeared (for echo timing).
  function newSession(){ S.sr={len:0,skip:0,seen:[],dirty:false}; }
  // Throw away whatever the recognizer is still holding (unfinished words we've already
  // used, or talk during a ring): abort, and onend starts a fresh session.
  function freshSession(){
    if(!rec||S.mic!=="live") return;
    S.sr.skip=Infinity;                               // ignore anything the old session still reports
    S.sr.fresh=true;
    try{ rec.abort(); }catch(e){}
  }

  function startMic(){
    if(!srOK){ S.mic="unsupported"; showFallback(); paintState(); return; }
    S.srFails=[];
    try{
      rec=new SR();
      rec.continuous=true; rec.interimResults=true; rec.lang="en-US"; rec.maxAlternatives=1;
      rec.onresult=onHeard;
      rec.onerror=(e)=>{
        const c=e&&e.error;
        if(c==="no-speech"||c==="aborted") return;
        if(c==="not-allowed"||c==="service-not-allowed"){ micFailed("denied"); return; }
        srFailure();                                   // network, audio-capture, language-not-supported…
      };
      rec.onend=()=>{
        if(S.phase!=="live"||S.mic!=="live"||restarting) return;
        // a session that ended mid-word (error, timeout) keeps what it had heard
        if(S.interim.trim()){ S.heardSegs.push(S.interim.trim()); S.heard=S.heardSegs.join(" "); S.interim=""; }
        if(S.sr&&S.sr.fresh){                         // our own abort: restart at once so no words are lost
          try{ newSession(); rec.start(); return; }catch(e){ /* fall through to the delayed restart */ }
        }
        restarting=true;
        setTimeout(()=>{
          restarting=false;
          if(S.phase!=="live"||S.mic!=="live"||!rec) return;
          try{ newSession(); rec.start(); }catch(e){ srFailure(); }
        },60);
      };
      newSession(); rec.start(); S.mic="live"; paintState();
    }catch(e){ micFailed("failed"); }
  }
  function srFailure(){
    const now=Date.now();
    S.srFails=S.srFails.filter(t=>now-t<8000); S.srFails.push(now);
    if(S.srFails.length>=3) micFailed("failed");
  }
  function micFailed(state){
    if(S.tm||(S.heard+S.interim).trim()) endOfTurn();   // keep what you already said
    teardownRecognizer();
    S.mic=state;
    showFallback(); paintState();
    if(S.phase==="live"){
      flash(state==="denied"?"Mic blocked — type instead.":"Speech service unavailable — type instead.");
      armDeadAir();
    }
  }
  function teardownRecognizer(){
    clearTimeout(S.vadTimer); clearTimeout(specTimer); specTimer=null;
    S.heard=""; S.heardSegs=[]; S.interim=""; S.tm=null;
    try{ if(rec){ rec.onend=null; rec.onresult=null; rec.onerror=null; rec.abort(); } }catch(e){}
    rec=null;
  }
  function stopMic(){
    teardownRecognizer();
    if(S.mic==="live") S.mic="idle";
    paintState();
  }
  function showFallback(focus=true){
    const f=$("#fallback"); if(!f) return;
    f.hidden=false;
    if(focus&&S.phase==="live") setTimeout(()=>{ try{ $("#say").focus(); }catch(e){} },0);
  }

  /* --- echo rejection: is what we just heard actually the prospect's own voice? --- */
  function norm(s){ return String(s||"").toLowerCase().replace(/[^a-z0-9' ]/g," ").replace(/\s+/g," ").trim(); }
  const STOP=new Set("the and you your for this that with are was our not but what who how can has have just its it's i'm you're we're they're okay yeah yes sure well about from them they she her his him".split(" "));
  function isEcho(text,seenAt){
    if(!S.audible){
      if(Date.now()-S.lastSpokeEnd > ECHO_TAIL_MS) return false;
      if(seenAt!=null && seenAt-S.lastSpokeEnd > SR_LAG_MS+200) return false;   // started after they stopped: that's you
    }
    const heard=norm(text), src=new Set(norm(S.spokenNow).split(" "));
    if(!heard||src.size<=1) return false;
    let hw=heard.split(" ").filter(w=>w.length>2&&!STOP.has(w));
    if(!hw.length) hw=heard.split(" ").filter(w=>w.length>2);   // "Who are you with?" is all stopwords
    if(!hw.length) return true;                       // a grunt while, or just after, they talk: drop it
    let hit=0; hw.forEach(w=>{ if(src.has(w)) hit++; });
    return (hit/hw.length) >= 0.6;                     // mostly their words coming back
  }

  /* --- how you sound: latency, fillers, restarts, pauses, pace --- */
  const FILLER=/\b(u+m+|u+h+|uhm|erm|er+|ah+|hmm+|mm+|you know|i mean|kind of|sort of|like,|basically)\b/gi;
  const TRAILING=/\b(and|so|but|or|because|um+|uh+|er+|the|a|an|to|of|with|if|just|kind of|sort of|my|our|your)$/i;
  function measure(text,tm){
    const words=norm(text).split(" ").filter(Boolean);
    const fillers=(text.match(FILLER)||[]).map(f=>{ f=f.toLowerCase().replace(/,$/,""); return /^[aeiouhmr]+$/.test(f)?f.replace(/(.)\1+/g,"$1"):f; });
    let restarts=0;
    for(let i=1;i<words.length;i++) if(words[i]===words[i-1]&&words[i].length<=4&&!/^(no|very|ha)$/.test(words[i])) restarts++;
    restarts+=(text.match(/\b(let me rephrase|what i mean is|i mean to say|scratch that|let me start over)\b/gi)||[]).length;
    const durMs=Math.max(400,(tm.lastAt-tm.firstAt)+SR_LAG_MS);
    return {
      barged:tm.barged,
      startedAfterMs:tm.barged?null:tm.startedAfterMs,
      fillers, restarts, pauses:tm.pauses,
      words:words.length,
      wpm:words.length>=4?Math.round(words.length/(durMs/60000)):null
    };
  }

  function onHeard(e){
    if(S.phase!=="live"||!S.sr) return;
    const sr=S.sr, now=Date.now();
    if(S.ringing){ sr.dirty=true; return; }          // talking over the ring doesn't count; dropped when it ends
    sr.len=e.results.length;
    const finals=[]; let inter="";
    for(let i=e.resultIndex;i<e.results.length;i++){
      if(i<sr.skip) continue;                          // already used in an earlier turn
      const r=e.results[i], t=r[0].transcript;
      if(sr.seen[i]==null) sr.seen[i]=now;
      if(isEcho(t,sr.seen[i])) continue;               // their own voice coming back through the mic
      if(r.isFinal){ if(t.trim()) finals.push(t.trim()); }
      else inter+=" "+t;
    }
    inter=inter.trim();
    const all=(finals.join(" ")+" "+inter).trim();
    if(!all) return;
    S.srFails=[];

    const wasTalking=S.audible, wasQueued=S.speaking;
    if(S.speaking){                                    // barge-in (or their reply hadn't started playing yet)
      if(norm(all).split(" ").filter(Boolean).length<2) return;   // a cough isn't an interruption
      cutThemOff();
    }

    if(!S.tm){                                         // first words of a new turn
      S.tm={firstAt:now,lastAt:now,pauses:0,barged:wasTalking,
        startedAfterMs:(S.lastSpokeEnd&&!S.busy&&!wasQueued)?Math.max(0,now-SR_LAG_MS-S.lastSpokeEnd):null};
    }else{
      if(now-S.tm.lastAt>PAUSE_MS) S.tm.pauses++;
      S.tm.lastAt=now;
    }
    clearDeadAir();

    finals.forEach((t)=>{
      const prev=S.heardSegs[S.heardSegs.length-1];
      // Android repeats finals cumulatively ("is", "is Lindsay", "is Lindsay around")
      if(IS_ANDROID&&prev&&norm(t).startsWith(norm(prev))) S.heardSegs[S.heardSegs.length-1]=t;
      else S.heardSegs.push(t);
    });
    S.heard=S.heardSegs.join(" ");
    S.interim=inter;
    const sofar=(S.heard+" "+S.interim).trim();
    if(S.spec&&norm(sofar)!==norm(S.spec.text)) cancelSpec();   // you kept going
    const base=S.step>=3?SILENCE_PITCH_MS:SILENCE_MS;
    S.eotMs=TRAILING.test(sofar.replace(/[.,!?…\s]+$/,""))?TRAILING_MS:base;
    updateMouth();
    clearTimeout(S.vadTimer); clearTimeout(specTimer);
    S.vadTimer=setTimeout(endOfTurn,S.eotMs);
    if(!S.spec&&S.eotMs===base) specTimer=setTimeout(startSpec,SPEC_MS);
  }

  // Take what you've said so far off the recognizer, and remember it was used
  // so a late final for the same words isn't heard twice.
  function consumeUtterance(){
    const text=(S.heard+" "+S.interim).trim(), tm=S.tm, sr=S.sr;
    const unfinished=!!S.interim;
    if(sr) sr.skip=sr.len;
    S.heard=""; S.heardSegs=[]; S.interim=""; S.tm=null;
    if(unfinished) freshSession();                   // the recognizer would re-send those words when it finalizes
    clearTimeout(S.vadTimer); clearTimeout(specTimer); specTimer=null;
    return {text,tm};
  }

  /* --- speculative reply: generate during the end-of-turn pause, release on commit --- */
  let specTimer=null;
  function startSpec(){
    specTimer=null;
    if(S.phase!=="live"||S.spec||S.busy||S.hold||S.ringing||S.speaking||!S.tm) return;
    const text=(S.heard+" "+S.interim).trim(); if(!text) return;
    flushNotes();
    let release; const gate=new Promise(r=>{ release=r; });
    const turn={side:"rep",text,meta:measure(text,S.tm),pending:true};
    S.turns.push(turn);
    S.spec={text,turn,release};
    askProspect(false,{gate});
  }
  function cancelSpec(){
    const sp=S.spec; if(!sp) return;
    S.spec=null;
    S.reqSeq++; try{ S.ctl&&S.ctl.abort(); }catch(e){} S.busy=false;
    const i=S.turns.indexOf(sp.turn); if(i>=0) S.turns.splice(i,1);
    sp.release(false);
  }
  function commitSpec(text){
    const sp=S.spec; if(!sp) return false;
    if(norm(text)!==norm(sp.text)){ cancelSpec(); return false; }
    S.spec=null; delete sp.turn.pending;
    clearDeadAir(); S.silences=0;
    renderCall(); paintState();
    sp.release(true); armFiller();
    return true;
  }

  function endOfTurn(){
    const {text,tm}=consumeUtterance();
    if(!text||S.phase!=="live"){ cancelSpec(); updateMouth(); return; }
    if(commitSpec(text)){ updateMouth(); return; }
    sendLine(text,tm?measure(text,tm):null);
  }

  /* ================= speaking ================= */
  // Each clause is queued as it streams in. With studio voices its audio is
  // fetched immediately (in parallel) so playback runs back to back.
  let queue=[], speakingChain=false, gen=0, audioCtl=new AbortController();   // gen: bumped on barge-in so late chunks die
  function say(text,sex,done,onStart){
    let finished=false, wd=null, u=null;
    const fin=()=>{ if(finished) return; finished=true; clearTimeout(wd); done&&done(); };
    if(!TTS){ fin(); return; }
    u=new SpeechSynthesisUtterance(text.replace(/\s*[—–]\s*/g,", "));
    const v=pickVoice(sex); if(v) u.voice=v;
    u.rate=1.07; u.pitch = sex==="m"?0.95:1.03;
    u.onstart=()=>{ onStart&&onStart(); };
    u.onend=fin; u.onerror=fin;
    say.live=u;                                        // keep a reference: some engines drop unreferenced utterances
    wd=setTimeout(fin,2500+text.length*90);           // some engines never fire end at all
    try{ TTS.speak(u); }catch(e){ fin(); }
  }
  function sexOf(role){ return role==="dm"?(S.scen.dmVoice||"f"):role==="rep"?"m":(S.scen.gkVoice||"f"); }
  function fetchVoice(text,role,previous,signal){
    const sig = AbortSignal.timeout&&AbortSignal.any ? AbortSignal.any([signal||new AbortController().signal,AbortSignal.timeout(5000)]) : signal;
    return fetch("api/tts",{method:"POST",headers:{"Content-Type":"application/json"},signal:sig,
      body:JSON.stringify({scenarioId:S.scen.id,role,text,previous})})
      .then(r=>{ if(!r.ok) throw new Error("tts "+r.status); return r.blob(); })
      .then(b=>URL.createObjectURL(b));
  }
  // one-off line outside a call (line test, "Hear it")
  async function speakOnce(text,role,sex){
    try{ TTS&&TTS.cancel(); }catch(e){}
    if(premium()){
      try{
        const url=await fetchVoice(text,role,"");
        const ok=await phone.playThroughLine(url);
        URL.revokeObjectURL(url);
        if(ok) return;
      }catch(e){}
    }
    await new Promise(r=>say(text,sex||sexOf(role),r));
  }

  function beginSpeaking(){ S.speaking=true; S.spokenNow=""; S.played=""; clearDeadAir(); paintState(); }

  /* --- a short acknowledgement in their own voice while the reply is on its way --- */
  const FILLERS={ dm:["Mm-hm.","Okay.","Hm.","Right."], gk:["Mm-hm.","Okay.","Sure.","Hm."] };
  let fillerBank={dm:[],gk:[]}, fillerTimer=null, fillerLive=false;
  function primeFillers(role){
    if(!premium()) return;
    if(fillerBank[role].length>=2) return;
    FILLERS[role].forEach((t)=>{
      fetchVoice(t,role,"",S.callCtl&&S.callCtl.signal).then((url)=>{ if(S.phase==="live") fillerBank[role].push({t,url}); else URL.revokeObjectURL(url); }).catch(()=>{});
    });
  }
  function armFiller(){
    cancelFiller();
    if(!premium()||S.studioDown||S.hold||S.ringing) return;
    fillerTimer=setTimeout(playFiller,FILLER_MS);
  }
  function cancelFiller(){ clearTimeout(fillerTimer); fillerTimer=null; }
  async function playFiller(){
    fillerTimer=null;
    const role=S.who==="dm"?"dm":"gk", bank=fillerBank[role];
    if(S.phase!=="live"||S.audible||!S.busy||S.hold||S.ringing||!bank.length||(S.heard+S.interim).trim()) return;
    const pick=bank.splice(Math.floor(Math.random()*bank.length),1)[0];
    fillerLive=true; S.speaking=true; S.audible=true; S.spokenNow+=" "+pick.t; paintState();
    const myGen=gen;
    await phone.playThroughLine(pick.url,audioCtl.signal);
    URL.revokeObjectURL(pick.url); fillerLive=false;
    if(myGen!==gen||S.phase!=="live") return;
    S.lastSpokeEnd=Date.now();
    if(!queue.length&&!speakingChain){ S.audible=false; if(!S.busy) finishSpeaking(); else paintState(); }
    primeFillers(role);
  }
  function speakChunk(chunk,role,myGen){
    if(!chunk.trim()||myGen!==gen) return;
    const previous=S.spokenNow.trim();
    S.spokenNow += " "+chunk;
    if(!S.speaking){ S.speaking=true; paintState(); }
    const item={t:chunk,role,g:myGen};
    if(premium()&&!S.studioDown) item.url=fetchVoice(chunk,role,previous,audioCtl.signal).catch(()=>null);
    queue.push(item);
    drain();
  }
  function drain(){
    if(speakingChain||!queue.length) return;
    const item=queue.shift();
    if(item.g!==gen){ drain(); return; }
    speakingChain=true;
    let begun=false;
    const started=()=>{ if(begun||item.g!==gen) return; begun=true; cancelFiller(); S.audible=true; S.played=(S.played+" "+item.t).trim(); };
    const next=()=>{
      if(item.g!==gen) return;                    // cut off; hushAudio already reset the chain
      speakingChain=false;
      if(queue.length) drain(); else finishSpeaking();
    };
    const browserVoice=()=>{ started(); say(item.t,sexOf(item.role),next,started); };
    if(item.url){
      const sig=audioCtl.signal;
      item.url.then(async(url)=>{
        if(item.g!==gen){ if(url) URL.revokeObjectURL(url); return; }
        if(url){
          const ok=await phone.playThroughLine(url,sig,started);
          URL.revokeObjectURL(url);
          if(ok||item.g!==gen){ next(); return; }
        }
        if(!sig.aborted) S.studioDown=true;        // studio voice failed: browser voice for the rest of this call
        browserVoice();
      });
    }else browserVoice();
  }
  function finishSpeaking(){
    if(queue.length||speakingChain) return;
    if(!S.speaking) return;
    S.speaking=false; S.audible=false; S.lastSpokeEnd=Date.now(); paintState(); updateMouth();
    armDeadAir();
  }
  function hushAudio(){
    gen++;
    queue.forEach(it=>{ if(it.url) it.url.then(u=>{ if(u) URL.revokeObjectURL(u); }); });
    queue=[]; speakingChain=false; S.audible=false; cancelFiller();
    audioCtl.abort(); audioCtl=new AbortController();
    try{ TTS&&TTS.cancel(); }catch(e){}
  }
  function cutThemOff(){
    if(!S.speaking&&!queue.length&&!speakingChain) return false;
    const wasAudible=S.audible;
    hushAudio();
    if(S.busy) S.cutReq=S.reqSeq;               // its reply is still streaming: keep listening for the tag
    // keep only what they actually got out before you cut in
    for(let i=S.turns.length-1;i>=0;i--){
      const t=S.turns[i];
      if(t.side!=="them") continue;
      const said=(S.played||"").trim();
      if(!said) S.turns.splice(i,1);             // not a word of theirs was heard
      else { t.cut=true; if(said.length<t.text.length) t.text=said; }
      break;
    }
    S.speaking=false;
    if(wasAudible) S.lastSpokeEnd=Date.now();
    paintState(); renderCall();
    armDeadAir();
    return true;
  }
  function quiet(){ return !S.speaking&&!queue.length&&!speakingChain; }
  function whenQuiet(fn){
    let n=0;
    const t=setInterval(()=>{
      n++;
      if(S.phase!=="live"){ clearInterval(t); return; }
      if(quiet()||n>80){ clearInterval(t); fn(); }
    },200);
    return t;
  }

  /* ================= call-ending events (hang-up, booked, transfer) ================= */
  function queueEvent(ev){
    cancelEvent();
    S.hold=true; S.pendingEv=ev;
    const tok=S.evSeq;
    if(ev==="transferred"){ S.pendingQuiet=whenQuiet(()=>{ if(tok===S.evSeq) transfer(tok); }); return; }
    S.outcome = ev==="rep-ended" ? "wrapped" : ev;
    S.pendingQuiet=whenQuiet(()=>{ if(tok===S.evSeq) endCall(S.outcome); });
  }
  function cancelEvent(){
    S.evSeq++;
    clearInterval(S.pendingQuiet); S.pendingQuiet=null;
    try{ S.xferCtl&&S.xferCtl.abort(); }catch(e){} S.xferCtl=null;
    if(S.ringing&&S.phase==="live"&&S.turns.some(t=>t.side==="them")) S.ringing=false;
    S.hold=false; S.pendingEv=null; S.outcome=null;
  }

  // gatekeeper put you through: a ring, then the decision maker picks up and speaks first
  async function transfer(tok){
    if(S.phase!=="live"||tok!==S.evSeq) return;
    beat("On hold — transferring…");
    S.ringing=true; paintState();
    S.xferCtl=new AbortController();
    await phone.ring(1,AbortSignal.any?AbortSignal.any([S.callCtl.signal,S.xferCtl.signal]):S.callCtl.signal);
    if(S.phase!=="live"||tok!==S.evSeq) return;
    S.ringing=false; S.xferCtl=null; if(S.sr&&S.sr.dirty) freshSession();
    S.who="dm"; S.hold=false; S.pendingEv=null; primeFillers("dm");
    beat(S.scen.dm+" picks up.");
    flushNotes();
    S.turns.push({side:"note",xfer:true,text:"[Your front desk just put the Levitate caller through to you. You pick up the phone.]",shown:""});
    askProspect(false);
  }

  /* ================= dead air ================= */
  function armDeadAir(){
    clearDeadAir();
    if(S.phase!=="live"||S.busy||S.ringing||S.speaking||S.hold) return;
    const ms = S.mic==="live" ? DEAD_AIR_MS : DEAD_AIR_TYPED_MS;
    S.deadAir=setTimeout(()=>{
      S.deadAir=null;
      if(S.phase!=="live"||S.busy||S.speaking||S.ringing||S.hold||S.tm||(S.heard+S.interim).trim()||$("#say").value.trim()) return;
      S.silences++;
      const secs=Math.round(ms/1000);
      flushNotes();
      S.turns.push({side:"note",text:"[silence: the rep has said nothing for "+secs+" seconds]",shown:"Dead air — "+secs+"s"});
      renderCall();
      askProspect(false);
    },ms);
  }
  function clearDeadAir(){ clearTimeout(S.deadAir); S.deadAir=null; }

  /* ================= the call ================= */
  function startCall(){
    try{ TTS&&TTS.cancel(); }catch(e){}
    phone.stopPlayback();
    unlockAudio();
    if(S.spec){ S.spec.release(false); S.spec=null; }
    cancelEvent();
    S.phase="live"; S.who=S.scen.open; S.step=S.scen.open==="dm"?2:1; S.reached=1;
    S.turns=[]; S.peeks=0; S.retries=0; S.outcome=null; S.teardown=null; S.silences=0; S.peekMood=false;
    S.lastSpokeEnd=0; S.spokenNow=""; S.played=""; S.audible=false; S.pendingNotes=[]; S.endedAt=0;
    S.liveThem=null; S.studioDown=false;
    S.reqSeq++; S.cutReq=-1; S.queuedAsk=false; S.busy=false;
    S.lastId="c"+Date.now().toString(36); S.callAt=""; S.peekStep=null; S.heard=""; S.heardSegs=[]; S.interim=""; S.tm=null;
    S.callCtl=new AbortController();
    startClock(); renderKeys(); paintBoard(); paintList(); renderCall(); renderRail();
    $("#fallback").hidden = srOK && S.mic!=="denied";
    if(!$("#fallback").hidden) showFallback();
    startMic();
    fillerBank={dm:[],gk:[]}; primeFillers(S.who==="dm"?"dm":"gk");
    beat("Calling "+S.scen.phone+"…");
    askProspect(true);
  }

  function beat(txt,dir){ S.turns.push({side:"beat",text:txt,dir:!!dir}); renderCall(); }

  function whoLabel(who){
    return who==="dm" ? S.scen.dm : (S.scen.gk||"Front desk");
  }

  let mouthBox=null, mouthLine=null, vadBar=null;

  function visible(t){ return t.side!=="director"&&!t.pending&&!(t.side==="note"&&!t.shown); }
  function turnNode(t){
    if(t.side==="beat") return el("div","beat"+(t.dir?" dir":""),t.text);
    if(t.side==="note") return el("div","beat",t.shown);
    const d=el("div","turn "+t.side+(t.flagged?" flagged":""));
    d.appendChild(el("span","cue",t.side==="rep"?"You":whoLabel(t.who)));
    const p=el("p","said"); p.textContent=t.text;
    if(t.cut) p.appendChild(el("span","cut"," ——"));
    d.appendChild(p);
    return d;
  }

  // script line + patience read-out, shown in the rail (or on the stage on phones)
  function peekNodes(){
    const out=[];
    const peekStep=(S.peekStep&&S.peekStep.n===S.step)?S.peekStep:null;
    if(peekStep) out.push(el("div","peek",peekStep.line));
    if(S.peekMood){
      const lt=[...S.turns].reverse().find(t=>t.side==="them"&&t.patience!=null);
      const mm=el("div","meter"); const ml=el("div","lbl");
      ml.appendChild(el("span","","Their patience"));
      ml.appendChild(el("span","",lt?lt.patience+" / 10":"—"));
      mm.appendChild(ml);
      const tr=el("div","track"); const fl=el("div","fill");
      fl.style.width=(lt?lt.patience*10:0)+"%";
      if(lt&&lt.patience<=3) fl.style.background="var(--crit)"; else if(lt&&lt.patience<=6) fl.style.background="var(--warn)";
      tr.appendChild(fl); mm.appendChild(tr);
      if(lt&&lt.objection&&lt.objection!=="none") mm.appendChild(el("p","hint","Last objection: "+lt.objection.replace(/-/g," ")));
      out.push(mm);
    }
    return out;
  }

  function renderCall(){
    if(S.phase!=="live") { mouthBox=null; return; }
    const w=$("#stage"); w.textContent="";
    const c=el("div","call");
    c.appendChild(el("div","slug","Outbound call · "+S.scen.firm));

    S.turns.forEach((t)=>{ if(visible(t)) c.appendChild(turnNode(t)); });

    const m=el("div","mouth");
    if(NARROW.matches){ const pk=peekNodes(); if(pk.length){ const box=el("div","stagepeek"); pk.forEach(n=>box.appendChild(n)); m.appendChild(box); } }
    mouthBox=el("div","mouthbox idle");
    mouthBox.appendChild(el("span","cue","You"));
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
        S.ringing?"Ringing…"
        :S.speaking?"They’re talking — cut in whenever you like."
        :S.busy&&!S.spec?"…"
        :S.mic==="live"?"Listening…"
        :"Type your line below.";
    }
    if(!vadBar) return;
    vadBar.style.transition="none";
    vadBar.style.transform=live?"scaleX(1)":"scaleX(0)";
    if(live) requestAnimationFrame(()=>{
      if(!vadBar) return;
      vadBar.style.transition="transform "+S.eotMs+"ms linear";
      vadBar.style.transform="scaleX(0)";
    });
  }

  function sendLine(text,meta){
    text=String(text||"").trim();
    if(!text||S.phase!=="live") return;
    const turn={side:"rep",text:text,meta:meta||{typed:true}};
    if(S.hold||S.ringing){                        // call is ending or being transferred
      if(S.pendingEv==="transferred"){ S.turns.push(turn); $("#say").value=""; renderCall(); }
      return;
    }
    cancelSpec(); clearDeadAir(); S.silences=0;
    if(S.busy&&(S.speaking||queue.length||speakingChain)) cutThemOff();
    if(S.busy&&S.cutReq===S.reqSeq){              // you cut in while their reply was still arriving:
      flushNotes(); S.turns.push(turn);           // let it finish (its tag may end the call), then answer
      S.queuedAsk=true; $("#say").value=""; renderCall(); return;
    }
    if(S.busy){ dropUnheardReply(); try{S.ctl&&S.ctl.abort();}catch(e){} S.reqSeq++; S.busy=false; }
    cutThemOff();
    flushNotes();
    S.turns.push(turn);
    $("#say").value=""; renderCall();
    askProspect(false); if(!turn.meta.typed) armFiller();
  }
  function lastRepIndex(){
    for(let i=S.turns.length-1;i>=0;i--) if(S.turns[i].side==="rep"&&!S.turns[i].pending) return i;
    return -1;
  }
  // a reply we're abandoning before a word of it was heard leaves no trace
  function dropUnheardReply(){
    const lt=S.liveThem; S.liveThem=null;
    if(!lt||lt.req!==S.reqSeq||S.audible||(S.played||"").trim()) return;
    const i=S.turns.indexOf(lt.turn); if(i>=0) S.turns.splice(i,1);
  }
  function flushNotes(){ if(S.pendingNotes.length){ S.turns.push(...S.pendingNotes); S.pendingNotes=[]; } }

  /* ================= prospect ================= */
  // what the server needs to rebuild the conversation
  function transcript(){
    const out=[];
    S.turns.forEach((t)=>{
      if(t.side==="rep") out.push({side:"rep",text:t.text,flagged:!!t.flagged,meta:t.meta||null});
      else if(t.side==="them") out.push({side:"them",text:t.text,cut:!!t.cut,patience:t.patience??null,objection:t.objection||null,tag:t.tag||null});
      else if(t.side==="director"||t.side==="note") out.push({side:t.side,text:t.text});
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
    let buf="", text="", done=false;
    for(;;){
      const {value,done:end}=await rd.read();
      if(end) break;
      buf+=dec.decode(value,{stream:true});
      let nl;
      while((nl=buf.indexOf("\n"))>=0){
        const line=buf.slice(0,nl).trim(); buf=buf.slice(nl+1);
        if(!line) continue;
        const m=JSON.parse(line);
        if(m.delta){ text+=m.delta; onText(text); }
        else if(m.done) done=true;
        else if(m.error) throw Object.assign(new Error(m.message||m.error),{code:m.error});
      }
    }
    if(!done) throw Object.assign(new Error("stream ended early"),{code:"error"});
    return text;
  }

  const TAG=/\[\[\s*(gatekeeper|dm)\s*\|\s*([1-5])\s*\|\s*(none|transferred|booked|hangup)\s*(?:\|\s*(\d{1,2})?\s*)?(?:\|\s*([^\]|]*?)\s*)?\]\]/i;
  const slug=(x)=>String(x||"").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,40)||null;

  async function askProspect(firstTurn,opts={}){
    clearDeadAir();
    S.busy=true; paintState();

    const role = S.who==="dm" ? "dm" : "gk";
    const sayer = S.who;
    const myReq=++S.reqSeq;
    S.played="";                                       // what the rep has heard of THIS reply
    const ctl=S.ctl=new AbortController();
    const myGen=gen;
    const stale=()=>myReq!==S.reqSeq||S.phase!=="live";   // superseded: a newer request owns S.busy
    const cut=()=>myGen!==gen;                              // you cut in: stop voicing, still read the tag

    // The reply is generated right away but may be held back: behind the ring on the
    // first turn, or until your end-of-turn pause is confirmed on a speculative turn.
    let open=true, lastWhole="", gateP=null;
    const waits=[];
    if(firstTurn){
      S.ringing=true; paintState();
      waits.push(phone.ring(1+(Math.random()<0.4?1:0),S.callCtl.signal).then(()=>{
        if(S.phase!=="live") return;
        S.ringing=false; if(S.sr&&S.sr.dirty) freshSession();
        beat("Connected.");
        paintState();
      }));
    }
    if(opts.gate) waits.push(opts.gate);
    if(waits.length){
      open=false;
      gateP=Promise.all(waits).then(()=>{ open=true; if(lastWhole) feed(lastWhole); });
    }

    let spokenUpTo=0, started=false, themTurn=null, tagSeen=false, liveP=null, chunks=0;
    const feed=(whole)=>{
      if(stale()||cut()) return;
      const tagAt=whole.indexOf("[[");
      let speakable = tagAt>=0 ? whole.slice(0,tagAt) : whole;
      if(tagAt>=0) tagSeen=true;
      if(!tagSeen) speakable=speakable.replace(/\[$/,"");  // a tag may be starting

      // voice each clause the moment it lands, so there's no dead air.
      // Studio voices sound best in whole sentences; the first chunk may break at a comma.
      const rest=speakable.slice(spokenUpTo);
      const soft = !premium() || chunks===0;
      const m = soft ? /[.!?…,;:](\s|$)/g : /[.!?…](\s|$)/g;
      let mm, last=-1;
      while((mm=m.exec(rest))!==null){ if(!soft||mm.index>=10||/[.!?…]/.test(rest[mm.index])) last=mm.index+1; }
      let cutAt = last>0 ? spokenUpTo+last : (tagSeen&&speakable.length>spokenUpTo ? speakable.length : -1);
      if(cutAt>spokenUpTo){
        const chunk=speakable.slice(spokenUpTo,cutAt).trim();
        spokenUpTo=cutAt;
        if(chunk){
          if(!started){ started=true; beginSpeaking(); }
          chunks++;
          speakChunk(chunk,role,myGen);
        }
      }

      const shown=speakable.trim();
      if(!shown) return;
      if(!themTurn){
        themTurn={side:"them",text:shown,who:sayer};
        S.turns.push(themTurn); S.liveThem={req:myReq,turn:themTurn};
        renderCall();
        const all=$("#stage").querySelectorAll(".turn.them .said");
        liveP=all[all.length-1]||null;
      }else{
        themTurn.text=shown;
        if(liveP&&liveP.isConnected) liveP.textContent=shown; else renderCall();
      }
    };

    const followUp=()=>{ if(S.queuedAsk&&S.phase==="live"&&!S.hold){ S.queuedAsk=false; askProspect(false); } else S.queuedAsk=false; };

    try{
      const raw=await streamProspect({scenarioId:S.scen.id,diff:S.diff,who:S.who,
        seed:S.lastId,turns:firstTurn?[]:transcript()},ctl.signal,(whole)=>{ lastWhole=whole; if(open) feed(whole); });
      if(gateP) await gateP;
      if(stale()) return;
      S.busy=false;
      const wasCut=cut();
      const tag=TAG.exec(raw);
      const spoken=raw.replace(/\[\[[\s\S]*$/,"").trim();
      if(!wasCut){
        if(!spoken&&!(tag&&tag[3].toLowerCase()==="hangup")){
          S.lastSpokeEnd=0; flushNotes();
          beat(S.turns.some(t=>t.side==="them")?"Line noise. Press R and say that again.":"Line noise. Press R to get them back.","dir");
          paintState(); return;
        }
        tagSeen=true; feed(raw.includes("[[")?raw:raw+"[[");      // voice whatever's still unsaid
        if(spoken){
          if(!themTurn){ themTurn={side:"them",text:spoken,who:sayer}; S.turns.push(themTurn); }
          else themTurn.text=spoken;
        }
      }

      const who = tag?tag[1].toLowerCase():S.who;
      const stp = Math.min(5,Math.max(1,tag?parseInt(tag[2],10):S.step));
      let ev    = tag?tag[3].toLowerCase():"none";
      const pat = tag&&tag[4]!=null?Math.min(10,Math.max(0,parseInt(tag[4],10))):null;
      const obj = tag?slug(tag[5]):null;
      if(ev==="booked"&&sayer!=="dm"&&!S.scen.gkBooks) ev="none";   // only a decision maker can book
      if(ev==="transferred"&&(sayer!=="gatekeeper"||!S.scen.gk)) ev="none";   // only the gatekeeper can transfer
      if(!tag&&/\[\[[^\]]*rep-ended/i.test(raw)) ev="rep-ended";
      if(pat===0&&ev==="none") ev="hangup";                   // out of patience means gone
      if(ev==="hangup"&&obj==="rep-ended") ev="rep-ended";     // you wrapped it up; not an objection
      const keep=themTurn&&S.turns.includes(themTurn);
      if(keep&&tag) Object.assign(themTurn,{patience:pat,objection:ev==="rep-ended"?null:obj,
        tag:{who,step:stp,ev:ev==="rep-ended"?"hangup":ev}});
      S.who=S.scen.gk?who:"dm"; S.step=stp; S.reached=Math.max(S.reached,S.step);
      flushNotes();
      renderCall(); paintBoard(); renderRail();

      if(ev!=="none"){ S.queuedAsk=false; queueEvent(ev); }
      else if(wasCut) followUp();                             // your line (spoken over them) gets its answer now
      if(quiet()) finishSpeaking();
      paintState();
      if(ev==="none"&&quiet()&&!S.busy) armDeadAir();
    }catch(e){
      const aborted=(e&&e.name==="AbortError")||(e&&e.code==="cancelled");
      if(gateP&&!aborted) await gateP;
      if(stale()){ return; }
      S.busy=false;
      paintState();
      if(aborted){ renderCall(); return; }
      if(cut()&&S.queuedAsk){ followUp(); return; }
      S.lastSpokeEnd=0; flushNotes();
      const msg = e&&e.code==="not_granted" ? "The server has no working Anthropic API key — the prospect can’t speak."
        : e&&e.code==="rate_limited" ? "Too many calls too fast. Give it a minute."
        : S.turns.some(t=>t.side==="them") ? "The line dropped. Press R to run that line again."
        : "The line dropped. Press R to get them back.";
      beat(msg,"dir"); renderCall();                    // R or your next line recovers; no dead-air strike for our failure
    }
  }

  /* ================= silent channel ================= */
  const KEYS=[
    {k:"M",label:"Mute",icon:"mic",fn:toggleMic},
    {k:"K",label:"Keypad",icon:"keypad",fn:togglePad},
    {k:"R",label:"Retry line",icon:"retry",fn:retryLine},
    {k:"B",label:"Cut in",icon:"cut",fn:()=>{ if(!cutThemOff()) flash("Nobody’s talking."); }},
    {k:"F",label:"Flag",icon:"flag",fn:flagLine},
    {k:"/",label:"Script",icon:"script",fn:peek},
    {k:"T",label:"Read room",icon:"room",fn:peekMood},
    {k:"H",label:"Harder",icon:"up",fn:()=>nudge(1)},
    {k:"E",label:"Easier",icon:"down",fn:()=>nudge(-1)},
    {k:"X",label:"End call",icon:"hang",fn:()=>endCall("hungup"),danger:true}
  ];
  function renderKeys(){
    const w=$("#keys"); w.textContent="";
    KEYS.forEach((it)=>{
      const b=el("button","ctrl"+(it.danger?" end":"")); b.type="button"; b.dataset.k=it.k;
      b.title=it.label+" ("+it.k+")";
      const i=el("i"); i.appendChild(icon(it.icon)); i.appendChild(el("kbd","",it.k));
      b.appendChild(i); b.appendChild(el("span","",it.label));
      b.onmousedown=(ev)=>ev.preventDefault();          // never keep focus: the next keystroke is yours
      b.onclick=(ev)=>{ ev.preventDefault(); it.fn(); };
      w.appendChild(b);
    });
    S.padOpen=false; paintPad();
    flash(HINT);
  }
  // in-call keypad: local tones only, the prospect never hears them
  function togglePad(){ S.padOpen=!S.padOpen; paintPad(); }
  function paintPad(){
    const p=$("#pad"); p.textContent=""; p.hidden=!S.padOpen;
    const kb=document.querySelector('.ctrl[data-k="K"]'); if(kb) kb.setAttribute("aria-pressed",String(S.padOpen));
    if(S.padOpen) p.appendChild(keypadGrid(()=>{}));
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
      if(e.key==="Escape"){ e.target.blur(); flash("Shortcut keys on — click the box to type."); return; }
      if(S.deadAir) armDeadAir();                        // typing buys time
      return;                                            // every other key is typing
    }
    if(e.target&&e.target.tagName==="BUTTON"&&(e.key===" "||e.key==="Enter")) return;
    if(S.padOpen&&/^[0-9*#]$/.test(e.key)){ e.preventDefault(); phone.dtmf(e.key); return; }
    const k=e.key.toUpperCase();
    const hit=KEYS.find(it=>it.k===k||(it.k==="/"&&(e.key==="/"||e.key==="?")));
    if(hit){ e.preventDefault(); hit.fn(); }
  });

  function restoreSpeaker(){
    let li=-1;
    for(let k=S.turns.length-1;k>=0;k--) if(S.turns[k].side==="them"&&S.turns[k].tag){ li=k; break; }
    const last=li>=0?S.turns[li]:null;
    const pickedUp=S.turns.slice(li+1).some(t=>t.xfer);
    if(last){
      S.step=last.tag.step;
      S.who= pickedUp ? "dm" : last.tag.ev==="transferred" ? "gatekeeper" : last.tag.who;
      if(pickedUp) S.step=Math.max(S.step,1);
    }
    else { S.who=S.scen.open; S.step=S.scen.open==="dm"?2:1; }
    if(!S.scen.gk) S.who="dm";
    // the gatekeeper was putting you through when you retried: carry on with the transfer
    return !!(last&&last.tag.ev==="transferred"&&!pickedUp);
  }

  function retryLine(){
    if(S.tm||(S.heard+S.interim).trim()){          // still mid-sentence: throw away what you've said
      consumeUtterance(); cancelSpec(); updateMouth(); paintState();
      flash("Say it again."); armDeadAir(); return;
    }
    const i=lastRepIndex();
    if(i<0){
      if(!S.turns.some(t=>t.side==="them")&&!S.busy&&!S.ringing){   // the pickup never came through
        S.lastSpokeEnd=0; askProspect(false); flash("Getting them back on the line."); return;
      }
      flash("Nothing to retry yet."); return;
    }
    cancelSpec(); cancelEvent();
    if(S.busy){ try{S.ctl&&S.ctl.abort();}catch(e){} S.reqSeq++; S.busy=false; }
    S.queuedAsk=false;
    const hadDirector=S.turns.slice(i).filter(t=>t.side==="director");
    hushAudio(); S.speaking=false;
    const said=S.turns[i].text;
    S.turns=S.turns.slice(0,i).concat(hadDirector); S.retries++;
    const resumeTransfer=restoreSpeaker();
    S.lastSpokeEnd=0;                              // don't time your retake from the deleted exchange
    beat("Take two.","dir");
    if(resumeTransfer){ S.who="gatekeeper"; queueEvent("transferred"); }
    if(!$("#fallback").hidden){ $("#say").value=said; }
    flash("Say it again.");
    paintBoard(); paintState(); renderCall(); renderRail(); armDeadAir();
  }
  function nudge(d){
    const was=S.diff; S.diff=Math.min(5,Math.max(1,S.diff+d));
    if(S.diff===was){ flash(d>0?"Already brutal.":"Already warm."); return; }
    const note={side:"director",text:"[DIRECTOR: resistance goes from "+was+" to "+S.diff+" of 5 ("+(d>0?"tougher":"easier")+"). Adjust from your next line on.]"};
    if(S.busy) S.pendingNotes.push(note); else S.turns.push(note);   // never before a reply that didn't see it
    flash("Resistance "+S.diff+".");
    paintBoard(); renderCall();
  }
  function flagLine(){
    const i=lastRepIndex(); if(i<0){ flash("Nothing to flag."); return; }
    S.turns[i].flagged=!S.turns[i].flagged; renderCall();
    flash(S.turns[i].flagged?"Flagged for the teardown.":"Unflagged.");
  }
  function toggleMic(){
    if(S.mic==="live"){
      if(S.tm||(S.heard+S.interim).trim()) endOfTurn();   // what you already said still counts
      stopMic(); showFallback(false); flash("Mic muted — click the box to type, M to unmute.");
    }
    else if(srOK){ startMic(); flash("Mic live."); }
    else flash("No mic in this browser.");
    armDeadAir();
  }
  function peek(){
    S.peeks++; S.peekStep=STEPS[S.step-1]; renderRail(); if(NARROW.matches) renderCall();
    flash("Peeked — "+S.peeks+" so far.");
  }
  function peekMood(){
    S.peeks++; S.peekMood=true; renderRail(); if(NARROW.matches) renderCall();
    flash("Reading the room — counts as a peek.");
  }

  $("#sendBtn").onmousedown=(e)=>e.preventDefault();
  $("#sendBtn").onclick=()=>{ sendLine($("#say").value); $("#say").focus(); };
  $("#say").addEventListener("input",()=>{ if(S.deadAir) armDeadAir(); });

  /* ================= end ================= */
  function endCall(how){
    if(S.phase!=="live") return;
    const outcome=S.outcome||how;
    try{ S.ctl&&S.ctl.abort(); }catch(e){}
    try{ S.callCtl&&S.callCtl.abort(); }catch(e){}
    cancelSpec(); cancelEvent();
    S.reqSeq++; S.queuedAsk=false; S.pendingNotes=[];
    hushAudio(); S.speaking=false; S.ringing=false;
    clearDeadAir(); cancelFiller();
    Object.values(fillerBank).flat().forEach(f=>URL.revokeObjectURL(f.url)); fillerBank={dm:[],gk:[]};
    stopMic(); clearInterval(S.tick); S.tick=null;
    S.phase="ended"; S.outcome=outcome; S.busy=false; S.endedAt=Date.now();
    if(S.outcome==="hangup") phone.disconnected(); else phone.hangup();
    beat(S.outcome==="booked"?"Meeting booked. Call over.":S.outcome==="hangup"?"They hung up.":S.outcome==="wrapped"?"Call wrapped up.":"You hung up.");
    paintBoard(); paintState(); renderEnd(); renderRail(); logCall(null);
  }

  function renderEnd(){
    const w=$("#stage"); w.textContent="";
    const s=el("div","sheet");
    s.appendChild(el("p","eyebrow","Call summary · "+fmt(elapsed())+" · resistance "+S.diff));
    s.appendChild(el("span","outcome "+(S.outcome==="booked"?"booked":S.outcome==="hangup"?"hangup":""),
      S.outcome==="booked"?"Meeting booked":S.outcome==="hangup"?"They hung up":S.outcome==="wrapped"?"Follow-up only":"You ended the call"));
    s.appendChild(el("p","verdict",
      S.outcome==="booked"?"Thirty minutes on the calendar.":S.outcome==="hangup"?"They hung up on you."
      :S.outcome==="wrapped"?"You settled for a follow-up, not a meeting.":"You ended it."));
    s.appendChild(el("p","sub","Reached step "+S.reached+" of 5 ("+STEPS[S.reached-1].name+")"
      +(S.retries?" · "+S.retries+" retr"+(S.retries>1?"ies":"y"):"")
      +(S.peeks?" · "+S.peeks+" peek"+(S.peeks>1?"s":""):"")+"."));

    const acts=el("div","acts");
    const grade=el("button","go","Grade this call"); grade.type="button";
    grade.onclick=()=>getTeardown(grade);
    const again=el("button","ghostbtn"); again.type="button"; again.append(icon("phone"),el("span","","Call again"));
    again.onclick=()=>{ S.phase="setup"; startCall(); };
    const next=el("button","ghostbtn"); next.type="button"; next.append(icon("next"),el("span","","Next contact"));
    next.onclick=()=>{ S.phase="setup"; selectContact(pickNext()); };
    const done=el("button","ghostbtn","Done"); done.type="button";
    done.onclick=()=>{ S.phase="setup"; renderSetup(); renderRail(); };
    if(!S.teardown) acts.appendChild(grade);
    acts.append(again,next,done); s.appendChild(acts);

    const hold=el("div"); hold.id="tdown"; s.appendChild(hold);
    if(S.teardown) paintTeardown(S.teardown,hold);

    const moods=S.turns.filter(t=>t.side==="them"&&t.patience!=null);
    if(moods.length){
      const mw=el("div");
      mw.appendChild(el("p","eyebrow","Their patience, line by line"));
      const tl=el("div","moodline");
      moods.forEach((t)=>{
        const col=el("div","moodcol");
        const bar=el("i"); bar.style.height=(t.patience*10)+"%";
        bar.className=t.patience<=3?"low":t.patience<=6?"mid":"";
        col.appendChild(bar);
        col.title=t.patience+"/10"+(t.objection&&t.objection!=="none"?" · "+t.objection.replace(/-/g," "):"")+" — “"+t.text+"”";
        tl.appendChild(col);
      });
      mw.appendChild(tl);
      const objs=[...new Set(moods.map(t=>t.objection).filter(o=>o&&o!=="none"))];
      if(objs.length) mw.appendChild(el("p","hint","Objections thrown: "+objs.map(o=>o.replace(/-/g," ")).join(" · ")));
      s.appendChild(mw);
    }

    const t=el("div");
    t.appendChild(el("p","eyebrow","The call"));
    const sc=el("div","call");
    S.turns.forEach((x)=>{
      if(!visible(x)) return;
      const n=turnNode(x);
      if(x.side==="rep"&&x.meta&&!x.meta.typed){
        const m=x.meta, bits=[];
        if(m.barged) bits.push("cut in"); else if(m.startedAfterMs!=null) bits.push((m.startedAfterMs/1000).toFixed(1)+"s to start");
        if(m.fillers&&m.fillers.length) bits.push(m.fillers.length+" filler"+(m.fillers.length>1?"s":""));
        if(m.restarts) bits.push(m.restarts+" restart"+(m.restarts>1?"s":""));
        if(m.pauses) bits.push(m.pauses+" pause"+(m.pauses>1?"s":""));
        if(m.wpm) bits.push(m.wpm+" wpm");
        if(bits.length) n.appendChild(el("span","meta",bits.join(" · ")));
      }
      sc.appendChild(n);
    });
    t.appendChild(sc); s.appendChild(t);
    w.appendChild(s);
  }

  async function getTeardown(btn){
    btn.disabled=true; btn.textContent="Grading…";
    const id=S.lastId, rec=logRecord(null);         // this call, even if you've moved on by the time it lands
    try{
      const r=await fetch("api/grade",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({scenarioId:S.scen.id,diff:S.diff,outcome:S.outcome||"hungup",
          reached:S.reached,turns:transcript()})});
      const j=await r.json().catch(()=>({}));
      if(!r.ok) throw Object.assign(new Error(j.message||"HTTP "+r.status),{code:j.code});
      saveLog({...rec,grade:avgGrade(j),fix:j.fix?String(j.fix):""});
      const hold=$("#tdown");
      if(S.lastId!==id||S.phase!=="ended"||!hold) return;
      S.teardown=j; paintTeardown(j,hold); btn.remove();
    }catch(e){
      const hold=$("#tdown");
      if(S.lastId!==id||S.phase!=="ended"||!hold) return;
      btn.disabled=false; btn.textContent="Grade this call";
      hold.textContent="";
      hold.appendChild(el("div","warnbox", e&&e.code==="not_granted"
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
    if(r.delivery){
      const d=el("div","delivery");
      d.appendChild(el("p","eyebrow","How you sounded"));
      d.appendChild(el("p","",String(r.delivery)));
      g.appendChild(d);
    }
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
      hear.onclick=()=>{ unlockAudio(); speakOnce(String(r.worst.instead||""),"rep","m"); };
      if(voiceOK()) b.appendChild(hear);
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
  function logRecord(r){
    if(!S.callAt) S.callAt=new Date().toISOString();
    return {id:S.lastId,at:S.callAt,sid:S.scen.id,firm:S.scen.firm,diff:S.diff,reached:S.reached,
      outcome:S.outcome||"hungup",seconds:elapsed(),peeks:S.peeks,retries:S.retries,
      grade:avgGrade(r)||"",fix:r&&r.fix?String(r.fix):"",turns:S.turns.filter(visible).map(t=>({side:t.side==="rep"||t.side==="them"?t.side:"beat",
        who:t.who||"",text:t.side==="note"?t.shown:t.text+(t.cut?" —":""),patience:t.patience??null,objection:t.objection||null}))};
  }
  function saveLog(rec){
    const i=S.calls.findIndex(c=>c.id===rec.id);
    if(i>=0) S.calls[i]=rec; else S.calls.unshift(rec);
    renderRail();
    fetch("api/calls/"+encodeURIComponent(rec.id),{method:"PUT",headers:{"Content-Type":"application/json"},
      body:JSON.stringify(rec)}).catch(()=>{});
  }
  function logCall(r){ saveLog(logRecord(r)); }
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

    if(S.phase==="live"){
      const s0=el("section");
      s0.appendChild(el("p","rtitle","Call stage"));
      const sl=el("div","steps");
      STEPS.forEach((st)=>{
        const d=el("div","stp"+(st.n===S.step?" now":st.n<S.reached||st.n<S.step?" done":""));
        d.appendChild(el("i","",st.n<S.step?"✓":String(st.n)));
        d.appendChild(el("span","",st.name+" — "+st.goal));
        sl.appendChild(d);
      });
      s0.appendChild(sl);
      const stp=STEPS[S.step-1];
      const cl=el("div","checks");
      stp.rules.forEach((r)=>{
        const d=el("div","chk"); d.appendChild(el("i","","•")); d.appendChild(el("span","",r)); cl.appendChild(d);
      });
      s0.appendChild(cl);
      peekNodes().forEach(n=>s0.appendChild(n));
      w.appendChild(s0);
    }

    if(S.phase==="live"){
      const sc=S.scen, s4=el("section");
      s4.appendChild(el("p","rtitle","Contact"));
      const b=el("div","brief");
      const nm=el("span"); nm.appendChild(el("b","",sc.dm)); b.appendChild(nm);
      b.appendChild(el("span","",sc.firm+" · "+sc.city));
      b.appendChild(el("span","",sc.years?sc.years+" years in business":"Years in business unknown"));
      b.appendChild(el("span","",(sc.services||[]).join(" · ")));
      s4.appendChild(b);
      w.appendChild(s4);
    }

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

    if(S.phase!=="live"){
      const s5=el("section");
      s5.appendChild(el("p","rtitle","On a call"));
      const cl=el("div","checks");
      ["Just talk — they answer when you pause.","Start talking to cut them off mid-sentence.","Silent keys: R retry · B cut in · F flag · / script · T read the room · H/E harder/easier · X end.","Nobody on the line hears the keys."].forEach((r)=>{
        const d=el("div","chk"); d.appendChild(el("i","","•")); d.appendChild(el("span","",r)); cl.appendChild(d);
      });
      s5.appendChild(cl); w.appendChild(s5);
    }
    if(S.view==="recents") renderSide();
  }

  /* ================= boot ================= */
  renderSide(); renderSetup(); renderRail(); paintBoard();

  (async function(){
    try{
      const r=await fetch("api/config");
      if(r.ok){ S.cfg={...S.cfg,...(await r.json())}; renderSetup(); }
    }catch(e){}
  })();
  (async function(){
    try{
      const r=await fetch("api/calls");
      if(r.ok){ S.calls=await r.json(); renderRail(); }
    }catch(e){}
  })();
