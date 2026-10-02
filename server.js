import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const ALLOWED_MODELS = new Set(['gpt-6-astra','gpt-6.1-sol','gpt-6-luna']);
const ALLOWED_REASONING = new Set(['low','medium','high','xhigh','max']);
const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json; charset=utf-8','.png':'image/png','.svg':'image/svg+xml'};

function send(res,status,body,headers={}){res.writeHead(status,{'X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin',...headers});res.end(body);}
async function readJson(req){let raw='';for await(const c of req){raw+=c;if(raw.length>2_000_000) throw new Error('Payload too large');}return JSON.parse(raw||'{}');}

async function handleChat(req,res){
  let body; try{body=await readJson(req);}catch{send(res,400,JSON.stringify({error:'Некорректный JSON'}),{'Content-Type':'application/json; charset=utf-8'});return;}
  const model=ALLOWED_MODELS.has(body.model)?body.model:'gpt-6.1-sol';
  const reasoning=ALLOWED_REASONING.has(body.reasoning)?body.reasoning:'medium';
  const messages=Array.isArray(body.messages)?body.messages.slice(-40):[];
  const instructions=typeof body.instructions==='string'?body.instructions.slice(0,24000):'';
  if(!messages.length){send(res,400,JSON.stringify({error:'Нет сообщений'}),{'Content-Type':'application/json; charset=utf-8'});return;}
  const accessKey=process.env.APP_ACCESS_KEY;
  if(!accessKey){send(res,503,JSON.stringify({error:'APP_ACCESS_KEY_NOT_CONFIGURED'}),{'Content-Type':'application/json; charset=utf-8'});return;}
  const providedAccessKey=String(req.headers['x-app-key']||'');
  if(!providedAccessKey){send(res,401,JSON.stringify({error:'APP_ACCESS_KEY_REQUIRED'}),{'Content-Type':'application/json; charset=utf-8'});return;}
  if(providedAccessKey!==accessKey){send(res,401,JSON.stringify({error:'APP_ACCESS_KEY_INVALID'}),{'Content-Type':'application/json; charset=utf-8'});return;}
  const apiKey=process.env.OPENAI_API_KEY;
  if(!apiKey){send(res,503,JSON.stringify({error:'OPENAI_API_KEY_NOT_CONFIGURED'}),{'Content-Type':'application/json; charset=utf-8'});return;}
  const input=messages.map(m=>({role:m.role==='assistant'?'assistant':'user',content:String(m.content||'').slice(0,120000)}));
  const controller=new AbortController(); req.on('close',()=>controller.abort());
  try{
    const upstream=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},body:JSON.stringify({model,input,instructions:instructions||'Ты полезный персональный ассистент. Отвечай на языке пользователя.',reasoning:{effort:reasoning},stream:true,store:false}),signal:controller.signal});
    if(!upstream.ok){const text=await upstream.text();send(res,upstream.status,text,{'Content-Type':upstream.headers.get('content-type')||'application/json; charset=utf-8'});return;}
    res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','X-Accel-Buffering':'no','Connection':'keep-alive'});
    const reader=upstream.body.getReader();
    while(true){const {done,value}=await reader.read();if(done)break;if(!res.write(Buffer.from(value)))await new Promise(r=>res.once('drain',r));}
    res.end();
  }catch(err){if(!res.headersSent)send(res,500,JSON.stringify({error:err?.message||'Ошибка соединения с OpenAI'}),{'Content-Type':'application/json; charset=utf-8'});else res.end();}
}

const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);
  if(url.pathname==='/health') return send(res,200,JSON.stringify({ok:true}),{'Content-Type':'application/json; charset=utf-8'});
  if(url.pathname==='/api/chat'&&req.method==='POST') return handleChat(req,res);
  if(url.pathname==='/api/chat'&&req.method==='GET') return send(res,200,JSON.stringify({ok:true,service:'Pocket GPT-6 API'}),{'Content-Type':'application/json; charset=utf-8'});
  let p=url.pathname==='/'?'/index.html':url.pathname;
  p=path.normalize(p).replace(/^(\.\.(\/|\\|$))+/, '');
  const file=path.join(__dirname,p);
  if(!file.startsWith(__dirname)) return send(res,403,'Forbidden');
  fs.readFile(file,(err,data)=>{
    if(err){if(!path.extname(p)){fs.readFile(path.join(__dirname,'index.html'),(e,d)=>e?send(res,404,'Not found'):send(res,200,d,{'Content-Type':'text/html; charset=utf-8'}));}else send(res,404,'Not found');return;}
    const ext=path.extname(file); const headers={'Content-Type':mime[ext]||'application/octet-stream'};
    if(p==='/sw.js')headers['Cache-Control']='public, max-age=0, must-revalidate';
    send(res,200,data,headers);
  });
});
server.listen(PORT,'0.0.0.0',()=>console.log(`Pocket GPT-6 listening on ${PORT}`));
