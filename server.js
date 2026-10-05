import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const ALLOWED_MODELS = new Set(['gpt-6-astra','gpt-6.1-sol','gpt-6-luna']);
const ALLOWED_REASONING = new Set(['low','medium','high','xhigh','max']);
const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json; charset=utf-8','.png':'image/png','.svg':'image/svg+xml'};

function send(res,status,body,headers={}){res.writeHead(status,{'X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin',...headers});res.end(body);}
function sendJson(res,status,body){send(res,status,JSON.stringify(body),{'Content-Type':'application/json; charset=utf-8'});}
async function readJson(req){let raw='';for await(const c of req){raw+=c;if(raw.length>2_000_000) throw new Error('Payload too large');}return JSON.parse(raw||'{}');}
async function readBuffer(req,maxBytes=MAX_FILE_BYTES){
  const chunks=[]; let total=0;
  for await(const chunk of req){
    total += chunk.length;
    if(total>maxBytes) throw new Error('FILE_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks,total);
}
function requireAccess(req,res){
  const accessKey=process.env.APP_ACCESS_KEY;
  if(!accessKey){sendJson(res,503,{error:'APP_ACCESS_KEY_NOT_CONFIGURED'});return false;}
  const provided=String(req.headers['x-app-key']||'');
  if(!provided){sendJson(res,401,{error:'APP_ACCESS_KEY_REQUIRED'});return false;}
  if(provided!==accessKey){sendJson(res,401,{error:'APP_ACCESS_KEY_INVALID'});return false;}
  return true;
}
function safeFilename(raw){
  let name=String(raw||'file');
  try{name=decodeURIComponent(name);}catch{}
  name=name.replace(/\\/g,'/').split('/').pop()||'file';
  name=name.replace(/[\u0000-\u001f\u007f]/g,'').trim();
  return (name||'file').slice(0,180);
}
function isImageAttachment(a){
  const type=String(a?.type||'').toLowerCase();
  const name=String(a?.name||'').toLowerCase();
  return type.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/.test(name);
}

async function handleFileUpload(req,res){
  if(!requireAccess(req,res)) return;
  const apiKey=process.env.OPENAI_API_KEY;
  if(!apiKey){sendJson(res,503,{error:'OPENAI_API_KEY_NOT_CONFIGURED'});return;}

  const declared=Number(req.headers['content-length']||0);
  if(declared>MAX_FILE_BYTES){sendJson(res,413,{error:'FILE_TOO_LARGE',maxBytes:MAX_FILE_BYTES});return;}

  let data;
  try{data=await readBuffer(req);}
  catch(err){
    if(err?.message==='FILE_TOO_LARGE'){sendJson(res,413,{error:'FILE_TOO_LARGE',maxBytes:MAX_FILE_BYTES});return;}
    sendJson(res,400,{error:'Не удалось прочитать файл'});return;
  }
  if(!data.length){sendJson(res,400,{error:'EMPTY_FILE'});return;}

  const filename=safeFilename(req.headers['x-file-name']);
  const contentType=String(req.headers['content-type']||'application/octet-stream').split(';')[0].trim()||'application/octet-stream';

  try{
    const form=new FormData();
    form.append('purpose','user_data');
    form.append('file',new Blob([data],{type:contentType}),filename);
    const upstream=await fetch('https://api.openai.com/v1/files',{
      method:'POST',
      headers:{Authorization:`Bearer ${apiKey}`},
      body:form
    });
    const raw=await upstream.text();
    if(!upstream.ok){
      send(res,upstream.status,raw,{'Content-Type':upstream.headers.get('content-type')||'application/json; charset=utf-8'});
      return;
    }
    let file={}; try{file=JSON.parse(raw);}catch{}
    sendJson(res,200,{id:file.id,filename:file.filename||filename,bytes:file.bytes||data.length,type:contentType});
  }catch(err){
    sendJson(res,500,{error:err?.message||'Ошибка загрузки файла в OpenAI'});
  }
}

async function handleChat(req,res){
  let body; try{body=await readJson(req);}catch{sendJson(res,400,{error:'Некорректный JSON'});return;}
  const model=ALLOWED_MODELS.has(body.model)?body.model:'gpt-6.1-sol';
  const reasoning=ALLOWED_REASONING.has(body.reasoning)?body.reasoning:'medium';
  const messages=Array.isArray(body.messages)?body.messages.slice(-40):[];
  const instructions=typeof body.instructions==='string'?body.instructions.slice(0,24000):'';
  if(!messages.length){sendJson(res,400,{error:'Нет сообщений'});return;}
  if(!requireAccess(req,res)) return;
  const apiKey=process.env.OPENAI_API_KEY;
  if(!apiKey){sendJson(res,503,{error:'OPENAI_API_KEY_NOT_CONFIGURED'});return;}

  const input=messages.map(m=>{
    const role=m.role==='assistant'?'assistant':'user';
    const text=String(m.content||'').slice(0,120000);
    if(role==='assistant') return {role:'assistant',content:text};

    const parts=[];
    if(text) parts.push({type:'input_text',text});
    const attachments=Array.isArray(m.attachments)?m.attachments.slice(0,5):[];
    for(const a of attachments){
      const fileId=String(a?.fileId||'').slice(0,180);
      if(!fileId) continue;
      if(isImageAttachment(a)) parts.push({type:'input_image',file_id:fileId,detail:'auto'});
      else parts.push({type:'input_file',file_id:fileId});
    }
    if(!parts.length) parts.push({type:'input_text',text:' '});
    return {role:'user',content:parts};
  });

  const controller=new AbortController(); req.on('close',()=>controller.abort());
  try{
    const upstream=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},body:JSON.stringify({model,input,instructions:instructions||'Ты полезный персональный ассистент. Отвечай на языке пользователя.',reasoning:{effort:reasoning},stream:true,store:false}),signal:controller.signal});
    if(!upstream.ok){const text=await upstream.text();send(res,upstream.status,text,{'Content-Type':upstream.headers.get('content-type')||'application/json; charset=utf-8'});return;}
    res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','X-Accel-Buffering':'no','Connection':'keep-alive'});
    const reader=upstream.body.getReader();
    while(true){const {done,value}=await reader.read();if(done)break;if(!res.write(Buffer.from(value)))await new Promise(r=>res.once('drain',r));}
    res.end();
  }catch(err){if(!res.headersSent)sendJson(res,500,{error:err?.message||'Ошибка соединения с OpenAI'});else res.end();}
}

const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);
  if(url.pathname==='/health') return sendJson(res,200,{ok:true});
  if(url.pathname==='/api/files'&&req.method==='POST') return handleFileUpload(req,res);
  if(url.pathname==='/api/chat'&&req.method==='POST') return handleChat(req,res);
  if(url.pathname==='/api/chat'&&req.method==='GET') return sendJson(res,200,{ok:true,service:'Pocket GPT-6 API'});
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
