'use strict';

// ================================================================
// WHATSAPP BOT v45.0
// Group management + video downloader + admin controls + human behavior
// All features preserved from v44.0
// ================================================================

const express = require('express');
const fs = require('fs');
const path = require('path');
const NodeCache = require('node-cache');
const { exec, execSync } = require('child_process');
const {
  makeWASocket, DisconnectReason, useMultiFileAuthState,
  Browsers, fetchLatestBaileysVersion, downloadMediaMessage
} = require('@whiskeysockets/baileys');

// ── baileys-antiban ──
let wrapSocket = null;
let createHumanEntropyService = null;
let classifyDisconnect = null;
let SessionHealthMonitor = null;
try {
  const antiban = require('baileys-antiban');
  wrapSocket = antiban.wrapSocket || null;
  createHumanEntropyService = antiban.createHumanEntropyService || null;
  classifyDisconnect = antiban.classifyDisconnect || null;
  SessionHealthMonitor = antiban.SessionHealthMonitor || null;
} catch (e) {
  console.log('[ANTIBAN] not installed — running without middleware');
}

const QRCode = require('qrcode');
const pino = require('pino');
const axios = require('axios');

// ================================================================
// CONFIG
// ================================================================
const PORT = process.env.PORT || 10000;
const AUTH_FOLDER = 'auth_info';
const ADMIN_PHONE = (process.env.ADMIN_PHONE || '263777627210').replace(/\D/g, '');
const ADMIN_JID = `${ADMIN_PHONE}@s.whatsapp.net`;
const ADMIN_LID_FILE = path.join(__dirname, 'admin_lids.json');
const HARDCODED_ADMIN_LIDS = ['115110005706891'];

// The group where the admin posts links to be shared (your group)
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

const GREETING_MIN_HOURS = 4;
const GREETING_MAX_HOURS = 8;
const DAILY_REPORT_HOUR = parseInt(process.env.DAILY_REPORT_HOUR || '22', 10);

const USER_HISTORY_SIZE = 4;
const PENDING_EXPIRY_MS = 60 * 60 * 1000;

// ── FLOOD HANDLING ──
const DM_QUEUE_MAX = 50;              // drop DMs beyond this
const FOCUS_LOCK_TIMEOUT_MS = 30000;  // max time a focus lock can be held
const MESSAGE_FLOOD_THRESHOLD = 20;   // messages/sec considered a flood
const FLOOD_IGNORE_MS = 5000;         // ignore messages for this long after flood detected

// ── TIME WINDOWS ──
// Zimbabwe is UTC+2. Adjust TZ_OFFSET_HOURS on Render if needed.
const TZ_OFFSET_HOURS = parseInt(process.env.TZ_OFFSET_HOURS || '2', 10);

// Group active window: 21:00 - 00:00 (9 PM - midnight)
const GROUP_ACTIVE_START = 21;
const GROUP_ACTIVE_END = 0; // 00:00 = midnight

// NSFW download window: 21:00 - 08:00
const NSFW_START = 21;
const NSFW_END = 8;

// ── GLOBAL PAUSE / FREEZE ──
let botPaused = false;
let botFrozen = false;

// ================================================================
// FIBONACCI TIMING CLOCK
// ================================================================
const FIBONACCI_SECONDS = [1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377, 610];

class FibonacciClock {
  constructor() {
    this.idx = 0;
    this.history = [];
  }
  next() {
    const roll = Math.random();
    if (roll < 0.08) {
      this.idx = Math.floor(Math.random() * 3);
    } else if (roll < 0.28) {
      this.idx = (this.idx + 2) % FIBONACCI_SECONDS.length;
    } else {
      this.idx = (this.idx + 1) % FIBONACCI_SECONDS.length;
    }
    const sec = FIBONACCI_SECONDS[this.idx];
    this.history.push(sec);
    if (this.history.length > 50) this.history.shift();
    return sec * 1000;
  }
  peek() { return FIBONACCI_SECONDS[this.idx] * 1000; }
  nextCapped(maxSeconds) {
    return Math.min(this.next(), maxSeconds * 1000);
  }
}

const fib = new FibonacciClock();

// ================================================================
// TIME WINDOW GATE
// ================================================================
class TimeWindowGate {
  constructor(offsetHours = 2) { this.offset = offsetHours; }
  localHour() {
    const d = new Date();
    return (d.getUTCHours() + this.offset) % 24;
  }
  // Existing v44.0 window
  window() {
    const h = this.localHour();
    if (h >= 22 || h < 6) return 'sleep';
    if (h >= 6 && h < 8) return 'light';
    if (h >= 12 && h < 13) return 'lunch';
    if (h >= 18 && h < 19) return 'dinner';
    if (h >= 20) return 'light';
    return 'active';
  }
  isOffline() {
    const w = this.window();
    return w === 'sleep' || w === 'lunch' || w === 'dinner';
  }
  speedFactor() {
    switch (this.window()) {
      case 'active': return 1.0;
      case 'light': return 0.5;
      case 'lunch': case 'dinner': return 0.1;
      case 'sleep': return 0.0;
      default: return 1.0;
    }
  }
  // Group active window (21:00 - 00:00)
  isGroupActive() {
    const h = this.localHour();
    if (GROUP_ACTIVE_START <= GROUP_ACTIVE_END) {
      return h >= GROUP_ACTIVE_START && h < GROUP_ACTIVE_END;
    }
    // wraps midnight (21 -> 0)
    return h >= GROUP_ACTIVE_START || h < GROUP_ACTIVE_END;
  }
  // NSFW download window (21:00 - 08:00)
  isNsfwActive() {
    const h = this.localHour();
    return h >= NSFW_START || h < NSFW_END;
  }
  describe() {
    const h = this.localHour();
    return `${String(h).padStart(2,'0')}:xx — ${this.window()} (factor ${this.speedFactor()})`;
  }
  describeGroup() {
    return this.isGroupActive() ? 'GROUP ACTIVE (21:00-00:00)' : 'GROUP IDLE (00:00-21:00)';
  }
  describeNsfw() {
    return this.isNsfwActive() ? 'NSFW ALLOWED (21:00-08:00)' : 'NSFW BLOCKED (08:00-21:00)';
  }
}

const timeGate = new TimeWindowGate(TZ_OFFSET_HOURS);

// ================================================================
// SERIAL TASK SCHEDULER
// ================================================================
class SerialTaskScheduler {
  constructor() {
    this.queue = [];
    this.running = false;
    this.totalQueued = 0;
    this.totalRun = 0;
    this.totalFailed = 0;
    this.currentTask = null;
    this.paused = false;
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
  pause() { this.paused = true; }
  resume() { this.paused = false; }
  freeze() { this.frozen = true; this.queue = []; }
  unfreeze() { this.frozen = false; }
  stats() {
    return {
      queued: this.queue.length,
      running: this.running ? 1 : 0,
      currentTask: this.currentTask,
      totalQueued: this.totalQueued,
      totalRun: this.totalRun,
      totalFailed: this.totalFailed,
      paused: this.paused,
      frozen: this.frozen,
      concurrency: 1,
      nextGapMs: fib.peek()
    };
  }
}

const scheduler = new SerialTaskScheduler();

// ================================================================
// FOCUS PIPELINE
// ================================================================
const FOCUS_STATES = ['notified', 'unlocked', 'opened', 'reading', 'thinking', 'typing', 'reviewing', 'sent', 'switching'];

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
      if (++attempts > (FOCUS_LOCK_TIMEOUT_MS / 500)) {
        pushLog('warn', 'focus', `Focus lock timeout for ${jid}`);
        throw new Error('Focus lock timeout');
      }
      await new Promise(r => setTimeout(r, 500));
    }
    this.busy = true;
    this.currentJid = jid;
    this.startedAt = Date.now();
    try {
      const steps = [
        { name: 'notified',  min: 1, max: 4 },
        { name: 'unlocked',  min: 1, max: 3 },
        { name: 'opened',    min: 1, max: 2 },
        { name: 'reading',   min: 2, max: 8 },
        { name: 'thinking',  min: 3, max: 15 }
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
      busy: this.busy,
      currentJid: this.currentJid,
      currentState: this.currentState,
      startedAt: this.startedAt,
      lastCompletedAt: this.lastCompletedAt
    };
  }
}

const focus = new FocusPipeline();

// ================================================================
// DM QUEUE (flood control)
// ================================================================
let dmQueue = [];
let dmQueueProcessing = false;

function enqueueDM(item) {
  if (dmQueue.length >= DM_QUEUE_MAX) {
    pushLog('warn', 'queue', `DM queue full (${DM_QUEUE_MAX}) — dropping message from ${item.pushName}`);
    return false;
  }
  dmQueue.push(item);
  processDMQueue();
  return true;
}

async function processDMQueue() {
  if (dmQueueProcessing) return;
  if (focus.busy || scheduler.frozen) return;
  const item = dmQueue.shift();
  if (!item) return;
  dmQueueProcessing = true;
  try {
    await focus.run(item.chatJid, async () => {
      await processDM(item);
    });
  } catch (e) {
    pushLog('error', 'dmqueue', e.message);
  } finally {
    dmQueueProcessing = false;
    if (dmQueue.length > 0) setTimeout(processDMQueue, 100);
  }
}

// ================================================================
// GROUP BATCHER
// ================================================================
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
    return { groupsWithPending: this.pending.size, totalPending: total, minBatchMin: this.minBatchIntervalMs / 60000, maxBatchMin: this.maxBatchIntervalMs / 60000 };
  }
}

const groupBatcher = new GroupBatcher();

// ================================================================
// FLOOD DETECTOR
// ================================================================
let msgCountInWindow = 0;
let windowStart = Date.now();
let floodIgnoreUntil = 0;

function checkFlood() {
  const now = Date.now();
  if (now - windowStart > 1000) {
    windowStart = now;
    msgCountInWindow = 0;
  }
  msgCountInWindow++;
  if (msgCountInWindow > MESSAGE_FLOOD_THRESHOLD) {
    if (floodIgnoreUntil < now) {
      pushLog('warn', 'flood', `Flood detected: ${msgCountInWindow} msgs/sec — ignoring for ${FLOOD_IGNORE_MS/1000}s`);
    }
    floodIgnoreUntil = now + FLOOD_IGNORE_MS;
    return true;
  }
  return false;
}

// ================================================================
// INFORMALITY LAYER
// ================================================================
function informalize(text) {
  if (!text) return text;
  let t = text;
  if (Math.random() < 0.4) t = t.charAt(0).toLowerCase() + t.slice(1);
  if (Math.random() < 0.15) { const parts = t.split(' '); if (parts[0]) parts[0] = parts[0].toLowerCase(); t = parts.join(' '); }
  if (Math.random() < 0.03) {
    const words = t.split(' '); const idx = Math.floor(Math.random() * words.length); const w = words[idx];
    if (w && w.length > 3) { const pos = 1 + Math.floor(Math.random() * (w.length - 2)); words[idx] = w.slice(0, pos) + w[pos + 1] + w[pos] + w.slice(pos + 2); t = words.join(' '); }
  }
  if (Math.random() < 0.05) { const fillers = ['😅', '😂', '🙃', '😊', '👀']; t += ' ' + fillers[Math.floor(Math.random() * fillers.length)]; }
  return t;
}

// ================================================================
// ADMIN LID STORE
// ================================================================
let adminLids = new Set(HARDCODED_ADMIN_LIDS);
function loadAdminLids() { try { if (fs.existsSync(ADMIN_LID_FILE)) { const arr = JSON.parse(fs.readFileSync(ADMIN_LID_FILE, 'utf8')) || []; for (const lid of arr) adminLids.add(lid); } } catch (e) {} }
function saveAdminLids() { try { fs.writeFileSync(ADMIN_LID_FILE, JSON.stringify([...adminLids], null, 2)); } catch (e) {} }

// ================================================================
// GROUP SETTINGS
// ================================================================
let groupSettings = new Map(); // jid -> { antilink: true, welcome: true, goodbye: true, welcomeMsg: '...', goodbyeMsg: '...' }

function loadGroupSettings() {
  try {
    if (fs.existsSync(GROUP_SETTINGS_FILE)) {
      const obj = JSON.parse(fs.readFileSync(GROUP_SETTINGS_FILE, 'utf8'));
      groupSettings = new Map(Object.entries(obj));
    }
  } catch (e) {}
}
function saveGroupSettings() {
  try { fs.writeFileSync(GROUP_SETTINGS_FILE, JSON.stringify(Object.fromEntries(groupSettings), null, 2)); } catch (e) {}
}
function getGroupSetting(jid) {
  if (!groupSettings.has(jid)) {
    groupSettings.set(jid, { antilink: true, welcome: true, goodbye: true, welcomeMsg: 'Welcome {user} to the group! 👋', goodbyeMsg: '{user} has left the group. 👋' });
    saveGroupSettings();
  }
  return groupSettings.get(jid);
}

// ================================================================
// LEARNING DATA (personality analysis)
// ================================================================
let learningData = new Map(); // jid -> { messages: [], wordCounts: {}, emojiCounts: {}, slangCounts: {}, analyzed: false }

function loadLearningData() {
  try {
    if (fs.existsSync(LEARNING_DATA_FILE)) {
      const obj = JSON.parse(fs.readFileSync(LEARNING_DATA_FILE, 'utf8'));
      learningData = new Map(Object.entries(obj));
    }
  } catch (e) {}
}
function saveLearningData() {
  try { fs.writeFileSync(LEARNING_DATA_FILE, JSON.stringify(Object.fromEntries(learningData), null, 2)); } catch (e) {}
}
function recordGroupMessage(jid, text, sender) {
  if (!learningData.has(jid)) {
    learningData.set(jid, { messages: [], wordCounts: {}, emojiCounts: {}, slangCounts: {}, analyzed: false, firstSeen: Date.now() });
  }
  const data = learningData.get(jid);
  data.messages.push({ text, sender, ts: Date.now() });
  if (data.messages.length > 500) data.messages.shift();

  // Simple word/emoji count
  const words = text.toLowerCase().split(/\s+/);
  for (const w of words) {
    const clean = w.replace(/[^a-z0-9]/g, '');
    if (clean.length > 2) data.wordCounts[clean] = (data.wordCounts[clean] || 0) + 1;
  }
  const emojis = text.match(/[\u{1F600}-\u{1F64F}]/gu) || [];
  for (const e of emojis) data.emojiCounts[e] = (data.emojiCounts[e] || 0) + 1;
}
function analyzeLearning(jid) {
  const data = learningData.get(jid);
  if (!data || data.messages.length < 50) return null;
  const topWords = Object.entries(data.wordCounts).sort((a, b) => b[1] - a[1]).slice(0, 20);
  const topEmojis = Object.entries(data.emojiCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  data.analyzed = true;
  data.analysis = { topWords, topEmojis, messageCount: data.messages.length, analyzedAt: Date.now() };
  saveLearningData();
  return data.analysis;
}

// ================================================================
// FORBIDDEN / FILLER FILTER
// ================================================================
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
  const filler = [ /how can i help you today\??/gi, /how may i help you\??/gi, /is there anything else.*?\?/gi, /let me know if.*?\./gi, /feel free to.*?\./gi, /i'?m? here to help\.?/gi, /i'?m? happy to help\.?/gi, /hope this helps!?/gi, /thank you for reaching out\.?/gi, /thanks for reaching out\.?/gi ];
  for (const p of filler) t = t.replace(p, '');
  return t.replace(/\n{3,}/g, '\n\n').replace(/\s{2,}/g, ' ').trim();
}

// ================================================================
// LANGUAGE
// ================================================================
const SHONA_MARKERS = ['ndi','uri','kuti','here','izvi','zvakanaka','sei','ndoda','unoda','mhoro','mangwanani','masikati','manheru','ndapota','zvinhu','vanhu','kuita','kuenda','kuuya'];
const LANG_NAMES = { sn: 'Shona', en: 'English' };
function detectLanguage(text) { if (!text) return 'en'; return text.toLowerCase().split(/\s+/).filter(w => SHONA_MARKERS.includes(w)).length > 0 ? 'sn' : 'en'; }

// ================================================================
// LOG / LIVE BUFFERS
// ================================================================
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
async function alertAdmin(text) {
  if (!sock || botPaused) return;
  try { await queuedSend(ADMIN_JID, { text }); } catch (e) { pushLog('warn', 'admin', `Alert failed: ${e.message}`); }
}
const _origError = console.error;
console.error = (...args) => { _origError.apply(console, args); pushLog('error', 'system', args.map(String).join(' ')); };

// ================================================================
// STATE
// ================================================================
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

const processedMessages = new Set();
const activeChats = new Set();
const activeDMs = new Set();
const replyCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });
const userHistories = new Map();
const pendingRequests = new Map();

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
    dailyStats = { date: today, joined: 0, failed: 0, dmsReplied: 0, broadcastsSent: 0, greetingsSent: 0, scraperSearches: 0, scraperGifs: 0, picsSent: 0, videosSent: 0, aiErrors: 0, pendingCreated: 0, pendingResolved: 0, discovered: 0, imageBroadcasts: 0, badMacs: 0, focusRuns: 0, downloads: 0, nsfwDownloads: 0, adminBroadcasts: 0, groupLinksShared: 0, messagesDropped: 0 };
  }
}
resetDailyStats();

// ================================================================
// PERSISTENCE
// ================================================================
function loadState() {
  try { if (fs.existsSync(JOIN_QUEUE_FILE)) joinQueue = JSON.parse(fs.readFileSync(JOIN_QUEUE_FILE, 'utf8')) || []; } catch (e) { joinQueue = []; }
  try { if (fs.existsSync(JOINED_GROUPS_FILE)) { const arr = JSON.parse(fs.readFileSync(JOINED_GROUPS_FILE, 'utf8')) || []; for (const g of arr) { joinedGroups.set(g.jid, { name: g.name, joinedAt: g.joinedAt, discovered: g.discovered || false }); if (g.lastGreetedAt) lastGreetingAt.set(g.jid, g.lastGreetedAt); } } } catch (e) {}
  try { if (fs.existsSync(PENDING_FILE)) { const arr = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8')) || []; const now = Date.now(); for (const p of arr) if (now - p.requestedAt < PENDING_EXPIRY_MS) pendingRequests.set(p.id, p); } } catch (e) {}
  pushLog('info', 'state', `queue=${joinQueue.length} groups=${joinedGroups.size} pending=${pendingRequests.size} adminLids=${adminLids.size}`);
}
function saveQueue() { try { fs.writeFileSync(JOIN_QUEUE_FILE, JSON.stringify(joinQueue, null, 2)); } catch (e) {} }
function saveGroups() { try { const arr = [...joinedGroups.entries()].map(([jid, v]) => ({ jid, name: v.name, joinedAt: v.joinedAt, discovered: v.discovered || false, lastGreetedAt: lastGreetingAt.get(jid) || null })); fs.writeFileSync(JOINED_GROUPS_FILE, JSON.stringify(arr, null, 2)); } catch (e) {} }
function savePending() { try { fs.writeFileSync(PENDING_FILE, JSON.stringify([...pendingRequests.values()], null, 2)); } catch (e) {} }

// ================================================================
// ADMIN GROUP JID
// ================================================================
function getAdminGroupJid() {
  try { if (fs.existsSync(ADMIN_GROUP_JID_FILE)) return fs.readFileSync(ADMIN_GROUP_JID_FILE, 'utf8').trim(); } catch (e) {}
  return null;
}
function setAdminGroupJid(jid) {
  try { fs.writeFileSync(ADMIN_GROUP_JID_FILE, jid); pushLog('success', 'admin', `Admin group JID set: ${jid}`); } catch (e) {}
}

// ================================================================
// GROUP MANAGEMENT FUNCTIONS
// ================================================================
async function deleteMessage(jid, msgKey) {
  try { await sock.sendMessage(jid, { delete: msgKey }); } catch (e) { pushLog('warn', 'group', `Delete failed: ${e.message}`); }
}

async function handleGroupParticipantsUpdate(update) {
  const { id, participants, action } = update;
  const settings = getGroupSetting(id);
  for (const p of participants) {
    const user = p.split('@')[0];
    if (action === 'add' && settings.welcome) {
      const msg = settings.welcomeMsg.replace('{user}', user);
      try { await sock.sendMessage(id, { text: msg }); } catch (e) {}
    }
    if (action === 'remove' && settings.goodbye) {
      const msg = settings.goodbyeMsg.replace('{user}', user);
      try { await sock.sendMessage(id, { text: msg }); } catch (e) {}
    }
  }
}

async function handleAntiLink(jid, msg, text, senderJid, isAdmin) {
  const settings = getGroupSetting(jid);
  if (!settings.antilink) return false;
  if (isAdmin) return false;
  const linkRe = /(https?:\/\/[^\s]+)/gi;
  const matches = text.match(linkRe);
  if (!matches || matches.length === 0) return false;
  // Ignore WhatsApp group invite links that are not spam (optional)
  // Delete the message
  await deleteMessage(jid, msg.key);
  pushLog('info', 'antilink', `Deleted link from ${senderJid} in ${jid}`);
  // Optionally warn
  try { await sock.sendMessage(jid, { text: `⚠️ Links are not allowed here, @${senderJid.split('@')[0]}` }, { mentions: [senderJid] }); } catch (e) {}
  return true;
}

async function handleGroupManagement(msg, chatJid, text, senderJid, isAdmin) {
  // Participant updates (handled via event, not here)
  // Anti-link
  const wasLink = await handleAntiLink(chatJid, msg, text, senderJid, isAdmin);
  if (wasLink) return true;

  // Welcome / goodbye handled via event

  // Other admin commands like promote, demote, tagall, etc. are in handleAdminCommand
  return false;
}

// ================================================================
// VIDEO DOWNLOADER (yt-dlp)
// ================================================================
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

function isYtDlpAvailable() {
  try { execSync('yt-dlp --version', { timeout: 5000, stdio: 'ignore' }); return true; } catch (e) { return false; }
}

async function downloadVideo(url, type = 'normal') {
  return new Promise((resolve, reject) => {
    if (!isYtDlpAvailable()) { reject(new Error('yt-dlp not installed')); return; }
    const id = Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const outputTemplate = path.join(DOWNLOAD_DIR, `${id}.%(ext)s`);
    const args = ['-f', 'best[ext=mp4]/best', '-o', outputTemplate, '--no-playlist', '--max-filesize', '50M'];
    if (type === 'nsfw') {
      // NSFW sites are supported by yt-dlp broadly; no special flag needed
    }
    const cmd = `yt-dlp ${args.map(a => `"${a}"`).join(' ')} "${url}"`;
    exec(cmd, { timeout: 120000 }, (error, stdout, stderr) => {
      if (error) {
        // Try to find the downloaded file
        const files = fs.readdirSync(DOWNLOAD_DIR).filter(f => f.startsWith(id));
        if (files.length > 0) {
          const filePath = path.join(DOWNLOAD_DIR, files[0]);
          resolve({ filePath, id });
        } else {
          reject(new Error(error.message));
        }
        return;
      }
      const files = fs.readdirSync(DOWNLOAD_DIR).filter(f => f.startsWith(id));
      if (files.length === 0) { reject(new Error('Download produced no file')); return; }
      const filePath = path.join(DOWNLOAD_DIR, files[0]);
      resolve({ filePath, id });
    });
  });
}

async function sendVideoFile(jid, filePath, caption = '') {
  try {
    const buffer = fs.readFileSync(filePath);
    const sent = await sock.sendMessage(jid, { video: buffer, caption, mimetype: 'video/mp4' });
    // Cleanup
    try { fs.unlinkSync(filePath); } catch (e) {}
    return sent;
  } catch (e) {
    pushLog('error', 'download', `Send failed: ${e.message}`);
    // Cleanup on failure
    try { fs.unlinkSync(filePath); } catch (e) {}
    throw e;
  }
}

// ================================================================
// GROUP LINK SHARING
// ================================================================
async function shareGroupLink(groupLink, excludeJid) {
  const targets = [...joinedGroups.keys()].filter(j => j !== excludeJid);
  const results = { sent: 0, failed: 0, total: targets.length };
  pushLog('info', 'grouplink', `Sharing link to ${targets.length} groups with 60s delay`);
  for (const jid of targets) {
    try {
      await sock.sendMessage(jid, { text: `🔗 *Join our group:*\n${groupLink}` });
      results.sent++;
      pushLog('success', 'grouplink', `Link sent to ${jid}`);
    } catch (e) {
      results.failed++;
      pushLog('error', 'grouplink', `Failed ${jid}: ${e.message}`);
    }
    // Wait 60 seconds (Fibonacci capped)
    const delay = Math.min(fib.nextCapped(90), 90000);
    await new Promise(r => setTimeout(r, delay));
  }
  pushLog('success', 'grouplink', `Link sharing done: ${results.sent}/${results.total}`);
  return results;
}

// ================================================================
// ADMIN COMMANDS (extended)
// ================================================================
const COMMAND_LIST = `🥖 *BreadBot v45*

*Admin Controls*
!pause — Pause bot (stop responding except !resume)
!resume — Resume bot
!freeze — Freeze scheduler (clear queue)
!unfreeze — Unfreeze
!broadcast <msg> — Broadcast to all groups
!logs — Show recent logs
!status — Full status report
!download <url> — Download video (admin DM only)
!nsfw <url> — Download NSFW video (9pm-8am only, admin DM)
!grouplink <link> — Share group link to all groups
!setadmingroup — Set this group as admin group
!grouplinkshare <link> — Share this link to all groups

*Group Management*
!antilink on|off — Toggle anti-link
!welcome on|off — Toggle welcome messages
!goodbye on|off — Toggle goodbye messages
!setwelcome <msg> — Set welcome message ({user} placeholder)
!setgoodbye <msg> — Set goodbye message
!promote @user — Promote to admin
!demote @user — Demote from admin
!kick @user — Remove from group
!tagall — Mention all members
!mute — Only admins can send (announcement)
!unmute — Everyone can send
!lock — Only admins can edit group settings
!unlock — Everyone can edit group settings
!groups — List all groups bot is in

*Scraper*
!pic <query> · !nextpic · !gif <query> · !nextgif
!bcastpic <caption> · !bcastpicdm · !bcastpicgroup

*Other*
!ad <title> | <body> | [cta] | [link] | [style]
!bcad
!stats · !ping · !summary · !commands`;

async function handleAdminCommand(text, chatJid, msg) {
  const args = text.slice(1).trim().split(/\s+/);
  const cmd = args[0].toLowerCase();
  const reply = (t) => queuedSend(chatJid, { text: t }, { quoted: msg });

  switch (cmd) {
    case 'commands': case 'help': await reply(COMMAND_LIST); break;
    case 'ping': await reply(`🏓 Pong!\nStatus: *${connectionStatus}*\nUptime: *${Math.floor((Date.now()-botStartTime)/1000)}s*\nPaused: *${botPaused}*\nFrozen: *${scheduler.frozen}*`); break;

    case 'pause': botPaused = true; await reply('⏸️ Bot paused. Send !resume to continue.'); break;
    case 'resume': botPaused = false; await reply('▶️ Bot resumed.'); break;
    case 'freeze': scheduler.freeze(); await reply('❄️ Scheduler frozen. Queue cleared.'); break;
    case 'unfreeze': scheduler.unfreeze(); await reply('🔥 Scheduler unfrozen.'); break;

    case 'logs': {
      const recent = logBuffer.slice(-30).map(e => `[${e.level}] ${e.source}: ${e.message}`).join('\n');
      await reply(`📜 *Recent Logs (last 30)*\n\n${recent.slice(0, 3500)}`);
      break;
    }

    case 'status': {
      const st = scheduler.stats();
      const f = focus.stats();
      const gb = groupBatcher.stats();
      await reply(`📊 *Status*\n\nConnection: *${connectionStatus}*\nBot: *${botNumber || '—'}*\nUptime: *${Math.floor((Date.now()-botStartTime)/1000)}s*\nPaused: *${botPaused}*\nFrozen: *${scheduler.frozen}*\nWindow: *${timeGate.window()}*\nGroup: *${timeGate.describeGroup()}*\nNSFW: *${timeGate.describeNsfw()}*\n\n⚙️ Scheduler\nQueued: *${st.queued}* / Running: *${st.running}*\nTotal: *${st.totalRun}* run, *${st.totalFailed}* failed\nFocus: *${f.currentState}* (busy: ${f.busy})\nDM queue: *${dmQueue.length}/${DM_QUEUE_MAX}*\nGroup batch: *${gb.totalPending}* pending in *${gb.groupsWithPending}* groups\n\n📈 Today\nDM replies: *${dailyStats.dmsReplied}*\nDownloads: *${dailyStats.downloads}* (NSFW: *${dailyStats.nsfwDownloads}*)\nBroadcasts: *${dailyStats.broadcastsSent}*\nGroup links shared: *${dailyStats.groupLinksShared}*\nDropped: *${dailyStats.messagesDropped}*`);
      break;
    }

    // ── GROUP MANAGEMENT ──
    case 'antilink': {
      const on = args[1]?.toLowerCase() === 'on';
      const s = getGroupSetting(chatJid); s.antilink = on; saveGroupSettings();
      await reply(`✅ Anti-link ${on ? 'ON' : 'OFF'}`);
      break;
    }
    case 'welcome': {
      const on = args[1]?.toLowerCase() === 'on';
      const s = getGroupSetting(chatJid); s.welcome = on; saveGroupSettings();
      await reply(`✅ Welcome messages ${on ? 'ON' : 'OFF'}`);
      break;
    }
    case 'goodbye': {
      const on = args[1]?.toLowerCase() === 'on';
      const s = getGroupSetting(chatJid); s.goodbye = on; saveGroupSettings();
      await reply(`✅ Goodbye messages ${on ? 'ON' : 'OFF'}`);
      break;
    }
    case 'setwelcome': {
      const txt = args.slice(1).join(' ');
      if (!txt) { await reply('❌ Usage: `!setwelcome <message with {user}>`'); return; }
      const s = getGroupSetting(chatJid); s.welcomeMsg = txt; saveGroupSettings();
      await reply(`✅ Welcome message set.`);
      break;
    }
    case 'setgoodbye': {
      const txt = args.slice(1).join(' ');
      if (!txt) { await reply('❌ Usage: `!setgoodbye <message with {user}>`'); return; }
      const s = getGroupSetting(chatJid); s.goodbyeMsg = txt; saveGroupSettings();
      await reply(`✅ Goodbye message set.`);
      break;
    }
    case 'promote': {
      const target = msg.message?.extendedTextMessage?.contextInfo?.participant || (args[1] ? args[1].replace(/\D/g, '') + '@s.whatsapp.net' : null);
      if (!target) { await reply('❌ Reply to a user or give phone number.'); return; }
      try { await sock.groupParticipantsUpdate(chatJid, [target], 'promote'); await reply(`✅ Promoted.`); }
      catch (e) { await reply(`❌ ${e.message}`); }
      break;
    }
    case 'demote': {
      const target = msg.message?.extendedTextMessage?.contextInfo?.participant || (args[1] ? args[1].replace(/\D/g, '') + '@s.whatsapp.net' : null);
      if (!target) { await reply('❌ Reply to a user or give phone number.'); return; }
      try { await sock.groupParticipantsUpdate(chatJid, [target], 'demote'); await reply(`✅ Demoted.`); }
      catch (e) { await reply(`❌ ${e.message}`); }
      break;
    }
    case 'kick': {
      const target = msg.message?.extendedTextMessage?.contextInfo?.participant || (args[1] ? args[1].replace(/\D/g, '') + '@s.whatsapp.net' : null);
      if (!target) { await reply('❌ Reply to a user or give phone number.'); return; }
      try { await sock.groupParticipantsUpdate(chatJid, [target], 'remove'); await reply(`✅ Kicked.`); }
      catch (e) { await reply(`❌ ${e.message}`); }
      break;
    }
    case 'tagall': {
      try {
        const meta = await sock.groupMetadata(chatJid);
        const mentions = meta.participants.map(p => p.id);
        const list = mentions.map(j => `@${j.split('@')[0]}`).join(' ');
        await sock.sendMessage(chatJid, { text: `📢 *Attention everyone:*\n\n${list}`, mentions });
      } catch (e) { await reply(`❌ ${e.message}`); }
      break;
    }
    case 'mute': {
      try { await sock.groupSettingUpdate(chatJid, 'announcement'); await reply('🔇 Group muted (only admins can send).'); }
      catch (e) { await reply(`❌ ${e.message}`); }
      break;
    }
    case 'unmute': {
      try { await sock.groupSettingUpdate(chatJid, 'not_announcement'); await reply('🔊 Group unmuted (everyone can send).'); }
      catch (e) { await reply(`❌ ${e.message}`); }
      break;
    }
    case 'lock': {
      try { await sock.groupSettingUpdate(chatJid, 'locked'); await reply('🔒 Group locked (only admins can edit).'); }
      catch (e) { await reply(`❌ ${e.message}`); }
      break;
    }
    case 'unlock': {
      try { await sock.groupSettingUpdate(chatJid, 'unlocked'); await reply('🔓 Group unlocked (everyone can edit).'); }
      catch (e) { await reply(`❌ ${e.message}`); }
      break;
    }
    case 'groups': {
      if (joinedGroups.size === 0) { await reply('📭 No groups.'); return; }
      const list = [...joinedGroups.keys()].slice(0, 30).map((j, i) => `${i + 1}. ${j}`).join('\n');
      await reply(`👥 *Groups (${joinedGroups.size})*\n${list}`);
      break;
    }

    // ── VIDEO DOWNLOADER ──
    case 'download': {
      const url = args[1];
      if (!url) { await reply('❌ Usage: `!download <url>`'); return; }
      await reply('⏳ Downloading...');
      try {
        const { filePath } = await downloadVideo(url, 'normal');
        await sendVideoFile(chatJid, filePath, `Downloaded from ${url}`);
        resetDailyStats(); dailyStats.downloads++;
        await reply('✅ Video sent.');
      } catch (e) { await reply(`❌ Download failed: ${e.message}`); }
      break;
    }
    case 'nsfw': {
      if (!timeGate.isNsfwActive()) { await reply(`⛔ NSFW downloads only allowed 21:00-08:00. Current: ${timeGate.describeNsfw()}`); return; }
      const url = args[1];
      if (!url) { await reply('❌ Usage: `!nsfw <url>`'); return; }
      await reply('⏳ Downloading NSFW...');
      try {
        const { filePath } = await downloadVideo(url, 'nsfw');
        await sendVideoFile(chatJid, filePath, `NSFW content from ${url}`);
        resetDailyStats(); dailyStats.downloads++; dailyStats.nsfwDownloads++;
        await reply('✅ NSFW video sent.');
      } catch (e) { await reply(`❌ Download failed: ${e.message}`); }
      break;
    }

    // ── GROUP LINK SHARING ──
    case 'setadmingroup': {
      setAdminGroupJid(chatJid);
      await reply(`✅ This group is now the admin group. Links posted here will be shared.`);
      break;
    }
    case 'grouplink': case 'grouplinkshare': {
      const link = args[1];
      if (!link || !link.includes('chat.whatsapp.com')) { await reply('❌ Usage: `!grouplink <whatsapp group link>`'); return; }
      await reply(`⏳ Sharing link to all groups with 60s delay...`);
      const r = await shareGroupLink(link, chatJid);
      resetDailyStats(); dailyStats.groupLinksShared++;
      await reply(`✅ Link shared: ${r.sent}/${r.total} sent.`);
      break;
    }

    // ── BROADCAST ──
    case 'broadcast': {
      const message = args.slice(1).join(' ');
      if (!message) { await reply('❌ Usage: `!broadcast <message>`'); return; }
      const count = joinedGroups.size;
      if (count === 0) { await reply('📭 No groups.'); return; }
      await reply(`⏳ Broadcasting to ${count} groups...`);
      const r = await broadcast({ message, mode: 'groups' });
      resetDailyStats(); dailyStats.adminBroadcasts++;
      await reply(`✅ Broadcast done: ${r.sent}/${r.total} sent.`);
      break;
    }

    // ── EXISTING COMMANDS (from v44.0) ──
    case 'sched': {
      const st = scheduler.stats(); const fo = focus.stats(); const gb = groupBatcher.stats();
      await reply(`⚙️ *Scheduler*\nQueued: *${st.queued}* / Running: *${st.running}*\nCurrent: *${st.currentTask || 'idle'}*\nFocus: *${fo.currentState}*\nWindow: *${timeGate.describe()}*\nGroup: *${timeGate.describeGroup()}*\nDM queue: *${dmQueue.length}*\nGroup batch: *${gb.totalPending}* pending`);
      break;
    }
    case 'whoami': {
      const c = extractAllPhoneCandidates(msg, chatJid); const lid = extractLid(msg, chatJid); const isAdm = isAdminSender(msg, chatJid);
      await reply(`🔍 *Diagnostics*\nJID: *${msg.key.participant || msg.key.remoteJid}*\nLID: *${lid || '—'}*\nCandidates: *${c.join(', ') || 'none'}*\nExpected: *${ADMIN_PHONE}*\nIs admin: *${isAdm ? 'YES ✅' : 'NO ❌'}*\nLIDs: *${[...adminLids].join(', ') || 'none'}*`);
      break;
    }
    case 'aitest': {
      const r = await testRewindRaw();
      if (r.ok) await reply(`✅ AI works: ${r.ms}ms`);
      else await reply(`❌ AI failed: ${r.error}`);
      break;
    }
    case 'scraperstatus': {
      const st = await scraperStatus();
      if (st.ok) await reply(`✅ Scraper works`);
      else await reply(`❌ Scraper failed: ${st.error}`);
      break;
    }
    case 'pic': case 'search': {
      const q = args.slice(1).join(' '); if (!q) { await reply('❌ Usage: `!pic <query>`'); return; }
      const r = await scraperSearch(q);
      if (!r.ok || r.images.length === 0) { await reply(`❌ No results`); return; }
      previewCache.imageUrls = r.images; previewCache.imageIndex = 0; previewCache.currentType = 'image'; previewCache.currentUrl = r.images[0];
      try { await queuedSend(chatJid, { image: { url: r.images[0] }, caption: `Preview 1/${r.images.length}\n!nextpic · !bcastpic <caption>` }); } catch (e) { await reply(`❌ ${e.message}`); }
      break;
    }
    case 'nextpic': {
      if (previewCache.imageUrls.length === 0) { await reply('❌ No preview.'); return; }
      previewCache.imageIndex = (previewCache.imageIndex + 1) % previewCache.imageUrls.length;
      previewCache.currentUrl = previewCache.imageUrls[previewCache.imageIndex];
      try { await queuedSend(chatJid, { image: { url: previewCache.currentUrl }, caption: `Preview ${previewCache.imageIndex + 1}/${previewCache.imageUrls.length}` }); } catch (e) { await reply(`❌ ${e.message}`); }
      break;
    }
    case 'gif': {
      const q = args.slice(1).join(' '); if (!q) { await reply('❌ Usage: `!gif <query>`'); return; }
      const r = await scraperGif(q);
      if (!r.ok || r.gifs.length === 0) { await reply(`❌ No results`); return; }
      previewCache.gifUrls = r.gifs; previewCache.gifIndex = 0; previewCache.currentType = 'gif'; previewCache.currentUrl = r.gifs[0];
      try { await queuedSend(chatJid, { video: { url: r.gifs[0] }, gifPlayback: true, caption: `GIF 1/${r.gifs.length}\n!nextgif · !bcastgif <caption>` }); } catch (e) { await reply(`❌ ${e.message}`); }
      break;
    }
    case 'nextgif': {
      if (previewCache.gifUrls.length === 0) { await reply('❌ No preview.'); return; }
      previewCache.gifIndex = (previewCache.gifIndex + 1) % previewCache.gifUrls.length;
      previewCache.currentUrl = previewCache.gifUrls[previewCache.gifIndex];
      try { await queuedSend(chatJid, { video: { url: previewCache.currentUrl }, gifPlayback: true, caption: `GIF ${previewCache.gifIndex + 1}/${previewCache.gifUrls.length}` }); } catch (e) { await reply(`❌ ${e.message}`); }
      break;
    }
    case 'all': case 'bcgroup': case 'bcdm': {
      const message = args.slice(1).join(' '); if (!message) { await reply(`❌ Usage: \`!${cmd} <message>\``); return; }
      const mode = cmd === 'all' ? 'all' : (cmd === 'bcgroup' ? 'groups' : 'dms');
      const count = mode === 'all' ? (joinedGroups.size + activeDMs.size) : mode === 'groups' ? joinedGroups.size : activeDMs.size;
      if (count === 0) { await reply(`📭 No ${mode} targets.`); return; }
      await reply(`⏳ Queued broadcast to ${count} (${mode})...`);
      const r = await broadcast({ message, mode });
      await reply(`✅ Done — Sent: *${r.sent}* / Failed: *${r.failed}*`);
      break;
    }
    case 'bcastpic': case 'bcastpicdm': case 'bcastpicgroup': {
      if (!previewCache.currentUrl || previewCache.currentType !== 'image') { await reply('❌ No image preview.'); return; }
      const caption = args.slice(1).join(' ') || '';
      const mode = cmd === 'bcastpic' ? 'all' : cmd === 'bcastpicdm' ? 'dms' : 'groups';
      const count = mode === 'all' ? (joinedGroups.size + activeDMs.size) : mode === 'groups' ? joinedGroups.size : activeDMs.size;
      if (count === 0) { await reply(`📭 No ${mode} targets.`); return; }
      await reply(`⏳ Queued broadcast to ${count}...`);
      const r = await broadcast({ message: caption, imageUrl: previewCache.currentUrl, mode });
      await reply(`✅ Done — Sent: *${r.sent}* / Failed: *${r.failed}*`);
      break;
    }
    case 'bcastgif': {
      if (!previewCache.currentUrl || previewCache.currentType !== 'gif') { await reply('❌ No GIF preview.'); return; }
      const caption = args.slice(1).join(' ') || '';
      const count = joinedGroups.size + activeDMs.size;
      if (count === 0) { await reply('📭 No targets.'); return; }
      await reply(`⏳ Queued broadcast GIF to ${count}...`);
      const r = await broadcast({ message: caption, gifUrl: previewCache.currentUrl, mode: 'all' });
      await reply(`✅ Done — Sent: *${r.sent}* / Failed: *${r.failed}*`);
      break;
    }
    case 'allimg': {
      const parts = args.slice(1).join(' ').split('|').map(s => s.trim());
      const url = parts[0]; const caption = parts[1] || '';
      if (!url) { await reply('❌ Usage: `!allimg <url> | <caption>`'); return; }
      const count = joinedGroups.size + activeDMs.size;
      if (count === 0) { await reply('📭 No targets.'); return; }
      await reply(`⏳ Queued broadcast image to ${count}...`);
      const r = await broadcast({ message: caption, imageUrl: url, mode: 'all' });
      await reply(`✅ Done — Sent: *${r.sent}* / Failed: *${r.failed}*`);
      break;
    }
    case 'ad': {
      const parts = args.slice(1).join(' ').split('|').map(p => p.trim());
      const [title, body, cta, link, style] = parts;
      if (!title || !body) { await reply('❌ Usage: `!ad <title> | <body> | [cta] | [link] | [style]`'); return; }
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
      await reply(`⏳ Queued broadcast ad to ${count}...`);
      const r = await broadcast({ message: adText, mode: 'all' });
      await reply(`✅ Done — Sent: *${r.sent}* / Failed: *${r.failed}*`);
      break;
    }
    case 'summary': {
      resetDailyStats(); const s = dailyStats;
      await reply(`📊 *Today (${s.date})*\nJoined: *${s.joined}*\nDiscovered: *${s.discovered}*\nDM replies: *${s.dmsReplied}*\nFocus runs: *${s.focusRuns}*\nPics: *${s.picsSent}*\nVideos: *${s.videosSent}*\nDownloads: *${s.downloads}* (NSFW: *${s.nsfwDownloads}*)\nBroadcasts: *${s.broadcastsSent}*\nGroup links: *${s.groupLinksShared}*\nGreetings: *${s.greetingsSent}*\nAI errors: *${s.aiErrors}*\nDropped: *${s.messagesDropped}*`);
      break;
    }
    default: await reply(`❓ Unknown: *!${cmd}*`);
  }
}

// ================================================================
// BROADCAST (v44.0 style)
// ================================================================
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
      await queuedSend(t.jid, content);
      results.sent++;
    } catch (e) { results.failed++; results.errors.push({ jid: t.jid, error: e.message }); }
  }
  pushLog('success', 'broadcast', `Done: ${results.sent}/${results.total}`);
  return results;
}

// ================================================================
// AD BUILDER
// ================================================================
class AdBuilder {
  static build(opts = {}) {
    const { title, body, cta, link, footer, style = 'fancy' } = opts;
    if (style === 'bold') return [`*${title || 'SPECIAL OFFER'}*`, '', body || '', cta ? `\n*${cta}*` : '', link ? `\n${link}` : '', footer ? `\n_${footer}_` : ''].filter(Boolean).join('\n');
    if (style === 'minimal') return [title || '', body || '', cta || '', link || ''].filter(Boolean).join('\n\n');
    const lines = ['╔══════════════════════════╗', `║ ✨ ${(title || 'SPECIAL OFFER').toUpperCase()} ✨`, '╚══════════════════════════╝', ''];
    if (body) lines.push(body);
    lines.push('');
    if (cta) lines.push(`*${cta}*`);
    if (link) lines.push(`${link}`);
    if (footer) lines.push(`\n_${footer}_`);
    return lines.join('\n');
  }
}

// ================================================================
// QUEUED SEND
// ================================================================
const botSentIds = new Set();
function queuedSend(jid, content, options = {}) {
  return scheduler.schedule(`send:${jid}`, async () => {
    if (!sock) throw new Error('Bot disconnected');
    if (botPaused) throw new Error('Bot paused');
    const sent = await sock.sendMessage(jid, content, options);
    if (sent?.key?.id) { botSentIds.add(sent.key.id); if (botSentIds.size > 2000) { const arr = [...botSentIds]; botSentIds.clear(); for (const i of arr.slice(-1000)) botSentIds.add(i); } }
    return sent;
  });
}

// ================================================================
// CONNECTION
// ================================================================
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
        pushLog('success', 'antiban', 'Socket wrapped with baileys-antiban');
      } catch (e) { pushLog('warn', 'antiban', `wrapSocket failed: ${e.message}`); sock = baseSocket; }
    } else { sock = baseSocket; pushLog('warn', 'antiban', 'baileys-antiban not available'); }

    if (SessionHealthMonitor) {
      try {
        healthMonitor = new SessionHealthMonitor({
          badMacThreshold: 3, badMacWindowMs: 60000,
          onDegraded: (stats) => {
            pushLog('error', 'health', `SESSION DEGRADED: ${stats.badMacCount} Bad MACs`);
            resetDailyStats(); dailyStats.badMacs = stats.badMacCount;
            alertAdmin(`⚠️ Session degraded — ${stats.badMacCount} Bad MACs`).catch(() => {});
          }
        });
        pushLog('info', 'health', 'Session health monitor started');
      } catch (e) { pushLog('warn', 'health', `Health monitor failed: ${e.message}`); }
    }

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) { qrDataUri = await QRCode.toDataURL(qr); connectionStatus = 'qr'; pushLog('info', 'bot', 'QR generated — scan now'); }
      if (connection === 'open') {
        isConnecting = false; connectionStatus = 'connected'; reconnectAttempts = 0; botStartTime = Date.now();
        botJid = sock.user?.id || null; botNumber = botJid?.split(':')[0]?.split('@')[0] || 'unknown';
        pushLog('success', 'bot', `✅ Connected as ${botNumber}`);
        pushLog('info', 'time', `Window: ${timeGate.describe()} | Group: ${timeGate.describeGroup()} | NSFW: ${timeGate.describeNsfw()}`);
        if (createHumanEntropyService) {
          try {
            entropyService = createHumanEntropyService(sock, botJid, { enabled: true, minIntervalMs: 7200000, maxIntervalMs: 21600000 });
            entropyService.start();
            pushLog('success', 'entropy', 'Entropy service started');
          } catch (e) { pushLog('warn', 'entropy', `Entropy failed: ${e.message}`); }
        }
        try { await sock.sendPresenceUpdate('available'); } catch (e) {}
        await alertAdmin(`✅ *BreadBot ONLINE*\n📱 ${botNumber}\nWindow: ${timeGate.window()}\nGroup: ${timeGate.describeGroup()}\n\nSend !commands`);
      }
      if (connection === 'close') {
        isConnecting = false;
        const code = lastDisconnect?.error?.output?.statusCode;
        let classification = null;
        if (classifyDisconnect) { try { classification = classifyDisconnect(code); } catch (e) {} }
        if (classification) pushLog('warn', 'bot', `Disconnected (${code}) — ${classification.message} [${classification.category}]`);
        else pushLog('warn', 'bot', `Disconnected (${code})`);
        if (entropyService) { try { entropyService.stop(); } catch (e) {} entropyService = null; }
        if (manualDisconnect) { connectionStatus = 'disconnected'; return; }
        if (code === DisconnectReason.loggedOut) { connectionStatus = 'disconnected'; pushLog('error', 'bot', 'Logged out — refresh QR'); return; }
        if (code === 408 && connectionStatus === 'qr' && !botNumber) { connectionStatus = 'disconnected'; pushLog('warn', 'bot', 'QR expired — refresh'); return; }
        if (code === 428 || code === 440) { connectionStatus = 'disconnected'; pushLog('error', 'bot', `Session conflict (${code})`); return; }
        const shouldReconnect = classification ? classification.shouldReconnect : true;
        if (shouldReconnect && reconnectAttempts < MAX_RECONNECT) {
          reconnectAttempts++;
          const baseDelay = code === 515 ? 2000 : 5000;
          const delay = classification?.backoffMs || Math.min(baseDelay * reconnectAttempts, 30000);
          connectionStatus = 'reconnecting';
          pushLog('warn', 'bot', `Retry in ${delay/1000}s [${reconnectAttempts}/${MAX_RECONNECT}]${code === 515 ? ' (515 post-scan)' : ''}`);
          setTimeout(() => { try { sock.end(undefined); } catch (e) {} sock = null; connectBot(); }, delay);
        } else { connectionStatus = 'disconnected'; pushLog('error', 'bot', 'Max retries — click Reconnect'); }
      }
    });

    sock.ev.on('creds.update', saveCreds);

    // Group participant updates (welcome / goodbye)
    sock.ev.on('group-participants.update', async (update) => {
      try { await handleGroupParticipantsUpdate(update); } catch (e) { pushLog('error', 'group', e.message); }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const msg of messages || []) {
        try {
          if (entropyService && msg.key?.remoteJid && !msg.key.fromMe) {
            try { entropyService.addRecentContact(msg.key.remoteJid, msg.key); } catch (e) {}
          }
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
  if (sock) { try { sock.end(undefined); } catch (e) {} sock = null; connectionStatus = 'disconnected'; qrDataUri = null; isConnecting = false; botNumber = null; pushLog('warn', 'bot', 'Disconnected manually'); }
}
function refreshQR() {
  qrDataUri = null; connectionStatus = 'disconnected'; manualDisconnect = true;
  if (sock) { try { sock.end(undefined); } catch (e) {} sock = null; }
  isConnecting = false; botNumber = null;
  pushLog('info', 'bot', 'Manual QR refresh');
  setTimeout(() => { manualDisconnect = false; connectBot(); }, 1500);
}

// ================================================================
// MESSAGE HANDLER (v45.0 with all features)
// ================================================================
async function handleMessage(msg) {
  if (!sock) return;

  // Flood check
  if (checkFlood()) {
    resetDailyStats(); dailyStats.messagesDropped++;
    return;
  }
  if (Date.now() < floodIgnoreUntil) return;

  const chatJid = msg.key?.remoteJid;
  if (!chatJid) return;
  activeChats.add(chatJid);

  const msgId = msg.key.id;
  if (processedMessages.has(msgId)) return;
  processedMessages.add(msgId);
  if (processedMessages.size > 10000) processedMessages.clear();
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

  pushLiveMessage({
    id: msgId, ts: new Date().toISOString(), chatJid, chatType, senderJid,
    senderName: pushName, phone: phone || '—', lid: lid || '—',
    text: text.slice(0, 200) || `[${mediaType}]`, mediaType
  });

  const isAdmin = isAdminSender(msg, senderJid);

  // If bot is paused, only allow admin commands (but not other actions)
  if (botPaused && !isAdmin) { pushLog('info', 'pause', `Bot paused — ignoring message from ${pushName}`); return; }

  // ── ADMIN IMAGE BROADCAST ──
  if (!isGroup && isAdmin && mediaType === 'image' && text.startsWith('!')) {
    const args = text.slice(1).trim().split(/\s+/);
    const cmd = args[0].toLowerCase();
    if (['bcdm', 'bcgroup', 'all'].includes(cmd)) {
      const caption = args.slice(1).join(' ').trim();
      pushLog('info', 'broadcast', `Image broadcast (${cmd}): "${caption}"`);
      await queuedSend(chatJid, { text: `⏳ Downloading your image...` });
      try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
        if (!buffer) { await queuedSend(chatJid, { text: '❌ Could not download.' }); return; }
        const mode = cmd === 'bcdm' ? 'dms' : cmd === 'bcgroup' ? 'groups' : 'all';
        const count = mode === 'all' ? (joinedGroups.size + activeDMs.size) : mode === 'groups' ? joinedGroups.size : activeDMs.size;
        if (count === 0) { await queuedSend(chatJid, { text: `📭 No ${mode} targets.` }); return; }
        await queuedSend(chatJid, { text: `📸 Queued broadcast to ${count} ${mode}.\nCaption: "${caption || '(none)'}"` });
        const r = await broadcast({ message: caption, imageBuffer: buffer, mode });
        resetDailyStats(); dailyStats.imageBroadcasts++;
        await queuedSend(chatJid, { text: `✅ Broadcast done — Sent: *${r.sent}* / Failed: *${r.failed}*` });
      } catch (e) { pushLog('error', 'broadcast', e.message); await queuedSend(chatJid, { text: `❌ ${e.message}` }); }
      return;
    }
  }

  // Track user history
  if (!isGroup && !isAdmin && !msg.key.fromMe && text) {
    if (!userHistories.has(senderJid)) userHistories.set(senderJid, []);
    const h = userHistories.get(senderJid);
    h.push({ text, ts: Date.now() });
    if (h.length > USER_HISTORY_SIZE * 2) h.shift();
  }

  // Invite links
  const codes = extractAllInviteCodes(text);
  if (codes.length > 0) {
    let added = 0;
    for (const c of codes) if (queueJoin(c, phone || pushName, chatType)) added++;
    if (added > 0) {
      pushLog('info', 'join', `Queued ${added}/${codes.length} from ${pushName}`);
      if (!isGroup) await queuedSend(chatJid, { text: `✅ Queued ${added} new link${added !== 1 ? 's' : ''}.\nQueue: ${joinQueue.length}` });
      processJoinQueue();
    }
  }

  // Admin commands
  if (!isGroup && isAdmin && text.startsWith('!')) {
    pushLog('info', 'admin', `Admin cmd: ${text.split(' ')[0]}`);
    await handleAdminCommand(text, chatJid, msg);
    return;
  }

  // ── GROUP MESSAGES ──
  if (isGroup) {
    // Group management (anti-link)
    const wasManaged = await handleGroupManagement(msg, chatJid, text, senderJid, isAdmin);
    if (wasManaged) return;

    // Only active from 9pm to midnight
    if (!timeGate.isGroupActive()) {
      groupBatcher.enqueue(chatJid, { msg, text, ts: Date.now() });
      pushLog('info', 'group', `Group idle (${timeGate.describeGroup()}) — message queued`);
      return;
    }

    // Random reply to group messages (personality building)
    if (!isAdmin && text && Math.random() < 0.08) { // 8% chance
      // Use learning data to inform reply
      const analysis = analyzeLearning(chatJid);
      const systemPrompt = `You are Abby Faith Sithole, a 23-year-old girl from Harare, Zimbabwe. You are in a WhatsApp group. Reply casually in Shona/English mix. Keep it short (1 sentence). ${analysis ? `Use words like: ${analysis.topWords.map(w=>w[0]).join(', ')}` : ''}`;
      const aiReply = await askRewind(text, systemPrompt);
      if (aiReply && !containsForbidden(aiReply)) {
        await queuedSend(chatJid, { text: informalize(aiReply) });
        pushLog('info', 'ai', `Group reply to ${pushName}`);
      }
    }
    return;
  }

  // ── ADMIN DM WITHOUT COMMAND ──
  if (isAdmin) { pushLog('info', 'admin', `Admin DM ignored (no command)`); return; }

  // ── NON-ADMIN DM: enqueue for focus pipeline ──
  enqueueDM({ msg, text, chatJid, senderJid, pushName, phone, intent: detectMediaIntent(text), lang: detectLanguage(text) });
}

// ================================================================
// PROCESS DM (called from queue)
// ================================================================
async function processDM(item) {
  const { msg, text, chatJid, senderJid, pushName, phone, intent, lang } = item;
  const langName = LANG_NAMES[lang] || 'English';

  if (containsForbidden(text)) { pushLog('info', 'filter', `Ignored: ${pushName}`); return; }

  if (intent) {
    pushLog('info', 'pic', `Intent ${intent.type} — "${intent.query}" from ${pushName}`);
    const vague = isVagueQuery(intent.query);
    if (!vague) {
      if (intent.type === 'video' || intent.type === 'gif') {
        const r = await scraperGif(intent.query);
        if (r.ok && r.gifs.length > 0) {
          try { await queuedSend(chatJid, { video: { url: r.gifs[0] }, gifPlayback: true }, { quoted: msg }); } catch (e) { await queuedSend(chatJid, { text: r.gifs[0] }, { quoted: msg }); }
          resetDailyStats(); if (intent.type === 'video') dailyStats.videosSent++; else dailyStats.picsSent++;
          return;
        }
      } else {
        const r = await scraperSearch(intent.query);
        if (r.ok && r.images.length > 0) {
          try { await queuedSend(chatJid, { image: { url: r.images[0] } }, { quoted: msg }); } catch (e) { await queuedSend(chatJid, { text: r.images[0] }, { quoted: msg }); }
          resetDailyStats(); dailyStats.picsSent++;
          return;
        }
      }
    }
    const history = userHistories.get(senderJid) || [];
    const id = createPendingRequest(senderJid, pushName, phone, history, intent);
    pushLog('warn', 'ai', `Pending ${id} for ${pushName}`);
    const ack = await askRewind(`User asked for something. Reply casually (max 8 words).`, `You are Abby Faith Sithole, 23, Harare Zimbabwe. Casual WhatsApp. Reply in ${langName}.`);
    const finalAck = (ack && !containsForbidden(ack)) ? informalize(ack) : 'checking rn 😊';
    try { await queuedSend(chatJid, { text: finalAck }, { quoted: msg }); } catch (e) {}
    await forwardToAdminForHelp(id, pendingRequests.get(id));
    return;
  }

  const systemPrompt = `You are Abby Faith Sithole, a 23-year-old girl from Harare, Zimbabwe. You are a REAL person. Reply in ${langName}. Mix in light Shona. Keep replies SHORT: 1-2 sentences. Never say you're an AI. Be casual, playful.`;
  const aiReply = await askRewind(text, systemPrompt);
  if (!aiReply) { pushLog('warn', 'ai', `No reply for ${pushName}`); return; }
  if (containsForbidden(aiReply)) { pushLog('warn', 'ai', `Dropped (forbidden)`); return; }
  const final = informalize(humanize(aiReply));
  if (!final) return;
  await queuedSend(chatJid, { text: final }, { quoted: msg });
  resetDailyStats(); dailyStats.dmsReplied++; dailyStats.focusRuns++;
  pushLog('info', 'ai', `DM reply to ${pushName}: ${final.slice(0, 50)}`);
}

// ================================================================
// AI & SCRAPER (unchanged)
// ================================================================
async function askRewind(prompt, systemPrompt) {
  if (!REWIND_KEY) { pushLog('error', 'ai', 'REWIND_KEY missing'); return null; }
  try {
    const r = await axios.post('https://api.rewind.ai/v1/chat/completions', {
      model: 'rewind-uncensored',
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }]
    }, { headers: { 'Authorization': `Bearer ${REWIND_KEY}`, 'Content-Type': 'application/json' }, timeout: 20000 });
    const raw = r.data?.choices?.[0]?.message?.content;
    if (!raw) return null;
    const cleaned = humanize(raw);
    if (!cleaned) return null;
    return cleaned;
  } catch (e) { pushLog('error', 'ai', `Rewind failed: ${e.response?.status || ''} ${e.message}`); resetDailyStats(); dailyStats.aiErrors++; return null; }
}
async function testRewindRaw() {
  if (!REWIND_KEY) return { ok: false, error: 'REWIND_KEY missing' };
  const t0 = Date.now();
  try {
    const r = await axios.post('https://api.rewind.ai/v1/chat/completions', { model: 'rewind-uncensored', messages: [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: 'Reply with exactly: AI WORKS' }] }, { headers: { 'Authorization': `Bearer ${REWIND_KEY}`, 'Content-Type': 'application/json' }, timeout: 20000 });
    return { ok: true, ms: Date.now() - t0, status: r.status, raw: r.data?.choices?.[0]?.message?.content };
  } catch (e) { return { ok: false, ms: Date.now() - t0, status: e.response?.status, error: e.message }; }
}
async function scraperSearch(query, site = 'darknaija') { scraperStats.searchCalls++; resetDailyStats(); dailyStats.scraperSearches++; try { const r = await axios.post(`${SCRAPER_URL}/search`, { query, site }, { timeout: 30000 }); scraperStats.searchSuccess++; return { ok: true, images: r.data?.images || [] }; } catch (e) { scraperStats.searchFail++; return { ok: false, error: e.message, images: [] }; } }
async function scraperGif(query) { scraperStats.gifCalls++; resetDailyStats(); dailyStats.scraperGifs++; try { const r = await axios.get(`${SCRAPER_URL}/gif?q=${encodeURIComponent(query)}`, { timeout: 30000 }); scraperStats.gifSuccess++; return { ok: true, gifs: r.data?.gifs || [] }; } catch (e) { scraperStats.gifFail++; return { ok: false, error: e.message, gifs: [] }; } }
async function scraperStatus() { try { const r = await axios.get(`${SCRAPER_URL}/status`, { timeout: 10000 }); return { ok: true, data: r.data }; } catch (e) { return { ok: false, error: e.message }; } }

// ================================================================
// HELPERS
// ================================================================
function extractAllPhoneCandidates(msg, senderJid) {
  const phones = new Set();
  const candidates = [msg.key?.participantPn, msg.key?.senderPn, msg.key?.remoteJidAlt, msg.key?.participantAlt, senderJid, msg.key?.remoteJid, msg.key?.participant].filter(Boolean);
  for (const c of candidates) { if (typeof c === 'string') { const digits = c.split('@')[0].split(':')[0].replace(/\D/g, ''); if (digits.length >= 10) phones.add(digits); } }
  return [...phones];
}
function extractLidFromMsg(msg, senderJid) { const candidates = [senderJid, msg.key?.remoteJid, msg.key?.participant].filter(Boolean); for (const c of candidates) if (typeof c === 'string' && c.includes('@lid')) return c.split('@')[0]; return null; }
function isAdminSender(msg, senderJid) {
  const candidates = extractAllPhoneCandidates(msg, senderJid);
  if (candidates.includes(ADMIN_PHONE)) { const lid = extractLidFromMsg(msg, senderJid); if (lid && !adminLids.has(lid)) { adminLids.add(lid); saveAdminLids(); } return true; }
  for (const c of candidates) if (adminLids.has(c)) return true;
  const lid = extractLidFromMsg(msg, senderJid);
  if (lid && adminLids.has(lid)) return true;
  if (typeof senderJid === 'string') { const bare = senderJid.split('@')[0].split(':')[0]; if (adminLids.has(bare) || bare === ADMIN_PHONE) return true; }
  return false;
}
function extractPhone(msg, senderJid) { const c = extractAllPhoneCandidates(msg, senderJid); return c.length > 0 ? c[0] : null; }
function extractLid(msg, senderJid) { return extractLidFromMsg(msg, senderJid); }

function extractAllInviteCodes(text) { if (!text) return []; const codes = new Set(); const re = /chat\.whatsapp\.com\/([A-Za-z0-9]{15,30})/gi; let m; while ((m = re.exec(text)) !== null) codes.add(m[1]); return [...codes]; }

function queueJoin(code, addedBy = 'unknown', source = 'dm') { if (!code || joinQueue.some(q => q.code === code)) return false; joinQueue.push({ code, addedAt: Date.now(), addedBy, source }); saveQueue(); pushLog('info', 'join', `Queued ${code}`); return true; }
async function processJoinQueue() {
  if (joinInProgress || !sock || connectionStatus !== 'connected' || joinQueue.length === 0) return;
  if (timeGate.isOffline() || !timeGate.isGroupActive()) return; // only join during group active window
  if (Date.now() - lastJoinAt < JOIN_INTERVAL_MS) return;
  joinInProgress = true; const item = joinQueue.shift(); saveQueue(); resetDailyStats();
  try { pushLog('info', 'join', `Joining ${item.code}...`); const res = await scheduler.schedule('groupJoin', () => sock.groupAcceptInvite(item.code)); lastJoinAt = Date.now(); if (res) { joinedGroups.set(res, { name: null, joinedAt: Date.now(), discovered: false }); lastGreetingAt.set(res, Date.now()); saveGroups(); dailyStats.joined++; pushLog('success', 'join', `✅ Joined ${res}`); } }
  catch (e) { dailyStats.failed++; pushLog('error', 'join', `Failed ${item.code}: ${e.message}`); }
  finally { joinInProgress = false; setTimeout(processJoinQueue, JOIN_INTERVAL_MS); }
}

function createPendingRequest(userJid, userName, userPhone, history, intent) { const id = Math.random().toString(36).slice(2, 8); pendingRequests.set(id, { id, userJid, userName, userPhone, userHistory: history.slice(-USER_HISTORY_SIZE), requestedAt: Date.now(), intent }); savePending(); resetDailyStats(); dailyStats.pendingCreated++; return id; }
async function forwardToAdminForHelp(id, pending) { const historyBlock = pending.userHistory.map((h, i) => `${i + 1}. ${h.text}`).join('\n'); await alertAdmin(`❓ *Unclear request*\n👤 ${pending.userName} (${pending.userPhone || 'no phone'})\n💬 Intent: ${pending.intent.type} — "${pending.intent.query}"\n\n*Last messages:*\n${historyBlock}\n\nReply:\n\`!teach ${id} <query>\` / \`!teach ${id} skip\` / \`!teach ${id} say <text>\``); }
async function resolvePending(id, action, payload, adminChatJid) { const p = pendingRequests.get(id); if (!p) return { ok: false, error: `No pending request ${id}` }; const reply = (t) => queuedSend(adminChatJid, { text: t }); try { if (action === 'skip') { const casual = await askRewind(`User said: "${p.userHistory.map(h => h.text).join(' / ')}". Reply casually.`, `You are Abby Faith Sithole, 23, Harare Zimbabwe. Warm, casual.`); await queuedSend(p.userJid, { text: casual || 'Sorry, couldn\'t find that right now 😅' }); pendingRequests.delete(id); savePending(); resetDailyStats(); dailyStats.pendingResolved++; await reply(`✅ Replied casually to ${p.userName}.`); return { ok: true }; } if (action === 'say') { await queuedSend(p.userJid, { text: payload }); pendingRequests.delete(id); savePending(); resetDailyStats(); dailyStats.pendingResolved++; await reply(`✅ Sent your text to ${p.userName}.`); return { ok: true }; } const query = payload || p.intent.query; await reply(`🔎 Searching "${query}" for ${p.userName}...`); if (p.intent.type === 'video' || p.intent.type === 'gif') { const r = await scraperGif(query); if (!r.ok || r.gifs.length === 0) { await reply(`❌ No results for "${query}".`); return { ok: false }; } await queuedSend(p.userJid, { video: { url: r.gifs[0] }, gifPlayback: true }); resetDailyStats(); dailyStats.picsSent++; } else { const r = await scraperSearch(query); if (!r.ok || r.images.length === 0) { await reply(`❌ No results for "${query}".`); return { ok: false }; } await queuedSend(p.userJid, { image: { url: r.images[0] } }); resetDailyStats(); dailyStats.picsSent++; } pendingRequests.delete(id); savePending(); resetDailyStats(); dailyStats.pendingResolved++; await reply(`✅ Sent to ${p.userName}.`); return { ok: true }; } catch (e) { await reply(`❌ ${e.message}`); return { ok: false, error: e.message }; } }

function discoverGroup(jid, groupName) { if (!jid || !jid.endsWith('@g.us')) return false; if (joinedGroups.has(jid)) return false; joinedGroups.set(jid, { name: groupName || null, joinedAt: Date.now(), discovered: true }); lastGreetingAt.set(jid, Date.now()); saveGroups(); resetDailyStats(); dailyStats.discovered++; pushLog('success', 'group', `Discovered group ${jid}`); return true; }

// ================================================================
// GREETINGS & DAILY REPORT (v44.0 style)
// ================================================================
const GREETING_PHRASES = { morning: ['Morning all ☀️', 'Mangwanani guys ☀️', 'Good morning fam', 'Morning 🌅', 'Rise and shine ☀️'], midday: ['Hi guys 👋', 'Hey everyone', 'Hello fam 😊', 'Hi all', 'Hey guys, hope you\'re good'], evening: ['Good evening fam 🌆', 'Evening all 👋', 'Manheru guys', 'Evening everyone'], night: ['Good night all 🌙', 'Manheru akanaka 🌙', 'Sleep well fam', 'Good night everyone 💤', 'Night night 😴'] };
function getTimeOfDay() { const h = new Date().getHours(); if (h >= 5 && h < 12) return 'morning'; if (h >= 12 && h < 17) return 'midday'; if (h >= 17 && h < 21) return 'evening'; return 'night'; }
function pickGreeting(p) { const pool = GREETING_PHRASES[p] || GREETING_PHRASES.midday; return pool[Math.floor(Math.random() * pool.length)]; }
function scheduleGreetings() {
  setInterval(async () => {
    if (!sock || connectionStatus !== 'connected' || joinedGroups.size === 0 || botPaused || scheduler.frozen) return;
    if (timeGate.isOffline() || !timeGate.isGroupActive()) return;
    const now = Date.now(); const minMs = GREETING_MIN_HOURS * 3600 * 1000, maxMs = GREETING_MAX_HOURS * 3600 * 1000;
    for (const [jid] of joinedGroups) {
      const sinceLast = now - (lastGreetingAt.get(jid) || 0); if (sinceLast < minMs) continue;
      const progress = (sinceLast - minMs) / (maxMs - minMs); if (Math.random() > Math.min(progress, 1)) continue;
      const replyText = pickGreeting(getTimeOfDay());
      try { await queuedSend(jid, { text: replyText }); lastGreetingAt.set(jid, now); resetDailyStats(); dailyStats.greetingsSent++; pushLog('info', 'greeting', `Queued greeting for ${jid}: ${replyText}`); } catch (e) { pushLog('warn', 'greeting', `Failed ${jid}: ${e.message}`); }
    }
    saveGroups();
  }, 15 * 60 * 1000);
}
function scheduleDailyReport() {
  setInterval(async () => {
    if (!sock || connectionStatus !== 'connected') return;
    const now = new Date(); const today = now.toISOString().slice(0, 10);
    if (now.getHours() !== DAILY_REPORT_HOUR || lastDailyReportDate === today) return;
    lastDailyReportDate = today; resetDailyStats(); const s = dailyStats || {};
    const summary = [`📊 *Daily Summary — ${today}*`, ``, `👥 Groups: *${joinedGroups.size}*`, `💬 DMs: *${activeDMs.size}*`, `📋 Queue: *${joinQueue.length}*`, `⏳ Pending: *${pendingRequests.size}*`, ``, `✅ Joined: *${s.joined || 0}*`, `🔍 Discovered: *${s.discovered || 0}*`, `❌ Failed: *${s.failed || 0}*`, `💌 DM replies: *${s.dmsReplied || 0}*`, `🎯 Focus runs: *${s.focusRuns || 0}*`, `🖼️ Pics/Videos: *${(s.picsSent || 0) + (s.videosSent || 0)}*`, `📥 Downloads: *${s.downloads || 0}* (NSFW: *${s.nsfwDownloads || 0}*)`, `📢 Broadcasts: *${s.broadcastsSent || 0}*`, `🔗 Group links shared: *${s.groupLinksShared || 0}*`, `👋 Greetings: *${s.greetingsSent || 0}*`, `🤖 AI errors: *${s.aiErrors || 0}*`, `💥 Bad MACs: *${s.badMacs || 0}*`, `🗑️ Messages dropped: *${s.messagesDropped || 0}*`, ``, `Uptime: ${Math.floor((Date.now() - botStartTime) / 3600000)}h`].join('\n');
    await alertAdmin(summary);
  }, 60 * 1000);
}

// ================================================================
// GROUP BATCH PROCESSOR
// ================================================================
function scheduleGroupBatchProcessor() {
  setInterval(async () => {
    if (!sock || connectionStatus !== 'connected' || botPaused || scheduler.frozen) return;
    if (!timeGate.isGroupActive()) return;
    for (const [jid, items] of groupBatcher.pending) {
      const drained = groupBatcher.drain(jid); if (!drained || drained.length === 0) continue;
      pushLog('info', 'group', `Batch processing ${drained.length} messages from ${jid}`);
    }
  }, 10 * 60 * 1000);
}

// ================================================================
// EXPRESS + DASHBOARD
// ================================================================
const app = express();
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now(), status: connectionStatus, uptime: Math.floor((Date.now()-botStartTime)/1000), sched: scheduler.stats(), focus: focus.stats(), window: timeGate.window(), groupActive: timeGate.isGroupActive(), nsfwActive: timeGate.isNsfwActive(), paused: botPaused, frozen: scheduler.frozen, dmQueue: dmQueue.length }));
app.get('/api/status', (req, res) => res.json({ status: connectionStatus, botNumber, groups: joinedGroups.size, dms: activeDMs.size, queue: joinQueue.length, pending: pendingRequests.size }));
app.get('/admin/qr', async (req, res) => { if (!qrDataUri) return res.status(404).json({ error: 'No QR' }); const b64 = qrDataUri.replace(/^data:image\/\w+;base64,/, ''); res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(Buffer.from(b64, 'base64')); });
app.get('/admin/qr-data', (req, res) => res.json({ qr: qrDataUri, status: connectionStatus, botNumber }));
app.post('/admin/connect', (req, res) => { if (!sock) connectBot(); res.json({ ok: true }); });
app.post('/admin/reconnect', async (req, res) => { await disconnectBot(); setTimeout(() => { manualDisconnect = false; connectBot(); }, 1500); res.json({ ok: true }); });
app.post('/admin/disconnect', async (req, res) => { await disconnectBot(); res.json({ ok: true }); });
app.post('/admin/refresh-qr', (req, res) => { refreshQR(); res.json({ ok: true }); });
app.post('/admin/clear-session', (req, res) => { try { fs.rmSync(AUTH_FOLDER, { recursive: true, force: true }); } catch (e) {} res.json({ ok: true, msg: 'Session cleared.' }); });
app.post('/admin/pause', (req, res) => { botPaused = true; res.json({ ok: true }); });
app.post('/admin/resume', (req, res) => { botPaused = false; res.json({ ok: true }); });
app.post('/admin/freeze', (req, res) => { scheduler.freeze(); res.json({ ok: true }); });
app.post('/admin/unfreeze', (req, res) => { scheduler.unfreeze(); res.json({ ok: true }); });
app.get('/admin/logs', (req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' }); for (const e of logBuffer.slice(-100)) res.write(`data: ${JSON.stringify(e)}\n\n`); logClients.add(res); req.on('close', () => logClients.delete(res)); });
app.get('/admin/messages-stream', (req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' }); for (const m of liveMessages.slice(-100)) res.write(`data: ${JSON.stringify(m)}\n\n`); msgClients.add(res); req.on('close', () => msgClients.delete(res)); });
app.get('/admin/aitest', async (req, res) => { const r = await testRewindRaw(); res.json(r); });
app.get('/admin/scraperstatus', async (req, res) => { const r = await scraperStatus(); res.json(r); });
app.get('/admin/sched', (req, res) => res.json({ scheduler: scheduler.stats(), focus: focus.stats(), window: timeGate.window(), groupActive: timeGate.isGroupActive(), nsfwActive: timeGate.isNsfwActive(), dmQueue: dmQueue.length, groupBatcher: groupBatcher.stats() }));
app.get('/admin/pending', (req, res) => res.json({ pending: [...pendingRequests.values()] }));
app.post('/admin/pending/:id/resolve', async (req, res) => { const { id } = req.params; const { action, payload } = req.body || {}; const r = await resolvePending(id, action || 'search', payload, ADMIN_JID); res.json(r); });
app.get('/admin/stats', (req, res) => {
  const grp = [...activeChats].filter(j => j.endsWith('@g.us')).length;
  res.json({
    status: connectionStatus, botNumber,
    uptime: Math.floor((Date.now()-botStartTime)/1000),
    dmCount: activeDMs.size, groupCount: grp, totalChats: activeChats.size,
    logCount: logBuffer.length, messageCount: liveMessages.length,
    scraperUrl: SCRAPER_URL,
    joinedGroups: joinedGroups.size, queueSize: joinQueue.length,
    dailyStats, scraperStats,
    adminPhone: ADMIN_PHONE, adminLids: [...adminLids],
    pendingCount: pendingRequests.size,
    sched: scheduler.stats(), focus: focus.stats(),
    window: timeGate.window(), groupActive: timeGate.isGroupActive(), nsfwActive: timeGate.isNsfwActive(),
    dmQueueLength: dmQueue.length, dmQueueMax: DM_QUEUE_MAX,
    groupBatcher: groupBatcher.stats(),
    paused: botPaused, frozen: scheduler.frozen,
    antibanActive: !!wrapSocket, entropyRunning: !!entropyService,
    fibonacciIndex: fib.idx
  });
});

const PANEL_HTML = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BreadBot v45</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:monospace;background:#0d1117;color:#c9d1d9;padding:16px}h1{font-size:20px;color:#58a6ff;margin-bottom:4px}.sub{font-size:12px;color:#8b949e;margin-bottom:16px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px}.card h2{font-size:12px;color:#8b949e;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px}button{background:#21262d;border:1px solid #30363d;color:#c9d1d9;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:13px;margin:3px;font-family:inherit}button:hover{background:#30363d;border-color:#58a6ff}button.primary{background:#238636;border-color:#2ea043;color:#fff}button.danger{background:#da3633;border-color:#f85149;color:#fff}#qrImg{width:100%;max-width:240px;border-radius:8px;margin:8px auto;display:block;background:#fff;padding:8px}.status-dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;vertical-align:middle}.s-connected{background:#3fb950;box-shadow:0 0 8px #3fb950}.s-qr{background:#d29922}.s-disconnected{background:#f85149}.s-reconnecting{background:#d29922;animation:pulse 1s infinite}.s-error{background:#f85149}@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}#logs,#msgs{height:280px;overflow-y:auto;font-size:12px;line-height:1.6;background:#0d1117;border-radius:6px;padding:8px}.log-entry{padding:3px 0;border-bottom:1px solid #21262d}.log-time{color:#484f58;margin-right:8px}.log-info{color:#58a6ff}.log-success{color:#3fb950}.log-warn{color:#d29922}.log-error{color:#f85149}.log-source{color:#8b949e;margin-right:6px}.stat-row{display:flex;justify-content:space-between;padding:5px 0;font-size:13px;border-bottom:1px solid #21262d}.stat-row:last-child{border-bottom:none}.stat-val{color:#58a6ff;font-weight:600}.msg-row{padding:6px 8px;margin:4px 0;border-radius:6px;background:#161b22;border-left:3px solid #58a6ff;font-size:12px}.msg-row.group{border-left-color:#a371f7}.msg-row.dm{border-left-color:#3fb950}.msg-meta{color:#8b949e;font-size:11px;margin-bottom:2px}.msg-name{color:#58a6ff;font-weight:600}.msg-text{color:#c9d1d9;word-break:break-word}.tag{display:inline-block;padding:1px 6px;border-radius:3px;font-size:10px;margin-left:6px;font-weight:600}.tag-group{background:#a371f7;color:#fff}.tag-dm{background:#3fb950;color:#000}.full-width{grid-column:1/-1}</style></head><body>
<h1>🥖 BreadBot v45 — Group Management + Video Downloader</h1><div class="sub">Admin: <b id="adminPhone">—</b> · Window: <b id="windowState">—</b> · Group: <b id="groupState">—</b> · NSFW: <b id="nsfwState">—</b></div>
<div class="grid">
<div class="card"><h2>Connection</h2><div style="margin-bottom:10px"><span class="status-dot" id="statusDot"></span><span id="statusText">Loading...</span></div><div class="stat-row"><span>Bot</span><span class="stat-val" id="botNum">—</span></div><div class="stat-row"><span>Uptime</span><span class="stat-val" id="statUptime">—</span></div><div class="stat-row"><span>Paused</span><span class="stat-val" id="pausedState">—</span></div><div class="stat-row"><span>Frozen</span><span class="stat-val" id="frozenState">—</span></div><img id="qrImg" src="" style="display:none"><div style="margin-top:10px"><button class="primary" onclick="doAction('connect')">🔗 Start</button><button onclick="doAction('reconnect')">🔄 Reconnect</button><button onclick="doAction('refresh-qr')">♻️ Refresh QR</button><button class="danger" onclick="doAction('disconnect')">⛔ Disconnect</button><button onclick="doAction('clear-session')">🗑️ Clear Session</button><button onclick="doAction('pause')">⏸️ Pause</button><button onclick="doAction('resume')">▶️ Resume</button><button onclick="doAction('freeze')">❄️ Freeze</button><button onclick="doAction('unfreeze')">🔥 Unfreeze</button><button onclick="testAI()">🧪 Test AI</button><button onclick="testScraper()">🔎 Test Scraper</button></div><pre id="testResult" style="margin-top:8px;font-size:11px;color:#8b949e;white-space:pre-wrap;max-height:180px;overflow:auto"></pre></div>
<div class="card"><h2>🎯 Focus Pipeline</h2><div class="stat-row"><span>Busy</span><span class="stat-val" id="focusBusy">—</span></div><div class="stat-row"><span>State</span><span class="stat-val" id="focusCurState">—</span></div><div class="stat-row"><span>Current JID</span><span class="stat-val" id="focusJid">—</span></div></div>
<div class="card"><h2>⏰ Time Windows</h2><div class="stat-row"><span>Window</span><span class="stat-val" id="windowName">—</span></div><div class="stat-row"><span>Group</span><span class="stat-val" id="groupWindow">—</span></div><div class="stat-row"><span>NSFW</span><span class="stat-val" id="nsfwWindow">—</span></div></div>
<div class="card"><h2>⚙️ Serial Scheduler</h2><div class="stat-row"><span>Queued</span><span class="stat-val" id="schedQueued">—</span></div><div class="stat-row"><span>Running</span><span class="stat-val" id="schedRunning">—</span></div><div class="stat-row"><span>Current</span><span class="stat-val" id="schedTask">—</span></div><div class="stat-row"><span>DM queue</span><span class="stat-val" id="dmQueue">—</span></div><div class="stat-row"><span>Next Fibonacci</span><span class="stat-val" id="schedGap">—</span></div></div>
<div class="card"><h2>📦 Group Batcher</h2><div class="stat-row"><span>Groups pending</span><span class="stat-val" id="gbGroups">—</span></div><div class="stat-row"><span>Total pending</span><span class="stat-val" id="gbTotal">—</span></div></div>
<div class="card"><h2>Groups & Queue</h2><div class="stat-row"><span>Joined</span><span class="stat-val" id="statGroups">—</span></div><div class="stat-row"><span>DM chats</span><span class="stat-val" id="statDMs">—</span></div><div class="stat-row"><span>Join queue</span><span class="stat-val" id="statQueue">—</span></div><div class="stat-row"><span>Pending</span><span class="stat-val" id="statPending">—</span></div></div>
<div class="card"><h2>Today</h2><div class="stat-row"><span>DM replies</span><span class="stat-val" id="dayDMs">—</span></div><div class="stat-row"><span>Focus runs</span><span class="stat-val" id="dayFocus">—</span></div><div class="stat-row"><span>Pics / Videos</span><span class="stat-val" id="dayPics">—</span></div><div class="stat-row"><span>Downloads</span><span class="stat-val" id="dayDownloads">—</span></div><div class="stat-row"><span>NSFW downloads</span><span class="stat-val" id="dayNsfw">—</span></div><div class="stat-row"><span>Broadcasts</span><span class="stat-val" id="dayBC">—</span></div><div class="stat-row"><span>Group links shared</span><span class="stat-val" id="dayGrouplink">—</span></div><div class="stat-row"><span>Dropped</span><span class="stat-val" id="dayDropped">—</span></div></div>
<div class="card full-width"><h2>📨 Live Messages</h2><div id="msgs"></div></div>
<div class="card full-width"><h2>📜 Logs</h2><div id="logs"></div></div>
</div>
<script>
const $=id=>document.getElementById(id);
async function api(p,m='GET',body){const opts={method:m};if(body){opts.headers={'Content-Type':'application/json'};opts.body=JSON.stringify(body);}const r=await fetch('/admin/'+p,opts);return r.json();}
function fmt(s){const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),x=s%60;return h+'h '+m+'m '+x+'s';}
function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function setStatus(st){$('statusDot').className='status-dot s-'+st;const l={connected:'Connected',qr:'Waiting for scan',disconnected:'Disconnected',reconnecting:'Reconnecting',error:'Error'};$('statusText').textContent=l[st]||st;}
async function testAI(){const b=$('testResult');b.textContent='Testing AI...';const r=await api('aitest');b.textContent=JSON.stringify(r,null,2);}
async function testScraper(){const b=$('testResult');b.textContent='Testing scraper...';const r=await api('scraperstatus');b.textContent=JSON.stringify(r,null,2);}
async function refreshStats(){try{const d=await api('stats');setStatus(d.status);$('statUptime').textContent=fmt(d.uptime);$('botNum').textContent=d.botNumber||'—';$('statGroups').textContent=d.joinedGroups;$('statDMs').textContent=d.dmCount;$('statQueue').textContent=d.queueSize;$('statPending').textContent=d.pendingCount||0;$('adminPhone').textContent=d.adminPhone||'—';$('windowState').textContent=d.window||'—';$('groupState').textContent=d.groupActive?'ACTIVE':'IDLE';$('nsfwState').textContent=d.nsfwActive?'ALLOWED':'BLOCKED';$('pausedState').textContent=d.paused?'YES':'no';$('frozenState').textContent=d.frozen?'YES':'no';$('windowName').textContent=d.window||'—';$('groupWindow').textContent=d.groupActive?'ACTIVE':'IDLE';$('nsfwWindow').textContent=d.nsfwActive?'ALLOWED':'BLOCKED';
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

// ================================================================
// KEEP-ALIVE
// ================================================================
setInterval(async () => { if (connectionStatus === 'connected' && sock && !timeGate.isOffline() && !botPaused) { try { await sock.sendPresenceUpdate('available'); } catch (e) {} } }, 4 * 60 * 1000);
setInterval(() => { axios.get(`http://localhost:${PORT}/health`).catch(() => {}); }, 4 * 60 * 1000);
setInterval(processJoinQueue, 30 * 1000);

// ================================================================
// STARTUP
// ================================================================
loadState();
loadAdminLids();
loadGroupSettings();
loadLearningData();
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Admin phone: ${ADMIN_PHONE}`);
  console.log(`Admin LIDs: ${[...adminLids].join(', ')}`);
  console.log(`Serial scheduler: concurrency=1, Fibonacci gaps`);
  console.log(`Time windows: ${timeGate.describe()} | Group: ${timeGate.describeGroup()} | NSFW: ${timeGate.describeNsfw()}`);
  console.log(`DM queue max: ${DM_QUEUE_MAX}, Focus timeout: ${FOCUS_LOCK_TIMEOUT_MS}ms`);
  console.log(`yt-dlp available: ${isYtDlpAvailable()}`);
  pushLog('info', 'system', `Boot port ${PORT}`);
  pushLog('info', 'system', `Admin phone: ${ADMIN_PHONE}`);
  pushLog('info', 'system', `Serial scheduler active · Fibonacci timing · Time windows`);
  pushLog('info', 'system', `Group active: 21:00-00:00 | NSFW: 21:00-08:00`);
  pushLog('info', 'system', `Scraper: ${SCRAPER_URL}`);
  scheduleGreetings();
  scheduleDailyReport();
  scheduleGroupBatchProcessor();
  connectBot().catch(err => { console.error('Boot failed:', err); pushLog('error', 'system', `Boot failed: ${err.message}`); });
});
