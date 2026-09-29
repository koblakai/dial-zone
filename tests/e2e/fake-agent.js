// Injected before page scripts: a stand-in for the ElevenLabs browser SDK. It does what the
// real service does from the app's point of view: takes the session, "hears" the rep via
// __agentSpeak, asks the app's own reply endpoint for the prospect's line, and fires the
// same callbacks (user transcript, agent response, mode changes, voice activity).
(()=>{
  const sessions=[]; window.__agentSessions=sessions;
  async function secret(){
    const key=await crypto.subtle.importKey("raw",new TextEncoder().encode("test"),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
    const sig=await crypto.subtle.sign("HMAC",key,new TextEncoder().encode("dialroom-custom-llm"));
    return [...new Uint8Array(sig)].map(b=>b.toString(16).padStart(2,"0")).join("").slice(0,40);
  }
  class FakeConversation{
    constructor(opts){ this.opts=opts; this.messages=[]; this.open=true; this.muted=false; sessions.push(this); }
    async askLlm(){
      const r=await fetch("api/voice/llm/"+(await secret())+"/chat/completions",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({model:"dialroom",stream:true,messages:[{role:"system",content:"agent prompt"},...this.messages],dialroom:this.opts.customLlmExtraBody.dialroom})});
      const text=(await r.text()).split("\n\n").filter(l=>l.startsWith("data: ")&&!l.startsWith("data: [DONE]")).map(l=>JSON.parse(l.slice(6)).choices[0].delta.content||"").join("");
      if(!this.open) return;
      this.messages.push({role:"assistant",content:text});
      if(!text) return;
      this.opts.onMessage&&this.opts.onMessage({role:"agent",source:"ai",message:text,event_id:this.messages.length});
      this.opts.onModeChange&&this.opts.onModeChange({mode:"speaking"});
      const ms=300+text.length*12;
      setTimeout(()=>{ if(this.open) this.opts.onModeChange&&this.opts.onModeChange({mode:"listening"}); },ms);
    }
    sendUserMessage(text){ this.messages.push({role:"user",content:text}); this.askLlm().catch(e=>console.error("fake agent",e)); }
    sendContextualUpdate(){}
    setMicMuted(m){ this.muted=m; }
    setVolume(){}
    getId(){ return "conv_fake"; }
    async endSession(){ if(!this.open) return; this.open=false; setTimeout(()=>this.opts.onDisconnect&&this.opts.onDisconnect({reason:"user"}),10); }
    // the rep talks: voice activity for ~120 ms a word, then the transcript, then the reply
    async speak(words,gap=120){
      for(const w of words){ this.opts.onVadScore&&this.opts.onVadScore({vadScore:0.9}); await new Promise(r=>setTimeout(r,gap)); }
      this.opts.onVadScore&&this.opts.onVadScore({vadScore:0.05});
      await new Promise(r=>setTimeout(r,250));
      const text=words.join(" ");
      this.opts.onMessage&&this.opts.onMessage({role:"user",source:"user",message:text,event_id:this.messages.length});
      this.messages.push({role:"user",content:text});
      await this.askLlm();
    }
  }
  window.ElevenLabsClient={ Conversation:{ async startSession(opts){ const c=new FakeConversation(opts); setTimeout(()=>opts.onConnect&&opts.onConnect({conversationId:"conv_fake"}),20); return c; } } };
  window.__agentSpeak=(words,gap)=>{ const c=sessions.filter(s=>s.open).pop(); return c?c.speak(words,gap):"no-session"; };
})();
