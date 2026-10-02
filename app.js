const $ = (id) => document.getElementById(id);
const STORAGE_KEY = "pocket_gpt6_state_v1";
const ACCESS_KEY = "pocket_gpt6_access_key";
const MODEL_NAMES = {"gpt-6-luna":"GPT-6 Luna","gpt-6.1-sol":"GPT-6.1 Sol","gpt-6-astra":"GPT-6 Astra"};
const PRICES = {
  "gpt-6-luna": { input: 0.10, cached: 0.01, output: 0.50 },
  "gpt-6.1-sol": { input: 2.00, cached: 0.10, output: 10.00 },
  "gpt-6-astra": { input: 10.00, cached: 1.00, output: 50.00 }
};

const defaultState = () => ({
  settings: { model: "gpt-6.1-sol", reasoning: "medium", budget: 20, memory: "Отвечай по-русски, если пользователь не попросил иначе. Пиши прямо, по делу и без лишней воды." },
  chats: [],
  activeChatId: null
});

let state = loadState();
let abortController = null;
let streaming = false;

function loadState(){
  try { return { ...defaultState(), ...JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") }; }
  catch { return defaultState(); }
}
function saveState(){ localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
function uid(){ return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`; }
function now(){ return new Date().toISOString(); }
function activeChat(){ return state.chats.find(c => c.id === state.activeChatId) || null; }
function ensureChat(){
  let c = activeChat();
  if (!c) {
    c = { id: uid(), title: "Новый чат", createdAt: now(), updatedAt: now(), messages: [] };
    state.chats.unshift(c); state.activeChatId = c.id; saveState();
  }
  return c;
}
function money(v){ return `$${Number(v || 0).toFixed(v >= 1 ? 2 : 4)}`; }
function estimateCost(model, usage={}){
  const p = PRICES[model] || PRICES["gpt-6.1-sol"];
  const input = Number(usage.input_tokens || 0);
  const cached = Number(usage.input_tokens_details?.cached_tokens || 0);
  const output = Number(usage.output_tokens || 0);
  const uncached = Math.max(0, input - cached);
  return (uncached*p.input + cached*p.cached + output*p.output)/1_000_000;
}
function monthSpend(){
  const d = new Date(), ym = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
  return state.chats.flatMap(c=>c.messages).filter(m => (m.createdAt||"").startsWith(ym)).reduce((s,m)=>s+(m.cost||0),0);
}
function toast(msg){ const el=$("toast"); el.textContent=msg; el.classList.remove("hidden"); clearTimeout(toast.t); toast.t=setTimeout(()=>el.classList.add("hidden"),2200); }

function render(){
  $("modelLabel").textContent = MODEL_NAMES[state.settings.model] || state.settings.model;
  $("modelSelect").value = state.settings.model;
  $("budgetInput").value = state.settings.budget;
  $("memoryInput").value = state.settings.memory;
  $("accessKeyInput").value = localStorage.getItem(ACCESS_KEY) || "";
  document.querySelectorAll("#reasoningOptions button").forEach(b=>b.classList.toggle("active", b.dataset.r===state.settings.reasoning));
  renderBudget(); renderChat(); renderChatList();
}
function renderBudget(){
  const spent = monthSpend(), budget = Math.max(1,Number(state.settings.budget)||20), pct=Math.min(100,spent/budget*100);
  $("monthCost").textContent=money(spent); $("budgetLabel").textContent=`из $${budget} / месяц`; $("budgetFill").style.width=`${pct}%`;
}
function renderChat(){
  const c=activeChat(); const msgs=c?.messages||[]; $("welcome").classList.toggle("hidden",msgs.length>0);
  $("chat").innerHTML="";
  for(const m of msgs){
    const wrap=document.createElement("div"); wrap.className=`message ${m.role}`;
    const bubble=document.createElement("div"); bubble.className="bubble"; bubble.textContent=m.content || ""; wrap.appendChild(bubble);
    if(m.role==="assistant"){
      const meta=document.createElement("div"); meta.className="message-meta";
      const model=document.createElement("span"); model.textContent=MODEL_NAMES[m.model]||"GPT"; meta.appendChild(model);
      if(m.cost!=null){ const cost=document.createElement("span"); cost.textContent=`≈ ${money(m.cost)}`; meta.appendChild(cost); }
      const cp=document.createElement("button"); cp.className="copy-btn"; cp.textContent="Копировать"; cp.onclick=async()=>{await navigator.clipboard.writeText(m.content||"");toast("Скопировано");}; meta.appendChild(cp); wrap.appendChild(meta);
    }
    $("chat").appendChild(wrap);
  }
  requestAnimationFrame(()=>{$("chat").scrollTop=$("chat").scrollHeight;});
}
function renderChatList(){
  const list=$("chatList"); list.innerHTML="";
  for(const c of [...state.chats].sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)))){
    const row=document.createElement("div"); row.className=`chat-item ${c.id===state.activeChatId?"active":""}`;
    const btn=document.createElement("button"); btn.textContent=c.title||"Новый чат"; btn.onclick=()=>{state.activeChatId=c.id;saveState();closePanels();render();};
    const del=document.createElement("button"); del.className="trash"; del.textContent="×"; del.onclick=(e)=>{e.stopPropagation();state.chats=state.chats.filter(x=>x.id!==c.id);if(state.activeChatId===c.id)state.activeChatId=state.chats[0]?.id||null;saveState();render();};
    row.append(btn,del); list.appendChild(row);
  }
}
function setStreaming(v){ streaming=v; $("sendBtn").classList.toggle("hidden",v); $("stopBtn").classList.toggle("hidden",!v); $("prompt").disabled=v; }
function autoResize(){ const el=$("prompt"); el.style.height="auto"; el.style.height=Math.min(el.scrollHeight,150)+"px"; }

function openPanel(id){ $("backdrop").classList.remove("hidden"); const p=$(id); p.classList.remove("hidden-panel"); requestAnimationFrame(()=>p.classList.add("open")); p.setAttribute("aria-hidden","false"); }
function closePanels(){
  for(const id of ["drawer","settings","modelSheet"]){const p=$(id);p.classList.remove("open");p.classList.add("hidden-panel");p.setAttribute("aria-hidden","true");}
  $("backdrop").classList.add("hidden");
}

async function sendMessage(text){
  if(streaming||!text.trim()) return;
  const c=ensureChat();
  const userMsg={id:uid(),role:"user",content:text.trim(),createdAt:now()}; c.messages.push(userMsg);
  if(c.messages.filter(m=>m.role==="user").length===1) c.title=text.trim().replace(/\s+/g," ").slice(0,48);
  c.updatedAt=now(); saveState(); render();
  $("prompt").value=""; autoResize();

  const assistantMsg={id:uid(),role:"assistant",content:"",createdAt:now(),model:state.settings.model,reasoning:state.settings.reasoning,cost:null};
  c.messages.push(assistantMsg); c.updatedAt=now(); saveState(); render();
  const bubble=$("chat").lastElementChild?.querySelector(".bubble");
  if(bubble) bubble.innerHTML='<span class="thinking"><i></i><i></i><i></i></span>';
  setStreaming(true); abortController=new AbortController();

  try{
    const accessKey=localStorage.getItem(ACCESS_KEY)||"";
    const response=await fetch("/api/chat",{
      method:"POST",
      headers:{"Content-Type":"application/json",...(accessKey?{"x-app-key":accessKey}:{})},
      body:JSON.stringify({
        model:state.settings.model,
        reasoning:state.settings.reasoning,
        instructions:state.settings.memory,
        messages:c.messages.filter(m=>m.id!==assistantMsg.id).slice(-40).map(m=>({role:m.role,content:m.content}))
      }),
      signal:abortController.signal
    });
    if(!response.ok){
      const raw=await response.text(); let msg=raw;
      try{const j=JSON.parse(raw);msg=j.error?.message||j.error||raw;}catch{}
      if(response.status===401 && /APP_ACCESS_KEY_(REQUIRED|INVALID)/.test(String(msg))){ openPanel("settings"); throw new Error("Нужен правильный код доступа к приложению."); }
      if(response.status===503 && String(msg).includes("OPENAI_API_KEY_NOT_CONFIGURED")){ throw new Error("На сервере не задан OPENAI_API_KEY."); }
      throw new Error(msg || `HTTP ${response.status}`);
    }

    const reader=response.body.getReader(); const decoder=new TextDecoder(); let buffer=""; let started=false; let usage=null;
    while(true){
      const {done,value}=await reader.read(); if(done) break;
      buffer += decoder.decode(value,{stream:true});
      const parts=buffer.split("\n\n"); buffer=parts.pop()||"";
      for(const part of parts){
        const dataLines=part.split("\n").filter(l=>l.startsWith("data:")).map(l=>l.slice(5).trim());
        if(!dataLines.length) continue;
        const data=dataLines.join("\n"); if(data==="[DONE]") continue;
        let evt; try{evt=JSON.parse(data);}catch{continue;}
        if(evt.type==="response.output_text.delta" && typeof evt.delta==="string"){
          if(!started){assistantMsg.content="";started=true;}
          assistantMsg.content += evt.delta;
          if(bubble){bubble.textContent=assistantMsg.content; $("chat").scrollTop=$("chat").scrollHeight;}
        }
        if(evt.type==="response.completed" && evt.response?.usage) usage=evt.response.usage;
        if(evt.type==="error") throw new Error(evt.error?.message||evt.message||"Ошибка OpenAI");
      }
    }
    assistantMsg.cost=estimateCost(assistantMsg.model,usage||{}); assistantMsg.usage=usage||null;
    if(!assistantMsg.content) assistantMsg.content="Ответ получен без текстового блока.";
    c.updatedAt=now(); saveState(); render();
  }catch(err){
    if(err.name==="AbortError"){
      if(!assistantMsg.content) assistantMsg.content="Остановлено."; else assistantMsg.content += "\n\n[Остановлено]";
    }else{
      assistantMsg.content=`Ошибка: ${String(err.message||err).slice(0,900)}`;
    }
    c.updatedAt=now(); saveState(); render();
  }finally{ setStreaming(false); abortController=null; }
}

$("composer").addEventListener("submit",e=>{e.preventDefault();sendMessage($("prompt").value);});
$("prompt").addEventListener("input",autoResize);
$("prompt").addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey&&!e.isComposing){e.preventDefault();sendMessage($("prompt").value);}});
$("stopBtn").onclick=()=>abortController?.abort();
$("menuBtn").onclick=()=>openPanel("drawer"); $("settingsBtn").onclick=()=>openPanel("settings"); $("modelBtn").onclick=()=>openPanel("modelSheet");
$("closeDrawer").onclick=$("closeSettings").onclick=$("closeModelSheet").onclick=$("backdrop").onclick=closePanels;
$("newChatBtn").onclick=()=>{const c={id:uid(),title:"Новый чат",createdAt:now(),updatedAt:now(),messages:[]};state.chats.unshift(c);state.activeChatId=c.id;saveState();closePanels();render();};
$("modelSelect").onchange=e=>{state.settings.model=e.target.value;saveState();render();};
document.querySelectorAll("#reasoningOptions button").forEach(b=>b.onclick=()=>{state.settings.reasoning=b.dataset.r;saveState();render();});
document.querySelectorAll(".model-option").forEach(b=>b.onclick=()=>{state.settings.model=b.dataset.model;saveState();closePanels();render();toast(`${MODEL_NAMES[b.dataset.model]} выбран`);});
$("saveSettings").onclick=()=>{state.settings.model=$("modelSelect").value;state.settings.budget=Math.max(1,Number($("budgetInput").value)||20);state.settings.memory=$("memoryInput").value.slice(0,24000);const key=$("accessKeyInput").value.trim();if(key)localStorage.setItem(ACCESS_KEY,key);else localStorage.removeItem(ACCESS_KEY);saveState();closePanels();render();toast("Настройки сохранены");};
$("clearData").onclick=()=>{if(confirm("Удалить все локальные чаты и статистику расходов на этом устройстве?")){state=defaultState();localStorage.removeItem(ACCESS_KEY);saveState();render();toast("История удалена");}};
document.querySelectorAll(".suggestion").forEach(b=>b.onclick=()=>{$("prompt").value=b.textContent;autoResize();$("prompt").focus();});

if("serviceWorker" in navigator){window.addEventListener("load",()=>navigator.serviceWorker.register("/sw.js").catch(()=>{}));}
render(); autoResize();
