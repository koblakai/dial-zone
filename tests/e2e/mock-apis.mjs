// Stand-ins for the Anthropic Messages API (streaming + structured grading) and the
// ElevenLabs TTS endpoint, with scripted prospect replies keyed off the rep's words.
import http from "node:http";
const log=[];
function wav(ms=400){ // silent 8k mono wav
  const n=Math.floor(8000*ms/1000), b=Buffer.alloc(44+n*2);
  b.write("RIFF",0); b.writeUInt32LE(36+n*2,4); b.write("WAVE",8); b.write("fmt ",12); b.writeUInt32LE(16,16);
  b.writeUInt16LE(1,20); b.writeUInt16LE(1,22); b.writeUInt32LE(8000,24); b.writeUInt32LE(16000,28); b.writeUInt16LE(2,32); b.writeUInt16LE(16,34);
  b.write("data",36); b.writeUInt32LE(n*2,40); return b;
}
function reply(body){
  const msgs=body.messages||[]; const last=msgs[msgs.length-1]?.content||"";
  const L=typeof last==="string"?last:JSON.stringify(last);
  if(/\[silence/.test(L)) return "Hello? Anyone there?\n[[gatekeeper|1|none|5|none]]";
  if(/put the Levitate caller through to you/.test(L)) return "This is Evan.\n[[dm|2|none|7|none]]";
  if(/fillers \(/.test(L) && /[3-9] fillers/.test(L)) return "I'm going to stop you there. We're all set, thanks.\n[[dm|2|hangup|0|not-interested]]";
  if(/Levitate/.test(L)) return "Okay, one moment, I'll put you through.\n[[dm|1|transferred|7|none]]";
  if(/Marsh/.test(L)) return "Can I ask what this is regarding?\n[[gatekeeper|1|none|7|whats-this-regarding]]";
  if(msgs.length<=1) return "Meridian Spine and Performance, this is Kayla, how can I help you?\n[[gatekeeper|1|none|8|none]]";
  return "Mm-hm. Go on, I'm listening, but make it quick please.\n[[dm|3|none|6|none]]";
}
export function startMock(port=0){ return new Promise((resolve)=>{ const srv=http.createServer((req,res)=>{
  let b=""; req.on("data",c=>b+=c); req.on("end",()=>{
    if(req.url.startsWith("/__log")){ res.end(JSON.stringify(log)); return; }
    if(req.url.startsWith("/__reset")){ log.length=0; res.end("ok"); return; }
    const body=JSON.parse(b||"{}"); log.push({url:req.url,beta:req.headers["anthropic-beta"],xi:req.headers["xi-api-key"],body});
    if(req.url.startsWith("/v1/convai/agents/create")){ res.writeHead(200,{"content-type":"application/json"}); res.end(JSON.stringify({agent_id:"agent_test"})); return; }
    if(req.url.startsWith("/v1/convai/agents/agent_test")){ res.writeHead(200,{"content-type":"application/json"}); res.end(JSON.stringify({agent_id:"agent_test"})); return; }
    if(req.url.startsWith("/v1/convai/agents")){ res.writeHead(200,{"content-type":"application/json"}); res.end(JSON.stringify({agents:[]})); return; }
    if(req.url.startsWith("/v1/convai/conversation/token")){ res.writeHead(200,{"content-type":"application/json"}); res.end(JSON.stringify({token:"tok_test",conversation_id:"conv_test"})); return; }
    if(req.url.includes("/text-to-speech/")){ res.writeHead(200,{"content-type":"audio/wav"}); res.end(wav(300+body.text.length*20)); return; }
    const msgBase={id:"msg_1",type:"message",role:"assistant",model:body.model,stop_reason:"end_turn",stop_sequence:null,usage:{input_tokens:1,output_tokens:1}};
    if(body.stream){
      const text=reply(body);
      res.writeHead(200,{"content-type":"text/event-stream"});
      const ev=(t,d)=>res.write(`event: ${t}\ndata: ${JSON.stringify(d)}\n\n`);
      ev("message_start",{type:"message_start",message:{...msgBase,content:[],stop_reason:null}});
      ev("content_block_start",{type:"content_block_start",index:0,content_block:{type:"text",text:""}});
      const parts=text.match(/.{1,6}/gs); let i=0;
      const t=setInterval(()=>{
        if(i<parts.length){ ev("content_block_delta",{type:"content_block_delta",index:0,delta:{type:"text_delta",text:parts[i++]}}); return; }
        clearInterval(t);
        ev("content_block_stop",{type:"content_block_stop",index:0});
        ev("message_delta",{type:"message_delta",delta:{stop_reason:"end_turn",stop_sequence:null},usage:{output_tokens:10}});
        ev("message_stop",{type:"message_stop"}); res.end();
      },15);
    } else {
      const out={steps:[{n:1,name:"Connect",grade:"B",hit:["asked for Lindsay by first name"],miss:["no interrupter"]}],worst:{said:"um so basically",instead:"Is she around?"},fix:"End every answer with an interrupter.",verdict:"Solid open, soft finish.",delivery:"You hesitated 3s and used 3 fillers at the hook."};
      res.writeHead(200,{"content-type":"application/json"});
      res.end(JSON.stringify({...msgBase,content:[{type:"text",text:JSON.stringify(out)}]}));
    }
  });
}); srv.listen(port,"127.0.0.1",()=>resolve(srv)); }); }
