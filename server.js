'use strict';

// ================================================================
// WHATSAPP BOT v44.0 — Human Behavior Edition
// Serial focus pipeline + Fibonacci timing + time windows
// All features preserved from v43.2
// ================================================================

const express = require('express');
const fs = require('fs');
const path = require('path');
const NodeCache = require('node-cache');
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

const REWIND_KEY = process.env.REWIND_KEY || 'sk-rewind-31c3a65acc981512de959195485deec0';
const SCRAPER_URL = (process.env.SCRAPER_URL || 'https://intelligent-scraper.onrender.com').replace(/\/$/, '');

const JOIN_INTERVAL_MS = parseInt(process.env.JOIN_INTERVAL_MS || '480000', 10);
const JOIN_QUEUE_FILE = path.join(__dirname, 'join_queue.json');
const JOINED_GROUPS_FILE = path.join(__dirname, 'joined_groups.json');
const PENDING_FILE = path.join(__dirname, 'pending_requests.json');

const GREETING_MIN_HOURS = 4;
const GREETING_MAX_HOURS = 8;
const DAILY_REPORT_HOUR = parseInt(process.env.DAILY_REPORT_HOUR || '22', 10);

const USER_HISTORY_SIZE = 4;
const PENDING_EXPIRY_MS = 60 * 60 * 1000;

// ── TIME WINDOW (server local time = UTC by default on Render) ──
// Set TZ env var on Render to 'Africa/Harare' to align with Zimbabwe hours
const TZ_OFFSET_HOURS = parseInt(process.env.TZ_OFFSET_HOURS || '2', 10); // Zimbabwe is UTC+2

// ================================================================
// FIBONACCI TIMING CLOCK
// Every delay in the bot draws from this clock. Values are in
// SECONDS. The sequence cycles with occasional skips and resets,
// making it deterministic-but-unpredictable (chess-move-like).
// ================================================================
const FIBONACCI_SECONDS = [1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377, 610];

class FibonacciClock {
  constructor() {
    this.idx = 0;
    this.history = [];
  }
  next() {
    // Chess-move-like: mostly advance by 1, sometimes skip, rarely reset
    const roll = Math.random();
    if (roll < 0.08) {
      // 8% chance: reset to a low index (a quick move)
      this.idx = Math.floor(Math.random() * 3);
    } else if (roll < 0.28) {
      // 20% chance: skip forward 2 (a bold move)
      this.idx = (this.idx + 2) % FIBONACCI_SECONDS.length;
    } else {
      // 72% chance: advance by 1 (normal move)
      this.idx = (this.idx + 1) % FIBONACCI_SECONDS.length;
    }
    const sec = FIBONACCI_SECONDS[this.idx];
    this.history.push(sec);
    if (this.history.length > 50) this.history.shift();
    return sec * 1000;
  }
  // Peek current position without advancing
  peek() {
    return FIBONACCI_SECONDS[this.idx] * 1000;
  }
  // For human steps we want small values — cap the Fibonacci value
  nextCapped(maxSeconds) {
    const ms = this.next();
    return Math.min(ms, maxSeconds * 1000);
  }
}

const fib = new FibonacciClock();

// ================================================================
// TIME WINDOW GATE
// Determines whether the bot is in an "active" window or offline.
// Zimbabwe local hours (UTC+2).
// ================================================================
class TimeWindowGate {
  constructor(offsetHours = 2) {
    this.offset = offsetHours;
  }
  localHour() {
    const d = new Date();
    const h = (d.getUTCHours() + this.offset) % 24;
    return h;
  }
  // Returns one of: 'sleep', 'light', 'active', 'lunch', 'dinner'
  window() {
    const h = this.localHour();
    if (h >= 22 || h < 6) return 'sleep';      // 22:00 - 06:00
    if (h >= 6 && h < 8) return 'light';        // 06:00 - 08:00
    if (h >= 12 && h < 13) return 'lunch';      // 12:00 - 13:00
    if (h >= 18 && h < 19) return 'dinner';     // 18:00 - 19:00
    if (h >= 20) return 'light';                // 20:00 - 22:00
    return 'active';
  }
  isOffline() {
    const w = this.window();
    return w === 'sleep' || w === 'lunch' || w === 'dinner';
  }
  // Speed multiplier for this window
  speedFactor() {
    switch (this.window()) {
      case 'active': return 1.0;
      case 'light': return 0.5;
      case 'lunch':
      case 'dinner': return 0.1; // essentially queued
      case 'sleep': return 0.0;
      default: return 1.0;
    }
  }
  describe() {
    const h = this.localHour();
    return `${String(h).padStart(2,'0')}:xx — ${this.window()} (factor ${this.speedFactor()})`;
  }
}

const timeGate = new TimeWindowGate(TZ_OFFSET_HOURS);

// ================================================================
// SERIAL TASK SCHEDULER
// Concurrency = 1. One task at a time. Gaps drawn from FibonacciClock.
// ================================================================
class SerialTaskScheduler {
  constructor() {
    this.queue = [];
    this.running = false;
    this.totalQueued = 0;
    this.totalRun = 0;
    this.totalFailed = 0;
    this.currentTask = null;
  }
  schedule(name, fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ name, fn, resolve, reject, queuedAt: Date.now() });
      this.totalQueued++;
      this._pump();
    });
  }
  async _pump() {
    if (this.running) return;
    if (this.queue.length === 0) return;
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

    // Chess-move gap before next task
    const gap = fib.nextCapped(60);
    const adjusted = Math.floor(gap * Math.max(0.3, timeGate.speedFactor()));
    setTimeout(() => this._pump(), adjusted);
  }
  stats() {
    return {
      queued: this.queue.length,
      running: this.running ? 1 : 0,
      currentTask: this.currentTask,
      totalQueued: this.totalQueued,
      totalRun: this.totalRun,
      totalFailed: this.totalFailed,
      concurrency: 1,
      nextGapMs: fib.peek()
    };
  }
}

const scheduler = new SerialTaskScheduler();

// ================================================================
// FOCUS PIPELINE — the "reading + replying" state machine
// Each incoming message runs through these states with Fibonacci
// timing. Only ONE message is ever in the pipeline at once.
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
    // Wait if another focus is active
    while (this.busy) {
      await new Promise(r => setTimeout(r, 500));
    }
    this.busy = true;
    this.currentJid = jid;
    this.startedAt = Date.now();

    try {
      // Human states — each one has a Fibonacci delay
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
        const scaled = Math.max(step.min * 1000, delay);
        await new Promise(r => setTimeout(r, scaled));
      }

      // Typing state — actual reply is generated + sent here
      this.currentState = 'typing';
      const result = await taskFn();

      // Review + send
      this.currentState = 'reviewing';
      await new Promise(r => setTimeout(r, 1000 + Math.random() * 3000));

      this.currentState = 'sent';
      this.lastCompletedAt = Date.now();

      // Switching chat gap before next focus
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
// GROUP BATCHER — group messages are queued, not processed instantly
// ================================================================
class GroupBatcher {
  constructor() {
    this.pending = new Map(); // jid -> [{msg, text, ts}]
    this.lastBatchAt = new Map(); // jid -> ts
    this.minBatchIntervalMs = 30 * 60 * 1000; // 30 min
    this.maxBatchIntervalMs = 90 * 60 * 1000; // 90 min
  }
  enqueue(jid, item) {
    if (!this.pending.has(jid)) this.pending.set(jid, []);
    this.pending.get(jid).push(item);
    if (this.pending.get(jid).length > 200) this.pending.get(jid).shift();
  }
  // Return all queued items for a jid if the interval has elapsed
  drain(jid) {
    const last = this.lastBatchAt.get(jid) || 0;
    const since = Date.now() - last;
    const targetInterval = this.minBatchIntervalMs +
      Math.random() * (this.maxBatchIntervalMs - this.minBatchIntervalMs);
    if (since < targetInterval) return null;
    const items = this.pending.get(jid) || [];
    this.pending.set(jid, []);
    this.lastBatchAt.set(jid, Date.now());
    return items;
  }
  stats() {
    let total = 0;
    for (const arr of this.pending.values()) total += arr.length;
    return {
      groupsWithPending: this.pending.size,
      totalPending: total,
      minBatchMin: this.minBatchIntervalMs / 60000,
      maxBatchMin: this.maxBatchIntervalMs / 60000
    };
  }
}

const groupBatcher = new GroupBatcher();

// ================================================================
// INFORMALITY LAYER
// Adds human imperfections to outgoing text.
// ================================================================
function informalize(text) {
  if (!text) return text;
  let t = text;

  // 40% chance: lowercase the first character
  if (Math.random() < 0.4) {
    t = t.charAt(0).toLowerCase() + t.slice(1);
  }

  // 15% chance: lowercase the first word entirely
  if (Math.random() < 0.15) {
    const parts = t.split(' ');
    if (parts[0]) parts[0] = parts[0].toLowerCase();
    t = parts.join(' ');
  }

  // 3% chance: inject a small typo (swap two adjacent chars in a word)
  if (Math.random() < 0.03) {
    const words = t.split(' ');
    const idx = Math.floor(Math.random() * words.length);
    const w = words[idx];
    if (w && w.length > 3) {
      const pos = 1 + Math.floor(Math.random() * (w.length - 2));
      words[idx] = w.slice(0, pos) + w[pos + 1] + w[pos] + w.slice(pos + 2);
      t = words.join(' ');
    }
  }

  // 5% chance: append a filler emoji
  if (Math.random() < 0.05) {
    const fillers = ['😅', '😂', '🙃', '😊', '👀'];
    t = t + ' ' + fillers[Math.floor(Math.random() * fillers.length)];
  }

  return t;
}

// ================================================================
// ADMIN LID STORE
// ================================================================
let adminLids = new Set(HARDCODED_ADMIN_LIDS);

function loadAdminLids() {
  try {
    if (fs.existsSync(ADMIN_LID_FILE)) {
      const arr = JSON.parse(fs.readFileSync(ADMIN_LID_FILE, 'utf8')) || [];
      for (const lid of arr) adminLids.add(lid);
    }
  } catch (e) {}
}
function saveAdminLids() {
  try { fs.writeFileSync(ADMIN_LID_FILE, JSON.stringify([...adminLids], null, 2)); } catch (e) {}
}

// ================================================================
// FORBIDDEN / FILLER FILTER
// ================================================================
const FORBIDDEN_PATTERNS = [
  /\bcannot\b/i, /\bcan'?t\b/i, /\bunable to\b/i,
  /\bi refuse\b/i, /\bnot allowed\b/i,
  /\bagainst my guidelines\b/i, /\bas an ai\b/i, /\bi am an ai\b/i,
  /\blanguage model\b/i, /\bsorry,? i\b/i, /\bi apologize\b/i,
  /\bapi[_ ]?key\b/i, /\bconsole\.log\b/i, /\berror:/i,
  /\bstack trace\b/i, /\btraceback\b/i, /\bdebug\b/i,
  /\bnode\.js\b/i, /\bnpm\b/i,
  /how can i help you today\??/i, /how may i help you\??/i,
  /is there anything else/i, /anything else i can help/i,
  /let me know if/i, /feel free to/i,
  /\bi am here to help\b/i, /\bi'?m here to help\b/i,
  /\bi am happy to help\b/i, /\bi'?m happy to help\b/i,
  /happy to assist/i, /how can i help/i, /what can i do for you/i,
  /do you need any/i, /please let me know/i,
  /i hope this helps/i, /hope this helps/i,
  /thank you for reaching out/i, /thanks for reaching out/i,
  /don'?t hesitate to/i, /do not hesitate/i, /\bas an assistant\b/i,
  /\bgreetings!\b/i, /how are you today\?/i, /i understand that/i,
  /based on your (query|request)/i, /to answer your question/i,
  /in response to/i, /\bapi_key\b/i, /\btoken\b/i,
  /\bas an? (ai|assistant|bot|language model)\b/i,
  /\bi'?m an? (ai|assistant|bot|language model)\b/i,
  /\bi cannot (provide|help|assist|do|generate)\b/i,
  /\bit'?s important to (note|remember|understand)\b/i,
  /\bhowever,? (i|it) (must|should|need)\b/i,
  /\bi should (mention|note|point out)\b/i,
];

function containsForbidden(text) {
  if (!text) return true;
  return FORBIDDEN_PATTERNS.some(re => re.test(text));
}

function humanize(text) {
  if (!text) return '';
  let t = text;
  t = t.replace(/```[\s\S]*?```/g, '').replace(/https?:\/\/\S+/g, '');
  t = t.split('\n').filter(line => {
    const l = line.trim().toLowerCase();
    if (!l) return true;
    if (/^\[?(info|warn|error|debug|trace)\]?[: ]/.test(l)) return false;
    if (/^\d{4}-\d{2}-\d{2}/.test(l)) return false;
    if (/^at\s+\w+/.test(l)) return false;
    return true;
  }).join('\n');
  const filler = [
    /how can i help you today\??/gi, /how may i help you\??/gi,
    /is there anything else.*?\?/gi, /let me know if.*?\./gi,
    /feel free to.*?\./gi, /i'?m? here to help\.?/gi,
    /i'?m? happy to help\.?/gi, /hope this helps!?/gi,
    /thank you for reaching out\.?/gi, /thanks for reaching out\.?/gi
  ];
  for (const p of filler) t = t.replace(p, '');
  return t.replace(/\n{3,}/g, '\n\n').replace(/\s{2,}/g, ' ').trim();
}

// ================================================================
// LANGUAGE
// ================================================================
const SHONA_MARKERS = ['ndi','uri','kuti','here','izvi','zvakanaka','sei','ndoda','unoda','mhoro','mangwanani','masikati','manheru','ndapota','zvinhu','vanhu','kuita','kuenda','kuuya'];
const LANG_NAMES = { sn: 'Shona', en: 'English' };
function detectLanguage(text) {
  if (!text) return 'en';
  return text.toLowerCase().split(/\s+/).filter(w => SHONA_MARKERS.includes(w)).length > 0 ? 'sn' : 'en';
}

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
  if (!sock) return;
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

const scraperStats = {
  searchCalls: 0, searchSuccess: 0, searchFail: 0,
  gifCalls: 0, gifSuccess: 0, gifFail: 0,
  lastSearchQuery: null, lastSearchAt: null,
  lastGifQuery: null, lastGifAt: null
};

let previewCache = { imageUrls: [], imageIndex: 0, gifUrls: [], gifIndex: 0, currentType: null, currentUrl: null };
let dailyStats = null;
let lastDailyReportDate = null;

function resetDailyStats() {
  const today = new Date().toISOString().slice(0, 10);
  if (lastDailyReportDate !== today) {
    dailyStats = { date: today, joined: 0, failed: 0, dmsReplied: 0, broadcastsSent: 0, greetingsSent: 0, scraperSearches: 0, scraperGifs: 0, picsSent: 0, videosSent: 0, aiErrors: 0, pendingCreated: 0, pendingResolved: 0, discovered: 0, imageBroadcasts: 0, badMacs: 0, focusRuns: 0 };
  }
}
resetDailyStats();

// ================================================================
// PERSISTENCE
// ================================================================
function loadState() {
  try { if (fs.existsSync(JOIN_QUEUE_FILE)) joinQueue = JSON.parse(fs.readFileSync(JOIN_QUEUE_FILE, 'utf8')) || []; } catch (e) { joinQueue = []; }
  try {
    if (fs.existsSync(JOINED_GROUPS_FILE)) {
      const arr = JSON.parse(fs.readFileSync(JOINED_GROUPS_FILE, 'utf8')) || [];
      for (const g of arr) {
        joinedGroups.set(g.jid, { name: g.name, joinedAt: g.joinedAt, discovered: g.discovered || false });
        if (g.lastGreetedAt) lastGreetingAt.set(g.jid, g.lastGreetedAt);
      }
    }
  } catch (e) {}
  try {
    if (fs.existsSync(PENDING_FILE)) {
      const arr = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8')) || [];
      const now = Date.now();
      for (const p of arr) if (now - p.requestedAt < PENDING_EXPIRY_MS) pendingRequests.set(p.id, p);
    }
  } catch (e) {}
  pushLog('info', 'state', `queue=${joinQueue.length} groups=${joinedGroups.size} pending=${pendingRequests.size} adminLids=${adminLids.size}`);
}
function saveQueue() { try { fs.writeFileSync(JOIN_QUEUE_FILE, JSON.stringify(joinQueue, null, 2)); } catch (e) {} }
function saveGroups() {
  try {
    const arr = [...joinedGroups.entries()].map(([jid, v]) => ({
      jid, name: v.name, joinedAt: v.joinedAt, discovered: v.discovered || false,
      lastGreetedAt: lastGreetingAt.get(jid) || null
    }));
    fs.writeFileSync(JOINED_GROUPS_FILE, JSON.stringify(arr, null, 2));
  } catch (e) {}
}
function savePending() { try { fs.writeFileSync(PENDING_FILE, JSON.stringify([...pendingRequests.values()], null, 2)); } catch (e) {} }

// ================================================================
// GROUP DISCOVERY (unchanged behavior — discovery is passive)
// ================================================================
function discoverGroup(jid, groupName) {
  if (!jid || !jid.endsWith('@g.us')) return false;
  if (joinedGroups.has(jid)) return false;
  joinedGroups.set(jid, { name: groupName || null, joinedAt: Date.now(), discovered: true });
  lastGreetingAt.set(jid, Date.now());
  saveGroups();
  resetDailyStats();
  dailyStats.discovered++;
  pushLog('success', 'group', `Discovered group ${jid}${groupName ? ' (' + groupName + ')' : ''}`);
  return true;
}

// ================================================================
// ADMIN DETECTION (unchanged)
// ================================================================
function extractAllPhoneCandidates(msg, senderJid) {
  const phones = new Set();
  const candidates = [
    msg.key?.participantPn, msg.key?.senderPn,
    msg.key?.remoteJidAlt, msg.key?.participantAlt,
    senderJid, msg.key?.remoteJid, msg.key?.participant
  ].filter(Boolean);
  for (const c of candidates) {
    if (typeof c === 'string') {
      const digits = c.split('@')[0].split(':')[0].replace(/\D/g, '');
      if (digits.length >= 10) phones.add(digits);
    }
  }
  return [...phones];
}
function extractLidFromMsg(msg, senderJid) {
  const candidates = [senderJid, msg.key?.remoteJid, msg.key?.participant].filter(Boolean);
  for (const c of candidates) if (typeof c === 'string' && c.includes('@lid')) return c.split('@')[0];
  return null;
}
function isAdminSender(msg, senderJid) {
  const candidates = extractAllPhoneCandidates(msg, senderJid);
  if (candidates.includes(ADMIN_PHONE)) {
    const lid = extractLidFromMsg(msg, senderJid);
    if (lid && !adminLids.has(lid)) { adminLids.add(lid); saveAdminLids(); }
    return true;
  }
  for (const c of candidates) if (adminLids.has(c)) return true;
  const lid = extractLidFromMsg(msg, senderJid);
  if (lid && adminLids.has(lid)) return true;
  if (typeof senderJid === 'string') {
    const bare = senderJid.split('@')[0].split(':')[0];
    if (adminLids.has(bare) || bare === ADMIN_PHONE) return true;
  }
  return false;
}
function extractPhone(msg, senderJid) { const c = extractAllPhoneCandidates(msg, senderJid); return c.length > 0 ? c[0] : null; }
function extractLid(msg, senderJid) { return extractLidFromMsg(msg, senderJid); }

// ================================================================
// INVITE LINK (unchanged)
// ================================================================
function extractAllInviteCodes(text) {
  if (!text) return [];
  const codes = new Set();
  const re = /chat\.whatsapp\.com\/([A-Za-z0-9]{15,30})/gi;
  let m;
  while ((m = re.exec(text)) !== null) codes.add(m[1]);
  return [...codes];
}

// ================================================================
// JOIN QUEUE (unchanged)
// ================================================================
function queueJoin(code, addedBy = 'unknown', source = 'dm') {
  if (!code || joinQueue.some(q => q.code === code)) return false;
  joinQueue.push({ code, addedAt: Date.now(), addedBy, source });
  saveQueue();
  pushLog('info', 'join', `Queued ${code} (by ${addedBy} via ${source})`);
  return true;
}
async function processJoinQueue() {
  if (joinInProgress || !sock || connectionStatus !== 'connected' || joinQueue.length === 0) return;
  if (timeGate.isOffline()) return; // don't join during offline windows
  if (Date.now() - lastJoinAt < JOIN_INTERVAL_MS) return;
  joinInProgress = true;
  const item = joinQueue.shift();
  saveQueue();
  resetDailyStats();
  try {
    pushLog('info', 'join', `Joining ${item.code}...`);
    const res = await scheduler.schedule('groupJoin', () => sock.groupAcceptInvite(item.code));
    lastJoinAt = Date.now();
    if (res) {
      joinedGroups.set(res, { name: null, joinedAt: Date.now(), discovered: false });
      lastGreetingAt.set(res, Date.now());
      saveGroups();
      dailyStats.joined++;
      pushLog('success', 'join', `✅ Joined ${res}`);
    }
  } catch (e) {
    dailyStats.failed++;
    pushLog('error', 'join', `Failed ${item.code}: ${e.message}`);
  } finally { joinInProgress = false; setTimeout(processJoinQueue, JOIN_INTERVAL_MS); }
}

// ================================================================
// REWIND AI (unchanged)
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
  } catch (e) {
    pushLog('error', 'ai', `Rewind failed: ${e.response?.status || ''} ${e.message}`);
    resetDailyStats(); dailyStats.aiErrors++;
    return null;
  }
}

async function testRewindRaw() {
  if (!REWIND_KEY) return { ok: false, error: 'REWIND_KEY missing' };
  const t0 = Date.now();
  try {
    const r = await axios.post('https://api.rewind.ai/v1/chat/completions', {
      model: 'rewind-uncensored',
      messages: [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: 'Reply with exactly: AI WORKS' }]
    }, { headers: { 'Authorization': `Bearer ${REWIND_KEY}`, 'Content-Type': 'application/json' }, timeout: 20000 });
    return { ok: true, ms: Date.now() - t0, status: r.status, raw: r.data?.choices?.[0]?.message?.content, full: r.data };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, status: e.response?.status, error: e.message, body: e.response?.data ? JSON.stringify(e.response.data).slice(0, 500) : null };
  }
}

// ================================================================
// SCRAPER (unchanged)
// ================================================================
async function scraperSearch(query, site = 'darknaija') {
  scraperStats.searchCalls++;
  scraperStats.lastSearchQuery = query;
  scraperStats.lastSearchAt = Date.now();
  resetDailyStats(); dailyStats.scraperSearches++;
  try {
    const r = await axios.post(`${SCRAPER_URL}/search`, { query, site }, { timeout: 30000 });
    scraperStats.searchSuccess++;
    return { ok: true, images: r.data?.images || [] };
  } catch (e) {
    scraperStats.searchFail++;
    return { ok: false, error: e.message, images: [] };
  }
}
async function scraperGif(query) {
  scraperStats.gifCalls++;
  scraperStats.lastGifQuery = query;
  scraperStats.lastGifAt = Date.now();
  resetDailyStats(); dailyStats.scraperGifs++;
  try {
    const r = await axios.get(`${SCRAPER_URL}/gif?q=${encodeURIComponent(query)}`, { timeout: 30000 });
    scraperStats.gifSuccess++;
    return { ok: true, gifs: r.data?.gifs || [] };
  } catch (e) {
    scraperStats.gifFail++;
    return { ok: false, error: e.message, gifs: [] };
  }
}
async function scraperStatus() {
  try { const r = await axios.get(`${SCRAPER_URL}/status`, { timeout: 10000 }); return { ok: true, data: r.data }; }
  catch (e) { return { ok: false, error: e.message }; }
}

// ================================================================
// INTENT DETECTION (unchanged)
// ================================================================
const VAGUE_QUERIES = ['', 'something', 'anything', 'nice', 'good', 'stuff', 'it', 'them', 'some', 'please', 'pls', 'now', 'me', 'one'];

function detectMediaIntent(text) {
  const low = (text || '').toLowerCase().trim();
  if (!low) return null;
  if (/\b(gif|gifs)\b/i.test(low)) {
    let q = low.replace(/^.*?\b(gif|gifs)\b\s*(of|ya|ye|za)?\s*/i, '').trim().replace(/\s+/g, ' ');
    return { type: 'gif', query: q || 'funny' };
  }
  if (/\b(video|videos|vid|vids|vidyo|mavhidhiyo)\b/i.test(low)) {
    let q = low.replace(/^.*?\b(video|videos|vid|vids|vidyo|mavhidhiyo)\b\s*(of|ya|ye|za)?\s*/i, '').trim().replace(/\s+/g, ' ');
    return { type: 'video', query: q || 'funny' };
  }
  const mediaRe = /\b(pic|pics|picture|pictures|image|images|photo|photos|mapic|mapics|mufananidzo|mifananidzo)\b/i;
  if (mediaRe.test(low)) {
    let q = low;
    q = q.replace(/^(please\s+|pls\s+|hey\s+|hi\s+|yo\s+)?(can\s+you\s+)?(send|share|give|show|drop|post|ndipe|ndipoo|nditumire|ndiratidze|ndoda)\s+(me\s+)?(a\s+|some\s+|any\s+)?/i, '');
    q = q.replace(/\b(pic|pics|picture|pictures|image|images|photo|photos|mapic|mapics|mufananidzo|mifananidzo)\b/gi, '');
    q = q.replace(/\b(of|ya|ye|za|for|about|ndiye|wa)\b/gi, '');
    q = q.replace(/[?.!,]+/g, ' ').replace(/\s+/g, ' ').trim();
    return { type: 'image', query: q || 'naija' };
  }
  return null;
}
function isVagueQuery(q) { return !q || VAGUE_QUERIES.includes(q.toLowerCase().trim()); }

// ================================================================
// PENDING (unchanged)
// ================================================================
function createPendingRequest(userJid, userName, userPhone, history, intent) {
  const id = Math.random().toString(36).slice(2, 8);
  pendingRequests.set(id, { id, userJid, userName, userPhone, userHistory: history.slice(-USER_HISTORY_SIZE), requestedAt: Date.now(), intent });
  savePending();
  resetDailyStats(); dailyStats.pendingCreated++;
  return id;
}
async function forwardToAdminForHelp(id, pending) {
  const historyBlock = pending.userHistory.map((h, i) => `${i + 1}. ${h.text}`).join('\n');
  await alertAdmin([
    `❓ *Unclear request*`,
    `👤 ${pending.userName} (${pending.userPhone || 'no phone'})`,
    `💬 Intent: ${pending.intent.type} — query "${pending.intent.query || '(empty)'}"`,
    ``, `*Last ${pending.userHistory.length} messages:*`, historyBlock || '(none)', ``,
    `Reply with:`, `• \`!teach ${id} <search query>\``, `• \`!teach ${id} skip\``, `• \`!teach ${id} say <text>\``
  ].join('\n'));
}
async function resolvePending(id, action, payload, adminChatJid) {
  const p = pendingRequests.get(id);
  if (!p) return { ok: false, error: `No pending request ${id}` };
  const reply = (t) => queuedSend(adminChatJid, { text: t });
  try {
    if (action === 'skip') {
      const casual = await askRewind(`User said: "${p.userHistory.map(h => h.text).join(' / ')}". Reply casually and warmly. No filler. 1 short sentence.`, `You are Abby Faith Sithole, 23, Harare Zimbabwe. Warm, casual WhatsApp tone with light Shona sprinkled in.`);
      await queuedSend(p.userJid, { text: casual || 'Sorry, couldn\'t find that right now 😅' });
      pendingRequests.delete(id); savePending();
      resetDailyStats(); dailyStats.pendingResolved++;
      await reply(`✅ Replied casually to ${p.userName}.`);
      return { ok: true };
    }
    if (action === 'say') {
      await queuedSend(p.userJid, { text: payload });
      pendingRequests.delete(id); savePending();
      resetDailyStats(); dailyStats.pendingResolved++;
      await reply(`✅ Sent your text to ${p.userName}.`);
      return { ok: true };
    }
    const query = payload || p.intent.query;
    await reply(`🔎 Searching "${query}" for ${p.userName}...`);
    if (p.intent.type === 'video' || p.intent.type === 'gif') {
      const r = await scraperGif(query);
      if (!r.ok || r.gifs.length === 0) { await reply(`❌ No results for "${query}".`); return { ok: false }; }
      await queuedSend(p.userJid, { video: { url: r.gifs[0] }, gifPlayback: true });
      resetDailyStats(); dailyStats.picsSent++;
    } else {
      const r = await scraperSearch(query);
      if (!r.ok || r.images.length === 0) { await reply(`❌ No results for "${query}".`); return { ok: false }; }
      await queuedSend(p.userJid, { image: { url: r.images[0] } });
      resetDailyStats(); dailyStats.picsSent++;
    }
    pendingRequests.delete(id); savePending();
    resetDailyStats(); dailyStats.pendingResolved++;
    await reply(`✅ Sent to ${p.userName}.`);
    return { ok: true };
  } catch (e) {
    await reply(`❌ ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// ================================================================
// GREETINGS (unchanged — gated by time window now)
// ================================================================
const GREETING_PHRASES = {
  morning: ['Morning all ☀️', 'Mangwanani guys ☀️', 'Good morning fam', 'Morning 🌅', 'Rise and shine ☀️'],
  midday: ['Hi guys 👋', 'Hey everyone', 'Hello fam 😊', 'Hi all', 'Hey guys, hope you\'re good'],
  evening: ['Good evening fam 🌆', 'Evening all 👋', 'Manheru guys', 'Evening everyone'],
  night: ['Good night all 🌙', 'Manheru akanaka 🌙', 'Sleep well fam', 'Good night everyone 💤', 'Night night 😴']
};
function getTimeOfDay() {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return 'morning';
  if (h >= 12 && h < 17) return 'midday';
  if (h >= 17 && h < 21) return 'evening';
  return 'night';
}
function pickGreeting(p) { const pool = GREETING_PHRASES[p] || GREETING_PHRASES.midday; return pool[Math.floor(Math.random() * pool.length)]; }
function scheduleGreetings() {
  setInterval(async () => {
    if (!sock || connectionStatus !== 'connected' || joinedGroups.size === 0) return;
    if (timeGate.isOffline()) return; // no greetings during offline windows
    const now = Date.now();
    const minMs = GREETING_MIN_HOURS * 3600 * 1000, maxMs = GREETING_MAX_HOURS * 3600 * 1000;
    for (const [jid] of joinedGroups) {
      const sinceLast = now - (lastGreetingAt.get(jid) || 0);
      if (sinceLast < minMs) continue;
      const progress = (sinceLast - minMs) / (maxMs - minMs);
      if (Math.random() > Math.min(progress, 1)) continue;
      const replyText = pickGreeting(getTimeOfDay());
      try {
        await queuedSend(jid, { text: replyText });
        lastGreetingAt.set(jid, now);
        resetDailyStats(); dailyStats.greetingsSent++;
        pushLog('info', 'greeting', `Queued greeting for ${jid}: ${replyText}`);
      } catch (e) { pushLog('warn', 'greeting', `Failed ${jid}: ${e.message}`); }
    }
    saveGroups();
  }, 15 * 60 * 1000);
}

// ================================================================
// DAILY REPORT (unchanged)
// ================================================================
function scheduleDailyReport() {
  setInterval(async () => {
    if (!sock || connectionStatus !== 'connected') return;
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    if (now.getHours() !== DAILY_REPORT_HOUR || lastDailyReportDate === today) return;
    lastDailyReportDate = today; resetDailyStats();
    const s = dailyStats || {};
    const summary = [
      `📊 *Daily Summary — ${today}*`, ``,
      `👥 Groups: *${joinedGroups.size}*`,
      `💬 DMs: *${activeDMs.size}*`,
      `📋 Queue: *${joinQueue.length}*`,
      `⏳ Pending: *${pendingRequests.size}*`, ``,
      `✅ Joined: *${s.joined || 0}*`,
      `🔍 Discovered: *${s.discovered || 0}*`,
      `❌ Failed: *${s.failed || 0}*`,
      `💌 DM replies: *${s.dmsReplied || 0}*`,
      `🖼️ Pics/Videos: *${(s.picsSent || 0) + (s.videosSent || 0)}*`,
      `📢 Broadcasts: *${s.broadcastsSent || 0}*`,
      `📸 Image broadcasts: *${s.imageBroadcasts || 0}*`,
      `👋 Greetings: *${s.greetingsSent || 0}*`,
      `🤖 AI errors: *${s.aiErrors || 0}*`,
      `💥 Bad MACs: *${s.badMacs || 0}*`,
      `🎯 Focus runs: *${s.focusRuns || 0}*`, ``,
      `Uptime: ${Math.floor((Date.now() - botStartTime) / 3600000)}h`
    ].join('\n');
    await alertAdmin(summary);
  }, 60 * 1000);
}

// ================================================================
// BROADCAST (unchanged — but serialized)
// ================================================================
async function broadcast({ message, imageUrl = null, gifUrl = null, imageBuffer = null, mode = 'all' }) {
  const targets = [];
  if (mode === 'all' || mode === 'groups') for (const jid of joinedGroups.keys()) targets.push({ jid, type: 'group' });
  if (mode === 'all' || mode === 'dms') for (const jid of activeDMs) targets.push({ jid, type: 'dm' });
  const results = { sent: 0, failed: 0, total: targets.length, errors: [], mode };
  pushLog('info', 'broadcast', `Broadcasting to ${targets.length} (${mode}) via serial queue`);
  for (const t of targets) {
    try {
      let content;
      if (gifUrl) content = { video: { url: gifUrl }, gifPlayback: true, caption: message || '' };
      else if (imageBuffer) content = { image: imageBuffer, caption: message || '' };
      else if (imageUrl) content = { image: { url: imageUrl }, caption: message || '' };
      else content = { text: message };
      await queuedSend(t.jid, content);
      results.sent++;
      resetDailyStats(); dailyStats.broadcastsSent++;
    } catch (e) { results.failed++; results.errors.push({ jid: t.jid, error: e.message }); }
  }
  pushLog('success', 'broadcast', `Done: ${results.sent}/${results.total}`);
  return results;
}

// ================================================================
// AD BUILDER (unchanged)
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
// COMMAND LIST (unchanged)
// ================================================================
const COMMAND_LIST = `🥖 *BreadBot v44*

*Behavior*
Serial processing · Fibonacci timing · Focus pipeline
Time windows: sleep 22-06, lunch 12-13, dinner 18-19

*Image broadcast* (send an image with a caption)
• Image + caption \`!bcdm Buy this product\` → DMs
• Image + caption \`!bcgroup Check this\` → Groups
• Image + caption \`!all Offer inside\` → Everyone

*Text broadcast*
!bcdm <msg> · !bcgroup <msg> · !all <msg>
!allimg <url> | <caption>

*Test*
!whoami · !aitest · !scraperstatus
!scrapersearch <q> · !scrapergif <q> · !test · !testall · !sched

*Pending*
!pending · !teach <id> <query> · !teach <id> say <text> · !teach <id> skip

*Group joins*
!join <link> · !joinall <links...> · !queue · !clearsqueue · !groups · !leave <jid>

*Scraper preview*
!pic <q> · !nextpic · !gif <q> · !nextgif
!bcastpic <caption> · !bcastpicdm · !bcastpicgroup · !bcastgif <caption>

*Other*
!ad <title> | <body> | [cta] | [link] | [style] · !bcad
!stats · !ping · !summary · !scraperstats`;

// ================================================================
// QUEUED SEND (goes through scheduler + focus)
// ================================================================
function queuedSend(jid, content, options = {}) {
  return scheduler.schedule(`send:${jid}`, async () => {
    if (!sock) throw new Error('Bot disconnected');
    const sent = await sock.sendMessage(jid, content, options);
    if (sent?.key?.id) botSentIds.add(sent.key.id);
    if (botSentIds.size > 2000) {
      const arr = [...botSentIds]; botSentIds.clear();
      for (const i of arr.slice(-1000)) botSentIds.add(i);
    }
    return sent;
  });
}

const botSentIds = new Set();

// ================================================================
// CONNECTION (unchanged from v43.2)
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
          groupOpGuard: { limits: { add: { max: 3, windowMs: 600_000 }, create: { max: 2, windowMs: 600_000 } } },
          legitimacySignals: { typoProbability: 0.02 },
          jidCanonicalizer: { enabled: true, canonical: 'pn' }
        });
        pushLog('success', 'antiban', 'Socket wrapped with baileys-antiban');
      } catch (e) {
        pushLog('warn', 'antiban', `wrapSocket failed: ${e.message}`);
        sock = baseSocket;
      }
    } else {
      sock = baseSocket;
      pushLog('warn', 'antiban', 'baileys-antiban not available');
    }

    if (SessionHealthMonitor) {
      try {
        healthMonitor = new SessionHealthMonitor({
          badMacThreshold: 3, badMacWindowMs: 60_000,
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
      if (qr) {
        qrDataUri = await QRCode.toDataURL(qr);
        connectionStatus = 'qr';
        pushLog('info', 'bot', 'QR generated — scan now');
      }
      if (connection === 'open') {
        isConnecting = false;
        connectionStatus = 'connected';
        reconnectAttempts = 0;
        botStartTime = Date.now();
        botJid = sock.user?.id || null;
        botNumber = botJid?.split(':')[0]?.split('@')[0] || 'unknown';
        pushLog('success', 'bot', `✅ Connected as ${botNumber}`);
        pushLog('info', 'time', `Time window: ${timeGate.describe()}`);
        if (createHumanEntropyService) {
          try {
            entropyService = createHumanEntropyService(sock, botJid, { enabled: true, minIntervalMs: 2 * 60 * 60 * 1000, maxIntervalMs: 6 * 60 * 60 * 1000 });
            entropyService.start();
            pushLog('success', 'entropy', 'Entropy service started');
          } catch (e) { pushLog('warn', 'entropy', `Entropy failed: ${e.message}`); }
        }
        try { await sock.sendPresenceUpdate('available'); } catch (e) {}
        await alertAdmin(`✅ *BreadBot ONLINE*\n📱 ${botNumber}\nWindow: ${timeGate.window()}\n\nSend !commands`);
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
        } else {
          connectionStatus = 'disconnected';
          pushLog('error', 'bot', 'Max retries — click Reconnect');
        }
      }
    });

    sock.ev.on('creds.update', saveCreds);
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
// MESSAGE HANDLER — routes through FocusPipeline
// ================================================================
async function handleMessage(msg) {
  if (!sock) return;
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

  if (isGroup) discoverGroup(chatJid, null);
  else activeDMs.add(chatJid);

  pushLiveMessage({
    id: msgId, ts: new Date().toISOString(), chatJid, chatType, senderJid,
    senderName: pushName, phone: phone || '—', lid: lid || '—',
    text: text.slice(0, 200) || `[${mediaType}]`, mediaType
  });

  const isAdmin = isAdminSender(msg, senderJid);

  // ── ADMIN IMAGE BROADCAST (goes straight through, no focus pipeline — admin is you) ──
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
        await queuedSend(chatJid, { text: `📸 Queued broadcast to ${count} ${mode}.\nCaption: "${caption || '(none)'}"\nSerial mode · Fibonacci gaps` });
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

  // ── ADMIN COMMANDS (immediate, no focus delay — you want fast control) ──
  if (!isGroup && isAdmin && text.startsWith('!')) {
    pushLog('info', 'admin', `Admin cmd: ${text.split(' ')[0]} (phone ${phone || '—'} lid ${lid || '—'})`);
    await handleAdminCommand(text, chatJid, msg);
    return;
  }

  // ── GROUP MESSAGES: batch, don't reply instantly ──
  if (isGroup) {
    groupBatcher.enqueue(chatJid, { msg, text, ts: Date.now() });
    return;
  }

  // ── ADMIN DM WITHOUT COMMAND: ignore ──
  if (isAdmin) {
    pushLog('info', 'admin', `Admin DM ignored (no command): "${text.slice(0, 60)}"`);
    return;
  }

  // ── NON-ADMIN DM: gate by time window ──
  if (timeGate.isOffline()) {
    pushLog('info', 'time', `DM from ${pushName} queued — offline window`);
    // Still log to history; will be processed when window opens
    setTimeout(() => handleMessage(msg).catch(() => {}), 5 * 60 * 1000); // retry in 5 min
    return;
  }

  // ── RUN THROUGH FOCUS PIPELINE (serial — one at a time) ──
  try {
    await focus.run(chatJid, async () => {
      if (containsForbidden(text)) {
        pushLog('info', 'filter', `Ignored (forbidden): ${pushName}`);
        return;
      }
      const lang = detectLanguage(text);
      const langName = LANG_NAMES[lang] || 'English';

      const intent = detectMediaIntent(text);
      if (intent) {
        pushLog('info', 'pic', `Intent ${intent.type} — "${intent.query}" from ${pushName}`);
        const vague = isVagueQuery(intent.query);
        if (!vague) {
          if (intent.type === 'video' || intent.type === 'gif') {
            const r = await scraperGif(intent.query);
            if (r.ok && r.gifs.length > 0) {
              try { await queuedSend(chatJid, { video: { url: r.gifs[0] }, gifPlayback: true }, { quoted: msg }); }
              catch (e) { await queuedSend(chatJid, { text: r.gifs[0] }, { quoted: msg }); }
              resetDailyStats();
              if (intent.type === 'video') dailyStats.videosSent++; else dailyStats.picsSent++;
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
        const ack = await askRewind(`User asked for something. Reply in one short casual WhatsApp sentence (max 8 words). No filler.`, `You are Abby Faith Sithole, 23, Harare Zimbabwe. Casual WhatsApp. Reply in ${langName}.`);
        const finalAck = (ack && !containsForbidden(ack)) ? informalize(ack) : 'checking rn 😊';
        try { await queuedSend(chatJid, { text: finalAck }, { quoted: msg }); } catch (e) {}
        await forwardToAdminForHelp(id, pendingRequests.get(id));
        return;
      }

      const systemPrompt = `You are Abby Faith Sithole, a 23-year-old girl from Harare, Zimbabwe. You are a REAL person, not an AI, not an assistant, not a bot. Roleplay her naturally.

RULES:
- Reply in ${langName}. Mix in light Shona sometimes ("mhoro", "sei uri", "sharp", "eish", "hezvoka", "zvakanaka", "uri bho", "zvinei", "ndizvo").
- Keep replies SHORT: 1-2 sentences max. Like real WhatsApp texting.
- Be casual, playful, warm. React naturally to what they say.
- NEVER say you're an AI, assistant, bot, or language model.
- NEVER ask "how can I help you" or offer assistance.
- NEVER use filler phrases like "I understand", "based on your message", "I hope this helps".
- No technical terms, no code, no URLs, no formal language.`;

      const aiReply = await askRewind(text, systemPrompt);
      if (!aiReply) { pushLog('warn', 'ai', `No reply for ${pushName}`); return; }
      if (containsForbidden(aiReply)) { pushLog('warn', 'ai', `Dropped (forbidden)`); return; }
      const final = informalize(humanize(aiReply));
      if (!final) { pushLog('warn', 'ai', 'Empty after humanize'); return; }
      await queuedSend(chatJid, { text: final }, { quoted: msg });
      resetDailyStats(); dailyStats.dmsReplied++; dailyStats.focusRuns++;
      pushLog('info', 'ai', `DM reply to ${pushName}: ${final.slice(0, 50)}`);
    });
  } catch (e) {
    pushLog('error', 'focus', `Focus pipeline failed: ${e.message}`);
  }
}

// ================================================================
// GROUP BATCH PROCESSOR — runs on interval, catches up on groups
// ================================================================
function scheduleGroupBatchProcessor() {
  setInterval(async () => {
    if (!sock || connectionStatus !== 'connected') return;
    if (timeGate.isOffline()) return;
    for (const [jid, items] of groupBatcher.pending) {
      const drained = groupBatcher.drain(jid);
      if (!drained || drained.length === 0) continue;
      pushLog('info', 'group', `Batch processing ${drained.length} messages from ${jid}`);
      // Note: we don't reply to group messages by default — just record them.
      // This matches human behavior (read but don't respond to everything).
      // Greetings are handled separately by scheduleGreetings().
      resetDailyStats();
    }
  }, 10 * 60 * 1000); // check every 10 min
}

// ================================================================
// ADMIN COMMANDS (unchanged from v43.2)
// ================================================================
async function handleAdminCommand(text, chatJid, msg) {
  const args = text.slice(1).trim().split(/\s+/);
  const cmd = args[0].toLowerCase();
  const reply = (t) => queuedSend(chatJid, { text: t }, { quoted: msg });

  switch (cmd) {
    case 'commands': case 'help': await reply(COMMAND_LIST); break;
    case 'ping': await reply(`🏓 Pong!\nStatus: *${connectionStatus}*\nUptime: *${Math.floor((Date.now()-botStartTime)/1000)}s*`); break;
    case 'sched': {
      const st = scheduler.stats();
      const fo = focus.stats();
      const gb = groupBatcher.stats();
      await reply(`⚙️ *Scheduler (Serial)*\n\nQueued: *${st.queued}*\nRunning: *${st.running}*\nCurrent: *${st.currentTask || 'idle'}*\nTotal: *${st.totalRun}* run / *${st.totalFailed}* failed\nNext gap: *${Math.round(st.nextGapMs/1000)}s*\n\n🎯 *Focus pipeline*\nBusy: *${fo.busy}*\nState: *${fo.currentState}*\nJID: *${fo.currentJid || '—'}*\n\n⏰ *Time window*\n${timeGate.describe()}\n\n📦 *Group batcher*\nPending groups: *${gb.groupsWithPending}*\nTotal pending msgs: *${gb.totalPending}*\nBatch interval: *${gb.minBatchMin}-${gb.maxBatchMin} min*`);
      break;
    }
    case 'test': await reply(`✅ *Test*\nBot: *${botNumber}*\nStatus: *${connectionStatus}*\nAdmin: *${ADMIN_PHONE}*\nWindow: *${timeGate.window()}*\nGroups: *${joinedGroups.size}*\nDMs: *${activeDMs.size}*\nSched queued: *${scheduler.queue.length}*\nFocus: *${focus.currentState}*`); break;
    case 'whoami': {
      const c = extractAllPhoneCandidates(msg, chatJid);
      const lid = extractLid(msg, chatJid);
      const isAdm = isAdminSender(msg, chatJid);
      await reply(`🔍 *Diagnostics*\n\nJID: *${msg.key.participant || msg.key.remoteJid}*\nLID: *${lid || '—'}*\nCandidates: *${c.join(', ') || 'none'}*\nExpected: *${ADMIN_PHONE}*\nIs admin: *${isAdm ? 'YES ✅' : 'NO ❌'}*\nLIDs: *${[...adminLids].join(', ') || 'none'}*`);
      break;
    }
    case 'aitest': {
      await reply('🧪 Testing Rewind AI...');
      const r = await testRewindRaw();
      if (r.ok) await reply(`✅ *AI WORKS*\n\nStatus: *${r.status}*\nTime: *${r.ms}ms*\nRaw: *${r.raw || '(empty)'}*`);
      else await reply(`❌ *AI FAILED*\n\nStatus: *${r.status || 'none'}*\nError: *${r.error}*`);
      break;
    }
    case 'scraperstatus': {
      await reply('🔎 Testing scraper...');
      const st = await scraperStatus();
      if (st.ok) await reply(`✅ *Scraper WORKS*\n\nStatus: *${st.data.status || 'ok'}*\nUptime: *${Math.floor(st.data.uptime || 0)}s*`);
      else await reply(`❌ *Scraper FAILED*\n\nError: *${st.error}*`);
      break;
    }
    case 'scrapersearch': {
      const q = args.slice(1).join(' ');
      if (!q) { await reply('❌ Usage: `!scrapersearch <query>`'); return; }
      const r = await scraperSearch(q);
      if (!r.ok) { await reply(`❌ Failed: ${r.error}`); return; }
      await reply(`✅ Found *${r.images.length}* images\nFirst: ${r.images[0] || 'none'}`);
      break;
    }
    case 'scrapergif': {
      const q = args.slice(1).join(' ');
      if (!q) { await reply('❌ Usage: `!scrapergif <query>`'); return; }
      const r = await scraperGif(q);
      if (!r.ok) { await reply(`❌ Failed: ${r.error}`); return; }
      await reply(`✅ Found *${r.gifs.length}* GIFs\nFirst: ${r.gifs[0] || 'none'}`);
      break;
    }
    case 'testall': { await reply('🧪 Testing...'); const r = await runFullTestSuite(); await reply(r); break; }
    case 'stats': {
      const s = (resetDailyStats(), dailyStats);
      await reply(`📊 *Stats*\n\n*Now*\nDMs: *${activeDMs.size}*\nGroups: *${joinedGroups.size}*\nQueue: *${joinQueue.length}*\nPending: *${pendingRequests.size}*\nSched queued: *${scheduler.queue.length}*\nFocus: *${focus.currentState}*\nWindow: *${timeGate.window()}*\nUptime: *${Math.floor((Date.now()-botStartTime)/1000)}s*\n\n*Today*\nJoined: *${s.joined}* / Discovered: *${s.discovered}*\nDM replies: *${s.dmsReplied}*\nFocus runs: *${s.focusRuns}*\nPics: *${s.picsSent}* / Videos: *${s.videosSent}*\nBroadcasts: *${s.broadcastsSent}*\nImage: *${s.imageBroadcasts}*\nGreetings: *${s.greetingsSent}*\nAI errors: *${s.aiErrors}*\nBad MACs: *${s.badMacs}*`);
      break;
    }
    case 'scraperstats': await reply(`🔎 *Scraper Stats*\n\nSearches: *${scraperStats.searchSuccess}* ok / *${scraperStats.searchFail}* fail\nGIFs: *${scraperStats.gifSuccess}* ok / *${scraperStats.gifFail}* fail`); break;

    case 'pending': {
      if (pendingRequests.size === 0) { await reply('📭 No pending requests.'); return; }
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

    case 'join': case 'joinall': {
      const codes = extractAllInviteCodes(args.slice(1).join(' '));
      if (codes.length === 0) { await reply('❌ No valid link.'); return; }
      let added = 0;
      for (const c of codes) if (queueJoin(c, 'admin', 'cmd')) added++;
      await reply(`✅ Queued ${added}/${codes.length}. Queue: ${joinQueue.length}.`);
      processJoinQueue();
      break;
    }
    case 'queue': {
      if (joinQueue.length === 0) { await reply('📭 Queue empty.'); return; }
      const list = joinQueue.slice(0, 20).map((q, i) => `${i + 1}. ${q.code} (${q.addedBy})`).join('\n');
      await reply(`📋 *Queue (${joinQueue.length})*\n${list}`);
      break;
    }
    case 'clearsqueue': { const n = joinQueue.length; joinQueue = []; saveQueue(); await reply(`🧹 Cleared ${n}.`); break; }
    case 'groups': {
      if (joinedGroups.size === 0) { await reply('📭 No groups.'); return; }
      const list = [...joinedGroups.entries()].slice(0, 30).map(([jid, v], i) => `${i + 1}. ${jid}${v.discovered ? ' (discovered)' : ''}`).join('\n');
      await reply(`👥 *Groups (${joinedGroups.size})*\n${list}`);
      break;
    }
    case 'leave': {
      const jid = args[1];
      if (!jid || !jid.endsWith('@g.us')) { await reply('❌ Usage: `!leave <jid@g.us>`'); return; }
      try { await scheduler.schedule('groupLeave', () => sock.groupLeave(jid)); joinedGroups.delete(jid); saveGroups(); await reply(`✅ Left ${jid}`); }
      catch (e) { await reply(`❌ ${e.message}`); }
      break;
    }

    case 'pic': case 'search': {
      const q = args.slice(1).join(' ');
      if (!q) { await reply('❌ Usage: `!pic <query>`'); return; }
      await reply(`🔎 Searching for *${q}*...`);
      const r = await scraperSearch(q);
      if (!r.ok || r.images.length === 0) { await reply(`❌ No results`); return; }
      previewCache.imageUrls = r.images; previewCache.imageIndex = 0;
      previewCache.currentType = 'image'; previewCache.currentUrl = r.images[0];
      try { await queuedSend(chatJid, { image: { url: r.images[0] }, caption: `Preview 1/${r.images.length}\n!nextpic · !bcastpic <caption>` }); }
      catch (e) { await reply(`❌ ${e.message}`); }
      break;
    }
    case 'nextpic': {
      if (previewCache.imageUrls.length === 0) { await reply('❌ No preview.'); return; }
      previewCache.imageIndex = (previewCache.imageIndex + 1) % previewCache.imageUrls.length;
      previewCache.currentUrl = previewCache.imageUrls[previewCache.imageIndex];
      try { await queuedSend(chatJid, { image: { url: previewCache.currentUrl }, caption: `Preview ${previewCache.imageIndex + 1}/${previewCache.imageUrls.length}` }); }
      catch (e) { await reply(`❌ ${e.message}`); }
      break;
    }
    case 'gif': {
      const q = args.slice(1).join(' ');
      if (!q) { await reply('❌ Usage: `!gif <query>`'); return; }
      await reply(`🔎 Searching GIFs for *${q}*...`);
      const r = await scraperGif(q);
      if (!r.ok || r.gifs.length === 0) { await reply(`❌ No results`); return; }
      previewCache.gifUrls = r.gifs; previewCache.gifIndex = 0;
      previewCache.currentType = 'gif'; previewCache.currentUrl = r.gifs[0];
      try { await queuedSend(chatJid, { video: { url: r.gifs[0] }, gifPlayback: true, caption: `GIF 1/${r.gifs.length}\n!nextgif · !bcastgif <caption>` }); }
      catch (e) { await reply(`❌ ${e.message}`); }
      break;
    }
    case 'nextgif': {
      if (previewCache.gifUrls.length === 0) { await reply('❌ No preview.'); return; }
      previewCache.gifIndex = (previewCache.gifIndex + 1) % previewCache.gifUrls.length;
      previewCache.currentUrl = previewCache.gifUrls[previewCache.gifIndex];
      try { await queuedSend(chatJid, { video: { url: previewCache.currentUrl }, gifPlayback: true, caption: `GIF ${previewCache.gifIndex + 1}/${previewCache.gifUrls.length}` }); }
      catch (e) { await reply(`❌ ${e.message}`); }
      break;
    }

    case 'all': case 'bcgroup': case 'bcdm': {
      const message = args.slice(1).join(' ');
      if (!message) { await reply(`❌ Usage: \`!${cmd} <message>\`\n\n_Or send an image with \`!${cmd} <caption>\`_`); return; }
      const mode = cmd === 'all' ? 'all' : (cmd === 'bcgroup' ? 'groups' : 'dms');
      const count = mode === 'all' ? (joinedGroups.size + activeDMs.size) : mode === 'groups' ? joinedGroups.size : activeDMs.size;
      if (count === 0) { await reply(`📭 No ${mode} targets.`); return; }
      await reply(`⏳ Queued broadcast to ${count} (${mode}) — serial · Fibonacci gaps`);
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
      await reply(`📊 *Today (${s.date})*\nJoined: *${s.joined}*\nDiscovered: *${s.discovered}*\nDM replies: *${s.dmsReplied}*\nFocus runs: *${s.focusRuns}*\nPics: *${s.picsSent}*\nVideos: *${s.videosSent}*\nBroadcasts: *${s.broadcastsSent}*\nImage: *${s.imageBroadcasts}*\nGreetings: *${s.greetingsSent}*\nAI errors: *${s.aiErrors}*`);
      break;
    }
    default: await reply(`❓ Unknown: *!${cmd}*`);
  }
}

async function runFullTestSuite() {
  const t0 = Date.now();
  const tests = [];
  const s1 = await scraperSearch('test');
  tests.push(`Scraper /search: ${s1.ok ? `✅ ${s1.images.length}` : '❌ ' + s1.error}`);
  const s2 = await scraperGif('funny');
  tests.push(`Scraper /gif: ${s2.ok ? `✅ ${s2.gifs.length}` : '❌ ' + s2.error}`);
  const rw = await testRewindRaw();
  tests.push(`Rewind AI: ${rw.ok ? `✅ ${rw.ms}ms` : `❌ ${rw.status || ''} ${rw.error}`}`);
  const st = await scraperStatus();
  tests.push(`Scraper /status: ${st.ok ? '✅' : '❌ ' + st.error}`);
  return ['🧪 *Test Suite*', '', ...tests, '',
    `🔌 WhatsApp: ${connectionStatus === 'connected' ? '✅' : `❌ ${connectionStatus}`}`,
    `📱 Bot: ${botNumber || '—'}`,
    `👥 Groups: ${joinedGroups.size}`,
    `💬 DMs: ${activeDMs.size}`,
    `🎯 Focus: ${focus.currentState}`,
    `⚙️ Sched: ${scheduler.queue.length}q`,
    `⏰ Window: ${timeGate.window()}`,
    `🕒 ${Date.now() - t0}ms`].join('\n');
}

// ================================================================
// EXPRESS + GUI
// ================================================================
const app = express();
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now(), status: connectionStatus, uptime: Math.floor((Date.now()-botStartTime)/1000), sched: scheduler.stats(), focus: focus.stats(), window: timeGate.window() }));
app.get('/api/status', (req, res) => res.json({ status: connectionStatus, botNumber, groups: joinedGroups.size, dms: activeDMs.size, queue: joinQueue.length, pending: pendingRequests.size, sched: scheduler.stats() }));
app.get('/admin/qr', async (req, res) => {
  if (!qrDataUri) return res.status(404).json({ error: 'No QR' });
  const b64 = qrDataUri.replace(/^data:image\/\w+;base64,/, '');
  res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(Buffer.from(b64, 'base64'));
});
app.get('/admin/qr-data', (req, res) => res.json({ qr: qrDataUri, status: connectionStatus, botNumber }));
app.post('/admin/connect', (req, res) => { if (!sock) connectBot(); res.json({ ok: true }); });
app.post('/admin/reconnect', async (req, res) => { await disconnectBot(); setTimeout(() => { manualDisconnect = false; connectBot(); }, 1500); res.json({ ok: true }); });
app.post('/admin/disconnect', async (req, res) => { await disconnectBot(); res.json({ ok: true }); });
app.post('/admin/refresh-qr', (req, res) => { refreshQR(); res.json({ ok: true }); });
app.post('/admin/clear-session', (req, res) => {
  try { fs.rmSync(AUTH_FOLDER, { recursive: true, force: true }); } catch (e) {}
  res.json({ ok: true, msg: 'Session cleared.' });
});
app.get('/admin/logs', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  for (const e of logBuffer.slice(-100)) res.write(`data: ${JSON.stringify(e)}\n\n`);
  logClients.add(res); req.on('close', () => logClients.delete(res));
});
app.get('/admin/messages-stream', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  for (const m of liveMessages.slice(-100)) res.write(`data: ${JSON.stringify(m)}\n\n`);
  msgClients.add(res); req.on('close', () => msgClients.delete(res));
});
app.get('/admin/aitest', async (req, res) => { const r = await testRewindRaw(); res.json(r); });
app.get('/admin/scraperstatus', async (req, res) => { const r = await scraperStatus(); res.json(r); });
app.get('/admin/sched', (req, res) => res.json({ scheduler: scheduler.stats(), focus: focus.stats(), window: timeGate.window(), groupBatcher: groupBatcher.stats() }));
app.get('/admin/pending', (req, res) => res.json({ pending: [...pendingRequests.values()] }));
app.post('/admin/pending/:id/resolve', async (req, res) => {
  const { id } = req.params;
  const { action, payload } = req.body || {};
  const r = await resolvePending(id, action || 'search', payload, ADMIN_JID);
  res.json(r);
});
app.get('/admin/stats', (req, res) => {
  const grp = [...activeChats].filter(j => j.endsWith('@g.us')).length;
  res.json({
    status: connectionStatus, botNumber,
    uptime: Math.floor((Date.now()-botStartTime)/1000),
    dmCount: activeDMs.size, groupCount: grp, totalChats: activeChats.size,
    logCount: logBuffer.length, messageCount: liveMessages.length,
    scraperUrl: SCRAPER_URL,
    joinedGroups: joinedGroups.size, queueSize: joinQueue.length,
    lastJoinAt: lastJoinAt || null,
    dailyStats, scraperStats,
    adminPhone: ADMIN_PHONE, adminLids: [...adminLids],
    pendingCount: pendingRequests.size,
    pendingList: [...pendingRequests.values()].map(p => ({ id: p.id, userName: p.userName, userPhone: p.userPhone, type: p.intent.type, query: p.intent.query })),
    sched: scheduler.stats(),
    focus: focus.stats(),
    window: timeGate.window(),
    windowDescription: timeGate.describe(),
    groupBatcher: groupBatcher.stats(),
    antibanActive: !!wrapSocket,
    entropyRunning: !!entropyService,
    fibonacciIndex: fib.idx
  });
});

const PANEL_HTML = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BreadBot v44</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:monospace;background:#0d1117;color:#c9d1d9;padding:16px}h1{font-size:20px;color:#58a6ff;margin-bottom:4px}.sub{font-size:12px;color:#8b949e;margin-bottom:16px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px}.card h2{font-size:12px;color:#8b949e;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px}button{background:#21262d;border:1px solid #30363d;color:#c9d1d9;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:13px;margin:3px;font-family:inherit}button:hover{background:#30363d;border-color:#58a6ff}button.primary{background:#238636;border-color:#2ea043;color:#fff}button.danger{background:#da3633;border-color:#f85149;color:#fff}#qrImg{width:100%;max-width:240px;border-radius:8px;margin:8px auto;display:block;background:#fff;padding:8px}.status-dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;vertical-align:middle}.s-connected{background:#3fb950;box-shadow:0 0 8px #3fb950}.s-qr{background:#d29922}.s-disconnected{background:#f85149}.s-reconnecting{background:#d29922;animation:pulse 1s infinite}.s-error{background:#f85149}@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}#logs,#msgs{height:280px;overflow-y:auto;font-size:12px;line-height:1.6;background:#0d1117;border-radius:6px;padding:8px}.log-entry{padding:3px 0;border-bottom:1px solid #21262d}.log-time{color:#484f58;margin-right:8px}.log-info{color:#58a6ff}.log-success{color:#3fb950}.log-warn{color:#d29922}.log-error{color:#f85149}.log-source{color:#8b949e;margin-right:6px}.stat-row{display:flex;justify-content:space-between;padding:5px 0;font-size:13px;border-bottom:1px solid #21262d}.stat-row:last-child{border-bottom:none}.stat-val{color:#58a6ff;font-weight:600}.msg-row{padding:6px 8px;margin:4px 0;border-radius:6px;background:#161b22;border-left:3px solid #58a6ff;font-size:12px}.msg-row.group{border-left-color:#a371f7}.msg-row.dm{border-left-color:#3fb950}.msg-meta{color:#8b949e;font-size:11px;margin-bottom:2px}.msg-name{color:#58a6ff;font-weight:600}.msg-text{color:#c9d1d9;word-break:break-word}.tag{display:inline-block;padding:1px 6px;border-radius:3px;font-size:10px;margin-left:6px;font-weight:600}.tag-group{background:#a371f7;color:#fff}.tag-dm{background:#3fb950;color:#000}.full-width{grid-column:1/-1}</style></head><body>
<h1>🥖 BreadBot v44 — Human Behavior Edition</h1><div class="sub">Admin: <b id="adminPhone">—</b> · Window: <b id="windowState">—</b> · Focus: <b id="focusState">—</b> · Fib idx: <b id="fibIdx">—</b></div>
<div class="grid">
<div class="card"><h2>Connection</h2><div style="margin-bottom:10px"><span class="status-dot" id="statusDot"></span><span id="statusText">Loading...</span></div><div class="stat-row"><span>Bot</span><span class="stat-val" id="botNum">—</span></div><div class="stat-row"><span>Uptime</span><span class="stat-val" id="statUptime">—</span></div><img id="qrImg" src="" style="display:none"><div style="margin-top:10px"><button class="primary" onclick="doAction('connect')">🔗 Start</button><button onclick="doAction('reconnect')">🔄 Reconnect</button><button onclick="doAction('refresh-qr')">♻️ Refresh QR</button><button class="danger" onclick="doAction('disconnect')">⛔ Disconnect</button><button onclick="doAction('clear-session')">🗑️ Clear Session</button><button onclick="testAI()">🧪 Test AI</button><button onclick="testScraper()">🔎 Test Scraper</button></div><pre id="testResult" style="margin-top:8px;font-size:11px;color:#8b949e;white-space:pre-wrap;max-height:180px;overflow:auto"></pre></div>
<div class="card"><h2>🎯 Focus Pipeline</h2><div class="stat-row"><span>Busy</span><span class="stat-val" id="focusBusy">—</span></div><div class="stat-row"><span>State</span><span class="stat-val" id="focusCurState">—</span></div><div class="stat-row"><span>Current JID</span><span class="stat-val" id="focusJid">—</span></div></div>
<div class="card"><h2>⏰ Time Window</h2><div class="stat-row"><span>Window</span><span class="stat-val" id="windowName">—</span></div><div class="stat-row"><span>Description</span><span class="stat-val" id="windowDesc">—</span></div></div>
<div class="card"><h2>⚙️ Serial Scheduler</h2><div class="stat-row"><span>Queued</span><span class="stat-val" id="schedQueued">—</span></div><div class="stat-row"><span>Running</span><span class="stat-val" id="schedRunning">—</span></div><div class="stat-row"><span>Current task</span><span class="stat-val" id="schedTask">—</span></div><div class="stat-row"><span>Total run</span><span class="stat-val" id="schedTotalRun">—</span></div><div class="stat-row"><span>Total failed</span><span class="stat-val" id="schedTotalFailed">—</span></div><div class="stat-row"><span>Next Fibonacci gap</span><span class="stat-val" id="schedGap">—</span></div></div>
<div class="card"><h2>📦 Group Batcher</h2><div class="stat-row"><span>Groups with pending</span><span class="stat-val" id="gbGroups">—</span></div><div class="stat-row"><span>Total pending msgs</span><span class="stat-val" id="gbTotal">—</span></div><div class="stat-row"><span>Batch interval</span><span class="stat-val" id="gbInterval">—</span></div></div>
<div class="card"><h2>Groups & Queue</h2><div class="stat-row"><span>Joined</span><span class="stat-val" id="statGroups">—</span></div><div class="stat-row"><span>DM chats</span><span class="stat-val" id="statDMs">—</span></div><div class="stat-row"><span>Join queue</span><span class="stat-val" id="statQueue">—</span></div><div class="stat-row"><span>Pending</span><span class="stat-val" id="statPending">—</span></div></div>
<div class="card"><h2>Today</h2><div class="stat-row"><span>DM replies</span><span class="stat-val" id="dayDMs">—</span></div><div class="stat-row"><span>Focus runs</span><span class="stat-val" id="dayFocus">—</span></div><div class="stat-row"><span>Pics / Videos</span><span class="stat-val" id="dayPics">—</span></div><div class="stat-row"><span>Broadcasts</span><span class="stat-val" id="dayBC">—</span></div><div class="stat-row"><span>Greetings</span><span class="stat-val" id="dayGreet">—</span></div><div class="stat-row"><span>AI errors</span><span class="stat-val" id="dayAiErr">—</span></div></div>
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
async function refreshStats(){try{const d=await api('stats');setStatus(d.status);$('statUptime').textContent=fmt(d.uptime);$('botNum').textContent=d.botNumber||'—';$('statGroups').textContent=d.joinedGroups;$('statDMs').textContent=d.dmCount;$('statQueue').textContent=d.queueSize;$('statPending').textContent=d.pendingCount||0;$('adminPhone').textContent=d.adminPhone||'—';
$('windowState').textContent=d.window||'—';$('windowName').textContent=d.window||'—';$('windowDesc').textContent=d.windowDescription||'—';$('fibIdx').textContent=d.fibonacciIndex||0;
const f=d.focus||{};$('focusState').textContent=f.currentState||'idle';$('focusBusy').textContent=f.busy?'YES':'no';$('focusCurState').textContent=f.currentState||'idle';$('focusJid').textContent=f.currentJid||'—';
const sc=d.sched||{};$('schedQueued').textContent=sc.queued||0;$('schedRunning').textContent=sc.running||0;$('schedTask').textContent=sc.currentTask||'idle';$('schedTotalRun').textContent=sc.totalRun||0;$('schedTotalFailed').textContent=sc.totalFailed||0;$('schedGap').textContent=Math.round((sc.nextGapMs||0)/1000)+'s';
const gb=d.groupBatcher||{};$('gbGroups').textContent=gb.groupsWithPending||0;$('gbTotal').textContent=gb.totalPending||0;$('gbInterval').textContent=(gb.minBatchMin||0)+'-'+(gb.maxBatchMin||0)+' min';
const s=d.dailyStats||{};$('dayDMs').textContent=s.dmsReplied||0;$('dayFocus').textContent=s.focusRuns||0;$('dayPics').textContent=(s.picsSent||0)+' / '+(s.videosSent||0);$('dayBC').textContent=s.broadcastsSent||0;$('dayGreet').textContent=s.greetingsSent||0;$('dayAiErr').textContent=s.aiErrors||0;
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
setInterval(async () => {
  if (connectionStatus === 'connected' && sock && !timeGate.isOffline()) {
    try { await sock.sendPresenceUpdate('available'); } catch (e) {}
  }
}, 4 * 60 * 1000);
setInterval(() => { axios.get(`http://localhost:${PORT}/health`).catch(() => {}); }, 4 * 60 * 1000);
setInterval(processJoinQueue, 30 * 1000);

// ================================================================
// STARTUP
// ================================================================
loadState();
loadAdminLids();
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Admin phone: ${ADMIN_PHONE}`);
  console.log(`Admin LIDs: ${[...adminLids].join(', ')}`);
  console.log(`Serial scheduler: concurrency=1, Fibonacci gaps`);
  console.log(`Time window: ${timeGate.describe()}`);
  console.log(`Focus pipeline: notified→unlocked→opened→reading→thinking→typing→reviewing→sent→switching`);
  pushLog('info', 'system', `Boot port ${PORT}`);
  pushLog('info', 'system', `Admin phone: ${ADMIN_PHONE}`);
  pushLog('info', 'system', `Serial scheduler active · Fibonacci timing · Time windows`);
  pushLog('info', 'system', `Scraper: ${SCRAPER_URL}`);
  scheduleGreetings();
  scheduleDailyReport();
  scheduleGroupBatchProcessor();
  connectBot().catch(err => { console.error('Boot failed:', err); pushLog('error', 'system', `Boot failed: ${err.message}`); });
});
