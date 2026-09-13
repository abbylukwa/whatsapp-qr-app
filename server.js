'use strict';

/* ============================================================
 *  BreadBot v48 — Admin-Priority Edition
 *  - Admin: full `!` command system (original + new commands)
 *  - Admin detection: phone + LIDs (same as original)
 *  - Everyone else: natural chat, no prefix
 *  - Main group: AI replies 24/7
 *  - Other groups: 2% ambient OR when directly addressed
 *  - DMs: AI window 21:00 → 08:00
 *  - Job queue max 2000 (priority: admin > main > DM > groups)
 *  - Download: search → numbered list → pick / mass-pick
 *  - NSFW: separate scraper site, admin always, others night-only
 *  - y2mate downloader (replaces yt-dlp)
 *  - Main-group-only welcomes (AI-generated)
 *  - 515 anti-spam reconnect preserved
 * ============================================================ */

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const NodeCache = require('node-cache');
const {
  makeWASocket, DisconnectReason, useMultiFileAuthState,
  Browsers, fetchLatestBaileysVersion, downloadMediaMessage
} = require('@whiskeysockets/baileys');

let wrapSocket=null, createHumanEntropyService=null, classifyDisconnect=null, SessionHealthMonitor=null;
try {
  const ab = require('baileys-antiban');
  wrapSocket                = ab.wrapSocket || null;
  createHumanEntropyService = ab.createHumanEntropyService || null;
  classifyDisconnect        = ab.classifyDisconnect || null;
  SessionHealthMonitor      = ab.SessionHealthMonitor || null;
} catch (e) {}

const QRCode = require('qrcode');
const pino   = require('pino');
const axios  = require('axios');

/* ══════════════════════════════════════════════════════════════
 *  CONFIG
 * ══════════════════════════════════════════════════════════════ */
const PORT          = process.env.PORT || 10000;
const AUTH_FOLDER   = 'auth_info';

const ADMIN_PHONE   = (process.env.ADMIN_PHONE || '263777627210').replace(/\D/g,'');
const ADMIN_JID     = `${ADMIN_PHONE}@s.whatsapp.net`;
const ADMIN_LID_FILE         = path.join(__dirname,'admin_lids.json');
const HARDCODED_ADMIN_LIDS   = ['115110005706891'];
const ADMIN_GROUP_JID_FILE   = path.join(__dirname,'admin_group_jid.json');
const ADMIN_GROUP_LINK       = 'https://chat.whatsapp.com/HGW3IdVbDJyImOgp1BFqT7?s=sw&p=a&mlu=4&ilr=4';
const MAIN_GROUP_FILE        = path.join(__dirname,'main_group_jid.json');

const JOIN_INTERVAL_MS   = parseInt(process.env.JOIN_INTERVAL_MS || '480000', 10);
const JOIN_QUEUE_FILE    = path.join(__dirname,'join_queue.json');
const JOINED_GROUPS_FILE = path.join(__dirname,'joined_groups.json');
const PENDING_FILE       = path.join(__dirname,'pending_requests.json');
const LEARNING_DATA_FILE = path.join(__dirname,'learning_data.json');
const GROUP_SETTINGS_FILE= path.join(__dirname,'group_settings.json');
const DOWNLOAD_DIR       = path.join(__dirname,'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR,{recursive:true});

const GREETING_MIN_HOURS = 4, GREETING_MAX_HOURS = 8;
const DAILY_REPORT_HOUR  = parseInt(process.env.DAILY_REPORT_HOUR || '22', 10);
const USER_HISTORY_SIZE  = 4;
const PENDING_EXPIRY_MS  = 3600000;
const DM_QUEUE_MAX       = 50;
const FOCUS_LOCK_TIMEOUT_MS = 30000;
const MESSAGE_FLOOD_THRESHOLD = 20;
const FLOOD_IGNORE_MS    = 5000;
const TZ_OFFSET_HOURS    = parseInt(process.env.TZ_OFFSET_HOURS || '2', 10);
const MEDIA_MAX_BYTES    = 34 * 1024 * 1024;

/* Time windows */
const GROUP_ACTIVE_START = 21;
const GROUP_ACTIVE_END   = 0;
const NSFW_START         = 21;
const NSFW_END           = 8;
const DM_AI_START_HOUR   = 21;
const DM_AI_END_HOUR     = 8;
const AMBIENT_CHANCE     = 0.02;

/* AI */
const AI_KEY      = process.env.OPENAI_API_KEY || process.env.REWIND_KEY || process.env.AI_API_KEY || '';
const AI_ENDPOINT = process.env.AI_ENDPOINT || 'https://api.openai.com/v1/chat/completions';
const AI_MODEL    = process.env.AI_MODEL    || 'gpt-4o-mini';

/* Scraper */
const SCRAPER_URL       = (process.env.SCRAPER_URL || 'https://intelligent-scraper.onrender.com').replace(/\/$/,'');
const SCRAPER_SFW_SITE  = process.env.SCRAPER_SFW_SITE  || 'darknaija';
const SCRAPER_NSFW_SITE = process.env.SCRAPER_NSFW_SITE || 'nsfw';

/* Jobs */
const JOB_MAX            = 2000;
const JOB_GAP_MIN_MS     = 800;
const JOB_GAP_MAX_MS     = 8000;
const DOWNLOAD_PICK_TTL  = 10 * 60 * 1000;
const DOWNLOAD_MAX_PICKS = 8;

let botPaused = false;

/* ══════════════════════════════════════════════════════════════
 *  FIBONACCI CLOCK  (unchanged)
 * ══════════════════════════════════════════════════════════════ */
const FIBONACCI_SECONDS = [1,1,2,3,5,8,13,21,34,55,89,144,233,377,610];
class FibonacciClock {
  constructor(){ this.idx=0; this.history=[]; }
  next(){
    const roll=Math.random();
    if(roll<0.08) this.idx=Math.floor(Math.random()*3);
    else if(roll<0.28) this.idx=(this.idx+2)%FIBONACCI_SECONDS.length;
    else this.idx=(this.idx+1)%FIBONACCI_SECONDS.length;
    const sec=FIBONACCI_SECONDS[this.idx];
    this.history.push(sec); if(this.history.length>50) this.history.shift();
    return sec*1000;
  }
  peek(){ return FIBONACCI_SECONDS[this.idx]*1000; }
  nextCapped(maxSeconds){ return Math.min(this.next(),maxSeconds*1000); }
}
const fib = new FibonacciClock();

/* ══════════════════════════════════════════════════════════════
 *  TIME WINDOW GATE  (unchanged)
 * ══════════════════════════════════════════════════════════════ */
class TimeWindowGate {
  constructor(offsetHours=2){ this.offset=offsetHours; }
  localHour(){ return (new Date().getUTCHours()+this.offset)%24; }
  window(){
    const h=this.localHour();
    if(h>=22||h<6) return 'sleep';
    if(h>=6&&h<8) return 'light';
    if(h>=12&&h<13) return 'lunch';
    if(h>=18&&h<19) return 'dinner';
    if(h>=20) return 'light';
    return 'active';
  }
  isOffline(){ const w=this.window(); return w==='sleep'||w==='lunch'||w==='dinner'; }
  speedFactor(){ const w=this.window(); return w==='active'?1.0:w==='light'?0.5:(w==='lunch'||w==='dinner')?0.1:0.0; }
  isGroupActive(){
    const h=this.localHour();
    if(GROUP_ACTIVE_START<=GROUP_ACTIVE_END) return h>=GROUP_ACTIVE_START&&h<GROUP_ACTIVE_END;
    return h>=GROUP_ACTIVE_START||h<GROUP_ACTIVE_END;
  }
  isNsfwActive(){ const h=this.localHour(); return h>=NSFW_START||h<NSFW_END; }
  isDmAiWindow(){
    const h=this.localHour();
    if(DM_AI_START_HOUR<=DM_AI_END_HOUR) return h>=DM_AI_START_HOUR&&h<DM_AI_END_HOUR;
    return h>=DM_AI_START_HOUR||h<DM_AI_END_HOUR;
  }
  describe(){ return `${String(this.localHour()).padStart(2,'0')}:xx — ${this.window()}`; }
  describeGroup(){ return this.isGroupActive()?'ACTIVE (21:00-00:00)':'IDLE'; }
  describeNsfw(){ return this.isNsfwActive()?'ALLOWED (21:00-08:00)':'BLOCKED (08:00-21:00)'; }
  describeDm(){ return this.isDmAiWindow()?'ON (21:00-08:00)':'OFF (08:00-21:00)'; }
}
const timeGate = new TimeWindowGate(TZ_OFFSET_HOURS);

/* ══════════════════════════════════════════════════════════════
 *  BOT SENT IDS
 * ══════════════════════════════════════════════════════════════ */
const botSentIds = new Set();
function markBotSent(id){
  if(!id) return;
  botSentIds.add(id);
  if(botSentIds.size>2000){ const a=[...botSentIds]; botSentIds.clear();
    for(const i of a.slice(-1000)) botSentIds.add(i); }
}

/* ══════════════════════════════════════════════════════════════
 *  JOB QUEUE  (2000 max, priority)
 * ══════════════════════════════════════════════════════════════ */
class JobQueue {
  constructor(max=JOB_MAX){ this.items=[]; this.max=max; this.running=false;
    this.totalRun=0; this.totalFailed=0; this.totalDropped=0; }
  push(job){
    if(this.items.length>=this.max){
      this.items.sort((a,b)=>b.priority-a.priority);
      this.items.pop();
      this.totalDropped++;
      pushLog('warn','jobs',`Queue full (${this.max}) — dropped oldest low-prio job`);
    }
    job.id=Date.now()+Math.random(); job.ts=Date.now();
    this.items.push(job);
    this.items.sort((a,b)=>a.priority-b.priority || a.ts-b.ts);
    this.pump();
  }
  async pump(){
    if(this.running) return;
    this.running=true;
    while(this.items.length){
      const job=this.items.shift();
      const gap=JOB_GAP_MIN_MS+Math.random()*(JOB_GAP_MAX_MS-JOB_GAP_MIN_MS);
      try{ await job.fn(); this.totalRun++; }
      catch(e){ this.totalFailed++; pushLog('error','jobs',`${job.name}: ${e.message}`); }
      await new Promise(r=>setTimeout(r,gap));
    }
    this.running=false;
  }
  stats(){ return { queued:this.items.length, running:this.running?1:0, max:this.max,
    totalRun:this.totalRun, totalFailed:this.totalFailed, totalDropped:this.totalDropped }; }
}
const jobs = new JobQueue(JOB_MAX);

/* ══════════════════════════════════════════════════════════════
 *  LOG BUFFER + LIVE
 * ══════════════════════════════════════════════════════════════ */
const LOG_BUFFER_MAX = 500, logBuffer=[], logClients=new Set();
const LIVE_MSG_MAX   = 200, liveMessages=[], msgClients=new Set();

function pushLog(level, source, message, meta={}){
  const entry={ id:Date.now()+Math.random(), ts:new Date().toISOString(), level, source, message,
    meta:Object.keys(meta).length?meta:undefined };
  logBuffer.push(entry); if(logBuffer.length>LOG_BUFFER_MAX) logBuffer.shift();
  const payload=`data: ${JSON.stringify(entry)}\n\n`;
  for(const res of logClients){ try{res.write(payload);}catch(e){logClients.delete(res);} }
  console.log(`${new Date().toTimeString().slice(0,8)}[${level.toUpperCase()}] ${source}: ${message}`);
}
function pushLiveMessage(entry){
  liveMessages.push(entry); if(liveMessages.length>LIVE_MSG_MAX) liveMessages.shift();
  const payload=`data: ${JSON.stringify(entry)}\n\n`;
  for(const res of msgClients){ try{res.write(payload);}catch(e){msgClients.delete(res);} }
}
async function notifyAdmin(text){
  if(!sock) return;
  try{
    const sent = await sock.sendMessage(ADMIN_JID,{ text });
    if(sent?.key?.id) markBotSent(sent.key.id);
  }catch(e){ pushLog('warn','admin',`Alert failed: ${e.message}`); }
}

/* ══════════════════════════════════════════════════════════════
 *  SHARED STATE
 * ══════════════════════════════════════════════════════════════ */
let sock=null, entropyService=null, healthMonitor=null, qrDataUri=null;
let connectionStatus='disconnected', botStartTime=Date.now(), botNumber=null, botJid=null;
let reconnectAttempts=0; const MAX_RECONNECT=10;
let isConnecting=false, manualDisconnect=false;

let restart515InFlight=false, lastReconnectAt=0;
let consecutive515=0, recent515Timestamps=[], spamCooldownUntil=0;
const RESTART_515_BASE_DELAY_MS=1500, RESTART_515_MAX_DELAY_MS=30000;
const MIN_RECONNECT_INTERVAL_MS=10000, SPAM_WINDOW_MS=60000;
const SPAM_THRESHOLD=3, SPAM_COOLDOWN_MS=60000;

/* Main group */
let mainGroupJid=null;
function loadMainGroup(){
  try{
    if(fs.existsSync(MAIN_GROUP_FILE)){
      mainGroupJid = fs.readFileSync(MAIN_GROUP_FILE,'utf8').trim()||null;
      if(mainGroupJid) pushLog('info','main',`Main group: ${mainGroupJid}`);
    }
  }catch(e){}
}
function setMainGroup(jid){
  mainGroupJid=jid;
  try{ fs.writeFileSync(MAIN_GROUP_FILE,jid); }catch(e){}
  pushLog('success','main',`Main group set: ${jid}`);
}

/* ══════════════════════════════════════════════════════════════
 *  FOCUS PIPELINE  (unchanged)
 * ══════════════════════════════════════════════════════════════ */
class FocusPipeline {
  constructor(){ this.busy=false; this.currentJid=null; this.currentState='idle';
    this.startedAt=null; this.lastCompletedAt=null; }
  async run(jid, taskFn){
    let attempts=0;
    while(this.busy){
      if(++attempts>(FOCUS_LOCK_TIMEOUT_MS/500)) throw new Error('Focus lock timeout');
      await new Promise(r=>setTimeout(r,500));
    }
    this.busy=true; this.currentJid=jid; this.startedAt=Date.now();
    try{
      const steps=[
        { name:'notified', min:1, max:4 },
        { name:'unlocked', min:1, max:3 },
        { name:'opened',   min:1, max:2 },
        { name:'reading',  min:2, max:8 },
        { name:'thinking', min:3, max:15 }
      ];
      for(const step of steps){
        this.currentState=step.name;
        const delay=Math.min(fib.nextCapped(step.max),step.max*1000);
        await new Promise(r=>setTimeout(r,Math.max(step.min*1000,delay)));
      }
      this.currentState='typing';
      const result=await taskFn();
      this.currentState='reviewing';
      await new Promise(r=>setTimeout(r,1000+Math.random()*3000));
      this.currentState='sent';
      this.lastCompletedAt=Date.now();
      this.currentState='switching';
      await new Promise(r=>setTimeout(r,Math.min(fib.nextCapped(20),20000)));
      return result;
    } finally {
      this.busy=false; this.currentState='idle'; this.currentJid=null;
    }
  }
  stats(){ return { busy:this.busy, currentJid:this.currentJid, currentState:this.currentState,
    startedAt:this.startedAt, lastCompletedAt:this.lastCompletedAt }; }
}
const focus = new FocusPipeline();

/* ══════════════════════════════════════════════════════════════
 *  DM QUEUE
 * ══════════════════════════════════════════════════════════════ */
let dmQueue=[], dmQueueProcessing=false;
function enqueueDM(item){
  if(dmQueue.length>=DM_QUEUE_MAX){
    pushLog('warn','queue',`DM queue full (${DM_QUEUE_MAX}) — dropping ${item.pushName}`);
    resetDailyStats(); dailyStats.messagesDropped++;
    return false;
  }
  dmQueue.push(item);
  processDMQueue();
  return true;
}
async function processDMQueue(){
  if(dmQueueProcessing) return;
  if(focus.busy || jobs.running){ setTimeout(processDMQueue,2000); return; }
  const item = dmQueue.shift();
  if(!item) return;
  dmQueueProcessing = true;
  try{
    await focus.run(item.chatJid, async ()=>{ await processDM(item); });
  }catch(e){
    pushLog('error','dmqueue',e.message);
    if(e.message==='Focus lock timeout'||e.message==='Bot paused') dmQueue.unshift(item);
  }finally{
    dmQueueProcessing=false;
    if(dmQueue.length>0) setTimeout(processDMQueue,100);
  }
}

/* ══════════════════════════════════════════════════════════════
 *  GROUP BATCHER  (unchanged)
 * ══════════════════════════════════════════════════════════════ */
class GroupBatcher {
  constructor(){
    this.pending=new Map(); this.lastBatchAt=new Map();
    this.minBatchIntervalMs=30*60*1000;
    this.maxBatchIntervalMs=90*60*1000;
  }
  enqueue(jid,item){
    if(!this.pending.has(jid)) this.pending.set(jid,[]);
    this.pending.get(jid).push(item);
    if(this.pending.get(jid).length>200) this.pending.get(jid).shift();
  }
  drain(jid){
    const last=this.lastBatchAt.get(jid)||0;
    const since=Date.now()-last;
    const target=this.minBatchIntervalMs+Math.random()*(this.maxBatchIntervalMs-this.minBatchIntervalMs);
    if(since<target) return null;
    const items=this.pending.get(jid)||[];
    this.pending.set(jid,[]); this.lastBatchAt.set(jid,Date.now());
    return items;
  }
  stats(){ let total=0; for(const a of this.pending.values()) total+=a.length;
    return { groupsWithPending:this.pending.size, totalPending:total }; }
}
const groupBatcher = new GroupBatcher();

/* ══════════════════════════════════════════════════════════════
 *  FLOOD
 * ══════════════════════════════════════════════════════════════ */
let msgCountInWindow=0, windowStart=Date.now(), floodIgnoreUntil=0;
function checkFlood(){
  const now=Date.now();
  if(now-windowStart>1000){ windowStart=now; msgCountInWindow=0; }
  msgCountInWindow++;
  if(msgCountInWindow>MESSAGE_FLOOD_THRESHOLD){
    if(floodIgnoreUntil<now) pushLog('warn','flood',`Flood: ${msgCountInWindow} msgs/sec`);
    floodIgnoreUntil=now+FLOOD_IGNORE_MS;
    return true;
  }
  return false;
}

/* ══════════════════════════════════════════════════════════════
 *  INFORMALIZE
 * ══════════════════════════════════════════════════════════════ */
function informalize(text){
  if(!text) return text;
  let t=text;
  if(Math.random()<0.4) t=t.charAt(0).toLowerCase()+t.slice(1);
  if(Math.random()<0.15){ const p=t.split(' '); if(p[0]) p[0]=p[0].toLowerCase(); t=p.join(' '); }
  if(Math.random()<0.03){
    const w=t.split(' '); const idx=Math.floor(Math.random()*w.length); const x=w[idx];
    if(x&&x.length>3){ const pos=1+Math.floor(Math.random()*(x.length-2));
      w[idx]=x.slice(0,pos)+x[pos+1]+x[pos]+x.slice(pos+2); t=w.join(' '); }
  }
  if(Math.random()<0.05){ const f=['😅','😂','🙃','😊','👀']; t+=' '+f[Math.floor(Math.random()*f.length)]; }
  return t;
}

/* ══════════════════════════════════════════════════════════════
 *  ADMIN LIDs  (preserved from original)
 * ══════════════════════════════════════════════════════════════ */
let adminLids = new Set(HARDCODED_ADMIN_LIDS);
function loadAdminLids(){
  try{ if(fs.existsSync(ADMIN_LID_FILE)){
    const a=JSON.parse(fs.readFileSync(ADMIN_LID_FILE,'utf8'))||[];
    for(const l of a) adminLids.add(l);
  } }catch(e){}
}
function saveAdminLids(){
  try{ fs.writeFileSync(ADMIN_LID_FILE,JSON.stringify([...adminLids],null,2)); }catch(e){}
}

/* ══════════════════════════════════════════════════════════════
 *  GROUP SETTINGS
 * ══════════════════════════════════════════════════════════════ */
let groupSettings = new Map();
function loadGroupSettings(){
  try{ if(fs.existsSync(GROUP_SETTINGS_FILE))
    groupSettings = new Map(Object.entries(JSON.parse(fs.readFileSync(GROUP_SETTINGS_FILE,'utf8'))));
  }catch(e){}
}
let groupSettingsDirty=false;
function saveGroupSettingsDebounced(){
  if(groupSettingsDirty) return;
  groupSettingsDirty=true;
  setTimeout(()=>{
    try{ fs.writeFileSync(GROUP_SETTINGS_FILE,
      JSON.stringify(Object.fromEntries(groupSettings),null,2)); }catch(e){}
    groupSettingsDirty=false;
  },5000);
}
function getGroupSetting(jid){
  if(!groupSettings.has(jid)){
    groupSettings.set(jid,{ antilink:true, welcome:true, goodbye:true,
      welcomeMsg:'Welcome {user}! 👋', goodbyeMsg:'{user} left. 👋' });
    saveGroupSettingsDebounced();
  }
  return groupSettings.get(jid);
}

/* ══════════════════════════════════════════════════════════════
 *  LEARNING DATA
 * ══════════════════════════════════════════════════════════════ */
let learningData = new Map();
function loadLearningData(){
  try{ if(fs.existsSync(LEARNING_DATA_FILE))
    learningData = new Map(Object.entries(JSON.parse(fs.readFileSync(LEARNING_DATA_FILE,'utf8'))));
  }catch(e){}
}
let learningDirty=false;
function saveLearningDebounced(){
  if(learningDirty) return;
  learningDirty=true;
  setTimeout(()=>{
    try{ fs.writeFileSync(LEARNING_DATA_FILE,
      JSON.stringify(Object.fromEntries(learningData),null,2)); }catch(e){}
    learningDirty=false;
  },10000);
}
function recordGroupMessage(jid, text, sender){
  if(!text) return;
  if(!learningData.has(jid)) learningData.set(jid,{ messages:[], wordCounts:{}, emojiCounts:{},
    analyzed:false, firstSeen:Date.now() });
  const d=learningData.get(jid);
  d.messages.push({ text, sender, ts:Date.now() });
  if(d.messages.length>500) d.messages.shift();
  for(const w of text.toLowerCase().split(/\s+/)){
    const c=w.replace(/[^a-z0-9]/g,''); if(c.length>2) d.wordCounts[c]=(d.wordCounts[c]||0)+1;
  }
  const emojis=text.match(/[\u{1F600}-\u{1F64F}]/gu)||[];
  for(const e of emojis) d.emojiCounts[e]=(d.emojiCounts[e]||0)+1;
  saveLearningDebounced();
}
function analyzeLearning(jid){
  const d=learningData.get(jid);
  if(!d||d.messages.length<50) return null;
  const topWords=Object.entries(d.wordCounts).sort((a,b)=>b[1]-a[1]).slice(0,20);
  const topEmojis=Object.entries(d.emojiCounts).sort((a,b)=>b[1]-a[1]).slice(0,10);
  d.analyzed=true;
  d.analysis={ topWords, topEmojis, messageCount:d.messages.length, analyzedAt:Date.now() };
  saveLearningDebounced();
  return d.analysis;
}

/* ══════════════════════════════════════════════════════════════
 *  FILTERS
 * ══════════════════════════════════════════════════════════════ */
const FORBIDDEN_PATTERNS = [
  /\bcannot\b/i, /\bcan'?t\b/i, /\bunable to\b/i, /\bi refuse\b/i, /\bnot allowed\b/i,
  /\bagainst my guidelines\b/i, /\bas an ai\b/i, /\bi am an ai\b/i, /\blanguage model\b/i,
  /\bsorry,? i\b/i, /\bi apologize\b/i, /\bapi[_ ]?key\b/i, /\bconsole\.log\b/i,
  /\berror:/i, /\bstack trace\b/i, /\btraceback\b/i, /\bdebug\b/i, /\bnode\.js\b/i, /\bnpm\b/i,
  /how can i help you today\??/i, /how may i help you\??/i, /is there anything else/i,
  /anything else i can help/i, /let me know if/i, /feel free to/i, /\bi am here to help\b/i,
  /\bi'?m here to help\b/i, /\bi am happy to help\b/i, /\bi'?m happy to help\b/i,
  /happy to assist/i, /how can i help/i, /what can i do for you/i, /do you need any/i,
  /please let me know/i, /i hope this helps/i, /hope this helps/i, /thank you for reaching out/i,
  /thanks for reaching out/i, /don'?t hesitate to/i, /do not hesitate/i, /\bas an assistant\b/i,
  /\bgreetings!\b/i, /how are you today\?/i, /i understand that/i, /based on your (query|request)/i,
  /to answer your question/i, /in response to/i, /\bapi_key\b/i, /\btoken\b/i,
  /\bas an? (ai|assistant|bot|language model)\b/i, /\bi'?m an? (ai|assistant|bot|language model)\b/i,
  /\bi cannot (provide|help|assist|do|generate)\b/i, /\bit'?s important to (note|remember|understand)\b/i,
  /\bhowever,? (i|it) (must|should|need)\b/i, /\bi should (mention|note|point out)\b/i,
  /```/
];
function containsForbidden(text){ if(!text) return true; return FORBIDDEN_PATTERNS.some(re=>re.test(text)); }
function humanize(text){
  if(!text) return '';
  let t=text;
  t=t.replace(/```[\s\S]*?```/g,'').replace(/https?:\/\/\S+/g,'');
  t=t.split('\n').filter(line=>{
    const l=line.trim().toLowerCase();
    if(!l) return true;
    if(/^\[?(info|warn|error|debug|trace)\]?[: ]/.test(l)) return false;
    if(/^\d{4}-\d{2}-\d{2}/.test(l)) return false;
    if(/^at\s+\w+/.test(l)) return false;
    return true;
  }).join('\n');
  const filler=[
    /how can i help you today\??/gi, /how may i help you\??/gi, /is there anything else.*?\?/gi,
    /let me know if.*?\./gi, /feel free to.*?\./gi, /i'?m? here to help\.?/gi,
    /i'?m? happy to help\.?/gi, /hope this helps!?/gi, /thank you for reaching out\.?/gi,
    /thanks for reaching out\.?/gi
  ];
  for(const p of filler) t=t.replace(p,'');
  return t.replace(/\n{3,}/g,'\n\n').replace(/\s{2,}/g,' ').trim();
}

const SHONA_MARKERS = ['ndi','uri','kuti','here','izvi','zvakanaka','sei','ndoda','unoda',
  'mhoro','mangwanani','masikati','manheru','ndapota','zvinhu','vanhu','kuita','kuenda','kuuya'];
const LANG_NAMES = { sn:'Shona', en:'English' };
function detectLanguage(text){
  if(!text) return 'en';
  return text.toLowerCase().split(/\s+/).filter(w=>SHONA_MARKERS.includes(w)).length>0 ? 'sn' : 'en';
}

/* ══════════════════════════════════════════════════════════════
 *  PERSISTENCE
 * ══════════════════════════════════════════════════════════════ */
const processedMessages = new Set();
const activeChats  = new Set();
const activeDMs    = new Set();
const replyCache   = new NodeCache({ stdTTL:300, checkperiod:60 });
const userHistories= new Map();
const pendingRequests = new Map();
const recentAdminCommands = new Map();

let joinQueue=[], joinInProgress=false, lastJoinAt=0;
const joinedGroups = new Map();
const lastGreetingAt = new Map();

const scraperStats = { searchCalls:0, searchSuccess:0, searchFail:0, gifCalls:0, gifSuccess:0,
  gifFail:0, lastSearchQuery:null, lastSearchAt:null, lastGifQuery:null, lastGifAt:null };
let previewCache = { imageUrls:[], imageIndex:0, gifUrls:[], gifIndex:0, currentType:null, currentUrl:null };
const downloadPicks = new Map();  // chatJid -> { query, results, ts }

let dailyStats=null, lastDailyReportDate=null;
function resetDailyStats(){
  const today=new Date().toISOString().slice(0,10);
  if(lastDailyReportDate!==today){
    dailyStats={ date:today, joined:0, failed:0, dmsReplied:0, broadcastsSent:0, greetingsSent:0,
      scraperSearches:0, scraperGifs:0, picsSent:0, videosSent:0, nsfwSent:0, aiErrors:0,
      pendingCreated:0, pendingResolved:0, discovered:0, imageBroadcasts:0, badMacs:0,
      focusRuns:0, downloads:0, nsfwDownloads:0, adminBroadcasts:0, groupLinksShared:0,
      messagesDropped:0, errors:0, invitesSent:0 };
  }
}
resetDailyStats();

function saveQueue(){ try{ fs.writeFileSync(JOIN_QUEUE_FILE,JSON.stringify(joinQueue,null,2)); }catch(e){} }
function saveGroups(){
  try{
    const a=[...joinedGroups.entries()].map(([jid,v])=>({ jid, name:v.name, joinedAt:v.joinedAt,
      discovered:v.discovered||false, lastGreetedAt:lastGreetingAt.get(jid)||null }));
    fs.writeFileSync(JOINED_GROUPS_FILE,JSON.stringify(a,null,2));
  }catch(e){}
}
function savePending(){ try{
  fs.writeFileSync(PENDING_FILE,JSON.stringify([...pendingRequests.values()],null,2));
}catch(e){} }

function getAdminGroupJid(){
  try{ if(fs.existsSync(ADMIN_GROUP_JID_FILE))
    return fs.readFileSync(ADMIN_GROUP_JID_FILE,'utf8').trim(); }catch(e){}
  return null;
}
function setAdminGroupJid(jid){
  try{ fs.writeFileSync(ADMIN_GROUP_JID_FILE,jid);
    pushLog('success','admin',`Admin group JID: ${jid}`); }catch(e){}
}

function loadState(){
  try{ if(fs.existsSync(JOIN_QUEUE_FILE)) joinQueue=JSON.parse(fs.readFileSync(JOIN_QUEUE_FILE,'utf8'))||[]; }
  catch(e){ joinQueue=[]; }
  try{
    if(fs.existsSync(JOINED_GROUPS_FILE)){
      const a=JSON.parse(fs.readFileSync(JOINED_GROUPS_FILE,'utf8'))||[];
      for(const g of a){
        joinedGroups.set(g.jid,{ name:g.name, joinedAt:g.joinedAt, discovered:g.discovered||false });
        if(g.lastGreetedAt) lastGreetingAt.set(g.jid,g.lastGreetedAt);
      }
    }
  }catch(e){}
  try{
    if(fs.existsSync(PENDING_FILE)){
      const a=JSON.parse(fs.readFileSync(PENDING_FILE,'utf8'))||[];
      const now=Date.now();
      for(const p of a) if(now-p.requestedAt<PENDING_EXPIRY_MS) pendingRequests.set(p.id,p);
    }
  }catch(e){}
  pushLog('info','state',`queue=${joinQueue.length} groups=${joinedGroups.size} pending=${pendingRequests.size} adminLids=${adminLids.size} main=${mainGroupJid||'—'}`);
}

/* ══════════════════════════════════════════════════════════════
 *  WELCOME / GOODBYE  — main group ONLY, AI generated
 * ══════════════════════════════════════════════════════════════ */
async function generateWelcomeMessage(userName){
  const prompt=`Write a warm, short WhatsApp welcome message for a new member named "${userName}". Max 12 words. Include an emoji. Do NOT mention AI. Mix Shona + English naturally.`;
  const sys=`You are Abby Faith Sithole, warm and friendly Zimbabwean. Reply casually, like a real person welcoming a friend.`;
  const ai=await askRewind(prompt, sys);
  if(ai&&!containsForbidden(ai)) return informalize(ai);
  return `Welcome ${userName}! 🎉 Tiri kufara kuva newe pano.`;
}
async function generateGoodbyeMessage(userName){
  const prompt=`Write a short goodbye for a member named "${userName}" leaving a WhatsApp group. Max 10 words.`;
  const sys=`You are Abby Faith Sithole, warm Zimbabwean. Casual tone.`;
  const ai=await askRewind(prompt, sys);
  if(ai&&!containsForbidden(ai)) return informalize(ai);
  return `${userName} has left. 👋`;
}

async function handleGroupParticipantsUpdate(update){
  const { id, participants, action } = update;
  if(!mainGroupJid || id!==mainGroupJid) return;
  const s = getGroupSetting(id);
  for(const p of participants){
    const user = p.split('@')[0];
    if(action==='add' && s.welcome){
      try{
        const msg=await generateWelcomeMessage(user);
        await queuedSend(id,{ text:msg, mentions:[p] },{},0);
        pushLog('success','welcome',`Welcomed ${user} to main group`);
      }catch(e){ pushLog('warn','welcome',e.message); }
    }
    if(action==='remove' && s.goodbye){
      try{
        const msg=await generateGoodbyeMessage(user);
        await queuedSend(id,{ text:msg },{},0);
        pushLog('info','goodbye',`Said bye to ${user}`);
      }catch(e){ pushLog('warn','goodbye',e.message); }
    }
  }
}

async function handleAntiLink(jid, msg, text, senderJid, isAdmin){
  const s=getGroupSetting(jid);
  if(!s.antilink || isAdmin) return false;
  const matches=text.match(/(https?:\/\/[^\s]+)/gi);
  if(!matches || matches.length===0) return false;
  try{ await sock.sendMessage(jid,{ delete: msg.key }); }catch(e){}
  pushLog('info','antilink',`Deleted from ${senderJid} in ${jid}`);
  try{ await queuedSend(jid,{ text:`⚠️ Links not allowed here, @${senderJid.split('@')[0]}` },{ mentions:[senderJid] },2); }catch(e){}
  return true;
}

/* ══════════════════════════════════════════════════════════════
 *  PHONE / LID EXTRACTION  (preserved)
 * ══════════════════════════════════════════════════════════════ */
function extractAllPhoneCandidates(msg, senderJid){
  const phones=new Set();
  const c=[msg.key?.participantPn, msg.key?.senderPn, msg.key?.remoteJidAlt,
    msg.key?.participantAlt, senderJid, msg.key?.remoteJid, msg.key?.participant].filter(Boolean);
  for(const x of c){
    if(typeof x==='string'){
      const d=x.split('@')[0].split(':')[0].replace(/\D/g,'');
      if(d.length>=10) phones.add(d);
    }
  }
  return [...phones];
}
function extractLidFromMsg(msg, senderJid){
  const c=[senderJid, msg.key?.remoteJid, msg.key?.participant].filter(Boolean);
  for(const x of c) if(typeof x==='string' && x.includes('@lid')) return x.split('@')[0];
  return null;
}
function isAdminSender(msg, senderJid){
  const c = extractAllPhoneCandidates(msg, senderJid);
  if(c.includes(ADMIN_PHONE)){
    const l=extractLidFromMsg(msg,senderJid);
    if(l && !adminLids.has(l)){ adminLids.add(l); saveAdminLids(); }
    return true;
  }
  for(const x of c) if(adminLids.has(x)) return true;
  const l = extractLidFromMsg(msg, senderJid);
  if(l && adminLids.has(l)) return true;
  if(typeof senderJid==='string'){
    const b=senderJid.split('@')[0].split(':')[0];
    if(adminLids.has(b) || b===ADMIN_PHONE) return true;
  }
  return false;
}
function extractPhone(msg, senderJid){
  const c=extractAllPhoneCandidates(msg,senderJid); return c.length>0 ? c[0] : null;
}
function extractLid(msg, senderJid){ return extractLidFromMsg(msg,senderJid); }

function extractAllInviteCodes(text){
  if(!text) return [];
  const s=new Set();
  const re=/chat\.whatsapp\.com\/([A-Za-z0-9]{15,30})/gi;
  let m; while((m=re.exec(text))!==null) s.add(m[1]);
  return [...s];
}

function queueJoin(code, addedBy='unknown', source='dm'){
  if(!code || joinQueue.some(q=>q.code===code)) return false;
  joinQueue.push({ code, addedAt:Date.now(), addedBy, source });
  saveQueue(); pushLog('info','join',`Queued ${code}`); return true;
}

async function processJoinQueue(){
  if(joinInProgress || !sock || connectionStatus!=='connected' || joinQueue.length===0) return;
  if(timeGate.isOffline()) return;
  if(Date.now()-lastJoinAt<JOIN_INTERVAL_MS) return;
  joinInProgress=true;
  const item=joinQueue.shift(); saveQueue(); resetDailyStats();
  try{
    pushLog('info','join',`Joining ${item.code}...`);
    const res=await sock.groupAcceptInvite(item.code);
    lastJoinAt=Date.now();
    if(res){
      joinedGroups.set(res,{ name:null, joinedAt:Date.now(), discovered:false });
      lastGreetingAt.set(res,Date.now()); saveGroups();
      dailyStats.joined++; pushLog('success','join',`✅ Joined ${res}`);
    }
  }catch(e){
    dailyStats.failed++; pushLog('error','join',`Failed: ${e.message}`);
    await notifyAdmin(`Join failed: ${item.code}\n${e.message}`);
  }finally{
    joinInProgress=false;
    setTimeout(processJoinQueue, JOIN_INTERVAL_MS);
  }
}

function createPendingRequest(userJid, userName, userPhone, history, intent){
  const id=Math.random().toString(36).slice(2,8);
  pendingRequests.set(id,{ id, userJid, userName, userPhone,
    userHistory:history.slice(-USER_HISTORY_SIZE), requestedAt:Date.now(), intent });
  savePending(); resetDailyStats(); dailyStats.pendingCreated++;
  return id;
}
async function forwardToAdminForHelp(id, pending){
  const hb=pending.userHistory.map((h,i)=>`${i+1}. ${h.text}`).join('\n');
  await notifyAdmin(`❓ *Unclear request*\n👤 ${pending.userName} (${pending.userPhone||'no phone'})\n💬 Intent: ${pending.intent.type} — "${pending.intent.query}"\n\n*Last messages:*\n${hb}\n\nReply:\n\`!teach ${id} <query>\` / \`!teach ${id} skip\` / \`!teach ${id} say <text>\``);
}
async function resolvePending(id, action, payload, adminChatJid){
  const p=pendingRequests.get(id);
  if(!p) return { ok:false, error:`No pending request ${id}` };
  const reply=(t)=>queuedSend(adminChatJid,{ text:t },{},0);
  try{
    if(action==='skip'){
      const casual=await askRewind(`User said: "${p.userHistory.map(h=>h.text).join(' / ')}". Reply casually.`,
        `You are Abby Faith Sithole, 23, Harare Zimbabwe. Warm, casual.`);
      await queuedSend(p.userJid,{ text:casual||'Sorry, couldn\'t find that 😅' },{},2);
      pendingRequests.delete(id); savePending(); resetDailyStats(); dailyStats.pendingResolved++;
      await reply(`✅ Replied casually to ${p.userName}.`);
      return { ok:true };
    }
    if(action==='say'){
      await queuedSend(p.userJid,{ text:payload },{},2);
      pendingRequests.delete(id); savePending(); resetDailyStats(); dailyStats.pendingResolved++;
      await reply(`✅ Sent to ${p.userName}.`);
      return { ok:true };
    }
    const query=payload||p.intent.query;
    await reply(`🔎 Searching "${query}"...`);
    if(p.intent.type==='video'||p.intent.type==='gif'){
      const r=await scraperGif(query);
      if(!r.ok||r.gifs.length===0){ await reply(`❌ No results.`); return { ok:false }; }
      await queuedSend(p.userJid,{ video:{ url:r.gifs[0] }, gifPlayback:true },{},2);
      resetDailyStats(); dailyStats.picsSent++;
    } else {
      const r=await scraperSearch(query);
      if(!r.ok||r.images.length===0){ await reply(`❌ No results.`); return { ok:false }; }
      await queuedSend(p.userJid,{ image:{ url:r.images[0] } },{},2);
      resetDailyStats(); dailyStats.picsSent++;
    }
    pendingRequests.delete(id); savePending(); resetDailyStats(); dailyStats.pendingResolved++;
    await reply(`✅ Sent to ${p.userName}.`);
    return { ok:true };
  }catch(e){ await reply(`❌ ${e.message}`); return { ok:false, error:e.message }; }
}

function discoverGroup(jid, groupName){
  if(!jid || !jid.endsWith('@g.us')) return false;
  if(joinedGroups.has(jid)) return false;
  joinedGroups.set(jid,{ name:groupName||null, joinedAt:Date.now(), discovered:true });
  lastGreetingAt.set(jid,Date.now());
  saveGroups(); resetDailyStats(); dailyStats.discovered++;
  pushLog('success','group',`Discovered ${jid}`);
  return true;
}

/* ══════════════════════════════════════════════════════════════
 *  AI  (Rewind or OpenAI)
 * ══════════════════════════════════════════════════════════════ */
async function askRewind(prompt, systemPrompt){
  if(!AI_KEY) return null;
  try{
    const r=await axios.post(AI_ENDPOINT,{
      model:AI_MODEL,
      messages:[
        { role:'system', content:systemPrompt },
        { role:'user',   content:prompt }
      ],
      max_tokens:250, temperature:0.9
    },{
      headers:{ 'Authorization':`Bearer ${AI_KEY}`, 'Content-Type':'application/json' },
      timeout:25000
    });
    const raw=r.data?.choices?.[0]?.message?.content;
    if(!raw) return null;
    const c=humanize(raw);
    return c||null;
  }catch(e){
    pushLog('error','ai',`${e.response?.status||''} ${e.message}`);
    resetDailyStats(); dailyStats.aiErrors++;
    await notifyAdmin(`AI error: ${e.response?.status||''} ${e.message}`).catch(()=>{});
    return null;
  }
}
async function testRewindRaw(){
  if(!AI_KEY) return { ok:false, error:'AI_KEY missing' };
  const t0=Date.now();
  try{
    const r=await axios.post(AI_ENDPOINT,{
      model:AI_MODEL,
      messages:[
        { role:'system', content:'You are a helpful assistant.' },
        { role:'user',   content:'Reply with exactly: AI WORKS' }
      ],
      max_tokens:20
    },{
      headers:{ 'Authorization':`Bearer ${AI_KEY}`, 'Content-Type':'application/json' },
      timeout:20000
    });
    return { ok:true, ms:Date.now()-t0, status:r.status, raw:r.data?.choices?.[0]?.message?.content };
  }catch(e){ return { ok:false, ms:Date.now()-t0, status:e.response?.status, error:e.message }; }
}

/* ══════════════════════════════════════════════════════════════
 *  SCRAPER  (SFW + NSFW)
 * ══════════════════════════════════════════════════════════════ */
async function scraperSearch(query, nsfw=false){
  const site = nsfw ? SCRAPER_NSFW_SITE : SCRAPER_SFW_SITE;
  scraperStats.searchCalls++; resetDailyStats(); dailyStats.scraperSearches++;
  try{
    const r=await axios.post(`${SCRAPER_URL}/search`,{ query, site },{ timeout:30000 });
    scraperStats.searchSuccess++;
    return { ok:true, images:r.data?.images||[], site };
  }catch(e){
    scraperStats.searchFail++;
    return { ok:false, error:e.message, images:[], site };
  }
}
async function scraperGif(query, nsfw=false){
  const site = nsfw ? SCRAPER_NSFW_SITE : SCRAPER_SFW_SITE;
  scraperStats.gifCalls++; resetDailyStats(); dailyStats.scraperGifs++;
  try{
    const r=await axios.get(`${SCRAPER_URL}/gif`,
      { params:{ q:query, site }, timeout:30000 });
    scraperStats.gifSuccess++;
    return { ok:true, gifs:r.data?.gifs||[], site };
  }catch(e){
    scraperStats.gifFail++;
    return { ok:false, error:e.message, gifs:[], site };
  }
}
async function scraperStatus(){
  try{ const r=await axios.get(`${SCRAPER_URL}/status`,{ timeout:10000 });
    return { ok:true, data:r.data }; }
  catch(e){ return { ok:false, error:e.message }; }
}

/* ══════════════════════════════════════════════════════════════
 *  INTENT DETECTION
 * ══════════════════════════════════════════════════════════════ */
const VAGUE_QUERIES=['', 'something', 'anything', 'nice', 'good', 'stuff', 'it', 'them',
  'some', 'please', 'pls', 'now', 'me', 'one'];
function detectMediaIntent(text){
  const low=(text||'').toLowerCase().trim();
  if(!low) return null;
  if(/\b(gif|gifs)\b/i.test(low)){
    let q=low.replace(/^.*?\b(gif|gifs)\b\s*(of|ya|ye|za)?\s*/i,'').trim().replace(/\s+/g,' ');
    return { type:'gif', query:q||'funny' };
  }
  if(/\b(video|videos|vid|vids|vidyo|mavhidhiyo)\b/i.test(low)){
    let q=low.replace(/^.*?\b(video|videos|vid|vids|vidyo|mavhidhiyo)\b\s*(of|ya|ye|za)?\s*/i,'').trim().replace(/\s+/g,' ');
    return { type:'video', query:q||'funny' };
  }
  if(/\b(pic|pics|picture|pictures|image|images|photo|photos|mapic|mapics|mufananidzo|mifananidzo)\b/i.test(low)){
    let q=low.replace(/^(please\s+|pls\s+|hey\s+|hi\s+|yo\s+)?(can\s+you\s+)?(send|share|give|show|drop|post|ndipe|ndipoo|nditumire|ndiratidze|ndoda)\s+(me\s+)?(a\s+|some\s+|any\s+)?/i,'');
    q=q.replace(/\b(pic|pics|picture|pictures|image|images|photo|photos|mapic|mapics|mufananidzo|mifananidzo)\b/gi,'');
    q=q.replace(/\b(of|ya|ye|za|for|about|ndiye|wa)\b/gi,'');
    q=q.replace(/[?.!,]+/g,' ').replace(/\s+/g,' ').trim();
    return { type:'image', query:q||'naija' };
  }
  return null;
}
function detectDownloadIntent(text){
  if(!text) return null;
  const low=text.toLowerCase();
  if(/\b(download|dl|save|grab|fetch)\b/.test(low) && /\b(youtube|video|vid|song|music)\b/.test(low)){
    const q=low.replace(/^(please\s+|pls\s+|hey\s+|hi\s+)?(can\s+you\s+)?(download|dl|save|grab|fetch)\s+(me\s+)?(a\s+|the\s+)?/i,'')
      .replace(/\b(youtube|video|vid|song|music)\b/gi,'')
      .replace(/\b(of|from|for|by)\b/gi,'')
      .replace(/[?.!,]+/g,' ').replace(/\s+/g,' ').trim();
    return { query:q };
  }
  return null;
}
function detectNsfw(text){
  if(!text) return false;
  const low=text.toLowerCase();
  return /\b(nsfw|porn|porno|sex|sexy|nude|nudes|xxx|adult|18\+|booty|ass|titties|boobs)\b/.test(low);
}
function detectGroupLinkRequest(text){
  const low=(text||'').toLowerCase();
  if(/group\s*link|grouplink|link ye\s*group|join\s*link|link rekujoina|link re group/i.test(low)) return true;
  return false;
}
function isVagueQuery(q){ return !q || VAGUE_QUERIES.includes(q.toLowerCase().trim()); }

/* ══════════════════════════════════════════════════════════════
 *  DIRECTED-AT-BOT  detection for groups
 * ══════════════════════════════════════════════════════════════ */
const BOT_NAMES = ['bread','breadbot','abby','abby faith','sithole'];
function isReplyToBot(msg){
  const c = msg.message?.extendedTextMessage?.contextInfo
         || msg.message?.imageMessage?.contextInfo
         || msg.message?.videoMessage?.contextInfo;
  if(!c?.stanzaId) return false;
  return botSentIds.has(c.stanzaId);
}
function isMentioningBot(msg){
  const c = msg.message?.extendedTextMessage?.contextInfo
         || msg.message?.imageMessage?.contextInfo
         || msg.message?.videoMessage?.contextInfo;
  const mentions = c?.mentionedJid || [];
  if(!mentions.length || !botJid) return false;
  const botNum = botJid.split('@')[0].split(':')[0];
  return mentions.some(j => j.split('@')[0].split(':')[0] === botNum);
}
function containsBotName(text){
  if(!text) return false;
  const low = text.toLowerCase();
  return BOT_NAMES.some(n => new RegExp(`\\b${n}\\b`,'i').test(low));
}
function isDirectedAtBot(msg, text){
  return isReplyToBot(msg) || isMentioningBot(msg) || containsBotName(text);
}

/* ══════════════════════════════════════════════════════════════
 *  QUEUED SEND
 * ══════════════════════════════════════════════════════════════ */
function queuedSend(jid, content, options={}, priority=2){
  return new Promise((resolve, reject)=>{
    jobs.push({
      name:`send:${jid}`,
      priority,
      fn: async ()=>{
        if(!sock){ reject(new Error('Bot disconnected')); return; }
        if(botPaused && priority>0){ reject(new Error('Bot paused')); return; }
        const sent = await sock.sendMessage(jid, content, options);
        if(sent?.key?.id) markBotSent(sent.key.id);
        resolve(sent);
        return sent;
      }
    });
  });
}

/* ══════════════════════════════════════════════════════════════
 *  GREETINGS
 * ══════════════════════════════════════════════════════════════ */
const GREETING_PHRASES = {
  morning:['Morning all ☀️','Mangwanani guys ☀️','Good morning fam','Morning 🌅','Rise and shine ☀️'],
  midday:['Hi guys 👋','Hey everyone','Hello fam 😊','Hi all'],
  evening:['Good evening fam 🌆','Evening all 👋','Manheru guys','Evening everyone'],
  night:['Good night all 🌙','Manheru akanaka 🌙','Sleep well fam','Good night everyone 💤']
};
function getTimeOfDay(){
  const h=timeGate.localHour();
  if(h>=5&&h<12) return 'morning';
  if(h>=12&&h<17) return 'midday';
  if(h>=17&&h<21) return 'evening';
  return 'night';
}
function pickGreeting(p){
  const pool=GREETING_PHRASES[p]||GREETING_PHRASES.midday;
  return pool[Math.floor(Math.random()*pool.length)];
}

/* ══════════════════════════════════════════════════════════════
 *  SCHEDULERS
 * ══════════════════════════════════════════════════════════════ */
function scheduleGreetings(){
  setInterval(async ()=>{
    if(!sock||connectionStatus!=='connected'||joinedGroups.size===0||botPaused||jobs.running) return;
    if(timeGate.isOffline()||!timeGate.isGroupActive()) return;
    const now=Date.now(); const minMs=GREETING_MIN_HOURS*3600000, maxMs=GREETING_MAX_HOURS*3600000;
    for(const [jid] of joinedGroups){
      const sinceLast=now-(lastGreetingAt.get(jid)||0);
      if(sinceLast<minMs) continue;
      const progress=(sinceLast-minMs)/(maxMs-minMs);
      if(Math.random()>Math.min(progress,1)) continue;
      const replyText=pickGreeting(getTimeOfDay());
      try{
        await queuedSend(jid,{ text:replyText },{},1);
        lastGreetingAt.set(jid,now); resetDailyStats(); dailyStats.greetingsSent++;
        pushLog('info','greeting',`Greeting: ${jid}`);
      }catch(e){ pushLog('warn','greeting',`Failed: ${e.message}`); }
    }
    saveGroups();
  },900000);
}
function scheduleDailyReport(){
  setInterval(async ()=>{
    if(!sock||connectionStatus!=='connected') return;
    const now=new Date(); const today=now.toISOString().slice(0,10);
    if(now.getHours()!==DAILY_REPORT_HOUR||lastDailyReportDate===today) return;
    lastDailyReportDate=today; resetDailyStats(); const s=dailyStats||{};
    await notifyAdmin([
      `📊 *Daily Summary — ${today}*`, ``,
      `👥 Groups: *${joinedGroups.size}*`,
      `💬 DMs: *${activeDMs.size}*`,
      `📋 Queue: *${joinQueue.length}*`,
      `⏳ Pending: *${pendingRequests.size}*`, ``,
      `✅ Joined: *${s.joined}*`,
      `🔍 Discovered: *${s.discovered}*`,
      `❌ Failed: *${s.failed}*`,
      `💌 DM replies: *${s.dmsReplied}*`,
      `🎯 Focus: *${s.focusRuns}*`,
      `🖼️ Media: *${s.picsSent+s.videosSent}*`,
      `🔞 NSFW: *${s.nsfwSent}*`,
      `📥 Downloads: *${s.downloads}*`,
      `📢 Broadcasts: *${s.broadcastsSent}*`,
      `📨 Invites: *${s.invitesSent}*`,
      `👋 Greetings: *${s.greetingsSent}*`,
      `🤖 AI errors: *${s.aiErrors}*`,
      `💥 Bad MACs: *${s.badMacs}*`,
      `🗑️ Dropped: *${s.messagesDropped}*`,
      `🕒 Uptime: ${Math.floor((Date.now()-botStartTime)/3600000)}h`
    ].join('\n'));
  },60000);
}
function scheduleGroupBatchProcessor(){
  setInterval(async ()=>{
    if(!sock||connectionStatus!=='connected'||botPaused||jobs.running) return;
    if(!timeGate.isGroupActive()) return;
    for(const [jid] of groupBatcher.pending){
      const drained=groupBatcher.drain(jid);
      if(!drained||drained.length===0) continue;
      pushLog('info','group',`Batch ${drained.length} from ${jid}`);
    }
  },600000);
}

/* ══════════════════════════════════════════════════════════════
 *  BROADCAST  (main group first)
 * ══════════════════════════════════════════════════════════════ */
function sortTargetsByPriority(targets){
  return targets.sort((a,b)=>{
    const aPri = a.jid===mainGroupJid ? 0 : (a.jid===ADMIN_JID ? 1 : 2);
    const bPri = b.jid===mainGroupJid ? 0 : (b.jid===ADMIN_JID ? 1 : 2);
    return aPri - bPri;
  });
}
async function broadcast({ message, imageUrl=null, gifUrl=null, imageBuffer=null, mode='all' }){
  const targets=[];
  if(mode==='all'||mode==='groups') for(const jid of joinedGroups.keys()) targets.push({ jid, type:'group' });
  if(mode==='all'||mode==='dms')    for(const jid of activeDMs)          targets.push({ jid, type:'dm' });
  sortTargetsByPriority(targets);
  const results={ sent:0, failed:0, total:targets.length, errors:[], mode };
  pushLog('info','broadcast',`Broadcasting to ${targets.length} (${mode})`);
  for(const t of targets){
    try{
      let content;
      if(gifUrl) content={ video:{ url:gifUrl }, gifPlayback:true, caption:message||'' };
      else if(imageBuffer) content={ image:imageBuffer, caption:message||'' };
      else if(imageUrl) content={ image:{ url:imageUrl }, caption:message||'' };
      else content={ text:message };
      await queuedSend(t.jid, content, {}, 0);
      results.sent++; resetDailyStats(); dailyStats.broadcastsSent++;
    }catch(e){ results.failed++; results.errors.push({ jid:t.jid, error:e.message }); }
  }
  pushLog('success','broadcast',`Done: ${results.sent}/${results.total}`);
  return results;
}

/* ══════════════════════════════════════════════════════════════
 *  AD BUILDER
 * ══════════════════════════════════════════════════════════════ */
class AdBuilder {
  static build(opts={}){
    const { title, body, cta, link, footer, style='fancy' } = opts;
    if(style==='bold') return [`*${title||'OFFER'}*`, '', body||'', cta?`\n*${cta}*`:'',
      link?`\n${link}`:'', footer?`\n_${footer}_`:''].filter(Boolean).join('\n');
    if(style==='minimal') return [title||'', body||'', cta||'', link||''].filter(Boolean).join('\n\n');
    const lines=['╔══════════════════════════╗',
      `║ ✨ ${(title||'OFFER').toUpperCase()} ✨`,
      '╚══════════════════════════╝', ''];
    if(body) lines.push(body);
    lines.push('');
    if(cta) lines.push(`*${cta}*`);
    if(link) lines.push(`${link}`);
    if(footer) lines.push(`\n_${footer}_`);
    return lines.join('\n');
  }
}

/* ══════════════════════════════════════════════════════════════
 *  Y2MATE  (search → list → pick / mass)
 * ══════════════════════════════════════════════════════════════ */
const YT_HEADERS = {
  'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
};
async function ytSearch(query, max=6){
  try{
    const url=`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=EgIQAQ%253D%253D`;
    const r=await axios.get(url,{ headers:YT_HEADERS, timeout:20000 });
    const html=r.data||'';
    const results=[];
    const re=/"videoRenderer":\{"videoId":"([^"]+)".*?"title":\{"runs":\[\{"text":"([^"]+)"/g;
    let m;
    while((m=re.exec(html))!==null && results.length<max){
      const vid=m[1];
      const title=m[2].replace(/\\u([\da-f]{4})/gi,(_,c)=>String.fromCharCode(parseInt(c,16)));
      if(!results.find(x=>x.id===vid)) results.push({ id:vid, title });
    }
    if(results.length===0){
      const re2=/"videoId":"([^"]+)","thumbnail".*?"title":\{"runs":\[\{"text":"([^"]+)"/g;
      let m2;
      while((m2=re2.exec(html))!==null && results.length<max){
        const vid=m2[1];
        const title=m2[2].replace(/\\u([\da-f]{4})/gi,(_,c)=>String.fromCharCode(parseInt(c,16)));
        if(!results.find(x=>x.id===vid)) results.push({ id:vid, title });
      }
    }
    return results;
  }catch(e){ pushLog('error','yt','search: '+e.message); return []; }
}
const Y2MATE_HEADERS = {
  'User-Agent':YT_HEADERS['User-Agent'],
  'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8',
  'X-Requested-With':'XMLHttpRequest',
  'Origin':'https://www.y2mate.com',
  'Referer':'https://www.y2mate.com/'
};
async function y2mateResolve(videoId, prefer='360p'){
  const ytUrl=`https://www.youtube.com/watch?v=${videoId}`;
  const analyze=await axios.post(
    'https://www.y2mate.com/mates/en948/analyze/ajax',
    new URLSearchParams({ url:ytUrl, q_auto:'0', ajax:'1' }).toString(),
    { headers:Y2MATE_HEADERS, timeout:30000 }
  );
  const html=analyze.data?.result||'';
  const vId=(html.match(/v_id["']?\s*[:=]\s*["']([^"']+)/)||[])[1];
  const id =(html.match(/_id["']?\s*[:=]\s*["']([^"']+)/)||[])[1];
  if(!vId||!id) throw new Error('y2mate: video not found (private or blocked)');

  const qualities=['360p','480p','720p'];
  const start=Math.max(0, qualities.indexOf(prefer));
  let lastErr=null;
  for(const q of qualities.slice(start)){
    try{
      const conv=await axios.post(
        'https://www.y2mate.com/mates/convert',
        new URLSearchParams({ type:'video', _id:id, v_id:vId, ajax:'1', token:'', ftype:'mp4', fquality:q }).toString(),
        { headers:Y2MATE_HEADERS, timeout:30000 }
      );
      const ch=conv.data?.result||'';
      const dl=(ch.match(/href="(https?:\/\/[^"]+\.mp4[^"]*)"/)||[])[1]
            || (ch.match(/href="(https?:\/\/[^"]+)"/)||[])[1];
      if(dl) return { url:dl, quality:q };
    }catch(e){ lastErr=e; }
  }
  throw new Error(`y2mate: no download (${lastErr?.message||'unknown'})`);
}
async function y2mateDownload(videoId, prefer='360p'){
  const { url, quality } = await y2mateResolve(videoId, prefer);
  const id=Date.now()+'_'+Math.random().toString(36).slice(2,8);
  const fp=path.join(DOWNLOAD_DIR,`${id}.mp4`);
  const resp=await axios.get(url,{
    responseType:'stream', timeout:180000, maxContentLength:MEDIA_MAX_BYTES,
    headers:{ 'User-Agent':YT_HEADERS['User-Agent'], 'Referer':'https://www.y2mate.com/' }
  });
  const w=fs.createWriteStream(fp);
  resp.data.pipe(w);
  await new Promise((res,rej)=>{ w.on('finish',res); w.on('error',rej); resp.data.on('error',rej); });
  const st=fs.statSync(fp);
  if(st.size>MEDIA_MAX_BYTES){
    try{ fs.unlinkSync(fp); }catch(e){}
    throw new Error(`Video too big (${Math.round(st.size/1024/1024)}MB > 34MB)`);
  }
  pushLog('info','download',`y2mate ${quality} → ${(st.size/1024/1024).toFixed(1)}MB`);
  return { filePath:fp, quality, sizeBytes:st.size };
}
async function sendVideoFile(jid, filePath, caption=''){
  try{
    const buf=fs.readFileSync(filePath);
    if(buf.length>MEDIA_MAX_BYTES){ try{fs.unlinkSync(filePath);}catch(e){} throw new Error('file too big'); }
    const sent=await queuedSend(jid,{ video:buf, caption, mimetype:'video/mp4' },{},0);
    try{ fs.unlinkSync(filePath); }catch(e){}
    return sent;
  }catch(e){
    try{ fs.unlinkSync(filePath); }catch(e2){}
    throw e;
  }
}
async function startDownloadSearch(chatJid, query, msg, priority=1){
  const results=await ytSearch(query, 6);
  if(!results.length){
    await queuedSend(chatJid,{ text:`Couldn't find "${query}" on YouTube 😕` },{ quoted:msg },priority);
    return;
  }
  downloadPicks.set(chatJid,{ query, results, ts:Date.now() });
  const list=results.map((r,i)=>`${i+1}. ${r.title}`).join('\n');
  await queuedSend(chatJid,{
    text:`Found ${results.length} for *${query}*:\n\n${list}\n\nReply with a number (1-${results.length}) or "1,2,3" for multiple.`
  },{ quoted:msg },priority);
}
async function handleDownloadPick(chatJid, text, msg, priority=1){
  const entry=downloadPicks.get(chatJid);
  if(!entry) return false;
  if(Date.now()-entry.ts>DOWNLOAD_PICK_TTL){ downloadPicks.delete(chatJid); return false; }
  const nums=(text.match(/\d+/g)||[]).map(n=>parseInt(n,10)).filter(n=>n>=1&&n<=entry.results.length);
  if(!nums.length) return false;

  const picks=[...new Set(nums)].slice(0,DOWNLOAD_MAX_PICKS);
  downloadPicks.delete(chatJid);

  await queuedSend(chatJid,{ text:`⏳ Downloading ${picks.length} video(s)...` },{ quoted:msg },priority);

  for(const n of picks){
    const r=entry.results[n-1];
    if(!r) continue;
    try{
      await queuedSend(chatJid,{ text:`▶️ ${r.title}` },{},priority);
      const { filePath, quality, sizeBytes }=await y2mateDownload(r.id,'360p');
      await sendVideoFile(chatJid, filePath, `${r.title}\n(${quality}, ${(sizeBytes/1024/1024).toFixed(1)}MB)`);
      resetDailyStats(); dailyStats.downloads++;
      pushLog('success','download',`${r.title} (${quality})`);
    }catch(e){
      await queuedSend(chatJid,{ text:`❌ ${r.title}: ${e.message}` },{},priority);
      pushLog('error','download',e.message);
    }
  }
  return true;
}

/* ══════════════════════════════════════════════════════════════
 *  ADMIN COMMAND LIST  (updated)
 * ══════════════════════════════════════════════════════════════ */
const COMMAND_LIST = `🥖 *BreadBot v48 — Admin Commands*

*BASICS*
!help / !commands — this list
!ping — alive check
!status / !diag — full status
!test — quick test
!testall — full test suite
!aitest — test AI
!scraperstatus — scraper health
!whoami — your IDs
!sched — scheduler + job queue stats
!stats — daily stats
!summary — today's summary
!logs — last 30 log lines
!errors — recent errors

*COUNTS*
!count — groups/DMs/queue
!groups — list every group + JID
!inbox / !dms — list DM chats

*MAIN GROUP*
!setmain — mark THIS group as main (run inside it)
!main — show current main group
!invite — AI writes invite + sends to all groups
!mylink — send your admin group link here

*MESSAGING*
!broadcast <msg> — all groups
!bcgroup <msg> — alias
!bcdm <msg> — all DMs
!all <msg> — groups + DMs
!send <jid> <msg> — one group
!grouplink <link> — share any link to all groups
!ad <title>|<body>|[cta]|[link]|[style] — build ad
!bcad — broadcast last ad

*GROUP MANAGEMENT*
!antilink on|off
!welcome on|off (fires only in main group)
!goodbye on|off (fires only in main group)
!setwelcome <msg with {user}>
!setgoodbye <msg with {user}>
!promote / !demote / !kick @user
!tagall
!mute / !unmute
!lock / !unlock

*MEDIA*
!pic <query> — search images
!nextpic — cycle
!bcastpic <cap> — broadcast to all
!bcastpicdm / !bcastpicgroup <cap>
!gif <query> — search GIFs
!nextgif — cycle
!bcastgif <cap>
!allimg <url> | <cap>
!scrapersearch <q> / !scrapergif <q>

*DOWNLOADS*
!dl <query> — search YouTube (numbered list)
!download <url> — direct download
!nsfw <url> — NSFW variant (admin always)
!cleanup — wipe downloads folder

*PENDING*
!pending — list unclear requests
!teach <id> <query|say <text>|skip> — resolve

*CONTROL*
!pause / !resume
!freeze / !unfreeze`;

function logRepeatedCmd(cmd, chatJid){
  const now=Date.now();
  const key=`${chatJid}:${cmd}`;
  const last=recentAdminCommands.get(key)||0;
  if(now-last<30000) pushLog('warn','admin',`Repeated: ${cmd}`);
  recentAdminCommands.set(key,now);
}

/* ══════════════════════════════════════════════════════════════
 *  ADMIN COMMAND HANDLER  (all original + new)
 * ══════════════════════════════════════════════════════════════ */
async function handleAdminCommand(text, chatJid, msg){
  const args=text.slice(1).trim().split(/\s+/);
  const cmd=args[0].toLowerCase();
  const reply=(t)=>queuedSend(chatJid,{ text:t },{ quoted:msg },0);
  logRepeatedCmd(cmd, chatJid);

  switch(cmd){
    case 'commands': case 'help': await reply(COMMAND_LIST); break;
    case 'ping':
      await reply(`🏓 Pong!\nStatus: *${connectionStatus}*\nUptime: *${Math.floor((Date.now()-botStartTime)/1000)}s*\nJobs: *${jobs.stats().queued}/${jobs.stats().max}*\nPaused: *${botPaused}*`);
      break;

    case 'pause': botPaused=true; await reply('⏸️ Paused.'); break;
    case 'resume': botPaused=false; await reply('▶️ Resumed.'); break;
    case 'freeze': /* legacy — now no-op since no scheduler freeze */
      await reply('❄️ Note: freeze is now tied to !pause. Use !pause.'); break;
    case 'unfreeze': await reply('🔥 Use !resume.'); break;

    case 'logs': {
      const recent=logBuffer.slice(-30).map(e=>`[${e.level}] ${e.source}: ${e.message}`).join('\n');
      await reply(`📜 *Logs (30)*\n\n${recent.slice(0,3500)}`);
      break;
    }
    case 'errors': {
      const errs=logBuffer.filter(e=>e.level==='error').slice(-20).map(e=>`[${e.source}] ${e.message}`).join('\n');
      await reply(`❌ *Errors (20)*\n\n${errs.slice(0,3500)||'None'}`);
      break;
    }
    case 'cleanup': {
      try{
        const files=fs.readdirSync(DOWNLOAD_DIR);
        for(const f of files){ try{ fs.unlinkSync(path.join(DOWNLOAD_DIR,f)); }catch(e){} }
        await reply(`🧹 Cleared ${files.length} files.`);
      }catch(e){ await reply(`❌ ${e.message}`); }
      break;
    }

    case 'count': {
      await reply([
        `📊 *Counts*`, ``,
        `👥 Groups known: *${joinedGroups.size}*`,
        `💬 DM chats: *${activeDMs.size}*`,
        `📋 Join queue: *${joinQueue.length}*`,
        `⏳ Pending: *${pendingRequests.size}*`,
        `📥 DM queue: *${dmQueue.length}/${DM_QUEUE_MAX}*`,
        `⚙️ Jobs: *${jobs.stats().queued}/${jobs.stats().max}*`,
        `⭐ Main group: *${mainGroupJid||'not set (!setmain)'}*`
      ].join('\n'));
      break;
    }

    case 'groups': {
      if(joinedGroups.size===0){ await reply('📭 Not in any groups yet.'); return; }
      const list=[...joinedGroups.entries()]
        .sort((a,b)=>(a[0]===mainGroupJid?-1:b[0]===mainGroupJid?1:0))
        .slice(0,40)
        .map(([jid,v],i)=>`${i+1}. ${jid===mainGroupJid?'⭐ ':''}${jid}${v.discovered?' (discovered)':''}`)
        .join('\n');
      await reply(`👥 *Groups (${joinedGroups.size})*\n${list}\n\n⭐ = main group · use !send <jid> <msg>`);
      break;
    }
    case 'inbox': case 'dms': {
      if(activeDMs.size===0){ await reply('📭 No DM chats yet.'); return; }
      const list=[...activeDMs].slice(0,40).map((jid,i)=>`${i+1}. ${jid.split('@')[0]}`).join('\n');
      await reply(`💬 *Inbox (${activeDMs.size})*\n${list}`);
      break;
    }

    case 'setmain': {
      if(!chatJid.endsWith('@g.us')){ await reply('❌ Run this from the group itself.'); return; }
      setMainGroup(chatJid);
      await reply(`✅ This group is now the main group. Welcomes and 24/7 AI here.`);
      break;
    }
    case 'main': {
      await reply(`⭐ Main group: *${mainGroupJid||'not set'}*\nRun !setmain in the target group.`);
      break;
    }
    case 'invite': {
      await reply('🎨 Asking AI to write your invite...');
      const aiText=await askRewind(
        `Write ONE warm WhatsApp invite line (max 20 words) asking people to join a Zimbabwean group. Include 1 emoji.`,
        `You are Abby Faith Sithole, warm Zimbabwean. Casual, real, no AI talk. Mix Shona + English.`
      );
      const inviteLine=(aiText&&!containsForbidden(aiText))?aiText:'Come join us, tinofara newe! 🎉';
      const full=`${inviteLine}\n\nFollow this link to join my WhatsApp group: ${ADMIN_GROUP_LINK}`;
      const r=await broadcast({ message:full, mode:'groups' });
      resetDailyStats(); dailyStats.invitesSent++;
      await reply(`✅ AI invite sent to ${r.sent}/${r.total} groups.`);
      break;
    }
    case 'mylink': {
      await queuedSend(chatJid,{ text:`🔗 *Join my group:*\n${ADMIN_GROUP_LINK}` },{ quoted:msg },0);
      break;
    }
    case 'send': {
      const target=args[1];
      const message=args.slice(2).join(' ').trim();
      if(!target||!message){ await reply('❌ Usage: `!send <group-jid> <message>` (get JID from !groups)'); return; }
      if(!joinedGroups.has(target)){ await reply(`❌ Bot is not in ${target}. Use !groups.`); return; }
      try{
        await queuedSend(target,{ text:message },{},0);
        await reply(`✅ Sent to ${target}`);
      }catch(e){ await reply(`❌ ${e.message}`); }
      break;
    }
    case 'jobs': {
      const st=jobs.stats();
      await reply(`⚙️ *Job Queue*\nQueued: *${st.queued}/${st.max}*\nRunning: *${st.running}*\nDone: *${st.totalRun}*\nFailed: *${st.totalFailed}*\nDropped: *${st.totalDropped}*`);
      break;
    }

    case 'status': case 'diag': {
      const st=jobs.stats(); const f=focus.stats(); const gb=groupBatcher.stats();
      resetDailyStats(); const s=dailyStats;
      await reply([
        `📊 *Status*`,
        `Connection: *${connectionStatus}*`,
        `Bot: *${botNumber||'—'}*`,
        `Uptime: *${Math.floor((Date.now()-botStartTime)/1000)}s*`,
        `Time: *${timeGate.describe()}*`,
        `Group window: *${timeGate.describeGroup()}*`,
        `NSFW: *${timeGate.describeNsfw()}*`,
        `DM AI: *${timeGate.describeDm()}*`,
        `Paused: *${botPaused}*`,
        ``,
        `👥 Groups: *${joinedGroups.size}* · 💬 DMs: *${activeDMs.size}*`,
        `⭐ Main group: *${mainGroupJid||'not set'}*`,
        `📋 Queue: *${joinQueue.length}* · Pending: *${pendingRequests.size}*`,
        `📥 DM queue: *${dmQueue.length}/${DM_QUEUE_MAX}*`,
        `⚙️ Jobs: *${st.queued}/${st.max}* · done *${st.totalRun}* · fail *${st.totalFailed}*`,
        `🎯 Focus: *${f.currentState}*`,
        `📦 Batch: *${gb.totalPending}* in *${gb.groupsWithPending}*`,
        ``,
        `📈 *Today*`,
        `DM: *${s.dmsReplied}* · Focus: *${s.focusRuns}*`,
        `Media: *${s.picsSent+s.videosSent}* · NSFW: *${s.nsfwSent}*`,
        `Downloads: *${s.downloads}*`,
        `Broadcasts: *${s.broadcastsSent}* · Invites: *${s.invitesSent}*`,
        `Links: *${s.groupLinksShared}* · Greetings: *${s.greetingsSent}*`,
        `AI errors: *${s.aiErrors}* · Dropped: *${s.messagesDropped}*`
      ].join('\n'));
      break;
    }

    case 'test': {
      const st=jobs.stats();
      await reply(`✅ *Test*\nBot: *${botNumber}*\nStatus: *${connectionStatus}*\nMain: *${mainGroupJid||'not set'}*\nGroups: *${joinedGroups.size}*\nDMs: *${activeDMs.size}*\nJobs: *${st.queued}* queued\nFocus: *${focus.currentState}*`);
      break;
    }
    case 'testall': {
      await reply('🧪 Running full test suite...');
      const t0=Date.now(); const tests=[];
      const s1=await scraperSearch('test'); tests.push(`Scraper search: ${s1.ok?`✅ ${s1.images.length}`:'❌ '+s1.error}`);
      const s2=await scraperGif('funny'); tests.push(`Scraper gif: ${s2.ok?`✅ ${s2.gifs.length}`:'❌ '+s2.error}`);
      const rw=await testRewindRaw(); tests.push(`AI: ${rw.ok?`✅ ${rw.ms}ms`:`❌ ${rw.status||''} ${rw.error}`}`);
      const st=await scraperStatus(); tests.push(`Scraper status: ${st.ok?'✅':'❌ '+st.error}`);
      tests.push(`y2mate: trying...`);
      try{ const y=await y2mateResolve('dQw4w9WgXcQ','360p'); tests.push(`y2mate: ✅ ${y.quality}`); }
      catch(e){ tests.push(`y2mate: ❌ ${e.message}`); }
      tests.push(`WhatsApp: ${connectionStatus==='connected'?'✅':`❌ ${connectionStatus}`}`);
      tests.push(`Main group set: ${mainGroupJid?'✅':'❌ (!setmain)'}`);
      tests.push(`Groups: ${joinedGroups.size} · DMs: ${activeDMs.size}`);
      tests.push(`Time: ${Date.now()-t0}ms`);
      await reply(['🧪 *Test Suite*','',...tests].join('\n'));
      break;
    }
    case 'aitest': {
      await reply('🧪 Testing AI...');
      const r=await testRewindRaw();
      if(r.ok) await reply(`✅ AI WORKS\n${r.status} ${r.ms}ms\n${r.raw||'(empty)'}`);
      else await reply(`❌ AI FAILED\n${r.status||''} ${r.error}`);
      break;
    }
    case 'scraperstatus': {
      await reply('🔎 Testing scraper...');
      const st=await scraperStatus();
      if(st.ok) await reply(`✅ Scraper WORKS\n${st.data.status||'ok'}\n${Math.floor(st.data.uptime||0)}s`);
      else await reply(`❌ Scraper FAILED\n${st.error}`);
      break;
    }
    case 'sched': {
      const st=jobs.stats(); const f=focus.stats(); const gb=groupBatcher.stats();
      await reply(`⚙️ *Jobs*\nQueued: *${st.queued}/${st.max}*\nRunning: *${st.running}*\nDone: *${st.totalRun}*\nFail: *${st.totalFailed}*\nDropped: *${st.totalDropped}*\n\n🎯 Focus: *${f.currentState}*\nJID: *${f.currentJid||'—'}*\n\n📦 Batch: *${gb.totalPending}* in *${gb.groupsWithPending}*\nDM queue: *${dmQueue.length}/${DM_QUEUE_MAX}*`);
      break;
    }

    case 'whoami': {
      const c=extractAllPhoneCandidates(msg,chatJid);
      const l=extractLid(msg,chatJid);
      const a=isAdminSender(msg,chatJid);
      await reply(`🔍 *Who am I?*\nJID: *${msg.key.participant||msg.key.remoteJid}*\nLID: *${l||'—'}*\nCandidates: *${c.join(', ')||'none'}*\nExpected admin: *${ADMIN_PHONE}*\nIs admin: *${a?'YES ✅':'NO ❌'}*\nKnown LIDs: *${[...adminLids].join(', ')||'none'}*`);
      break;
    }

    /* ── Group management ── */
    case 'antilink': { const on=args[1]?.toLowerCase()==='on'; const s=getGroupSetting(chatJid); s.antilink=on; saveGroupSettingsDebounced(); await reply(`✅ Anti-link ${on?'ON':'OFF'}`); break; }
    case 'welcome':  { const on=args[1]?.toLowerCase()==='on'; const s=getGroupSetting(chatJid); s.welcome=on;  saveGroupSettingsDebounced(); await reply(`✅ Welcome ${on?'ON':'OFF'} (only main group)`); break; }
    case 'goodbye':  { const on=args[1]?.toLowerCase()==='on'; const s=getGroupSetting(chatJid); s.goodbye=on;  saveGroupSettingsDebounced(); await reply(`✅ Goodbye ${on?'ON':'OFF'} (only main group)`); break; }
    case 'setwelcome': { const t=args.slice(1).join(' '); if(!t){ await reply('❌ Usage: `!setwelcome <msg with {user}>`'); return; } const s=getGroupSetting(chatJid); s.welcomeMsg=t; saveGroupSettingsDebounced(); await reply(`✅ Welcome set.`); break; }
    case 'setgoodbye': { const t=args.slice(1).join(' '); if(!t){ await reply('❌ Usage: `!setgoodbye <msg with {user}>`'); return; } const s=getGroupSetting(chatJid); s.goodbyeMsg=t; saveGroupSettingsDebounced(); await reply(`✅ Goodbye set.`); break; }

    case 'promote': case 'demote': case 'kick': {
      const t=msg.message?.extendedTextMessage?.contextInfo?.participant
             || (args[1] ? args[1].replace(/\D/g,'')+'@s.whatsapp.net' : null);
      if(!t){ await reply('❌ Reply to user or give phone.'); return; }
      const action = cmd==='promote'?'promote':cmd==='demote'?'demote':'remove';
      try{ await sock.groupParticipantsUpdate(chatJid,[t],action); await reply(`✅ ${cmd} done.`); }
      catch(e){ await reply(`❌ ${e.message}`); }
      break;
    }
    case 'tagall': {
      try{
        const meta=await sock.groupMetadata(chatJid);
        const mentions=meta.participants.map(p=>p.id);
        const list=mentions.map(j=>`@${j.split('@')[0]}`).join(' ');
        await queuedSend(chatJid,{ text:`📢 *Attention:*\n\n${list}`, mentions },{},0);
      }catch(e){ await reply(`❌ ${e.message}`); }
      break;
    }
    case 'mute':   { try{ await sock.groupSettingUpdate(chatJid,'announcement'); await reply('🔇 Muted.'); }catch(e){ await reply(`❌ ${e.message}`); } break; }
    case 'unmute': { try{ await sock.groupSettingUpdate(chatJid,'not_announcement'); await reply('🔊 Unmuted.'); }catch(e){ await reply(`❌ ${e.message}`); } break; }
    case 'lock':   { try{ await sock.groupSettingUpdate(chatJid,'locked'); await reply('🔒 Locked.'); }catch(e){ await reply(`❌ ${e.message}`); } break; }
    case 'unlock': { try{ await sock.groupSettingUpdate(chatJid,'unlocked'); await reply('🔓 Unlocked.'); }catch(e){ await reply(`❌ ${e.message}`); } break; }

    /* ── Downloads ── */
    case 'dl': {
      const q=args.slice(1).join(' ').trim();
      if(!q){ await reply('❌ Usage: `!dl <song or video name>`'); return; }
      await startDownloadSearch(chatJid, q, msg, 0);
      break;
    }
    case 'download': {
      const url=args[1];
      if(!url){ await reply('❌ Usage: `!download <youtube-url>` (or use `!dl <name>` to search)'); return; }
      await reply('⏳ Resolving via y2mate...');
      try{
        const vid=(url.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/)||[])[1];
        if(!vid){ await reply('❌ Cannot parse video ID from URL.'); return; }
        const { filePath, quality, sizeBytes }=await y2mateDownload(vid,'360p');
        await reply(`✅ Got ${quality} (${(sizeBytes/1024/1024).toFixed(1)}MB). Sending...`);
        await sendVideoFile(chatJid, filePath, `From ${url}`);
        resetDailyStats(); dailyStats.downloads++;
        await reply('✅ Sent.');
      }catch(e){ await reply(`❌ ${e.message}`); }
      break;
    }
    case 'nsfw': {
      const url=args[1];
      if(!url){ await reply('❌ Usage: `!nsfw <youtube-url>`'); return; }
      await reply('⏳ Resolving NSFW video...');
      try{
        const vid=(url.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/)||[])[1];
        if(!vid){ await reply('❌ Cannot parse video ID.'); return; }
        const { filePath, quality, sizeBytes }=await y2mateDownload(vid,'720p');
        await reply(`✅ Got ${quality} (${(sizeBytes/1024/1024).toFixed(1)}MB). Sending...`);
        await sendVideoFile(chatJid, filePath, `NSFW from ${url}`);
        resetDailyStats(); dailyStats.downloads++; dailyStats.nsfwDownloads++;
        await reply('✅ Sent.');
      }catch(e){ await reply(`❌ ${e.message}`); }
      break;
    }

    case 'setadmingroup': {
      setAdminGroupJid(chatJid);
      await reply('✅ This group is now the admin group.');
      break;
    }
    case 'grouplink': case 'grouplinkshare': {
      const link=args[1];
      if(!link||!link.includes('chat.whatsapp.com')){ await reply('❌ Usage: `!grouplink <link>`'); return; }
      await reply(`⏳ Sharing to all groups...`);
      const targets=[...joinedGroups.keys()].filter(j=>j!==chatJid);
      let sent=0;
      for(const jid of targets){
        try{ await queuedSend(jid,{ text:`🔗 *Join our group:*\n${link}` },{},0); sent++; }catch(e){}
      }
      resetDailyStats(); dailyStats.groupLinksShared++;
      await reply(`✅ Shared: ${sent}/${targets.length}`);
      break;
    }

    case 'broadcast': case 'bcgroup': {
      const message=args.slice(1).join(' ');
      if(!message){ await reply(`❌ Usage: \`!${cmd} <message>\``); return; }
      if(joinedGroups.size===0){ await reply('📭 No groups.'); return; }
      await reply(`⏳ Broadcasting to ${joinedGroups.size} groups (main first)...`);
      const r=await broadcast({ message, mode:'groups' });
      resetDailyStats(); dailyStats.adminBroadcasts++;
      await reply(`✅ Done: ${r.sent}/${r.total}`);
      break;
    }
    case 'all': case 'bcdm': {
      const message=args.slice(1).join(' ');
      if(!message){ await reply(`❌ Usage: \`!${cmd} <message>\``); return; }
      const mode=cmd==='all'?'all':'dms';
      const count=mode==='all'?(joinedGroups.size+activeDMs.size):activeDMs.size;
      if(count===0){ await reply(`📭 No ${mode} targets.`); return; }
      await reply(`⏳ Queued to ${count} (${mode})...`);
      const r=await broadcast({ message, mode });
      await reply(`✅ Done: ${r.sent}/${r.total}`);
      break;
    }

    case 'pic': case 'search': {
      const q=args.slice(1).join(' ');
      if(!q){ await reply('❌ Usage: `!pic <query>`'); return; }
      const r=await scraperSearch(q, false);
      if(!r.ok||r.images.length===0){ await reply('❌ No results'); return; }
      previewCache.imageUrls=r.images; previewCache.imageIndex=0;
      previewCache.currentType='image'; previewCache.currentUrl=r.images[0];
      try{ await queuedSend(chatJid,{ image:{ url:r.images[0] }, caption:`Preview 1/${r.images.length}\n!nextpic · !bcastpic <caption>` },{},0); }
      catch(e){ await reply(`❌ ${e.message}`); }
      break;
    }
    case 'nextpic': {
      if(previewCache.imageUrls.length===0){ await reply('❌ No preview.'); return; }
      previewCache.imageIndex=(previewCache.imageIndex+1)%previewCache.imageUrls.length;
      previewCache.currentUrl=previewCache.imageUrls[previewCache.imageIndex];
      try{ await queuedSend(chatJid,{ image:{ url:previewCache.currentUrl }, caption:`Preview ${previewCache.imageIndex+1}/${previewCache.imageUrls.length}` },{},0); }
      catch(e){ await reply(`❌ ${e.message}`); }
      break;
    }
    case 'gif': {
      const q=args.slice(1).join(' ');
      if(!q){ await reply('❌ Usage: `!gif <query>`'); return; }
      const r=await scraperGif(q, false);
      if(!r.ok||r.gifs.length===0){ await reply('❌ No results'); return; }
      previewCache.gifUrls=r.gifs; previewCache.gifIndex=0;
      previewCache.currentType='gif'; previewCache.currentUrl=r.gifs[0];
      try{ await queuedSend(chatJid,{ video:{ url:r.gifs[0] }, gifPlayback:true, caption:`GIF 1/${r.gifs.length}\n!nextgif · !bcastgif <caption>` },{},0); }
      catch(e){ await reply(`❌ ${e.message}`); }
      break;
    }
    case 'nextgif': {
      if(previewCache.gifUrls.length===0){ await reply('❌ No preview.'); return; }
      previewCache.gifIndex=(previewCache.gifIndex+1)%previewCache.gifUrls.length;
      previewCache.currentUrl=previewCache.gifUrls[previewCache.gifIndex];
      try{ await queuedSend(chatJid,{ video:{ url:previewCache.currentUrl }, gifPlayback:true, caption:`GIF ${previewCache.gifIndex+1}/${previewCache.gifUrls.length}` },{},0); }
      catch(e){ await reply(`❌ ${e.message}`); }
      break;
    }
    case 'bcastpic': case 'bcastpicdm': case 'bcastpicgroup': {
      if(!previewCache.currentUrl||previewCache.currentType!=='image'){ await reply('❌ No image preview.'); return; }
      const caption=args.slice(1).join(' ')||'';
      const mode=cmd==='bcastpic'?'all':cmd==='bcastpicdm'?'dms':'groups';
      const count=mode==='all'?(joinedGroups.size+activeDMs.size):mode==='groups'?joinedGroups.size:activeDMs.size;
      if(count===0){ await reply(`📭 No ${mode} targets.`); return; }
      await reply(`⏳ Queued to ${count}...`);
      const r=await broadcast({ message:caption, imageUrl:previewCache.currentUrl, mode });
      await reply(`✅ Done: ${r.sent}/${r.total}`);
      break;
    }
    case 'bcastgif': {
      if(!previewCache.currentUrl||previewCache.currentType!=='gif'){ await reply('❌ No GIF preview.'); return; }
      const caption=args.slice(1).join(' ')||'';
      const count=joinedGroups.size+activeDMs.size;
      if(count===0){ await reply('📭 No targets.'); return; }
      await reply(`⏳ Queued to ${count}...`);
      const r=await broadcast({ message:caption, gifUrl:previewCache.currentUrl, mode:'all' });
      await reply(`✅ Done: ${r.sent}/${r.total}`);
      break;
    }
    case 'allimg': {
      const parts=args.slice(1).join(' ').split('|').map(s=>s.trim());
      const url=parts[0]; const caption=parts[1]||'';
      if(!url){ await reply('❌ Usage: `!allimg <url> | <caption>`'); return; }
      const count=joinedGroups.size+activeDMs.size;
      if(count===0){ await reply('📭 No targets.'); return; }
      const r=await broadcast({ message:caption, imageUrl:url, mode:'all' });
      await reply(`✅ Done: ${r.sent}/${r.total}`);
      break;
    }
    case 'ad': {
      const parts=args.slice(1).join(' ').split('|').map(p=>p.trim());
      const [title, body, cta, link, style]=parts;
      if(!title||!body){ await reply('❌ Usage: `!ad <title>|<body>|[cta]|[link]|[style]`'); return; }
      const adText=AdBuilder.build({ title, body, cta, link, footer:'Reply STOP to opt out', style:style||'fancy' });
      await reply(`📢 *Preview:*\n\n${adText}`);
      replyCache.set('LAST_AD', adText);
      break;
    }
    case 'bcad': {
      const adText=replyCache.get('LAST_AD');
      if(!adText){ await reply('❌ No ad built.'); return; }
      const count=joinedGroups.size+activeDMs.size;
      if(count===0){ await reply('📭 No targets.'); return; }
      const r=await broadcast({ message:adText, mode:'all' });
      await reply(`✅ Done: ${r.sent}/${r.total}`);
      break;
    }
    case 'pending': {
      if(pendingRequests.size===0){ await reply('📭 No pending.'); return; }
      const list=[...pendingRequests.values()].slice(0,20).map(p=>`• *${p.id}* — ${p.userName} — ${p.intent.type}: "${p.intent.query}"`).join('\n');
      await reply(`⏳ *Pending (${pendingRequests.size})*\n${list}`);
      break;
    }
    case 'teach': {
      const id=args[1];
      if(!id){ await reply('❌ Usage: `!teach <id> <query>` / `!teach <id> say <text>` / `!teach <id> skip`'); return; }
      const rest=args.slice(2).join(' ').trim();
      if(!rest){ await reply('❌ Provide action.'); return; }
      if(rest.toLowerCase()==='skip') await resolvePending(id,'skip',null,chatJid);
      else if(rest.toLowerCase().startsWith('say ')) await resolvePending(id,'say',rest.slice(4).trim(),chatJid);
      else await resolvePending(id,'search',rest,chatJid);
      break;
    }
    case 'scrapersearch': case 'scrapergif': {
      const q=args.slice(1).join(' ');
      if(!q){ await reply(`❌ Usage: \`!${cmd} <query>\``); return; }
      const r=cmd==='scrapersearch'?await scraperSearch(q):await scraperGif(q);
      if(!r.ok){ await reply(`❌ Failed: ${r.error}`); return; }
      const items=r.images||r.gifs||[];
      await reply(`✅ ${items.length} results\nFirst: ${items[0]||'none'}`);
      break;
    }
    case 'stats': {
      resetDailyStats(); const s=dailyStats;
      await reply(`📊 *Stats*\n\n*Now*\nGroups: *${joinedGroups.size}*\nDMs: *${activeDMs.size}*\nQueue: *${joinQueue.length}*\nPending: *${pendingRequests.size}*\nJobs: *${jobs.stats().queued}/${jobs.stats().max}*\nUptime: *${Math.floor((Date.now()-botStartTime)/1000)}s*\n\n*Today*\nJoined: *${s.joined}*\nDiscovered: *${s.discovered}*\nFailed: *${s.failed}*\nDM replies: *${s.dmsReplied}*\nFocus: *${s.focusRuns}*\nPics: *${s.picsSent}* / Videos: *${s.videosSent}*\nNSFW: *${s.nsfwSent}*\nDownloads: *${s.downloads}* (NSFW: *${s.nsfwDownloads}*)\nBroadcasts: *${s.broadcastsSent}*\nInvites: *${s.invitesSent}*\nLinks: *${s.groupLinksShared}*\nGreetings: *${s.greetingsSent}*\nAI err: *${s.aiErrors}*\nDropped: *${s.messagesDropped}*`);
      break;
    }
    case 'summary': {
      resetDailyStats(); const s=dailyStats;
      await reply(`📊 *Today (${s.date})*\nJoined: *${s.joined}*\nDM: *${s.dmsReplied}*\nFocus: *${s.focusRuns}*\nMedia: *${s.picsSent+s.videosSent}*\nNSFW: *${s.nsfwSent}*\nDownloads: *${s.downloads}*\nBroadcasts: *${s.broadcastsSent}*\nInvites: *${s.invitesSent}*\nLinks: *${s.groupLinksShared}*\nGreetings: *${s.greetingsSent}*`);
      break;
    }
    default: await reply(`❓ Unknown: *!${cmd}*\n\nSend *!help* to see all commands.`);
  }
}

/* ══════════════════════════════════════════════════════════════
 *  CONNECT BOT  (with 515 fix)
 * ══════════════════════════════════════════════════════════════ */
async function connectBot(){
  if(isConnecting) return;
  isConnecting=true; manualDisconnect=false;
  try{
    pushLog('info','bot','Initializing...');
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const { version } = await fetchLatestBaileysVersion();
    pushLog('info','bot',`WA version ${version.join('.')}`);

    const baseSocket = makeWASocket({
      version, auth: state, printQRInTerminal: false,
      browser: Browsers.macOS('Desktop'),
      logger: pino({ level:'silent' }),
      markOnlineOnConnect: false, syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      getMessage: async ()=>undefined,
      qrTimeout: 300000, connectTimeoutMs: 120000,
      keepAliveIntervalMs: 30000
    });

    if(wrapSocket){
      try{
        sock = wrapSocket(baseSocket,{
          groupOpGuard:{ limits:{ add:{ max:3, windowMs:600000 } } },
          legitimacySignals:{ typoProbability:0.02 },
          jidCanonicalizer:{ enabled:true, canonical:'pn' }
        });
        pushLog('success','antiban','Wrapped');
      }catch(e){ pushLog('warn','antiban',e.message); sock=baseSocket; }
    } else { sock=baseSocket; pushLog('warn','antiban','Not available'); }

    if(SessionHealthMonitor){
      try{
        healthMonitor=new SessionHealthMonitor({
          badMacThreshold:3, badMacWindowMs:60000,
          onDegraded:(stats)=>{
            pushLog('error','health',`DEGRADED: ${stats.badMacCount} Bad MACs`);
            resetDailyStats(); dailyStats.badMacs=stats.badMacCount;
            notifyAdmin(`⚠️ Session degraded — ${stats.badMacCount} Bad MACs`).catch(()=>{});
          }
        });
        pushLog('info','health','Monitor started');
      }catch(e){ pushLog('warn','health',e.message); }
    }

    sock.ev.on('connection.update', async (update)=>{
      const { connection, lastDisconnect, qr } = update;
      if(qr){ qrDataUri=await QRCode.toDataURL(qr); connectionStatus='qr'; pushLog('info','bot','QR generated'); }
      if(connection==='open'){
        isConnecting=false; connectionStatus='connected'; reconnectAttempts=0; botStartTime=Date.now();
        botJid=sock.user?.id||null; botNumber=botJid?.split(':')[0]?.split('@')[0]||'unknown';
        consecutive515=0; recent515Timestamps=[]; spamCooldownUntil=0; lastReconnectAt=0;
        pushLog('success','bot',`Connected as ${botNumber}`);
        pushLog('info','time',`${timeGate.describe()} | Group: ${timeGate.describeGroup()} | NSFW: ${timeGate.describeNsfw()} | DM AI: ${timeGate.describeDm()}`);
        if(createHumanEntropyService){
          try{
            entropyService=createHumanEntropyService(sock,botJid,
              { enabled:true, minIntervalMs:7200000, maxIntervalMs:21600000 });
            entropyService.start();
            pushLog('success','entropy','Started');
          }catch(e){ pushLog('warn','entropy',e.message); }
        }
        try{ await sock.sendPresenceUpdate('available'); }catch(e){}
        await notifyAdmin([
          `✅ *BreadBot ONLINE*`,
          `📱 ${botNumber}`,
          `⭐ Main group: ${mainGroupJid||'_not set — run !setmain in your group_'}`,
          `👥 Groups: ${joinedGroups.size}`,
          `💬 DMs: ${activeDMs.size}`,
          `🕐 ${timeGate.describe()}`,
          `Group: ${timeGate.describeGroup()} | NSFW: ${timeGate.describeNsfw()} | DM AI: ${timeGate.describeDm()}`,
          ``,
          `Send *!help* for admin commands.`
        ].join('\n'));
      }
      if(connection==='close'){
        isConnecting=false;
        const code=getDisconnectStatusCode(lastDisconnect);
        let cls=null; if(classifyDisconnect){ try{ cls=classifyDisconnect(code); }catch(e){} }
        if(cls) pushLog('warn','bot',`Disconnected (${code}) — ${cls.message} [${cls.category}]`);
        else pushLog('warn','bot',`Disconnected (${code})`);
        if(entropyService){ try{ entropyService.stop(); }catch(e){} entropyService=null; }
        if(manualDisconnect){ connectionStatus='disconnected'; return; }
        if(code===DisconnectReason.loggedOut){ connectionStatus='disconnected'; pushLog('error','bot','Logged out'); return; }
        if(code===408 && connectionStatus==='qr' && !botNumber){ connectionStatus='disconnected'; pushLog('warn','bot','QR expired'); return; }
        if(code===428 || code===440){ connectionStatus='disconnected'; pushLog('error','bot',`Conflict ${code}`); return; }

        if(code===DisconnectReason.restartRequired || code===515){
          if(restart515InFlight){ pushLog('warn','bot','515 handler already in flight — skip'); return; }
          restart515InFlight=true;
          const now=Date.now();
          if(now<spamCooldownUntil){
            const remain=spamCooldownUntil-now;
            pushLog('warn','antispam',`cooldown — wait ${Math.ceil(remain/1000)}s`);
            await new Promise(r=>setTimeout(r,remain));
          }
          record515();
          const delay=next515Delay();
          pushLog('warn','bot',`Retry ${delay/1000}s (515 attempt ${consecutive515})`);
          await new Promise(r=>setTimeout(r,delay));
          await enforceMinReconnectInterval();
          try{ sock.ev.removeAllListeners('connection.update'); }catch(e){}
          try{ sock.ev.removeAllListeners('creds.update'); }catch(e){}
          try{ sock.end(undefined); }catch(e){}
          sock=null; restart515InFlight=false;
          connectionStatus='reconnecting';
          return connectBot();
        }

        const shouldReconnect = cls ? cls.shouldReconnect : true;
        if(shouldReconnect && reconnectAttempts<MAX_RECONNECT){
          reconnectAttempts++;
          const delay=cls?.backoffMs || Math.min(5000*reconnectAttempts,30000);
          connectionStatus='reconnecting';
          pushLog('warn','bot',`Retry ${delay/1000}s [${reconnectAttempts}/${MAX_RECONNECT}]`);
          setTimeout(()=>{ try{sock.end(undefined);}catch(e){} sock=null; connectBot(); },delay);
        } else { connectionStatus='disconnected'; pushLog('error','bot','Max retries'); }
      }
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('group-participants.update', async (update)=>{
      try{ await handleGroupParticipantsUpdate(update); }catch(e){ pushLog('error','group',e.message); }
    });
    sock.ev.on('messages.upsert', async ({ messages })=>{
      for(const msg of messages||[]){
        try{
          if(entropyService && msg.key?.remoteJid && !msg.key.fromMe){
            try{ entropyService.addRecentContact(msg.key.remoteJid,msg.key); }catch(e){}
          }
          await handleMessage(msg);
        }catch(e){ pushLog('error','handler',`handleMessage: ${e.message}`); }
      }
    });
  }catch(err){
    isConnecting=false;
    pushLog('error','bot',`Connection failed: ${err.message}`);
    connectionStatus='error';
  }
}
async function disconnectBot(){
  manualDisconnect=true;
  if(entropyService){ try{ entropyService.stop(); }catch(e){} entropyService=null; }
  if(sock){ try{ sock.end(undefined); }catch(e){} sock=null;
    connectionStatus='disconnected'; qrDataUri=null; isConnecting=false; botNumber=null;
    pushLog('warn','bot','Disconnected'); }
}
function refreshQR(){
  qrDataUri=null; connectionStatus='disconnected'; manualDisconnect=true;
  if(sock){ try{ sock.end(undefined); }catch(e){} sock=null; }
  isConnecting=false; botNumber=null;
  consecutive515=0; recent515Timestamps=[]; spamCooldownUntil=0; lastReconnectAt=0; restart515InFlight=false;
  pushLog('info','bot','Manual QR refresh');
  setTimeout(()=>{ manualDisconnect=false; connectBot(); },1500);
}

/* ══════════════════════════════════════════════════════════════
 *  processDM  — for admin it uses natural; for others AI window
 * ══════════════════════════════════════════════════════════════ */
async function processDM(item){
  const { msg, text, chatJid, senderJid, pushName, phone, intent, lang } = item;
  const langName=LANG_NAMES[lang]||'English';
  if(containsForbidden(text)){ pushLog('info','filter',`Ignored: ${pushName}`); return; }

  if(detectGroupLinkRequest(text)){
    const link=ADMIN_GROUP_LINK;
    await queuedSend(chatJid,{ text:`🔗 *Join our group:*\n${link}` },{ quoted:msg },2);
    resetDailyStats(); dailyStats.dmsReplied++;
    pushLog('info','ai',`Sent group link to ${pushName}`);
    return;
  }

  if(intent){
    pushLog('info','pic',`Intent ${intent.type} — "${intent.query}" from ${pushName}`);
    const vague=isVagueQuery(intent.query);
    if(!vague){
      if(intent.type==='video'||intent.type==='gif'){
        const r=await scraperGif(intent.query,false);
        if(r.ok&&r.gifs.length>0){
          try{ await queuedSend(chatJid,{ video:{ url:r.gifs[0] }, gifPlayback:true },{ quoted:msg },2); }
          catch(e){ await queuedSend(chatJid,{ text:r.gifs[0] },{ quoted:msg },2); }
          resetDailyStats(); if(intent.type==='video') dailyStats.videosSent++; else dailyStats.picsSent++;
          return;
        }
      } else {
        const r=await scraperSearch(intent.query,false);
        if(r.ok&&r.images.length>0){
          try{ await queuedSend(chatJid,{ image:{ url:r.images[0] } },{ quoted:msg },2); }
          catch(e){ await queuedSend(chatJid,{ text:r.images[0] },{ quoted:msg },2); }
          resetDailyStats(); dailyStats.picsSent++;
          return;
        }
      }
    }
    const history=userHistories.get(senderJid)||[];
    const id=createPendingRequest(senderJid,pushName,phone,history,intent);
    pushLog('warn','ai',`Pending ${id} for ${pushName}`);
    const ack=await askRewind(`User asked for something vague. Reply casually (max 8 words) — no AI talk.`,
      `You are Abby Faith Sithole, 23, Harare Zimbabwe. Casual. Reply in ${langName}.`);
    const finalAck=(ack&&!containsForbidden(ack))?informalize(ack):'checking rn 😊';
    try{ await queuedSend(chatJid,{ text:finalAck },{ quoted:msg },2); }catch(e){}
    await forwardToAdminForHelp(id, pendingRequests.get(id));
    return;
  }

  const sys=`You are Abby Faith Sithole, a 23-year-old girl from Harare, Zimbabwe. You are a REAL person. Reply in ${langName}. Mix in light Shona. Keep replies SHORT: 1-2 sentences. Never say you're an AI. Be casual, playful.`;
  const aiReply=await askRewind(text, sys);
  if(!aiReply){ pushLog('warn','ai',`No reply for ${pushName}`); return; }
  if(containsForbidden(aiReply)){ pushLog('warn','ai',`Dropped (forbidden)`); return; }
  const final=informalize(humanize(aiReply));
  if(!final) return;
  await queuedSend(chatJid,{ text:final },{ quoted:msg },2);
  resetDailyStats(); dailyStats.dmsReplied++; dailyStats.focusRuns++;
  pushLog('info','ai',`DM reply to ${pushName}: ${final.slice(0,50)}`);
}

/* ══════════════════════════════════════════════════════════════
 *  handleMessage  — master router
 * ══════════════════════════════════════════════════════════════ */
async function handleMessage(msg){
  if(!sock) return;
  if(checkFlood()){ resetDailyStats(); dailyStats.messagesDropped++; return; }
  if(Date.now()<floodIgnoreUntil) return;

  const chatJid=msg.key?.remoteJid;
  if(!chatJid) return;
  activeChats.add(chatJid);

  const msgId=msg.key.id;
  if(processedMessages.has(msgId)) return;
  processedMessages.add(msgId);
  if(processedMessages.size>10000){
    const a=[...processedMessages]; processedMessages.clear();
    for(const i of a.slice(-5000)) processedMessages.add(i);
  }
  if(botSentIds.has(msgId)) return;

  let m=msg.message; let guard=0;
  while(m && guard++<10){
    if(m.ephemeralMessage?.message){ m=m.ephemeralMessage.message; continue; }
    if(m.viewOnceMessage?.message){ m=m.viewOnceMessage.message; continue; }
    if(m.viewOnceMessageV2?.message){ m=m.viewOnceMessageV2.message; continue; }
    if(m.deviceSentMessage?.message){ m=m.deviceSentMessage.message; continue; }
    if(m.documentWithCaptionMessage?.message){ m=m.documentWithCaptionMessage.message; continue; }
    break;
  }

  const text=m?.conversation || m?.extendedTextMessage?.text
          || m?.imageMessage?.caption || m?.videoMessage?.caption || '';
  const mediaType = m?.imageMessage ? 'image' : m?.videoMessage ? 'video'
                  : m?.audioMessage ? 'audio' : m?.documentMessage ? 'document' : 'text';
  const isGroup   = chatJid.endsWith('@g.us');
  const senderJid = isGroup ? (msg.key.participant||chatJid) : chatJid;
  const phone     = extractPhone(msg, senderJid);
  const lid       = extractLid(msg, senderJid);
  const pushName  = msg.pushName || (msg.key.fromMe?'You':'Unknown');
  const chatType  = isGroup ? 'group' : 'dm';

  if(isGroup){ discoverGroup(chatJid,null); recordGroupMessage(chatJid,text,senderJid); }
  else activeDMs.add(chatJid);

  pushLiveMessage({ id:msgId, ts:new Date().toISOString(), chatJid, chatType,
    senderJid, senderName:pushName, phone:phone||'—', lid:lid||'—',
    text:text.slice(0,200)||`[${mediaType}]`, mediaType });

  const isAdmin = isAdminSender(msg, senderJid);
  const priority = isAdmin ? 0
                  : (chatJid===mainGroupJid ? 1
                  : (!isGroup ? 2 : 3));

  /* ═══ 1. ADMIN ! COMMANDS — top priority, always work ═══ */
  if(isAdmin && text.startsWith('!')){
    pushLog('info','admin',`Cmd: ${text.split(' ')[0]} (${chatType})`);
    await handleAdminCommand(text, chatJid, msg);
    return;
  }

  if(botPaused && !isAdmin){ pushLog('info','pause',`Paused — ${pushName}`); return; }

  /* ═══ 2. Admin image broadcast replies (!all !bcdm !bcgroup with image) ═══ */
  if(!isGroup && isAdmin && mediaType==='image' && text.startsWith('!')){
    const args=text.slice(1).trim().split(/\s+/);
    const cmd=args[0].toLowerCase();
    if(['bcdm','bcgroup','all'].includes(cmd)){
      const caption=args.slice(1).join(' ').trim();
      pushLog('info','broadcast',`Image ${cmd}: "${caption}"`);
      await queuedSend(chatJid,{ text:`⏳ Downloading...` },{},0);
      try{
        const buffer=await downloadMediaMessage(msg,'buffer',{},
          { logger:pino({level:'silent'}), reuploadRequest:sock.updateMediaMessage });
        if(!buffer){ await queuedSend(chatJid,{ text:'❌ Failed.' },{},0); return; }
        if(buffer.length>MEDIA_MAX_BYTES){ await queuedSend(chatJid,{ text:`❌ ${Math.round(buffer.length/1024/1024)}MB > 34MB` },{},0); return; }
        const mode=cmd==='bcdm'?'dms':cmd==='bcgroup'?'groups':'all';
        const count=mode==='all'?(joinedGroups.size+activeDMs.size):mode==='groups'?joinedGroups.size:activeDMs.size;
        if(count===0){ await queuedSend(chatJid,{ text:`📭 No ${mode}.` },{},0); return; }
        await queuedSend(chatJid,{ text:`📸 Queued to ${count} ${mode}.` },{},0);
        const r=await broadcast({ message:caption, imageBuffer:buffer, mode });
        resetDailyStats(); dailyStats.imageBroadcasts++;
        await queuedSend(chatJid,{ text:`✅ Done: ${r.sent}/${r.total}` },{},0);
      }catch(e){
        pushLog('error','broadcast',e.message);
        await queuedSend(chatJid,{ text:`❌ ${e.message}` },{},0);
      }
      return;
    }
  }

  /* ═══ 3. User history for pending/teach (non-admin DMs) ═══ */
  if(!isGroup && !isAdmin && !msg.key.fromMe && text){
    if(!userHistories.has(senderJid)) userHistories.set(senderJid,[]);
    const h=userHistories.get(senderJid);
    h.push({ text, ts:Date.now() });
    if(h.length>USER_HISTORY_SIZE*2) h.shift();
  }

  /* ═══ 4. Invite-link auto-join (any chat) ═══ */
  const codes=extractAllInviteCodes(text);
  if(codes.length>0){
    let added=0;
    for(const c of codes) if(queueJoin(c, phone||pushName, chatType)) added++;
    if(added>0){
      pushLog('info','join',`Queued ${added}/${codes.length}`);
      if(!isGroup) await queuedSend(chatJid,{ text:`✅ Queued ${added}. Total: ${joinQueue.length}` },{},priority);
      processJoinQueue();
    }
  }

  /* ═══ 5. Download pick from a previous search list ═══ */
  if(text && downloadPicks.has(chatJid)){
    const ok = await handleDownloadPick(chatJid, text, msg, priority);
    if(ok) return;
  }

  /* ═══ 6. Download intent (search YouTube) ═══ */
  const dl=text ? detectDownloadIntent(text) : null;
  if(dl && dl.query){
    await startDownloadSearch(chatJid, dl.query, msg, priority);
    return;
  }

  /* ═══ 7. Group messages ═══ */
  if(isGroup){
    await handleAntiLink(chatJid, msg, text, senderJid, isAdmin);

    const isMain = chatJid===mainGroupJid;
    const directed = isDirectedAtBot(msg, text);

    /* 7a. Main group: 24/7 AI */
    if(isMain && text){
      // Group link request
      if(detectGroupLinkRequest(text)){
        await queuedSend(chatJid,{ text:`🔗 *Join:*\n${ADMIN_GROUP_LINK}` },{ quoted:msg },priority);
        return;
      }
      // NSFW check (only admins or night window)
      const isNsfw=detectNsfw(text);
      if(isNsfw && !isAdmin && !timeGate.isNsfwActive()){
        await queuedSend(chatJid,{ text:`Not right now 😅 try after 9pm` },{ quoted:msg },priority);
        return;
      }
      // Media intent
      const gIntent=detectMediaIntent(text);
      if(gIntent && !isVagueQuery(gIntent.query)){
        pushLog('info','pic',`Main group intent ${gIntent.type} — "${gIntent.query}"`);
        if(gIntent.type==='video'||gIntent.type==='gif'){
          const r=await scraperGif(gIntent.query, isNsfw);
          if(r.ok&&r.gifs.length){
            try{ await queuedSend(chatJid,{ video:{ url:r.gifs[0] }, gifPlayback:true },{ quoted:msg },priority); }
            catch(e){ await queuedSend(chatJid,{ text:r.gifs[0] },{},priority); }
            resetDailyStats(); if(gIntent.type==='video') dailyStats.videosSent++; else dailyStats.picsSent++;
            if(isNsfw) dailyStats.nsfwSent++;
            return;
          }
        } else {
          const r=await scraperSearch(gIntent.query, isNsfw);
          if(r.ok&&r.images.length){
            try{ await queuedSend(chatJid,{ image:{ url:r.images[0] } },{ quoted:msg },priority); }
            catch(e){ await queuedSend(chatJid,{ text:r.images[0] },{},priority); }
            resetDailyStats(); dailyStats.picsSent++;
            if(isNsfw) dailyStats.nsfwSent++;
            return;
          }
        }
      }
      // Free AI reply
      const analysis=analyzeLearning(chatJid);
      const lang=detectLanguage(text);
      const sys=`You are Abby Faith Sithole, 23, Harare Zimbabwe. You are in your OWN WhatsApp group where you are a real member. Reply casually, SHORT (1 sentence max), warm, in ${LANG_NAMES[lang]}. Mix light Shona naturally. Never say you're AI. ${analysis?`Friends here often use words like: ${analysis.topWords.map(w=>w[0]).join(', ')}`:''}`;
      const aiReply=await askRewind(text, sys);
      if(aiReply && !containsForbidden(aiReply)){
        await queuedSend(chatJid,{ text:informalize(aiReply) },{ quoted:msg },priority);
        resetDailyStats(); dailyStats.greetingsSent++;
      }
      return;
    }

    /* 7b. Other groups: directed OR 2% ambient */
    if(directed && text){
      const analysis=analyzeLearning(chatJid);
      const lang=detectLanguage(text);
      const sys=`You are Abby Faith Sithole, 23, Harare Zimbabwe. Someone in a WhatsApp group is talking TO you directly. Reply casually, SHORT, in ${LANG_NAMES[lang]}. Never say you're AI. ${analysis?`Group style: ${analysis.topWords.map(w=>w[0]).join(', ')}`:''}`;
      const aiReply=await askRewind(text, sys);
      if(aiReply && !containsForbidden(aiReply)){
        await queuedSend(chatJid,{ text:informalize(aiReply) },{ quoted:msg },priority);
        resetDailyStats(); dailyStats.greetingsSent++;
      }
      return;
    }
    if(text && Math.random()<AMBIENT_CHANCE){
      const analysis=analyzeLearning(chatJid);
      const sys=`You are Abby Faith Sithole in a group chat. React casually, 1 short sentence, warm, real. Never mention being AI. ${analysis?`Chat style: ${analysis.topWords.map(w=>w[0]).join(', ')}`:''}`;
      const aiReply=await askRewind(text, sys);
      if(aiReply && !containsForbidden(aiReply)){
        await queuedSend(chatJid,{ text:informalize(aiReply) },{ quoted:msg },priority);
        pushLog('info','ambient',`Replied in ${chatJid}`);
      }
    } else {
      groupBatcher.enqueue(chatJid,{ msg, text, ts:Date.now() });
    }
    return;
  }

  /* ═══ 8. Non-admin DM ═══ */
  if(isAdmin){ pushLog('info','admin',`Admin DM (no !cmd)`); return; } // admin DM with no ! → ignored (they know to use !)

  if(!timeGate.isDmAiWindow()){
    pushLog('info','dm',`Outside window — ignored ${pushName}`);
    return;
  }
  enqueueDM({ msg, text, chatJid, senderJid, pushName, phone,
    intent:detectMediaIntent(text), lang:detectLanguage(text) });
}

/* ══════════════════════════════════════════════════════════════
 *  EXPRESS PANEL
 * ══════════════════════════════════════════════════════════════ */
const app = express();
app.use(express.json());

app.get('/health',(req,res)=>res.json({
  ok:true, ts:Date.now(), status:connectionStatus,
  uptime:Math.floor((Date.now()-botStartTime)/1000),
  jobs: jobs.stats(),
  window:{ time:timeGate.describe(), group:timeGate.describeGroup(),
    nsfw:timeGate.describeNsfw(), dmAI:timeGate.describeDm() },
  paused:botPaused, mainGroup:mainGroupJid,
  groups:joinedGroups.size, dms:activeDMs.size, queue:joinQueue.length,
  consecutive515, spamCooldownUntil:spamCooldownUntil?new Date(spamCooldownUntil).toISOString():null
}));
app.get('/api/status',(req,res)=>res.json({
  status:connectionStatus, botNumber,
  groups:joinedGroups.size, dms:activeDMs.size,
  queue:joinQueue.length, jobs:jobs.stats(), mainGroup:mainGroupJid
}));
app.get('/admin/qr',async (req,res)=>{
  if(!qrDataUri) return res.status(404).json({ error:'No QR' });
  const b64=qrDataUri.replace(/^data:image\/\w+;base64,/,'');
  res.writeHead(200,{ 'Content-Type':'image/png' });
  res.end(Buffer.from(b64,'base64'));
});
app.get('/admin/qr-data',(req,res)=>res.json({ qr:qrDataUri, status:connectionStatus, botNumber }));
app.post('/admin/connect',(req,res)=>{ if(!sock) connectBot(); res.json({ ok:true }); });
app.post('/admin/reconnect',async (req,res)=>{ await disconnectBot();
  setTimeout(()=>{ manualDisconnect=false; connectBot(); },1500); res.json({ ok:true }); });
app.post('/admin/disconnect',async (req,res)=>{ await disconnectBot(); res.json({ ok:true }); });
app.post('/admin/refresh-qr',(req,res)=>{ refreshQR(); res.json({ ok:true }); });
app.post('/admin/clear-session',(req,res)=>{ try{ fs.rmSync(AUTH_FOLDER,{recursive:true,force:true}); }catch(e){} res.json({ ok:true }); });
app.post('/admin/pause',(req,res)=>{ botPaused=true; res.json({ ok:true }); });
app.post('/admin/resume',(req,res)=>{ botPaused=false; res.json({ ok:true }); });

app.get('/admin/logs',(req,res)=>{
  res.writeHead(200,{ 'Content-Type':'text/event-stream', 'Cache-Control':'no-cache', 'Connection':'keep-alive' });
  for(const e of logBuffer.slice(-100)) res.write(`data: ${JSON.stringify(e)}\n\n`);
  logClients.add(res); req.on('close',()=>logClients.delete(res));
});
app.get('/admin/messages-stream',(req,res)=>{
  res.writeHead(200,{ 'Content-Type':'text/event-stream', 'Cache-Control':'no-cache', 'Connection':'keep-alive' });
  for(const m of liveMessages.slice(-100)) res.write(`data: ${JSON.stringify(m)}\n\n`);
  msgClients.add(res); req.on('close',()=>msgClients.delete(res));
});

app.get('/admin/aitest',async (req,res)=>res.json(await testRewindRaw()));
app.get('/admin/scraperstatus',async (req,res)=>res.json(await scraperStatus()));
app.get('/admin/sched',(req,res)=>res.json({ jobs:jobs.stats(), focus:focus.stats(),
  window:timeGate.describe(), dmQueue:dmQueue.length, groupBatcher:groupBatcher.stats(),
  consecutive515, spamCooldownUntil:spamCooldownUntil?new Date(spamCooldownUntil).toISOString():null }));
app.get('/admin/pending',(req,res)=>res.json({ pending:[...pendingRequests.values()] }));
app.post('/admin/pending/:id/resolve',async (req,res)=>{
  const { id }=req.params; const { action, payload }=req.body||{};
  res.json(await resolvePending(id, action||'search', payload, ADMIN_JID));
});
app.get('/admin/stats',(req,res)=>{
  const grp=[...activeChats].filter(j=>j.endsWith('@g.us')).length;
  res.json({
    status:connectionStatus, botNumber,
    uptime:Math.floor((Date.now()-botStartTime)/1000),
    dmCount:activeDMs.size, groupCount:grp, totalChats:activeChats.size,
    logCount:logBuffer.length, messageCount:liveMessages.length,
    scraperUrl:SCRAPER_URL, scraperSites:{ sfw:SCRAPER_SFW_SITE, nsfw:SCRAPER_NSFW_SITE },
    joinedGroups:joinedGroups.size, queueSize:joinQueue.length,
    dailyStats, scraperStats, adminPhone:ADMIN_PHONE, adminLids:[...adminLids],
    pendingCount:pendingRequests.size,
    jobs:jobs.stats(), focus:focus.stats(),
    window:{ time:timeGate.describe(), group:timeGate.describeGroup(),
      nsfw:timeGate.describeNsfw(), dmAI:timeGate.describeDm() },
    dmQueueLength:dmQueue.length, dmQueueMax:DM_QUEUE_MAX,
    groupBatcher:groupBatcher.stats(),
    paused:botPaused, mainGroup:mainGroupJid,
    antibanActive:!!wrapSocket, entropyRunning:!!entropyService
  });
});

const PANEL_HTML = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BreadBot v48</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:monospace;background:#0d1117;color:#c9d1d9;padding:16px}h1{font-size:20px;color:#58a6ff;margin-bottom:4px}.sub{font-size:12px;color:#8b949e;margin-bottom:16px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px}.card h2{font-size:12px;color:#8b949e;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px}button{background:#21262d;border:1px solid #30363d;color:#c9d1d9;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:13px;margin:3px;font-family:inherit}button:hover{background:#30363d;border-color:#58a6ff}button.primary{background:#238636;border-color:#2ea043;color:#fff}button.danger{background:#da3633;border-color:#f85149;color:#fff}#qrImg{width:100%;max-width:240px;border-radius:8px;margin:8px auto;display:block;background:#fff;padding:8px}.status-dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;vertical-align:middle}.s-connected{background:#3fb950;box-shadow:0 0 8px #3fb950}.s-qr{background:#d29922}.s-disconnected{background:#f85149}.s-reconnecting{background:#d29922;animation:pulse 1s infinite}.s-error{background:#f85149}@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}#logs,#msgs{height:280px;overflow-y:auto;font-size:12px;line-height:1.6;background:#0d1117;border-radius:6px;padding:8px}.log-entry{padding:3px 0;border-bottom:1px solid #21262d}.stat-row{display:flex;justify-content:space-between;padding:5px 0;font-size:13px;border-bottom:1px solid #21262d}.stat-row:last-child{border-bottom:none}.stat-val{color:#58a6ff;font-weight:600}.full-width{grid-column:1/-1}</style></head><body>
<h1>🥖 BreadBot v48</h1><div class="sub">Admin: <b id="adminPhone">—</b> · Window: <b id="windowState">—</b> · NSFW: <b id="nsfwState">—</b> · DM AI: <b id="dmState">—</b></div>
<div class="grid">
<div class="card"><h2>Connection</h2><div style="margin-bottom:10px"><span class="status-dot" id="statusDot"></span><span id="statusText">Loading...</span></div><div class="stat-row"><span>Bot</span><span class="stat-val" id="botNum">—</span></div><div class="stat-row"><span>Uptime</span><span class="stat-val" id="statUptime">—</span></div><div class="stat-row"><span>Paused</span><span class="stat-val" id="pausedState">—</span></div><div class="stat-row"><span>515 streak</span><span class="stat-val" id="c515">—</span></div><img id="qrImg" src="" style="display:none"><div style="margin-top:10px"><button class="primary" onclick="doAction('connect')">Start</button><button onclick="doAction('refresh-qr')">Refresh QR</button><button class="danger" onclick="doAction('disconnect')">Disconnect</button><button onclick="doAction('pause')">Pause</button><button onclick="doAction('resume')">Resume</button></div></div>
<div class="card"><h2>Job Queue</h2><div class="stat-row"><span>Queued</span><span class="stat-val" id="jQueued">—</span></div><div class="stat-row"><span>Max</span><span class="stat-val" id="jMax">—</span></div><div class="stat-row"><span>Done</span><span class="stat-val" id="jDone">—</span></div><div class="stat-row"><span>Failed</span><span class="stat-val" id="jFailed">—</span></div><div class="stat-row"><span>Dropped</span><span class="stat-val" id="jDropped">—</span></div></div>
<div class="card"><h2>Scope</h2><div class="stat-row"><span>Groups</span><span class="stat-val" id="statGroups">—</span></div><div class="stat-row"><span>DMs</span><span class="stat-val" id="statDMs">—</span></div><div class="stat-row"><span>Join queue</span><span class="stat-val" id="statQueue">—</span></div><div class="stat-row"><span>Pending</span><span class="stat-val" id="statPending">—</span></div><div class="stat-row"><span>DM queue</span><span class="stat-val" id="dmQ">—</span></div><div class="stat-row"><span>Main group</span><span class="stat-val" id="mainG">—</span></div></div>
<div class="card"><h2>Focus</h2><div class="stat-row"><span>Busy</span><span class="stat-val" id="focusBusy">—</span></div><div class="stat-row"><span>State</span><span class="stat-val" id="focusState">—</span></div><div class="stat-row"><span>JID</span><span class="stat-val" id="focusJid">—</span></div></div>
<div class="card"><h2>Today</h2><div class="stat-row"><span>DM replies</span><span class="stat-val" id="dayDMs">—</span></div><div class="stat-row"><span>Media</span><span class="stat-val" id="dayMedia">—</span></div><div class="stat-row"><span>NSFW</span><span class="stat-val" id="dayNsfw">—</span></div><div class="stat-row"><span>Downloads</span><span class="stat-val" id="dayDl">—</span></div><div class="stat-row"><span>Broadcasts</span><span class="stat-val" id="dayBc">—</span></div><div class="stat-row"><span>Invites</span><span class="stat-val" id="dayInv">—</span></div><div class="stat-row"><span>Greetings</span><span class="stat-val" id="dayGr">—</span></div><div class="stat-row"><span>Dropped</span><span class="stat-val" id="dayDropped">—</span></div></div>
<div class="card full-width"><h2>Live Messages</h2><div id="msgs"></div></div>
<div class="card full-width"><h2>Logs</h2><div id="logs"></div></div>
</div>
<script>
const $=id=>document.getElementById(id);
async function api(p,m='GET',body){const opts={method:m};if(body){opts.headers={'Content-Type':'application/json'};opts.body=JSON.stringify(body);}const r=await fetch('/admin/'+p,opts);return r.json();}
function fmt(s){const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),x=s%60;return h+'h '+m+'m '+x+'s';}
function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function setStatus(st){$('statusDot').className='status-dot s-'+st;const l={connected:'Connected',qr:'Waiting for scan',disconnected:'Disconnected',reconnecting:'Reconnecting',error:'Error'};$('statusText').textContent=l[st]||st;}
async function refreshStats(){try{const d=await api('stats');setStatus(d.status);
$('statUptime').textContent=fmt(d.uptime);$('botNum').textContent=d.botNumber||'—';
$('statGroups').textContent=d.joinedGroups;$('statDMs').textContent=d.dmCount;
$('statQueue').textContent=d.queueSize;$('statPending').textContent=d.pendingCount||0;
$('dmQ').textContent=(d.dmQueueLength||0)+'/'+(d.dmQueueMax||50);
$('mainG').textContent=d.mainGroup||'not set';
$('adminPhone').textContent=d.adminPhone||'—';
$('windowState').textContent=(d.window&&d.window.time)||'—';
$('nsfwState').textContent=(d.window&&d.window.nsfw)||'—';
$('dmState').textContent=(d.window&&d.window.dmAI)||'—';
$('pausedState').textContent=d.paused?'YES':'no';
$('c515').textContent=d.consecutive515||0;
const j=d.jobs||{};$('jQueued').textContent=j.queued||0;$('jMax').textContent=j.max||0;
$('jDone').textContent=j.totalRun||0;$('jFailed').textContent=j.totalFailed||0;$('jDropped').textContent=j.totalDropped||0;
const f=d.focus||{};$('focusBusy').textContent=f.busy?'YES':'no';
$('focusState').textContent=f.currentState||'idle';$('focusJid').textContent=f.currentJid||'—';
const s=d.dailyStats||{};$('dayDMs').textContent=s.dmsReplied||0;
$('dayMedia').textContent=(s.picsSent||0)+(s.videosSent||0);
$('dayNsfw').textContent=s.nsfwSent||0;$('dayDl').textContent=s.downloads||0;
$('dayBc').textContent=s.broadcastsSent||0;$('dayInv').textContent=s.invitesSent||0;
$('dayGr').textContent=s.greetingsSent||0;$('dayDropped').textContent=s.messagesDropped||0;
const q=await api('qr-data');if(q.qr&&q.status==='qr'){$('qrImg').src='/admin/qr?t='+Date.now();$('qrImg').style.display='block';}else{$('qrImg').style.display='none';}}catch(e){}}
async function doAction(a){await api(a,'POST');setTimeout(refreshStats,1000);}
function connectLogs(){const es=new EventSource('/admin/logs');es.onmessage=e=>{try{const en=JSON.parse(e.data);const div=document.createElement('div');div.className='log-entry';const t=new Date(en.ts).toLocaleTimeString();div.innerHTML='<span style="color:#484f58">'+t+'</span> <span style="color:#58a6ff">['+en.level+']</span> <span style="color:#8b949e">'+esc(en.source)+'</span> '+esc(en.message);const b=$('logs');b.appendChild(div);b.scrollTop=b.scrollHeight;while(b.children.length>300)b.removeChild(b.firstChild);}catch(e){}};es.onerror=()=>{es.close();setTimeout(connectLogs,5000);};}
function connectMsgs(){const es=new EventSource('/admin/messages-stream');es.onmessage=e=>{try{const m=JSON.parse(e.data);const div=document.createElement('div');div.style.padding='4px 8px';div.style.margin='3px 0';div.style.borderLeft='3px solid '+(m.chatType==='group'?'#a371f7':'#3fb950');div.innerHTML='<div style="color:#8b949e;font-size:11px">'+new Date(m.ts).toLocaleTimeString()+' · <span style="color:#58a6ff">'+esc(m.senderName)+'</span></div><div>'+esc(m.text)+'</div>';const b=$('msgs');b.appendChild(div);b.scrollTop=b.scrollHeight;while(b.children.length>200)b.removeChild(b.firstChild);}catch(e){}};es.onerror=()=>{es.close();setTimeout(connectMsgs,5000);};}
refreshStats();connectLogs();connectMsgs();setInterval(refreshStats,5000);
</script></body></html>`;
app.get('/',(req,res)=>res.send(PANEL_HTML));
app.get('/admin',(req,res)=>res.send(PANEL_HTML));

/* ══════════════════════════════════════════════════════════════
 *  PERIODIC TASKS
 * ══════════════════════════════════════════════════════════════ */
setInterval(async ()=>{
  if(connectionStatus==='connected' && sock && !botPaused && !timeGate.isOffline()){
    try{ await sock.sendPresenceUpdate('available'); }catch(e){}
  }
},240000);
setInterval(()=>{ axios.get(`http://localhost:${PORT}/health`).catch(()=>{}); },240000);
setInterval(processJoinQueue,30000);
setInterval(()=>{
  const now=Date.now();
  for(const [k,v] of downloadPicks){ if(now-v.ts>DOWNLOAD_PICK_TTL) downloadPicks.delete(k); }
},60000);

/* ══════════════════════════════════════════════════════════════
 *  BOOT
 * ══════════════════════════════════════════════════════════════ */
loadState();
loadAdminLids();
loadGroupSettings();
loadLearningData();
loadMainGroup();

app.listen(PORT, ()=>{
  console.log(`🌐 Port ${PORT}`);
  console.log(`👤 Admin phone: ${ADMIN_PHONE}`);
  console.log(`🔑 Admin LIDs: ${[...adminLids].join(', ')||'none'}`);
  console.log(`⭐ Main group: ${mainGroupJid||'not set'}`);
  console.log(`🕐 ${timeGate.describe()} · DM AI: ${timeGate.describeDm()} · NSFW: ${timeGate.describeNsfw()}`);
  console.log(`⚙️ Job queue max: ${JOB_MAX}`);
  console.log(`🔎 Scraper: ${SCRAPER_URL} (SFW=${SCRAPER_SFW_SITE} / NSFW=${SCRAPER_NSFW_SITE})`);
  pushLog('info','system',`Boot port ${PORT}`);
  pushLog('info','system',`Admin phone: ${ADMIN_PHONE}`);
  pushLog('info','system',`Main group: ${mainGroupJid||'not set'}`);
  pushLog('info','system',`Jobs max: ${JOB_MAX}`);
  pushLog('info','system',`Scraper SFW=${SCRAPER_SFW_SITE} NSFW=${SCRAPER_NSFW_SITE}`);
  scheduleGreetings();
  scheduleDailyReport();
  scheduleGroupBatchProcessor();
  connectBot().catch(err=>{ pushLog('error','system',`Boot: ${err.message}`); });
});

process.on('SIGINT',async ()=>{
  pushLog('warn','system','shutting down...');
  try{ if(sock) sock.end(undefined); }catch(e){}
  process.exit(0);
});
process.on('SIGTERM',async ()=>{
  pushLog('warn','system','shutting down...');
  try{ if(sock) sock.end(undefined); }catch(e){}
  process.exit(0);
});
process.on('uncaughtException',(e)=>pushLog('error','uncaught',e.message));
process.on('unhandledRejection',(e)=>pushLog('error','unhandled',String(e)));
