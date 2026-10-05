import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);
const ffprobePath = ffprobeStatic.path;
const PORT = Number(process.env.PORT || 3000);
const MAX_FILE_BYTES = 49 * 1024 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const VIDEO_FRAME_COUNT = 12;
const ALLOWED_MODELS = new Set(['gpt-6-astra','gpt-6.1-sol','gpt-6-luna']);
const ALLOWED_REASONING = new Set(['low','medium','high','xhigh','max']);
const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json; charset=utf-8','.png':'image/png','.svg':'image/svg+xml'};

function send(res,status,body,headers={}){res.writeHead(status,{'X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin',...headers});res.end(body);}
function sendJson(res,status,body){send(res,status,JSON.stringify(body),{'Content-Type':'application/json; charset=utf-8'});}
async function readJson(req){let raw='';for await(const c of req){raw+=c;if(raw.length>2_000_000) throw new Error('Payload too large');}return JSON.parse(raw||'{}');}
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
function safeExt(filename, fallback='.bin'){
  const ext=path.extname(filename||'').toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(ext)?ext:fallback;
}
function isImageAttachment(a){
  const type=String(a?.type||'').toLowerCase();
  const name=String(a?.name||'').toLowerCase();
  return type.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/.test(name);
}
function isVideoAttachment(a){
  const type=String(a?.type||'').toLowerCase();
  const name=String(a?.name||'').toLowerCase();
  return a?.kind==='video' || type.startsWith('video/') || /\.(mp4|mov|m4v|webm|mpeg|mpg)$/.test(name);
}
async function saveRequestToFile(req,filePath,maxBytes){
  const declared=Number(req.headers['content-length']||0);
  if(declared>maxBytes) throw new Error('FILE_TOO_LARGE');
  let total=0;
  const out=fs.createWriteStream(filePath,{flags:'wx'});
  try{
    for await(const chunk of req){
      total+=chunk.length;
      if(total>maxBytes) throw new Error('FILE_TOO_LARGE');
      if(!out.write(chunk)) await new Promise((resolve,reject)=>{out.once('drain',resolve);out.once('error',reject);});
    }
    await new Promise((resolve,reject)=>out.end(err=>err?reject(err):resolve()));
    return total;
  }catch(err){
    out.destroy();
    await fsp.rm(filePath,{force:true}).catch(()=>{});
    throw err;
  }
}
async function uploadBlobToOpenAI(apiKey,blob,filename){
  const form=new FormData();
  form.append('purpose','user_data');
  form.append('file',blob,filename);
  const upstream=await fetch('https://api.openai.com/v1/files',{method:'POST',headers:{Authorization:`Bearer ${apiKey}`},body:form});
  const raw=await upstream.text();
  if(!upstream.ok) throw new Error(raw||`OpenAI Files HTTP ${upstream.status}`);
  const file=JSON.parse(raw);
  if(!file?.id) throw new Error('OpenAI не вернул ID файла');
  return file;
}
async function uploadPathToOpenAI(apiKey,filePath,contentType,filename){
  const data=await fsp.readFile(filePath);
  return uploadBlobToOpenAI(apiKey,new Blob([data],{type:contentType}),filename);
}
async function transcribeAudio(apiKey,audioPath){
  const stat=await fsp.stat(audioPath);
  if(!stat.size) return '';
  if(stat.size>25*1024*1024) throw new Error('AUDIO_TOO_LARGE');
  const data=await fsp.readFile(audioPath);
  const form=new FormData();
  form.append('model','gpt-transcribe');
  form.append('file',new Blob([data],{type:'audio/mpeg'}),'audio.mp3');
  const upstream=await fetch('https://api.openai.com/v1/audio/transcriptions',{method:'POST',headers:{Authorization:`Bearer ${apiKey}`},body:form});
  const raw=await upstream.text();
  if(!upstream.ok) throw new Error(raw||`Transcription HTTP ${upstream.status}`);
  let parsed={}; try{parsed=JSON.parse(raw);}catch{}
  return String(parsed.text||raw||'').trim();
}
async function probeDuration(filePath){
  try{
    const {stdout}=await execFileAsync(ffprobePath,['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',filePath],{timeout:30000,maxBuffer:1024*1024});
    const n=Number(String(stdout).trim());
    return Number.isFinite(n)&&n>0?n:0;
  }catch{return 0;}
}
async function processVideo(apiKey,inputPath,workDir,filename,contentType,size){
  const duration=await probeDuration(inputPath);
  const interval=Math.max(duration>0?duration/VIDEO_FRAME_COUNT:5,0.5);
  const framePattern=path.join(workDir,'frame-%02d.jpg');
  await execFileAsync(ffmpegPath,[
    '-hide_banner','-loglevel','error','-i',inputPath,
    '-vf',`fps=1/${interval.toFixed(3)},scale=1280:-2:force_original_aspect_ratio=decrease`,
    '-frames:v',String(VIDEO_FRAME_COUNT),'-q:v','4','-y',framePattern
  ],{timeout:240000,maxBuffer:2*1024*1024});
  const entries=(await fsp.readdir(workDir)).filter(x=>/^frame-\d+\.jpg$/.test(x)).sort();
  if(!entries.length) throw new Error('Не удалось извлечь кадры из видео.');

  let transcript='';
  const audioPath=path.join(workDir,'audio.mp3');
  try{
    await execFileAsync(ffmpegPath,[
      '-hide_banner','-loglevel','error','-i',inputPath,
      '-vn','-ac','1','-ar','16000','-b:a','16k','-y',audioPath
    ],{timeout:240000,maxBuffer:2*1024*1024});
    transcript=await transcribeAudio(apiKey,audioPath);
  }catch(err){
    if(err?.message==='AUDIO_TOO_LARGE') transcript='[Аудиодорожка слишком длинная для транскрибации одним запросом.]';
  }

  const frameFileIds=[];
  for(const entry of entries){
    const uploaded=await uploadPathToOpenAI(apiKey,path.join(workDir,entry),'image/jpeg',entry);
    frameFileIds.push(uploaded.id);
  }
  let transcriptFileId=null;
  if(transcript){
    const uploaded=await uploadBlobToOpenAI(apiKey,new Blob([transcript],{type:'text/plain; charset=utf-8'}),`${path.parse(filename).name || 'video'}-transcript.txt`);
    transcriptFileId=uploaded.id;
  }
  return {kind:'video',name:filename,size,type:contentType,duration:Math.round(duration*10)/10,frameFileIds,transcriptFileId,frameCount:frameFileIds.length,hasTranscript:Boolean(transcriptFileId)};
}
async function handleFileUpload(req,res){
  if(!requireAccess(req,res)) return;
  const apiKey=process.env.OPENAI_API_KEY;
  if(!apiKey){sendJson(res,503,{error:'OPENAI_API_KEY_NOT_CONFIGURED'});return;}
  const declared=Number(req.headers['content-length']||0);
  if(declared>=50*1024*1024){sendJson(res,413,{error:'FILE_TOO_LARGE',maxBytes:MAX_FILE_BYTES});return;}
  let data;
  try{
    const chunks=[]; let total=0;
    for await(const chunk of req){total+=chunk.length;if(total>MAX_FILE_BYTES) throw new Error('FILE_TOO_LARGE');chunks.push(chunk);}
    data=Buffer.concat(chunks,total);
  }catch(err){
    if(err?.message==='FILE_TOO_LARGE'){sendJson(res,413,{error:'FILE_TOO_LARGE',maxBytes:MAX_FILE_BYTES});return;}
    sendJson(res,400,{error:'Не удалось прочитать файл'});return;
  }
  if(!data.length){sendJson(res,400,{error:'EMPTY_FILE'});return;}
  const filename=safeFilename(req.headers['x-file-name']);
  const contentType=String(req.headers['content-type']||'application/octet-stream').split(';')[0].trim()||'application/octet-stream';
  try{
    const file=await uploadBlobToOpenAI(apiKey,new Blob([data],{type:contentType}),filename);
    sendJson(res,200,{id:file.id,filename:file.filename||filename,bytes:file.bytes||data.length,type:contentType});
  }catch(err){sendJson(res,500,{error:err?.message||'Ошибка загрузки файла в OpenAI'});}
}
async function handleVideoUpload(req,res){
  if(!requireAccess(req,res)) return;
  const apiKey=process.env.OPENAI_API_KEY;
  if(!apiKey){sendJson(res,503,{error:'OPENAI_API_KEY_NOT_CONFIGURED'});return;}
  const filename=safeFilename(req.headers['x-file-name']);
  const contentType=String(req.headers['content-type']||'video/mp4').split(';')[0].trim()||'video/mp4';
  if(!isVideoAttachment({name:filename,type:contentType})){sendJson(res,415,{error:'UNSUPPORTED_VIDEO'});return;}
  const workDir=path.join(os.tmpdir(),`pocket-video-${randomUUID()}`);
  await fsp.mkdir(workDir,{recursive:true});
  const inputPath=path.join(workDir,`input${safeExt(filename,'.mp4')}`);
  try{
    const size=await saveRequestToFile(req,inputPath,MAX_VIDEO_BYTES);
    if(!size){sendJson(res,400,{error:'EMPTY_FILE'});return;}
    const result=await processVideo(apiKey,inputPath,workDir,filename,contentType,size);
    sendJson(res,200,result);
  }catch(err){
    if(err?.message==='FILE_TOO_LARGE'){sendJson(res,413,{error:'VIDEO_TOO_LARGE',maxBytes:MAX_VIDEO_BYTES});return;}
    sendJson(res,500,{error:String(err?.message||'Не удалось обработать видео').slice(0,1200)});
  }finally{await fsp.rm(workDir,{recursive:true,force:true}).catch(()=>{});}
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
      if(isVideoAttachment(a)){
        const frames=Array.isArray(a.frameFileIds)?a.frameFileIds.slice(0,VIDEO_FRAME_COUNT):[];
        const transcriptFileId=String(a.transcriptFileId||'').slice(0,180);
        parts.push({type:'input_text',text:`Видео «${String(a.name||'video').slice(0,180)}» (~${Number(a.duration||0).toFixed(1)} сек). Далее идут репрезентативные кадры из ролика${transcriptFileId?' и файл с расшифровкой речи':''}.`});
        if(transcriptFileId) parts.push({type:'input_file',file_id:transcriptFileId});
        for(const id of frames){if(id) parts.push({type:'input_image',file_id:String(id).slice(0,180),detail:'auto'});}
        continue;
      }
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
  if(url.pathname==='/health') return sendJson(res,200,{ok:true,video:true,maxVideoBytes:MAX_VIDEO_BYTES});
  if(url.pathname==='/api/files'&&req.method==='POST') return handleFileUpload(req,res);
  if(url.pathname==='/api/videos'&&req.method==='POST') return handleVideoUpload(req,res);
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
