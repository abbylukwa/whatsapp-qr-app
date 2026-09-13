'use strict';

/* ============================================================
 *  BreadBot v50 — Full & Fixed
 *  - 34 MB enforced on EVERY media (scraper images/GIFs included)
 *  - Fast lane (admin) + Slow lane (everyone else)
 *  - Serial per lane, one task at a time
 *  - Fixes ReferenceError: getDisconnectStatusCode
 *  - DM queue max 1000
 *  - Anti-spam 515 reconnect preserved
 *  - Music search + download
 *  - NSFW role-play & NSFW video API hooks
 *  - !offline / !online / !limit / !pause admin controls
 *  - Main-group-only welcome & goodbye
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
const MAIN_GROUP_FILE        = path.join(__dirname,'main_group_jid.json');
const ADMIN_GROUP_LINK       = 'https://chat.whatsapp.com/HGW3IdVbDJyImOgp1BFqT7?s=sw&p=a&mlu=4&ilr=4';

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
const DM_QUEUE_MAX       = 1000;
const FOCUS_LOCK_TIMEOUT_MS = 30000;
const TZ_OFFSET_HOURS    = parseInt(process.env.TZ_OFFSET_HOURS || '2', 10);
const MEDIA_MAX_BYTES    = 34 * 1024 * 1024;   // 34 MB — enforced everywhere

/* Flood — mutable so !limit can change */
let MESSAGE_FLOOD_THRESHOLD = 20;
let FLOOD_IGNORE_MS         = 5000;

/* Time windows */
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

/* Lanes */
const FAST_LANE_GAP_MIN_MS = 150;
const FAST_LANE_GAP_MAX_MS = 600;
const SLOW_LANE_GAP_MIN_MS = 800;
const SLOW_LANE_GAP_MAX_MS = 15000;
const FAST_LANE_MAX = 5000;
const SLOW_LANE_MAX = 5000;

/* Download */
const DOWNLOAD_PICK_TTL  = 10 * 60 * 1000;
const DOWNLOAD_MAX_PICKS = 8;

/* Runtime flags */
let botPaused = false;
let botOfflineUntil = 0;
let nsfwRoleplayEnabled = true;

/* ══════════════════════════════════════════════════════════════
 *  FIX — getDisconnectStatusCode (function declaration, hoisted)
 *  This must exist BEFORE connectBot is called.
 * ══════════════════════════════════════════════════════════════ */
function getDisconnectStatusCode(lastDisconnect) {
  if (!lastDisconnect) return undefined;
  if (lastDisconnect.error?.output?.statusCode) return lastDisconnect.error.output.statusCode;
  if (lastDisconnect.error?.output?.payload?.statusCode) return lastDisconnect.error.output.payload.statusCode;
  if (lastDisconnect.error?.statusCode) return lastDisconnect.error.statusCode;
  if (lastDisconnect.statusCode) return lastDisconnect.statusCode;
  return undefined;
}

/* ══════════════════════════════════════════════════════════════
 *  LOGGER
 * ══════════════════════════════════════════════════════════════ */
const LOG_BUFFER_MAX = 500, logBuffer=[], logClients=new Set();
const LIVE_MSG_MAX   = 200, liveMessages=[], msgClients=new Set();

function pushLog(level, source, message, meta={}){
  const entry = { id:Date.now()+Math.random(), ts:new Date().toISOString(),
    level, source, message, meta:Object.keys(meta).length?meta:undefined };
  logBuffer.push(entry); if (logBuffer.length>LOG_BUFFER_MAX) logBuffer.shift();
  const payload = `data: ${JSON.stringify(entry)}\n\n`;
  for (const res of logClients) { try{res.write(payload);}catch(e){logClients.delete(res);} }
  console.log(`${new Date().toTimeString().slice(0,8)}[${level.toUpperCase()}] ${source}: ${message}`);
}
function pushLiveMessage(entry){
  liveMessages.push(entry); if (liveMessages.length>LIVE_MSG_MAX) liveMessages.shift();
  const payload = `data: ${JSON.stringify(entry)}\n\n`;
  for (const res of msgClients) { try{res.write(payload);}catch(e){msgClients.delete(res);} }
}

/* ══════════════════════════════════════════════════════════════
 *  TIME GATE
 * ══════════════════════════════════════════════════════════════ */
function localHour() { return (new Date().getUTCHours() + TZ_OFFSET_HOURS) % 24; }
function isNsfwWindow() { const h=localHour(); return h>=NSFW_START || h<NSFW_END; }
function isDmAiWindow() {
  const h = localHour();
  if (DM_AI_START_HOUR <= DM_AI_END_HOUR) return h >= DM_AI_START_HOUR && h < DM_AI_END_HOUR;
  return h >= DM_AI_START_HOUR || h < DM_AI_END_HOUR;
}
function describeWindow() { return `${String(localHour()).padStart(2,'0')}:xx`; }
function describeNsfw() { return isNsfwWindow() ? 'ALLOWED (21:00-08:00)' : 'BLOCKED (08:00-21:00)'; }
function describeDm()   { return isDmAiWindow()  ? 'ON (21:00-08:00)'    : 'OFF (08:00-21:00)'; }

/* ══════════════════════════════════════════════════════════════
 *  STATE
 * ══════════════════════════════════════════════════════════════ */
let sock=null, entropyService=null, healthMonitor=null, qrDataUri=null;
let connectionStatus='disconnected', botStartTime=Date.now(), botNumber=null, botJid=null;
let isConnecting=false, manualDisconnect=false;
let reconnectAttempts=0; const MAX_RECONNECT=10;

/* Anti-spam 515 */
let restart515InFlight=false, lastReconnectAt=0;
let consecutive515=0, recent515Timestamps=[], spamCooldownUntil=0;
const RESTART_515_BASE_DELAY_MS=1500, RESTART_515_MAX_DELAY_MS=30000;
const MIN_RECONNECT_INTERVAL_MS=10000, SPAM_WINDOW_MS=60000;
const SPAM_THRESHOLD=3, SPAM_COOLDOWN_MS=60000;

/* Main group */
let mainGroupJid=null;

/* Sets & maps */
const botSentIds       = new Set();
const processedMessages= new Set();
const activeChats      = new Set();
const activeDMs        = new Set();
const userHistories    = new Map();
const pendingRequests  = new Map();
const joinedGroups     = new Map();
const lastGreetingAt   = new Map();
const learningData     = new Map();
const adminLids        = new Set(HARDCODED_ADMIN_LIDS);
const recentAdminCmds  = new Map();
const downloadPicks    = new Map();

let joinQueue=[], joinInProgress=false, lastJoinAt=0;
let dmQueue=[], dmQueueProcessing=false;

/* Daily stats */
let dailyStats=null, lastDailyReportDate=null;
function resetDailyStats(){
  const today = new Date().toISOString().slice(0,10);
  if (lastDailyReportDate !== today){
    dailyStats = { date:today, joined:0, failed:0, dmsReplied:0, broadcastsSent:0, greetingsSent:0,
      scraperSearches:0, scraperGifs:0, picsSent:0, videosSent:0, nsfwSent:0, aiErrors:0,
      pendingCreated:0, pendingResolved:0, discovered:0, imageBroadcasts:0, badMacs:0,
      focusRuns:0, downloads:0, nsfwDownloads:0, adminBroadcasts:0, groupLinksShared:0,
      messagesDropped:0, errors:0, invitesSent:0 };
  }
}
resetDailyStats();

/* ══════════════════════════════════════════════════════════════
 *  DUAL QUEUE  — fast lane (admin) + slow lane (everyone else)
 *  One task at a time PER lane
 * ══════════════════════════════════════════════════════════════ */
class DualQueue {
  constructor(){
    this.fast=[]; this.slow=[];
    this.fastRunning=false; this.slowRunning=false;
    this.fastRun=0; this.fastFail=0; this.fastDrop=0;
    this.slowRun=0; this.slowFail=0; this.slowDrop=0;
  }
  pushFast(job){
    if (this.fast.length >= FAST_LANE_MAX){
      this.fast.shift(); this.fastDrop++;
      pushLog('warn','jobs',`Fast lane full — dropped oldest`);
    }
    job.ts = Date.now();
    this.fast.push(job);
    this._pumpFast();
  }
  pushSlow(job){
    if (this.slow.length >= SLOW_LANE_MAX){
      // drop oldest low priority (high number = low priority)
      this.slow.sort((a,b)=>b.priority-a.priority || a.ts-b.ts);
      this.slow.pop(); this.slowDrop++;
      pushLog('warn','jobs',`Slow lane full — dropped oldest low-prio`);
    }
    job.ts = Date.now();
    this.slow.push(job);
    this.slow.sort((a,b)=>a.priority-b.priority || a.ts-b.ts);
    this._pumpSlow();
  }
  async _pumpFast(){
    if (this.fastRunning) return;
    this.fastRunning = true;
    while (this.fast.length){
      const job = this.fast.shift();
      try { await job.fn(); this.fastRun++; }
      catch(e){ this.fastFail++; pushLog('error','fastlane',`${job.name}: ${e.message}`); }
      const gap = FAST_LANE_GAP_MIN_MS + Math.random()*(FAST_LANE_GAP_MAX_MS-FAST_LANE_GAP_MIN_MS);
      await new Promise(r=>setTimeout(r,gap));
    }
    this.fastRunning = false;
  }
  async _pumpSlow(){
    if (this.slowRunning) return;
    this.slowRunning = true;
    while (this.slow.length){
      const job = this.slow.shift();
      // unpredictability — occasionally inject a distraction
      if (this.slow.length > 1 && Math.random() < 0.05){
        const idx = this.slow.findIndex(j => j.priority >= 2);
        if (idx >= 0){
          const d = this.slow.splice(idx,1)[0];
          try { await d.fn(); this.slowRun++; } catch(e) { this.slowFail++; }
          await new Promise(r=>setTimeout(r,200+Math.random()*600));
        }
      }
      try { await job.fn(); this.slowRun++; }
      catch(e){ this.slowFail++; pushLog('error','slowlane',`${job.name}: ${e.message}`); }
      const base = SLOW_LANE_GAP_MIN_MS + Math.random()*(SLOW_LANE_GAP_MAX_MS-SLOW_LANE_GAP_MIN_MS);
      const speed = Math.max(0.3, isNsfwWindow()?1:0.7);
      await new Promise(r=>setTimeout(r, Math.floor(base*speed)));
    }
    this.slowRunning = false;
  }
  stats(){
    return {
      fast:{ queued:this.fast.length, running:this.fastRunning?1:0,
             done:this.fastRun, failed:this.fastFail, dropped:this.fastDrop, max:FAST_LANE_MAX },
      slow:{ queued:this.slow.length, running:this.slowRunning?1:0,
             done:this.slowRun, failed:this.slowFail, dropped:this.slowDrop, max:SLOW_LANE_MAX },
      total:{ done:this.fastRun+this.slowRun, failed:this.fastFail+this.slowFail,
              dropped:this.fastDrop+this.slowDrop }
    };
  }
}
const jobs = new DualQueue();

/* ══════════════════════════════════════════════════════════════
 *  FOCUS PIPELINE (DM pacing)
 * ══════════════════════════════════════════════════════════════ */
class FocusPipeline {
  constructor(){ this.busy=false; this.currentJid=null; this.currentState='idle'; }
  async run(jid, taskFn){
    let attempts=0;
    while (this.busy){
      if (++attempts > FOCUS_LOCK_TIMEOUT_MS/500) throw new Error('Focus lock timeout');
      await new Promise(r=>setTimeout(r,500));
    }
    this.busy=true; this.currentJid=jid;
    try {
      this.currentState='thinking';
      await new Promise(r=>setTimeout(r, 1500+Math.random()*3000));
      this.currentState='typing';
      return await taskFn();
    } finally {
      this.busy=false; this.currentJid=null; this.currentState='idle';
    }
  }
  stats(){ return { busy:this.busy, currentJid:this.currentJid, currentState:this.currentState }; }
}
const focus = new FocusPipeline();

/* ══════════════════════════════════════════════════════════════
 *  HELPERS — extraction, IDs, filters
 * ══════════════════════════════════════════════════════════════ */
function markBotSent(id){
  if (!id) return;
  botSentIds.add(id);
  if (botSentIds.size > 5000){
    const a=[...botSentIds]; botSentIds.clear();
    for (const i of a.slice(-2500)) botSentIds.add(i);
  }
}
function extractAllPhoneCandidates(msg, senderJid){
  const s=new Set();
  const c=[msg.key?.participantPn, msg.key?.senderPn, msg.key?.remoteJidAlt,
    msg.key?.participantAlt, senderJid, msg.key?.remoteJid, msg.key?.participant].filter(Boolean);
  for (const x of c){
    if (typeof x==='string'){
      const d = x.split('@')[0].split(':')[0].replace(/\D/g,'');
      if (d.length>=10) s.add(d);
    }
  }
  return [...s];
}
function extractLidFromMsg(msg, senderJid){
  const c=[senderJid, msg.key?.remoteJid, msg.key?.participant].filter(Boolean);
  for (const x of c) if (typeof x==='string' && x.includes('@lid')) return x.split('@')[0];
  return null;
}
function isAdminSender(msg, senderJid){
  const c = extractAllPhoneCandidates(msg, senderJid);
  if (c.includes(ADMIN_PHONE)){
    const l = extractLidFromMsg(msg, senderJid);
    if (l && !adminLids.has(l)){ adminLids.add(l); saveAdminLids(); }
    return true;
  }
  for (const x of c) if (adminLids.has(x)) return true;
  const l = extractLidFromMsg(msg, senderJid);
  if (l && adminLids.has(l)) return true;
  if (typeof senderJid==='string'){
    const b = senderJid.split('@')[0].split(':')[0];
    if (adminLids.has(b) || b===ADMIN_PHONE) return true;
  }
  return false;
}
function extractPhone(msg, senderJid){
  const c = extractAllPhoneCandidates(msg, senderJid); return c[0] || null;
}
function extractLid(msg, senderJid){ return extractLidFromMsg(msg, senderJid); }

const FORBIDDEN = [
  /\bas an ai\b/i, /\bi am an ai\b/i, /\blanguage model\b/i, /\bas an assistant\b/i,
  /\bi cannot\b/i, /how can i help you today/i, /is there anything else/i,
  /let me know if/i, /feel free to/i, /i hope this helps/i,
  /thank you for reaching out/i, /\bapi[_ ]?key\b/i, /```/
];
function containsForbidden(t){ if (!t) return true; return FORBIDDEN.some(r=>r.test(t)); }
function humanize(t){
  if (!t) return '';
  let s = t.replace(/```[\s\S]*?```/g,'').replace(/https?:\/\/\S+/g,'').trim();
  s = s.split('\n').map(l=>l.trim()).filter(Boolean).join(' ');
  s = s.replace(/^(assistant|ai|bot)[:\-]\s*/i,'').replace(/\s{2,}/g,' ').trim();
  return s;
}
function informalize(t){
  if (!t) return t;
  if (Math.random()<0.4) t = t.charAt(0).toLowerCase()+t.slice(1);
  if (Math.random()<0.05) t += ' ' + ['😊','😅','👀','🙂','😂'][Math.floor(Math.random()*5)];
  return t;
}

const SHONA_MARKERS = ['ndi','uri','kuti','here','izvi','zvakanaka','sei','ndoda','unoda',
  'mhoro','mangwanani','masikati','manheru','ndapota','zvinhu','vanhu','kuita','kuenda','kuuya'];
const LANG_NAMES = { sn:'Shona', en:'English' };
function detectLanguage(t){
  if (!t) return 'en';
  return t.toLowerCase().split(/\s+/).filter(w=>SHONA_MARKERS.includes(w)).length>0 ? 'sn' : 'en';
}

/* ══════════════════════════════════════════════════════════════
 *  AI
 * ══════════════════════════════════════════════════════════════ */
async function askAI(prompt, system){
  if (!AI_KEY) return null;
  try {
    const r = await axios.post(AI_ENDPOINT, {
      model:AI_MODEL,
      messages:[
        { role:'system', content: system },
        { role:'user',   content: prompt }
      ],
      max_tokens: 250, temperature: 0.9
    }, {
      headers:{ 'Authorization': `Bearer ${AI_KEY}`, 'Content-Type': 'application/json' },
      timeout: 25000
    });
    const raw = r.data?.choices?.[0]?.message?.content;
    if (!raw) return null;
    const c = humanize(raw);
    return (c && !containsForbidden(c)) ? c : null;
  } catch(e){
    pushLog('error','ai',`${e.response?.status||''} ${e.message}`);
    resetDailyStats(); dailyStats.aiErrors++;
    return null;
  }
}
async function testAIRaw(){
  if (!AI_KEY) return { ok:false, error:'AI_KEY missing' };
  const t0 = Date.now();
  try {
    const r = await axios.post(AI_ENDPOINT, {
      model:AI_MODEL,
      messages:[
        { role:'system', content:'You are a helpful assistant.' },
        { role:'user',   content:'Reply with exactly: AI WORKS' }
      ],
      max_tokens:20
    }, {
      headers:{ 'Authorization': `Bearer ${AI_KEY}`, 'Content-Type':'application/json' },
      timeout:20000
    });
    return { ok:true, ms:Date.now()-t0, status:r.status, raw:r.data?.choices?.[0]?.message?.content };
  } catch(e){ return { ok:false, ms:Date.now()-t0, status:e.response?.status, error:e.message }; }
}

/* ══════════════════════════════════════════════════════════════
 *  34 MB ENFORCEMENT — download → check → send
 *  This is the ONLY way images/GIFs are sent so 34 MB is guaranteed.
 * ══════════════════════════════════════════════════════════════ */
async function downloadAndCheck(url, maxBytes = MEDIA_MAX_BYTES, expectType = 'image'){
  const resp = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 60000,
    maxContentLength: maxBytes + 1,
    maxBodyLength: maxBytes + 1,
    validateStatus: s => s >= 200 && s < 300,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BreadBot/1.0)' }
  });
  const buf = Buffer.from(resp.data);
  if (buf.length > maxBytes){
    throw new Error(`Media too big (${(buf.length/1024/1024).toFixed(1)}MB > ${(maxBytes/1024/1024).toFixed(0)}MB)`);
  }
  if (buf.length < 32) throw new Error('Media file is empty');
  const mimetype = resp.headers['content-type'] || (expectType === 'gif' ? 'video/mp4' : 'image/jpeg');
  return { buffer: buf, mimetype, sizeBytes: buf.length };
}

/* Send image via buffer (34 MB enforced) */
async function sendImageSafe(jid, url, caption='', priority=2, lane='slow'){
  try {
    const { buffer, mimetype } = await downloadAndCheck(url, MEDIA_MAX_BYTES, 'image');
    await sendBuffer(jid, { image: buffer, caption, mimetype }, priority, lane);
    return true;
  } catch(e){
    pushLog('warn','media',`image skip: ${e.message}`);
    // fallback: try sending as text URL
    try { await sendBuffer(jid, { text: `${caption}\n${url}`.trim() }, priority, lane); } catch(_){}
    return false;
  }
}

/* Send GIF via buffer (34 MB enforced) */
async function sendGifSafe(jid, url, caption='', priority=2, lane='slow'){
  try {
    const { buffer, mimetype } = await downloadAndCheck(url, MEDIA_MAX_BYTES, 'gif');
    await sendBuffer(jid, { video: buffer, gifPlayback: true, caption, mimetype: 'video/mp4' }, priority, lane);
    return true;
  } catch(e){
    pushLog('warn','media',`gif skip: ${e.message}`);
    try { await sendBuffer(jid, { text: `${caption}\n${url}`.trim() }, priority, lane); } catch(_){}
    return false;
  }
}

/* ══════════════════════════════════════════════════════════════
 *  LANE-AWARE SEND
 * ══════════════════════════════════════════════════════════════ */
function sendBuffer(jid, content, priority=2, lane='auto'){
  // lane 'auto' → admin = fast, everyone else = slow
  const actualLane = lane === 'auto' ? (priority === 0 ? 'fast' : 'slow') : lane;
  return new Promise((resolve, reject)=>{
    const job = {
      name:`send:${jid}`,
      priority,
      fn: async ()=>{
        if (!sock){ reject(new Error('Bot disconnected')); return; }
        if (botPaused && priority > 0){ reject(new Error('Bot paused')); return; }
        if (Date.now() < botOfflineUntil && priority > 0){ reject(new Error('Bot offline')); return; }
        try {
          const sent = await sock.sendMessage(jid, content);
          if (sent?.key?.id) markBotSent(sent.key.id);
          resolve(sent);
        } catch(e){ reject(e); }
      }
    };
    if (actualLane === 'fast') jobs.pushFast(job);
    else jobs.pushSlow(job);
  });
}

/* Convenience: admin reply (fast lane, always fires) */
function adminReply(jid, text, quoted){
  return sendBuffer(jid, { text }, 0, 'fast')
    .catch(e => pushLog('warn','adminreply',e.message));
}

/* ══════════════════════════════════════════════════════════════
 *  SCRAPER  (SFW + NSFW, size-checked)
 * ══════════════════════════════════════════════════════════════ */
async function scraperSearch(query, nsfw=false){
  const site = nsfw ? SCRAPER_NSFW_SITE : SCRAPER_SFW_SITE;
  resetDailyStats(); dailyStats.scraperSearches++;
  try {
    const r = await axios.post(`${SCRAPER_URL}/search`, { query, site }, { timeout: 30000 });
    return { ok:true, images: r.data?.images || [], site };
  } catch(e){
    pushLog('error','scraper',`${nsfw?'NSFW':'SFW'} "${query}": ${e.message}`);
    return { ok:false, error:e.message, images:[], site };
  }
}
async function scraperGif(query, nsfw=false){
  const site = nsfw ? SCRAPER_NSFW_SITE : SCRAPER_SFW_SITE;
  resetDailyStats(); dailyStats.scraperGifs++;
  try {
    const r = await axios.get(`${SCRAPER_URL}/gif`, { params:{ q:query, site }, timeout:30000 });
    return { ok:true, gifs: r.data?.gifs || [], site };
  } catch(e){
    pushLog('error','scraper',`GIF "${query}": ${e.message}`);
    return { ok:false, error:e.message, gifs:[], site };
  }
}
async function scraperStatus(){
  try { const r = await axios.get(`${SCRAPER_URL}/status`, { timeout:10000 });
    return { ok:true, data:r.data }; }
  catch(e){ return { ok:false, error:e.message }; }
}

/* ══════════════════════════════════════════════════════════════
 *  YOUTUBE + Y2MATE  (34 MB enforced)
 * ══════════════════════════════════════════════════════════════ */
const YT_HEADERS = {
  'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
};
const Y2MATE_HEADERS = {
  'User-Agent': YT_HEADERS['User-Agent'],
  'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8',
  'X-Requested-With':'XMLHttpRequest',
  'Origin':'https://www.y2mate.com',
  'Referer':'https://www.y2mate.com/'
};

async function ytSearch(query, max=6){
  try {
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=EgIQAQ%253D%253D`;
    const r = await axios.get(url, { headers:YT_HEADERS, timeout:20000 });
    const html = r.data || '';
    const results = [];
    const re = /"videoRenderer":\{"videoId":"([^"]+)".*?"title":\{"runs":\[\{"text":"([^"]+)"/g;
    let m;
    while ((m = re.exec(html)) !== null && results.length < max){
      const vid = m[1];
      const title = m[2].replace(/\\u([\da-f]{4})/gi,(_,c)=>String.fromCharCode(parseInt(c,16)));
      if (!results.find(x=>x.id===vid)) results.push({ id:vid, title });
    }
    if (results.length === 0){
      const re2 = /"videoId":"([^"]+)","thumbnail".*?"title":\{"runs":\[\{"text":"([^"]+)"/g;
      let m2;
      while ((m2 = re2.exec(html)) !== null && results.length < max){
        const vid = m2[1];
        const title = m2[2].replace(/\\u([\da-f]{4})/gi,(_,c)=>String.fromCharCode(parseInt(c,16)));
        if (!results.find(x=>x.id===vid)) results.push({ id:vid, title });
      }
    }
    return results;
  } catch(e){
    pushLog('error','yt',`search: ${e.message}`);
    return [];
  }
}

async function y2mateResolve(videoId, prefer='360p'){
  const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const analyze = await axios.post(
    'https://www.y2mate.com/mates/en948/analyze/ajax',
    new URLSearchParams({ url: ytUrl, q_auto:'0', ajax:'1' }).toString(),
    { headers: Y2MATE_HEADERS, timeout:30000 }
  );
  const html = analyze.data?.result || '';
  const vId = (html.match(/v_id["']?\s*[:=]\s*["']([^"']+)/)||[])[1];
  const id  = (html.match(/_id["']?\s*[:=]\s*["']([^"']+)/)||[])[1];
  if (!vId || !id) throw new Error('y2mate: video not found');

  const qualities = ['360p','480p','720p'];
  const start = Math.max(0, qualities.indexOf(prefer));
  let lastErr=null;
  for (const q of qualities.slice(start)){
    try {
      const conv = await axios.post(
        'https://www.y2mate.com/mates/convert',
        new URLSearchParams({ type:'video', _id:id, v_id:vId, ajax:'1', token:'', ftype:'mp4', fquality:q }).toString(),
        { headers: Y2MATE_HEADERS, timeout:30000 }
      );
      const ch = conv.data?.result || '';
      const dl = (ch.match(/href="(https?:\/\/[^"]+\.mp4[^"]*)"/)||[])[1]
              || (ch.match(/href="(https?:\/\/[^"]+)"/)||[])[1];
      if (dl) return { url: dl, quality: q };
    } catch(e){ lastErr = e; }
  }
  throw new Error(`y2mate: no download (${lastErr?.message||'unknown'})`);
}

async function y2mateDownload(videoId, prefer='360p'){
  const { url, quality } = await y2mateResolve(videoId, prefer);
  const id = Date.now()+'_'+Math.random().toString(36).slice(2,8);
  const fp = path.join(DOWNLOAD_DIR, `${id}.mp4`);
  const resp = await axios.get(url, {
    responseType: 'stream', timeout: 180000, maxContentLength: MEDIA_MAX_BYTES,
    headers: { 'User-Agent': YT_HEADERS['User-Agent'], 'Referer':'https://www.y2mate.com/' }
  });
  const w = fs.createWriteStream(fp);
  resp.data.pipe(w);
  await new Promise((res,rej)=>{ w.on('finish',res); w.on('error',rej); resp.data.on('error',rej); });
  const st = fs.statSync(fp);
  if (st.size > MEDIA_MAX_BYTES){
    try{ fs.unlinkSync(fp); }catch(e){}
    throw new Error(`Video too big (${(st.size/1024/1024).toFixed(1)}MB > 34MB)`);
  }
  return { filePath:fp, quality, sizeBytes:st.size };
}

async function y2mateDownloadMusic(videoId, format='mp3'){
  const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const analyze = await axios.post(
    'https://www.y2mate.com/mates/en948/analyze/ajax',
    new URLSearchParams({ url: ytUrl, q_auto:'0', ajax:'1' }).toString(),
    { headers: Y2MATE_HEADERS, timeout:30000 }
  );
  const html = analyze.data?.result || '';
  const vId = (html.match(/v_id["']?\s*[:=]\s*["']([^"']+)/)||[])[1];
  const id  = (html.match(/_id["']?\s*[:=]\s*["']([^"']+)/)||[])[1];
  if (!vId || !id) throw new Error('y2mate: audio not found');

  const ftype = format === 'mp3' ? 'mp3' : 'mp4';
  const conv = await axios.post(
    'https://www.y2mate.com/mates/convert',
    new URLSearchParams({ type:'audio', _id:id, v_id:vId, ajax:'1', token:'', ftype, fquality:'128' }).toString(),
    { headers: Y2MATE_HEADERS, timeout:30000 }
  );
  const ch = conv.data?.result || '';
  const dl = (ch.match(/href="(https?:\/\/[^"]+\.(mp3|mp4|m4a)[^"]*)"/)||[])[1]
          || (ch.match(/href="(https?:\/\/[^"]+)"/)||[])[1];
  if (!dl) throw new Error('y2mate: no music download link');

  const fileId = Date.now()+'_'+Math.random().toString(36).slice(2,8);
  const ext = format === 'mp3' ? '.mp3' : '.mp4';
  const fp = path.join(DOWNLOAD_DIR, `${fileId}${ext}`);
  const resp = await axios.get(dl, {
    responseType: 'stream', timeout: 180000, maxContentLength: MEDIA_MAX_BYTES,
    headers: { 'User-Agent': YT_HEADERS['User-Agent'], 'Referer':'https://www.y2mate.com/' }
  });
  const w = fs.createWriteStream(fp);
  resp.data.pipe(w);
  await new Promise((res,rej)=>{ w.on('finish',res); w.on('error',rej); resp.data.on('error',rej); });
  const st = fs.statSync(fp);
  if (st.size > MEDIA_MAX_BYTES){
    try{ fs.unlinkSync(fp); }catch(e){}
    throw new Error(`File too big (${(st.size/1024/1024).toFixed(1)}MB > 34MB)`);
  }
  return { filePath:fp, format, sizeBytes:st.size };
}

/* Send a video/audio file from disk — 34 MB enforced */
async function sendMediaFile(jid, filePath, caption='', priority=2, lane='slow'){
  try {
    const buf = fs.readFileSync(filePath);
    if (buf.length > MEDIA_MAX_BYTES){
      try{ fs.unlinkSync(filePath); }catch(e){}
      throw new Error(`File ${(buf.length/1024/1024).toFixed(1)}MB exceeds 34MB`);
    }
    const ext = path.extname(filePath).toLowerCase();
    const isAudio = ext === '.mp3' || ext === '.m4a';
    const content = isAudio
      ? { audio: buf, mimetype: 'audio/mpeg', caption }
      : { video: buf, mimetype: 'video/mp4', caption };
    await sendBuffer(jid, content, priority, lane);
    try{ fs.unlinkSync(filePath); }catch(e){}
    return true;
  } catch(e){
    try{ fs.unlinkSync(filePath); }catch(_){}
    throw e;
  }
}

/* ══════════════════════════════════════════════════════════════
 *  NSFW ROLE-PLAY
 * ══════════════════════════════════════════════════════════════ */
async function nsfwRoleplay(userName, text){
  const sys = `You are Abby Faith Sithole, a real Zimbabwean girl, 23. The user wants NSFW roleplay. Be flirty and seductive, 1-2 sentences. Use casual Shona/English. If you feel uncomfortable, stay silent. Never mention AI.`;
  const prompt = `User ${userName} says: "${text}". Reply as Abby.`;
  const aiReply = await askAI(prompt, sys);
  if (aiReply && !containsForbidden(aiReply)) return informalize(aiReply);
  return null;
}

/* ══════════════════════════════════════════════════════════════
 *  INTENT DETECTION
 * ══════════════════════════════════════════════════════════════ */
const VAGUE = ['', 'something','anything','nice','good','stuff','it','them','some','please','pls','now','me','one'];
function isVague(q){ return !q || VAGUE.includes(q.toLowerCase().trim()); }

function detectMediaIntent(text){
  const low = (text||'').toLowerCase().trim();
  if (!low) return null;
  if (/\b(gif|gifs)\b/i.test(low)){
    let q = low.replace(/^.*?\b(gif|gifs)\b\s*(of|ya|ye|za)?\s*/i,'').trim();
    return { type:'gif', query: q||'funny' };
  }
  if (/\b(video|videos|vid|vids|vidyo|mavhidhiyo)\b/i.test(low)){
    let q = low.replace(/^.*?\b(video|videos|vid|vids|vidyo|mavhidhiyo)\b\s*(of|ya|ye|za)?\s*/i,'').trim();
    return { type:'video', query: q||'funny' };
  }
  if (/\b(song|songs|album|albums|music|track|tracks|mixtape)\b/i.test(low)){
    let q = low.replace(/^(please\s+|pls\s+|hey\s+|hi\s+|yo\s+)?(can\s+you\s+)?(send|share|give|show|drop|post|download|get)\s+(me\s+)?(a\s+|some\s+|any\s+)?/i,'');
    q = q.replace(/\b(song|songs|album|albums|music|track|tracks|mixtape)\b/gi,'');
    q = q.replace(/\b(of|by|from|for)\b/gi,'');
    q = q.replace(/[?.!,]+/g,' ').replace(/\s+/g,' ').trim();
    return { type:'music', query: q || 'top hits' };
  }
  if (/\b(pic|pics|picture|pictures|image|images|photo|photos|mapic|mapics|mufananidzo|mifananidzo)\b/i.test(low)){
    let q = low.replace(/^(please\s+|pls\s+|hey\s+|hi\s+|yo\s+)?(can\s+you\s+)?(send|share|give|show|drop|post|ndipe|ndipoo|nditumire|ndiratidze|ndoda)\s+(me\s+)?(a\s+|some\s+|any\s+)?/i,'');
    q = q.replace(/\b(pic|pics|picture|pictures|image|images|photo|photos|mapic|mapics|mufananidzo|mifananidzo)\b/gi,'');
    q = q.replace(/\b(of|ya|ye|za|for|about|ndiye|wa)\b/gi,'');
    q = q.replace(/[?.!,]+/g,' ').replace(/\s+/g,' ').trim();
    return { type:'image', query: q || 'naija' };
  }
  return null;
}

function detectDownloadIntent(text){
  if (!text) return null;
  const low = text.toLowerCase();
  if (/\b(download|dl|save|grab|fetch)\b/.test(low) && /\b(youtube|video|vid|song|music)\b/.test(low)){
    const q = low.replace(/^(please\s+|pls\s+|hey\s+|hi\s+)?(can\s+you\s+)?(download|dl|save|grab|fetch)\s+(me\s+)?(a\s+|the\s+)?/i,'')
      .replace(/\b(youtube|video|vid|song|music)\b/gi,'')
      .replace(/\b(of|from|for|by)\b/gi,'')
      .replace(/[?.!,]+/g,' ').replace(/\s+/g,' ').trim();
    return { query: q };
  }
  return null;
}

function detectNsfw(text){
  if (!text) return false;
  const low = text.toLowerCase();
  return /\b(nsfw|porn|porno|sex|sexy|nude|nudes|xxx|adult|18\+|booty|ass|titties|boobs)\b/.test(low);
}

function detectGroupLinkRequest(text){
  if (!text) return false;
  return /group\s*link|grouplink|join\s*link|link\s*(ye|re)\s*group|link rekujoina/i.test(text);
}

/* Direct address */
const BOT_NAMES = ['bread','breadbot','abby','abby faith','sithole'];
function isReplyToBot(msg){
  const c = msg.message?.extendedTextMessage?.contextInfo
         || msg.message?.imageMessage?.contextInfo
         || msg.message?.videoMessage?.contextInfo;
  if (!c?.stanzaId) return false;
  return botSentIds.has(c.stanzaId);
}
function isMentioningBot(msg){
  const c = msg.message?.extendedTextMessage?.contextInfo
         || msg.message?.imageMessage?.contextInfo
         || msg.message?.videoMessage?.contextInfo;
  const mentions = c?.mentionedJid || [];
  if (!mentions.length || !botJid) return false;
  const botNum = botJid.split('@')[0].split(':')[0];
  return mentions.some(j => j.split('@')[0].split(':')[0] === botNum);
}
function containsBotName(text){
  if (!text) return false;
  const low = text.toLowerCase();
  return BOT_NAMES.some(n => new RegExp(`\\b${n}\\b`,'i').test(low));
}
function isDirectedAtBot(msg, text){
  return isReplyToBot(msg) || isMentioningBot(msg) || containsBotName(text);
}

/* ══════════════════════════════════════════════════════════════
 *  PERSISTENCE
 * ══════════════════════════════════════════════════════════════ */
function saveAdminLids(){
  try { fs.writeFileSync(ADMIN_LID_FILE, JSON.stringify([...adminLids],null,2)); } catch(e){}
}
let groupSettings = new Map();
function loadGroupSettings(){
  try {
    if (fs.existsSync(GROUP_SETTINGS_FILE))
      groupSettings = new Map(Object.entries(JSON.parse(fs.readFileSync(GROUP_SETTINGS_FILE,'utf8'))));
  } catch(e){}
}
let groupSettingsDirty=false;
function saveGroupSettingsDebounced(){
  if (groupSettingsDirty) return;
  groupSettingsDirty = true;
  setTimeout(()=>{
    try { fs.writeFileSync(GROUP_SETTINGS_FILE,
      JSON.stringify(Object.fromEntries(groupSettings),null,2)); } catch(e){}
    groupSettingsDirty = false;
  }, 5000);
}
function getGroupSetting(jid){
  if (!groupSettings.has(jid)){
    groupSettings.set(jid, { antilink:true, welcome:true, goodbye:true,
      welcomeMsg:'Welcome {user}! 👋', goodbyeMsg:'{user} left. 👋' });
    saveGroupSettingsDebounced();
  }
  return groupSettings.get(jid);
}

let learningDirty=false;
function saveLearningDebounced(){
  if (learningDirty) return;
  learningDirty = true;
  setTimeout(()=>{
    try { fs.writeFileSync(LEARNING_DATA_FILE,
      JSON.stringify(Object.fromEntries(learningData),null,2)); } catch(e){}
    learningDirty = false;
  }, 10000);
}
function loadLearningData(){
  try {
    if (fs.existsSync(LEARNING_DATA_FILE))
      learningData.clear(),
      Object.entries(JSON.parse(fs.readFileSync(LEARNING_DATA_FILE,'utf8'))).forEach(([k,v])=>learningData.set(k,v));
  } catch(e){}
}
function recordGroupMessage(jid, text){
  if (!text) return;
  if (!learningData.has(jid)) learningData.set(jid,{ messages:[], wordCounts:{}, firstSeen:Date.now() });
  const d = learningData.get(jid);
  d.messages.push({ text, ts:Date.now() });
  if (d.messages.length > 400) d.messages.shift();
  for (const w of text.toLowerCase().split(/\s+/)){
    const c = w.replace(/[^a-z0-9]/g,'');
    if (c.length > 3) d.wordCounts[c] = (d.wordCounts[c]||0)+1;
  }
  saveLearningDebounced();
}
function analyzeGroup(jid){
  const d = learningData.get(jid);
  if (!d || d.messages.length < 40) return null;
  const top = Object.entries(d.wordCounts).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([w])=>w);
  return { topWords: top };
}

function saveQueue(){ try { fs.writeFileSync(JOIN_QUEUE_FILE, JSON.stringify(joinQueue,null,2)); } catch(e){} }
function saveGroups(){
  try {
    const a = [...joinedGroups.entries()].map(([jid,v])=>({ jid, name:v.name, joinedAt:v.joinedAt,
      discovered:v.discovered||false, lastGreetedAt:lastGreetingAt.get(jid)||null }));
    fs.writeFileSync(JOINED_GROUPS_FILE, JSON.stringify(a,null,2));
  } catch(e){}
}
function savePending(){
  try { fs.writeFileSync(PENDING_FILE, JSON.stringify([...pendingRequests.values()],null,2)); } catch(e){}
}
function loadState(){
  try { if (fs.existsSync(JOIN_QUEUE_FILE)) joinQueue = JSON.parse(fs.readFileSync(JOIN_QUEUE_FILE,'utf8')) || []; }
  catch(e){ joinQueue = []; }
  try {
    if (fs.existsSync(JOINED_GROUPS_FILE)){
      const a = JSON.parse(fs.readFileSync(JOINED_GROUPS_FILE,'utf8')) || [];
      for (const g of a){
        joinedGroups.set(g.jid, { name:g.name, joinedAt:g.joinedAt, discovered:g.discovered||false });
        if (g.lastGreetedAt) lastGreetingAt.set(g.jid, g.lastGreetedAt);
      }
    }
  } catch(e){}
  try {
    if (fs.existsSync(PENDING_FILE)){
      const a = JSON.parse(fs.readFileSync(PENDING_FILE,'utf8')) || [];
      const now = Date.now();
      for (const p of a) if (now-p.requestedAt < PENDING_EXPIRY_MS) pendingRequests.set(p.id, p);
    }
  } catch(e){}
  try { if (fs.existsSync(ADMIN_LID_FILE)){
    const a = JSON.parse(fs.readFileSync(ADMIN_LID_FILE,'utf8')) || [];
    for (const l of a) adminLids.add(l);
  } } catch(e){}
  try { if (fs.existsSync(MAIN_GROUP_FILE)){
    mainGroupJid = fs.readFileSync(MAIN_GROUP_FILE,'utf8').trim() || null;
  } } catch(e){}
  pushLog('info','state',`queue=${joinQueue.length} groups=${joinedGroups.size} pending=${pendingRequests.size} adminLids=${adminLids.size} main=${mainGroupJid||'—'}`);
}
function setMainGroup(jid){
  mainGroupJid = jid;
  try { fs.writeFileSync(MAIN_GROUP_FILE, jid); } catch(e){}
  pushLog('success','main',`Main group set: ${jid}`);
}

/* ══════════════════════════════════════════════════════════════
 *  WELCOME / GOODBYE (main group only, AI-generated)
 * ══════════════════════════════════════════════════════════════ */
async function generateWelcome(userName){
  const ai = await askAI(
    `Write a warm, short WhatsApp welcome for a new member named "${userName}". Max 12 words. Include one emoji.`,
    `You are Abby Faith Sithole, warm Zimbabwean. Casual, real. Mix Shona + English naturally. Never mention AI.`
  );
  if (ai && !containsForbidden(ai)) return informalize(ai);
  return `Welcome ${userName}! 🎉 Tiri kufara kuva newe.`;
}
async function generateGoodbye(userName){
  const ai = await askAI(
    `Write a short goodbye for a member named "${userName}" leaving a WhatsApp group. Max 10 words.`,
    `You are Abby Faith Sithole, warm Zimbabwean. Casual tone.`
  );
  if (ai && !containsForbidden(ai)) return informalize(ai);
  return `${userName} left. 👋`;
}
async function handleParticipants(update){
  const { id, participants, action } = update;
  if (!mainGroupJid || id !== mainGroupJid) return;
  for (const p of participants){
    const user = p.split('@')[0];
    if (action === 'add'){
      try {
        const msg = await generateWelcome(user);
        await sendBuffer(id, { text: msg, mentions:[p] }, 0, 'fast');
        pushLog('success','welcome',`Welcomed ${user}`);
      } catch(e){ pushLog('warn','welcome',e.message); }
    }
    if (action === 'remove'){
      try {
        const msg = await generateGoodbye(user);
        await sendBuffer(id, { text: msg }, 0, 'fast');
      } catch(e){ pushLog('warn','goodbye',e.message); }
    }
  }
}

/* Anti-link */
async function handleAntiLink(jid, msg, text, senderJid, isAdmin){
  const s = getGroupSetting(jid);
  if (!s.antilink || isAdmin) return false;
  const matches = text.match(/(https?:\/\/[^\s]+)/gi);
  if (!matches || !matches.length) return false;
  try { await sock.sendMessage(jid, { delete: msg.key }); } catch(e){}
  pushLog('info','antilink',`Deleted from ${senderJid}`);
  try {
    await sendBuffer(jid, { text: `⚠️ Links not allowed, @${senderJid.split('@')[0]}`, mentions:[senderJid] }, 0, 'fast');
  } catch(e){}
  return true;
}

/* Invite-link auto-join */
function extractInviteCodes(text){
  if (!text) return [];
  const s=new Set();
  const re = /chat\.whatsapp\.com\/([A-Za-z0-9]{15,30})/gi;
  let m; while ((m = re.exec(text)) !== null) s.add(m[1]);
  return [...s];
}
function queueJoin(code, addedBy='unknown', source='dm'){
  if (!code || joinQueue.some(q=>q.code===code)) return false;
  joinQueue.push({ code, addedAt:Date.now(), addedBy, source });
  saveQueue(); pushLog('info','join',`Queued ${code}`); return true;
}
async function processJoinQueue(){
  if (joinInProgress || !sock || connectionStatus!=='connected' || !joinQueue.length) return;
  if (Date.now()-lastJoinAt < JOIN_INTERVAL_MS) return;
  joinInProgress = true;
  const item = joinQueue.shift(); saveQueue(); resetDailyStats();
  try {
    pushLog('info','join',`Joining ${item.code}...`);
    const res = await sock.groupAcceptInvite(item.code);
    lastJoinAt = Date.now();
    if (res){
      joinedGroups.set(res, { name:null, joinedAt:Date.now(), discovered:false });
      lastGreetingAt.set(res, Date.now()); saveGroups();
      dailyStats.joined++;
      pushLog('success','join',`✅ Joined ${res}`);
    }
  } catch(e){
    dailyStats.failed++;
    pushLog('error','join',`Failed: ${e.message}`);
  } finally {
    joinInProgress = false;
    setTimeout(processJoinQueue, JOIN_INTERVAL_MS);
  }
}

function discoverGroup(jid){
  if (!jid || !jid.endsWith('@g.us')) return false;
  if (joinedGroups.has(jid)) return false;
  joinedGroups.set(jid, { name:null, joinedAt:Date.now(), discovered:true });
  lastGreetingAt.set(jid, Date.now());
  saveGroups(); resetDailyStats(); dailyStats.discovered++;
  pushLog('success','group',`Discovered ${jid}`);
  return true;
}

/* Pending requests */
function createPendingRequest(userJid, userName, userPhone, history, intent){
  const id = Math.random().toString(36).slice(2,8);
  pendingRequests.set(id, { id, userJid, userName, userPhone,
    userHistory: history.slice(-USER_HISTORY_SIZE), requestedAt:Date.now(), intent });
  savePending(); resetDailyStats(); dailyStats.pendingCreated++;
  return id;
}
async function resolvePending(id, action, payload, adminChatJid){
  const p = pendingRequests.get(id);
  if (!p) return { ok:false, error:`No pending ${id}` };
  try {
    if (action === 'skip'){
      await sendBuffer(p.userJid, { text: 'sorry, couldn\'t find that 😅' }, 2, 'slow');
      pendingRequests.delete(id); savePending(); resetDailyStats(); dailyStats.pendingResolved++;
      adminReply(adminChatJid, `✅ Replied casually to ${p.userName}.`);
      return { ok:true };
    }
    if (action === 'say'){
      await sendBuffer(p.userJid, { text: payload }, 2, 'slow');
      pendingRequests.delete(id); savePending(); resetDailyStats(); dailyStats.pendingResolved++;
      adminReply(adminChatJid, `✅ Sent to ${p.userName}.`);
      return { ok:true };
    }
    const query = payload || p.intent.query;
    if (p.intent.type === 'video' || p.intent.type === 'gif'){
      const r = await scraperGif(query);
      if (!r.ok || !r.gifs.length){ adminReply(adminChatJid, '❌ No results.'); return { ok:false }; }
      await sendGifSafe(p.userJid, r.gifs[0], '', 2, 'slow');
    } else {
      const r = await scraperSearch(query);
      if (!r.ok || !r.images.length){ adminReply(adminChatJid, '❌ No results.'); return { ok:false }; }
      await sendImageSafe(p.userJid, r.images[0], '', 2, 'slow');
    }
    pendingRequests.delete(id); savePending(); resetDailyStats(); dailyStats.pendingResolved++;
    adminReply(adminChatJid, `✅ Sent to ${p.userName}.`);
    return { ok:true };
  } catch(e){ adminReply(adminChatJid, `❌ ${e.message}`); return { ok:false, error:e.message }; }
}

/* ══════════════════════════════════════════════════════════════
 *  DOWNLOAD FLOW — search → numbered list → pick / mass
 * ══════════════════════════════════════════════════════════════ */
async function startDownloadSearch(chatJid, query, msg, priority=1, lane='slow'){
  const results = await ytSearch(query, 6);
  if (!results.length){
    await sendBuffer(chatJid, { text: `Couldn't find "${query}" 😕` }, priority, lane);
    return;
  }
  downloadPicks.set(chatJid, { query, results, ts:Date.now() });
  const list = results.map((r,i)=>`${i+1}. ${r.title}`).join('\n');
  await sendBuffer(chatJid, {
    text: `Found ${results.length} for *${query}*:\n\n${list}\n\nReply with a number (1-${results.length}) or "1,2,3" for multiple.`
  }, priority, lane);
}
async function handleDownloadPick(chatJid, text, msg, priority=1, lane='slow'){
  const entry = downloadPicks.get(chatJid);
  if (!entry) return false;
  if (Date.now() - entry.ts > DOWNLOAD_PICK_TTL){ downloadPicks.delete(chatJid); return false; }
  const nums = (text.match(/\d+/g)||[]).map(n=>parseInt(n,10)).filter(n=>n>=1 && n<=entry.results.length);
  if (!nums.length) return false;
  const picks = [...new Set(nums)].slice(0, DOWNLOAD_MAX_PICKS);
  downloadPicks.delete(chatJid);
  await sendBuffer(chatJid, { text: `⏳ Downloading ${picks.length} video(s)...` }, priority, lane);
  for (const n of picks){
    const r = entry.results[n-1];
    if (!r) continue;
    try {
      await sendBuffer(chatJid, { text: `▶️ ${r.title}` }, priority, lane);
      const { filePath, quality, sizeBytes } = await y2mateDownload(r.id, '360p');
      await sendMediaFile(chatJid, filePath, `${r.title}\n(${quality}, ${(sizeBytes/1024/1024).toFixed(1)}MB)`, priority, lane);
      resetDailyStats(); dailyStats.downloads++;
      pushLog('success','download',`${r.title} (${quality})`);
    } catch(e){
      await sendBuffer(chatJid, { text: `❌ ${r.title}: ${e.message}` }, priority, lane);
      pushLog('error','download',e.message);
    }
  }
  return true;
}

/* ══════════════════════════════════════════════════════════════
 *  ADMIN COMMANDS
 * ══════════════════════════════════════════════════════════════ */
const COMMAND_LIST = `🥖 *BreadBot v50 — Admin Commands*

*BASICS*
!help — this list
!ping — alive check
!status — full status
!test / !testall / !aitest
!scraperstatus
!whoami — your IDs
!jobs — both lanes' stats
!stats / !summary
!logs / !errors
!count
!groups / !inbox / !dms

*MAIN GROUP*
!setmain — mark this group as main
!main — show current main
!invite — AI invite + broadcast
!mylink — send admin group link

*MESSAGING*
!broadcast <msg> — all groups
!bcgroup <msg> — alias
!bcdm <msg> — all DMs
!all <msg> — groups + DMs
!send <jid> <msg> — one group
!grouplink <link>

*GROUP MANAGEMENT*
!antilink on|off
!welcome on|off
!goodbye on|off
!setwelcome <msg>
!setgoodbye <msg>
!promote / !demote / !kick @user
!tagall
!mute / !unmute
!lock / !unlock

*MEDIA*
!pic <query> — search images
!nextpic
!bcastpic <cap> — broadcast image
!gif <query>
!nextgif
!bcastgif <cap>
!allimg <url> | <cap>
!scrapersearch <q> / !scrapergif <q>

*DOWNLOADS & MUSIC*
!dl <query> — search YouTube → numbered list → pick
!download <url> — direct video
!music <query> — search & download mp3
!nsfw <url> — NSFW video
!nsfw on|off
!nsfwroleplay on|off
!cleanup — wipe downloads

*CONTROL*
!pause / !resume
!offline <mins> — bot sleeps
!online — wake up
!limit <n> — set flood limit
!unlimit
!jobs — lane stats

*Every file limited to 34 MB.*`;

function logRepeatedCmd(cmd, chatJid){
  const now = Date.now();
  const key = `${chatJid}:${cmd}`;
  if (now - (recentAdminCmds.get(key)||0) < 30000) pushLog('warn','admin',`Repeated: ${cmd}`);
  recentAdminCmds.set(key, now);
}

async function handleAdminCommand(text, chatJid, msg){
  const args = text.slice(1).trim().split(/\s+/);
  const cmd  = args[0].toLowerCase();
  const reply = (t)=>adminReply(chatJid, t, msg);
  logRepeatedCmd(cmd, chatJid);

  switch(cmd){
    case 'commands': case 'help': await reply(COMMAND_LIST); break;
    case 'ping':
      await reply(`🏓 Pong!\nStatus: *${connectionStatus}*\nUptime: *${Math.floor((Date.now()-botStartTime)/1000)}s*`);
      break;
    case 'pause': botPaused = true; await reply('⏸️ Paused.'); break;
    case 'resume': botPaused = false; await reply('▶️ Resumed.'); break;
    case 'offline': {
      const mins = parseInt(args[1],10) || 30;
      botOfflineUntil = Date.now() + mins*60000;
      await reply(`💤 Offline for ${mins} min.`);
      break;
    }
    case 'online': botOfflineUntil = 0; await reply('🟢 Back online.'); break;
    case 'limit': {
      const n = parseInt(args[1],10) || 20;
      MESSAGE_FLOOD_THRESHOLD = n;
      await reply(`📊 Flood limit = ${n}/s.`);
      break;
    }
    case 'unlimit': {
      MESSAGE_FLOOD_THRESHOLD = 9999;
      await reply('📊 Flood limit removed.');
      break;
    }
    case 'jobs': {
      const s = jobs.stats();
      await reply(`⚙️ *Fast lane*\nqueued: *${s.fast.queued}/${s.fast.max}*\ndone: *${s.fast.done}* · fail: *${s.fast.failed}*\n\n⚙️ *Slow lane*\nqueued: *${s.slow.queued}/${s.slow.max}*\ndone: *${s.slow.done}* · fail: *${s.slow.failed}*`);
      break;
    }
    case 'status': case 'diag': {
      const s = jobs.stats(); const f = focus.stats();
      resetDailyStats(); const st = dailyStats;
      await reply([
        `📊 *Status*`, `Connection: *${connectionStatus}*`, `Bot: *${botNumber||'—'}*`,
        `Uptime: *${Math.floor((Date.now()-botStartTime)/1000)}s*`,
        `Time: *${describeWindow()}*`, `NSFW: *${describeNsfw()}*`, `DM AI: *${describeDm()}*`,
        `Paused: *${botPaused}*`, `Offline: *${botOfflineUntil>Date.now()?'yes':'no'}*`,
        ``, `👥 Groups: *${joinedGroups.size}* · 💬 DMs: *${activeDMs.size}*`,
        `⭐ Main: *${mainGroupJid||'not set'}*`, `📋 Queue: *${joinQueue.length}*`,
        `⚙️ Fast: *${s.fast.queued}* · Slow: *${s.slow.queued}*`,
        `🎯 Focus: *${f.currentState}*`,
        ``, `📈 *Today*`, `DM: *${st.dmsReplied}*`, `Media: *${st.picsSent+st.videosSent}*`,
        `NSFW: *${st.nsfwSent}*`, `Downloads: *${st.downloads}*`,
        `Broadcasts: *${st.broadcastsSent}*`, `Dropped: *${st.messagesDropped}*`
      ].join('\n'));
      break;
    }
    case 'count': {
      await reply(`Groups: *${joinedGroups.size}*\nDMs: *${activeDMs.size}*\nJoin queue: *${joinQueue.length}*\nPending: *${pendingRequests.size}*\nMain: *${mainGroupJid||'not set'}*`);
      break;
    }
    case 'groups': {
      if (!joinedGroups.size){ await reply('No groups.'); return; }
      const list = [...joinedGroups.entries()].map(([j],i)=>`${i+1}. ${j===mainGroupJid?'⭐ ':''}${j}`).join('\n');
      await reply(`👥 *Groups (${joinedGroups.size})*\n${list}`);
      break;
    }
    case 'inbox': case 'dms': {
      if (!activeDMs.size){ await reply('No DMs.'); return; }
      const list = [...activeDMs].map((j,i)=>`${i+1}. ${j.split('@')[0]}`).join('\n');
      await reply(`💬 *DMs (${activeDMs.size})*\n${list}`);
      break;
    }
    case 'setmain': {
      if (!chatJid.endsWith('@g.us')){ await reply('Run this in the group.'); return; }
      setMainGroup(chatJid);
      await reply('✅ Main group set. Welcomes only here.');
      break;
    }
    case 'main': await reply(`⭐ Main: *${mainGroupJid||'not set'}*`); break;
    case 'mylink':
      await adminReply(chatJid, `🔗 Join my group:\n${ADMIN_GROUP_LINK}`);
      break;
    case 'send': {
      const t = args[1]; const body = args.slice(2).join(' ').trim();
      if (!t || !body){ await reply('❌ Usage: `!send <jid> <msg>`'); return; }
      if (!joinedGroups.has(t)){ await reply(`❌ Not in ${t}`); return; }
      await sendBuffer(t, { text: body }, 0, 'fast');
      await reply(`✅ Sent to ${t}`);
      break;
    }
    case 'broadcast': case 'bcgroup': {
      const m = args.slice(1).join(' ');
      if (!m){ await reply(`❌ Usage: \`!${cmd} <msg>\``); return; }
      await reply(`⏳ Broadcasting to ${joinedGroups.size} groups...`);
      let sent=0;
      for (const jid of joinedGroups.keys()){
        try { await sendBuffer(jid, { text:m }, 3, 'slow'); sent++; } catch(e){}
      }
      resetDailyStats(); dailyStats.broadcastsSent += sent;
      await reply(`✅ Queued ${sent}/${joinedGroups.size}`);
      break;
    }
    case 'all': case 'bcdm': {
      const m = args.slice(1).join(' ');
      if (!m){ await reply(`❌ Usage: \`!${cmd} <msg>\``); return; }
      const mode = cmd === 'all' ? 'all' : 'dms';
      const targets = mode === 'all'
        ? [...joinedGroups.keys(), ...activeDMs]
        : [...activeDMs];
      if (!targets.length){ await reply('📭 No targets.'); return; }
      await reply(`⏳ Queued to ${targets.length}...`);
      for (const jid of targets){
        try { await sendBuffer(jid, { text:m }, 3, 'slow'); } catch(e){}
      }
      resetDailyStats(); dailyStats.broadcastsSent += targets.length;
      await reply(`✅ Done.`);
      break;
    }
    case 'pic': case 'search': {
      const q = args.slice(1).join(' ');
      if (!q){ await reply('❌ Usage: `!pic <query>`'); return; }
      const r = await scraperSearch(q, false);
      if (!r.ok || !r.images.length){ await reply('❌ No results'); return; }
      previewCache.imageUrls = r.images; previewCache.imageIndex = 0;
      previewCache.currentType = 'image'; previewCache.currentUrl = r.images[0];
      await sendImageSafe(chatJid, r.images[0], `Preview 1/${r.images.length}\n!nextpic · !bcastpic <caption>`, 0, 'fast');
      break;
    }
    case 'nextpic': {
      if (!previewCache.imageUrls.length){ await reply('No preview.'); return; }
      previewCache.imageIndex = (previewCache.imageIndex+1) % previewCache.imageUrls.length;
      previewCache.currentUrl = previewCache.imageUrls[previewCache.imageIndex];
      await sendImageSafe(chatJid, previewCache.currentUrl,
        `Preview ${previewCache.imageIndex+1}/${previewCache.imageUrls.length}`, 0, 'fast');
      break;
    }
    case 'gif': {
      const q = args.slice(1).join(' ');
      if (!q){ await reply('❌ Usage: `!gif <query>`'); return; }
      const r = await scraperGif(q, false);
      if (!r.ok || !r.gifs.length){ await reply('❌ No results'); return; }
      previewCache.gifUrls = r.gifs; previewCache.gifIndex = 0;
      previewCache.currentType = 'gif'; previewCache.currentUrl = r.gifs[0];
      await sendGifSafe(chatJid, r.gifs[0],
        `GIF 1/${r.gifs.length}\n!nextgif · !bcastgif <caption>`, 0, 'fast');
      break;
    }
    case 'nextgif': {
      if (!previewCache.gifUrls.length){ await reply('No preview.'); return; }
      previewCache.gifIndex = (previewCache.gifIndex+1) % previewCache.gifUrls.length;
      previewCache.currentUrl = previewCache.gifUrls[previewCache.gifIndex];
      await sendGifSafe(chatJid, previewCache.currentUrl,
        `GIF ${previewCache.gifIndex+1}/${previewCache.gifUrls.length}`, 0, 'fast');
      break;
    }
    case 'bcastpic': case 'bcastpicdm': case 'bcastpicgroup': {
      if (!previewCache.currentUrl || previewCache.currentType !== 'image'){
        await reply('No image preview.'); return;
      }
      const cap = args.slice(1).join(' ') || '';
      const mode = cmd === 'bcastpic' ? 'all' : cmd === 'bcastpicdm' ? 'dms' : 'groups';
      const targets = mode === 'all'
        ? [...joinedGroups.keys(), ...activeDMs]
        : mode === 'groups' ? [...joinedGroups.keys()] : [...activeDMs];
      if (!targets.length){ await reply(`No ${mode}.`); return; }
      await reply(`⏳ Queued to ${targets.length}...`);
      for (const jid of targets){ await sendImageSafe(jid, previewCache.currentUrl, cap, 3, 'slow'); }
      await reply('✅ Done.');
      break;
    }
    case 'bcastgif': {
      if (!previewCache.currentUrl || previewCache.currentType !== 'gif'){ await reply('No GIF preview.'); return; }
      const cap = args.slice(1).join(' ') || '';
      const targets = [...joinedGroups.keys(), ...activeDMs];
      if (!targets.length){ await reply('No targets.'); return; }
      for (const jid of targets){ await sendGifSafe(jid, previewCache.currentUrl, cap, 3, 'slow'); }
      await reply('✅ Done.');
      break;
    }
    case 'allimg': {
      const parts = args.slice(1).join(' ').split('|').map(s=>s.trim());
      const url = parts[0]; const cap = parts[1] || '';
      if (!url){ await reply('❌ Usage: `!allimg <url> | <cap>`'); return; }
      const targets = [...joinedGroups.keys(), ...activeDMs];
      for (const jid of targets){ await sendImageSafe(jid, url, cap, 3, 'slow'); }
      await reply('✅ Done.');
      break;
    }
    case 'ad': {
      const parts = args.slice(1).join(' ').split('|').map(p=>p.trim());
      const [title, body, cta, link, style] = parts;
      if (!title || !body){ await reply('❌ Usage: `!ad <title>|<body>|[cta]|[link]|[style]`'); return; }
      const ad = AdBuilder.build({ title, body, cta, link, footer:'Reply STOP to opt out', style: style||'fancy' });
      await reply(`📢 *Preview:*\n\n${ad}`);
      replyCache.set('LAST_AD', ad);
      break;
    }
    case 'bcad': {
      const ad = replyCache.get('LAST_AD');
      if (!ad){ await reply('No ad built.'); return; }
      const targets = [...joinedGroups.keys(), ...activeDMs];
      for (const jid of targets){ await sendBuffer(jid, { text:ad }, 3, 'slow'); }
      await reply('✅ Done.');
      break;
    }
    case 'antilink': { const on = args[1]==='on'; getGroupSetting(chatJid).antilink = on; saveGroupSettingsDebounced(); await reply(`✅ Anti-link ${on?'ON':'OFF'}`); break; }
    case 'welcome':  { const on = args[1]==='on'; getGroupSetting(chatJid).welcome  = on; saveGroupSettingsDebounced(); await reply(`✅ Welcome ${on?'ON':'OFF'}`); break; }
    case 'goodbye':  { const on = args[1]==='on'; getGroupSetting(chatJid).goodbye  = on; saveGroupSettingsDebounced(); await reply(`✅ Goodbye ${on?'ON':'OFF'}`); break; }
    case 'setwelcome': { const t = args.slice(1).join(' '); if (!t){ await reply('❌ Provide text.'); return; } getGroupSetting(chatJid).welcomeMsg = t; saveGroupSettingsDebounced(); await reply('✅ Set.'); break; }
    case 'setgoodbye': { const t = args.slice(1).join(' '); if (!t){ await reply('❌ Provide text.'); return; } getGroupSetting(chatJid).goodbyeMsg = t; saveGroupSettingsDebounced(); await reply('✅ Set.'); break; }
    case 'promote': case 'demote': case 'kick': {
      const t = msg.message?.extendedTextMessage?.contextInfo?.participant
              || (args[1] ? args[1].replace(/\D/g,'')+'@s.whatsapp.net' : null);
      if (!t){ await reply('❌ Reply or give phone.'); return; }
      const act = cmd === 'promote' ? 'promote' : cmd === 'demote' ? 'demote' : 'remove';
      try { await sock.groupParticipantsUpdate(chatJid, [t], act); await reply(`✅ ${cmd} done.`); }
      catch(e){ await reply(`❌ ${e.message}`); }
      break;
    }
    case 'tagall': {
      try {
        const meta = await sock.groupMetadata(chatJid);
        const mentions = meta.participants.map(p=>p.id);
        const list = mentions.map(j=>`@${j.split('@')[0]}`).join(' ');
        await sendBuffer(chatJid, { text: `📢 *Attention:*\n\n${list}`, mentions }, 0, 'fast');
      } catch(e){ await reply(`❌ ${e.message}`); }
      break;
    }
    case 'mute':   { try { await sock.groupSettingUpdate(chatJid,'announcement'); await reply('🔇'); } catch(e){ await reply(`❌ ${e.message}`); } break; }
    case 'unmute': { try { await sock.groupSettingUpdate(chatJid,'not_announcement'); await reply('🔊'); } catch(e){ await reply(`❌ ${e.message}`); } break; }
    case 'lock':   { try { await sock.groupSettingUpdate(chatJid,'locked'); await reply('🔒'); } catch(e){ await reply(`❌ ${e.message}`); } break; }
    case 'unlock': { try { await sock.groupSettingUpdate(chatJid,'unlocked'); await reply('🔓'); } catch(e){ await reply(`❌ ${e.message}`); } break; }
    case 'dl': {
      const q = args.slice(1).join(' ').trim();
      if (!q){ await reply('❌ Usage: `!dl <song or video>`'); return; }
      await startDownloadSearch(chatJid, q, msg, 0, 'fast');
      break;
    }
    case 'download': {
      const url = args[1];
      if (!url){ await reply('❌ Usage: `!download <youtube-url>`'); return; }
      await reply('⏳ Resolving...');
      try {
        const vid = (url.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/)||[])[1];
        if (!vid){ await reply('❌ Cannot parse video ID.'); return; }
        const { filePath, quality, sizeBytes } = await y2mateDownload(vid, '360p');
        await sendMediaFile(chatJid, filePath, `(${quality}, ${(sizeBytes/1024/1024).toFixed(1)}MB)`, 0, 'fast');
        resetDailyStats(); dailyStats.downloads++;
        await reply('✅ Sent.');
      } catch(e){ await reply(`❌ ${e.message}`); }
      break;
    }
    case 'music': {
      const q = args.slice(1).join(' ').trim();
      if (!q){ await reply('❌ Usage: `!music <song>`'); return; }
      await reply(`🎵 Searching "${q}"...`);
      try {
        const results = await ytSearch(q + ' audio', 3);
        if (!results.length){ await reply('❌ No results.'); return; }
        const top = results[0];
        await reply(`🎧 *${top.title}* — downloading...`);
        const { filePath, sizeBytes } = await y2mateDownloadMusic(top.id, 'mp3');
        await sendMediaFile(chatJid, filePath, `🎵 ${top.title}\n(${(sizeBytes/1024/1024).toFixed(1)}MB)`, 0, 'fast');
        resetDailyStats(); dailyStats.downloads++;
        await reply('✅ Sent.');
      } catch(e){ await reply(`❌ ${e.message}`); }
      break;
    }
    case 'nsfw': {
      if (args[1] === 'on'){ await reply('🔞 NSFW on.'); break; }
      if (args[1] === 'off'){ await reply('🔞 NSFW off.'); break; }
      const url = args[1];
      if (!url){ await reply('❌ Usage: `!nsfw <youtube-url>`'); return; }
      try {
        const vid = (url.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/)||[])[1];
        if (!vid){ await reply('❌ Bad URL.'); return; }
        const { filePath, quality, sizeBytes } = await y2mateDownload(vid, '720p');
        await sendMediaFile(chatJid, filePath, `NSFW (${quality}, ${(sizeBytes/1024/1024).toFixed(1)}MB)`, 0, 'fast');
        resetDailyStats(); dailyStats.nsfwDownloads++;
        await reply('✅ Sent.');
      } catch(e){ await reply(`❌ ${e.message}`); }
      break;
    }
    case 'nsfwroleplay': {
      if (args[1] === 'on'){ nsfwRoleplayEnabled = true; await reply('🔞 Roleplay ON.'); break; }
      if (args[1] === 'off'){ nsfwRoleplayEnabled = false; await reply('🔞 Roleplay OFF.'); break; }
      await reply('❌ Usage: `!nsfwroleplay on|off`');
      break;
    }
    case 'cleanup': {
      try {
        const files = fs.readdirSync(DOWNLOAD_DIR);
        for (const f of files){ try{ fs.unlinkSync(path.join(DOWNLOAD_DIR,f)); }catch(e){} }
        await reply(`🧹 Cleared ${files.length} files.`);
      } catch(e){ await reply(`❌ ${e.message}`); }
      break;
    }
    case 'logs': {
      const recent = logBuffer.slice(-30).map(e=>`[${e.level}] ${e.source}: ${e.message}`).join('\n');
      await reply(`📜 *Logs (30)*\n\n${recent.slice(0,3500)}`);
      break;
    }
    case 'errors': {
      const errs = logBuffer.filter(e=>e.level==='error').slice(-20).map(e=>`[${e.source}] ${e.message}`).join('\n');
      await reply(`❌ *Errors*\n\n${errs.slice(0,3500)||'none'}`);
      break;
    }
    case 'pending': {
      if (!pendingRequests.size){ await reply('None.'); return; }
      const list = [...pendingRequests.values()].slice(0,20).map(p=>`• *${p.id}* — ${p.userName} — ${p.intent.type}: "${p.intent.query}"`).join('\n');
      await reply(`⏳ *Pending*\n${list}`);
      break;
    }
    case 'teach': {
      const id = args[1]; const rest = args.slice(2).join(' ').trim();
      if (!id || !rest){ await reply('❌ Usage: `!teach <id> <q|say|skip>`'); return; }
      if (rest === 'skip') await resolvePending(id, 'skip', null, chatJid);
      else if (rest.startsWith('say ')) await resolvePending(id, 'say', rest.slice(4).trim(), chatJid);
      else await resolvePending(id, 'search', rest, chatJid);
      break;
    }
    case 'scrapersearch': case 'scrapergif': {
      const q = args.slice(1).join(' ');
      if (!q){ await reply('❌ Give a query.'); return; }
      const r = cmd === 'scrapersearch' ? await scraperSearch(q) : await scraperGif(q);
      if (!r.ok){ await reply(`❌ ${r.error}`); return; }
      const items = r.images || r.gifs || [];
      await reply(`✅ ${items.length} results\nFirst: ${items[0]||'none'}`);
      break;
    }
    case 'scraperstatus': {
      const st = await scraperStatus();
      await reply(st.ok ? `✅ Scraper up (${st.data?.status||'ok'})` : `❌ ${st.error}`);
      break;
    }
    case 'aitest': {
      const r = await testAIRaw();
      await reply(r.ok ? `✅ AI works (${r.ms}ms)` : `❌ ${r.status||''} ${r.error}`);
      break;
    }
    case 'test': {
      const s = jobs.stats();
      await reply(`✅ Bot: *${botNumber}*\nStatus: *${connectionStatus}*\nFast: *${s.fast.queued}*\nSlow: *${s.slow.queued}*`);
      break;
    }
    case 'testall': {
      await reply('🧪 Running tests...');
      const tests = [];
      const s1 = await scraperSearch('test'); tests.push(`Scraper search: ${s1.ok?`✅ ${s1.images.length}`:'❌ '+s1.error}`);
      const s2 = await scraperGif('funny'); tests.push(`Scraper gif: ${s2.ok?`✅ ${s2.gifs.length}`:'❌ '+s2.error}`);
      const rw = await testAIRaw(); tests.push(`AI: ${rw.ok?`✅ ${rw.ms}ms`:`❌ ${rw.error}`}`);
      const st = await scraperStatus(); tests.push(`Scraper: ${st.ok?'✅':'❌'}`);
      tests.push(`WA: ${connectionStatus==='connected'?'✅':'❌'}`);
      tests.push(`Main: ${mainGroupJid?'✅':'❌'}`);
      tests.push(`Groups: ${joinedGroups.size} · DMs: ${activeDMs.size}`);
      await reply(['🧪 *Tests*','',...tests].join('\n'));
      break;
    }
    case 'stats': case 'summary': {
      resetDailyStats(); const s = dailyStats;
      await reply(`📊 *Today*\nJoined: *${s.joined}*\nDM: *${s.dmsReplied}*\nMedia: *${s.picsSent+s.videosSent}*\nNSFW: *${s.nsfwSent}*\nDownloads: *${s.downloads}*\nBroadcasts: *${s.broadcastsSent}*\nGreetings: *${s.greetingsSent}*`);
      break;
    }
    case 'whoami': {
      const c = extractAllPhoneCandidates(msg, chatJid);
      const l = extractLid(msg, chatJid);
      const a = isAdminSender(msg, chatJid);
      await reply(`JID: *${msg.key.participant||msg.key.remoteJid}*\nLID: *${l||'—'}*\nCandidates: *${c.join(', ')||'none'}*\nIs admin: *${a?'YES':'NO'}*`);
      break;
    }
    default: await reply(`❓ Unknown: *!${cmd}*\n\nSend *!help*.`);
  }
}

/* Ad builder */
class AdBuilder {
  static build({ title, body, cta, link, footer, style='fancy' }){
    if (style === 'bold') return [`*${title}*`, '', body, cta?`\n*${cta}*`:'', link?`\n${link}`:'', footer?`\n_${footer}_`:''].filter(Boolean).join('\n');
    if (style === 'minimal') return [title, body, cta, link].filter(Boolean).join('\n\n');
    return ['╔══════════════════════════╗',
      `║ ✨ ${(title||'').toUpperCase()} ✨`,
      '╚══════════════════════════╝', '', body, '',
      cta?`*${cta}*`:'', link||'', footer?`\n_${footer}_`:''].filter(Boolean).join('\n');
  }
}

/* Preview cache (used by !pic / !gif) */
let previewCache = { imageUrls:[], imageIndex:0, gifUrls:[], gifIndex:0, currentType:null, currentUrl:null };
const replyCache = new NodeCache({ stdTTL:600 });

/* ══════════════════════════════════════════════════════════════
 *  FLOOD CONTROL
 * ══════════════════════════════════════════════════════════════ */
let msgCountInWindow=0, windowStart=Date.now(), floodIgnoreUntil=0;
function checkFlood(){
  const now = Date.now();
  if (now - windowStart > 1000){ windowStart = now; msgCountInWindow = 0; }
  msgCountInWindow++;
  if (msgCountInWindow > MESSAGE_FLOOD_THRESHOLD){
    if (floodIgnoreUntil < now) pushLog('warn','flood',`Flood: ${msgCountInWindow} msgs/s`);
    floodIgnoreUntil = now + FLOOD_IGNORE_MS;
    return true;
  }
  return false;
}

/* ══════════════════════════════════════════════════════════════
 *  SCHEDULERS
 * ══════════════════════════════════════════════════════════════ */
const GREETING_PHRASES = {
  morning:['Morning all ☀️','Mangwanani guys ☀️','Good morning fam'],
  midday:['Hi guys 👋','Hey everyone','Hello fam 😊'],
  evening:['Good evening fam 🌆','Evening all 👋','Manheru guys'],
  night:['Good night all 🌙','Manheru akanaka 🌙','Sleep well fam']
};
function getTimeOfDay(){
  const h = localHour();
  if (h>=5 && h<12) return 'morning';
  if (h>=12 && h<17) return 'midday';
  if (h>=17 && h<21) return 'evening';
  return 'night';
}
function pickGreeting(p){ const pool = GREETING_PHRASES[p] || GREETING_PHRASES.midday; return pool[Math.floor(Math.random()*pool.length)]; }

function scheduleGreetings(){
  setInterval(async ()=>{
    if (!sock || connectionStatus!=='connected' || !joinedGroups.size || botPaused || Date.now() < botOfflineUntil) return;
    const now = Date.now();
    const minMs = GREETING_MIN_HOURS*3600000, maxMs = GREETING_MAX_HOURS*3600000;
    for (const [jid] of joinedGroups){
      const sinceLast = now - (lastGreetingAt.get(jid)||0);
      if (sinceLast < minMs) continue;
      const progress = (sinceLast - minMs) / (maxMs - minMs);
      if (Math.random() > Math.min(progress, 1)) continue;
      try {
        await sendBuffer(jid, { text: pickGreeting(getTimeOfDay()) }, 3, 'slow');
        lastGreetingAt.set(jid, now); resetDailyStats(); dailyStats.greetingsSent++;
      } catch(e){}
    }
    saveGroups();
  }, 900000);
}
function scheduleDailyReport(){
  setInterval(async ()=>{
    if (!sock || connectionStatus!=='connected') return;
    const now = new Date(); const today = now.toISOString().slice(0,10);
    if (now.getHours() !== DAILY_REPORT_HOUR || lastDailyReportDate === today) return;
    lastDailyReportDate = today; resetDailyStats(); const s = dailyStats;
    try {
      await sock.sendMessage(ADMIN_JID, { text: `📊 Daily ${today}\nGroups: ${joinedGroups.size}\nDMs: ${activeDMs.size}\nDM replies: ${s.dmsReplied}\nMedia: ${s.picsSent+s.videosSent}\nDownloads: ${s.downloads}\nBroadcasts: ${s.broadcastsSent}` });
    } catch(e){}
  }, 60000);
}

/* ══════════════════════════════════════════════════════════════
 *  DM PROCESSING
 * ══════════════════════════════════════════════════════════════ */
async function processDM(item){
  const { msg, text, chatJid, senderJid, pushName, phone, intent, lang } = item;
  const langName = LANG_NAMES[lang] || 'English';
  if (containsForbidden(text)) return;

  // Music
  if (intent && intent.type === 'music'){
    try {
      const results = await ytSearch(intent.query + ' audio', 3);
      if (!results.length){ await sendBuffer(chatJid, { text:`Couldn't find "${intent.query}" 😕` }, 2, 'slow'); return; }
      const top = results[0];
      await sendBuffer(chatJid, { text:`🎵 Found *${top.title}*. Downloading...` }, 2, 'slow');
      const { filePath, sizeBytes } = await y2mateDownloadMusic(top.id, 'mp3');
      await sendMediaFile(chatJid, filePath, `🎵 ${top.title}`, 2, 'slow');
      resetDailyStats(); dailyStats.downloads++;
    } catch(e){
      await sendBuffer(chatJid, { text:`❌ ${e.message}` }, 2, 'slow');
    }
    return;
  }

  // NSFW
  if (detectNsfw(text) && nsfwRoleplayEnabled){
    if (isNsfwWindow() || isAdminSender(msg, senderJid)){
      const rp = await nsfwRoleplay(pushName, text);
      if (rp){ await sendBuffer(chatJid, { text: rp }, 2, 'slow'); resetDailyStats(); dailyStats.dmsReplied++; }
      return;
    } else {
      await sendBuffer(chatJid, { text: 'Not right now 😅 try after 9pm' }, 2, 'slow');
      return;
    }
  }

  // Group link
  if (detectGroupLinkRequest(text)){
    await sendBuffer(chatJid, { text:`🔗 Join our group:\n${ADMIN_GROUP_LINK}` }, 2, 'slow');
    resetDailyStats(); dailyStats.dmsReplied++;
    return;
  }

  // Media intent
  if (intent && intent.type !== 'music'){
    if (!isVague(intent.query)){
      if (intent.type === 'video' || intent.type === 'gif'){
        const r = await scraperGif(intent.query, false);
        if (r.ok && r.gifs.length){
          await sendGifSafe(chatJid, r.gifs[0], '', 2, 'slow');
          resetDailyStats();
          if (intent.type === 'video') dailyStats.videosSent++; else dailyStats.picsSent++;
          return;
        }
      } else {
        const r = await scraperSearch(intent.query, false);
        if (r.ok && r.images.length){
          await sendImageSafe(chatJid, r.images[0], '', 2, 'slow');
          resetDailyStats(); dailyStats.picsSent++;
          return;
        }
      }
    }
    const history = userHistories.get(senderJid) || [];
    const id = createPendingRequest(senderJid, pushName, phone, history, intent);
    await sendBuffer(chatJid, { text: 'checking rn 😊' }, 2, 'slow');
    return;
  }

  // Free chat
  const sys = `You are Abby Faith Sithole, a 23-year-old girl from Harare, Zimbabwe. REAL person. Reply in ${langName}. Mix light Shona. Keep replies SHORT (1-2 sentences). Never say you're an AI. Be casual.`;
  const aiReply = await askAI(text, sys);
  if (!aiReply) return;
  await sendBuffer(chatJid, { text: informalize(aiReply) }, 2, 'slow');
  resetDailyStats(); dailyStats.dmsReplied++; dailyStats.focusRuns++;
}

async function processDMQueue(){
  if (dmQueueProcessing) return;
  if (focus.busy){ setTimeout(processDMQueue, 2000); return; }
  const item = dmQueue.shift();
  if (!item) return;
  dmQueueProcessing = true;
  try {
    await focus.run(item.chatJid, async ()=>{ await processDM(item); });
  } catch(e){
    pushLog('error','dmqueue',e.message);
    if (e.message === 'Focus lock timeout') dmQueue.unshift(item);
  } finally {
    dmQueueProcessing = false;
    if (dmQueue.length) setTimeout(processDMQueue, 100);
  }
}

function enqueueDM(item){
  if (dmQueue.length >= DM_QUEUE_MAX){
    resetDailyStats(); dailyStats.messagesDropped++;
    pushLog('warn','queue',`DM queue full (${DM_QUEUE_MAX})`);
    return false;
  }
  dmQueue.push(item);
  processDMQueue();
  return true;
}

/* ══════════════════════════════════════════════════════════════
 *  MAIN MESSAGE HANDLER
 * ══════════════════════════════════════════════════════════════ */
async function handleMessage(msg){
  if (!sock) return;
  if (checkFlood()){ resetDailyStats(); dailyStats.messagesDropped++; return; }
  if (Date.now() < floodIgnoreUntil) return;

  const chatJid = msg.key?.remoteJid;
  if (!chatJid) return;
  activeChats.add(chatJid);

  const msgId = msg.key.id;
  if (processedMessages.has(msgId)) return;
  processedMessages.add(msgId);
  if (processedMessages.size > 10000){
    const a=[...processedMessages]; processedMessages.clear();
    for (const i of a.slice(-5000)) processedMessages.add(i);
  }
  if (botSentIds.has(msgId)) return;

  let m = msg.message; let guard=0;
  while (m && guard++<10){
    if (m.ephemeralMessage?.message){ m=m.ephemeralMessage.message; continue; }
    if (m.viewOnceMessage?.message){ m=m.viewOnceMessage.message; continue; }
    if (m.viewOnceMessageV2?.message){ m=m.viewOnceMessageV2.message; continue; }
    if (m.deviceSentMessage?.message){ m=m.deviceSentMessage.message; continue; }
    if (m.documentWithCaptionMessage?.message){ m=m.documentWithCaptionMessage.message; continue; }
    break;
  }

  const text = m?.conversation || m?.extendedTextMessage?.text
            || m?.imageMessage?.caption || m?.videoMessage?.caption || '';
  const mediaType = m?.imageMessage ? 'image' : m?.videoMessage ? 'video'
                  : m?.audioMessage ? 'audio' : m?.documentMessage ? 'document' : 'text';
  const isGroup   = chatJid.endsWith('@g.us');
  const senderJid = isGroup ? (msg.key.participant||chatJid) : chatJid;
  const phone     = extractPhone(msg, senderJid);
  const lid       = extractLid(msg, senderJid);
  const pushName  = msg.pushName || (msg.key.fromMe?'You':'Unknown');
  const chatType  = isGroup ? 'group' : 'dm';

  if (isGroup){ discoverGroup(chatJid); recordGroupMessage(chatJid, text); }
  else activeDMs.add(chatJid);

  pushLiveMessage({ id:msgId, ts:new Date().toISOString(), chatJid, chatType,
    senderJid, senderName:pushName, phone:phone||'—', lid:lid||'—',
    text:text.slice(0,200)||`[${mediaType}]`, mediaType });

  const isAdmin = isAdminSender(msg, senderJid);

  /* 1. Admin commands — fast lane, always work */
  if (isAdmin && text.startsWith('!')){
    pushLog('info','admin',`Cmd: ${text.split(' ')[0]}`);
    await handleAdminCommand(text, chatJid, msg);
    return;
  }

  if (botPaused && !isAdmin) return;
  if (Date.now() < botOfflineUntil && !isAdmin) return;

  /* 2. Admin image broadcast via reply */
  if (!isGroup && isAdmin && mediaType === 'image' && text.startsWith('!')){
    const args = text.slice(1).trim().split(/\s+/);
    const cmd  = args[0].toLowerCase();
    if (['bcdm','bcgroup','all'].includes(cmd)){
      const caption = args.slice(1).join(' ').trim();
      try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger:pino({level:'silent'}) });
        if (!buffer){ adminReply(chatJid, '❌ Failed.'); return; }
        if (buffer.length > MEDIA_MAX_BYTES){
          adminReply(chatJid, `❌ ${(buffer.length/1024/1024).toFixed(1)}MB > 34MB`); return;
        }
        const mode = cmd==='bcdm'?'dms':cmd==='bcgroup'?'groups':'all';
        const targets = mode === 'all'
          ? [...joinedGroups.keys(), ...activeDMs]
          : mode === 'groups' ? [...joinedGroups.keys()] : [...activeDMs];
        if (!targets.length){ adminReply(chatJid, `No ${mode}.`); return; }
        adminReply(chatJid, `📸 Queued to ${targets.length}.`);
        for (const jid of targets){
          await sendBuffer(jid, { image: buffer, caption }, 3, 'slow');
        }
        adminReply(chatJid, '✅ Done.');
      } catch(e){ adminReply(chatJid, `❌ ${e.message}`); }
      return;
    }
  }

  /* 3. User history for DMs */
  if (!isGroup && !isAdmin && text){
    if (!userHistories.has(senderJid)) userHistories.set(senderJid, []);
    const h = userHistories.get(senderJid);
    h.push({ text, ts:Date.now() });
    if (h.length > USER_HISTORY_SIZE*2) h.shift();
  }

  /* 4. Invite links */
  const codes = extractInviteCodes(text);
  if (codes.length){
    let added = 0;
    for (const c of codes) if (queueJoin(c, phone||pushName, chatType)) added++;
    if (added && !isGroup) await sendBuffer(chatJid, { text:`✅ Queued ${added}. Total ${joinQueue.length}` }, 3, 'slow');
    processJoinQueue();
  }

  /* 5. Download pick */
  if (text && downloadPicks.has(chatJid)){
    const ok = await handleDownloadPick(chatJid, text, msg, isAdmin?0:2, isAdmin?'fast':'slow');
    if (ok) return;
  }

  /* 6. Download search intent */
  const dl = text ? detectDownloadIntent(text) : null;
  if (dl && dl.query){
    await startDownloadSearch(chatJid, dl.query, msg, isAdmin?0:2, isAdmin?'fast':'slow');
    return;
  }

  /* 7. Group messages */
  if (isGroup){
    await handleAntiLink(chatJid, msg, text, senderJid, isAdmin);
    const isMain = chatJid === mainGroupJid;
    const directed = isDirectedAtBot(msg, text);

    if (isMain && text){
      if (detectGroupLinkRequest(text)){
        await sendBuffer(chatJid, { text:`🔗 Join: ${ADMIN_GROUP_LINK}` }, 3, 'slow');
        return;
      }
      const isNsfw = detectNsfw(text);
      if (isNsfw && !isAdmin && !isNsfwWindow()){
        await sendBuffer(chatJid, { text:'Not right now 😅 try after 9pm' }, 3, 'slow');
        return;
      }
      const gIntent = detectMediaIntent(text);
      if (gIntent && !isVague(gIntent.query)){
        if (gIntent.type === 'music'){
          try {
            const results = await ytSearch(gIntent.query + ' audio', 3);
            if (results.length){
              const top = results[0];
              await sendBuffer(chatJid, { text:`🎵 *${top.title}* — downloading...` }, 3, 'slow');
              const { filePath } = await y2mateDownloadMusic(top.id, 'mp3');
              await sendMediaFile(chatJid, filePath, `🎵 ${top.title}`, 3, 'slow');
              resetDailyStats(); dailyStats.downloads++;
              return;
            }
          } catch(e){ pushLog('error','music',e.message); }
        }
        if (gIntent.type === 'video' || gIntent.type === 'gif'){
          const r = await scraperGif(gIntent.query, isNsfw);
          if (r.ok && r.gifs.length){
            await sendGifSafe(chatJid, r.gifs[0], '', 3, 'slow');
            resetDailyStats();
            if (gIntent.type === 'video') dailyStats.videosSent++; else dailyStats.picsSent++;
            if (isNsfw) dailyStats.nsfwSent++;
            return;
          }
        } else {
          const r = await scraperSearch(gIntent.query, isNsfw);
          if (r.ok && r.images.length){
            await sendImageSafe(chatJid, r.images[0], '', 3, 'slow');
            resetDailyStats(); dailyStats.picsSent++;
            if (isNsfw) dailyStats.nsfwSent++;
            return;
          }
        }
      }
      const analysis = analyzeGroup(chatJid);
      const lang = detectLanguage(text);
      const sys = `You are Abby Faith Sithole, 23, Harare Zimbabwe. In YOUR OWN WhatsApp group. Reply casually, SHORT (1 sentence), warm, in ${LANG_NAMES[lang]}. Mix light Shona. Never say you're AI. ${analysis?`Members often use: ${analysis.topWords.slice(0,6).join(', ')}`:''}`;
      const aiReply = await askAI(text, sys);
      if (aiReply){
        await sendBuffer(chatJid, { text: informalize(aiReply) }, 3, 'slow');
        resetDailyStats(); dailyStats.greetingsSent++;
      }
      return;
    }

    /* Other groups */
    if (directed && text){
      const analysis = analyzeGroup(chatJid);
      const lang = detectLanguage(text);
      const sys = `You are Abby Faith Sithole, 23, Harare Zimbabwe. Someone is talking TO you in a group. Reply SHORT, casual, in ${LANG_NAMES[lang]}. Never mention AI. ${analysis?`Style: ${analysis.topWords.slice(0,5).join(', ')}`:''}`;
      const aiReply = await askAI(text, sys);
      if (aiReply){
        await sendBuffer(chatJid, { text: informalize(aiReply) }, 3, 'slow');
        resetDailyStats(); dailyStats.greetingsSent++;
      }
      return;
    }

    if (text && Math.random() < AMBIENT_CHANCE){
      const sys = `You are Abby Faith Sithole in a group. React casually, 1 short sentence, warm. Never mention AI.`;
      const aiReply = await askAI(text, sys);
      if (aiReply) await sendBuffer(chatJid, { text: informalize(aiReply) }, 3, 'slow');
    }
    return;
  }

  /* 8. Non-admin DM */
  if (isAdmin) return;
  if (!isDmAiWindow()) return;
  enqueueDM({ msg, text, chatJid, senderJid, pushName, phone,
    intent: detectMediaIntent(text), lang: detectLanguage(text) });
}

/* ══════════════════════════════════════════════════════════════
 *  CONNECT BOT
 * ══════════════════════════════════════════════════════════════ */
async function connectBot(){
  if (isConnecting) return;
  isConnecting = true; manualDisconnect = false;
  try {
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

    if (wrapSocket){
      try {
        sock = wrapSocket(baseSocket, {
          groupOpGuard:{ limits:{ add:{ max:3, windowMs:600000 } } },
          legitimacySignals:{ typoProbability:0.02 },
          jidCanonicalizer:{ enabled:true, canonical:'pn' }
        });
        pushLog('success','antiban','Wrapped');
      } catch(e){ pushLog('warn','antiban',e.message); sock = baseSocket; }
    } else { sock = baseSocket; pushLog('warn','antiban','Not available'); }

    if (SessionHealthMonitor){
      try {
        healthMonitor = new SessionHealthMonitor({
          badMacThreshold: 3, badMacWindowMs: 60000,
          onDegraded:(s)=>{
            pushLog('error','health',`DEGRADED: ${s.badMacCount} Bad MACs`);
            resetDailyStats(); dailyStats.badMacs = s.badMacCount;
          }
        });
        pushLog('info','health','Monitor started');
      } catch(e){ pushLog('warn','health',e.message); }
    }

    sock.ev.on('connection.update', async (update)=>{
      const { connection, lastDisconnect, qr } = update;
      if (qr){
        qrDataUri = await QRCode.toDataURL(qr);
        connectionStatus = 'qr';
        pushLog('info','bot','QR generated');
      }
      if (connection === 'open'){
        isConnecting = false; connectionStatus = 'connected';
        reconnectAttempts = 0; botStartTime = Date.now();
        botJid = sock.user?.id || null;
        botNumber = botJid?.split(':')[0]?.split('@')[0] || 'unknown';
        consecutive515 = 0; recent515Timestamps = []; spamCooldownUntil = 0; lastReconnectAt = 0;
        pushLog('success','bot',`Connected as ${botNumber}`);
        pushLog('info','time',`${describeWindow()} · NSFW: ${describeNsfw()} · DM: ${describeDm()}`);
        if (createHumanEntropyService){
          try {
            entropyService = createHumanEntropyService(sock, botJid,
              { enabled:true, minIntervalMs:7200000, maxIntervalMs:21600000 });
            entropyService.start();
            pushLog('success','entropy','Started');
          } catch(e){ pushLog('warn','entropy',e.message); }
        }
        try { await sock.sendPresenceUpdate('available'); } catch(e){}
        try {
          await sock.sendMessage(ADMIN_JID, { text:
            `✅ *BreadBot ONLINE*\n📱 ${botNumber}\n⭐ Main: ${mainGroupJid||'_not set_'}\n👥 Groups: ${joinedGroups.size}\n💬 DMs: ${activeDMs.size}\n🕐 ${describeWindow()}\nNSFW: ${describeNsfw()}\nDM AI: ${describeDm()}\n\nSend *!help*.`
          });
        } catch(e){}
      }
      if (connection === 'close'){
        isConnecting = false;
        const code = getDisconnectStatusCode(lastDisconnect);
        let cls = null;
        if (classifyDisconnect){ try { cls = classifyDisconnect(code); } catch(e){} }
        if (cls) pushLog('warn','bot',`Disconnected (${code}) — ${cls.message} [${cls.category}]`);
        else pushLog('warn','bot',`Disconnected (${code})`);
        if (entropyService){ try { entropyService.stop(); } catch(e){} entropyService = null; }
        if (manualDisconnect){ connectionStatus = 'disconnected'; return; }
        if (code === DisconnectReason.loggedOut){ connectionStatus = 'disconnected'; pushLog('error','bot','Logged out'); return; }
        if (code === 408 && connectionStatus === 'qr' && !botNumber){ connectionStatus = 'disconnected'; pushLog('warn','bot','QR expired'); return; }
        if (code === 428 || code === 440){ connectionStatus = 'disconnected'; pushLog('error','bot',`Conflict ${code}`); return; }

        if (code === DisconnectReason.restartRequired || code === 515){
          if (restart515InFlight){ pushLog('warn','bot','515 handler already in flight — skip'); return; }
          restart515InFlight = true;
          const now = Date.now();
          if (now < spamCooldownUntil){
            const remain = spamCooldownUntil - now;
            pushLog('warn','antispam',`cooldown — wait ${Math.ceil(remain/1000)}s`);
            await new Promise(r=>setTimeout(r, remain));
          }
          // record 515 for spam detection
          const t = Date.now();
          recent515Timestamps.push(t);
          recent515Timestamps = recent515Timestamps.filter(ts => t - ts < SPAM_WINDOW_MS);
          if (recent515Timestamps.length > SPAM_THRESHOLD){
            spamCooldownUntil = t + SPAM_COOLDOWN_MS;
            pushLog('warn','antispam',`${recent515Timestamps.length}x 515 in 60s — pause 60s`);
            recent515Timestamps = []; consecutive515 = 0;
          }
          consecutive515 += 1;
          const delay = Math.min(RESTART_515_BASE_DELAY_MS * Math.pow(2, consecutive515-1), RESTART_515_MAX_DELAY_MS);
          pushLog('warn','bot',`515 retry in ${delay/1000}s (attempt ${consecutive515})`);
          await new Promise(r=>setTimeout(r, delay));
          const since = Date.now() - lastReconnectAt;
          if (since < MIN_RECONNECT_INTERVAL_MS){
            await new Promise(r=>setTimeout(r, MIN_RECONNECT_INTERVAL_MS - since));
          }
          lastReconnectAt = Date.now();
          try { sock.ev.removeAllListeners('connection.update'); } catch(e){}
          try { sock.ev.removeAllListeners('creds.update'); } catch(e){}
          try { sock.end(undefined); } catch(e){}
          sock = null; restart515InFlight = false;
          connectionStatus = 'reconnecting';
          return connectBot();
        }

        const shouldReconnect = cls ? cls.shouldReconnect : true;
        if (shouldReconnect && reconnectAttempts < MAX_RECONNECT){
          reconnectAttempts++;
          const delay = cls?.backoffMs || Math.min(5000 * reconnectAttempts, 30000);
          connectionStatus = 'reconnecting';
          pushLog('warn','bot',`Retry ${delay/1000}s [${reconnectAttempts}/${MAX_RECONNECT}]`);
          setTimeout(()=>{ try { sock.end(undefined); } catch(e){} sock = null; connectBot(); }, delay);
        } else {
          connectionStatus = 'disconnected';
          pushLog('error','bot','Max retries');
        }
      }
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('group-participants.update', async (u)=>{ try { await handleParticipants(u); } catch(e){ pushLog('error','group',e.message); } });
    sock.ev.on('messages.upsert', async ({ messages })=>{
      for (const msg of messages || []){
        try {
          if (entropyService && msg.key?.remoteJid && !msg.key.fromMe){
            try { entropyService.addRecentContact(msg.key.remoteJid, msg.key); } catch(e){}
          }
          await handleMessage(msg);
        } catch(e){ pushLog('error','handler',e.message); }
      }
    });
  } catch(err){
    isConnecting = false;
    pushLog('error','bot',`Connection failed: ${err.message}`);
    connectionStatus = 'error';
  }
}

async function disconnectBot(){
  manualDisconnect = true;
  if (entropyService){ try { entropyService.stop(); } catch(e){} entropyService = null; }
  if (sock){ try { sock.end(undefined); } catch(e){} sock = null;
    connectionStatus = 'disconnected'; qrDataUri = null; isConnecting = false; botNumber = null;
    pushLog('warn','bot','Disconnected'); }
}
function refreshQR(){
  qrDataUri = null; connectionStatus = 'disconnected'; manualDisconnect = true;
  if (sock){ try { sock.end(undefined); } catch(e){} sock = null; }
  isConnecting = false; botNumber = null;
  consecutive515 = 0; recent515Timestamps = []; spamCooldownUntil = 0; lastReconnectAt = 0; restart515InFlight = false;
  pushLog('info','bot','Manual QR refresh');
  setTimeout(()=>{ manualDisconnect = false; connectBot(); }, 1500);
}

/* ══════════════════════════════════════════════════════════════
 *  EXPRESS PANEL
 * ══════════════════════════════════════════════════════════════ */
const app = express();
app.use(express.json());

app.get('/health',(req,res)=>res.json({
  ok:true, ts:Date.now(), status:connectionStatus,
  uptime:Math.floor((Date.now()-botStartTime)/1000),
  lanes: jobs.stats(),
  window:{ time:describeWindow(), nsfw:describeNsfw(), dmAI:describeDm() },
  paused:botPaused, offlineUntil: botOfflineUntil > Date.now() ? new Date(botOfflineUntil).toISOString() : null,
  mainGroup: mainGroupJid,
  groups: joinedGroups.size, dms: activeDMs.size, queue: joinQueue.length,
  dmQueue: dmQueue.length, dmQueueMax: DM_QUEUE_MAX,
  consecutive515, spamCooldownUntil: spamCooldownUntil ? new Date(spamCooldownUntil).toISOString() : null
}));
app.get('/api/status',(req,res)=>res.json({
  status: connectionStatus, botNumber,
  groups: joinedGroups.size, dms: activeDMs.size,
  queue: joinQueue.length, lanes: jobs.stats(), mainGroup: mainGroupJid
}));
app.get('/admin/qr',async (req,res)=>{
  if (!qrDataUri) return res.status(404).json({ error:'No QR' });
  const b64 = qrDataUri.replace(/^data:image\/\w+;base64,/,'');
  res.writeHead(200, { 'Content-Type':'image/png' });
  res.end(Buffer.from(b64, 'base64'));
});
app.get('/admin/qr-data',(req,res)=>res.json({ qr: qrDataUri, status: connectionStatus, botNumber }));
app.post('/admin/connect',(req,res)=>{ if (!sock) connectBot(); res.json({ ok:true }); });
app.post('/admin/reconnect',async (req,res)=>{ await disconnectBot(); setTimeout(()=>{ manualDisconnect=false; connectBot(); },1500); res.json({ ok:true }); });
app.post('/admin/disconnect',async (req,res)=>{ await disconnectBot(); res.json({ ok:true }); });
app.post('/admin/refresh-qr',(req,res)=>{ refreshQR(); res.json({ ok:true }); });
app.post('/admin/clear-session',(req,res)=>{ try { fs.rmSync(AUTH_FOLDER, { recursive:true, force:true }); } catch(e){} res.json({ ok:true }); });
app.post('/admin/pause',(req,res)=>{ botPaused = true; res.json({ ok:true }); });
app.post('/admin/resume',(req,res)=>{ botPaused = false; res.json({ ok:true }); });
app.post('/admin/offline',(req,res)=>{
  const mins = parseInt(req.body?.minutes, 10) || 30;
  botOfflineUntil = Date.now() + mins*60000;
  res.json({ ok:true, until: new Date(botOfflineUntil).toISOString() });
});
app.post('/admin/online',(req,res)=>{ botOfflineUntil = 0; res.json({ ok:true }); });

app.get('/admin/logs',(req,res)=>{
  res.writeHead(200, { 'Content-Type':'text/event-stream', 'Cache-Control':'no-cache', Connection:'keep-alive' });
  for (const e of logBuffer.slice(-100)) res.write(`data: ${JSON.stringify(e)}\n\n`);
  logClients.add(res); req.on('close',()=>logClients.delete(res));
});
app.get('/admin/messages-stream',(req,res)=>{
  res.writeHead(200, { 'Content-Type':'text/event-stream', 'Cache-Control':'no-cache', Connection:'keep-alive' });
  for (const m of liveMessages.slice(-100)) res.write(`data: ${JSON.stringify(m)}\n\n`);
  msgClients.add(res); req.on('close',()=>msgClients.delete(res));
});

app.get('/admin/aitest',async (req,res)=>res.json(await testAIRaw()));
app.get('/admin/scraperstatus',async (req,res)=>res.json(await scraperStatus()));
app.get('/admin/sched',(req,res)=>res.json({
  lanes: jobs.stats(), focus: focus.stats(),
  window: describeWindow(), dmQueue: dmQueue.length,
  consecutive515, spamCooldownUntil: spamCooldownUntil ? new Date(spamCooldownUntil).toISOString() : null
}));
app.get('/admin/pending',(req,res)=>res.json({ pending: [...pendingRequests.values()] }));
app.post('/admin/pending/:id/resolve',async (req,res)=>{
  const { id } = req.params; const { action, payload } = req.body || {};
  res.json(await resolvePending(id, action || 'search', payload, ADMIN_JID));
});
app.get('/admin/stats',(req,res)=>{
  resetDailyStats();
  res.json({
    status: connectionStatus, botNumber,
    uptime: Math.floor((Date.now()-botStartTime)/1000),
    dmCount: activeDMs.size, groupCount: joinedGroups.size,
    joinedGroups: joinedGroups.size, queueSize: joinQueue.length,
    dailyStats, adminPhone: ADMIN_PHONE, adminLids: [...adminLids],
    pendingCount: pendingRequests.size,
    lanes: jobs.stats(), focus: focus.stats(),
    window:{ time:describeWindow(), nsfw:describeNsfw(), dmAI:describeDm() },
    dmQueueLength: dmQueue.length, dmQueueMax: DM_QUEUE_MAX,
    paused: botPaused,
    offlineUntil: botOfflineUntil > Date.now() ? new Date(botOfflineUntil).toISOString() : null,
    mainGroup: mainGroupJid,
    antibanActive: !!wrapSocket, entropyRunning: !!entropyService,
    floodLimit: MESSAGE_FLOOD_THRESHOLD
  });
});

/* ─── HTML panel ─── */
const PANEL_HTML = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BreadBot v50</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:monospace;background:#0d1117;color:#c9d1d9;padding:16px}h1{font-size:20px;color:#58a6ff}.sub{font-size:12px;color:#8b949e;margin-bottom:16px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px}.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px}.card h2{font-size:12px;color:#8b949e;text-transform:uppercase;margin-bottom:10px}button{background:#21262d;border:1px solid #30363d;color:#c9d1d9;padding:8px 14px;border-radius:6px;cursor:pointer;margin:3px;font-family:inherit}button:hover{background:#30363d}button.primary{background:#238636;color:#fff}button.danger{background:#da3633;color:#fff}.row{display:flex;justify-content:space-between;padding:4px 0;font-size:13px;border-bottom:1px solid #21262d}.val{color:#58a6ff;font-weight:600}.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px}.s-connected{background:#3fb950}.s-qr{background:#d29922}.s-disconnected,.s-error{background:#f85149}.s-reconnecting{background:#d29922}#logs,#msgs{height:280px;overflow-y:auto;font-size:12px;background:#0d1117;border-radius:6px;padding:8px}#qrImg{max-width:220px;background:#fff;padding:8px;border-radius:8px;display:block;margin:auto}.full{grid-column:1/-1}</style></head><body>
<h1>🥖 BreadBot v50</h1><div class="sub">Admin: <b id="ap">—</b> · Window: <b id="w">—</b> · NSFW: <b id="ns">—</b> · DM: <b id="dm">—</b></div>
<div class="grid">
<div class="card"><h2>Connection</h2><div><span class="dot" id="dot"></span><span id="st">—</span></div>
<div class="row"><span>Bot</span><span class="val" id="bn">—</span></div>
<div class="row"><span>Uptime</span><span class="val" id="up">—</span></div>
<div class="row"><span>Paused</span><span class="val" id="pz">—</span></div>
<div class="row"><span>Offline</span><span class="val" id="off">—</span></div>
<div class="row"><span>515 streak</span><span class="val" id="c5">—</span></div>
<img id="qrImg" src="" style="display:none">
<div style="margin-top:10px"><button class="primary" onclick="a('connect')">Start</button>
<button onclick="a('refresh-qr')">Refresh QR</button>
<button class="danger" onclick="a('disconnect')">Disconnect</button>
<button onclick="a('pause')">Pause</button><button onclick="a('resume')">Resume</button>
<button onclick="a('offline')">Offline 30m</button><button onclick="a('online')">Online</button></div></div>
<div class="card"><h2>Lanes</h2>
<div class="row"><span>Fast queued</span><span class="val" id="fq">—</span></div>
<div class="row"><span>Fast done</span><span class="val" id="fd">—</span></div>
<div class="row"><span>Slow queued</span><span class="val" id="sq">—</span></div>
<div class="row"><span>Slow done</span><span class="val" id="sd">—</span></div>
<div class="row"><span>Failed</span><span class="val" id="fl">—</span></div>
<div class="row"><span>Dropped</span><span class="val" id="dr">—</span></div></div>
<div class="card"><h2>Scope</h2>
<div class="row"><span>Groups</span><span class="val" id="g">—</span></div>
<div class="row"><span>DMs</span><span class="val" id="d">—</span></div>
<div class="row"><span>Join queue</span><span class="val" id="jq">—</span></div>
<div class="row"><span>Pending</span><span class="val" id="pd">—</span></div>
<div class="row"><span>DM queue</span><span class="val" id="dmq">—</span></div>
<div class="row"><span>Main</span><span class="val" id="mg">—</span></div></div>
<div class="card"><h2>Today</h2>
<div class="row"><span>DM replies</span><span class="val" id="dms">—</span></div>
<div class="row"><span>Media</span><span class="val" id="md">—</span></div>
<div class="row"><span>NSFW</span><span class="val" id="nsf">—</span></div>
<div class="row"><span>Downloads</span><span class="val" id="dls">—</span></div>
<div class="row"><span>Broadcasts</span><span class="val" id="bc">—</span></div>
<div class="row"><span>Dropped</span><span class="val" id="drp">—</span></div></div>
<div class="card full"><h2>Live</h2><div id="msgs"></div></div>
<div class="card full"><h2>Logs</h2><div id="logs"></div></div>
</div>
<script>
const $=id=>document.getElementById(id);
async function api(p,m='GET',body){const o={method:m};if(body){o.headers={'Content-Type':'application/json'};o.body=JSON.stringify(body);}const r=await fetch('/admin/'+p,o);return r.json();}
function esc(s){return String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function setS(s){$('dot').className='dot s-'+s;$('st').textContent=s;}
async function refresh(){
  try{const d=await api('stats');setS(d.status);
  $('ap').textContent=d.adminPhone||'—';
  $('w').textContent=(d.window&&d.window.time)||'—';
  $('ns').textContent=(d.window&&d.window.nsfw)||'—';
  $('dm').textContent=(d.window&&d.window.dmAI)||'—';
  $('bn').textContent=d.botNumber||'—';
  const u=d.uptime||0,h=Math.floor(u/3600),m=Math.floor((u%3600)/60),s=u%60;
  $('up').textContent=h+'h '+m+'m '+s+'s';
  $('pz').textContent=d.paused?'yes':'no';
  $('off').textContent=d.offlineUntil?'yes':'no';
  $('c5').textContent=d.consecutive515||0;
  const L=d.lanes||{fast:{},slow:{},total:{}};
  $('fq').textContent=L.fast.queued||0;$('fd').textContent=L.fast.done||0;
  $('sq').textContent=L.slow.queued||0;$('sd').textContent=L.slow.done||0;
  $('fl').textContent=L.total.failed||0;$('dr').textContent=L.total.dropped||0;
  $('g').textContent=d.joinedGroups||0;$('d').textContent=d.dmCount||0;
  $('jq').textContent=d.queueSize||0;$('pd').textContent=d.pendingCount||0;
  $('dmq').textContent=(d.dmQueueLength||0)+'/'+(d.dmQueueMax||1000);
  $('mg').textContent=d.mainGroup||'not set';
  const t=d.dailyStats||{};
  $('dms').textContent=t.dmsReplied||0;
  $('md').textContent=(t.picsSent||0)+(t.videosSent||0);
  $('nsf').textContent=t.nsfwSent||0;$('dls').textContent=t.downloads||0;
  $('bc').textContent=t.broadcastsSent||0;$('drp').textContent=t.messagesDropped||0;
  const q=await api('qr-data');
  if(q.qr&&q.status==='qr'){$('qrImg').src='/admin/qr?t='+Date.now();$('qrImg').style.display='block';}
  else{$('qrImg').style.display='none';}
  }catch(e){}
}
async function a(x){await api(x,'POST');setTimeout(refresh,1000);}
function logs(){const es=new EventSource('/admin/logs');es.onmessage=e=>{try{const en=JSON.parse(e.data);const div=document.createElement('div');const t=new Date(en.ts).toLocaleTimeString();div.innerHTML='<span style="color:#484f58">'+t+'</span> <span style="color:#58a6ff">['+en.level+']</span> <span style="color:#8b949e">'+esc(en.source)+'</span> '+esc(en.message);const b=$('logs');b.appendChild(div);b.scrollTop=b.scrollHeight;while(b.children.length>300)b.removeChild(b.firstChild);}catch(e){}};es.onerror=()=>{es.close();setTimeout(logs,5000);};}
function msgs(){const es=new EventSource('/admin/messages-stream');es.onmessage=e=>{try{const m=JSON.parse(e.data);const div=document.createElement('div');div.style.padding='4px 8px';div.style.margin='3px 0';div.style.borderLeft='3px solid '+(m.chatType==='group'?'#a371f7':'#3fb950');div.innerHTML='<div style="color:#8b949e;font-size:11px">'+new Date(m.ts).toLocaleTimeString()+' · <span style="color:#58a6ff">'+esc(m.senderName)+'</span></div><div>'+esc(m.text)+'</div>';const b=$('msgs');b.appendChild(div);b.scrollTop=b.scrollHeight;while(b.children.length>200)b.removeChild(b.firstChild);}catch(e){}};es.onerror=()=>{es.close();setTimeout(msgs,5000);};}
refresh();logs();msgs();setInterval(refresh,5000);
</script></body></html>`;
app.get('/',(req,res)=>res.send(PANEL_HTML));
app.get('/admin',(req,res)=>res.send(PANEL_HTML));

/* ══════════════════════════════════════════════════════════════
 *  PERIODIC TASKS
 * ══════════════════════════════════════════════════════════════ */
setInterval(async ()=>{
  if (connectionStatus==='connected' && sock && !botPaused && Date.now() > botOfflineUntil){
    try { await sock.sendPresenceUpdate('available'); } catch(e){}
  }
}, 240000);
setInterval(()=>{ axios.get(`http://localhost:${PORT}/health`).catch(()=>{}); }, 240000);
setInterval(processJoinQueue, 30000);
setInterval(()=>{
  const now = Date.now();
  for (const [k,v] of downloadPicks){ if (now - v.ts > DOWNLOAD_PICK_TTL) downloadPicks.delete(k); }
}, 60000);

/* ══════════════════════════════════════════════════════════════
 *  BOOT
 * ══════════════════════════════════════════════════════════════ */
loadState();
loadGroupSettings();
loadLearningData();

app.listen(PORT, ()=>{
  console.log(`🌐 Port ${PORT}`);
  console.log(`👤 Admin phone: ${ADMIN_PHONE}`);
  console.log(`🔑 Admin LIDs: ${[...adminLids].join(', ')||'none'}`);
  console.log(`⭐ Main group: ${mainGroupJid||'not set'}`);
  console.log(`🕐 ${describeWindow()} · DM AI: ${describeDm()} · NSFW: ${describeNsfw()}`);
  console.log(`⚙️ Lanes — fast max ${FAST_LANE_MAX}, slow max ${SLOW_LANE_MAX}`);
  console.log(`📦 Media max: 34 MB (enforced on images, GIFs, videos, audio)`);
  console.log(`🔎 Scraper: ${SCRAPER_URL}`);
  console.log(`🔞 NSFW roleplay: ${nsfwRoleplayEnabled ? 'ON' : 'OFF'}`);
  pushLog('info','system',`Boot port ${PORT}`);
  pushLog('info','system',`Admin: ${ADMIN_PHONE}`);
  pushLog('info','system',`Main group: ${mainGroupJid||'not set'}`);
  pushLog('info','system',`Lanes fast=${FAST_LANE_MAX} slow=${SLOW_LANE_MAX}`);
  pushLog('info','system',`Media cap 34MB enforced on all files`);
  scheduleGreetings();
  scheduleDailyReport();
  connectBot().catch(err=>{ pushLog('error','system',`Boot: ${err.message}`); });
});

process.on('SIGINT', async ()=>{
  pushLog('warn','system','SIGINT — shutting down');
  try { if (sock) sock.end(undefined); } catch(e){}
  process.exit(0);
});
process.on('SIGTERM', async ()=>{
  pushLog('warn','system','SIGTERM — shutting down');
  try { if (sock) sock.end(undefined); } catch(e){}
  process.exit(0);
});
process.on('uncaughtException', (e)=>pushLog('error','uncaught',e.message));
process.on('unhandledRejection', (e)=>pushLog('error','unhandled',String(e)));
