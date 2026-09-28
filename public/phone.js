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

// Keypad tones (DTMF), local only: nothing is sent down the line.
const DTMF = { "1":[697,1209],"2":[697,1336],"3":[697,1477],"4":[770,1209],"5":[770,1336],"6":[770,1477],
  "7":[852,1209],"8":[852,1336],"9":[852,1477],"*":[941,1209],"0":[941,1336],"#":[941,1477] };
export function dtmf(key){
  const f = DTMF[key];
  if(f && unlock()) tone(f, ctx.currentTime + 0.01, 0.14, 0.05);
}

// You hung up: just the click.
export function hangup(){ if(unlock()) click(ctx.currentTime + 0.01, 0.3); }

// One shared <audio> element, unlocked during the Dial tap. Safari and iOS only let
// an element play later (after network waits) if it was started inside a user gesture.
let player = null, silentUrl = null;
function silentWav(){
  const n = 800, b = new ArrayBuffer(44 + n * 2), v = new DataView(b);
  const w = (o, s) => { for(let i=0;i<s.length;i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0,"RIFF"); v.setUint32(4, 36 + n*2, true); w(8,"WAVE"); w(12,"fmt "); v.setUint32(16,16,true);
  v.setUint16(20,1,true); v.setUint16(22,1,true); v.setUint32(24,8000,true); v.setUint32(28,16000,true);
  v.setUint16(32,2,true); v.setUint16(34,16,true); w(36,"data"); v.setUint32(40, n*2, true);
  return URL.createObjectURL(new Blob([b], { type:"audio/wav" }));
}
export function primeAudio(){
  unlock();
  try{
    if(!player){
      player = new Audio(); player.preload = "auto";
      if(ctx && line){ try{ ctx.createMediaElementSource(player).connect(line); }catch(e){} }
    }
    player.src = silentUrl ??= silentWav();
    player.play().catch(()=>{});
  }catch(e){ player = null; }
}

// Play an audio URL through the handset filter. Resolves true when it played to
// the end (or was deliberately stopped), false if it couldn't play at all.
// onStart fires when sound actually starts.
let active = null;
export function stopPlayback(){ active && active(true); }
export function playThroughLine(url, signal, onStart){
  active && active(true);                           // one voice on the line at a time
  return new Promise((resolve)=>{
    const a = player || new Audio();
    let done = false, began = false;
    const finish = (ok) => {
      if(done) return; done = true;
      if(active === finish) active = null;
      a.onended = a.onerror = a.onplaying = null;
      try{ a.pause(); }catch(e){}
      resolve(ok);
    };
    active = finish;
    a.onplaying = () => { if(!began){ began = true; onStart && onStart(); } };
    a.onended = () => finish(true);
    a.onerror = () => finish(began);
    if(signal?.aborted) return finish(true);
    signal?.addEventListener("abort", () => finish(true), { once:true });
    if(a !== player){
      try{ if(unlock() && line){ ctx.createMediaElementSource(a).connect(line); } }catch(e){}
    }
    a.src = url;
    a.play().catch(() => finish(false));
  });
}
