// Injected before page scripts: a stand-in for the ElevenLabs browser SDK. It does what the
// real service does from the app's point of view: takes the session, "hears" the rep via
// __agentSpeak, asks the app's own reply endpoint for the prospect's line, and fires the
// same callbacks (user transcript, agent response, mode changes, voice activity). Like the
// real one it reports every client tool call back and asks the LLM again afterwards, and it
// can be told to misbehave the ways the real one does: drop a late reply and re-ask
// (__agentDropNext, __agentReplay), re-send a turn with a longer transcript
// (__agentSpeculate), or ask again with the history ending on the agent's own message
// (__agentContinue).
(()=>{
  const sessions=[]; window.__agentSessions=sessions; window.__llmRequests=0;
  async function secret(){
    const key=await crypto.subtle.importKey("raw",new TextEncoder().encode("test"),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
    const sig=await crypto.subtle.sign("HMAC",key,new TextEncoder().encode("dialroom-custom-llm"));
    return [...new Uint8Array(sig)].map(b=>b.toString(16).padStart(2,"0")).join("").slice(0,40);
  }
  class FakeConversation{
    constructor(opts){ this.opts=opts; this.messages=[]; this.open=true; this.muted=false; this.gen=0; sessions.push(this); }
    // one request to the custom LLM with the given history (default: the conversation so far)
    async askLlm(messages=this.messages,{drop=false}={}){
      const my=++this.gen; window.__llmRequests++;
      const r=await fetch("api/voice/llm/"+(await secret())+"/chat/completions",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({model:"dialroom",stream:true,messages:[{role:"system",content:"agent prompt"},...messages],elevenlabs_extra_body:{dialroom:this.opts.customLlmExtraBody.dialroom},
          tools:[{type:"function",function:{name:"dialroom_state",parameters:{type:"object",properties:{}}}}]})});
      const deltas=(await r.text()).split("\n\n").filter(l=>l.startsWith("data: ")&&!l.startsWith("data: [DONE]")).map(l=>JSON.parse(l.slice(6)).choices[0].delta);
      const text=deltas.map(d=>d.content||"").join("");
      const call=deltas.flatMap(d=>d.tool_calls||[])[0];
      if(!this.open||drop||my!==this.gen) return;            // discarded: a later request superseded it, or the drop was scripted
      if(!text&&!call) return;                                // an empty completion: the agent stays quiet
      this.messages.push({role:"assistant",content:text,...(call?{tool_calls:[{id:call.id,type:"function",function:call.function}]}:{})});
      if(text){
        this.opts.onMessage&&this.opts.onMessage({role:"agent",source:"ai",message:text,event_id:this.messages.length});
        this.opts.onModeChange&&this.opts.onModeChange({mode:"speaking"});
        const ms=300+text.length*12;
        setTimeout(()=>{ if(this.open) this.opts.onModeChange&&this.opts.onModeChange({mode:"listening"}); },ms);
      }
      if(call){                                              // the SDK runs the client tool, reports the result, and the LLM is asked once more
        window.__toolCalls=(window.__toolCalls||0)+1;
        setTimeout(()=>{
          try{ this.opts.clientTools&&this.opts.clientTools.dialroom_state&&this.opts.clientTools.dialroom_state(JSON.parse(call.function.arguments)); }catch(e){ console.error("fake agent tool",e); }
          this.messages.push({role:"tool",tool_call_id:call.id,content:"ok"});
          this.askLlm().catch(e=>console.error("fake agent follow-up",e));   // sent even after endSession, as the platform does
        },50);
      }
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
      if(window.__agentDropNext){                            // the reply arrives too late for ElevenLabs: discarded, then asked for again
        window.__agentDropNext=false;
        await this.askLlm(this.messages,{drop:true});
        await new Promise(r=>setTimeout(r,400));
      }
      await this.askLlm();
    }
    // ElevenLabs threw our reply away and asks again with the history ending on the rep's line
    async replay(){ while(this.messages.length&&this.messages.at(-1).role!=="user") this.messages.pop(); await this.askLlm(); }
    // a bare follow-up: the history ends on the agent's own message, no tool report
    async continueTurn(){ const h=this.messages.filter((m,i,a)=>!(i===a.length-1&&m.role==="tool")); await this.askLlm(h); }
    // a speculative end of turn: the short transcript is sent, then replaced by the full one 150 ms later
    async speculate(words,more){
      for(const w of [...words,...more]){ this.opts.onVadScore&&this.opts.onVadScore({vadScore:0.9}); await new Promise(r=>setTimeout(r,60)); }
      this.opts.onVadScore&&this.opts.onVadScore({vadScore:0.05});
      this.messages.push({role:"user",content:words.join(" ")});
      const early=this.askLlm().catch(()=>{});
      await new Promise(r=>setTimeout(r,150));
      const full=[...words,...more].join(" ");
      this.messages[this.messages.length-1]={role:"user",content:full};
      this.opts.onMessage&&this.opts.onMessage({role:"user",source:"user",message:full,event_id:this.messages.length});
      await Promise.all([early,this.askLlm()]);
    }
  }
  window.ElevenLabsClient={ Conversation:{ async startSession(opts){ const c=new FakeConversation(opts); setTimeout(()=>opts.onConnect&&opts.onConnect({conversationId:"conv_fake"}),20); return c; } } };
  const live=()=>sessions.filter(s=>s.open).pop();
  window.__agentSpeak=(words,gap)=>{ const c=live(); return c?c.speak(words,gap):"no-session"; };
  window.__agentReplay=()=>{ const c=live(); return c?c.replay():"no-session"; };
  window.__agentContinue=()=>{ const c=live(); return c?c.continueTurn():"no-session"; };
  window.__agentSpeculate=(words,more)=>{ const c=live(); return c?c.speculate(words,more):"no-session"; };
})();
