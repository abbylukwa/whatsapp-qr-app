'use strict';

/* ============================================================
 *  BreadBot v64 — Full fix release
 *  - Fixed: markBotSent is not defined
 *  - Fixed: Bot LID extraction (lazy learn)
 *  - Fixed: getSelfLid() defined
 *  - Fixed: isBotSender refreshes LID
 *  - Fixed: extractInviteCodes undefined crash
 *  - Fixed: protocol frames flooding Live Messages
 *  - Fixed: fromMe echoes appearing as "You" messages
 *  - LID-aware admin detection (id, phoneNumber, lid)
 *  - Main group starts NULL (admin must !setmain)
 * ============================================================ */

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const NodeCache = require('node-cache');
const {
  makeWASocket, DisconnectReason, useMultiFileAuthState,
  Browsers, fetchLatestBaileysVersion, downloadMediaMessage
} = require('@whiskeysockets/baileys');

let RedgifsDownloader = null;
try { RedgifsDownloader = require('redgifs-downloader'); } catch(e){}

const QRCode = require('qrcode');
const pino   = require('pino');
const axios  = require('axios');

/* ══════════════════════════════════════════════════════════════
 *  TOGGLES
 * ══════════════════════════════════════════════════════════════ */
const ENABLE_CONTENT_BLOCK = false;
const ENABLE_TYPING = true;
const ENABLE_READ_RECEIPTS = true;

/* ══════════════════════════════════════════════════════════════
 *  CONFIG
 * ══════════════════════════════════════════════════════════════ */
const PORT        = process.env.PORT || 10000;
const AUTH_FOLDER = 'auth_info';

const ADMIN_PHONE = (process.env.ADMIN_PHONE || '263777627210').replace(/\D/g,'');
const ADMIN_JID   = `${ADMIN_PHONE}@s.whatsapp.net`;
const ADMIN_LID_FILE         = path.join(__dirname,'admin_lids.json');
const HARDCODED_ADMIN_LIDS   = ['115110005706891'];
const MAIN_GROUP_FILE        = path.join(__dirname,'main_group_jid.json');
const ADMIN_GROUP_LINK       = 'https://chat.whatsapp.com/HGW3IdVbDJyImOgp1BFqT7?s=sw&p=a&mlu=4&ilr=4';

const JOIN_QUEUE_FILE    = path.join(__dirname,'join_queue.json');
const JOIN_MAX_PER_DAY       = 15;
const JOIN_ACTIVE_HOUR_START = 8;
const JOIN_ACTIVE_HOUR_END   = 22;
const JOIN_MIN_GAP_MS        = 25 * 60 * 1000;
const JOIN_MAX_GAP_MS        = 75 * 60 * 1000;
const JOIN_QUEUE_MAX         = 30;

const JOINED_GROUPS_FILE = path.join(__dirname,'joined_groups.json');
const PENDING_FILE       = path.join(__dirname,'pending_requests.json');
const LEARNING_DATA_FILE = path.join(__dirname,'learning_data.json');
const GROUP_SETTINGS_FILE= path.join(__dirname,'group_settings.json');
const POLICY_FILE        = path.join(__dirname,'policy_state.json');
const DOWNLOAD_DIR       = path.join(__dirname,'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR,{recursive:true});

const GREETING_MIN_HOURS = 4, GREETING_MAX_HOURS = 8;
const DAILY_REPORT_HOUR  = parseInt(process.env.DAILY_REPORT_HOUR || '22', 10);
const USER_HISTORY_SIZE  = 5;
const PENDING_EXPIRY_MS  = 3600000;
const DM_QUEUE_MAX       = 1000;
const FOCUS_LOCK_TIMEOUT_MS = 30000;
const TZ_OFFSET_HOURS    = parseInt(process.env.TZ_OFFSET_HOURS || '2', 10);
const MEDIA_MAX_BYTES    = 34 * 1024 * 1024;

let MESSAGE_FLOOD_THRESHOLD = 20;
let FLOOD_IGNORE_MS         = 5000;

const NSFW_START = 21, NSFW_END = 8;
const DM_AI_START_HOUR = 21, DM_AI_END_HOUR = 8;
const AMBIENT_CHANCE = 0.02;

const SCRAPER_URL       = (process.env.SCRAPER_URL || 'https://intelligent-scraper.onrender.com').replace(/\/$/,'');
const SCRAPER_SFW_SITE  = process.env.SCRAPER_SFW_SITE  || 'darknaija';
const SCRAPER_NSFW_SITE = process.env.SCRAPER_NSFW_SITE || 'nsfw';

const FAST_LANE_MAX = 5000, SLOW_LANE_MAX = 5000;
const DOWNLOAD_PICK_TTL  = 10 * 60 * 1000;
const DOWNLOAD_MAX_PICKS = 8;

const ADMIN_ACTIVE_MS = 45000;
let adminActiveUntil = 0;
function isAdminActive(){ return Date.now() < adminActiveUntil; }
function touchAdminActive(){ adminActiveUntil = Date.now() + ADMIN_ACTIVE_MS; }

let botPaused = false;
let botOfflineUntil = 0;
let nsfwRoleplayEnabled = true;

/* ══════════════════════════════════════════════════════════════
 *  AI — REWIND ONLY
 * ══════════════════════════════════════════════════════════════ */
const REWIND_KEY_ENV = process.env.REWIND_KEY;
const REWIND_MODEL   = process.env.REWIND_MODEL || 'rewind-uncensored';

let activeProvider = null;
let activeKey = null;
let providerReport = {};

async function testRewind(){
  const key = REWIND_KEY_ENV;
  if (!key){ providerReport.rewind = { ok:false, error:'no key', skipped:true }; return null; }
  const t0 = Date.now();
  try {
    const r = await axios.post('https://api.rewind.ai/v1/chat/completions', {
      model: REWIND_MODEL,
      messages: [
        { role:'system', content:'You are a test bot.' },
        { role:'user', content:'Reply with exactly: OK' }
      ],
      max_tokens: 20, temperature: 0
    }, { headers: { 'Authorization': `Bearer ${key}`, 'Content-Type':'application/json' }, timeout: 15000 });
    const reply = r.data?.choices?.[0]?.message?.content;
    const ms = Date.now() - t0;
    if (reply && reply.trim().length){
      providerReport.rewind = { ok:true, ms, sample: reply.trim().slice(0,40) };
      return { name:'rewind', key };
    }
    providerReport.rewind = { ok:false, error:'empty response', ms };
    return null;
  } catch(e){
    providerReport.rewind = { ok:false, ms: Date.now()-t0, status:e.response?.status,
      error: e.response?.data?.error?.message || e.message };
    return null;
  }
}

async function detectAIBackend(){
  pushLog('info','ai','Testing Rewind...');
  providerReport = {};
  const found = await testRewind();
  if (found){
    activeProvider = 'rewind';
    activeKey = found.key;
    pushLog('success','ai',`rewind: OK ${providerReport.rewind.ms}ms — active`);
  } else {
    activeProvider = null; activeKey = null;
    pushLog('error','ai',`Rewind unavailable: ${providerReport.rewind?.error || 'unknown'}`);
  }
  return activeProvider;
}

async function askAI(prompt, system){
  if (!activeProvider || !activeKey) return null;
  try {
    const r = await axios.post('https://api.rewind.ai/v1/chat/completions', {
      model: REWIND_MODEL,
      messages: [
        { role:'system', content: system },
        { role:'user', content: prompt }
      ],
      max_tokens: 250, temperature: 0.95
    }, { headers: { 'Authorization': `Bearer ${activeKey}`, 'Content-Type':'application/json' }, timeout: 25000 });
    const raw = r.data?.choices?.[0]?.message?.content;
    if (!raw) return null;
    const c = humanize(raw);
    return (c && !containsForbidden(c)) ? c : null;
  } catch(e){
    pushLog('error','ai',`rewind: ${e.response?.status||''} ${e.message}`);
    resetDailyStats(); dailyStats.aiErrors++;
    return null;
  }
}

async function testAllProviders(){
  await testRewind();
  return { rewind: providerReport.rewind || { ok:false, error:'not tested' } };
}

/* ══════════════════════════════════════════════════════════════
 *  PER-JID SEND LOCK
 * ══════════════════════════════════════════════════════════════ */
const jidLockMap = new Map();
async function withJidLock(jid, fn){
  while (jidLockMap.has(jid)){
    try { await jidLockMap.get(jid); } catch(e){}
  }
  let release;
  const lock = new Promise(r => release = r);
  jidLockMap.set(jid, lock);
  try { return await fn(); }
  finally { jidLockMap.delete(jid); release(); }
}

/* ══════════════════════════════════════════════════════════════
 *  FIBONACCI DELAYS
 * ══════════════════════════════════════════════════════════════ */
const FIB_TABLES = {
  broadcast: [10, 20, 30, 50, 80, 130, 210],
  dmreply:   [5, 8, 13, 21, 34, 55, 89],
  group:     [3, 5, 8, 13, 21, 34, 55],
  admin:     [1, 1, 2, 3, 5, 8, 13],
  join:      [600, 900, 1200, 1800, 2700]
};
const fibIdx = { broadcast:0, dmreply:0, group:0, admin:0, join:0 };

function nextFibDelayMs(taskType){
  const tbl = FIB_TABLES[taskType] || FIB_TABLES.group;
  const i = fibIdx[taskType] || 0;
  const secs = tbl[Math.min(i, tbl.length - 1)];
  if (i >= tbl.length - 1 && Math.random() < 0.4){
    fibIdx[taskType] = Math.floor(Math.random() * 3);
  } else {
    fibIdx[taskType] = i + 1;
  }
  return secs * 1000;
}

/* ══════════════════════════════════════════════════════════════
 *  TASK ROTATION
 * ══════════════════════════════════════════════════════════════ */
const rotationState = { lastType:null, streak:0, MAX_STREAK:3 };
function pickRotationSlot(jobType){
  if (jobType !== rotationState.lastType){
    rotationState.lastType = jobType;
    rotationState.streak = 1;
    return jobType;
  }
  rotationState.streak += 1;
  if (rotationState.streak > rotationState.MAX_STREAK){
    rotationState.streak = 0;
    rotationState.lastType = 'rotate';
    return null;
  }
  return jobType;
}

/* ══════════════════════════════════════════════════════════════
 *  REPLY RATIO MONITOR
 * ══════════════════════════════════════════════════════════════ */
const replyTracker = {
  sends: [], MAX: 50, MIN_RATE: 0.15,
  BROADCAST_PAUSE_MS: 6 * 60 * 60 * 1000, pausedUntil: 0
};
function recordOutbound(jid){
  const entry = { jid, ts: Date.now(), replied: false };
  replyTracker.sends.push(entry);
  if (replyTracker.sends.length > replyTracker.MAX) replyTracker.sends.shift();
  return entry;
}
function recordReply(jid){
  for (let i = replyTracker.sends.length - 1; i >= 0; i--){
    const e = replyTracker.sends[i];
    if (e.jid === jid && !e.replied){ e.replied = true; return; }
  }
}
function replyRate(){
  if (!replyTracker.sends.length) return 1;
  return replyTracker.sends.filter(e => e.replied).length / replyTracker.sends.length;
}
function checkReplyRatio(){
  if (replyTracker.sends.length < 20) return;
  const rate = replyRate();
  if (rate < replyTracker.MIN_RATE && Date.now() > replyTracker.pausedUntil){
    replyTracker.pausedUntil = Date.now() + replyTracker.BROADCAST_PAUSE_MS;
    pushLog('warn','policy',`Reply rate ${(rate*100).toFixed(0)}% < 15% — broadcasts paused 6h`);
  }
}
function broadcastsAllowed(){ return Date.now() >= replyTracker.pausedUntil; }

/* ══════════════════════════════════════════════════════════════
 *  POLICY LAYER
 * ══════════════════════════════════════════════════════════════ */
const PER_RECIPIENT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function dailyRecipientLimit(ageDays){
  if (ageDays < 1) return 20;
  if (ageDays < 3) return 40;
  if (ageDays < 7) return 80;
  if (ageDays < 14) return 150;
  if (ageDays < 30) return 300;
  return 1000;
}
function dailyJoinLimit(_ageDays){ return JOIN_MAX_PER_DAY; }

let policyState = {
  firstRunAt: Date.now(),
  day: new Date().toISOString().slice(0,10),
  dailyRecipients: {}, dailyJoins: 0, recipientLastSent: {}
};
function loadPolicy(){
  try {
    if (fs.existsSync(POLICY_FILE)){
      const loaded = JSON.parse(fs.readFileSync(POLICY_FILE,'utf8'));
      Object.assign(policyState, loaded);
    }
  } catch(e){}
  const today = new Date().toISOString().slice(0,10);
  if (policyState.day !== today){
    policyState.day = today;
    policyState.dailyRecipients = {};
    policyState.dailyJoins = 0;
  }
}
function savePolicy(){
  try { fs.writeFileSync(POLICY_FILE, JSON.stringify(policyState, null, 2)); } catch(e){}
}
function getAccountAgeDays(){
  return Math.floor((Date.now() - policyState.firstRunAt) / (24*60*60*1000));
}
function prunePolicyMaps(){
  const now = Date.now();
  for (const [jid, ts] of Object.entries(policyState.recipientLastSent)){
    if (now - ts > PER_RECIPIENT_COOLDOWN_MS) delete policyState.recipientLastSent[jid];
  }
  savePolicy();
}
function policyCanSend(jid){
  const ageDays = getAccountAgeDays();
  const limit = dailyRecipientLimit(ageDays);
  const todayCount = Object.keys(policyState.dailyRecipients).length;
  const last = policyState.recipientLastSent[jid];
  if (last && Date.now() - last < PER_RECIPIENT_COOLDOWN_MS){
    const remH = Math.ceil((PER_RECIPIENT_COOLDOWN_MS - (Date.now()-last)) / 3600000);
    return { ok: false, reason: `recipient cooldown (${remH}h)` };
  }
  if (!policyState.dailyRecipients[jid] && todayCount >= limit){
    return { ok: false, reason: `daily cap (${todayCount}/${limit})` };
  }
  return { ok: true };
}
function policyRecordSend(jid){
  policyState.dailyRecipients[jid] = (policyState.dailyRecipients[jid]||0) + 1;
  policyState.recipientLastSent[jid] = Date.now();
  savePolicy();
}
function policyCanJoin(){
  const ageDays = getAccountAgeDays();
  const limit = dailyJoinLimit(ageDays);
  if (policyState.dailyJoins >= limit) return { ok:false, reason:`join cap (${policyState.dailyJoins}/${limit})` };
  if (joinQueue.length >= JOIN_QUEUE_MAX) return { ok:false, reason:`queue full (${JOIN_QUEUE_MAX})` };
  return { ok:true };
}
function policyRecordJoin(){ policyState.dailyJoins += 1; savePolicy(); }

/* ══════════════════════════════════════════════════════════════
 *  DELETE RATE CAP
 * ══════════════════════════════════════════════════════════════ */
const deleteHist = { min: [], hour: [], day: [] };
function deleteAllowed(){
  const now = Date.now();
  deleteHist.min  = deleteHist.min.filter(t => now - t < 60_000);
  deleteHist.hour = deleteHist.hour.filter(t => now - t < 3_600_000);
  deleteHist.day  = deleteHist.day.filter(t => now - t < 86_400_000);
  if (deleteHist.min.length  >= 5)  return false;
  if (deleteHist.hour.length >= 30) return false;
  if (deleteHist.day.length  >= 100) return false;
  return true;
}
function recordDelete(){
  const now = Date.now();
  deleteHist.min.push(now);
  deleteHist.hour.push(now);
  deleteHist.day.push(now);
}

/* ══════════════════════════════════════════════════════════════
 *  CONTENT BLOCK
 * ══════════════════════════════════════════════════════════════ */
const CONTENT_BLOCKLIST = [
  /\bteen(s|ager|agers)?\b/i, /\bchild(ren)?\b/i, /\bunderage\b/i,
  /\bminor(s)?\b/i, /\bpreteen\b/i, /\bloli\b/i, /\bshota\b/i,
  /\bschool\s*(girl|boy)/i, /\bhorny\b/i, /\bhrny\b/i, /\bdtf\b/i,
  /\bsext(ing)?\b/i
];
function contentBlocked(text){
  if (!ENABLE_CONTENT_BLOCK) return null;
  if (!text) return null;
  for (const re of CONTENT_BLOCKLIST){ if (re.test(String(text))) return re.source; }
  return null;
}

/* ══════════════════════════════════════════════════════════════
 *  DISCONNECT HELPERS
 * ══════════════════════════════════════════════════════════════ */
function getDisconnectStatusCode(lastDisconnect) {
  if (!lastDisconnect) return undefined;
  return (
    lastDisconnect.error?.output?.statusCode ??
    lastDisconnect.error?.output?.payload?.statusCode ??
    lastDisconnect.error?.data?.statusCode ??
    lastDisconnect.error?.statusCode ??
    lastDisconnect.statusCode
  );
}
function describeDisconnect(lastDisconnect){
  const code = getDisconnectStatusCode(lastDisconnect);
  const msg = lastDisconnect?.error?.message
    || lastDisconnect?.error?.output?.payload?.message
    || lastDisconnect?.error?.output?.payload?.error
    || 'no reason';
  return { code, msg };
}

/* ══════════════════════════════════════════════════════════════
 *  LOGGER
 * ══════════════════════════════════════════════════════════════ */
const LOG_BUFFER_MAX = 500, logBuffer=[], logClients=new Set();
const LIVE_MSG_MAX   = 300, liveMessages=[], msgClients=new Set();

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
let sock=null, qrDataUri=null;
let connectionStatus='disconnected', botStartTime=Date.now(), botNumber=null, botJid=null;
let botLid=null;
let isConnecting=false, manualDisconnect=false;
let reconnectAttempts=0; const MAX_RECONNECT=10;

let restart515InFlight=false, lastReconnectAt=0;
let consecutive515=0, recent515Timestamps=[], spamCooldownUntil=0;
const RESTART_515_BASE_DELAY_MS=1500, RESTART_515_MAX_DELAY_MS=30000;
const MIN_RECONNECT_INTERVAL_MS=10000, SPAM_WINDOW_MS=60000;
const SPAM_THRESHOLD=3, SPAM_COOLDOWN_MS=60000;

let mainGroupJid = null;

const botSentIds = new Set();
const processedMessages = new Set();
const activeChats = new Set();
const activeDMs = new Set();
const userHistories = new Map();
const pendingRequests = new Map();
const joinedGroups = new Map();
const lastGreetingAt = new Map();
const learningData = new Map();
const adminLids = new Set(HARDCODED_ADMIN_LIDS);
const recentAdminCmds = new Map();
const downloadPicks = new Map();
const recentJoinAttempts = new Map();
const antilinkWarnCooldown = new Map();
const groupAdminCache = new Map();
const recentGroupLids = new Map();
const recentGroupPhones = new Map();

let joinQueue=[], joinInProgress=false, lastJoinAt=0;
let dmQueue=[], dmQueueProcessing=false;

let dailyStats=null, lastDailyReportDate=null;
function resetDailyStats(){
  const today = new Date().toISOString().slice(0,10);
  if (lastDailyReportDate !== today){
    dailyStats = { date:today, joined:0, failed:0, dmsReplied:0, broadcastsSent:0, greetingsSent:0,
      scraperSearches:0, scraperGifs:0, picsSent:0, videosSent:0, nsfwSent:0, aiErrors:0,
      pendingCreated:0, pendingResolved:0, discovered:0, imageBroadcasts:0, badMacs:0,
      focusRuns:0, downloads:0, nsfwDownloads:0, adminBroadcasts:0, groupLinksShared:0,
      messagesDropped:0, errors:0, invitesSent:0, policyBlocks:0, deletesDone:0, readsSent:0, typingsSent:0 };
  }
}
resetDailyStats();

/* ══════════════════════════════════════════════════════════════
 *  FIX: markBotSent — was missing in v63
 * ══════════════════════════════════════════════════════════════ */
function markBotSent(id){
  if (!id) return;
  botSentIds.add(id);
  if (botSentIds.size > 5000){
    const a = [...botSentIds];
    botSentIds.clear();
    for (const i of a.slice(-2500)) botSentIds.add(i);
  }
}

/* ══════════════════════════════════════════════════════════════
 *  FIX: getSelfLid — was called but never defined in v63
 * ══════════════════════════════════════════════════════════════ */
function getSelfLid(){
  try {
    const candidates = [
      sock?.user?.lid,
      sock?.authState?.creds?.me?.lid,
      sock?.creds?.me?.lid,
      sock?.user?.id?.includes('@lid') ? sock.user.id : null
    ];
    for (const c of candidates){
      if (typeof c === 'string' && c.includes('@lid')){
        return c.split('@')[0].split(':')[0];
      }
    }
  } catch(e){}
  return null;
}

/* ══════════════════════════════════════════════════════════════
 *  DUAL QUEUE
 * ══════════════════════════════════════════════════════════════ */
class DualQueue {
  constructor(){
    this.fast=[]; this.slow=[];
    this.fastRunning=false; this.slowRunning=false;
    this.fastRun=0; this.fastFail=0; this.fastDrop=0;
    this.slowRun=0; this.slowFail=0; this.slowDrop=0;
  }
  pushFast(job){
    if (this.fast.length >= FAST_LANE_MAX){ this.fast.shift(); this.fastDrop++; }
    job.ts = Date.now(); this.fast.push(job); this._pumpFast();
  }
  pushSlow(job){
    if (this.slow.length >= SLOW_LANE_MAX){
      this.slow.sort((a,b)=>b.priority-a.priority || a.ts-b.ts);
      this.slow.pop(); this.slowDrop++;
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
      await new Promise(r=>setTimeout(r, nextFibDelayMs('admin')));
    }
    this.fastRunning = false;
  }
  async _pumpSlow(){
    if (this.slowRunning) return;
    this.slowRunning = true;
    while (this.slow.length){
      if (isAdminActive()){
        const wait = adminActiveUntil - Date.now() + 500;
        if (wait > 0){
          pushLog('info','queue',`Admin active — pausing slow lane ${Math.ceil(wait/1000)}s`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
      }
      const job = this.slow.shift();
      const rotated = pickRotationSlot(job.taskType || 'group');
      if (rotated === null){
        const altIdx = this.slow.findIndex(j => (j.taskType||'group') !== job.taskType);
        if (altIdx >= 0){
          const alt = this.slow.splice(altIdx,1)[0];
          this.slow.push(job);
          this.slow.sort((a,b)=>a.priority-b.priority || a.ts-b.ts);
          try { await alt.fn(); this.slowRun++; } catch(e){ this.slowFail++; }
          await new Promise(r=>setTimeout(r, nextFibDelayMs(alt.taskType||'group')));
          continue;
        }
      }
      try { await job.fn(); this.slowRun++; }
      catch(e){ this.slowFail++; pushLog('error','slowlane',`${job.name}: ${e.message}`); }
      await new Promise(r=>setTimeout(r, nextFibDelayMs(job.taskType || 'group')));
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
 *  FOCUS PIPELINE
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
 *  HELPERS — LID/PN aware
 * ══════════════════════════════════════════════════════════════ */
function extractAllPhoneCandidates(msg, senderJid){
  const s = new Set();
  const c = [
    msg.key?.participantPn,
    msg.key?.senderPn,
    msg.key?.remoteJidAlt,
    msg.key?.participantAlt,
    senderJid,
    msg.key?.remoteJid,
    msg.key?.participant
  ].filter(Boolean);
  for (const x of c){
    if (typeof x === 'string'){
      const d = x.split('@')[0].split(':')[0].replace(/\D/g,'');
      if (d.length >= 10) s.add(d);
    }
  }
  return [...s];
}

function extractLidFromMsg(msg, senderJid){
  const c = [senderJid, msg.key?.remoteJid, msg.key?.participant].filter(Boolean);
  for (const x of c){
    if (typeof x === 'string' && x.includes('@lid')) return x.split('@')[0];
  }
  return null;
}

function extractPnFromMsg(msg, senderJid){
  if (msg.key?.participantAlt && msg.key.participantAlt.includes('@s.whatsapp.net')){
    return msg.key.participantAlt.split('@')[0];
  }
  if (msg.key?.remoteJidAlt && msg.key.remoteJidAlt.includes('@s.whatsapp.net')){
    return msg.key.remoteJidAlt.split('@')[0];
  }
  const c = [senderJid, msg.key?.remoteJid, msg.key?.participant].filter(Boolean);
  for (const x of c){
    if (typeof x === 'string' && x.includes('@s.whatsapp.net')){
      return x.split('@')[0];
    }
  }
  return null;
}

/* ══════════════════════════════════════════════════════════════
 *  ADMIN DETECTION — LID-aware
 * ══════════════════════════════════════════════════════════════ */
function announceAdminToLive(reason, extraLid){
  const lidList = [...adminLids];
  pushLiveMessage({
    id: 'admin-' + Date.now(), ts: new Date().toISOString(),
    chatJid: ADMIN_JID, chatType: 'system',
    senderJid: ADMIN_JID, senderName: 'ADMIN',
    phone: ADMIN_PHONE,
    lid: extraLid ? `${extraLid}${lidList.length>1?' (+'+(lidList.length-1)+' more)':''}` : (lidList.join(', ')||'-'),
    text: `Admin ${reason}\nPhone: ${ADMIN_PHONE}\nLIDs: ${lidList.join(', ')||'none'}`,
    mediaType: 'system', isAdmin: true
  });
  pushLog('success','admin',`Live-log: ${reason} - LIDs [${lidList.join(', ')||'none'}]`);
}

function isAdminSender(msg, senderJid){
  const candidates = extractAllPhoneCandidates(msg, senderJid);
  const lid = extractLidFromMsg(msg, senderJid);
  const pn = extractPnFromMsg(msg, senderJid);

  if (candidates.includes(ADMIN_PHONE)){
    if (lid && !adminLids.has(lid)){
      adminLids.add(lid);
      saveAdminLids();
      pushLog('success','admin',`Saved new admin LID: ${lid}`);
      announceAdminToLive('identified (first time)', lid);
    }
    return true;
  }
  if (lid && adminLids.has(lid)) return true;
  if (pn && pn === ADMIN_PHONE) return true;
  if (pn && adminLids.has(pn)) return true;
  if (typeof senderJid === 'string'){
    const base = senderJid.split('@')[0].split(':')[0];
    if (base === ADMIN_PHONE) return true;
    if (adminLids.has(base)) return true;
  }
  for (const c of candidates) if (adminLids.has(c)) return true;
  return false;
}

function extractPhone(msg, senderJid){
  const c = extractAllPhoneCandidates(msg, senderJid);
  return c[0] || null;
}
function extractLid(msg, senderJid){ return extractLidFromMsg(msg, senderJid); }

/* ══════════════════════════════════════════════════════════════
 *  BOT SELF-DETECTION — LID-aware + lazy refresh
 * ══════════════════════════════════════════════════════════════ */
function isBotSender(msg, senderJid){
  if (!botLid){
    const fresh = getSelfLid();
    if (fresh){ botLid = fresh; pushLog('success','bot','Bot LID learned: '+botLid); }
  }
  const candidates = extractAllPhoneCandidates(msg, senderJid);
  const lid = extractLidFromMsg(msg, senderJid);
  const pn = extractPnFromMsg(msg, senderJid);

  if (botNumber && candidates.includes(botNumber)) return true;
  if (botLid && lid === botLid) return true;
  if (botLid && candidates.includes(botLid)) return true;
  if (botNumber && pn === botNumber) return true;
  if (botJid){
    const botBase = botJid.split('@')[0].split(':')[0];
    if (senderJid && senderJid.includes(botBase)) return true;
    if (candidates.includes(botBase)) return true;
  }
  return false;
}

async function botIsAdminIn(jid){
  const c = groupAdminCache.get(jid);
  if (c && Date.now() - c.ts < 60000) return c.botIsAdmin;
  try {
    const meta = await sock.groupMetadata(jid);
    const me = meta.participants.find(p => {
      if (p.id && p.id.split('@')[0].split(':')[0] === botNumber) return true;
      if (p.phoneNumber && p.phoneNumber.split('@')[0] === botNumber) return true;
      if (p.lid && botLid && p.lid === botLid) return true;
      if (botJid && p.id && p.id === botJid) return true;
      return false;
    });
    const isAdmin = !!(me && (me.admin === 'admin' || me.admin === 'superadmin'));
    groupAdminCache.set(jid, { botIsAdmin: isAdmin, ts: Date.now() });
    return isAdmin;
  } catch(e){
    groupAdminCache.set(jid, { botIsAdmin: false, ts: Date.now() });
    return false;
  }
}

async function getGroupAdmins(jid){
  try {
    const meta = await sock.groupMetadata(jid);
    const admins = meta.participants.filter(p => p.admin === 'admin' || p.admin === 'superadmin');
    return admins.map(p => ({
      id: p.id,
      phoneNumber: p.phoneNumber || null,
      lid: p.lid || null,
      role: p.admin
    }));
  } catch(e){
    return [];
  }
}

/* ══════════════════════════════════════════════════════════════
 *  READ + TYPING
 * ══════════════════════════════════════════════════════════════ */
async function markRead(msg){
  if (!ENABLE_READ_RECEIPTS || !sock || !msg?.key) return;
  try {
    await sock.readMessages([msg.key]);
    resetDailyStats(); dailyStats.readsSent++;
  } catch(e){}
}

/* ══════════════════════════════════════════════════════════════
 *  INVITE RESOLUTION
 * ══════════════════════════════════════════════════════════════ */
function extractInviteCodes(text){
  if (!text) return [];
  const s = new Set();
  const re = /chat\.whatsapp\.com\/([A-Za-z0-9]{15,30})/gi;
  let m;
  while ((m = re.exec(String(text))) !== null) s.add(m[1]);
  return [...s];
}
function extractInviteCode(text){
  const all = extractInviteCodes(text);
  return all.length ? all[0] : null;
}
async function resolveInviteToJid(link){
  const code = extractInviteCode(link);
  if (!code) throw new Error('No invite code found in link');
  const info = await sock.groupGetInviteInfo(code);
  if (!info || !info.id) throw new Error('Could not resolve invite');
  return { code, jid: info.id, subject: info.subject || 'unknown', size: info.size || 0 };
}

/* ══════════════════════════════════════════════════════════════
 *  34 MB ENFORCEMENT
 * ══════════════════════════════════════════════════════════════ */
async function downloadAndCheck(url, maxBytes = MEDIA_MAX_BYTES, expectType = 'image'){
  const resp = await axios.get(url, {
    responseType: 'arraybuffer', timeout: 60000,
    maxContentLength: maxBytes + 1, maxBodyLength: maxBytes + 1,
    validateStatus: s => s >= 200 && s < 300,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BreadBot/1.0)' }
  });
  const buf = Buffer.from(resp.data);
  if (buf.length > maxBytes) throw new Error(`Media too big (${(buf.length/1024/1024).toFixed(1)}MB > 34MB)`);
  if (buf.length < 32) throw new Error('Media empty');
  const mimetype = resp.headers['content-type'] || (expectType === 'gif' ? 'video/mp4' : 'image/jpeg');
  return { buffer: buf, mimetype, sizeBytes: buf.length };
}
async function sendImageSafe(jid, url, caption='', priority=2, lane='slow', taskType='group', typing=false){
  try {
    const { buffer, mimetype } = await downloadAndCheck(url, MEDIA_MAX_BYTES, 'image');
    await sendBuffer(jid, { image: buffer, caption, mimetype }, priority, lane, taskType, typing);
    return true;
  } catch(e){
    pushLog('warn','media',`image skip: ${e.message}`);
    try { await sendBuffer(jid, { text: `${caption}\n${url}`.trim() }, priority, lane, taskType, typing); } catch(_){}
    return false;
  }
}
async function sendGifSafe(jid, url, caption='', priority=2, lane='slow', taskType='group', typing=false){
  try {
    const { buffer } = await downloadAndCheck(url, MEDIA_MAX_BYTES, 'gif');
    await sendBuffer(jid, { video: buffer, gifPlayback: true, caption, mimetype: 'video/mp4' }, priority, lane, taskType, typing);
    return true;
  } catch(e){
    pushLog('warn','media',`gif skip: ${e.message}`);
    try { await sendBuffer(jid, { text: `${caption}\n${url}`.trim() }, priority, lane, taskType, typing); } catch(_){}
    return false;
  }
}

/* ══════════════════════════════════════════════════════════════
 *  SEND — per-JID lock + admin preemption
 * ══════════════════════════════════════════════════════════════ */
function sendBuffer(jid, content, priority=2, lane='auto', taskType='group', typing=false){
  if (priority >= 2){
    const gate = policyCanSend(jid);
    if (!gate.ok){
      pushLog('warn','policy',`Send blocked to ${jid}: ${gate.reason}`);
      resetDailyStats(); dailyStats.policyBlocks++;
      return Promise.reject(new Error(`Policy: ${gate.reason}`));
    }
    const txt = (content && (content.text || content.caption)) || '';
    const hit = contentBlocked(txt);
    if (hit){
      pushLog('error','policy',`Content blocked (${hit})`);
      resetDailyStats(); dailyStats.policyBlocks++;
      return Promise.reject(new Error('Content blocked'));
    }
  }

  const actualLane = lane === 'auto' ? (priority === 0 ? 'fast' : 'slow') : lane;
  if (priority >= 2) recordOutbound(jid);
  const showTyping_ = typing && priority >= 2 && ENABLE_TYPING;

  return new Promise((resolve, reject)=>{
    const job = {
      name:`send:${jid}`, priority, taskType,
      fn: async ()=>{
        if (!sock){ reject(new Error('Bot disconnected')); return; }
        if (botPaused && priority > 0){ reject(new Error('Bot paused')); return; }
        if (Date.now() < botOfflineUntil && priority > 0){ reject(new Error('Bot offline')); return; }

        return withJidLock(jid, async ()=>{
          if (showTyping_){
            try { await sock.sendPresenceUpdate('composing', jid); } catch(e){}
            const ms = 1500 + Math.random() * 4500;
            await new Promise(r => setTimeout(r, ms));
            try { await sock.sendPresenceUpdate('paused', jid); } catch(e){}
            await new Promise(r => setTimeout(r, 200 + Math.random() * 400));
            resetDailyStats(); dailyStats.typingsSent++;
          }
          try {
            const sent = await sock.sendMessage(jid, content);
            if (sent?.key?.id) markBotSent(sent.key.id);
            if (priority >= 2) policyRecordSend(jid);
            resolve(sent);
          } catch(e){ reject(e); }
        });
      }
    };
    if (actualLane === 'fast') jobs.pushFast(job);
    else jobs.pushSlow(job);
  });
}
function adminReply(jid, text){
  return sendBuffer(jid, { text }, 0, 'fast', 'admin', false)
    .catch(e => pushLog('warn','adminreply',e.message));
}

/* ══════════════════════════════════════════════════════════════
 *  SCRAPER
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
 *  YOUTUBE + Y2MATE
 * ══════════════════════════════════════════════════════════════ */
const YT_HEADERS = {
  'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
};
const Y2MATE_HOSTS = ['www.y2mate.com','y2mate.com','y2mate.nu','y2mate.guru'];
let workingY2MateHost = null;
async function findWorkingY2MateHost(){
  for (const host of Y2MATE_HOSTS){
    try {
      const r = await axios.get(`https://${host}/`, { timeout: 5000, validateStatus: s => s < 500 });
      if (r.status < 500){ workingY2MateHost = host; return host; }
    } catch(e){}
  }
  return null;
}
function y2host(){ return workingY2MateHost || Y2MATE_HOSTS[0]; }
function y2Headers(){
  return {
    'User-Agent': YT_HEADERS['User-Agent'],
    'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8',
    'X-Requested-With':'XMLHttpRequest',
    'Origin': `https://${y2host()}`,
    'Referer': `https://${y2host()}/`
  };
}

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
    `https://${y2host()}/mates/en948/analyze/ajax`,
    new URLSearchParams({ url: ytUrl, q_auto:'0', ajax:'1' }).toString(),
    { headers: y2Headers(), timeout:30000 }
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
        `https://${y2host()}/mates/convert`,
        new URLSearchParams({ type:'video', _id:id, v_id:vId, ajax:'1', token:'', ftype:'mp4', fquality:q }).toString(),
        { headers: y2Headers(), timeout:30000 }
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
    headers: { 'User-Agent': YT_HEADERS['User-Agent'], 'Referer': `https://${y2host()}/` }
  });
  const w = fs.createWriteStream(fp);
  resp.data.pipe(w);
  await new Promise((res,rej)=>{ w.on('finish',res); w.on('error',rej); resp.data.on('error',rej); });
  const st = fs.statSync(fp);
  if (st.size > MEDIA_MAX_BYTES){ try{ fs.unlinkSync(fp); }catch(e){} throw new Error('Video too big'); }
  return { filePath:fp, quality, sizeBytes:st.size };
}
async function y2mateDownloadMusic(videoId, format='mp3'){
  const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const analyze = await axios.post(
    `https://${y2host()}/mates/en948/analyze/ajax`,
    new URLSearchParams({ url: ytUrl, q_auto:'0', ajax:'1' }).toString(),
    { headers: y2Headers(), timeout:30000 }
  );
  const html = analyze.data?.result || '';
  const vId = (html.match(/v_id["']?\s*[:=]\s*["']([^"']+)/)||[])[1];
  const id  = (html.match(/_id["']?\s*[:=]\s*["']([^"']+)/)||[])[1];
  if (!vId || !id) throw new Error('y2mate: audio not found');
  const ftype = format === 'mp3' ? 'mp3' : 'mp4';
  const conv = await axios.post(
    `https://${y2host()}/mates/convert`,
    new URLSearchParams({ type:'audio', _id:id, v_id:vId, ajax:'1', token:'', ftype, fquality:'128' }).toString(),
    { headers: y2Headers(), timeout:30000 }
  );
  const ch = conv.data?.result || '';
  const dl = (ch.match(/href="(https?:\/\/[^"]+\.(mp3|mp4|m4a)[^"]*)"/)||[])[1]
          || (ch.match(/href="(https?:\/\/[^"]+)"/)||[])[1];
  if (!dl) throw new Error('y2mate: no music link');
  const fileId = Date.now()+'_'+Math.random().toString(36).slice(2,8);
  const ext = format === 'mp3' ? '.mp3' : '.mp4';
  const fp = path.join(DOWNLOAD_DIR, `${fileId}${ext}`);
  const resp = await axios.get(dl, {
    responseType: 'stream', timeout: 180000, maxContentLength: MEDIA_MAX_BYTES,
    headers: { 'User-Agent': YT_HEADERS['User-Agent'], 'Referer': `https://${y2host()}/` }
  });
  const w = fs.createWriteStream(fp);
  resp.data.pipe(w);
  await new Promise((res,rej)=>{ w.on('finish',res); w.on('error',rej); resp.data.on('error',rej); });
  const st = fs.statSync(fp);
  if (st.size > MEDIA_MAX_BYTES){ try{ fs.unlinkSync(fp); }catch(e){} throw new Error('File too big'); }
  return { filePath:fp, format, sizeBytes:st.size };
}
async function sendMediaFile(jid, filePath, caption='', priority=2, lane='slow', taskType='group', typing=false){
  try {
    const buf = fs.readFileSync(filePath);
    if (buf.length > MEDIA_MAX_BYTES){ try{ fs.unlinkSync(filePath); }catch(e){} throw new Error('File too big'); }
    const ext = path.extname(filePath).toLowerCase();
    const isAudio = ext === '.mp3' || ext === '.m4a';
    const content = isAudio
      ? { audio: buf, mimetype: 'audio/mpeg', caption }
      : { video: buf, mimetype: 'video/mp4', caption };
    await sendBuffer(jid, content, priority, lane, taskType, typing);
    try{ fs.unlinkSync(filePath); }catch(e){}
    return true;
  } catch(e){
    try{ fs.unlinkSync(filePath); }catch(_){}
    throw e;
  }
}

/* ══════════════════════════════════════════════════════════════
 *  NSFW
 * ══════════════════════════════════════════════════════════════ */
async function nsfwVideoSearchAndSend(chatJid, query, priority=2, lane='slow', taskType='group', typing=false){
  if (!RedgifsDownloader){
    await sendBuffer(chatJid, { text: 'NSFW downloader not installed. Run: npm i redgifs-downloader' }, priority, lane, taskType, typing);
    return false;
  }
  try {
    const links = await RedgifsDownloader.getSearchLinks(query, { numberToDownload: 3 });
    if (!links || !links.length){
      await sendBuffer(chatJid, { text: `No NSFW results for "${query}"` }, priority, lane, taskType, typing);
      return false;
    }
    for (const link of links.slice(0, 2)){
      try {
        const resp = await axios.get(link.url || link, {
          responseType: 'arraybuffer', timeout: 90000,
          maxContentLength: MEDIA_MAX_BYTES + 1, maxBodyLength: MEDIA_MAX_BYTES + 1,
          headers: { 'User-Agent': YT_HEADERS['User-Agent'] }
        });
        const buf = Buffer.from(resp.data);
        if (buf.length > MEDIA_MAX_BYTES) continue;
        await sendBuffer(chatJid, { video: buf, mimetype: 'video/mp4', caption: `NSFW ${query}` }, priority, lane, taskType, typing);
        resetDailyStats(); dailyStats.nsfwSent++;
        return true;
      } catch(e){ pushLog('warn','nsfw',e.message); }
    }
    return false;
  } catch(e){
    pushLog('error','nsfw',e.message);
    await sendBuffer(chatJid, { text: `NSFW search failed: ${e.message}` }, priority, lane, taskType, typing);
    return false;
  }
}
async function nsfwRoleplay(userName, text){
  const sys = `You are Abby Faith Sithole, a real Zimbabwean girl, 23. NSFW roleplay. Flirty, seductive, 1-2 sentences. Casual Shona/English. If uncomfortable, stay silent. Never mention AI.`;
  const aiReply = await askAI(`User ${userName} says: "${text}". Reply as Abby.`, sys);
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
    q = q.replace(/\b(song|songs|album|albums|music|track|tracks|mixtape)\b/gi,'').replace(/\b(of|by|from|for)\b/gi,'');
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
      .replace(/\b(youtube|video|vid|song|music)\b/gi,'').replace(/\b(of|from|for|by)\b/gi,'')
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
function saveAdminLids(){ try { fs.writeFileSync(ADMIN_LID_FILE, JSON.stringify([...adminLids],null,2)); } catch(e){} }
let groupSettings = new Map();
function loadGroupSettings(){
  try { if (fs.existsSync(GROUP_SETTINGS_FILE))
    groupSettings = new Map(Object.entries(JSON.parse(fs.readFileSync(GROUP_SETTINGS_FILE,'utf8')))); } catch(e){}
}
let groupSettingsDirty=false;
function saveGroupSettingsDebounced(){
  if (groupSettingsDirty) return;
  groupSettingsDirty = true;
  setTimeout(()=>{
    try { fs.writeFileSync(GROUP_SETTINGS_FILE, JSON.stringify(Object.fromEntries(groupSettings),null,2)); } catch(e){}
    groupSettingsDirty = false;
  }, 5000);
}
function getGroupSetting(jid){
  if (!groupSettings.has(jid)){
    groupSettings.set(jid, { antilink:true, welcome:true, goodbye:true,
      welcomeMsg:'Welcome {user}!', goodbyeMsg:'{user} left.' });
    saveGroupSettingsDebounced();
  }
  return groupSettings.get(jid);
}
let learningDirty=false;
function saveLearningDebounced(){
  if (learningDirty) return;
  learningDirty = true;
  setTimeout(()=>{
    try { fs.writeFileSync(LEARNING_DATA_FILE, JSON.stringify(Object.fromEntries(learningData),null,2)); } catch(e){}
    learningDirty = false;
  }, 10000);
}
function loadLearningData(){
  try { if (fs.existsSync(LEARNING_DATA_FILE))
    Object.entries(JSON.parse(fs.readFileSync(LEARNING_DATA_FILE,'utf8'))).forEach(([k,v])=>learningData.set(k,v)); } catch(e){}
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
  try { if (fs.existsSync(JOIN_QUEUE_FILE)) joinQueue = JSON.parse(fs.readFileSync(JOIN_QUEUE_FILE,'utf8')) || []; } catch(e){ joinQueue=[]; }
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
    const saved = fs.readFileSync(MAIN_GROUP_FILE,'utf8').trim();
    if (saved) mainGroupJid = saved;
  } } catch(e){}
  pushLog('info','state',`queue=${joinQueue.length} groups=${joinedGroups.size} pending=${pendingRequests.size} adminLids=${adminLids.size} main=${mainGroupJid||'NOT SET'}`);
}
function setMainGroup(jid){
  mainGroupJid = jid;
  try { fs.writeFileSync(MAIN_GROUP_FILE, jid); } catch(e){}
  pushLog('success','main',`Main group set: ${jid}`);
}
function clearMainGroup(){
  mainGroupJid = null;
  try { if (fs.existsSync(MAIN_GROUP_FILE)) fs.unlinkSync(MAIN_GROUP_FILE); } catch(e){}
  pushLog('warn','main','Main group cleared');
}

/* ══════════════════════════════════════════════════════════════
 *  MAIN GROUP PROBE
 * ══════════════════════════════════════════════════════════════ */
async function probeMainGroup(){
  if (!mainGroupJid || !sock || connectionStatus !== 'connected') return;
  try {
    const sent = await sock.sendMessage(mainGroupJid, { text: 'Anyone online? 👋' });
    if (sent?.key?.id) markBotSent(sent.key.id);
    pushLog('success','main',`Probe sent to ${mainGroupJid}`);
    setTimeout(async () => {
      try {
        const meta = await sock.groupMetadata(mainGroupJid);
        pushLog('info','main',`Main group: ${meta.subject || '?'} (${meta.participants?.length || 0} members)`);
        for (const p of meta.participants || []){
          if (p.id && p.id.includes('@lid')) recentGroupLids.set(p.id.split('@')[0], Date.now());
          if (p.id && p.id.includes('@s.whatsapp.net')) recentGroupPhones.set(p.id.split('@')[0], Date.now());
          if (p.phoneNumber) recentGroupPhones.set(p.phoneNumber.split('@')[0], Date.now());
          if (p.lid) recentGroupLids.set(p.lid, Date.now());
        }
        pushLog('success','main',`Cached ${recentGroupLids.size} LIDs, ${recentGroupPhones.size} phones`);
        const admins = meta.participants.filter(p => p.admin === 'admin' || p.admin === 'superadmin');
        pushLog('info','main',`Group has ${admins.length} admin(s)`);
      } catch(e){ pushLog('warn','main','metadata: '+e.message); }
    }, 15000);
  } catch(e){
    pushLog('warn','main','Probe failed: '+e.message);
  }
}

/* ══════════════════════════════════════════════════════════════
 *  WELCOME / GOODBYE
 * ══════════════════════════════════════════════════════════════ */
async function generateWelcome(userName){
  const ai = await askAI(
    `Write a warm, short WhatsApp welcome for a new member named "${userName}". Max 12 words. Include one emoji.`,
    `You are Abby Faith Sithole, warm Zimbabwean. Casual, real. Mix Shona + English naturally. Never mention AI.`
  );
  if (ai && !containsForbidden(ai)) return informalize(ai);
  return `Welcome ${userName}! Tiri kufara kuva newe.`;
}
async function generateGoodbye(userName){
  const ai = await askAI(
    `Write a short goodbye for a member named "${userName}" leaving a WhatsApp group. Max 10 words.`,
    `You are Abby Faith Sithole, warm Zimbabwean. Casual tone.`
  );
  if (ai && !containsForbidden(ai)) return informalize(ai);
  return `${userName} left.`;
}
async function handleParticipants(update){
  const { id, participants, action } = update;
  if (!mainGroupJid || id !== mainGroupJid) return;
  for (const p of participants){
    const user = p.split('@')[0];
    if (action === 'add'){
      try {
        const msg = await generateWelcome(user);
        await sendBuffer(id, { text: msg, mentions:[p] }, 0, 'fast', 'admin', false);
        pushLog('success','welcome',`Welcomed ${user}`);
      } catch(e){ pushLog('warn','welcome',e.message); }
    }
    if (action === 'remove'){
      try {
        const msg = await generateGoodbye(user);
        await sendBuffer(id, { text: msg }, 0, 'fast', 'admin', false);
      } catch(e){ pushLog('warn','goodbye',e.message); }
    }
  }
}

/* ══════════════════════════════════════════════════════════════
 *  ANTI-LINK
 * ══════════════════════════════════════════════════════════════ */
async function handleAntiLink(jid, msg, text, senderJid, isAdmin){
  if (!mainGroupJid || jid !== mainGroupJid) return false;
  const s = getGroupSetting(jid);
  if (!s.antilink || isAdmin) return false;
  const matches = text.match(/(https?:\/\/[^\s]+)/gi);
  if (!matches || !matches.length) return false;
  if (!deleteAllowed()){ pushLog('warn','antilink','Delete rate cap hit'); return false; }
  const botIsAdmin = await botIsAdminIn(jid);
  if (!botIsAdmin){ pushLog('info','antilink',`Skip delete in ${jid} — not admin`); return false; }
  try { await sock.sendMessage(jid, { delete: msg.key }); recordDelete(); resetDailyStats(); dailyStats.deletesDone++; } catch(e){}
  pushLog('info','antilink',`Deleted link from ${senderJid.split('@')[0]}`);
  const key = `${jid}:${senderJid}`;
  const now = Date.now();
  const last = antilinkWarnCooldown.get(key) || 0;
  if (now - last > 5 * 60 * 1000){
    antilinkWarnCooldown.set(key, now);
    try {
      await sendBuffer(jid, { text: `Links not allowed here, @${senderJid.split('@')[0]}`, mentions: [senderJid] }, 3, 'slow', 'group', false);
    } catch(e){}
  }
  return true;
}

/* ══════════════════════════════════════════════════════════════
 *  JOIN QUEUE
 * ══════════════════════════════════════════════════════════════ */
function queueJoin(code, addedBy='unknown', source='unknown'){
  if (!code) return false;
  const gate = policyCanJoin();
  if (!gate.ok){ pushLog('warn','join',`Rejected ${code} — ${gate.reason}`); return false; }
  if (joinQueue.some(q => q.code === code)) return false;
  const last = recentJoinAttempts.get(code);
  if (last && Date.now() - last < 60 * 60 * 1000){
    pushLog('info','join',`Skipping ${code} — attempted recently`);
    return false;
  }
  joinQueue.push({ code, addedAt:Date.now(), addedBy, source });
  saveQueue();
  pushLog('info','join',`Queued ${code} (${joinQueue.length}/${JOIN_QUEUE_MAX})`);
  return true;
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

/* ══════════════════════════════════════════════════════════════
 *  SCHEDULERS
 * ══════════════════════════════════════════════════════════════ */
const GREETING_PHRASES = {
  morning:['Morning all','Mangwanani guys','Good morning fam'],
  midday:['Hi guys','Hey everyone','Hello fam'],
  evening:['Good evening fam','Evening all','Manheru guys'],
  night:['Good night all','Manheru akanaka','Sleep well fam']
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
  setInterval(async function(){
    if (!sock || connectionStatus!=='connected' || !mainGroupJid || botPaused) return;
    if (Date.now() < botOfflineUntil) return;
    if (isAdminActive()) return;
    const now = Date.now();
    const minMs = GREETING_MIN_HOURS*3600000, maxMs = GREETING_MAX_HOURS*3600000;
    for (const [jid] of joinedGroups){
      if (jid === mainGroupJid) continue;
      const sinceLast = now - (lastGreetingAt.get(jid)||0);
      if (sinceLast < minMs) continue;
      const progress = (sinceLast - minMs) / (maxMs - minMs);
      if (Math.random() > Math.min(progress, 1)) continue;
      try {
        await sendBuffer(jid, { text: pickGreeting(getTimeOfDay()) }, 3, 'slow', 'group', false);
        lastGreetingAt.set(jid, now); resetDailyStats(); dailyStats.greetingsSent++;
      } catch(e){}
    }
    saveGroups();
  }, 900000);
  pushLog('info','system','scheduleGreetings started');
}

function scheduleDailyReport(){
  setInterval(async function(){
    if (!sock || connectionStatus!=='connected') return;
    const now = new Date(); const today = now.toISOString().slice(0,10);
    if (now.getHours() !== DAILY_REPORT_HOUR || lastDailyReportDate === today) return;
    lastDailyReportDate = today; resetDailyStats(); const s = dailyStats;
    try {
      await sock.sendMessage(ADMIN_JID, { text:
        `Daily ${today}\nGroups: ${joinedGroups.size}\nDMs: ${activeDMs.size}\nDM replies: ${s.dmsReplied}\nMedia: ${s.picsSent+s.videosSent}\nDownloads: ${s.downloads}\nBroadcasts: ${s.broadcastsSent}\nDeletes: ${s.deletesDone}\nReads: ${s.readsSent}\nTypings: ${s.typingsSent}\nPolicy blocks: ${s.policyBlocks}\nReply rate: ${(replyRate()*100).toFixed(0)}%\nMain group: ${mainGroupJid||'NOT SET'}` });
    } catch(e){}
  }, 60000);
  pushLog('info','system','scheduleDailyReport started');
}

let nextJoinGapMs = 0;
function scheduleGroupJoins(){
  setInterval(async function(){
    const h = localHour();
    if (h < JOIN_ACTIVE_HOUR_START || h >= JOIN_ACTIVE_HOUR_END) return;
    if (joinInProgress || !sock || connectionStatus !== 'connected' || !joinQueue.length) return;
    if (Date.now() - lastJoinAt < nextJoinGapMs) return;
    if (isAdminActive()) return;

    joinInProgress = true;
    const item = joinQueue.shift();
    saveQueue(); resetDailyStats();
    lastJoinAt = Date.now();
    nextJoinGapMs = JOIN_MIN_GAP_MS + Math.random() * (JOIN_MAX_GAP_MS - JOIN_MIN_GAP_MS);
    recentJoinAttempts.set(item.code, Date.now());

    try {
      pushLog('info','join',`Joining ${item.code} (${policyState.dailyJoins+1}/${JOIN_MAX_PER_DAY})...`);
      const res = await sock.groupAcceptInvite(item.code);
      if (res){
        joinedGroups.set(res, { name:null, joinedAt:Date.now(), discovered:false });
        lastGreetingAt.set(res, Date.now());
        saveGroups(); dailyStats.joined++; policyRecordJoin();
        pushLog('success','join',`Joined ${res} — next in ${Math.round(nextJoinGapMs/60000)}min`);
      }
    } catch(e){
      dailyStats.failed++;
      pushLog('error','join',`Failed: ${e.message}`);
    } finally {
      joinInProgress = false;
      const now = Date.now();
      for (const [k, t] of recentJoinAttempts){ if (now - t > 30 * 60 * 1000) recentJoinAttempts.delete(k); }
    }
  }, 60 * 1000);
  pushLog('info','system',`scheduleGroupJoins started — ${JOIN_MAX_PER_DAY}/day, hours ${JOIN_ACTIVE_HOUR_START}-${JOIN_ACTIVE_HOUR_END}`);
}

function scheduleHumanPresence(){
  setInterval(async function(){
    if (!sock || connectionStatus !== 'connected') return;
    const h = localHour();
    const isDay = h >= 7 && h < 21;
    const isLateNight = h >= 0 && h < 6;
    const state = isDay ? 'available' : (isLateNight ? 'unavailable' : 'available');
    try { await sock.sendPresenceUpdate(state); } catch(e){}
  }, 5 * 60 * 1000);
  pushLog('info','system','scheduleHumanPresence started');
}

/* Pending */
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
      await sendBuffer(p.userJid, { text: 'sorry, could not find that' }, 2, 'slow', 'dmreply', true);
      pendingRequests.delete(id); savePending(); resetDailyStats(); dailyStats.pendingResolved++;
      adminReply(adminChatJid, `Replied casually to ${p.userName}.`);
      return { ok:true };
    }
    if (action === 'say'){
      await sendBuffer(p.userJid, { text: payload }, 2, 'slow', 'dmreply', true);
      pendingRequests.delete(id); savePending(); resetDailyStats(); dailyStats.pendingResolved++;
      adminReply(adminChatJid, `Sent to ${p.userName}.`);
      return { ok:true };
    }
    const query = payload || p.intent.query;
    if (p.intent.type === 'video' || p.intent.type === 'gif'){
      const r = await scraperGif(query);
      if (!r.ok || !r.gifs.length){ adminReply(adminChatJid, 'No results.'); return { ok:false }; }
      await sendGifSafe(p.userJid, r.gifs[0], '', 2, 'slow', 'dmreply', true);
    } else {
      const r = await scraperSearch(query);
      if (!r.ok || !r.images.length){ adminReply(adminChatJid, 'No results.'); return { ok:false }; }
      await sendImageSafe(p.userJid, r.images[0], '', 2, 'slow', 'dmreply', true);
    }
    pendingRequests.delete(id); savePending(); resetDailyStats(); dailyStats.pendingResolved++;
    adminReply(adminChatJid, `Sent to ${p.userName}.`);
    return { ok:true };
  } catch(e){ adminReply(adminChatJid, `Err: ${e.message}`); return { ok:false, error:e.message }; }
}

/* Download flow */
async function startDownloadSearch(chatJid, query, priority=1, lane='slow'){
  const results = await ytSearch(query, 6);
  if (!results.length){
    await sendBuffer(chatJid, { text: `Could not find "${query}"` }, priority, lane, 'admin', false);
    return;
  }
  downloadPicks.set(chatJid, { query, results, ts:Date.now() });
  const list = results.map((r,i)=>`${i+1}. ${r.title}`).join('\n');
  await sendBuffer(chatJid, { text: `Found ${results.length} for *${query}*:\n\n${list}\n\nReply with a number (1-${results.length}) or "1,2,3" for multiple.` }, priority, lane, 'admin', false);
}
async function handleDownloadPick(chatJid, text, priority=1, lane='slow'){
  const entry = downloadPicks.get(chatJid);
  if (!entry) return false;
  if (Date.now() - entry.ts > DOWNLOAD_PICK_TTL){ downloadPicks.delete(chatJid); return false; }
  const nums = (text.match(/\d+/g)||[]).map(n=>parseInt(n,10)).filter(n=>n>=1 && n<=entry.results.length);
  if (!nums.length) return false;
  const picks = [...new Set(nums)].slice(0, DOWNLOAD_MAX_PICKS);
  downloadPicks.delete(chatJid);
  await sendBuffer(chatJid, { text: `Downloading ${picks.length} video(s)...` }, priority, lane, 'admin', false);
  for (const n of picks){
    const r = entry.results[n-1];
    if (!r) continue;
    try {
      await sendBuffer(chatJid, { text: `Playing ${r.title}` }, priority, lane, 'admin', false);
      const { filePath, quality, sizeBytes } = await y2mateDownload(r.id, '360p');
      await sendMediaFile(chatJid, filePath, `${r.title}\n(${quality}, ${(sizeBytes/1024/1024).toFixed(1)}MB)`, priority, lane, 'admin', false);
      resetDailyStats(); dailyStats.downloads++;
    } catch(e){
      await sendBuffer(chatJid, { text: `${r.title}: ${e.message}` }, priority, lane, 'admin', false);
      pushLog('error','download',e.message);
    }
  }
  return true;
}

/* ══════════════════════════════════════════════════════════════
 *  AD BUILDER
 * ══════════════════════════════════════════════════════════════ */
class AdBuilder {
  static build({ title, body, cta, link, footer, style='fancy' }){
    if (style === 'bold') return ['*'+title+'*', '', body, cta?'\n*'+cta+'*':'', link?'\n'+link:'', footer?'\n_'+footer+'_':''].filter(Boolean).join('\n');
    if (style === 'minimal') return [title, body, cta, link].filter(Boolean).join('\n\n');
    return ['---', title.toUpperCase(), '---', '', body, '', cta?'*'+cta+'*':'', link||'', footer?'\n_'+footer+'_':''].filter(Boolean).join('\n');
  }
}

let previewCache = { imageUrls:[], imageIndex:0, gifUrls:[], gifIndex:0, currentType:null, currentUrl:null };
const replyCache = new NodeCache({ stdTTL:600 });

/* ══════════════════════════════════════════════════════════════
 *  ADMIN COMMANDS
 * ══════════════════════════════════════════════════════════════ */
const COMMAND_LIST = `BreadBot v64 — Admin

MAIN GROUP
!setmain <invite-link>  — resolve link, set as main group
!setmain                — run inside the group to set it
!main                   — show current main group
!clearmain              — unset main group
!join <invite-link>     — join a group manually
!admins                 — list admins in main group

BASICS
!help / !ping / !status / !jobs / !flow
!test / !testall / !aitest
!scraperstatus / !whoami / !stats / !summary
!logs / !errors / !count / !groups / !inbox

MESSAGING
!broadcast <msg> / !bcgroup <msg> / !bcdm <msg> / !all <msg>
!send <jid> <msg> / !grouplink <link>

GROUP MANAGEMENT (main group only)
!antilink on|off / !welcome on|off / !goodbye on|off
!setwelcome / !setgoodbye
!promote / !demote / !kick @user
!tagall / !mute / !unmute / !lock / !unlock

MEDIA
!pic <q> / !nextpic / !bcastpic <cap>
!gif <q> / !nextgif / !bcastgif <cap>
!allimg <url> | <cap>

DOWNLOADS
!dl <q> / !download <url> / !music <q>
!nsfwvideo <q> / !nsfw <url> / !nsfwroleplay on|off / !cleanup

CONTROL
!pause / !resume / !offline <mins> / !online
!limit <n> / !unlimit

AI: Rewind only. Typing: ON. Reads: ON. Blocklist: OFF.
Main group: ${mainGroupJid || 'NOT SET — use !setmain'}`;

function logRepeatedCmd(cmd, chatJid){
  const now = Date.now();
  const key = `${chatJid}:${cmd}`;
  if (now - (recentAdminCmds.get(key)||0) < 30000) pushLog('warn','admin',`Repeated: ${cmd}`);
  recentAdminCmds.set(key, now);
}

async function handleAdminCommand(text, chatJid, msg){
  const args = text.slice(1).trim().split(/\s+/);
  const cmd  = args[0].toLowerCase();
  const reply = (t)=>adminReply(chatJid, t);
  logRepeatedCmd(cmd, chatJid);

  switch(cmd){
    case 'commands': case 'help': await reply(COMMAND_LIST); break;
    case 'ping': await reply(`Pong!\nStatus: ${connectionStatus}\nUptime: ${Math.floor((Date.now()-botStartTime)/1000)}s`); break;
    case 'pause': botPaused = true; await reply('Paused.'); break;
    case 'resume': botPaused = false; await reply('Resumed.'); break;
    case 'offline': { const m = parseInt(args[1],10) || 30; botOfflineUntil = Date.now()+m*60000; await reply(`Offline ${m}min.`); break; }
    case 'online': botOfflineUntil = 0; await reply('Online.'); break;
    case 'limit': { const n = Math.max(1, parseInt(args[1],10)||20); MESSAGE_FLOOD_THRESHOLD = n; await reply(`Limit ${n}/s.`); break; }
    case 'unlimit': MESSAGE_FLOOD_THRESHOLD = 9999; await reply('No limit.'); break;

    case 'setmain': {
      const linkArg = args.slice(1).join(' ').trim();
      if (linkArg && /chat\.whatsapp\.com/i.test(linkArg)){
        try {
          const { code, jid, subject, size } = await resolveInviteToJid(linkArg);
          pushLog('info','main',`Resolved ${code} → ${jid} (${subject}, ${size})`);
          if (!joinedGroups.has(jid)){
            try {
              const joined = await sock.groupAcceptInvite(code);
              if (joined){
                joinedGroups.set(joined, { name: subject, joinedAt: Date.now(), discovered: false });
                lastGreetingAt.set(joined, Date.now());
                saveGroups();
                pushLog('success','main',`Joined ${joined}`);
              }
            } catch(e){ pushLog('warn','main',`Could not join ${jid}: ${e.message}`); }
          }
          setMainGroup(jid);
          await reply(`✅ Main group set\n${jid}\n${subject} (${size} members)`);
        } catch(e){ await reply(`❌ Could not resolve link: ${e.message}`); }
        break;
      }
      if (chatJid.endsWith('@g.us')){
        setMainGroup(chatJid);
        await reply(`✅ Main group set to this group: ${chatJid}`);
        break;
      }
      await reply('❌ Usage: `!setmain https://chat.whatsapp.com/...` from DM, OR `!setmain` inside the group.');
      break;
    }
    case 'clearmain': { clearMainGroup(); await reply('✅ Main group cleared.'); break; }
    case 'main': {
      if (!mainGroupJid){ await reply('Main group: NOT SET'); break; }
      try {
        const meta = await sock.groupMetadata(mainGroupJid);
        await reply(`Main group: ${mainGroupJid}\n${meta.subject || '?'} (${meta.participants?.length || 0} members)`);
      } catch(e){ await reply(`Main group: ${mainGroupJid} (metadata error)`); }
      break;
    }
    case 'join': {
      const linkArg = args.slice(1).join(' ').trim();
      if (!linkArg){ await reply('❌ Usage: `!join <invite-link>`'); break; }
      try {
        const { code, jid, subject, size } = await resolveInviteToJid(linkArg);
        const joined = await sock.groupAcceptInvite(code);
        if (joined){
          joinedGroups.set(joined, { name: subject, joinedAt: Date.now(), discovered: false });
          lastGreetingAt.set(joined, Date.now());
          saveGroups();
        }
        await reply(`✅ Joined\n${joined}\n${subject} (${size} members)`);
      } catch(e){ await reply(`❌ ${e.message}`); }
      break;
    }
    case 'admins': {
      if (!mainGroupJid){ await reply('Set main group first.'); break; }
      const admins = await getGroupAdmins(mainGroupJid);
      if (!admins.length){ await reply('No admins found.'); break; }
      const list = admins.map((a, i) =>
        `${i+1}. ${a.role === 'superadmin' ? '👑' : '🛡️'} ${a.phoneNumber || a.lid || a.id.split('@')[0]}`
      ).join('\n');
      await reply(`Admins in main group (${admins.length}):\n${list}`);
      break;
    }

    case 'jobs': {
      const s = jobs.stats();
      await reply(`Fast ${s.fast.queued}/${s.fast.max} done ${s.fast.done}\nSlow ${s.slow.queued}/${s.slow.max} done ${s.slow.done}\nAdmin active: ${isAdminActive() ? 'YES' : 'no'}`);
      break;
    }
    case 'flow': {
      const age = getAccountAgeDays();
      const rate = (replyRate()*100).toFixed(0);
      const paused = broadcastsAllowed() ? 'no' : 'yes';
      const todayCount = Object.keys(policyState.dailyRecipients).length;
      await reply([
        `Flow stats`,
        `Account age: ${age}d`,
        `Recipient limit: ${dailyRecipientLimit(age)}`,
        `Recipients used: ${todayCount}`,
        `Joins: ${policyState.dailyJoins}/${dailyJoinLimit(age)}`,
        `Reply rate (${replyTracker.sends.length}): ${rate}%`,
        `Broadcasts paused: ${paused}`,
        `Deletes: ${deleteHist.min.length}/5m · ${deleteHist.hour.length}/30h · ${deleteHist.day.length}/100d`,
        `Main group: ${mainGroupJid||'NOT SET'}`,
        `Admin active: ${isAdminActive() ? 'YES' : 'no'}`,
        `Bot LID: ${botLid||'unknown'}`,
        `Typing: ${ENABLE_TYPING?'ON':'OFF'} · Reads: ${ENABLE_READ_RECEIPTS?'ON':'OFF'}`
      ].join('\n'));
      break;
    }
    case 'providers': case 'aitest': {
      const r = await testAllProviders();
      const x = r.rewind;
      if (x.ok) await reply(`Rewind OK ${x.ms}ms — active`);
      else await reply(`Rewind FAIL ${x.status||''} ${x.error||''}`);
      break;
    }
    case 'status': case 'diag': {
      const s = jobs.stats(); const f = focus.stats(); resetDailyStats(); const st = dailyStats;
      await reply([
        'Status','Connection: '+connectionStatus,'Bot: '+(botNumber||'-'),
        'Bot LID: '+(botLid||'-'),
        'Uptime: '+Math.floor((Date.now()-botStartTime)/1000)+'s',
        'Time: '+describeWindow()+' NSFW: '+describeNsfw()+' DM: '+describeDm(),
        'Paused: '+botPaused+' Offline: '+(botOfflineUntil>Date.now()?'yes':'no'),
        '','Groups: '+joinedGroups.size+' DMs: '+activeDMs.size,
        'Main: '+(mainGroupJid||'NOT SET'),'Queue: '+joinQueue.length+'/'+JOIN_QUEUE_MAX,
        'Fast: '+s.fast.queued+' Slow: '+s.slow.queued,
        'Focus: '+f.currentState,
        'AI: '+(activeProvider||'NONE'),
        'Admin active: '+(isAdminActive()?'YES':'no'),
        '','Today','DM: '+st.dmsReplied+' Media: '+(st.picsSent+st.videosSent),
        'Reads: '+st.readsSent+' Typings: '+st.typingsSent,
        'Broadcasts: '+st.broadcastsSent+' Deletes: '+st.deletesDone,
        '','Admin LIDs: '+([...adminLids].join(', ')||'none')
      ].join('\n'));
      break;
    }
    case 'count': await reply('Groups: '+joinedGroups.size+'\nDMs: '+activeDMs.size+'\nQueue: '+joinQueue.length+'\nPending: '+pendingRequests.size+'\nMain: '+(mainGroupJid||'NOT SET')+'\nAI: '+(activeProvider||'NONE')); break;
    case 'groups': {
      if (!joinedGroups.size){ await reply('No groups.'); return; }
      const list = [...joinedGroups.entries()].map(function(kv,i){return (i+1)+'. '+(kv[0]===mainGroupJid?'⭐ ':'')+kv[0];}).join('\n');
      await reply('Groups ('+joinedGroups.size+')\n'+list);
      break;
    }
    case 'inbox': case 'dms': {
      if (!activeDMs.size){ await reply('No DMs.'); return; }
      const list = [...activeDMs].map(function(j,i){return (i+1)+'. '+j.split('@')[0];}).join('\n');
      await reply('DMs ('+activeDMs.size+')\n'+list);
      break;
    }
    case 'mylink': await adminReply(chatJid, 'Join my group:\n'+ADMIN_GROUP_LINK); break;
    case 'send': {
      const t = args[1]; const body = args.slice(2).join(' ').trim();
      if (!t || !body){ await reply('Usage: !send <jid> <msg>'); return; }
      if (!joinedGroups.has(t)){ await reply('Not in '+t); return; }
      await sendBuffer(t, { text: body }, 0, 'fast', 'admin', false);
      await reply('Sent.');
      break;
    }
    case 'broadcast': case 'bcgroup': {
      if (!broadcastsAllowed()){ await reply('Broadcasts paused.'); break; }
      if (!mainGroupJid){ await reply('Set main group first: `!setmain`'); break; }
      const m = args.slice(1).join(' ');
      if (!m){ await reply('Usage: !'+cmd+' <msg>'); return; }
      await reply('Broadcasting to '+joinedGroups.size+' groups...');
      let sent=0;
      for (const jid of joinedGroups.keys()){
        if (jid === mainGroupJid) continue;
        try { await sendBuffer(jid, { text:m }, 3, 'slow', 'broadcast', false); sent++; } catch(e){}
      }
      resetDailyStats(); dailyStats.broadcastsSent += sent;
      await reply('Queued '+sent+'/'+joinedGroups.size);
      break;
    }
    case 'all': case 'bcdm': {
      if (!broadcastsAllowed()){ await reply('Broadcasts paused.'); break; }
      if (!mainGroupJid){ await reply('Set main group first: `!setmain`'); break; }
      const m = args.slice(1).join(' ');
      if (!m){ await reply('Usage: !'+cmd+' <msg>'); return; }
      const mode = cmd === 'all' ? 'all' : 'dms';
      const targets = mode === 'all'
        ? [...[...joinedGroups.keys()].filter(j=>j!==mainGroupJid), ...activeDMs]
        : [...activeDMs];
      if (!targets.length){ await reply('None.'); return; }
      for (const jid of targets){ try { await sendBuffer(jid, { text:m }, 3, 'slow', 'broadcast', false); } catch(e){} }
      resetDailyStats(); dailyStats.broadcastsSent += targets.length;
      await reply('Done.');
      break;
    }
    case 'pic': case 'search': {
      const q = args.slice(1).join(' ');
      if (!q){ await reply('Usage: !pic <query>'); return; }
      const r = await scraperSearch(q, false);
      if (!r.ok || !r.images.length){ await reply('No results'); return; }
      previewCache.imageUrls = r.images; previewCache.imageIndex = 0;
      previewCache.currentType = 'image'; previewCache.currentUrl = r.images[0];
      await sendImageSafe(chatJid, r.images[0], 'Preview 1/'+r.images.length, 0, 'fast', 'admin', false);
      break;
    }
    case 'nextpic': {
      if (!previewCache.imageUrls.length){ await reply('No preview.'); return; }
      previewCache.imageIndex = (previewCache.imageIndex+1) % previewCache.imageUrls.length;
      previewCache.currentUrl = previewCache.imageUrls[previewCache.imageIndex];
      await sendImageSafe(chatJid, previewCache.currentUrl, 'Preview '+(previewCache.imageIndex+1)+'/'+previewCache.imageUrls.length, 0, 'fast', 'admin', false);
      break;
    }
    case 'gif': {
      const q = args.slice(1).join(' ');
      if (!q){ await reply('Usage: !gif <query>'); return; }
      const r = await scraperGif(q, false);
      if (!r.ok || !r.gifs.length){ await reply('No results'); return; }
      previewCache.gifUrls = r.gifs; previewCache.gifIndex = 0;
      previewCache.currentType = 'gif'; previewCache.currentUrl = r.gifs[0];
      await sendGifSafe(chatJid, r.gifs[0], 'GIF 1/'+r.gifs.length, 0, 'fast', 'admin', false);
      break;
    }
    case 'nextgif': {
      if (!previewCache.gifUrls.length){ await reply('No preview.'); return; }
      previewCache.gifIndex = (previewCache.gifIndex+1) % previewCache.gifUrls.length;
      previewCache.currentUrl = previewCache.gifUrls[previewCache.gifIndex];
      await sendGifSafe(chatJid, previewCache.currentUrl, 'GIF '+(previewCache.gifIndex+1)+'/'+previewCache.gifUrls.length, 0, 'fast', 'admin', false);
      break;
    }
    case 'bcastpic': case 'bcastpicdm': case 'bcastpicgroup': {
      if (!previewCache.currentUrl || previewCache.currentType !== 'image'){ await reply('No preview.'); return; }
      if (!broadcastsAllowed()){ await reply('Broadcasts paused.'); break; }
      const cap = args.slice(1).join(' ') || '';
      const mode = cmd === 'bcastpic' ? 'all' : cmd === 'bcastpicdm' ? 'dms' : 'groups';
      const targets = mode === 'all'
        ? [...[...joinedGroups.keys()].filter(j=>j!==mainGroupJid), ...activeDMs]
        : mode === 'groups' ? [...joinedGroups.keys()].filter(j=>j!==mainGroupJid) : [...activeDMs];
      if (!targets.length){ await reply('No '+mode+'.'); return; }
      for (const jid of targets){ await sendImageSafe(jid, previewCache.currentUrl, cap, 3, 'slow', 'broadcast', false); }
      await reply('Done.');
      break;
    }
    case 'bcastgif': {
      if (!previewCache.currentUrl || previewCache.currentType !== 'gif'){ await reply('No preview.'); return; }
      if (!broadcastsAllowed()){ await reply('Broadcasts paused.'); break; }
      const cap = args.slice(1).join(' ') || '';
      const targets = [...[...joinedGroups.keys()].filter(j=>j!==mainGroupJid), ...activeDMs];
      for (const jid of targets){ await sendGifSafe(jid, previewCache.currentUrl, cap, 3, 'slow', 'broadcast', false); }
      await reply('Done.');
      break;
    }
    case 'allimg': {
      if (!broadcastsAllowed()){ await reply('Broadcasts paused.'); break; }
      const parts = args.slice(1).join(' ').split('|').map(s=>s.trim());
      const url = parts[0]; const cap = parts[1] || '';
      if (!url){ await reply('Usage: !allimg <url> | <cap>'); return; }
      const targets = [...[...joinedGroups.keys()].filter(j=>j!==mainGroupJid), ...activeDMs];
      for (const jid of targets){ await sendImageSafe(jid, url, cap, 3, 'slow', 'broadcast', false); }
      await reply('Done.');
      break;
    }
    case 'ad': {
      const parts = args.slice(1).join(' ').split('|').map(p=>p.trim());
      const [title, body, cta, link, style] = parts;
      if (!title || !body){ await reply('Usage: !ad <title>|<body>|[cta]|[link]|[style]'); return; }
      const ad = AdBuilder.build({ title, body, cta, link, footer:'Reply STOP to opt out', style: style||'fancy' });
      await reply('Preview:\n\n'+ad);
      replyCache.set('LAST_AD', ad);
      break;
    }
    case 'bcad': {
      const ad = replyCache.get('LAST_AD');
      if (!ad){ await reply('No ad.'); return; }
      if (!broadcastsAllowed()){ await reply('Broadcasts paused.'); break; }
      const targets = [...[...joinedGroups.keys()].filter(j=>j!==mainGroupJid), ...activeDMs];
      for (const jid of targets){ await sendBuffer(jid, { text:ad }, 3, 'slow', 'broadcast', false); }
      await reply('Done.');
      break;
    }
    case 'antilink': { getGroupSetting(chatJid).antilink = args[1]==='on'; saveGroupSettingsDebounced(); await reply(args[1]==='on'?'ON':'OFF'); break; }
    case 'welcome':  { getGroupSetting(chatJid).welcome  = args[1]==='on'; saveGroupSettingsDebounced(); await reply(args[1]==='on'?'ON':'OFF'); break; }
    case 'goodbye':  { getGroupSetting(chatJid).goodbye  = args[1]==='on'; saveGroupSettingsDebounced(); await reply(args[1]==='on'?'ON':'OFF'); break; }
    case 'setwelcome': { const t = args.slice(1).join(' '); if (!t){ await reply('Provide text.'); return; } getGroupSetting(chatJid).welcomeMsg = t; saveGroupSettingsDebounced(); await reply('Set.'); break; }
    case 'setgoodbye': { const t = args.slice(1).join(' '); if (!t){ await reply('Provide text.'); return; } getGroupSetting(chatJid).goodbyeMsg = t; saveGroupSettingsDebounced(); await reply('Set.'); break; }
    case 'promote': case 'demote': case 'kick': {
      if (!chatJid.endsWith('@g.us')){ await reply('Group only.'); return; }
      if (chatJid !== mainGroupJid){ await reply('Only in main group.'); return; }
      const botIsAdmin = await botIsAdminIn(chatJid);
      if (!botIsAdmin){ await reply('Bot is not admin here.'); return; }
      const t = msg.message?.extendedTextMessage?.contextInfo?.participant
              || (args[1] ? args[1].replace(/\D/g,'')+'@s.whatsapp.net' : null);
      if (!t){ await reply('Reply or give phone.'); return; }
      const act = cmd === 'promote' ? 'promote' : cmd === 'demote' ? 'demote' : 'remove';
      try { await sock.groupParticipantsUpdate(chatJid, [t], act); await reply(cmd+' done.'); }
      catch(e){ await reply('Err: '+e.message); }
      break;
    }
    case 'tagall': {
      if (chatJid !== mainGroupJid){ await reply('Only in main group.'); return; }
      try {
        const meta = await sock.groupMetadata(chatJid);
        const mentions = meta.participants.map(p=>p.id);
        const list = mentions.map(j=>'@'+j.split('@')[0]).join(' ');
        await sendBuffer(chatJid, { text: 'Attention:\n\n'+list, mentions }, 0, 'fast', 'admin', false);
      } catch(e){ await reply('Err: '+e.message); }
      break;
    }
    case 'mute':   { if (chatJid !== mainGroupJid){ await reply('Only in main group.'); break; } if (!await botIsAdminIn(chatJid)){ await reply('Not admin here.'); break; } try { await sock.groupSettingUpdate(chatJid,'announcement'); await reply('Muted.'); } catch(e){ await reply('Err: '+e.message); } break; }
    case 'unmute': { if (chatJid !== mainGroupJid){ await reply('Only in main group.'); break; } if (!await botIsAdminIn(chatJid)){ await reply('Not admin here.'); break; } try { await sock.groupSettingUpdate(chatJid,'not_announcement'); await reply('Unmuted.'); } catch(e){ await reply('Err: '+e.message); } break; }
    case 'lock':   { if (chatJid !== mainGroupJid){ await reply('Only in main group.'); break; } if (!await botIsAdminIn(chatJid)){ await reply('Not admin here.'); break; } try { await sock.groupSettingUpdate(chatJid,'locked'); await reply('Locked.'); } catch(e){ await reply('Err: '+e.message); } break; }
    case 'unlock': { if (chatJid !== mainGroupJid){ await reply('Only in main group.'); break; } if (!await botIsAdminIn(chatJid)){ await reply('Not admin here.'); break; } try { await sock.groupSettingUpdate(chatJid,'unlocked'); await reply('Unlocked.'); } catch(e){ await reply('Err: '+e.message); } break; }
    case 'dl': {
      const q = args.slice(1).join(' ').trim();
      if (!q){ await reply('Usage: !dl <song or video>'); return; }
      await startDownloadSearch(chatJid, q, 0, 'fast');
      break;
    }
    case 'download': {
      const url = args[1];
      if (!url){ await reply('Usage: !download <url>'); return; }
      await reply('Resolving...');
      try {
        const vid = (url.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/)||[])[1];
        if (!vid){ await reply('Bad URL.'); return; }
        const { filePath, quality, sizeBytes } = await y2mateDownload(vid, '360p');
        await sendMediaFile(chatJid, filePath, '('+quality+', '+(sizeBytes/1024/1024).toFixed(1)+'MB)', 0, 'fast', 'admin', false);
        resetDailyStats(); dailyStats.downloads++;
        await reply('Sent.');
      } catch(e){ await reply('Err: '+e.message); }
      break;
    }
    case 'music': {
      const q = args.slice(1).join(' ').trim();
      if (!q){ await reply('Usage: !music <song>'); return; }
      await reply('Searching "'+q+'"...');
      try {
        const results = await ytSearch(q + ' audio', 3);
        if (!results.length){ await reply('None.'); return; }
        const top = results[0];
        await reply(top.title+' - downloading...');
        const { filePath, sizeBytes } = await y2mateDownloadMusic(top.id, 'mp3');
        await sendMediaFile(chatJid, filePath, top.title+'\n('+(sizeBytes/1024/1024).toFixed(1)+'MB)', 0, 'fast', 'admin', false);
        resetDailyStats(); dailyStats.downloads++;
        await reply('Sent.');
      } catch(e){ await reply('Err: '+e.message); }
      break;
    }
    case 'nsfwvideo': {
      const q = args.slice(1).join(' ').trim();
      if (!q){ await reply('Usage: !nsfwvideo <query>'); return; }
      await reply('Searching "'+q+'"...');
      const ok = await nsfwVideoSearchAndSend(chatJid, q, 0, 'fast', 'admin', false);
      if (ok) await reply('Sent.');
      break;
    }
    case 'nsfw': {
      if (args[1] === 'on'){ await reply('on.'); break; }
      if (args[1] === 'off'){ await reply('off.'); break; }
      const url = args[1];
      if (!url){ await reply('Usage: !nsfw <url> or !nsfwvideo <query>'); return; }
      try {
        const vid = (url.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/)||[])[1];
        if (!vid){ await reply('Bad URL.'); return; }
        const { filePath, quality, sizeBytes } = await y2mateDownload(vid, '720p');
        await sendMediaFile(chatJid, filePath, 'NSFW ('+quality+', '+(sizeBytes/1024/1024).toFixed(1)+'MB)', 0, 'fast', 'admin', false);
        resetDailyStats(); dailyStats.nsfwDownloads++;
        await reply('Sent.');
      } catch(e){ await reply('Err: '+e.message); }
      break;
    }
    case 'nsfwroleplay': {
      if (args[1] === 'on'){ nsfwRoleplayEnabled = true; await reply('Roleplay ON.'); break; }
      if (args[1] === 'off'){ nsfwRoleplayEnabled = false; await reply('Roleplay OFF.'); break; }
      await reply('Usage: !nsfwroleplay on|off');
      break;
    }
    case 'cleanup': {
      try {
        const files = fs.readdirSync(DOWNLOAD_DIR);
        for (const f of files){ try{ fs.unlinkSync(path.join(DOWNLOAD_DIR,f)); }catch(e){} }
        await reply('Cleared '+files.length+'.');
      } catch(e){ await reply('Err: '+e.message); }
      break;
    }
    case 'logs': {
      const recent = logBuffer.slice(-30).map(e=>'['+e.level+'] '+e.source+': '+e.message).join('\n');
      await reply('Logs (30)\n\n'+recent.slice(0,3500));
      break;
    }
    case 'errors': {
      const errs = logBuffer.filter(e=>e.level==='error').slice(-20).map(e=>'['+e.source+'] '+e.message).join('\n');
      await reply('Errors\n\n'+(errs.slice(0,3500)||'none'));
      break;
    }
    case 'pending': {
      if (!pendingRequests.size){ await reply('None.'); return; }
      const list = [...pendingRequests.values()].slice(0,20).map(p=>'- '+p.id+' - '+p.userName+' - '+p.intent.type+': "'+p.intent.query+'"').join('\n');
      await reply('Pending\n'+list);
      break;
    }
    case 'teach': {
      const id = args[1]; const rest = args.slice(2).join(' ').trim();
      if (!id || !rest){ await reply('Usage: !teach <id> <q|say|skip>'); return; }
      if (rest === 'skip') await resolvePending(id, 'skip', null, chatJid);
      else if (rest.startsWith('say ')) await resolvePending(id, 'say', rest.slice(4).trim(), chatJid);
      else await resolvePending(id, 'search', rest, chatJid);
      break;
    }
    case 'scrapersearch': case 'scrapergif': {
      const q = args.slice(1).join(' ');
      if (!q){ await reply('Give query.'); return; }
      const r = cmd === 'scrapersearch' ? await scraperSearch(q) : await scraperGif(q);
      if (!r.ok){ await reply('Err: '+r.error); return; }
      const items = r.images || r.gifs || [];
      await reply(items.length+' results\nFirst: '+(items[0]||'none'));
      break;
    }
    case 'scraperstatus': {
      const st = await scraperStatus();
      await reply(st.ok ? 'Up ('+(st.data?.status||'ok')+')' : 'Err: '+st.error);
      break;
    }
    case 'test': {
      const s = jobs.stats();
      await reply('Bot: '+botNumber+'\nBot LID: '+(botLid||'-')+'\nStatus: '+connectionStatus+'\nAI: '+(activeProvider||'NONE')+'\nMain: '+(mainGroupJid||'NOT SET')+'\nFast: '+s.fast.queued+'\nSlow: '+s.slow.queued);
      break;
    }
    case 'testall': {
      await reply('Running...');
      const tests = [];
      const s1 = await scraperSearch('test'); tests.push('Search: '+(s1.ok?'OK '+s1.images.length:'FAIL'));
      const s2 = await scraperGif('funny'); tests.push('GIF: '+(s2.ok?'OK '+s2.gifs.length:'FAIL'));
      const rw = await testAllProviders();
      tests.push('rewind: '+(rw.rewind?.ok ? 'OK '+rw.rewind.ms+'ms' : 'FAIL '+(rw.rewind?.status||'')));
      tests.push('WA: '+(connectionStatus==='connected'?'OK':'FAIL'));
      tests.push('Main: '+(mainGroupJid?'OK '+mainGroupJid:'NOT SET'));
      tests.push('Bot LID: '+(botLid||'unknown'));
      tests.push('NSFW DL: '+(RedgifsDownloader?'OK':'FAIL'));
      tests.push('Reply rate: '+(replyRate()*100).toFixed(0)+'%');
      tests.push('Groups: '+joinedGroups.size+' DMs: '+activeDMs.size);
      await reply('Tests\n\n'+tests.join('\n'));
      break;
    }
    case 'stats': case 'summary': {
      resetDailyStats(); const s = dailyStats;
      await reply('Today\nJoined: '+s.joined+'\nDM: '+s.dmsReplied+'\nMedia: '+(s.picsSent+s.videosSent)+'\nNSFW: '+s.nsfwSent+'\nDownloads: '+s.downloads+'\nBroadcasts: '+s.broadcastsSent+'\nDeletes: '+s.deletesDone+'\nReads: '+s.readsSent+'\nTypings: '+s.typingsSent+'\nAI: '+(activeProvider||'NONE'));
      break;
    }
    case 'whoami': {
      const c = extractAllPhoneCandidates(msg, chatJid);
      const l = extractLid(msg, chatJid);
      const p = extractPnFromMsg(msg, chatJid);
      const a = isAdminSender(msg, chatJid);
      await reply('JID: '+(msg.key.participant||msg.key.remoteJid)+'\nLID: '+(l||'-')+'\nPN: '+(p||'-')+'\nCandidates: '+(c.join(', ')||'none')+'\nIs admin: '+(a?'YES':'NO')+'\n\nKnown LIDs: '+([...adminLids].join(', ')||'none'));
      break;
    }
    default: await reply('Unknown: !'+cmd+'\n\nSend !help.');
  }
}

/* ══════════════════════════════════════════════════════════════
 *  FLOOD
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
 *  DM PROCESSING
 * ══════════════════════════════════════════════════════════════ */
async function processDM(item){
  const { msg, text, chatJid, senderJid, pushName, phone, intent, lang } = item;
  const langName = LANG_NAMES[lang] || 'English';
  if (containsForbidden(text)) return;

  if (intent && intent.type === 'music'){
    try {
      const results = await ytSearch(intent.query + ' audio', 3);
      if (!results.length){ await sendBuffer(chatJid, { text:'Could not find "'+intent.query+'"' }, 2, 'slow', 'dmreply', true); return; }
      const top = results[0];
      await sendBuffer(chatJid, { text:'Found '+top.title+'. Downloading...' }, 2, 'slow', 'dmreply', true);
      const { filePath } = await y2mateDownloadMusic(top.id, 'mp3');
      await sendMediaFile(chatJid, filePath, top.title, 2, 'slow', 'dmreply', true);
      resetDailyStats(); dailyStats.downloads++;
    } catch(e){ await sendBuffer(chatJid, { text:'Err: '+e.message }, 2, 'slow', 'dmreply', true); }
    return;
  }

  if (detectNsfw(text) && nsfwRoleplayEnabled){
    if (isNsfwWindow() || isAdminSender(msg, senderJid)){
      const rp = await nsfwRoleplay(pushName, text);
      if (rp){ await sendBuffer(chatJid, { text: rp }, 2, 'slow', 'dmreply', true); resetDailyStats(); dailyStats.dmsReplied++; }
      return;
    } else {
      await sendBuffer(chatJid, { text: 'Not right now, try after 9pm' }, 2, 'slow', 'dmreply', true);
      return;
    }
  }

  if (detectGroupLinkRequest(text)){
    await sendBuffer(chatJid, { text:'Join our group:\n'+ADMIN_GROUP_LINK }, 2, 'slow', 'dmreply', true);
    resetDailyStats(); dailyStats.dmsReplied++;
    return;
  }

  if (intent && intent.type !== 'music'){
    if (!isVague(intent.query)){
      if (intent.type === 'video' || intent.type === 'gif'){
        const r = await scraperGif(intent.query, false);
        if (r.ok && r.gifs.length){
          await sendGifSafe(chatJid, r.gifs[0], '', 2, 'slow', 'dmreply', true);
          resetDailyStats();
          if (intent.type === 'video') dailyStats.videosSent++; else dailyStats.picsSent++;
          return;
        }
      } else {
        const r = await scraperSearch(intent.query, false);
        if (r.ok && r.images.length){
          await sendImageSafe(chatJid, r.images[0], '', 2, 'slow', 'dmreply', true);
          resetDailyStats(); dailyStats.picsSent++;
          return;
        }
      }
    }
    const history = userHistories.get(senderJid) || [];
    const id = createPendingRequest(senderJid, pushName, phone, history, intent);
    await sendBuffer(chatJid, { text: 'checking...' }, 2, 'slow', 'dmreply', true);
    return;
  }

  const hist = userHistories.get(senderJid) || [];
  const recentTurns = hist.slice(-USER_HISTORY_SIZE * 2);
  const transcript = recentTurns.map(h => (h.role === 'bot' ? 'Abby' : 'Them') + ': ' + h.text).join('\n');
  const fullPrompt = transcript
    ? 'Conversation so far:\n' + transcript + '\n\nThem: ' + text + '\n\nReply as Abby. This is a NEW reply.'
    : text;

  const sys = 'You are Abby Faith Sithole, a 23-year-old girl from Harare, Zimbabwe. REAL person. Reply in ' + langName + '. Mix light Shona. Keep replies SHORT (1-2 sentences). Never say you are an AI. Be casual, playful.';
  let aiReply = await askAI(fullPrompt, sys);
  if (!aiReply) return;

  const lastBot = hist.filter(h => h.role === 'bot').slice(-1)[0];
  if (lastBot && lastBot.text.toLowerCase().trim() === aiReply.toLowerCase().trim()){
    const retry = await askAI('You already said: "'+lastBot.text+'". Say something COMPLETELY DIFFERENT.', sys);
    if (retry && retry.toLowerCase().trim() !== lastBot.text.toLowerCase().trim()) aiReply = retry;
    else return;
  }

  hist.push({ role:'user', text, ts:Date.now() });
  hist.push({ role:'bot',  text:aiReply, ts:Date.now() });
  while (hist.length > USER_HISTORY_SIZE * 2) hist.shift();
  userHistories.set(senderJid, hist);

  await sendBuffer(chatJid, { text: informalize(aiReply) }, 2, 'slow', 'dmreply', true);
  resetDailyStats(); dailyStats.dmsReplied++; dailyStats.focusRuns++;
}
async function processDMQueue(){
  if (dmQueueProcessing) return;
  if (focus.busy){ setTimeout(processDMQueue, 2000); return; }
  const item = dmQueue.shift();
  if (!item) return;
  dmQueueProcessing = true;
  try { await focus.run(item.chatJid, async ()=>{ await processDM(item); }); }
  catch(e){
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
    pushLog('warn','queue','DM queue full ('+DM_QUEUE_MAX+')');
    return false;
  }
  dmQueue.push(item); processDMQueue(); return true;
}

/* ══════════════════════════════════════════════════════════════
 *  MAIN MESSAGE HANDLER
 * ══════════════════════════════════════════════════════════════ */
async function handleMessage(msg){
  if (!sock) return;

  /* ═══ Refresh bot LID if still unknown ═══ */
  if (!botLid){
    const fresh = getSelfLid();
    if (fresh){
      botLid = fresh;
      pushLog('success','bot','Bot LID learned: '+botLid);
    }
  }

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

  /* ═══ FILTER 1: Protocol frames ═══ */
  const rawMsg = msg.message;
  if (!rawMsg) return;
  if (rawMsg.protocolMessage) return;
  if (rawMsg.senderKeyDistributionMessage) return;
  if (rawMsg.reactionMessage) return;
  if (rawMsg.pollUpdateMessage) return;
  if (rawMsg.pollCreationMessage) return;
  if (rawMsg.pollCreationMessageV2) return;
  if (rawMsg.pollCreationMessageV3) return;
  if (rawMsg.stickerMessage) return;
  if (msg.messageStubType) return;

  let m = rawMsg; let guard=0;
  while (m && guard++<10){
    if (m.ephemeralMessage?.message){ m=m.ephemeralMessage.message; continue; }
    if (m.viewOnceMessage?.message){ m=m.viewOnceMessage.message; continue; }
    if (m.viewOnceMessageV2?.message){ m=m.viewOnceMessageV2.message; continue; }
    if (m.deviceSentMessage?.message){ m=m.deviceSentMessage.message; continue; }
    if (m.documentWithCaptionMessage?.message){ m=m.documentWithCaptionMessage.message; continue; }
    break;
  }

  const hasText = !!(m?.conversation || m?.extendedTextMessage?.text
                || m?.imageMessage || m?.videoMessage
                || m?.audioMessage || m?.documentMessage
                || m?.contactMessage || m?.locationMessage);
  if (!hasText) return;

  /* ═══ FILTER 2: fromMe echoes ═══ */
  if (msg.key.fromMe) return;

  const text = m?.conversation || m?.extendedTextMessage?.text
            || m?.imageMessage?.caption || m?.videoMessage?.caption || '';
  const mediaType = m?.imageMessage ? 'image' : m?.videoMessage ? 'video'
                  : m?.audioMessage ? 'audio' : m?.documentMessage ? 'document' : 'text';
  const isGroup   = chatJid.endsWith('@g.us');
  const senderJid = isGroup ? (msg.key.participant||chatJid) : chatJid;
  const phone     = extractPhone(msg, senderJid);
  const lid       = extractLid(msg, senderJid);
  const pn        = extractPnFromMsg(msg, senderJid);
  const pushName  = msg.pushName || 'Unknown';
  const chatType  = isGroup ? 'group' : 'dm';

  if (isGroup) discoverGroup(chatJid);
  if (isGroup) recordGroupMessage(chatJid, text);
  else activeDMs.add(chatJid);

  recordReply(chatJid);
  markRead(msg).catch(()=>{});

  const isAdmin = isAdminSender(msg, senderJid);
  if (isBotSender(msg, senderJid)) return;
  if (isAdmin) touchAdminActive();

  pushLiveMessage({
    id:msgId, ts:new Date().toISOString(), chatJid, chatType,
    senderJid, senderName:pushName, phone:phone||'-', lid:lid||'-',
    text:text.slice(0,200)||'['+mediaType+']', mediaType, isAdmin
  });

  /* ═══ ADMIN COMMANDS ═══ */
  if (isAdmin && text.startsWith('!')){
    const inDM = !isGroup;
    const inMainGroup = mainGroupJid && chatJid === mainGroupJid;
    if (!inDM && !inMainGroup){
      pushLog('warn','admin',`Cmd ignored in non-main group ${chatJid}`);
      return;
    }
    const hit = contentBlocked(text);
    if (hit){
      pushLog('error','admin',`Command blocked (${hit})`);
      resetDailyStats(); dailyStats.policyBlocks++;
      await adminReply(chatJid, 'Command refused.');
      return;
    }
    pushLog('info','admin','Cmd: '+text.split(' ')[0]);
    await handleAdminCommand(text, chatJid, msg);
    return;
  }

  /* ═══ NO MAIN GROUP → IGNORE ALL GROUPS ═══ */
  if (isGroup && !mainGroupJid) return;

  /* ═══ NOT MAIN GROUP → IGNORE ═══ */
  if (isGroup && chatJid !== mainGroupJid) return;

  if (botPaused && !isAdmin) return;
  if (Date.now() < botOfflineUntil && !isAdmin) return;

  /* ═══ ADMIN IMAGE BROADCAST ═══ */
  if (!isGroup && isAdmin && mediaType === 'image' && text.startsWith('!')){
    const args = text.slice(1).trim().split(/\s+/);
    const cmd  = args[0].toLowerCase();
    if (['bcdm','bcgroup','all'].includes(cmd)){
      const caption = args.slice(1).join(' ').trim();
      try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger:pino({level:'silent'}) });
        if (!buffer){ adminReply(chatJid, 'Failed.'); return; }
        if (buffer.length > MEDIA_MAX_BYTES){ adminReply(chatJid, (buffer.length/1024/1024).toFixed(1)+'MB > 34MB'); return; }
        const mode = cmd==='bcdm'?'dms':cmd==='bcgroup'?'groups':'all';
        const targets = mode === 'all'
          ? [...[...joinedGroups.keys()].filter(j=>j!==mainGroupJid), ...activeDMs]
          : mode === 'groups' ? [...joinedGroups.keys()].filter(j=>j!==mainGroupJid) : [...activeDMs];
        if (!targets.length){ adminReply(chatJid, 'No '+mode+'.'); return; }
        adminReply(chatJid, 'Queued to '+targets.length+'.');
        for (const jid of targets) await sendBuffer(jid, { image: buffer, caption }, 3, 'slow', 'broadcast', false);
        adminReply(chatJid, 'Done.');
      } catch(e){ adminReply(chatJid, 'Err: '+e.message); }
      return;
    }
  }

  if (!isGroup && !isAdmin && text){
    if (!userHistories.has(senderJid)) userHistories.set(senderJid, []);
    const h = userHistories.get(senderJid);
    const last = h[h.length-1];
    if (!last || last.text !== text || last.role !== 'user') h.push({ role:'user', text, ts:Date.now() });
    if (h.length > USER_HISTORY_SIZE * 2) h.shift();
  }

  const codes = extractInviteCodes(text);
  if (codes.length){
    let added = 0;
    for (const c of codes){ if (queueJoin(c, phone||pushName, chatType)) added++; }
    if (added && !isGroup) await sendBuffer(chatJid, { text:`Queued ${added}. Total ${joinQueue.length}/${JOIN_QUEUE_MAX}` }, 3, 'slow', 'admin', false);
  }

  if (text && downloadPicks.has(chatJid)){
    const ok = await handleDownloadPick(chatJid, text, isAdmin?0:2, isAdmin?'fast':'slow');
    if (ok) return;
  }

  const dl = text ? detectDownloadIntent(text) : null;
  if (dl && dl.query){
    await startDownloadSearch(chatJid, dl.query, isAdmin?0:2, isAdmin?'fast':'slow');
    return;
  }

  /* ═══ GROUP MESSAGES — MAIN ONLY ═══ */
  if (isGroup){
    await handleAntiLink(chatJid, msg, text, senderJid, isAdmin);

    if (text){
      if (detectGroupLinkRequest(text)){ await sendBuffer(chatJid, { text:'Join: '+ADMIN_GROUP_LINK }, 3, 'slow', 'group', true); return; }
      const isNsfw = detectNsfw(text);
      if (isNsfw && !isAdmin && !isNsfwWindow()){ await sendBuffer(chatJid, { text:'Not right now, try after 9pm' }, 3, 'slow', 'group', true); return; }
      const gIntent = detectMediaIntent(text);
      if (gIntent && !isVague(gIntent.query)){
        if (gIntent.type === 'music'){
          try {
            const results = await ytSearch(gIntent.query + ' audio', 3);
            if (results.length){
              const top = results[0];
              await sendBuffer(chatJid, { text:top.title+' - downloading...' }, 3, 'slow', 'group', true);
              const { filePath } = await y2mateDownloadMusic(top.id, 'mp3');
              await sendMediaFile(chatJid, filePath, top.title, 3, 'slow', 'group', true);
              resetDailyStats(); dailyStats.downloads++;
              return;
            }
          } catch(e){ pushLog('error','music',e.message); }
        }
        if (gIntent.type === 'video' || gIntent.type === 'gif'){
          const r = await scraperGif(gIntent.query, isNsfw);
          if (r.ok && r.gifs.length){
            await sendGifSafe(chatJid, r.gifs[0], '', 3, 'slow', 'group', true);
            resetDailyStats();
            if (gIntent.type === 'video') dailyStats.videosSent++; else dailyStats.picsSent++;
            if (isNsfw) dailyStats.nsfwSent++;
            return;
          }
        } else {
          const r = await scraperSearch(gIntent.query, isNsfw);
          if (r.ok && r.images.length){
            await sendImageSafe(chatJid, r.images[0], '', 3, 'slow', 'group', true);
            resetDailyStats(); dailyStats.picsSent++;
            if (isNsfw) dailyStats.nsfwSent++;
            return;
          }
        }
      }
      const analysis = analyzeGroup(chatJid);
      const lang = detectLanguage(text);
      const sys = 'You are Abby Faith Sithole, 23, Harare Zimbabwe. In YOUR OWN WhatsApp group. Reply casually, SHORT (1 sentence), warm, in ' + LANG_NAMES[lang] + '. Mix light Shona. Never say you are AI. ' + (analysis?'Members often use: '+analysis.topWords.slice(0,6).join(', '):'');
      const aiReply = await askAI(text, sys);
      if (aiReply){ await sendBuffer(chatJid, { text: informalize(aiReply) }, 3, 'slow', 'group', true); resetDailyStats(); dailyStats.greetingsSent++; }
      return;
    }
    return;
  }

  if (isAdmin) return;
  if (!isDmAiWindow()) return;
  enqueueDM({ msg, text, chatJid, senderJid, pushName, phone,
    intent: detectMediaIntent(text), lang: detectLanguage(text) });
}

/* ══════════════════════════════════════════════════════════════
 *  CONNECT BOT
 * ══════════════════════════════════════════════════════════════ */
let cachedVersion = null;
async function getVersion(){
  if (cachedVersion) return cachedVersion;
  try {
    const { version } = await fetchLatestBaileysVersion();
    cachedVersion = version;
    return version;
  } catch(e){
    cachedVersion = [2, 3000, 1043857760];
    return cachedVersion;
  }
}

async function connectBot(){
  if (isConnecting) return;
  isConnecting = true; manualDisconnect = false;
  try {
    pushLog('info','bot','Initializing...');
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const version = await getVersion();
    pushLog('info','bot','WA version '+version.join('.'));

    const baseSocket = makeWASocket({
      version, auth: state, printQRInTerminal: false,
      browser: Browsers.macOS('Desktop'),
      logger: pino({ level:'silent' }),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      getMessage: async ()=>undefined,
      qrTimeout: 90000,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
      defaultQueryTimeoutMs: 30000
    });

    sock = baseSocket;
    pushLog('info','antiban','Raw socket');

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
        botLid = getSelfLid();
        consecutive515 = 0; recent515Timestamps = []; spamCooldownUntil = 0; lastReconnectAt = 0;
        pushLog('success','bot','Connected as '+botNumber);
        if (botLid) pushLog('info','bot','Bot LID: '+botLid);
        else pushLog('info','bot','Bot LID: unknown — will learn on first message');
        pushLog('info','time',describeWindow()+' NSFW: '+describeNsfw()+' DM: '+describeDm());
        pushLog('info','main',`Main group: ${mainGroupJid || 'NOT SET — use !setmain'}`);

        try { await sock.updateOnlinePrivacy('match_last_seen'); } catch(e){}
        try { await sock.updateLastSeenPrivacy('none'); } catch(e){}
        pushLog('info','privacy','hidden');

        try { await sock.sendPresenceUpdate('available'); } catch(e){}

        if (mainGroupJid) setTimeout(() => { probeMainGroup().catch(()=>{}); }, 8000);

        detectAIBackend().catch(e => pushLog('error','ai','detect: '+e.message));

        const lidList = [...adminLids];
        pushLiveMessage({
          id: 'boot-' + Date.now(), ts: new Date().toISOString(),
          chatJid: ADMIN_JID, chatType: 'system',
          senderJid: botJid, senderName: 'BOT ONLINE',
          phone: ADMIN_PHONE, lid: lidList.join(', ') || 'none',
          text: 'Bot ONLINE as ' + botNumber + '\nBot LID: ' + (botLid || 'unknown') + '\nMain group: ' + (mainGroupJid || 'NOT SET') + '\n' + describeWindow(),
          mediaType: 'system', isAdmin: true
        });
        pushLog('success','admin','Live-log: ONLINE announcement');

        try {
          const sent = await sock.sendMessage(ADMIN_JID, { text:
            'BreadBot v64 ONLINE\n' +
            'Bot: ' + botNumber + '\n' +
            'Bot LID: ' + (botLid || 'unknown (will learn on first message)') + '\n' +
            'Admin: ' + ADMIN_PHONE + '\n' +
            'Main group: ' + (mainGroupJid || 'NOT SET — send !setmain <link>') + '\n' +
            'Groups: ' + joinedGroups.size + '\n' +
            'Account age: ' + getAccountAgeDays() + 'd\n' +
            'Recipient limit: ' + dailyRecipientLimit(getAccountAgeDays()) + '\n\n' +
            'Admin commands accepted in DM and main group only.\n' +
            'Other groups are ignored.'
          });
          if (sent?.key?.id) markBotSent(sent.key.id);
        } catch(e){ pushLog('warn','admin','DM: '+e.message); }
      }
      if (connection === 'close'){
        isConnecting = false;
        const { code, msg } = describeDisconnect(lastDisconnect);
        pushLog('warn','bot',`Disconnected (${code ?? '?'}) — ${msg}`);

        if (manualDisconnect){ connectionStatus = 'disconnected'; return; }
        if (code === DisconnectReason.loggedOut){ connectionStatus = 'disconnected'; pushLog('error','bot','Logged out'); return; }
        if (code === 403){ connectionStatus = 'disconnected'; pushLog('error','bot','403 Forbidden — likely banned'); return; }
        if (code === 408 && connectionStatus === 'qr' && !botNumber){ connectionStatus = 'disconnected'; pushLog('warn','bot','QR expired'); return; }
        if (code === 428 || code === 440){ connectionStatus = 'disconnected'; pushLog('error','bot','Conflict '+code); return; }

        if (code === DisconnectReason.restartRequired || code === 515){
          if (restart515InFlight){ pushLog('warn','bot','515 in flight — skip'); return; }
          restart515InFlight = true;
          const now = Date.now();
          if (now < spamCooldownUntil) await new Promise(r=>setTimeout(r, spamCooldownUntil - now));
          const t = Date.now();
          recent515Timestamps.push(t);
          recent515Timestamps = recent515Timestamps.filter(ts => t - ts < SPAM_WINDOW_MS);
          if (recent515Timestamps.length > SPAM_THRESHOLD){
            spamCooldownUntil = t + SPAM_COOLDOWN_MS;
            recent515Timestamps = []; consecutive515 = 0;
          }
          consecutive515 += 1;
          const delay = Math.min(RESTART_515_BASE_DELAY_MS * Math.pow(2, consecutive515-1), RESTART_515_MAX_DELAY_MS);
          pushLog('warn','bot','515 retry '+delay/1000+'s');
          await new Promise(r=>setTimeout(r, delay));
          const since = Date.now() - lastReconnectAt;
          if (since < MIN_RECONNECT_INTERVAL_MS) await new Promise(r=>setTimeout(r, MIN_RECONNECT_INTERVAL_MS - since));
          lastReconnectAt = Date.now();
          try { sock.ev.removeAllListeners('connection.update'); } catch(e){}
          try { sock.ev.removeAllListeners('creds.update'); } catch(e){}
          try { sock.end(undefined); } catch(e){}
          sock = null; restart515InFlight = false;
          connectionStatus = 'reconnecting';
          return connectBot();
        }

        if (reconnectAttempts < MAX_RECONNECT){
          reconnectAttempts++;
          const delay = Math.min(3000 * reconnectAttempts, 20000);
          connectionStatus = 'reconnecting';
          pushLog('warn','bot','Retry '+delay/1000+'s ['+reconnectAttempts+'/'+MAX_RECONNECT+']');
          setTimeout(function(){ try { sock.end(undefined); } catch(e){} sock = null; connectBot(); }, delay);
        } else {
          connectionStatus = 'disconnected';
          pushLog('error','bot','Max retries');
        }
      }
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('group-participants.update', async (u)=>{ try { await handleParticipants(u); } catch(e){ pushLog('error','group',e.message); } });
    sock.ev.on('messages.upsert', async function(data){
      const messages = data.messages || [];
      for (const msg of messages){
        try { await handleMessage(msg); } catch(e){ pushLog('error','handler',e.message); }
      }
    });
  } catch(err){
    isConnecting = false;
    pushLog('error','bot','Connection failed: '+err.message);
    connectionStatus = 'error';
  }
}

async function disconnectBot(){
  manualDisconnect = true;
  if (sock){ try { sock.end(undefined); } catch(e){} sock = null;
    connectionStatus = 'disconnected'; qrDataUri = null; isConnecting = false; botNumber = null; botLid = null;
    pushLog('warn','bot','Disconnected'); }
}
function refreshQR(){
  qrDataUri = null; connectionStatus = 'disconnected'; manualDisconnect = true;
  if (sock){ try { sock.end(undefined); } catch(e){} sock = null; }
  isConnecting = false; botNumber = null; botLid = null;
  consecutive515 = 0; recent515Timestamps = []; spamCooldownUntil = 0; lastReconnectAt = 0; restart515InFlight = false;
  pushLog('info','bot','Manual QR refresh');
  setTimeout(function(){ manualDisconnect = false; connectBot(); }, 1000);
}

/* ══════════════════════════════════════════════════════════════
 *  EXPRESS APP
 * ══════════════════════════════════════════════════════════════ */
const app = express();
app.use(express.json());

const PANEL_HTML = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BreadBot v64</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}body{font-family:monospace;background:#0d1117;color:#c9d1d9;padding:16px}
h1{font-size:20px;color:#58a6ff}.sub{font-size:12px;color:#8b949e;margin-bottom:16px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px}
.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px}
.card h2{font-size:12px;color:#8b949e;text-transform:uppercase;margin-bottom:10px}
button{background:#21262d;border:1px solid #30363d;color:#c9d1d9;padding:8px 14px;border-radius:6px;cursor:pointer;margin:3px;font-family:inherit}
button:hover{background:#30363d}button.primary{background:#238636;color:#fff}button.danger{background:#da3633;color:#fff}
.row{display:flex;justify-content:space-between;padding:4px 0;font-size:13px;border-bottom:1px solid #21262d}
.val{color:#58a6ff;font-weight:600}.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px}
.s-connected{background:#3fb950}.s-qr{background:#d29922}.s-disconnected,.s-error{background:#f85149}.s-reconnecting{background:#d29922}
#logs,#msgs{height:300px;overflow-y:auto;font-size:12px;background:#0d1117;border-radius:6px;padding:8px}
#qrImg{max-width:220px;background:#fff;padding:8px;border-radius:8px;display:block;margin:auto}
.full{grid-column:1/-1}.admin-badge{background:#da3633;color:#fff;font-size:10px;padding:1px 6px;border-radius:3px;margin-left:6px;font-weight:700}
.sys-badge{background:#6e40c9;color:#fff;font-size:10px;padding:1px 6px;border-radius:3px;margin-left:6px;font-weight:700}
.ai-badge{background:#238636;color:#fff;font-size:10px;padding:1px 6px;border-radius:3px;margin-left:6px;font-weight:700}
.alert{background:#5a1d1d;color:#fff;padding:8px;border-radius:6px;margin-bottom:8px;font-size:12px;display:none}
.alert.show{display:block}
</style></head><body>
<h1>BreadBot v64</h1>
<div class="alert" id="noMain">⚠️ Main group NOT SET — bot ignores all group messages. Send <b>!setmain &lt;link&gt;</b> from DM.</div>
<div class="sub">Admin: <b id="ap">-</b> | Window: <b id="w">-</b> | NSFW: <b id="ns">-</b> | DM: <b id="dm">-</b> | AI: <b id="ai">-</b> | Main: <b id="mg">-</b></div>
<div class="grid">
<div class="card"><h2>Connection</h2>
<div><span class="dot" id="dot"></span><span id="st">-</span></div>
<div class="row"><span>Bot</span><span class="val" id="bn">-</span></div>
<div class="row"><span>Bot LID</span><span class="val" id="bl">-</span></div>
<div class="row"><span>Uptime</span><span class="val" id="up">-</span></div>
<div class="row"><span>Paused</span><span class="val" id="pz">-</span></div>
<div class="row"><span>Admin active</span><span class="val" id="aa">-</span></div>
<img id="qrImg" src="" style="display:none">
<div style="margin-top:10px">
<button class="primary" onclick="a('connect')">Start</button>
<button onclick="a('refresh-qr')">Refresh QR</button>
<button class="danger" onclick="a('clear-session')">Clear Session</button>
<button class="danger" onclick="a('disconnect')">Disconnect</button>
<button onclick="a('pause')">Pause</button><button onclick="a('resume')">Resume</button>
</div></div>
<div class="card"><h2>Main Group</h2>
<div class="row"><span>Status</span><span class="val" id="mgStatus">-</span></div>
<div class="row"><span>JID</span><span class="val" id="mgJid" style="font-size:11px">-</span></div>
<div class="row"><span>LIDs cached</span><span class="val" id="mainLids">-</span></div>
</div>
<div class="card"><h2>AI — Rewind only</h2><div id="aiList" style="font-size:12px;line-height:1.7"></div>
<div style="margin-top:8px"><button onclick="testAI()">Test Rewind</button></div></div>
<div class="card"><h2>Policy</h2>
<div class="row"><span>Account age</span><span class="val" id="age">-</span></div>
<div class="row"><span>Recipients today</span><span class="val" id="recip">-</span></div>
<div class="row"><span>Joins today</span><span class="val" id="joins">-</span></div>
<div class="row"><span>Reply rate</span><span class="val" id="reply">-</span></div>
</div>
<div class="card"><h2>Lanes</h2>
<div class="row"><span>Fast queue</span><span class="val" id="fq">-</span></div>
<div class="row"><span>Fast done</span><span class="val" id="fd">-</span></div>
<div class="row"><span>Slow queue</span><span class="val" id="sq">-</span></div>
<div class="row"><span>Slow done</span><span class="val" id="sd">-</span></div>
</div>
<div class="card"><h2>Scope</h2>
<div class="row"><span>Groups</span><span class="val" id="g">-</span></div>
<div class="row"><span>DMs</span><span class="val" id="d">-</span></div>
<div class="row"><span>Join queue</span><span class="val" id="jq">-</span></div>
<div class="row"><span>Pending</span><span class="val" id="pd">-</span></div>
</div>
<div class="card"><h2>Today</h2>
<div class="row"><span>DM</span><span class="val" id="dms">-</span></div>
<div class="row"><span>Reads</span><span class="val" id="reads">-</span></div>
<div class="row"><span>Typings</span><span class="val" id="typs">-</span></div>
<div class="row"><span>Deletes</span><span class="val" id="del">-</span></div>
</div>
<div class="card full"><h2>Live Messages</h2><div id="msgs"></div></div>
<div class="card full"><h2>Logs</h2><div id="logs"></div></div>
</div>
<script>
var $ = function(id){ return document.getElementById(id); };
async function api(p,m,body){var o={method:m||'GET'};if(body){o.headers={'Content-Type':'application/json'};o.body=JSON.stringify(body);}var r=await fetch('/admin/'+p,o);return r.json();}
function esc(s){return String(s||'').replace(/[&<>"']/g,function(c){var m={'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'};return m[c];});}
function setS(s){$('dot').className='dot s-'+s;$('st').textContent=s;}
async function testAI(){var b=$('aiList');b.innerHTML='Testing...';var r=await api('aitest');
  var x=r.rewind;if(x&&x.ok)b.innerHTML='<div>OK rewind: '+x.ms+'ms ACTIVE</div>';
  else b.innerHTML='<div style="color:#f85149">FAIL rewind: '+(x?.status||'')+' '+esc(x?.error||'')+'</div>';}
async function refresh(){try{var d=await api('stats');setS(d.status);
$('ap').textContent=d.adminPhone||'-';
$('w').textContent=(d.window&&d.window.time)||'-';
$('ns').textContent=(d.window&&d.window.nsfw)||'-';
$('dm').textContent=(d.window&&d.window.dmAI)||'-';
$('ai').textContent=(d.ai&&d.ai.active)||'NONE';
$('mg').textContent=d.mainGroup||'NOT SET';
$('bn').textContent=d.botNumber||'-';
$('bl').textContent=d.botLid||'unknown';
var u=d.uptime||0,h=Math.floor(u/3600),m=Math.floor((u%3600)/60),s=u%60;
$('up').textContent=h+'h '+m+'m '+s+'s';
$('pz').textContent=d.paused?'yes':'no';
$('aa').textContent=d.adminActive?'YES':'no';
if(!d.mainGroup){$('noMain').classList.add('show');}else{$('noMain').classList.remove('show');}
$('mgStatus').textContent=d.mainGroup?'SET':'NOT SET';
$('mgJid').textContent=d.mainGroup||'-';
$('mainLids').textContent=(d.mainGroupLids||0);
var p=d.policy||{};$('age').textContent=(p.ageDays||0)+'d';
$('recip').textContent=(p.recipientsToday||0)+' / '+(p.recipientLimit||0);
$('joins').textContent=(p.joinsToday||0)+' / '+(p.joinLimit||0);
$('reply').textContent=((p.replyRate||0)*100).toFixed(0)+'%';
var L=d.lanes||{fast:{},slow:{}};
$('fq').textContent=L.fast.queued||0;$('fd').textContent=L.fast.done||0;
$('sq').textContent=L.slow.queued||0;$('sd').textContent=L.slow.done||0;
$('g').textContent=d.joinedGroups||0;$('d').textContent=d.dmCount||0;
$('jq').textContent=d.queueSize||0;$('pd').textContent=d.pendingCount||0;
var t=d.dailyStats||{};$('dms').textContent=t.dmsReplied||0;
$('reads').textContent=t.readsSent||0;$('typs').textContent=t.typingsSent||0;
$('del').textContent=t.deletesDone||0;
var pr=(d.ai&&d.ai.providers)||{};var x=pr.rewind;
if(x){if(x.ok)$('aiList').innerHTML='<div>OK rewind: '+x.ms+'ms <span class="ai-badge">ACTIVE</span></div>';
else $('aiList').innerHTML='<div style="color:#f85149">FAIL rewind: '+(x.status||'')+' '+esc(x.error||'')+'</div>';}
else $('aiList').innerHTML='<div style="opacity:0.5">Not tested</div>';
var q=await api('qr-data');if(q.qr&&q.status==='qr'){$('qrImg').src='/admin/qr?t='+Date.now();$('qrImg').style.display='block';}
else $('qrImg').style.display='none';}catch(e){}}
async function a(x){await api(x,'POST');setTimeout(refresh,1000);}
function logs(){var es=new EventSource('/admin/logs');es.onmessage=function(e){try{var en=JSON.parse(e.data);var div=document.createElement('div');var t=new Date(en.ts).toLocaleTimeString();
div.innerHTML='<span style="color:#484f58">'+t+'</span> <span style="color:#58a6ff">['+en.level+']</span> <span style="color:#8b949e">'+esc(en.source)+'</span> '+esc(en.message);
var b=$('logs');b.appendChild(div);b.scrollTop=b.scrollHeight;while(b.children.length>300)b.removeChild(b.firstChild);}catch(e){}};
es.onerror=function(){es.close();setTimeout(logs,5000);};}
function msgs(){var es=new EventSource('/admin/messages-stream');es.onmessage=function(e){try{var m=JSON.parse(e.data);var div=document.createElement('div');
div.style.padding='6px 10px';div.style.margin='4px 0';div.style.borderRadius='4px';
div.style.borderLeft='3px solid '+(m.chatType==='group'?'#a371f7':(m.isAdmin?'#da3633':'#3fb950'));
div.style.background=m.mediaType==='system'?'#1a1d3a':(m.isAdmin?'#2d1517':'transparent');
var badge=m.mediaType==='system'?'<span class="sys-badge">SYSTEM</span>':(m.isAdmin?'<span class="admin-badge">ADMIN</span>':'');
div.innerHTML='<div style="color:#8b949e;font-size:11px">'+new Date(m.ts).toLocaleTimeString()+' | <span style="color:#58a6ff">'+esc(m.senderName)+'</span>'+badge+' | '+esc(m.phone)+'</div><div style="white-space:pre-wrap">'+esc(m.text)+'</div>';
var b=$('msgs');b.appendChild(div);b.scrollTop=b.scrollHeight;while(b.children.length>250)b.removeChild(b.firstChild);}catch(e){}};
es.onerror=function(){es.close();setTimeout(msgs,5000);};}
refresh();logs();msgs();setInterval(refresh,5000);
</script></body></html>`;

app.get('/', function(req,res){ res.send(PANEL_HTML); });
app.get('/admin', function(req,res){ res.send(PANEL_HTML); });

app.get('/health', function(req,res){ res.json({
  ok:true, ts:Date.now(), status:connectionStatus,
  uptime: Math.floor((Date.now()-botStartTime)/1000),
  lanes: jobs.stats(),
  window: { time: describeWindow(), nsfw: describeNsfw(), dmAI: describeDm() },
  paused: botPaused, adminActive: isAdminActive(),
  mainGroup: mainGroupJid,
  botNumber, botLid,
  groups: joinedGroups.size, dms: activeDMs.size, queue: joinQueue.length,
  ai: { active: activeProvider, providers: providerReport },
  consecutive515
}); });

app.get('/api/status', function(req,res){ res.json({
  status: connectionStatus, botNumber, botLid,
  groups: joinedGroups.size, dms: activeDMs.size,
  queue: joinQueue.length, lanes: jobs.stats(), mainGroup: mainGroupJid,
  adminLids: [...adminLids], ai: { active: activeProvider, providers: providerReport }
}); });

app.get('/admin/qr', async function(req,res){
  if (!qrDataUri) return res.status(404).json({ error:'No QR' });
  const b64 = qrDataUri.replace(/^data:image\/\w+;base64,/,'');
  res.writeHead(200, { 'Content-Type':'image/png' });
  res.end(Buffer.from(b64, 'base64'));
});
app.get('/admin/qr-data', function(req,res){ res.json({ qr: qrDataUri, status: connectionStatus, botNumber }); });
app.post('/admin/connect', function(req,res){ if (!sock) connectBot(); res.json({ ok:true }); });
app.post('/admin/reconnect', async function(req,res){ await disconnectBot(); setTimeout(function(){ manualDisconnect=false; connectBot(); },1000); res.json({ ok:true }); });
app.post('/admin/disconnect', async function(req,res){ await disconnectBot(); res.json({ ok:true }); });
app.post('/admin/refresh-qr', function(req,res){ refreshQR(); res.json({ ok:true }); });
app.post('/admin/clear-session', function(req,res){ try { fs.rmSync(AUTH_FOLDER, { recursive:true, force:true }); } catch(e){} res.json({ ok:true }); });
app.post('/admin/pause', function(req,res){ botPaused = true; res.json({ ok:true }); });
app.post('/admin/resume', function(req,res){ botPaused = false; res.json({ ok:true }); });
app.post('/admin/offline', function(req,res){
  const mins = parseInt(req.body && req.body.minutes, 10) || 30;
  botOfflineUntil = Date.now() + mins*60000;
  res.json({ ok:true, until: new Date(botOfflineUntil).toISOString() });
});
app.post('/admin/online', function(req,res){ botOfflineUntil = 0; res.json({ ok:true }); });
app.post('/admin/clear-main', function(req,res){ clearMainGroup(); res.json({ ok:true }); });

app.get('/admin/logs', function(req,res){
  res.writeHead(200, { 'Content-Type':'text/event-stream', 'Cache-Control':'no-cache', Connection:'keep-alive' });
  for (const e of logBuffer.slice(-100)) res.write('data: '+JSON.stringify(e)+'\n\n');
  logClients.add(res); req.on('close', function(){ logClients.delete(res); });
});
app.get('/admin/messages-stream', function(req,res){
  res.writeHead(200, { 'Content-Type':'text/event-stream', 'Cache-Control':'no-cache', Connection:'keep-alive' });
  for (const m of liveMessages.slice(-100)) res.write('data: '+JSON.stringify(m)+'\n\n');
  msgClients.add(res); req.on('close', function(){ msgClients.delete(res); });
});

app.get('/admin/aitest', async function(req,res){ res.json(await testAllProviders()); });
app.get('/admin/flow', function(req,res){
  const age = getAccountAgeDays();
  res.json({
    ageDays: age,
    recipientsToday: Object.keys(policyState.dailyRecipients).length,
    recipientLimit: dailyRecipientLimit(age),
    joinsToday: policyState.dailyJoins,
    joinLimit: dailyJoinLimit(age),
    replyRate: replyRate(),
    broadcastsAllowed: broadcastsAllowed(),
    mainGroup: mainGroupJid,
    adminActive: isAdminActive(),
    adminActiveUntil: new Date(adminActiveUntil).toISOString(),
    deletes: { min: deleteHist.min.length, hour: deleteHist.hour.length, day: deleteHist.day.length },
    fibIdx: { ...fibIdx },
    mainGroupLids: recentGroupLids.size,
    botLid
  });
});
app.get('/admin/stats', function(req,res){
  resetDailyStats();
  const age = getAccountAgeDays();
  res.json({
    status: connectionStatus, botNumber, botLid,
    uptime: Math.floor((Date.now()-botStartTime)/1000),
    dmCount: activeDMs.size, groupCount: joinedGroups.size,
    joinedGroups: joinedGroups.size, queueSize: joinQueue.length,
    dailyStats, adminPhone: ADMIN_PHONE, adminLids: [...adminLids],
    pendingCount: pendingRequests.size,
    lanes: jobs.stats(), focus: focus.stats(),
    window: { time: describeWindow(), nsfw: describeNsfw(), dmAI: describeDm() },
    dmQueueLength: dmQueue.length, dmQueueMax: DM_QUEUE_MAX,
    paused: botPaused,
    adminActive: isAdminActive(),
    mainGroup: mainGroupJid,
    mainGroupLids: recentGroupLids.size,
    mainGroupPhones: recentGroupPhones.size,
    ai: { active: activeProvider, providers: providerReport },
    policy: {
      ageDays: age,
      recipientsToday: Object.keys(policyState.dailyRecipients).length,
      recipientLimit: dailyRecipientLimit(age),
      joinsToday: policyState.dailyJoins,
      joinLimit: dailyJoinLimit(age),
      replyRate: replyRate(),
      broadcastsAllowed: broadcastsAllowed()
    }
  });
});

/* ══════════════════════════════════════════════════════════════
 *  PERIODIC TASKS
 * ══════════════════════════════════════════════════════════════ */
setInterval(function(){ axios.get('http://localhost:'+PORT+'/health').catch(function(){}); }, 240000);
setInterval(function(){
  const now = Date.now();
  for (const [k,v] of downloadPicks){ if (now - v.ts > DOWNLOAD_PICK_TTL) downloadPicks.delete(k); }
}, 60000);
setInterval(function(){
  const now = Date.now();
  for (const [k, t] of antilinkWarnCooldown){ if (now - t > 10 * 60 * 1000) antilinkWarnCooldown.delete(k); }
}, 120000);
setInterval(prunePolicyMaps, 60 * 60 * 1000);
setInterval(checkReplyRatio, 5 * 60 * 1000);

/* ══════════════════════════════════════════════════════════════
 *  BOOT
 * ══════════════════════════════════════════════════════════════ */
loadState();
loadGroupSettings();
loadLearningData();
loadPolicy();

app.listen(PORT, async function(){
  console.log('Port '+PORT);
  console.log('Admin: '+ADMIN_PHONE);
  console.log('Main group: '+(mainGroupJid||'NOT SET'));
  console.log('AI: Rewind only');
  console.log('Typing: '+(ENABLE_TYPING?'ON':'OFF')+' · Reads: '+(ENABLE_READ_RECEIPTS?'ON':'OFF'));
  console.log('Admin active window: '+ADMIN_ACTIVE_MS/1000+'s');
  console.log('ENV: REWIND='+(REWIND_KEY_ENV?'set':'MISSING'));
  console.log('LID-aware admin detection: ENABLED');

  pushLog('info','system','Boot port '+PORT);
  pushLog('info','system','Admin: '+ADMIN_PHONE);
  pushLog('info','system','Main: '+(mainGroupJid||'NOT SET — use !setmain'));
  pushLog('info','policy','Age '+getAccountAgeDays()+'d · '+dailyRecipientLimit(getAccountAgeDays())+' rec/day · '+dailyJoinLimit(getAccountAgeDays())+' joins/day');
  pushLog('info','policy','Typing='+(ENABLE_TYPING?'ON':'OFF')+' Reads='+(ENABLE_READ_RECEIPTS?'ON':'OFF')+' Block='+(ENABLE_CONTENT_BLOCK?'ON':'OFF'));
  pushLog('info','env','REWIND='+(REWIND_KEY_ENV?'set':'MISSING'));
  pushLog('info','admin','LID-aware detection enabled');

  findWorkingY2MateHost().then(h => {
    if (h) pushLog('success','yt','y2mate host: '+h);
    else pushLog('error','yt','no y2mate host');
  });

  scheduleGreetings();
  scheduleDailyReport();
  scheduleGroupJoins();
  scheduleHumanPresence();

  connectBot().catch(function(err){ pushLog('error','system','Boot: '+err.message); });
});

process.on('SIGINT', async function(){
  pushLog('warn','system','SIGINT');
  try { if (sock) sock.end(undefined); } catch(e){}
  process.exit(0);
});
process.on('SIGTERM', async function(){
  pushLog('warn','system','SIGTERM');
  try { if (sock) sock.end(undefined); } catch(e){}
  process.exit(0);
});
process.on('uncaughtException', function(e){ pushLog('error','uncaught', e.message); });
process.on('unhandledRejection', function(e){ pushLog('error','unhandled', String(e)); });
