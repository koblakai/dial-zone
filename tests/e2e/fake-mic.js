// Injected before page scripts: a Chrome-like scriptable SpeechRecognition + optional fake speechSynthesis.
(()=>{
  const insts=[];
  class FakeSR{ constructor(){ insts.push(this); this.results=[]; }
    start(){ this.live=true; this.results=[]; this.session=(this.session||0)+1; window.__sessions=(window.__sessions||0)+1; }
    stop(){ this.live=false; setTimeout(()=>this.onend&&this.onend(),30); }
    abort(){ this.live=false; setTimeout(()=>{ this.onerror&&this.onerror({error:"aborted"}); this.onend&&this.onend(); },20); } }
  window.SpeechRecognition=FakeSR; window.webkitSpeechRecognition=FakeSR;
  const snap=(sr)=>sr.results.map(r=>{ const a=[{transcript:r.t,confidence:.9}]; a.isFinal=r.f; return a; });
  const emit=(sr,idx)=>sr.onresult&&sr.onresult({resultIndex:idx,results:snap(sr)});
  const cur=()=>insts.filter(i=>i.live).pop();
  // words: array; gaps: ms between words; finalDelay: ms after last word before the result is final
  window.__speak=async(words,gaps=150,finalDelay=0)=>{
    const sr=cur(); if(!sr) return "no-live-recognizer";
    const idx=sr.results.length; sr.results.push({t:"",f:false});
    const said=[];
    for(let i=0;i<words.length;i++){
      said.push(words[i]); sr.results[idx].t=(idx?" ":"")+said.join(" "); emit(sr,idx);
      const g=Array.isArray(gaps)?(gaps[i]??150):gaps;
      await new Promise(r=>setTimeout(r,g));
    }
    const sess=sr.session;
    const fin=()=>{ if(!sr.live||sr.session!==sess) return; sr.results[idx].f=true; emit(sr,idx); };
    if(finalDelay) setTimeout(fin,finalDelay); else fin();
    return "ok";
  };
  // realistic echo: interim results while the speaker is playing, final arriving later
  window.__echoStream=async(words,gap,finalAt)=>{
    const sr=cur(); if(!sr) return; const sess=sr.session;
    const idx=sr.results.length; sr.results.push({t:"",f:false}); const said=[];
    const t0=Date.now();
    for(const w of words){ if(sr.session!==sess) return; said.push(w); sr.results[idx].t=" "+said.join(" "); emit(sr,idx); await new Promise(r=>setTimeout(r,gap)); }
    setTimeout(()=>{ if(!sr.live||sr.session!==sess) return; sr.results[idx].f=true; emit(sr,idx); }, Math.max(0,finalAt-(Date.now()-t0)));
  };
  window.__echo=(text,delay)=>setTimeout(()=>{ const sr=cur(); if(!sr) return; const idx=sr.results.length; sr.results.push({t:" "+text,f:true}); emit(sr,idx); },delay);
  if(window.__FAKE_TTS){
    const spoken=[]; window.__spoken=spoken;
    const fake={ speak(u){ if(!u.text.trim()) return; spoken.push(u.text); this._u=u; setTimeout(()=>u.onstart&&u.onstart(),20); this._t=setTimeout(()=>u.onend&&u.onend(),600+u.text.length*40); },
      cancel(){ clearTimeout(this._t); spoken.push("<cancel>"); }, getVoices(){ return []; }, onvoiceschanged:null };
    Object.defineProperty(window,"speechSynthesis",{value:fake,configurable:true});
  }
})();
