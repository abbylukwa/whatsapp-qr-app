'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const NodeCache = require('node-cache');
const { spawn, execSync } = require('child_process');
const {
  makeWASocket, DisconnectReason, useMultiFileAuthState,
  Browsers, fetchLatestBaileysVersion, downloadMediaMessage
} = require('@whiskeysockets/baileys');

let wrapSocket = null, createHumanEntropyService = null, classifyDisconnect = null, SessionHealthMonitor = null;
try {
  const antiban = require('baileys-antiban');
  wrapSocket = antiban.wrapSocket || null;
  createHumanEntropyService = antiban.createHumanEntropyService || null;
  classifyDisconnect = antiban.classifyDisconnect || null;
  SessionHealthMonitor = antiban.SessionHealthMonitor || null;
} catch (e) {}

const QRCode = require('qrcode');
const pino = require('pino');
const axios = require('axios');

const PORT = process.env.PORT || 10000;
const AUTH_FOLDER = 'auth_info';
const ADMIN_PHONE = (process.env.ADMIN_PHONE || '263777627210').replace(/\D/g, '');
const ADMIN_JID = `${ADMIN_PHONE}@s.whatsapp.net`;
const ADMIN_LID_FILE = path.join(__dirname, 'admin_lids.json');
const HARDCODED_ADMIN_LIDS = ['115110005706891'];
const ADMIN_GROUP_LINK = 'https://chat.whatsapp.com/HGW3IdVbDJyImOgp1BFqT7?s=sw&p=a&mlu=4&ilr=4';
const ADMIN_GROUP_JID_FILE = path.join(__dirname, 'admin_group_jid.json');
const REWIND_KEY = process.env.REWIND_KEY || 'sk-rewind-31c3a65acc981512de959195485deec0';
const SCRAPER_URL = (process.env.SCRAPER_URL || 'https://intelligent-scraper.onrender.com').replace(/\/$/, '');
const JOIN_INTERVAL_MS = parseInt(process.env.JOIN_INTERVAL_MS || '480000', 10);
const JOIN_QUEUE_FILE = path.join(__dirname, 'join_queue.json');
const JOINED_GROUPS_FILE = path.join(__dirname, 'joined_groups.json');
const PENDING_FILE = path.join(__dirname, 'pending_requests.json');
const LEARNING_DATA_FILE = path.join(__dirname, 'learning_data.json');
const GROUP_SETTINGS_FILE = path.join(__dirname, 'group_settings.json');
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
const GREETING_MIN_HOURS = 4, GREETING_MAX_HOURS = 8;
const DAILY_REPORT_HOUR = parseInt(process.env.DAILY_REPORT_HOUR || '22', 10);
const USER_HISTORY_SIZE = 4;
const PENDING_EXPIRY_MS = 3600000;
const DM_QUEUE_MAX = 50;
const FOCUS_LOCK_TIMEOUT_MS = 30000;
const MESSAGE_FLOOD_THRESHOLD = 20;
const FLOOD_IGNORE_MS = 5000;
const TZ_OFFSET_HOURS = parseInt(process.env.TZ_OFFSET_HOURS || '2', 10);
const GROUP_ACTIVE_START = 21;
const GROUP_ACTIVE_END = 0;
const NSFW_START = 21;
const NSFW_END = 8;
const MEDIA_MAX_BYTES = 34 * 1024 * 1024;
const MENU_ACTIVE_START = 8;
const MENU_ACTIVE_END = 22;

let botPaused = false;
let botFrozen = false;

const FIBONACCI_SECONDS = [1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377, 610];
class FibonacciClock {
  constructor() { this.idx = 0; this.history = []; }
  next() {
    const roll = Math.random();
    if (roll < 0.08) this.idx = Math.floor(Math.random() * 3);
    else if (roll < 0.28) this.idx = (this.idx + 2) % FIBONACCI_SECONDS.length;
    else this.idx = (this.idx + 1) % FIBONACCI_SECONDS.length;
    const sec = FIBONACCI_SECONDS[this.idx];
    this.history.push(sec);
    if (this.history.length > 50) this.history.shift();
    return sec * 1000;
  }
  peek() { return FIBONACCI_SECONDS[this.idx] * 1000; }
  nextCapped(maxSeconds) { return Math.min(this.next(), maxSeconds * 1000); }
}
const fib = new FibonacciClock();

class TimeWindowGate {
  constructor(offsetHours = 2) { this.offset = offsetHours; }
  localHour() { return (new Date().getUTCHours() + this.offset) % 24; }
  window() {
    const h = this.localHour();
    if (h >= 22 || h < 6) return 'sleep';
    if (h >= 6 && h < 8) return 'light';
    if (h >= 12 && h < 13) return 'lunch';
    if (h >= 18 && h < 19) return 'dinner';
    if (h >= 20) return 'light';
    return 'active';
  }
  isOffline() { const w = this.window(); return w === 'sleep' || w === 'lunch' || w === 'dinner'; }
  speedFactor() { const w = this.window(); return w === 'active' ? 1.0 : w === 'light' ? 0.5 : (w === 'lunch' || w === 'dinner') ? 0.1 : 0.0; }
  isGroupActive() {
    const h = this.localHour();
    if (GROUP_ACTIVE_START <= GROUP_ACTIVE_END) return h >= GROUP_ACTIVE_START && h < GROUP_ACTIVE_END;
    return h >= GROUP_ACTIVE_START || h < GROUP_ACTIVE_END;
  }
  isNsfwActive() { const h = this.localHour(); return h >= NSFW_START || h < NSFW_END; }
  isMenuActive() {
    const h = this.localHour();
    if (MENU_ACTIVE_START <= MENU_ACTIVE_END) return h >= MENU_ACTIVE_START && h < MENU_ACTIVE_END;
    return h >= MENU_ACTIVE_START || h < MENU_ACTIVE_END;
  }
  describe() { return `${String(this.localHour()).padStart(2,'0')}:xx — ${this.window()}`; }
  describeGroup() { return this.isGroupActive() ? 'ACTIVE (21:00-00:00)' : 'IDLE'; }
  describeNsfw() { return this.isNsfwActive() ? 'ALLOWED (21:00-08:00)' : 'BLOCKED (08:00-21:00)'; }
}
const timeGate = new TimeWindowGate(TZ_OFFSET_HOURS);

const botSentIds = new Set();
function markBotSent(id) {
  if (!id) return;
  botSentIds.add(id);
  if (botSentIds.size > 2000) {
    const arr = [...botSentIds];
    botSentIds.clear();
    for (const i of arr.slice(-1000)) botSentIds.add(i);
  }
}

class SerialTaskScheduler {
  constructor() {
    this.queue = [];
    this.running = false;
    this.totalQueued = 0;
    this.totalRun = 0;
    this.totalFailed = 0;
    this.currentTask = null;
    this.frozen = false;
  }
  schedule(name, fn) {
    return new Promise((resolve, reject) => {
      if (this.frozen) { reject(new Error('Scheduler frozen')); return; }
      this.queue.push({ name, fn, resolve, reject, queuedAt: Date.now() });
      this.totalQueued++;
      this._pump();
    });
  }
  async _pump() {
    if (this.running || this.queue.length === 0 || this.frozen) return;
    this.running = true;
    const task = this.queue.shift();
    this.currentTask = task.name;
    try {
      const result = await task.fn();
      this.totalRun++;
      task.resolve(result);
    } catch (err) {
      this.totalFailed++;
      task.reject(err);
    }
    this.currentTask = null;
    this.running = false;
    if (!this.frozen) {
      const gap = fib.nextCapped(60);
      const adjusted = Math.floor(gap * Math.max(0.3, timeGate.speedFactor()));
      setTimeout(() => this._pump(), adjusted);
    }
  }
  freeze() { this.frozen = true; this.queue = []; }
  unfreeze() { this.frozen = false; this._pump(); }
  stats() {
    return {
      queued: this.queue.length, running: this.running ? 1 : 0,
      currentTask: this.currentTask, totalQueued: this.totalQueued,
      totalRun: this.totalRun, totalFailed: this.totalFailed,
      frozen: this.frozen, concurrency: 1, nextGapMs: fib.peek()
    };
  }
}
const scheduler = new SerialTaskScheduler();

class FocusPipeline {
  constructor() {
    this.busy = false;
    this.currentJid = null;
    this.currentState = 'idle';
    this.startedAt = null;
    this.lastCompletedAt = null;
  }
  async run(jid, taskFn) {
    let attempts = 0;
    while (this.busy) {
      if (++attempts > (FOCUS_LOCK_TIMEOUT_MS / 500)) throw new Error('Focus lock timeout');
      await new Promise(r => setTimeout(r, 500));
    }
    this.busy = true;
    this.currentJid = jid;
    this.startedAt = Date.now();
    try {
      const steps = [
        { name: 'notified', min: 1, max: 4 },
        { name: 'unlocked', min: 1, max: 3 },
        { name: 'opened', min: 1, max: 2 },
        { name: 'reading', min: 2, max: 8 },
        { name: 'thinking', min: 3, max: 15 }
      ];
      for (const step of steps) {
        this.currentState = step.name;
        const delay = Math.min(fib.nextCapped(step.max), step.max * 1000);
        await new Promise(r => setTimeout(r, Math.max(step.min * 1000, delay)));
      }
      this.currentState = 'typing';
      const result = await taskFn();
      this.currentState = 'reviewing';
      await new Promise(r => setTimeout(r, 1000 + Math.random() * 3000));
      this.currentState = 'sent';
      this.lastCompletedAt = Date.now();
      this.currentState = 'switching';
      const switchGap = Math.min(fib.nextCapped(20), 20000);
      await new Promise(r => setTimeout(r, switchGap));
      return result;
    } finally {
      this.busy = false;
      this.currentState = 'idle';
      this.currentJid = null;
    }
  }
  stats() {
    return {
      busy: this.busy, currentJid: this.currentJid,
      currentState: this.currentState, startedAt: this.startedAt,
      lastCompletedAt: this.lastCompletedAt
    };
  }
}
const focus = new FocusPipeline();

let dmQueue = [];
let dmQueueProcessing = false;

function enqueueDM(item) {
  if (dmQueue.length >= DM_QUEUE_MAX) {
    pushLog('warn', 'queue', `DM queue full (${DM_QUEUE_MAX}) — dropping ${item.pushName}`);
    resetDailyStats(); dailyStats.messagesDropped++;
    notifyAdmin(`Queue full — dropped message from ${item.pushName} (${item.senderJid})`).catch(() => {});
    return false;
  }
  dmQueue.push(item);
  processDMQueue();
  return true;
}

async function processDMQueue() {
  if (dmQueueProcessing) return;
  if (focus.busy || scheduler.frozen) { setTimeout(processDMQueue, 2000); return; }
  const item = dmQueue.shift();
  if (!item) return;
  dmQueueProcessing = true;
  try {
    await focus.run(item.chatJid, async () => { await processDM(item); });
  } catch (e) {
    pushLog('error', 'dmqueue', e.message);
    if (e.message === 'Focus lock timeout' || e.message === 'Bot paused') {
      dmQueue.unshift(item);
    } else {
      notifyAdmin(`DM processing failed for ${item.pushName}: ${e.message}`).catch(() => {});
    }
  } finally {
    dmQueueProcessing = false;
    if (dmQueue.length > 0) setTimeout(processDMQueue, 100);
  }
}

class GroupBatcher {
  constructor() {
    this.pending = new Map();
    this.lastBatchAt = new Map();
    this.minBatchIntervalMs = 30 * 60 * 1000;
    this.maxBatchIntervalMs = 90 * 60 * 1000;
  }
  enqueue(jid, item) {
    if (!this.pending.has(jid)) this.pending.set(jid, []);
    this.pending.get(jid).push(item);
    if (this.pending.get(jid).length > 200) this.pending.get(jid).shift();
  }
  drain(jid) {
    const last = this.lastBatchAt.get(jid) || 0;
    const since = Date.now() - last;
    const targetInterval = this.minBatchIntervalMs + Math.random() * (this.maxBatchIntervalMs - this.minBatchIntervalMs);
    if (since < targetInterval) return null;
    const items = this.pending.get(jid) || [];
    this.pending.set(jid, []);
    this.lastBatchAt.set(jid, Date.now());
    return items;
  }
  stats() {
    let total = 0;
    for (const arr of this.pending.values()) total += arr.length;
    return { groupsWithPending: this.pending.size, totalPending: total };
  }
}
const groupBatcher = new GroupBatcher();

let msgCountInWindow = 0;
let windowStart = Date.now();
let floodIgnoreUntil = 0;

function checkFlood() {
  const now = Date.now();
  if (now - windowStart > 1000) { windowStart = now; msgCountInWindow = 0; }
  msgCountInWindow++;
  if (msgCountInWindow > MESSAGE_FLOOD_THRESHOLD) {
    if (floodIgnoreUntil < now) pushLog('warn', 'flood', `Flood: ${msgCountInWindow} msgs/sec`);
    floodIgnoreUntil = now + FLOOD_IGNORE_MS;
    return true;
  }
  return false;
}

function informalize(text) {
  if (!text) return text;
  let t = text;
  if (Math.random() < 0.4) t = t.charAt(0).toLowerCase() + t.slice(1);
  if (Math.random() < 0.15) { const p = t.split(' '); if (p[0]) p[0] = p[0].toLowerCase(); t = p.join(' '); }
  if (Math.random() < 0.03) {
    const w = t.split(' '); const idx = Math.floor(Math.random() * w.length); const x = w[idx];
    if (x && x.length > 3) { const pos = 1 + Math.floor(Math.random() * (x.length - 2)); w[idx] = x.slice(0, pos) + x[pos + 1] + x[pos] + x.slice(pos + 2); t = w.join(' '); }
  }
  if (Math.random() < 0.05) { const f = ['😅', '😂', '🙃', '😊', '👀']; t += ' ' + f[Math.floor(Math.random() * f.length)]; }
  return t;
}

let adminLids = new Set(HARDCODED_ADMIN_LIDS);
function loadAdminLids() { try { if (fs.existsSync(ADMIN_LID_FILE)) { const a = JSON.parse(fs.readFileSync(ADMIN_LID_FILE, 'utf8')) || []; for (const l of a) adminLids.add(l); } } catch (e) {} }
function saveAdminLids() { try { fs.writeFileSync(ADMIN_LID_FILE, JSON.stringify([...adminLids], null, 2)); } catch (e) {} }

let groupSettings = new Map();
function loadGroupSettings() { try { if (fs.existsSync(GROUP_SETTINGS_FILE)) groupSettings = new Map(Object.entries(JSON.parse(fs.readFileSync(GROUP_SETTINGS_FILE, 'utf8')))); } catch (e) {} }
let groupSettingsDirty = false;
function saveGroupSettingsDebounced() {
  if (groupSettingsDirty) return;
  groupSettingsDirty = true;
  setTimeout(() => { try { fs.writeFileSync(GROUP_SETTINGS_FILE, JSON.stringify(Object.fromEntries(groupSettings), null, 2)); } catch (e) {} groupSettingsDirty = false; }, 5000);
}
function getGroupSetting(jid) {
  if (!groupSettings.has(jid)) {
    groupSettings.set(jid, { antilink: true, welcome: true, goodbye: true, welcomeMsg: 'Welcome {user}! 👋', goodbyeMsg: '{user} left. 👋' });
    saveGroupSettingsDebounced();
  }
  return groupSettings.get(jid);
}

let learningData = new Map();
function loadLearningData() { try { if (fs.existsSync(LEARNING_DATA_FILE)) learningData = new Map(Object.entries(JSON.parse(fs.readFileSync(LEARNING_DATA_FILE, 'utf8')))); } catch (e) {} }
let learningDirty = false;
function saveLearningDebounced() {
  if (learningDirty) return;
  learningDirty = true;
  setTimeout(() => { try { fs.writeFileSync(LEARNING_DATA_FILE, JSON.stringify(Object.fromEntries(learningData), null, 2)); } catch (e) {} learningDirty = false; }, 10000);
}
function recordGroupMessage(jid, text, sender) {
  if (!text) return;
  if (!learningData.has(jid)) learningData.set(jid, { messages: [], wordCounts: {}, emojiCounts: {}, analyzed: false, firstSeen: Date.now() });
  const d = learningData.get(jid);
  d.messages.push({ text, sender, ts: Date.now() });
  if (d.messages.length > 500) d.messages.shift();
  const words = text.toLowerCase().split(/\s+/);
  for (const w of words) { const c = w.replace(/[^a-z0-9]/g, ''); if (c.length > 2) d.wordCounts[c] = (d.wordCounts[c] || 0) + 1; }
  const emojis = text.match(/[\u{1F600}-\u{1F64F}]/gu) || [];
  for (const e of emojis) d.emojiCounts[e] = (d.emojiCounts[e] || 0) + 1;
  saveLearningDebounced();
}
function analyzeLearning(jid) {
  const d = learningData.get(jid);
  if (!d || d.messages.length < 50) return null;
  const topWords = Object.entries(d.wordCounts).sort((a, b) => b[1] - a[1]).slice(0, 20);
  const topEmojis = Object.entries(d.emojiCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  d.analyzed = true;
  d.analysis = { topWords, topEmojis, messageCount: d.messages.length, analyzedAt: Date.now() };
  saveLearningDebounced();
  return d.analysis;
}

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
  /\bhowever,? (i|it) (must|should|need)\b/i, /\bi should (mention|note|point out)\b/i
];
function containsForbidden(text) { if (!text) return true; return FORBIDDEN_PATTERNS.some(re => re.test(text)); }
function humanize(text) {
  if (!text) return '';
  let t = text;
  t = t.replace(/```[\s\S]*?```/g, '').replace(/https?:\/\/\S+/g, '');
  t = t.split('\n').filter(line => { const l = line.trim().toLowerCase(); if (!l) return true; if (/^\[?(info|warn|error|debug|trace)\]?[: ]/.test(l)) return false; if (/^\d{4}-\d{2}-\d{2}/.test(l)) return false; if (/^at\s+\w+/.test(l)) return false; return true; }).join('\n');
  const filler = [/how can i help you today\??/gi, /how may i help you\??/gi, /is there anything else.*?\?/gi, /let me know if.*?\./gi, /feel free to.*?\./gi, /i'?m? here to help\.?/gi, /i'?m? happy to help\.?/gi, /hope this helps!?/gi, /thank you for reaching out\.?/gi, /thanks for reaching out\.?/gi];
  for (const p of filler) t = t.replace(p, '');
  return t.replace(/\n{3,}/g, '\n\n').replace(/\s{2,}/g, ' ').trim();
}

const SHONA_MARKERS = ['ndi','uri','kuti','here','izvi','zvakanaka','sei','ndoda','unoda','mhoro','mangwanani','masikati','manheru','ndapota','zvinhu','vanhu','kuita','kuenda','kuuya'];
const LANG_NAMES = { sn: 'Shona', en: 'English' };
function detectLanguage(text) { if (!text) return 'en'; return text.toLowerCase().split(/\s+/).filter(w => SHONA_MARKERS.includes(w)).length > 0 ? 'sn' : 'en'; }

const LOG_BUFFER_MAX = 500;
const logBuffer = [];
const logClients = new Set();
const LIVE_MSG_MAX = 200;
const liveMessages = [];
const msgClients = new Set();

function pushLog(level, source, message, meta = {}) {
  const entry = { id: Date.now() + Math.random(), ts: new Date().toISOString(), level, source, message, meta: Object.keys(meta).length ? meta : undefined };
  logBuffer.push(entry);
  if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
  const payload = `data: ${JSON.stringify(entry)}\n\n`;
  for (const res of logClients) { try { res.write(payload); } catch (e) { logClients.delete(res); } }
}
function pushLiveMessage(entry) {
  liveMessages.push(entry);
  if (liveMessages.length > LIVE_MSG_MAX) liveMessages.shift();
  const payload = `data: ${JSON.stringify(entry)}\n\n`;
  for (const res of msgClients) { try { res.write(payload); } catch (e) { msgClients.delete(res); } }
}
async function notifyAdmin(text) {
  if (!sock) return;
  try {
    const r = await scheduler.schedule('adminAlert', () => sock.sendMessage(ADMIN_JID, { text }));
    if (r?.key?.id) markBotSent(r.key.id);
  } catch (e) { pushLog('warn', 'admin', `Alert failed: ${e.message}`); }
}
const _origError = console.error;
console.error = (...args) => { _origError.apply(console, args); pushLog('error', 'system', args.map(String).join(' ')); };

let sock = null;
let entropyService = null;
let healthMonitor = null;
let qrDataUri = null;
let connectionStatus = 'disconnected';
let botStartTime = Date.now();
let botNumber = null;
let botJid = null;
let reconnectAttempts = 0;
const MAX_RECONNECT = 10;
let isConnecting = false;
let manualDisconnect = false;

/* ============================================================
 *  ANTI-SPAM RECONNECTION STATE  (515 fix)
 *  Prevents WhatsApp from being hammered with rapid reconnects.
 * ============================================================ */
let restart515InFlight = false;       // guard against parallel restart handlers
let lastReconnectAt = 0;              // timestamp of last reconnect attempt
let consecutive515 = 0;               // how many 515s in a row (for backoff)
let recent515Timestamps = [];         // sliding window of 515 events
let spamCooldownUntil = 0;            // when to resume after spam detected
const RESTART_515_BASE_DELAY_MS = 1500;   // first 515 wait
const RESTART_515_MAX_DELAY_MS = 30000;   // backoff cap
const MIN_RECONNECT_INTERVAL_MS = 10000;  // never reconnect faster than this
const SPAM_WINDOW_MS = 60000;             // sliding window
const SPAM_THRESHOLD = 3;                 // >3× 515 in window → cool down
const SPAM_COOLDOWN_MS = 60000;           // pause duration

/* ---------- anti-spam helper functions ---------- */
function getDisconnectStatusCode(lastDisconnect) {
  return (
    lastDisconnect?.error?.output?.statusCode ??
    lastDisconnect?.error?.output?.payload?.statusCode ??
    lastDisconnect?.error?.statusCode ??
    lastDisconnect?.statusCode
  );
}
function record515() {
  const now = Date.now();
  recent515Timestamps.push(now);
  recent515Timestamps = recent515Timestamps.filter(t => now - t < SPAM_WINDOW_MS);
  if (recent515Timestamps.length > SPAM_THRESHOLD) {
    spamCooldownUntil = now + SPAM_COOLDOWN_MS;
    pushLog('warn', 'antispam', `${recent515Timestamps.length}x 515 in ${SPAM_WINDOW_MS / 1000}s — pausing ${SPAM_COOLDOWN_MS / 1000}s`);
    recent515Timestamps = [];
    consecutive515 = 0;
  }
}
function next515Delay() {
  consecutive515 += 1;
  return Math.min(
    RESTART_515_BASE_DELAY_MS * Math.pow(2, consecutive515 - 1),
    RESTART_515_MAX_DELAY_MS
  );
}
async function enforceMinReconnectInterval() {
  const now = Date.now();
  const sinceLast = now - lastReconnectAt;
  if (sinceLast < MIN_RECONNECT_INTERVAL_MS) {
    const wait = MIN_RECONNECT_INTERVAL_MS - sinceLast;
    pushLog('warn', 'antispam', `throttling reconnect — waiting ${wait}ms`);
    await new Promise(r => setTimeout(r, wait));
  }
  lastReconnectAt = Date.now();
}

const processedMessages = new Set();
const activeChats = new Set();
const activeDMs = new Set();
const replyCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });
const userHistories = new Map();
const pendingRequests = new Map();
const recentAdminCommands = new Map();

let joinQueue = [];
let joinInProgress = false;
let lastJoinAt = 0;
const joinedGroups = new Map();
const lastGreetingAt = new Map();

const scraperStats = { searchCalls: 0, searchSuccess: 0, searchFail: 0, gifCalls: 0, gifSuccess: 0, gifFail: 0, lastSearchQuery: null, lastSearchAt: null, lastGifQuery: null, lastGifAt: null };
let previewCache = { imageUrls: [], imageIndex: 0, gifUrls: [], gifIndex: 0, currentType: null, currentUrl: null };
let dailyStats = null;
let lastDailyReportDate = null;

function resetDailyStats() {
  const today = new Date().toISOString().slice(0, 10);
  if (lastDailyReportDate !== today) {
    dailyStats = { date: today, joined: 0, failed: 0, dmsReplied: 0, broadcastsSent: 0, greetingsSent: 0, scraperSearches: 0, scraperGifs: 0, picsSent: 0, videosSent: 0, aiErrors: 0, pendingCreated: 0, pendingResolved: 0, discovered: 0, imageBroadcasts: 0, badMacs: 0, focusRuns: 0, downloads: 0, nsfwDownloads: 0, adminBroadcasts: 0, groupLinksShared: 0, messagesDropped: 0, errors: 0 };
  }
}
resetDailyStats();

function loadState() {
  try { if (fs.existsSync(JOIN_QUEUE_FILE)) joinQueue = JSON.parse(fs.readFileSync(JOIN_QUEUE_FILE, 'utf8')) || []; } catch (e) { joinQueue = []; }
  try { if (fs.existsSync(JOINED_GROUPS_FILE)) { const a = JSON.parse(fs.readFileSync(JOINED_GROUPS_FILE, 'utf8')) || []; for (const g of a) { joinedGroups.set(g.jid, { name: g.name, joinedAt: g.joinedAt, discovered: g.discovered || false }); if (g.lastGreetedAt) lastGreetingAt.set(g.jid, g.lastGreetedAt); } } } catch (e) {}
  try { if (fs.existsSync(PENDING_FILE)) { const a = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8')) || []; const now = Date.now(); for (const p of a) if (now - p.requestedAt < PENDING_EXPIRY_MS) pendingRequests.set(p.id, p); } } catch (e) {}
  pushLog('info', 'state', `queue=${joinQueue.length} groups=${joinedGroups.size} pending=${pendingRequests.size} adminLids=${adminLids.size}`);
}
function saveQueue() { try { fs.writeFileSync(JOIN_QUEUE_FILE, JSON.stringify(joinQueue, null, 2)); } catch (e) {} }
function saveGroups() { try { const a = [...joinedGroups.entries()].map(([jid, v]) => ({ jid, name: v.name, joinedAt: v.joinedAt, discovered: v.discovered || false, lastGreetedAt: lastGreetingAt.get(jid) || null })); fs.writeFileSync(JOINED_GROUPS_FILE, JSON.stringify(a, null, 2)); } catch (e) {} }
function savePending() { try { fs.writeFileSync(PENDING_FILE, JSON.stringify([...pendingRequests.values()], null, 2)); } catch (e) {} }

function getAdminGroupJid() { try { if (fs.existsSync(ADMIN_GROUP_JID_FILE)) return fs.readFileSync(ADMIN_GROUP_JID_FILE, 'utf8').trim(); } catch (e) {} return null; }
function setAdminGroupJid(jid) { try { fs.writeFileSync(ADMIN_GROUP_JID_FILE, jid); pushLog('success', 'admin', `Admin group JID: ${jid}`); } catch (e) {} }

async function handleGroupParticipantsUpdate(update) {
  const { id, participants, action } = update;
  const s = getGroupSetting(id);
  for (const p of participants) {
    const user = p.split('@')[0];
    if (action === 'add' && s.welcome) { try { await queuedSend(id, { text: s.welcomeMsg.replace('{user}', user) }); } catch (e) {} }
    if (action === 'remove' && s.goodbye) { try { await queuedSend(id, { text: s.goodbyeMsg.replace('{user}', user) }); } catch (e) {} }
  }
}

async function handleAntiLink(jid, msg, text, senderJid, isAdmin) {
  const s = getGroupSetting(jid);
  if (!s.antilink || isAdmin) return false;
  const matches = text.match(/(https?:\/\/[^\s]+)/gi);
  if (!matches || matches.length === 0) return false;
  try { await sock.sendMessage(jid, { delete: msg.key }); } catch (e) {}
  pushLog('info', 'antilink', `Deleted from ${senderJid} in ${jid}`);
  try { await queuedSend(jid, { text: `⚠️ Links not allowed here, @${senderJid.split('@')[0]}` }, { mentions: [senderJid] }); } catch (e) {}
  return true;
}

function isYtDlpAvailable() { try { execSync('yt-dlp --version', { timeout: 5000, stdio: 'ignore' }); return true; } catch (e) { return false; } }

async function downloadVideo(url, type = 'normal') {
  return new Promise((resolve, reject) => {
    if (!isYtDlpAvailable()) { reject(new Error('yt-dlp not installed')); return; }
    const id = Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const outputTemplate = path.join(DOWNLOAD_DIR, `${id}.%(ext)s`);
    const args = ['-f', 'best[ext=mp4]/best', '-o', outputTemplate, '--no-playlist', '--max-filesize', '34M', '--', url];
    const proc = spawn('yt-dlp', args, { timeout: 120000 });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', (e) => reject(e));
    proc.on('close', (code) => {
      const files = fs.readdirSync(DOWNLOAD_DIR).filter(f => f.startsWith(id));
      if (files.length === 0) { reject(new Error(stderr.slice(-200) || 'No file produced')); return; }
      const filePath = path.join(DOWNLOAD_DIR, files[0]);
      const stats = fs.statSync(filePath);
      if (stats.size > MEDIA_MAX_BYTES) {
        try { fs.unlinkSync(filePath); } catch (e) {}
        reject(new Error(`File too large: ${Math.round(stats.size/1024/1024)}MB > 34MB`));
        return;
      }
      resolve({ filePath, id });
    });
  });
}

async function sendVideoFile(jid, filePath, caption = '') {
  try {
    const buffer = fs.readFileSync(filePath);
    if (buffer.length > MEDIA_MAX_BYTES) { try { fs.unlinkSync(filePath); } catch (e) {} throw new Error(`Media ${Math.round(buffer.length/1024/1024)}MB exceeds 34MB limit`); }
    const sent = await queuedSend(jid, { video: buffer, caption, mimetype: 'video/mp4' }, {}, true);
    try { fs.unlinkSync(filePath); } catch (e) {}
    return sent;
  } catch (e) {
    try { fs.unlinkSync(filePath); } catch (e2) {}
    throw e;
  }
}

async function shareGroupLink(groupLink, excludeJid) {
  const targets = [...joinedGroups.keys()].filter(j => j !== excludeJid);
  const results = { sent: 0, failed: 0, total: targets.length };
  pushLog('info', 'grouplink', `Sharing to ${targets.length} groups`);
  for (const jid of targets) {
    try { await queuedSend(jid, { text: `🔗 *Join our group:*\n${groupLink}` }); results.sent++; }
    catch (e) { results.failed++; pushLog('error', 'grouplink', `Failed ${jid}: ${e.message}`); }
  }
  pushLog('success', 'grouplink', `Done: ${results.sent}/${results.total}`);
  return results;
}

function extractAllPhoneCandidates(msg, senderJid) {
  const phones = new Set();
  const c = [msg.key?.participantPn, msg.key?.senderPn, msg.key?.remoteJidAlt, msg.key?.participantAlt, senderJid, msg.key?.remoteJid, msg.key?.participant].filter(Boolean);
  for (const x of c) { if (typeof x === 'string') { const d = x.split('@')[0].split(':')[0].replace(/\D/g, ''); if (d.length >= 10) phones.add(d); } }
  return [...phones];
}
function extractLidFromMsg(msg, senderJid) { const c = [senderJid, msg.key?.remoteJid, msg.key?.participant].filter(Boolean); for (const x of c) if (typeof x === 'string' && x.includes('@lid')) return x.split('@')[0]; return null; }
function isAdminSender(msg, senderJid) {
  const c = extractAllPhoneCandidates(msg, senderJid);
  if (c.includes(ADMIN_PHONE)) { const l = extractLidFromMsg(msg, senderJid); if (l && !adminLids.has(l)) { adminLids.add(l); saveAdminLids(); } return true; }
  for (const x of c) if (adminLids.has(x)) return true;
  const l = extractLidFromMsg(msg, senderJid);
  if (l && adminLids.has(l)) return true;
  if (typeof senderJid === 'string') { const b = senderJid.split('@')[0].split(':')[0]; if (adminLids.has(b) || b === ADMIN_PHONE) return true; }
  return false;
}
function extractPhone(msg, senderJid) { const c = extractAllPhoneCandidates(msg, senderJid); return c.length > 0 ? c[0] : null; }
function extractLid(msg, senderJid) { return extractLidFromMsg(msg, senderJid); }

function extractAllInviteCodes(text) { if (!text) return []; const s = new Set(); const re = /chat\.whatsapp\.com\/([A-Za-z0-9]{15,30})/gi; let m; while ((m = re.exec(text)) !== null) s.add(m[1]); return [...s]; }

function queueJoin(code, addedBy = 'unknown', source = 'dm') { if (!code || joinQueue.some(q => q.code === code)) return false; joinQueue.push({ code, addedAt: Date.now(), addedBy, source }); saveQueue(); pushLog('info', 'join', `Queued ${code}`); return true; }

async function processJoinQueue() {
  if (joinInProgress || !sock || connectionStatus !== 'connected' || joinQueue.length === 0) return;
  if (timeGate.isOffline()) return;
  if (Date.now() - lastJoinAt < JOIN_INTERVAL_MS) return;
  joinInProgress = true;
  const item = joinQueue.shift();
  saveQueue();
  resetDailyStats();
  try {
    pushLog('info', 'join', `Joining ${item.code}...`);
    const res = await scheduler.schedule('groupJoin', () => sock.groupAcceptInvite(item.code));
    lastJoinAt = Date.now();
    if (res) { joinedGroups.set(res, { name: null, joinedAt: Date.now(), discovered: false }); lastGreetingAt.set(res, Date.now()); saveGroups(); dailyStats.joined++; pushLog('success', 'join', `✅ Joined ${res}`); }
  } catch (e) { dailyStats.failed++; pushLog('error', 'join', `Failed: ${e.message}`); await notifyAdmin(`Join failed: ${item.code}\n${e.message}`); }
  finally { joinInProgress = false; setTimeout(processJoinQueue, JOIN_INTERVAL_MS); }
}

function createPendingRequest(userJid, userName, userPhone, history, intent) {
  const id = Math.random().toString(36).slice(2, 8);
  pendingRequests.set(id, { id, userJid, userName, userPhone, userHistory: history.slice(-USER_HISTORY_SIZE), requestedAt: Date.now(), intent });
  savePending(); resetDailyStats(); dailyStats.pendingCreated++;
  return id;
}
async function forwardToAdminForHelp(id, pending) {
  const hb = pending.userHistory.map((h, i) => `${i + 1}. ${h.text}`).join('\n');
  await notifyAdmin(`❓ *Unclear request*\n👤 ${pending.userName} (${pending.userPhone || 'no phone'})\n💬 Intent: ${pending.intent.type} — "${pending.intent.query}"\n\n*Last messages:*\n${hb}\n\nReply:\n\`!teach ${id} <query>\` / \`!teach ${id} skip\` / \`!teach ${id} say <text>\``);
}
async function resolvePending(id, action, payload, adminChatJid) {
  const p = pendingRequests.get(id);
  if (!p) return { ok: false, error: `No pending request ${id}` };
  const reply = (t) => queuedSend(adminChatJid, { text: t }, {}, true);
  try {
    if (action === 'skip') {
      const casual = await askRewind(`User said: "${p.userHistory.map(h => h.text).join(' / ')}". Reply casually.`, `You are Abby Faith Sithole, 23, Harare Zimbabwe. Warm, casual.`);
      await queuedSend(p.userJid, { text: casual || 'Sorry, couldn\'t find that 😅' });
      pendingRequests.delete(id); savePending(); resetDailyStats(); dailyStats.pendingResolved++;
      await reply(`✅ Replied casually to ${p.userName}.`);
      return { ok: true };
    }
    if (action === 'say') {
      await queuedSend(p.userJid, { text: payload });
      pendingRequests.delete(id); savePending(); resetDailyStats(); dailyStats.pendingResolved++;
      await reply(`✅ Sent to ${p.userName}.`);
      return { ok: true };
    }
    const query = payload || p.intent.query;
    await reply(`🔎 Searching "${query}"...`);
    if (p.intent.type === 'video' || p.intent.type === 'gif') {
      const r = await scraperGif(query);
      if (!r.ok || r.gifs.length === 0) { await reply(`❌ No results.`); return { ok: false }; }
      await queuedSend(p.userJid, { video: { url: r.gifs[0] }, gifPlayback: true });
      resetDailyStats(); dailyStats.picsSent++;
    } else {
      const r = await scraperSearch(query);
      if (!r.ok || r.images.length === 0) { await reply(`❌ No results.`); return { ok: false }; }
      await queuedSend(p.userJid, { image: { url: r.images[0] } });
      resetDailyStats(); dailyStats.picsSent++;
    }
    pendingRequests.delete(id); savePending(); resetDailyStats(); dailyStats.pendingResolved++;
    await reply(`✅ Sent to ${p.userName}.`);
    return { ok: true };
  } catch (e) { await reply(`❌ ${e.message}`); return { ok: false, error: e.message }; }
}

function discoverGroup(jid, groupName) {
  if (!jid || !jid.endsWith('@g.us')) return false;
  if (joinedGroups.has(jid)) return false;
  joinedGroups.set(jid, { name: groupName || null, joinedAt: Date.now(), discovered: true });
  lastGreetingAt.set(jid, Date.now());
  saveGroups(); resetDailyStats(); dailyStats.discovered++;
  pushLog('success', 'group', `Discovered ${jid}`);
  return true;
}

async function askRewind(prompt, systemPrompt) {
  if (!REWIND_KEY) return null;
  try {
    const r = await axios.post('https://api.rewind.ai/v1/chat/completions', {
      model: 'rewind-uncensored',
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }]
    }, { headers: { 'Authorization': `Bearer ${REWIND_KEY}`, 'Content-Type': 'application/json' }, timeout: 20000 });
    const raw = r.data?.choices?.[0]?.message?.content;
    if (!raw) return null;
    const c = humanize(raw);
    return c || null;
  } catch (e) {
    pushLog('error', 'ai', `Rewind: ${e.response?.status || ''} ${e.message}`);
    resetDailyStats(); dailyStats.aiErrors++;
    await notifyAdmin(`AI error: ${e.response?.status || ''} ${e.message}`).catch(() => {});
    return null;
  }
}
async function testRewindRaw() {
  if (!REWIND_KEY) return { ok: false, error: 'REWIND_KEY missing' };
  const t0 = Date.now();
  try {
    const r = await axios.post('https://api.rewind.ai/v1/chat/completions', { model: 'rewind-uncensored', messages: [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: 'Reply with exactly: AI WORKS' }] }, { headers: { 'Authorization': `Bearer ${REWIND_KEY}`, 'Content-Type': 'application/json' }, timeout: 20000 });
    return { ok: true, ms: Date.now() - t0, status: r.status, raw: r.data?.choices?.[0]?.message?.content };
  } catch (e) { return { ok: false, ms: Date.now() - t0, status: e.response?.status, error: e.message }; }
}
async function scraperSearch(query, site = 'darknaija') {
  scraperStats.searchCalls++; resetDailyStats(); dailyStats.scraperSearches++;
  try { const r = await axios.post(`${SCRAPER_URL}/search`, { query, site }, { timeout: 30000 }); scraperStats.searchSuccess++; return { ok: true, images: r.data?.images || [] }; }
  catch (e) { scraperStats.searchFail++; return { ok: false, error: e.message, images: [] }; }
}
async function scraperGif(query) {
  scraperStats.gifCalls++; resetDailyStats(); dailyStats.scraperGifs++;
  try { const r = await axios.get(`${SCRAPER_URL}/gif?q=${encodeURIComponent(query)}`, { timeout: 30000 }); scraperStats.gifSuccess++; return { ok: true, gifs: r.data?.gifs || [] }; }
  catch (e) { scraperStats.gifFail++; return { ok: false, error: e.message, gifs: [] }; }
}
async function scraperStatus() { try { const r = await axios.get(`${SCRAPER_URL}/status`, { timeout: 10000 }); return { ok: true, data: r.data }; } catch (e) { return { ok: false, error: e.message }; } }

const VAGUE_QUERIES = ['', 'something', 'anything', 'nice', 'good', 'stuff', 'it', 'them', 'some', 'please', 'pls', 'now', 'me', 'one'];
function detectMediaIntent(text) {
  const low = (text || '').toLowerCase().trim();
  if (!low) return null;
  if (/\b(gif|gifs)\b/i.test(low)) { let q = low.replace(/^.*?\b(gif|gifs)\b\s*(of|ya|ye|za)?\s*/i, '').trim().replace(/\s+/g, ' '); return { type: 'gif', query: q || 'funny' }; }
  if (/\b(video|videos|vid|vids|vidyo|mavhidhiyo)\b/i.test(low)) { let q = low.replace(/^.*?\b(video|videos|vid|vids|vidyo|mavhidhiyo)\b\s*(of|ya|ye|za)?\s*/i, '').trim().replace(/\s+/g, ' '); return { type: 'video', query: q || 'funny' }; }
  const mediaRe = /\b(pic|pics|picture|pictures|image|images|photo|photos|mapic|mapics|mufananidzo|mifananidzo)\b/i;
  if (mediaRe.test(low)) {
    let q = low.replace(/^(please\s+|pls\s+|hey\s+|hi\s+|yo\s+)?(can\s+you\s+)?(send|share|give|show|drop|post|ndipe|ndipoo|nditumire|ndiratidze|ndoda)\s+(me\s+)?(a\s+|some\s+|any\s+)?/i, '');
    q = q.replace(/\b(pic|pics|picture|pictures|image|images|photo|photos|mapic|mapics|mufananidzo|mifananidzo)\b/gi, '');
    q = q.replace(/\b(of|ya|ye|za|for|about|ndiye|wa)\b/gi, '');
    q = q.replace(/[?.!,]+/g, ' ').replace(/\s+/g, ' ').trim();
    return { type: 'image', query: q || 'naija' };
  }
  return null;
}
function detectGroupLinkRequest(text) {
  const low = (text || '').toLowerCase();
  if (/group\s*link|grouplink|link ye\s*group|join\s*link|link rekujoina|link re group/i.test(low)) return true;
  return false;
}
function isVagueQuery(q) { return !q || VAGUE_QUERIES.includes(q.toLowerCase().trim()); }

function queuedSend(jid, content, options = {}, bypassPause = false) {
  return scheduler.schedule(`send:${jid}`, async () => {
    if (!sock) throw new Error('Bot disconnected');
    if (botPaused && !bypassPause) throw new Error('Bot paused');
    const sent = await sock.sendMessage(jid, content, options);
    if (sent?.key?.id) markBotSent(sent.key.id);
    return sent;
  });
}

const GREETING_PHRASES = { morning: ['Morning all ☀️', 'Mangwanani guys ☀️', 'Good morning fam', 'Morning 🌅', 'Rise and shine ☀️'], midday: ['Hi guys 👋', 'Hey everyone', 'Hello fam 😊', 'Hi all'], evening: ['Good evening fam 🌆', 'Evening all 👋', 'Manheru guys', 'Evening everyone'], night: ['Good night all 🌙', 'Manheru akanaka 🌙', 'Sleep well fam', 'Good night everyone 💤'] };
function getTimeOfDay() { const h = timeGate.localHour(); if (h >= 5 && h < 12) return 'morning'; if (h >= 12 && h < 17) return 'midday'; if (h >= 17 && h < 21) return 'evening'; return 'night'; }
function pickGreeting(p) { const pool = GREETING_PHRASES[p] || GREETING_PHRASES.midday; return pool[Math.floor(Math.random() * pool.length)]; }

function scheduleGreetings() {
  setInterval(async () => {
    if (!sock || connectionStatus !== 'connected' || joinedGroups.size === 0 || botPaused || scheduler.frozen) return;
    if (timeGate.isOffline() || !timeGate.isGroupActive()) return;
    const now = Date.now(); const minMs = GREETING_MIN_HOURS * 3600000, maxMs = GREETING_MAX_HOURS * 3600000;
    for (const [jid] of joinedGroups) {
      const sinceLast = now - (lastGreetingAt.get(jid) || 0);
      if (sinceLast < minMs) continue;
      const progress = (sinceLast - minMs) / (maxMs - minMs);
      if (Math.random() > Math.min(progress, 1)) continue;
      const replyText = pickGreeting(getTimeOfDay());
      try { await queuedSend(jid, { text: replyText }); lastGreetingAt.set(jid, now); resetDailyStats(); dailyStats.greetingsSent++; pushLog('info', 'greeting', `Greeting: ${jid}`); }
      catch (e) { pushLog('warn', 'greeting', `Failed: ${e.message}`); }
    }
    saveGroups();
  }, 900000);
}

function scheduleDailyReport() {
  setInterval(async () => {
    if (!sock || connectionStatus !== 'connected') return;
    const now = new Date(); const today = now.toISOString().slice(0, 10);
    if (now.getHours() !== DAILY_REPORT_HOUR || lastDailyReportDate === today) return;
    lastDailyReportDate = today; resetDailyStats(); const s = dailyStats || {};
    await notifyAdmin([`📊 *Daily Summary — ${today}*`, ``, `👥 Groups: *${joinedGroups.size}*`, `💬 DMs: *${activeDMs.size}*`, `📋 Queue: *${joinQueue.length}*`, `⏳ Pending: *${pendingRequests.size}*`, ``, `✅ Joined: *${s.joined}*`, `🔍 Discovered: *${s.discovered}*`, `❌ Failed: *${s.failed}*`, `💌 DM replies: *${s.dmsReplied}*`, `🎯 Focus: *${s.focusRuns}*`, `🖼️ Media: *${s.picsSent + s.videosSent}*`, `📥 Downloads: *${s.downloads}* (NSFW: *${s.nsfwDownloads}*)`, `📢 Broadcasts: *${s.broadcastsSent}*`, `🔗 Links shared: *${s.groupLinksShared}*`, `👋 Greetings: *${s.greetingsSent}*`, `🤖 AI errors: *${s.aiErrors}*`, `💥 Bad MACs: *${s.badMacs}*`, `🗑️ Dropped: *${s.messagesDropped}*`, `🕒 Uptime: ${Math.floor((Date.now()-botStartTime)/3600000)}h`].join('\n'));
  }, 60000);
}

function scheduleGroupBatchProcessor() {
  setInterval(async () => {
    if (!sock || connectionStatus !== 'connected' || botPaused || scheduler.frozen) return;
    if (!timeGate.isGroupActive()) return;
    for (const [jid, items] of groupBatcher.pending) {
      const drained = groupBatcher.drain(jid);
      if (!drained || drained.length === 0) continue;
      pushLog('info', 'group', `Batch ${drained.length} from ${jid}`);
    }
  }, 600000);
}

async function broadcast({ message, imageUrl = null, gifUrl = null, imageBuffer = null, mode = 'all' }) {
  const targets = [];
  if (mode === 'all' || mode === 'groups') for (const jid of joinedGroups.keys()) targets.push({ jid, type: 'group' });
  if (mode === 'all' || mode === 'dms') for (const jid of activeDMs) targets.push({ jid, type: 'dm' });
  const results = { sent: 0, failed: 0, total: targets.length, errors: [], mode };
  pushLog('info', 'broadcast', `Broadcasting to ${targets.length} (${mode})`);
  for (const t of targets) {
    try {
      let content;
      if (gifUrl) content = { video: { url: gifUrl }, gifPlayback: true, caption: message || '' };
      else if (imageBuffer) content = { image: imageBuffer, caption: message || '' };
      else if (imageUrl) content = { image: { url: imageUrl }, caption: message || '' };
      else content = { text: message };
      await queuedSend(t.jid, content, {}, true);
      results.sent++; resetDailyStats(); dailyStats.broadcastsSent++;
    } catch (e) { results.failed++; results.errors.push({ jid: t.jid, error: e.message }); }
  }
  pushLog('success', 'broadcast', `Done: ${results.sent}/${results.total}`);
  return results;
}

class AdBuilder {
  static build(opts = {}) {
    const { title, body, cta, link, footer, style = 'fancy' } = opts;
    if (style === 'bold') return [`*${title || 'OFFER'}*`, '', body || '', cta ? `\n*${cta}*` : '', link ? `\n${link}` : '', footer ? `\n_${footer}_` : ''].filter(Boolean).join('\n');
    if (style === 'minimal') return [title || '', body || '', cta || '', link || ''].filter(Boolean).join('\n\n');
    const lines = ['╔══════════════════════════╗', `║ ✨ ${(title || 'OFFER').toUpperCase()} ✨`, '╚══════════════════════════╝', ''];
    if (body) lines.push(body);
    lines.push('');
    if (cta) lines.push(`*${cta}*`);
    if (link) lines.push(`${link}`);
    if (footer) lines.push(`\n_${footer}_`);
    return lines.join('\n');
  }
}

const COMMAND_LIST = `🥖 *BreadBot v46*

*Admin Control*
!pause / !resume — pause/resume bot
!freeze / !unfreeze — freeze/clear queue
!broadcast <msg> — all groups
!logs — last 30 log entries
!status — full status
!errors — recent error log
!diag — diagnostic tests
!cleanup — clear downloads folder

*Test Commands*
!test — basic status
!testall — scraper + AI + WA
!aitest — Rewind AI test
!scraperstatus — scraper health
!sched — scheduler stats
!whoami — your IDs

*Group Management*
!antilink on|off
!welcome on|off
!goodbye on|off
!setwelcome <msg with {user}>
!setgoodbye <msg with {user}>
!promote @user
!demote @user
!kick @user
!tagall
!mute / !unmute
!lock / !unlock
!groups

*Downloads*
!download <url> — video (34MB max)
!nsfw <url> — NSFW video (admin only, no time restriction)
!cleanup — clear downloads

*Group Link*
!setadmingroup
!grouplink <link> — share to all groups
!mylink — send admin group link here

*Media*
!pic <q> / !nextpic / !gif <q> / !nextgif
!bcastpic <caption> / !bcastgif <caption>
!all <msg> / !bcgroup <msg> / !bcdm <msg>

*Pending*
!pending / !teach <id> <query|say|skip>

*Other*
!ad <title>|<body>|[cta]|[link]|[style]
!bcad
!stats / !ping / !summary`;

function logRepeatedCmd(cmd, chatJid) {
  const now = Date.now();
  const key = `${chatJid}:${cmd}`;
  const last = recentAdminCommands.get(key) || 0;
  if (now - last < 30000) pushLog('warn', 'admin', `Repeated: ${cmd}`);
  recentAdminCommands.set(key, now);
}

async function handleAdminCommand(text, chatJid, msg) {
  const args = text.slice(1).trim().split(/\s+/);
  const cmd = args[0].toLowerCase();
  const reply = (t) => queuedSend(chatJid, { text: t }, { quoted: msg }, true);
  logRepeatedCmd(cmd, chatJid);

  switch (cmd) {
    case 'commands': case 'help': await reply(COMMAND_LIST); break;
    case 'ping': await reply(`🏓 Pong!\nStatus: *${connectionStatus}*\nUptime: *${Math.floor((Date.now()-botStartTime)/1000)}s*\nPaused: *${botPaused}*\nFrozen: *${scheduler.frozen}*`); break;

    case 'pause': botPaused = true; await reply('⏸️ Paused.'); break;
    case 'resume': botPaused = false; await reply('▶️ Resumed.'); break;
    case 'freeze': scheduler.freeze(); await reply('❄️ Frozen.'); break;
    case 'unfreeze': scheduler.unfreeze(); await reply('🔥 Unfrozen.'); break;

    case 'logs': {
      const recent = logBuffer.slice(-30).map(e => `[${e.level}] ${e.source}: ${e.message}`).join('\n');
      await reply(`📜 *Logs (30)*\n\n${recent.slice(0, 3500)}`);
      break;
    }

    case 'errors': {
      const errs = logBuffer.filter(e => e.level === 'error').slice(-20).map(e => `[${e.source}] ${e.message}`).join('\n');
      await reply(`❌ *Errors (20)*\n\n${errs.slice(0, 3500) || 'None'}`);
      break;
    }

    case 'diag': {
      const st = scheduler.stats();
      const f = focus.stats();
      const yt = isYtDlpAvailable();
      await reply(`🔍 *Diagnostics*\n\nConnection: *${connectionStatus}*\nBot: *${botNumber || '—'}*\nUptime: *${Math.floor((Date.now()-botStartTime)/1000)}s*\nPaused: *${botPaused}*\nFrozen: *${scheduler.frozen}*\nWindow: *${timeGate.window()}*\nGroup: *${timeGate.describeGroup()}*\nNSFW: *${timeGate.describeNsfw()}*\n\n⚙️ Sched: *${st.queued}*q / *${st.running}*r\nFocus: *${f.currentState}*\nDM queue: *${dmQueue.length}/${DM_QUEUE_MAX}*\nGroups: *${joinedGroups.size}*\nDMs: *${activeDMs.size}*\nPending: *${pendingRequests.size}*\nJoin queue: *${joinQueue.length}*\n\n🔧 yt-dlp: *${yt ? 'OK' : 'MISSING'}*\nMedia limit: *34MB*`);
      break;
    }

    case 'cleanup': {
      try {
        const files = fs.readdirSync(DOWNLOAD_DIR);
        for (const f of files) { try { fs.unlinkSync(path.join(DOWNLOAD_DIR, f)); } catch (e) {} }
        await reply(`🧹 Cleared ${files.length} files.`);
      } catch (e) { await reply(`❌ ${e.message}`); }
      break;
    }

    case 'status': case 'diag2': {
      const st = scheduler.stats();
      const f = focus.stats();
      const gb = groupBatcher.stats();
      const s = resetDailyStats() || dailyStats;
      await reply(`📊 *Status*\n\nConnection: *${connectionStatus}*\nBot: *${botNumber || '—'}*\nUptime: *${Math.floor((Date.now()-botStartTime)/1000)}s*\nPaused: *${botPaused}*\nFrozen: *${scheduler.frozen}*\nWindow: *${timeGate.window()}*\nGroup: *${timeGate.describeGroup()}*\nNSFW: *${timeGate.describeNsfw()}*\n\n⚙️ Sched: *${st.queued}q/${st.running}r*\nFocus: *${f.currentState}*\nDM queue: *${dmQueue.length}*\nGroup batch: *${gb.totalPending}* in *${gb.groupsWithPending}*\n\n📈 Today\nDM: *${dailyStats.dmsReplied}*\nFocus: *${dailyStats.focusRuns}*\nMedia: *${dailyStats.picsSent + dailyStats.videosSent}*\nDownloads: *${dailyStats.downloads}* (NSFW: *${dailyStats.nsfwDownloads}*)\nBroadcasts: *${dailyStats.broadcastsSent}*\nLinks: *${dailyStats.groupLinksShared}*\nGreetings: *${dailyStats.greetingsSent}*\nAI err: *${dailyStats.aiErrors}*\nDropped: *${dailyStats.messagesDropped}*`);
      break;
    }

    case 'test': {
      const st = scheduler.stats();
      await reply(`✅ *Test*\nBot: *${botNumber}*\nStatus: *${connectionStatus}*\nAdmin: *${ADMIN_PHONE}*\nGroups: *${joinedGroups.size}*\nDMs: *${activeDMs.size}*\nQueue: *${joinQueue.length}*\nPending: *${pendingRequests.size}*\nSched: *${st.queued}* queued\nFocus: *${focus.currentState}*`);
      break;
    }

    case 'testall': {
      await reply('🧪 Running...');
      const t0 = Date.now();
      const tests = [];
      const s1 = await scraperSearch('test');
      tests.push(`Scraper search: ${s1.ok ? `✅ ${s1.images.length}` : '❌ ' + s1.error}`);
      const s2 = await scraperGif('funny');
      tests.push(`Scraper gif: ${s2.ok ? `✅ ${s2.gifs.length}` : '❌ ' + s2.error}`);
      const rw = await testRewindRaw();
      tests.push(`Rewind AI: ${rw.ok ? `✅ ${rw.ms}ms` : `❌ ${rw.status || ''} ${rw.error}`}`);
      const st = await scraperStatus();
      tests.push(`Scraper status: ${st.ok ? '✅' : '❌ ' + st.error}`);
      tests.push(`yt-dlp: ${isYtDlpAvailable() ? '✅' : '❌ MISSING'}`);
      tests.push(`WhatsApp: ${connectionStatus === 'connected' ? '✅' : `❌ ${connectionStatus}`}`);
      tests.push(`Focus: ${focus.currentState}`);
      tests.push(`Sched: ${scheduler.queue.length} queued`);
      tests.push(`DM queue: ${dmQueue.length}/${DM_QUEUE_MAX}`);
      tests.push(`Groups: ${joinedGroups.size} | DMs: ${activeDMs.size}`);
      tests.push(`Time: ${Date.now() - t0}ms`);
      await reply(['🧪 *Test Suite*', '', ...tests].join('\n'));
      break;
    }

    case 'aitest': {
      await reply('🧪 Testing AI...');
      const r = await testRewindRaw();
      if (r.ok) await reply(`✅ AI WORKS\n${r.status} ${r.ms}ms\n${r.raw || '(empty)'}`);
      else await reply(`❌ AI FAILED\n${r.status || ''} ${r.error}`);
      break;
    }

    case 'scraperstatus': {
      await reply('🔎 Testing scraper...');
      const st = await scraperStatus();
      if (st.ok) await reply(`✅ Scraper WORKS\n${st.data.status || 'ok'}\n${Math.floor(st.data.uptime || 0)}s`);
      else await reply(`❌ Scraper FAILED\n${st.error}`);
      break;
    }

    case 'sched': {
      const st = scheduler.stats(); const f = focus.stats(); const gb = groupBatcher.stats();
      await reply(`⚙️ *Scheduler*\nQueued: *${st.queued}*\nRunning: *${st.running}*\nCurrent: *${st.currentTask || 'idle'}*\nTotal: *${st.totalRun}* ok / *${st.totalFailed}* fail\nFrozen: *${st.frozen}*\nNext gap: *${Math.round(st.nextGapMs/1000)}s*\n\n🎯 Focus: *${f.currentState}*\nBusy: *${f.busy}*\nJID: *${f.currentJid || '—'}*\n\n📦 Batch: *${gb.totalPending}* in *${gb.groupsWithPending}* groups\nDM queue: *${dmQueue.length}/${DM_QUEUE_MAX}*`);
      break;
    }

    case 'whoami': {
      const c = extractAllPhoneCandidates(msg, chatJid);
      const l = extractLid(msg, chatJid);
      const a = isAdminSender(msg, chatJid);
      await reply(`🔍 *Diagnostics*\nJID: *${msg.key.participant || msg.key.remoteJid}*\nLID: *${l || '—'}*\nCandidates: *${c.join(', ') || 'none'}*\nExpected: *${ADMIN_PHONE}*\nIs admin: *${a ? 'YES ✅' : 'NO ❌'}*\nLIDs: *${[...adminLids].join(', ') || 'none'}*`);
      break;
    }

    case 'antilink': { const on = args[1]?.toLowerCase() === 'on'; const s = getGroupSetting(chatJid); s.antilink = on; saveGroupSettingsDebounced(); await reply(`✅ Anti-link ${on ? 'ON' : 'OFF'}`); break; }
    case 'welcome': { const on = args[1]?.toLowerCase() === 'on'; const s = getGroupSetting(chatJid); s.welcome = on; saveGroupSettingsDebounced(); await reply(`✅ Welcome ${on ? 'ON' : 'OFF'}`); break; }
    case 'goodbye': { const on = args[1]?.toLowerCase() === 'on'; const s = getGroupSetting(chatJid); s.goodbye = on; saveGroupSettingsDebounced(); await reply(`✅ Goodbye ${on ? 'ON' : 'OFF'}`); break; }
    case 'setwelcome': { const t = args.slice(1).join(' '); if (!t) { await reply('❌ Usage: `!setwelcome <msg with {user}>`'); return; } const s = getGroupSetting(chatJid); s.welcomeMsg = t; saveGroupSettingsDebounced(); await reply(`✅ Welcome set.`); break; }
    case 'setgoodbye': { const t = args.slice(1).join(' '); if (!t) { await reply('❌ Usage: `!setgoodbye <msg with {user}>`'); return; } const s = getGroupSetting(chatJid); s.goodbyeMsg = t; saveGroupSettingsDebounced(); await reply(`✅ Goodbye set.`); break; }

    case 'promote': {
      const t = msg.message?.extendedTextMessage?.contextInfo?.participant || (args[1] ? args[1].replace(/\D/g, '') + '@s.whatsapp.net' : null);
      if (!t) { await reply('❌ Reply to user or give phone.'); return; }
      try { await scheduler.schedule('promote', () => sock.groupParticipantsUpdate(chatJid, [t], 'promote')); await reply('✅ Promoted.'); }
      catch (e) { await reply(`❌ ${e.message}`); }
      break;
    }
    case 'demote': {
      const t = msg.message?.extendedTextMessage?.contextInfo?.participant || (args[1] ? args[1].replace(/\D/g, '') + '@s.whatsapp.net' : null);
      if (!t) { await reply('❌ Reply to user or give phone.'); return; }
      try { await scheduler.schedule('demote', () => sock.groupParticipantsUpdate(chatJid, [t], 'demote')); await reply('✅ Demoted.'); }
      catch (e) { await reply(`❌ ${e.message}`); }
      break;
    }
    case 'kick': {
      const t = msg.message?.extendedTextMessage?.contextInfo?.participant || (args[1] ? args[1].replace(/\D/g, '') + '@s.whatsapp.net' : null);
      if (!t) { await reply('❌ Reply to user or give phone.'); return; }
      try { await scheduler.schedule('kick', () => sock.groupParticipantsUpdate(chatJid, [t], 'remove')); await reply('✅ Kicked.'); }
      catch (e) { await reply(`❌ ${e.message}`); }
      break;
    }
    case 'tagall': {
      try {
        const meta = await scheduler.schedule('meta', () => sock.groupMetadata(chatJid));
        const mentions = meta.participants.map(p => p.id);
        const list = mentions.map(j => `@${j.split('@')[0]}`).join(' ');
        await queuedSend(chatJid, { text: `📢 *Attention:*\n\n${list}`, mentions }, {}, true);
      } catch (e) { await reply(`❌ ${e.message}`); }
      break;
    }
    case 'mute': { try { await scheduler.schedule('mute', () => sock.groupSettingUpdate(chatJid, 'announcement')); await reply('🔇 Muted.'); } catch (e) { await reply(`❌ ${e.message}`); } break; }
    case 'unmute': { try { await scheduler.schedule('unmute', () => sock.groupSettingUpdate(chatJid, 'not_announcement')); await reply('🔊 Unmuted.'); } catch (e) { await reply(`❌ ${e.message}`); } break; }
    case 'lock': { try { await scheduler.schedule('lock', () => sock.groupSettingUpdate(chatJid, 'locked')); await reply('🔒 Locked.'); } catch (e) { await reply(`❌ ${e.message}`); } break; }
    case 'unlock': { try { await scheduler.schedule('unlock', () => sock.groupSettingUpdate(chatJid, 'unlocked')); await reply('🔓 Unlocked.'); } catch (e) { await reply(`❌ ${e.message}`); } break; }

    case 'groups': {
      if (joinedGroups.size === 0) { await reply('📭 No groups.'); return; }
      const list = [...joinedGroups.keys()].slice(0, 30).map((j, i) => `${i + 1}. ${j}`).join('\n');
      await reply(`👥 *Groups (${joinedGroups.size})*\n${list}`);
      break;
    }

    case 'download': {
      const url = args[1];
      if (!url) { await reply('❌ Usage: `!download <url>`'); return; }
      await reply('⏳ Downloading...');
      try {
        const { filePath } = await downloadVideo(url, 'normal');
        await sendVideoFile(chatJid, filePath, `From ${url}`);
        resetDailyStats(); dailyStats.downloads++;
        await reply('✅ Sent.');
      } catch (e) { await reply(`❌ ${e.message}`); }
      break;
    }

    case 'nsfw': {
      const url = args[1];
      if (!url) { await reply('❌ Usage: `!nsfw <url>`'); return; }
      await reply('⏳ Downloading NSFW...');
      try {
        const { filePath } = await downloadVideo(url, 'nsfw');
        await sendVideoFile(chatJid, filePath, `NSFW from ${url}`);
        resetDailyStats(); dailyStats.downloads++; dailyStats.nsfwDownloads++;
        await reply('✅ Sent.');
      } catch (e) { await reply(`❌ ${e.message}`); }
      break;
    }

    case 'setadmingroup': {
      setAdminGroupJid(chatJid);
      await reply('✅ This group is now the admin group.');
      break;
    }

    case 'grouplink': case 'grouplinkshare': {
      const link = args[1];
      if (!link || !link.includes('chat.whatsapp.com')) { await reply('❌ Usage: `!grouplink <link>`'); return; }
      await reply(`⏳ Sharing to all groups...`);
      const r = await shareGroupLink(link, chatJid);
      resetDailyStats(); dailyStats.groupLinksShared++;
      await reply(`✅ Shared: ${r.sent}/${r.total}`);
      break;
    }

    case 'mylink': {
      const link = ADMIN_GROUP_LINK;
      await queuedSend(chatJid, { text: `🔗 *Join our group:*\n${link}` }, { quoted: msg }, true);
      break;
    }

    case 'broadcast': {
      const message = args.slice(1).join(' ');
      if (!message) { await reply('❌ Usage: `!broadcast <message>`'); return; }
      const count = joinedGroups.size;
      if (count === 0) { await reply('📭 No groups.'); return; }
      await reply(`⏳ Broadcasting to ${count}...`);
      const r = await broadcast({ message, mode: 'groups' });
      resetDailyStats(); dailyStats.adminBroadcasts++;
      await reply(`✅ Done: ${r.sent}/${r.total}`);
      break;
    }

    case 'all': case 'bcgroup': case 'bcdm': {
      const message = args.slice(1).join(' ');
      if (!message) { await reply(`❌ Usage: \`!${cmd} <message>\``); return; }
      const mode = cmd === 'all' ? 'all' : (cmd === 'bcgroup' ? 'groups' : 'dms');
      const count = mode === 'all' ? (joinedGroups.size + activeDMs.size) : mode === 'groups' ? joinedGroups.size : activeDMs.size;
      if (count === 0) { await reply(`📭 No ${mode} targets.`); return; }
      await reply(`⏳ Queued to ${count} (${mode})...`);
      const r = await broadcast({ message, mode });
      await reply(`✅ Done: ${r.sent}/${r.total}`);
      break;
    }

    case 'pic': case 'search': {
      const q = args.slice(1).join(' ');
      if (!q) { await reply('❌ Usage: `!pic <query>`'); return; }
      const r = await scraperSearch(q);
      if (!r.ok || r.images.length === 0) { await reply('❌ No results'); return; }
      previewCache.imageUrls = r.images; previewCache.imageIndex = 0; previewCache.currentType = 'image'; previewCache.currentUrl = r.images[0];
      try { await queuedSend(chatJid, { image: { url: r.images[0] }, caption: `Preview 1/${r.images.length}\n!nextpic · !bcastpic <caption>` }, {}, true); }
      catch (e) { await reply(`❌ ${e.message}`); }
      break;
    }
    case 'nextpic': {
      if (previewCache.imageUrls.length === 0) { await reply('❌ No preview.'); return; }
      previewCache.imageIndex = (previewCache.imageIndex + 1) % previewCache.imageUrls.length;
      previewCache.currentUrl = previewCache.imageUrls[previewCache.imageIndex];
      try { await queuedSend(chatJid, { image: { url: previewCache.currentUrl }, caption: `Preview ${previewCache.imageIndex + 1}/${previewCache.imageUrls.length}` }, {}, true); }
      catch (e) { await reply(`❌ ${e.message}`); }
      break;
    }
    case 'gif': {
      const q = args.slice(1).join(' ');
      if (!q) { await reply('❌ Usage: `!gif <query>`'); return; }
      const r = await scraperGif(q);
      if (!r.ok || r.gifs.length === 0) { await reply('❌ No results'); return; }
      previewCache.gifUrls = r.gifs; previewCache.gifIndex = 0; previewCache.currentType = 'gif'; previewCache.currentUrl = r.gifs[0];
      try { await queuedSend(chatJid, { video: { url: r.gifs[0] }, gifPlayback: true, caption: `GIF 1/${r.gifs.length}\n!nextgif · !bcastgif <caption>` }, {}, true); }
      catch (e) { await reply(`❌ ${e.message}`); }
      break;
    }
    case 'nextgif': {
      if (previewCache.gifUrls.length === 0) { await reply('❌ No preview.'); return; }
      previewCache.gifIndex = (previewCache.gifIndex + 1) % previewCache.gifUrls.length;
      previewCache.currentUrl = previewCache.gifUrls[previewCache.gifIndex];
      try { await queuedSend(chatJid, { video: { url: previewCache.currentUrl }, gifPlayback: true, caption: `GIF ${previewCache.gifIndex + 1}/${previewCache.gifUrls.length}` }, {}, true); }
      catch (e) { await reply(`❌ ${e.message}`); }
      break;
    }
    case 'bcastpic': case 'bcastpicdm': case 'bcastpicgroup': {
      if (!previewCache.currentUrl || previewCache.currentType !== 'image') { await reply('❌ No image preview.'); return; }
      const caption = args.slice(1).join(' ') || '';
      const mode = cmd === 'bcastpic' ? 'all' : cmd === 'bcastpicdm' ? 'dms' : 'groups';
      const count = mode === 'all' ? (joinedGroups.size + activeDMs.size) : mode === 'groups' ? joinedGroups.size : activeDMs.size;
      if (count === 0) { await reply(`📭 No ${mode} targets.`); return; }
      await reply(`⏳ Queued to ${count}...`);
      const r = await broadcast({ message: caption, imageUrl: previewCache.currentUrl, mode });
      await reply(`✅ Done: ${r.sent}/${r.total}`);
      break;
    }
    case 'bcastgif': {
      if (!previewCache.currentUrl || previewCache.currentType !== 'gif') { await reply('❌ No GIF preview.'); return; }
      const caption = args.slice(1).join(' ') || '';
      const count = joinedGroups.size + activeDMs.size;
      if (count === 0) { await reply('📭 No targets.'); return; }
      await reply(`⏳ Queued to ${count}...`);
      const r = await broadcast({ message: caption, gifUrl: previewCache.currentUrl, mode: 'all' });
      await reply(`✅ Done: ${r.sent}/${r.total}`);
      break;
    }
    case 'allimg': {
      const parts = args.slice(1).join(' ').split('|').map(s => s.trim());
      const url = parts[0]; const caption = parts[1] || '';
      if (!url) { await reply('❌ Usage: `!allimg <url> | <caption>`'); return; }
      const count = joinedGroups.size + activeDMs.size;
      if (count === 0) { await reply('📭 No targets.'); return; }
      const r = await broadcast({ message: caption, imageUrl: url, mode: 'all' });
      await reply(`✅ Done: ${r.sent}/${r.total}`);
      break;
    }
    case 'ad': {
      const parts = args.slice(1).join(' ').split('|').map(p => p.trim());
      const [title, body, cta, link, style] = parts;
      if (!title || !body) { await reply('❌ Usage: `!ad <title>|<body>|[cta]|[link]|[style]`'); return; }
      const adText = AdBuilder.build({ title, body, cta, link, footer: 'Reply STOP to opt out', style: style || 'fancy' });
      await reply(`📢 *Preview:*\n\n${adText}`);
      replyCache.set('LAST_AD', adText);
      break;
    }
    case 'bcad': {
      const adText = replyCache.get('LAST_AD');
      if (!adText) { await reply('❌ No ad built.'); return; }
      const count = joinedGroups.size + activeDMs.size;
      if (count === 0) { await reply('📭 No targets.'); return; }
      const r = await broadcast({ message: adText, mode: 'all' });
      await reply(`✅ Done: ${r.sent}/${r.total}`);
      break;
    }
    case 'pending': {
      if (pendingRequests.size === 0) { await reply('📭 No pending.'); return; }
      const list = [...pendingRequests.values()].slice(0, 20).map(p => `• *${p.id}* — ${p.userName} — ${p.intent.type}: "${p.intent.query}"`).join('\n');
      await reply(`⏳ *Pending (${pendingRequests.size})*\n${list}`);
      break;
    }
    case 'teach': {
      const id = args[1];
      if (!id) { await reply('❌ Usage: `!teach <id> <query>` / `!teach <id> say <text>` / `!teach <id> skip`'); return; }
      const rest = args.slice(2).join(' ').trim();
      if (!rest) { await reply('❌ Provide action.'); return; }
      if (rest.toLowerCase() === 'skip') await resolvePending(id, 'skip', null, chatJid);
      else if (rest.toLowerCase().startsWith('say ')) await resolvePending(id, 'say', rest.slice(4).trim(), chatJid);
      else await resolvePending(id, 'search', rest, chatJid);
      break;
    }
    case 'scrapersearch': case 'scrapergif': {
      const q = args.slice(1).join(' ');
      if (!q) { await reply(`❌ Usage: \`!${cmd} <query>\``); return; }
      const r = cmd === 'scrapersearch' ? await scraperSearch(q) : await scraperGif(q);
      if (!r.ok) { await reply(`❌ Failed: ${r.error}`); return; }
      const items = r.images || r.gifs || [];
      await reply(`✅ ${items.length} results\nFirst: ${items[0] || 'none'}`);
      break;
    }
    case 'stats': {
      const s = (resetDailyStats(), dailyStats);
      await reply(`📊 *Stats*\n\n*Now*\nDMs: *${activeDMs.size}*\nGroups: *${joinedGroups.size}*\nQueue: *${joinQueue.length}*\nPending: *${pendingRequests.size}*\nDM queue: *${dmQueue.length}/${DM_QUEUE_MAX}*\nUptime: *${Math.floor((Date.now()-botStartTime)/1000)}s*\n\n*Today*\nJoined: *${s.joined}*\nDiscovered: *${s.discovered}*\nFailed: *${s.failed}*\nDM replies: *${s.dmsReplied}*\nFocus: *${s.focusRuns}*\nPics: *${s.picsSent}* / Videos: *${s.videosSent}*\nDownloads: *${s.downloads}* (NSFW: *${s.nsfwDownloads}*)\nBroadcasts: *${s.broadcastsSent}*\nLinks: *${s.groupLinksShared}*\nGreetings: *${s.greetingsSent}*\nAI err: *${s.aiErrors}*\nDropped: *${s.messagesDropped}*`);
      break;
    }
    case 'summary': {
      resetDailyStats(); const s = dailyStats;
      await reply(`📊 *Today (${s.date})*\nJoined: *${s.joined}*\nDM: *${s.dmsReplied}*\nFocus: *${s.focusRuns}*\nMedia: *${s.picsSent + s.videosSent}*\nDownloads: *${s.downloads}* (NSFW: *${s.nsfwDownloads}*)\nBroadcasts: *${s.broadcastsSent}*\nLinks: *${s.groupLinksShared}*\nGreetings: *${s.greetingsSent}*`);
      break;
    }
    default: await reply(`❓ Unknown: *!${cmd}*`);
  }
}

async function connectBot() {
  if (isConnecting) return;
  isConnecting = true;
  manualDisconnect = false;
  try {
    pushLog('info', 'bot', 'Initializing...');
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const { version } = await fetchLatestBaileysVersion();
    pushLog('info', 'bot', `WA version ${version.join('.')}`);

    const baseSocket = makeWASocket({
      version, auth: state, printQRInTerminal: false,
      browser: Browsers.macOS('Desktop'),
      logger: pino({ level: 'silent' }),
      markOnlineOnConnect: false, syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      getMessage: async () => undefined,
      qrTimeout: 300000,
      connectTimeoutMs: 120000,
      keepAliveIntervalMs: 30000
    });

    if (wrapSocket) {
      try {
        sock = wrapSocket(baseSocket, {
          groupOpGuard: { limits: { add: { max: 3, windowMs: 600000 }, create: { max: 2, windowMs: 600000 } } },
          legitimacySignals: { typoProbability: 0.02 },
          jidCanonicalizer: { enabled: true, canonical: 'pn' }
        });
        pushLog('success', 'antiban', 'Wrapped');
      } catch (e) { pushLog('warn', 'antiban', `wrapSocket: ${e.message}`); sock = baseSocket; }
    } else { sock = baseSocket; pushLog('warn', 'antiban', 'Not available'); }

    if (SessionHealthMonitor) {
      try {
        healthMonitor = new SessionHealthMonitor({
          badMacThreshold: 3, badMacWindowMs: 60000,
          onDegraded: (stats) => {
            pushLog('error', 'health', `DEGRADED: ${stats.badMacCount} Bad MACs`);
            resetDailyStats(); dailyStats.badMacs = stats.badMacCount;
            notifyAdmin(`⚠️ Session degraded — ${stats.badMacCount} Bad MACs`).catch(() => {});
          }
        });
        pushLog('info', 'health', 'Monitor started');
      } catch (e) { pushLog('warn', 'health', `Monitor failed: ${e.message}`); }
    }

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) { qrDataUri = await QRCode.toDataURL(qr); connectionStatus = 'qr'; pushLog('info', 'bot', 'QR generated'); }
      if (connection === 'open') {
        isConnecting = false; connectionStatus = 'connected'; reconnectAttempts = 0; botStartTime = Date.now();
        botJid = sock.user?.id || null; botNumber = botJid?.split(':')[0]?.split('@')[0] || 'unknown';
        // reset anti-spam counters on successful connect
        consecutive515 = 0;
        recent515Timestamps = [];
        spamCooldownUntil = 0;
        lastReconnectAt = 0;
        pushLog('success', 'bot', `Connected as ${botNumber}`);
        pushLog('info', 'time', `${timeGate.describe()} | ${timeGate.describeGroup()} | ${timeGate.describeNsfw()}`);
        if (createHumanEntropyService) {
          try {
            entropyService = createHumanEntropyService(sock, botJid, { enabled: true, minIntervalMs: 7200000, maxIntervalMs: 21600000 });
            entropyService.start();
            pushLog('success', 'entropy', 'Started');
          } catch (e) { pushLog('warn', 'entropy', `${e.message}`); }
        }
        try { await sock.sendPresenceUpdate('available'); } catch (e) {}
        await notifyAdmin(`✅ *BreadBot ONLINE*\n📱 ${botNumber}\nWindow: ${timeGate.window()}\nGroup: ${timeGate.describeGroup()}\nNSFW: ${timeGate.describeNsfw()}\n\nSend !commands`);
      }
      if (connection === 'close') {
        isConnecting = false;
        const code = getDisconnectStatusCode(lastDisconnect) ?? lastDisconnect?.error?.output?.statusCode;
        let cls = null;
        if (classifyDisconnect) { try { cls = classifyDisconnect(code); } catch (e) {} }
        if (cls) pushLog('warn', 'bot', `Disconnected (${code}) — ${cls.message} [${cls.category}]`);
        else pushLog('warn', 'bot', `Disconnected (${code})`);
        if (entropyService) { try { entropyService.stop(); } catch (e) {} entropyService = null; }
        if (manualDisconnect) { connectionStatus = 'disconnected'; return; }
        if (code === DisconnectReason.loggedOut) { connectionStatus = 'disconnected'; pushLog('error', 'bot', 'Logged out'); return; }
        if (code === 408 && connectionStatus === 'qr' && !botNumber) { connectionStatus = 'disconnected'; pushLog('warn', 'bot', 'QR expired'); return; }
        if (code === 428 || code === 440) { connectionStatus = 'disconnected'; pushLog('error', 'bot', `Conflict ${code}`); return; }

        // ─────────────────────────────────────────────
        //  🔑 515 FIX — WhatsApp wants a restart
        //  + anti-spam guard (cooldown, backoff, in-flight lock)
        // ─────────────────────────────────────────────
        if (code === DisconnectReason.restartRequired || code === 515) {
          if (restart515InFlight) {
            pushLog('warn', 'bot', '515 handler already in flight — skipping duplicate');
            return;
          }
          restart515InFlight = true;

          // wait out any active spam cooldown first
          const now = Date.now();
          if (now < spamCooldownUntil) {
            const remain = spamCooldownUntil - now;
            pushLog('warn', 'antispam', `cooldown active — waiting ${Math.ceil(remain / 1000)}s before reconnect`);
            await new Promise(r => setTimeout(r, remain));
          }

          // record this 515 for spam detection
          record515();

          // exponential backoff for consecutive 515s
          const delay = next515Delay();
          pushLog('warn', 'bot', `Retry ${delay/1000}s (515 attempt ${consecutive515})`);
          await new Promise(r => setTimeout(r, delay));

          // enforce minimum gap between reconnects
          await enforceMinReconnectInterval();

          try { sock.ev.removeAllListeners('connection.update'); } catch (e) {}
          try { sock.ev.removeAllListeners('creds.update'); } catch (e) {}
          try { sock.end(undefined); } catch (e) {}
          sock = null;
          restart515InFlight = false;

          // 515 does NOT count as a retry — it's a WhatsApp request
          connectionStatus = 'reconnecting';
          return connectBot();
        }

        const shouldReconnect = cls ? cls.shouldReconnect : true;
        if (shouldReconnect && reconnectAttempts < MAX_RECONNECT) {
          reconnectAttempts++;
          const baseDelay = 5000;
          const delay = cls?.backoffMs || Math.min(baseDelay * reconnectAttempts, 30000);
          connectionStatus = 'reconnecting';
          pushLog('warn', 'bot', `Retry ${delay/1000}s [${reconnectAttempts}/${MAX_RECONNECT}]`);
          setTimeout(() => { try { sock.end(undefined); } catch (e) {} sock = null; connectBot(); }, delay);
        } else { connectionStatus = 'disconnected'; pushLog('error', 'bot', 'Max retries'); }
      }
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('group-participants.update', async (update) => { try { await handleGroupParticipantsUpdate(update); } catch (e) { pushLog('error', 'group', e.message); } });

    sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const msg of messages || []) {
        try {
          if (entropyService && msg.key?.remoteJid && !msg.key.fromMe) { try { entropyService.addRecentContact(msg.key.remoteJid, msg.key); } catch (e) {} }
          await handleMessage(msg);
        } catch (e) { pushLog('error', 'handler', `handleMessage: ${e.message}`); }
      }
    });
  } catch (err) {
    isConnecting = false;
    pushLog('error', 'bot', `Connection failed: ${err.message}`);
    connectionStatus = 'error';
  }
}

async function disconnectBot() {
  manualDisconnect = true;
  if (entropyService) { try { entropyService.stop(); } catch (e) {} entropyService = null; }
  if (sock) { try { sock.end(undefined); } catch (e) {} sock = null; connectionStatus = 'disconnected'; qrDataUri = null; isConnecting = false; botNumber = null; pushLog('warn', 'bot', 'Disconnected'); }
}
function refreshQR() {
  qrDataUri = null; connectionStatus = 'disconnected'; manualDisconnect = true;
  if (sock) { try { sock.end(undefined); } catch (e) {} sock = null; }
  isConnecting = false; botNumber = null;
  // reset anti-spam on manual refresh
  consecutive515 = 0;
  recent515Timestamps = [];
  spamCooldownUntil = 0;
  lastReconnectAt = 0;
  restart515InFlight = false;
  pushLog('info', 'bot', 'Manual QR refresh');
  setTimeout(() => { manualDisconnect = false; connectBot(); }, 1500);
}

async function processDM(item) {
  const { msg, text, chatJid, senderJid, pushName, phone, intent, lang } = item;
  const langName = LANG_NAMES[lang] || 'English';
  if (containsForbidden(text)) { pushLog('info', 'filter', `Ignored: ${pushName}`); return; }

  if (detectGroupLinkRequest(text)) {
    const link = ADMIN_GROUP_LINK;
    await queuedSend(chatJid, { text: `🔗 *Join our group:*\n${link}` }, { quoted: msg });
    resetDailyStats(); dailyStats.dmsReplied++;
    pushLog('info', 'ai', `Sent group link to ${pushName}`);
    return;
  }

  if (intent) {
    pushLog('info', 'pic', `Intent ${intent.type} — "${intent.query}" from ${pushName}`);
    const vague = isVagueQuery(intent.query);
    if (!vague) {
      if (intent.type === 'video' || intent.type === 'gif') {
        const r = await scraperGif(intent.query);
        if (r.ok && r.gifs.length > 0) {
          try { await queuedSend(chatJid, { video: { url: r.gifs[0] }, gifPlayback: true }, { quoted: msg }); }
          catch (e) { await queuedSend(chatJid, { text: r.gifs[0] }, { quoted: msg }); }
          resetDailyStats(); if (intent.type === 'video') dailyStats.videosSent++; else dailyStats.picsSent++;
          return;
        }
      } else {
        const r = await scraperSearch(intent.query);
        if (r.ok && r.images.length > 0) {
          try { await queuedSend(chatJid, { image: { url: r.images[0] } }, { quoted: msg }); }
          catch (e) { await queuedSend(chatJid, { text: r.images[0] }, { quoted: msg }); }
          resetDailyStats(); dailyStats.picsSent++;
          return;
        }
      }
    }
    const history = userHistories.get(senderJid) || [];
    const id = createPendingRequest(senderJid, pushName, phone, history, intent);
    pushLog('warn', 'ai', `Pending ${id} for ${pushName}`);
    const ack = await askRewind(`User asked for something. Reply casually (max 8 words).`, `You are Abby Faith Sithole, 23, Harare Zimbabwe. Casual. Reply in ${langName}.`);
    const finalAck = (ack && !containsForbidden(ack)) ? informalize(ack) : 'checking rn 😊';
    try { await queuedSend(chatJid, { text: finalAck }, { quoted: msg }); } catch (e) {}
    await forwardToAdminForHelp(id, pendingRequests.get(id));
    return;
  }

  const sys = `You are Abby Faith Sithole, a 23-year-old girl from Harare, Zimbabwe. You are a REAL person. Reply in ${langName}. Mix in light Shona. Keep replies SHORT: 1-2 sentences. Never say you're an AI. Be casual, playful.`;
  const aiReply = await askRewind(text, sys);
  if (!aiReply) { pushLog('warn', 'ai', `No reply for ${pushName}`); return; }
  if (containsForbidden(aiReply)) { pushLog('warn', 'ai', `Dropped (forbidden)`); return; }
  const final = informalize(humanize(aiReply));
  if (!final) return;
  await queuedSend(chatJid, { text: final }, { quoted: msg });
  resetDailyStats(); dailyStats.dmsReplied++; dailyStats.focusRuns++;
  pushLog('info', 'ai', `DM reply to ${pushName}: ${final.slice(0, 50)}`);
}

async function handleMessage(msg) {
  if (!sock) return;
  if (checkFlood()) { resetDailyStats(); dailyStats.messagesDropped++; return; }
  if (Date.now() < floodIgnoreUntil) return;

  const chatJid = msg.key?.remoteJid;
  if (!chatJid) return;
  activeChats.add(chatJid);

  const msgId = msg.key.id;
  if (processedMessages.has(msgId)) return;
  processedMessages.add(msgId);
  if (processedMessages.size > 10000) {
    const arr = [...processedMessages];
    processedMessages.clear();
    for (const i of arr.slice(-5000)) processedMessages.add(i);
  }
  if (botSentIds.has(msgId)) return;

  let m = msg.message;
  let guard = 0;
  while (m && guard++ < 10) {
    if (m.ephemeralMessage?.message) { m = m.ephemeralMessage.message; continue; }
    if (m.viewOnceMessage?.message) { m = m.viewOnceMessage.message; continue; }
    if (m.viewOnceMessageV2?.message) { m = m.viewOnceMessageV2.message; continue; }
    if (m.deviceSentMessage?.message) { m = m.deviceSentMessage.message; continue; }
    if (m.documentWithCaptionMessage?.message) { m = m.documentWithCaptionMessage.message; continue; }
    break;
  }

  const text = m?.conversation || m?.extendedTextMessage?.text || m?.imageMessage?.caption || m?.videoMessage?.caption || '';
  const mediaType = m?.imageMessage ? 'image' : m?.videoMessage ? 'video' : m?.audioMessage ? 'audio' : m?.documentMessage ? 'document' : 'text';
  const isGroup = chatJid.endsWith('@g.us');
  const senderJid = isGroup ? (msg.key.participant || chatJid) : chatJid;
  const phone = extractPhone(msg, senderJid);
  const lid = extractLid(msg, senderJid);
  const pushName = msg.pushName || (msg.key.fromMe ? 'You' : 'Unknown');
  const chatType = isGroup ? 'group' : 'dm';

  if (isGroup) { discoverGroup(chatJid, null); recordGroupMessage(chatJid, text, senderJid); }
  else activeDMs.add(chatJid);

  pushLiveMessage({ id: msgId, ts: new Date().toISOString(), chatJid, chatType, senderJid, senderName: pushName, phone: phone || '—', lid: lid || '—', text: text.slice(0, 200) || `[${mediaType}]`, mediaType });

  const isAdmin = isAdminSender(msg, senderJid);

  if (isAdmin && text.startsWith('!')) {
    pushLog('info', 'admin', `Cmd: ${text.split(' ')[0]} (${chatType})`);
    await handleAdminCommand(text, chatJid, msg);
    return;
  }

  if (botPaused && !isAdmin) { pushLog('info', 'pause', `Paused — ${pushName}`); return; }

  if (!isGroup && isAdmin && mediaType === 'image' && text.startsWith('!')) {
    const args = text.slice(1).trim().split(/\s+/);
    const cmd = args[0].toLowerCase();
    if (['bcdm', 'bcgroup', 'all'].includes(cmd)) {
      const caption = args.slice(1).join(' ').trim();
      pushLog('info', 'broadcast', `Image ${cmd}: "${caption}"`);
      await queuedSend(chatJid, { text: `⏳ Downloading...` }, {}, true);
      try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
        if (!buffer) { await queuedSend(chatJid, { text: '❌ Failed.' }, {}, true); return; }
        if (buffer.length > MEDIA_MAX_BYTES) { await queuedSend(chatJid, { text: `❌ ${Math.round(buffer.length/1024/1024)}MB > 34MB` }, {}, true); return; }
        const mode = cmd === 'bcdm' ? 'dms' : cmd === 'bcgroup' ? 'groups' : 'all';
        const count = mode === 'all' ? (joinedGroups.size + activeDMs.size) : mode === 'groups' ? joinedGroups.size : activeDMs.size;
        if (count === 0) { await queuedSend(chatJid, { text: `📭 No ${mode}.` }, {}, true); return; }
        await queuedSend(chatJid, { text: `📸 Queued to ${count} ${mode}.` }, {}, true);
        const r = await broadcast({ message: caption, imageBuffer: buffer, mode });
        resetDailyStats(); dailyStats.imageBroadcasts++;
        await queuedSend(chatJid, { text: `✅ Done: ${r.sent}/${r.total}` }, {}, true);
      } catch (e) { pushLog('error', 'broadcast', e.message); await queuedSend(chatJid, { text: `❌ ${e.message}` }, {}, true); }
      return;
    }
  }

  if (!isGroup && !isAdmin && !msg.key.fromMe && text) {
    if (!userHistories.has(senderJid)) userHistories.set(senderJid, []);
    const h = userHistories.get(senderJid);
    h.push({ text, ts: Date.now() });
    if (h.length > USER_HISTORY_SIZE * 2) h.shift();
  }

  const codes = extractAllInviteCodes(text);
  if (codes.length > 0) {
    let added = 0;
    for (const c of codes) if (queueJoin(c, phone || pushName, chatType)) added++;
    if (added > 0) {
      pushLog('info', 'join', `Queued ${added}/${codes.length}`);
      if (!isGroup) await queuedSend(chatJid, { text: `✅ Queued ${added}. Total: ${joinQueue.length}` });
      processJoinQueue();
    }
  }

  if (isGroup) {
    await handleAntiLink(chatJid, msg, text, senderJid, isAdmin);
    if (!timeGate.isGroupActive()) { groupBatcher.enqueue(chatJid, { msg, text, ts: Date.now() }); return; }
    if (!isAdmin && text) {
      const groupLinkReq = detectGroupLinkRequest(text);
      if (groupLinkReq) { await queuedSend(chatJid, { text: `🔗 *Join:*\n${ADMIN_GROUP_LINK}` }, { quoted: msg }); return; }
      if (Math.random() < 0.08) {
        const analysis = analyzeLearning(chatJid);
        const sys = `You are Abby Faith Sithole, 23, Harare Zimbabwe. In a WhatsApp group. Reply casually Shona/English. Short (1 sentence). ${analysis ? `Use words like: ${analysis.topWords.map(w=>w[0]).join(', ')}` : ''}`;
        const aiReply = await askRewind(text, sys);
        if (aiReply && !containsForbidden(aiReply)) { await queuedSend(chatJid, { text: informalize(aiReply) }); pushLog('info', 'ai', `Group reply to ${pushName}`); }
      }
    }
    return;
  }

  if (isAdmin) { pushLog('info', 'admin', `Admin DM no cmd`); return; }

  enqueueDM({ msg, text, chatJid, senderJid, pushName, phone, intent: detectMediaIntent(text), lang: detectLanguage(text) });
}

const app = express();
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now(), status: connectionStatus, uptime: Math.floor((Date.now()-botStartTime)/1000), sched: scheduler.stats(), focus: focus.stats(), window: timeGate.window(), groupActive: timeGate.isGroupActive(), nsfwActive: timeGate.isNsfwActive(), paused: botPaused, frozen: scheduler.frozen, dmQueue: dmQueue.length, consecutive515, spamCooldownUntil: spamCooldownUntil ? new Date(spamCooldownUntil).toISOString() : null }));
app.get('/api/status', (req, res) => res.json({ status: connectionStatus, botNumber, groups: joinedGroups.size, dms: activeDMs.size, queue: joinQueue.length, pending: pendingRequests.size }));
app.get('/admin/qr', async (req, res) => { if (!qrDataUri) return res.status(404).json({ error: 'No QR' }); const b64 = qrDataUri.replace(/^data:image\/\w+;base64,/, ''); res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(Buffer.from(b64, 'base64')); });
app.get('/admin/qr-data', (req, res) => res.json({ qr: qrDataUri, status: connectionStatus, botNumber }));
app.post('/admin/connect', (req, res) => { if (!sock) connectBot(); res.json({ ok: true }); });
app.post('/admin/reconnect', async (req, res) => { await disconnectBot(); setTimeout(() => { manualDisconnect = false; connectBot(); }, 1500); res.json({ ok: true }); });
app.post('/admin/disconnect', async (req, res) => { await disconnectBot(); res.json({ ok: true }); });
app.post('/admin/refresh-qr', (req, res) => { refreshQR(); res.json({ ok: true }); });
app.post('/admin/clear-session', (req, res) => { try { fs.rmSync(AUTH_FOLDER, { recursive: true, force: true }); } catch (e) {} res.json({ ok: true, msg: 'Cleared.' }); });
app.post('/admin/pause', (req, res) => { botPaused = true; res.json({ ok: true }); });
app.post('/admin/resume', (req, res) => { botPaused = false; res.json({ ok: true }); });
app.post('/admin/freeze', (req, res) => { scheduler.freeze(); res.json({ ok: true }); });
app.post('/admin/unfreeze', (req, res) => { scheduler.unfreeze(); res.json({ ok: true }); });
app.get('/admin/logs', (req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' }); for (const e of logBuffer.slice(-100)) res.write(`data: ${JSON.stringify(e)}\n\n`); logClients.add(res); req.on('close', () => logClients.delete(res)); });
app.get('/admin/messages-stream', (req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' }); for (const m of liveMessages.slice(-100)) res.write(`data: ${JSON.stringify(m)}\n\n`); msgClients.add(res); req.on('close', () => msgClients.delete(res)); });
app.get('/admin/aitest', async (req, res) => { const r = await testRewindRaw(); res.json(r); });
app.get('/admin/scraperstatus', async (req, res) => { const r = await scraperStatus(); res.json(r); });
app.get('/admin/sched', (req, res) => res.json({ scheduler: scheduler.stats(), focus: focus.stats(), window: timeGate.window(), groupActive: timeGate.isGroupActive(), nsfwActive: timeGate.isNsfwActive(), dmQueue: dmQueue.length, groupBatcher: groupBatcher.stats(), consecutive515, spamCooldownUntil: spamCooldownUntil ? new Date(spamCooldownUntil).toISOString() : null }));
app.get('/admin/pending', (req, res) => res.json({ pending: [...pendingRequests.values()] }));
app.post('/admin/pending/:id/resolve', async (req, res) => { const { id } = req.params; const { action, payload } = req.body || {}; const r = await resolvePending(id, action || 'search', payload, ADMIN_JID); res.json(r); });
app.get('/admin/stats', (req, res) => {
  const grp = [...activeChats].filter(j => j.endsWith('@g.us')).length;
  res.json({
    status: connectionStatus, botNumber,
    uptime: Math.floor((Date.now()-botStartTime)/1000),
    dmCount: activeDMs.size, groupCount: grp, totalChats: activeChats.size,
    logCount: logBuffer.length, messageCount: liveMessages.length,
    scraperUrl: SCRAPER_URL, joinedGroups: joinedGroups.size, queueSize: joinQueue.length,
    dailyStats, scraperStats, adminPhone: ADMIN_PHONE, adminLids: [...adminLids],
    pendingCount: pendingRequests.size,
    sched: scheduler.stats(), focus: focus.stats(),
    window: timeGate.window(), groupActive: timeGate.isGroupActive(), nsfwActive: timeGate.isNsfwActive(),
    dmQueueLength: dmQueue.length, dmQueueMax: DM_QUEUE_MAX,
    groupBatcher: groupBatcher.stats(),
    paused: botPaused, frozen: scheduler.frozen,
    antibanActive: !!wrapSocket, entropyRunning: !!entropyService,
    fibonacciIndex: fib.idx,
    consecutive515,
    spamCooldownUntil: spamCooldownUntil ? new Date(spamCooldownUntil).toISOString() : null
  });
});

const PANEL_HTML = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BreadBot v46</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:monospace;background:#0d1117;color:#c9d1d9;padding:16px}h1{font-size:20px;color:#58a6ff;margin-bottom:4px}.sub{font-size:12px;color:#8b949e;margin-bottom:16px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px}.card h2{font-size:12px;color:#8b949e;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px}button{background:#21262d;border:1px solid #30363d;color:#c9d1d9;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:13px;margin:3px;font-family:inherit}button:hover{background:#30363d;border-color:#58a6ff}button.primary{background:#238636;border-color:#2ea043;color:#fff}button.danger{background:#da3633;border-color:#f85149;color:#fff}#qrImg{width:100%;max-width:240px;border-radius:8px;margin:8px auto;display:block;background:#fff;padding:8px}.status-dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;vertical-align:middle}.s-connected{background:#3fb950;box-shadow:0 0 8px #3fb950}.s-qr{background:#d29922}.s-disconnected{background:#f85149}.s-reconnecting{background:#d29922;animation:pulse 1s infinite}.s-error{background:#f85149}@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}#logs,#msgs{height:280px;overflow-y:auto;font-size:12px;line-height:1.6;background:#0d1117;border-radius:6px;padding:8px}.log-entry{padding:3px 0;border-bottom:1px solid #21262d}.log-time{color:#484f58;margin-right:8px}.log-info{color:#58a6ff}.log-success{color:#3fb950}.log-warn{color:#d29922}.log-error{color:#f85149}.log-source{color:#8b949e;margin-right:6px}.stat-row{display:flex;justify-content:space-between;padding:5px 0;font-size:13px;border-bottom:1px solid #21262d}.stat-row:last-child{border-bottom:none}.stat-val{color:#58a6ff;font-weight:600}.msg-row{padding:6px 8px;margin:4px 0;border-radius:6px;background:#161b22;border-left:3px solid #58a6ff;font-size:12px}.msg-row.group{border-left-color:#a371f7}.msg-row.dm{border-left-color:#3fb950}.msg-meta{color:#8b949e;font-size:11px;margin-bottom:2px}.msg-name{color:#58a6ff;font-weight:600}.msg-text{color:#c9d1d9;word-break:break-word}.tag{display:inline-block;padding:1px 6px;border-radius:3px;font-size:10px;margin-left:6px;font-weight:600}.tag-group{background:#a371f7;color:#fff}.tag-dm{background:#3fb950;color:#000}.full-width{grid-column:1/-1}</style></head><body>
<h1>🥖 BreadBot v46</h1><div class="sub">Admin: <b id="adminPhone">—</b> · Window: <b id="windowState">—</b> · Group: <b id="groupState">—</b> · NSFW: <b id="nsfwState">—</b></div>
<div class="grid">
<div class="card"><h2>Connection</h2><div style="margin-bottom:10px"><span class="status-dot" id="statusDot"></span><span id="statusText">Loading...</span></div><div class="stat-row"><span>Bot</span><span class="stat-val" id="botNum">—</span></div><div class="stat-row"><span>Uptime</span><span class="stat-val" id="statUptime">—</span></div><div class="stat-row"><span>Paused</span><span class="stat-val" id="pausedState">—</span></div><div class="stat-row"><span>Frozen</span><span class="stat-val" id="frozenState">—</span></div><div class="stat-row"><span>515 streak</span><span class="stat-val" id="c515">—</span></div><img id="qrImg" src="" style="display:none"><div style="margin-top:10px"><button class="primary" onclick="doAction('connect')">🔗 Start</button><button onclick="doAction('reconnect')">🔄 Reconnect</button><button onclick="doAction('refresh-qr')">♻️ Refresh QR</button><button class="danger" onclick="doAction('disconnect')">⛔ Disconnect</button><button onclick="doAction('clear-session')">🗑️ Clear Session</button><button onclick="doAction('pause')">⏸️ Pause</button><button onclick="doAction('resume')">▶️ Resume</button><button onclick="doAction('freeze')">❄️ Freeze</button><button onclick="doAction('unfreeze')">🔥 Unfreeze</button><button onclick="testAI()">🧪 Test AI</button><button onclick="testScraper()">🔎 Test Scraper</button></div><pre id="testResult" style="margin-top:8px;font-size:11px;color:#8b949e;white-space:pre-wrap;max-height:180px;overflow:auto"></pre></div>
<div class="card"><h2>🎯 Focus</h2><div class="stat-row"><span>Busy</span><span class="stat-val" id="focusBusy">—</span></div><div class="stat-row"><span>State</span><span class="stat-val" id="focusCurState">—</span></div><div class="stat-row"><span>JID</span><span class="stat-val" id="focusJid">—</span></div></div>
<div class="card"><h2>⏰ Time</h2><div class="stat-row"><span>Window</span><span class="stat-val" id="windowName">—</span></div><div class="stat-row"><span>Group</span><span class="stat-val" id="groupWindow">—</span></div><div class="stat-row"><span>NSFW</span><span class="stat-val" id="nsfwWindow">—</span></div></div>
<div class="card"><h2>⚙️ Scheduler</h2><div class="stat-row"><span>Queued</span><span class="stat-val" id="schedQueued">—</span></div><div class="stat-row"><span>Running</span><span class="stat-val" id="schedRunning">—</span></div><div class="stat-row"><span>Current</span><span class="stat-val" id="schedTask">—</span></div><div class="stat-row"><span>DM queue</span><span class="stat-val" id="dmQueue">—</span></div><div class="stat-row"><span>Next</span><span class="stat-val" id="schedGap">—</span></div></div>
<div class="card"><h2>📦 Group Batch</h2><div class="stat-row"><span>Groups pending</span><span class="stat-val" id="gbGroups">—</span></div><div class="stat-row"><span>Total pending</span><span class="stat-val" id="gbTotal">—</span></div></div>
<div class="card"><h2>Groups & Queue</h2><div class="stat-row"><span>Joined</span><span class="stat-val" id="statGroups">—</span></div><div class="stat-row"><span>DM chats</span><span class="stat-val" id="statDMs">—</span></div><div class="stat-row"><span>Join queue</span><span class="stat-val" id="statQueue">—</span></div><div class="stat-row"><span>Pending</span><span class="stat-val" id="statPending">—</span></div></div>
<div class="card"><h2>Today</h2><div class="stat-row"><span>DM replies</span><span class="stat-val" id="dayDMs">—</span></div><div class="stat-row"><span>Focus runs</span><span class="stat-val" id="dayFocus">—</span></div><div class="stat-row"><span>Pics / Videos</span><span class="stat-val" id="dayPics">—</span></div><div class="stat-row"><span>Downloads</span><span class="stat-val" id="dayDownloads">—</span></div><div class="stat-row"><span>NSFW</span><span class="stat-val" id="dayNsfw">—</span></div><div class="stat-row"><span>Broadcasts</span><span class="stat-val" id="dayBC">—</span></div><div class="stat-row"><span>Links shared</span><span class="stat-val" id="dayGrouplink">—</span></div><div class="stat-row"><span>Dropped</span><span class="stat-val" id="dayDropped">—</span></div></div>
<div class="card full-width"><h2>📨 Live Messages</h2><div id="msgs"></div></div>
<div class="card full-width"><h2>📜 Logs</h2><div id="logs"></div></div>
</div>
<script>
const $=id=>document.getElementById(id);
async function api(p,m='GET',body){const opts={method:m};if(body){opts.headers={'Content-Type':'application/json'};opts.body=JSON.stringify(body);}const r=await fetch('/admin/'+p,opts);return r.json();}
function fmt(s){const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),x=s%60;return h+'h '+m+'m '+x+'s';}
function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function setStatus(st){$('statusDot').className='status-dot s-'+st;const l={connected:'Connected',qr:'Waiting for scan',disconnected:'Disconnected',reconnecting:'Reconnecting',error:'Error'};$('statusText').textContent=l[st]||st;}
async function testAI(){const b=$('testResult');b.textContent='Testing...';const r=await api('aitest');b.textContent=JSON.stringify(r,null,2);}
async function testScraper(){const b=$('testResult');b.textContent='Testing...';const r=await api('scraperstatus');b.textContent=JSON.stringify(r,null,2);}
async function refreshStats(){try{const d=await api('stats');setStatus(d.status);$('statUptime').textContent=fmt(d.uptime);$('botNum').textContent=d.botNumber||'—';$('statGroups').textContent=d.joinedGroups;$('statDMs').textContent=d.dmCount;$('statQueue').textContent=d.queueSize;$('statPending').textContent=d.pendingCount||0;$('adminPhone').textContent=d.adminPhone||'—';$('windowState').textContent=d.window||'—';$('groupState').textContent=d.groupActive?'ACTIVE':'IDLE';$('nsfwState').textContent=d.nsfwActive?'ALLOWED':'BLOCKED';$('pausedState').textContent=d.paused?'YES':'no';$('frozenState').textContent=d.frozen?'YES':'no';$('c515').textContent=(d.consecutive515||0)+(d.spamCooldownUntil?' (paused)':'');$('windowName').textContent=d.window||'—';$('groupWindow').textContent=d.groupActive?'ACTIVE':'IDLE';$('nsfwWindow').textContent=d.nsfwActive?'ALLOWED':'BLOCKED';
const f=d.focus||{};$('focusBusy').textContent=f.busy?'YES':'no';$('focusCurState').textContent=f.currentState||'idle';$('focusJid').textContent=f.currentJid||'—';
const sc=d.sched||{};$('schedQueued').textContent=sc.queued||0;$('schedRunning').textContent=sc.running||0;$('schedTask').textContent=sc.currentTask||'idle';$('dmQueue').textContent=(d.dmQueueLength||0)+'/'+(d.dmQueueMax||50);$('schedGap').textContent=Math.round((sc.nextGapMs||0)/1000)+'s';
const gb=d.groupBatcher||{};$('gbGroups').textContent=gb.groupsWithPending||0;$('gbTotal').textContent=gb.totalPending||0;
const s=d.dailyStats||{};$('dayDMs').textContent=s.dmsReplied||0;$('dayFocus').textContent=s.focusRuns||0;$('dayPics').textContent=(s.picsSent||0)+' / '+(s.videosSent||0);$('dayDownloads').textContent=s.downloads||0;$('dayNsfw').textContent=s.nsfwDownloads||0;$('dayBC').textContent=s.broadcastsSent||0;$('dayGrouplink').textContent=s.groupLinksShared||0;$('dayDropped').textContent=s.messagesDropped||0;
const q=await api('qr-data');if(q.qr&&q.status==='qr'){$('qrImg').src='/admin/qr?t='+Date.now();$('qrImg').style.display='block';}else{$('qrImg').style.display='none';}}catch(e){}}
async function doAction(a){await api(a,'POST');setTimeout(refreshStats,1000);}
function connectLogs(){const es=new EventSource('/admin/logs');es.onmessage=e=>{try{const en=JSON.parse(e.data);const div=document.createElement('div');div.className='log-entry';const t=new Date(en.ts).toLocaleTimeString();div.innerHTML='<span class="log-time">'+t+'</span><span class="log-'+en.level+'">['+en.level.toUpperCase()+']</span> <span class="log-source">'+en.source+'</span>'+esc(en.message);const b=$('logs');b.appendChild(div);b.scrollTop=b.scrollHeight;while(b.children.length>300)b.removeChild(b.firstChild);}catch(e){}};es.onerror=()=>{es.close();setTimeout(connectLogs,5000);};}
function connectMessages(){const es=new EventSource('/admin/messages-stream');es.onmessage=e=>{try{const m=JSON.parse(e.data);const div=document.createElement('div');div.className='msg-row '+m.chatType;const t=new Date(m.ts).toLocaleTimeString();const tag=m.chatType==='group'?'<span class="tag tag-group">GROUP</span>':'<span class="tag tag-dm">DM</span>';div.innerHTML='<div class="msg-meta">'+t+tag+'</div><div><span class="msg-name">'+esc(m.senderName)+'</span> 📱 '+esc(m.phone)+' | 🆔 '+esc(m.lid)+'</div><div class="msg-text">'+esc(m.text)+'</div>';const b=$('msgs');b.appendChild(div);b.scrollTop=b.scrollHeight;while(b.children.length>200)b.removeChild(b.firstChild);}catch(e){}};es.onerror=()=>{es.close();setTimeout(connectMessages,5000);};}
refreshStats();connectLogs();connectMessages();setInterval(refreshStats,5000);
</script></body></html>`;
app.get('/', (req, res) => res.send(PANEL_HTML));
app.get('/admin', (req, res) => res.send(PANEL_HTML));

setInterval(async () => { if (connectionStatus === 'connected' && sock && !timeGate.isOffline() && !botPaused) { try { await sock.sendPresenceUpdate('available'); } catch (e) {} } }, 240000);
setInterval(() => { axios.get(`http://localhost:${PORT}/health`).catch(() => {}); }, 240000);
setInterval(processJoinQueue, 30000);

loadState();
loadAdminLids();
loadGroupSettings();
loadLearningData();
app.listen(PORT, () => {
  console.log(`Port ${PORT}`);
  console.log(`Admin: ${ADMIN_PHONE}`);
  console.log(`LIDs: ${[...adminLids].join(', ')}`);
  console.log(`Group: ${timeGate.describeGroup()} | NSFW: ${timeGate.describeNsfw()}`);
  console.log(`Media limit: 34MB`);
  console.log(`yt-dlp: ${isYtDlpAvailable()}`);
  pushLog('info', 'system', `Boot port ${PORT}`);
  pushLog('info', 'system', `Admin: ${ADMIN_PHONE}`);
  pushLog('info', 'system', `Group active 21-00 | NSFW 21-08 | Media 34MB`);
  pushLog('info', 'system', `Scraper: ${SCRAPER_URL}`);
  scheduleGreetings();
  scheduleDailyReport();
  scheduleGroupBatchProcessor();
  connectBot().catch(err => { console.error('Boot failed:', err); pushLog('error', 'system', `Boot: ${err.message}`); });
});
