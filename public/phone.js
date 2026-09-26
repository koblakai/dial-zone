// Phone-line audio: ringback, pickup/hang-up clicks, disconnect tones, and a
// telephone band-pass for the prospect's voice. Everything is synthesized with
// Web Audio, so there are no sound files to ship.

let ctx = null, line = null;

// Must first be called from a user gesture (the Dial button) so audio can start.
export function unlock(){
  try{
    if(!ctx){
      const AC = window.AudioContext || window.webkitAudioContext;
      if(!AC) return null;
      ctx = new AC();
      // voice chain: 300–3400 Hz like a real handset, gently compressed
      const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 300;
      const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 3400;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -24; comp.ratio.value = 3;
      const gain = ctx.createGain(); gain.gain.value = 1.15;
      hp.connect(lp); lp.connect(comp); comp.connect(gain); gain.connect(ctx.destination);
      line = hp;
    }
    if(ctx.state === "suspended") ctx.resume();
  }catch(e){ ctx = null; line = null; }
  return ctx;
}

function tone(freqs, start, dur, vol=0.08){
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, start);
  g.gain.linearRampToValueAtTime(vol, start + 0.015);
  g.gain.setValueAtTime(vol, start + dur - 0.02);
  g.gain.linearRampToValueAtTime(0, start + dur);
  g.connect(ctx.destination);
  const oscs = freqs.map((f)=>{
    const o = ctx.createOscillator(); o.frequency.value = f; o.connect(g);
    o.start(start); o.stop(start + dur + 0.02); return o;
  });
  return { stop(){ oscs.forEach(o=>{ try{ o.stop(); }catch(e){} }); g.disconnect(); } };
}

function click(at, vol=0.25){
  const len = Math.floor(ctx.sampleRate * 0.03);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
  for(let i=0;i<len;i++) d[i] = (Math.random()*2-1) * Math.pow(1 - i/len, 3);
  const src = ctx.createBufferSource(), g = ctx.createGain();
  g.gain.value = vol; src.buffer = buf; src.connect(g); g.connect(ctx.destination); src.start(at);
}

const wait = (ms, signal) => new Promise((res)=>{
  const t = setTimeout(res, ms);
  signal?.addEventListener("abort", ()=>{ clearTimeout(t); res(); }, { once:true });
});

// North American ringback: 440+480 Hz, 2 s on / 4 s off. Resolves when the far
// end "picks up" (a moment into the silence after the last ring).
export async function ring(rings=1, signal){
  if(!unlock()) return wait(1200 + 2600 * (rings - 1), signal);
  const live = [];
  const stopAll = () => live.forEach(t=>t.stop());
  signal?.addEventListener("abort", stopAll, { once:true });
  for(let i=0;i<rings && !signal?.aborted;i++){
    live.push(tone([440,480], ctx.currentTime + 0.05, 2.0, 0.05));
    await wait(i < rings-1 ? 6000 : 2000 + 500 + Math.random()*1100, signal);
  }
  if(!signal?.aborted) click(ctx.currentTime + 0.01, 0.2);
}

export function pickup(){ if(unlock()) click(ctx.currentTime + 0.01, 0.2); }

// The other side hung up: handset click, then the three-beep "call ended" tone.
export function disconnected(){
  if(!unlock()) return;
  const t = ctx.currentTime + 0.05;
  click(t, 0.3);
  [0.35, 0.65, 0.95].forEach((dt)=>tone([480, 620], t + dt, 0.18, 0.05));
}

// You hung up: just the click.
export function hangup(){ if(unlock()) click(ctx.currentTime + 0.01, 0.3); }

// Play an audio URL through the handset filter. Resolves when it ends or is stopped.
export function playThroughLine(url, signal){
  return new Promise((resolve)=>{
    const a = new Audio();
    a.src = url; a.preload = "auto";
    let done = false;
    const finish = () => { if(done) return; done = true; try{ a.pause(); }catch(e){} resolve(); };
    a.onended = finish; a.onerror = finish;
    signal?.addEventListener("abort", finish, { once:true });
    try{
      if(unlock() && line){ const src = ctx.createMediaElementSource(a); src.connect(line); }
    }catch(e){}
    a.play().catch(finish);
  });
}
