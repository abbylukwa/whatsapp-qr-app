'use strict';

// ================================================================
// WHATSAPP BOT v39.1
// Working admin (broad candidate scan) | Casual roleplay | No photo desc
// ================================================================

const express = require('express');
const fs = require('fs');
const path = require('path');
const NodeCache = require('node-cache');
const {
  makeWASocket, DisconnectReason, useMultiFileAuthState,
  Browsers, fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
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

// Hardcoded admin LIDs (fallback when phone fields empty)
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
const BC_DELAY_MIN_MS = 2000;
const BC_DELAY_MAX_MS = 6000;

const USER_HISTORY_SIZE = 4;
const PENDING_EXPIRY_MS = 60 * 60 * 1000;

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
// FORBIDDEN / FILLER FILTER  (expanded cat-bot filter)
// ================================================================
const FORBIDDEN_PATTERNS = [
  // Refusals
  /\bcannot\b/i, /\bcan'?t\b/i, /\bunable to\b/i,
  /\bi refuse\b/i, /\bnot allowed\b/i,
  /\bagainst my guidelines\b/i, /\bas an ai\b/i, /\bi am an ai\b/i,
  /\blanguage model\b/i, /\bsorry,? i\b/i, /\bi apologize\b/i,
  // Tech/debug leaks
  /\bapi[_ ]?key\b/i, /\bconsole\.log\b/i, /\berror:/i,
  /\bstack trace\b/i, /\btraceback\b/i, /\bdebug\b/i,
  /\bnode\.js\b/i, /\bnpm\b/i,
  // Generic AI filler (the "weird conversations" to avoid)
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
  try { await sock.sendMessage(ADMIN_JID, { text }); }
  catch (e) { pushLog('warn', 'admin', `Alert failed: ${e.message}`); }
}
const _origError = console.error;
console.error = (...args) => { _origError.apply(console, args); pushLog('error', 'system', args.map(String).join(' ')); };

// ================================================================
// STATE
// ================================================================
let sock = null;
let qrDataUri = null;
let connectionStatus = 'disconnected';
let botStartTime = Date.now();
let botNumber = null;
let reconnectAttempts = 0;
const MAX_RECONNECT = 10;
let isConnecting = false;

let lastRawMsg = null;

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
    dailyStats = { date: today, joined: 0, failed: 0, dmsReplied: 0, broadcastsSent: 0, greetingsSent: 0, scraperSearches: 0, scraperGifs: 0, picsSent: 0, videosSent: 0, aiErrors: 0, pendingCreated: 0, pendingResolved: 0 };
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
      for (const g of arr) joinedGroups.set(g.jid, { name: g.name, joinedAt: g.joinedAt });
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
function saveGroups() { try { fs.writeFileSync(JOINED_GROUPS_FILE, JSON.stringify([...joinedGroups.entries()].map(([jid, v]) => ({ jid, ...v })), null, 2)); } catch (e) {} }
function savePending() { try { fs.writeFileSync(PENDING_FILE, JSON.stringify([...pendingRequests.values()], null, 2)); } catch (e) {} }

// ================================================================
// ADMIN DETECTION — v36.0 style (broad candidate scan)
// ================================================================
function extractAllPhoneCandidates(msg, senderJid) {
  const phones = new Set();
  const candidates = [
    msg.key?.participantPn,
    msg.key?.senderPn,
    msg.key?.remoteJidAlt,
    msg.key?.participantAlt,
    senderJid,
    msg.key?.remoteJid,
    msg.key?.participant
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
  // 1. Any field with admin phone digits
  const candidates = extractAllPhoneCandidates(msg, senderJid);
  if (candidates.includes(ADMIN_PHONE)) {
    const lid = extractLidFromMsg(msg, senderJid);
    if (lid && !adminLids.has(lid)) { adminLids.add(lid); saveAdminLids(); pushLog('success', 'admin', `Registered admin LID ${lid}`); }
    return true;
  }
  // 2. Hardcoded or cached LID
  const lid = extractLidFromMsg(msg, senderJid);
  if (lid && adminLids.has(lid)) return true;
  return false;
}
function extractPhone(msg, senderJid) { const c = extractAllPhoneCandidates(msg, senderJid); return c.length > 0 ? c[0] : null; }
function extractLid(msg, senderJid) { return extractLidFromMsg(msg, senderJid); }

// ================================================================
// INVITE LINK
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
// JOIN QUEUE
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
  if (Date.now() - lastJoinAt < JOIN_INTERVAL_MS) return;
  joinInProgress = true;
  const item = joinQueue.shift();
  saveQueue();
  resetDailyStats();
  try {
    pushLog('info', 'join', `Joining ${item.code}...`);
    const res = await sock.groupAcceptInvite(item.code);
    lastJoinAt = Date.now();
    if (res) { joinedGroups.set(res, { name: null, joinedAt: Date.now() }); saveGroups(); dailyStats.joined++; pushLog('success', 'join', `✅ Joined ${res}`); }
  } catch (e) {
    dailyStats.failed++;
    pushLog('error', 'join', `Failed ${item.code}: ${e.message}`);
  } finally { joinInProgress = false; setTimeout(processJoinQueue, JOIN_INTERVAL_MS); }
}

// ================================================================
// REWIND AI
// ================================================================
async function askRewind(prompt, systemPrompt) {
  if (!REWIND_KEY) { pushLog('error', 'ai', 'REWIND_KEY missing'); return null; }
  try {
    const r = await axios.post('https://api.rewind.ai/v1/chat/completions', {
      model: 'rewind-uncensored',
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }]
    }, { headers: { 'Authorization': `Bearer ${REWIND_KEY}`, 'Content-Type': 'application/json' }, timeout: 20000 });
    const raw = r.data?.choices?.[0]?.message?.content;
    if (!raw) { pushLog('warn', 'ai', `Empty Rewind response`, { status: r.status }); return null; }
    const cleaned = humanize(raw);
    if (!cleaned) { pushLog('warn', 'ai', `Rewind output empty after humanize`); return null; }
    return cleaned;
  } catch (e) {
    const status = e.response?.status;
    const body = e.response?.data ? JSON.stringify(e.response.data).slice(0, 300) : '';
    pushLog('error', 'ai', `Rewind failed: ${status || ''} ${e.message}`, { body });
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
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Reply with exactly: AI WORKS' }
      ]
    }, { headers: { 'Authorization': `Bearer ${REWIND_KEY}`, 'Content-Type': 'application/json' }, timeout: 20000 });
    const ms = Date.now() - t0;
    const raw = r.data?.choices?.[0]?.message?.content;
    return { ok: true, ms, status: r.status, raw, full: r.data };
  } catch (e) {
    const ms = Date.now() - t0;
    const status = e.response?.status;
    const body = e.response?.data ? JSON.stringify(e.response.data).slice(0, 500) : null;
    return { ok: false, ms, status, error: e.message, body };
  }
}

// ================================================================
// SCRAPER
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
    pushLog('error', 'scraper', `search failed: ${e.message}`);
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
    pushLog('error', 'scraper', `gif failed: ${e.message}`);
    return { ok: false, error: e.message, gifs: [] };
  }
}
async function scraperStatus() {
  try { const r = await axios.get(`${SCRAPER_URL}/status`, { timeout: 10000 }); return { ok: true, data: r.data }; }
  catch (e) { return { ok: false, error: e.message }; }
}

// ================================================================
// INTENT DETECTION
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
// PENDING
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
  const msg = [
    `❓ *Unclear request*`,
    `👤 ${pending.userName} (${pending.userPhone || 'no phone'})`,
    `💬 Intent: ${pending.intent.type} — query "${pending.intent.query || '(empty)'}"`,
    ``,
    `*Last ${pending.userHistory.length} messages:*`,
    historyBlock || '(none)',
    ``,
    `Reply with:`,
    `• \`!teach ${id} <search query>\``,
    `• \`!teach ${id} skip\``,
    `• \`!teach ${id} say <text>\``
  ].join('\n');
  await alertAdmin(msg);
}
async function resolvePending(id, action, payload, adminChatJid) {
  const p = pendingRequests.get(id);
  if (!p) return { ok: false, error: `No pending request ${id}` };
  const reply = (t) => sock.sendMessage(adminChatJid, { text: t });
  try {
    if (action === 'skip') {
      const casual = await askRewind(`User said: "${p.userHistory.map(h => h.text).join(' / ')}". Reply casually and warmly. No filler. 1 short sentence.`, `You are Abby Faith Sithole, 23, Harare Zimbabwe. Warm, casual WhatsApp tone with light Shona sprinkled in.`);
      const fallback = casual || 'Sorry, couldn\'t find that right now 😅';
      await sock.sendMessage(p.userJid, { text: fallback });
      pendingRequests.delete(id); savePending();
      resetDailyStats(); dailyStats.pendingResolved++;
      await reply(`✅ Replied casually to ${p.userName}.`);
      return { ok: true };
    }
    if (action === 'say') {
      await sock.sendMessage(p.userJid, { text: payload });
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
      await sock.sendMessage(p.userJid, { video: { url: r.gifs[0] }, gifPlayback: true, caption: '' });
      resetDailyStats(); dailyStats.picsSent++;
    } else {
      const r = await scraperSearch(query);
      if (!r.ok || r.images.length === 0) { await reply(`❌ No results for "${query}".`); return { ok: false }; }
      // Send image with NO caption
      await sock.sendMessage(p.userJid, { image: { url: r.images[0] } });
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
// GREETINGS
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
    const now = Date.now();
    const minMs = GREETING_MIN_HOURS * 3600 * 1000, maxMs = GREETING_MAX_HOURS * 3600 * 1000;
    for (const [jid] of joinedGroups) {
      const sinceLast = now - (lastGreetingAt.get(jid) || 0);
      if (sinceLast < minMs) continue;
      const progress = (sinceLast - minMs) / (maxMs - minMs);
      if (Math.random() > Math.min(progress, 1)) continue;
      const reply = pickGreeting(getTimeOfDay());
      try {
        await sock.sendMessage(jid, { text: reply });
        lastGreetingAt.set(jid, now);
        resetDailyStats(); dailyStats.greetingsSent++;
        pushLog('info', 'greeting', `Sent to ${jid}: ${reply}`);
        await new Promise(r => setTimeout(r, 3000 + Math.random() * 4000));
      } catch (e) { pushLog('warn', 'greeting', `Failed ${jid}: ${e.message}`); }
    }
  }, 15 * 60 * 1000);
}

// ================================================================
// DAILY REPORT
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
      `❌ Failed: *${s.failed || 0}*`,
      `💌 DM replies: *${s.dmsReplied || 0}*`,
      `🖼️ Pics/Videos: *${(s.picsSent || 0) + (s.videosSent || 0)}*`,
      `📢 Broadcasts: *${s.broadcastsSent || 0}*`,
      `👋 Greetings: *${s.greetingsSent || 0}*`,
      `🤖 AI errors: *${s.aiErrors || 0}*`,
      `❓ Pending: *${s.pendingCreated || 0}/${s.pendingResolved || 0}*`, ``,
      `Uptime: ${Math.floor((Date.now() - botStartTime) / 3600000)}h`
    ].join('\n');
    try { await sock.sendMessage(ADMIN_JID, { text: summary }); pushLog('success', 'daily', 'Daily summary sent'); }
    catch (e) { pushLog('error', 'daily', `Report failed: ${e.message}`); }
  }, 60 * 1000);
}

// ================================================================
// BROADCAST
// ================================================================
function randomBcDelay() { return BC_DELAY_MIN_MS + Math.floor(Math.random() * (BC_DELAY_MAX_MS - BC_DELAY_MIN_MS)); }
async function broadcast({ message, imageUrl = null, gifUrl = null, mode = 'all' }) {
  const targets = [];
  if (mode === 'all' || mode === 'groups') for (const jid of joinedGroups.keys()) targets.push({ jid, type: 'group' });
  if (mode === 'all' || mode === 'dms') for (const jid of activeDMs) targets.push({ jid, type: 'dm' });
  const results = { sent: 0, failed: 0, total: targets.length, errors: [], mode };
  pushLog('info', 'broadcast', `Broadcasting to ${targets.length} (${mode})`);
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    try {
      if (gifUrl) await sock.sendMessage(t.jid, { video: { url: gifUrl }, gifPlayback: true, caption: message || '' });
      else if (imageUrl) await sock.sendMessage(t.jid, { image: { url: imageUrl }, caption: message || '' });
      else await sock.sendMessage(t.jid, { text: message });
      results.sent++;
      resetDailyStats(); dailyStats.broadcastsSent++;
    } catch (e) { results.failed++; results.errors.push({ jid: t.jid, error: e.message }); }
    if (i < targets.length - 1) await new Promise(r => setTimeout(r, randomBcDelay()));
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
// COMMAND LIST
// ================================================================
const COMMAND_LIST = `🥖 *BreadBot v39.1*

*Test*
!whoami · !aitest · !scraperstatus
!scrapersearch <q> · !scrapergif <q> · !test · !testall

*Pending*
!pending · !teach <id> <query> · !teach <id> say <text> · !teach <id> skip

*Group joins*
!join <link> · !joinall <links...> · !queue · !clearsqueue · !groups · !leave <jid>

*Scraper*
!pic <q> · !nextpic · !gif <q> · !nextgif
!bcastpic <caption> · !bcastpicdm · !bcastpicgroup · !bcastgif <caption>

*Broadcast*
!all <msg> · !bcgroup <msg> · !bcdm <msg> · !allimg <url> | <caption>
!ad <title> | <body> | [cta] | [link] | [style] · !bcad

*Other*
!stats · !ping · !summary · !scraperstats`;

// ================================================================
// CONNECTION
// ================================================================
async function connectBot() {
  if (isConnecting) return;
  isConnecting = true;
  try {
    pushLog('info', 'bot', 'Initializing...');
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const { version } = await fetchLatestBaileysVersion();
    pushLog('info', 'bot', `WA version ${version.join('.')}`);

    sock = makeWASocket({
      version, auth: state, printQRInTerminal: false,
      browser: Browsers.macOS('Desktop'),
      logger: pino({ level: 'silent' }),
      markOnlineOnConnect: false, syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      getMessage: async () => undefined
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) { qrDataUri = await QRCode.toDataURL(qr); connectionStatus = 'qr'; pushLog('info', 'bot', 'QR generated'); }
      if (connection === 'open') {
        isConnecting = false; connectionStatus = 'connected'; reconnectAttempts = 0;
        botStartTime = Date.now();
        botNumber = sock.user?.id?.split(':')[0]?.split('@')[0] || 'unknown';
        pushLog('success', 'bot', `✅ Connected as ${botNumber}`);
        try { await sock.sendPresenceUpdate('available'); } catch (e) {}
        try { await sock.sendMessage(ADMIN_JID, { text: `✅ *BreadBot ONLINE*\n📱 ${botNumber}\n\nSend !commands` }); } catch (e) {}
      }
      if (connection === 'close') {
        isConnecting = false;
        const code = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = code !== DisconnectReason.loggedOut;
        if (shouldReconnect && reconnectAttempts < MAX_RECONNECT) {
          reconnectAttempts++;
          const delay = Math.min(5000 * reconnectAttempts, 30000);
          connectionStatus = 'reconnecting';
          pushLog('warn', 'bot', `Disconnected (${code}), retry ${delay/1000}s [${reconnectAttempts}/${MAX_RECONNECT}]`);
          setTimeout(() => { try { sock.end(undefined); } catch (e) {} sock = null; connectBot(); }, delay);
        } else {
          connectionStatus = 'disconnected';
          pushLog('error', 'bot', code === DisconnectReason.loggedOut ? 'Logged out — rescan' : 'Max retries');
        }
      }
    });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const msg of messages || []) {
        try {
          if (msg.key?.fromMe) continue;
          await handleMessage(msg);
        } catch (e) {
          pushLog('error', 'handler', `handleMessage: ${e.message}`);
        }
      }
    });
  } catch (err) {
    isConnecting = false;
    pushLog('error', 'bot', `Connection failed: ${err.message}`);
    connectionStatus = 'error';
  }
}
async function disconnectBot() { if (sock) { try { sock.end(undefined); } catch (e) {} sock = null; connectionStatus = 'disconnected'; qrDataUri = null; isConnecting = false; pushLog('warn', 'bot', 'Disconnected'); } }
function refreshQR() { qrDataUri = null; connectionStatus = 'disconnected'; disconnectBot(); setTimeout(connectBot, 1500); }

// ================================================================
// MESSAGE HANDLER
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

  lastRawMsg = { ts: new Date().toISOString(), key: msg.key, pushName: msg.pushName };

  // Unwrap message content
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
  const pushName = msg.pushName || 'Unknown';
  const chatType = isGroup ? 'group' : 'dm';

  if (!isGroup) activeDMs.add(chatJid);

  pushLiveMessage({
    id: msgId, ts: new Date().toISOString(), chatJid, chatType, senderJid,
    senderName: pushName, phone: phone || '—', lid: lid || '—',
    text: text.slice(0, 200) || `[${mediaType}]`, mediaType
  });

  const isAdmin = isAdminSender(msg, senderJid);

  if (!isGroup && !isAdmin && text) {
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
      pushLog('info', 'join', `Queued ${added}/${codes.length} from ${pushName} via ${chatType}`);
      if (!isGroup) { try { await sock.sendMessage(chatJid, { text: `✅ Queued ${added} new link${added !== 1 ? 's' : ''}.\nQueue: ${joinQueue.length}` }); } catch (e) {} }
      processJoinQueue();
    }
  }

  if (!isGroup && isAdmin && text.startsWith('!')) {
    pushLog('info', 'admin', `Admin cmd: ${text.split(' ')[0]} (phone ${phone || '—'} lid ${lid || '—'})`);
    await handleAdminCommand(text, chatJid, msg);
    return;
  }

  if (isGroup) return;

  if (isAdmin) {
    pushLog('info', 'admin', `Admin DM ignored (no command): "${text.slice(0, 60)}"`);
    return;
  }

  if (!isGroup && !isAdmin) {
    const lang = detectLanguage(text);
    const langName = LANG_NAMES[lang] || 'English';

    // Ignore violation messages (cat bot filter)
    if (containsForbidden(text)) {
      pushLog('info', 'filter', `Message from ${pushName} ignored (forbidden)`);
      return;
    }

    const intent = detectMediaIntent(text);
    if (intent) {
      pushLog('info', 'pic', `Intent ${intent.type} — "${intent.query}" from ${pushName}`);
      const vague = isVagueQuery(intent.query);
      if (!vague) {
        if (intent.type === 'video' || intent.type === 'gif') {
          const r = await scraperGif(intent.query);
          if (r.ok && r.gifs.length > 0) {
            // NO caption on video
            try { await sock.sendMessage(chatJid, { video: { url: r.gifs[0] }, gifPlayback: true }, { quoted: msg }); }
            catch (e) { await sock.sendMessage(chatJid, { text: r.gifs[0] }, { quoted: msg }); }
            resetDailyStats();
            if (intent.type === 'video') dailyStats.videosSent++; else dailyStats.picsSent++;
            return;
          }
        } else {
          const r = await scraperSearch(intent.query);
          if (r.ok && r.images.length > 0) {
            // NO caption on image
            try { await sock.sendMessage(chatJid, { image: { url: r.images[0] } }, { quoted: msg }); }
            catch (e) { await sock.sendMessage(chatJid, { text: r.images[0] }, { quoted: msg }); }
            resetDailyStats(); dailyStats.picsSent++;
            return;
          }
        }
      }
      const history = userHistories.get(senderJid) || [];
      const id = createPendingRequest(senderJid, pushName, phone, history, intent);
      pushLog('warn', 'ai', `Pending ${id} for ${pushName}`);
      const ack = await askRewind(
        `User asked for something. Reply in one short casual WhatsApp sentence (max 8 words). No filler. No "how can I help".`,
        `You are Abby Faith Sithole, 23, Harare Zimbabwe. Casual WhatsApp, roleplaying a real person. Reply in ${langName}. Light Shona ok.`
      );
      const finalAck = (ack && !containsForbidden(ack)) ? ack : 'checking rn 😊';
      try { await sock.sendMessage(chatJid, { text: finalAck }, { quoted: msg }); } catch (e) {}
      const pending = pendingRequests.get(id);
      await forwardToAdminForHelp(id, pending);
      return;
    }

    // ── CASUAL ROLEPLAY AI REPLY ──
    const systemPrompt = `You are Abby Faith Sithole, a 23-year-old girl from Harare, Zimbabwe. You are a REAL person, not an AI, not an assistant, not a bot. Roleplay her naturally.

RULES:
- Reply in ${langName}. Mix in light Shona sometimes ("mhoro", "sei uri", "sharp", "eish", "hezvoka", "zvakanaka", "uri bho", "zvinei", "ndizvo").
- Keep replies SHORT: 1-2 sentences max. Like real WhatsApp texting.
- Be casual, playful, warm. React naturally to what they say.
- NEVER say you're an AI, assistant, bot, or language model.
- NEVER ask "how can I help you" or offer assistance.
- NEVER use filler phrases like "I understand", "based on your message", "I hope this helps".
- NEVER explain yourself. Just respond like a friend would.
- If the message is weird or something you wouldn't answer, reply very briefly or just with "😂" or "???" or something casual.
- No technical terms, no code, no URLs, no formal language.
- Text like a real person on WhatsApp.`;

    const aiReply = await askRewind(text, systemPrompt);
    if (!aiReply) { pushLog('warn', 'ai', `No reply for ${pushName}`); return; }
    if (containsForbidden(aiReply)) { pushLog('warn', 'ai', `Dropped (forbidden): ${aiReply.slice(0, 80)}`); return; }
    const final = humanize(aiReply);
    if (!final) { pushLog('warn', 'ai', 'Empty after humanize'); return; }
    await sock.sendMessage(chatJid, { text: final }, { quoted: msg });
    resetDailyStats(); dailyStats.dmsReplied++;
    pushLog('info', 'ai', `DM reply to ${pushName}: ${final.slice(0, 50)}`);
  }
}

// ================================================================
// ADMIN COMMANDS
// ================================================================
async function handleAdminCommand(text, chatJid, msg) {
  const args = text.slice(1).trim().split(/\s+/);
  const cmd = args[0].toLowerCase();
  const reply = (t) => sock.sendMessage(chatJid, { text: t }, { quoted: msg });

  switch (cmd) {
    case 'commands': case 'help': await reply(COMMAND_LIST); break;
    case 'ping': await reply(`🏓 Pong!\nStatus: *${connectionStatus}*\nUptime: *${Math.floor((Date.now()-botStartTime)/1000)}s*`); break;
    case 'test': await reply(`✅ *Test*\nBot: *${botNumber}*\nStatus: *${connectionStatus}*\nAdmin: *${ADMIN_PHONE}*\nGroups: *${joinedGroups.size}*\nDMs: *${activeDMs.size}*\nQueue: *${joinQueue.length}*\nPending: *${pendingRequests.size}*\nAdmin LIDs: *${[...adminLids].join(', ') || 'none'}*`); break;
    case 'whoami': {
      const c = extractAllPhoneCandidates(msg, chatJid);
      const lid = extractLid(msg, chatJid);
      await reply(`🔍 *Diagnostics*\n\nJID: *${msg.key.participant || msg.key.remoteJid}*\nLID: *${lid || '—'}*\nPhone candidates: *${c.join(', ') || 'none'}*\nExpected admin: *${ADMIN_PHONE}*\nIs admin: *${isAdminSender(msg, chatJid) ? 'YES ✅' : 'NO ❌'}*\nAdmin LIDs: *${[...adminLids].join(', ') || 'none'}*`);
      break;
    }
    case 'aitest': {
      await reply('🧪 Testing Rewind AI...');
      const r = await testRewindRaw();
      if (r.ok) await reply(`✅ *AI WORKS*\n\nStatus: *${r.status}*\nTime: *${r.ms}ms*\nRaw: *${r.raw || '(empty)'}*`);
      else await reply(`❌ *AI FAILED*\n\nStatus: *${r.status || 'none'}*\nTime: *${r.ms}ms*\nError: *${r.error}*\nBody: *${r.body || '(no body)'}*`);
      break;
    }
    case 'scraperstatus': {
      await reply('🔎 Testing scraper...');
      const st = await scraperStatus();
      if (st.ok) await reply(`✅ *Scraper WORKS*\n\nStatus: *${st.data.status || 'ok'}*\nUptime: *${Math.floor(st.data.uptime || 0)}s*\nTemp files: *${st.data.tempFiles || 0}*`);
      else await reply(`❌ *Scraper FAILED*\n\nError: *${st.error}*\nURL: *${SCRAPER_URL}*`);
      break;
    }
    case 'scrapersearch': {
      const q = args.slice(1).join(' ');
      if (!q) { await reply('❌ Usage: `!scrapersearch <query>`'); return; }
      await reply(`🔎 Searching scraper for *${q}*...`);
      const r = await scraperSearch(q);
      if (!r.ok) { await reply(`❌ Failed: ${r.error}`); return; }
      await reply(`✅ Found *${r.images.length}* images\nFirst: ${r.images[0] || 'none'}`);
      break;
    }
    case 'scrapergif': {
      const q = args.slice(1).join(' ');
      if (!q) { await reply('❌ Usage: `!scrapergif <query>`'); return; }
      await reply(`🔎 Searching GIFs for *${q}*...`);
      const r = await scraperGif(q);
      if (!r.ok) { await reply(`❌ Failed: ${r.error}`); return; }
      await reply(`✅ Found *${r.gifs.length}* GIFs\nFirst: ${r.gifs[0] || 'none'}`);
      break;
    }
    case 'testall': { await reply('🧪 Testing...'); const r = await runFullTestSuite(); await reply(r); break; }
    case 'stats': {
      const s = (resetDailyStats(), dailyStats);
      await reply(`📊 *Stats*\n\n*Now*\nDMs: *${activeDMs.size}*\nGroups: *${joinedGroups.size}*\nQueue: *${joinQueue.length}*\nPending: *${pendingRequests.size}*\nUptime: *${Math.floor((Date.now()-botStartTime)/1000)}s*\n\n*Today*\nJoined: *${s.joined}* / Failed: *${s.failed}*\nDM replies: *${s.dmsReplied}*\nPics: *${s.picsSent}* / Videos: *${s.videosSent}*\nBroadcasts: *${s.broadcastsSent}*\nGreetings: *${s.greetingsSent}*\nAI errors: *${s.aiErrors}*\nPending: *${s.pendingCreated}* / *${s.pendingResolved}*`);
      break;
    }
    case 'scraperstats': await reply(`🔎 *Scraper Stats*\n\nSearches: *${scraperStats.searchSuccess}* ok / *${scraperStats.searchFail}* fail\nGIFs: *${scraperStats.gifSuccess}* ok / *${scraperStats.gifFail}* fail\nLast search: *${scraperStats.lastSearchQuery || '—'}*\nLast GIF: *${scraperStats.lastGifQuery || '—'}*`); break;

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
      const list = [...joinedGroups.keys()].slice(0, 30).map((j, i) => `${i + 1}. ${j}`).join('\n');
      await reply(`👥 *Joined (${joinedGroups.size})*\n${list}`);
      break;
    }
    case 'leave': {
      const jid = args[1];
      if (!jid || !jid.endsWith('@g.us')) { await reply('❌ Usage: `!leave <jid@g.us>`'); return; }
      try { await sock.groupLeave(jid); joinedGroups.delete(jid); saveGroups(); await reply(`✅ Left ${jid}`); }
      catch (e) { await reply(`❌ ${e.message}`); }
      break;
    }

    case 'pic': case 'search': {
      const q = args.slice(1).join(' ');
      if (!q) { await reply('❌ Usage: `!pic <query>`'); return; }
      await reply(`🔎 Searching for *${q}*...`);
      const r = await scraperSearch(q);
      if (!r.ok || r.images.length === 0) { await reply(`❌ No results (${r.error || 'empty'})`); return; }
      previewCache.imageUrls = r.images; previewCache.imageIndex = 0;
      previewCache.currentType = 'image'; previewCache.currentUrl = r.images[0];
      try { await sock.sendMessage(chatJid, { image: { url: r.images[0] }, caption: `Preview 1/${r.images.length}\n!nextpic · !bcastpic <caption>` }); }
      catch (e) { await reply(`❌ ${e.message}`); }
      break;
    }
    case 'nextpic': {
      if (previewCache.imageUrls.length === 0) { await reply('❌ No preview.'); return; }
      previewCache.imageIndex = (previewCache.imageIndex + 1) % previewCache.imageUrls.length;
      previewCache.currentUrl = previewCache.imageUrls[previewCache.imageIndex];
      try { await sock.sendMessage(chatJid, { image: { url: previewCache.currentUrl }, caption: `Preview ${previewCache.imageIndex + 1}/${previewCache.imageUrls.length}` }); }
      catch (e) { await reply(`❌ ${e.message}`); }
      break;
    }
    case 'gif': {
      const q = args.slice(1).join(' ');
      if (!q) { await reply('❌ Usage: `!gif <query>`'); return; }
      await reply(`🔎 Searching GIFs for *${q}*...`);
      const r = await scraperGif(q);
      if (!r.ok || r.gifs.length === 0) { await reply(`❌ No results (${r.error || 'empty'})`); return; }
      previewCache.gifUrls = r.gifs; previewCache.gifIndex = 0;
      previewCache.currentType = 'gif'; previewCache.currentUrl = r.gifs[0];
      try { await sock.sendMessage(chatJid, { video: { url: r.gifs[0] }, gifPlayback: true, caption: `GIF 1/${r.gifs.length}\n!nextgif · !bcastgif <caption>` }); }
      catch (e) { await reply(`❌ ${e.message}`); }
      break;
    }
    case 'nextgif': {
      if (previewCache.gifUrls.length === 0) { await reply('❌ No preview.'); return; }
      previewCache.gifIndex = (previewCache.gifIndex + 1) % previewCache.gifUrls.length;
      previewCache.currentUrl = previewCache.gifUrls[previewCache.gifIndex];
      try { await sock.sendMessage(chatJid, { video: { url: previewCache.currentUrl }, gifPlayback: true, caption: `GIF ${previewCache.gifIndex + 1}/${previewCache.gifUrls.length}` }); }
      catch (e) { await reply(`❌ ${e.message}`); }
      break;
    }

    case 'all': case 'bcgroup': case 'bcdm': {
      const message = args.slice(1).join(' ');
      if (!message) { await reply(`❌ Usage: \`!${cmd} <message>\``); return; }
      const mode = cmd === 'all' ? 'all' : (cmd === 'bcgroup' ? 'groups' : 'dms');
      const count = mode === 'all' ? (joinedGroups.size + activeDMs.size) : mode === 'groups' ? joinedGroups.size : activeDMs.size;
      if (count === 0) { await reply(`📭 No ${mode} targets.`); return; }
      await reply(`⏳ Broadcasting to ${count} (${mode})...`);
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
      await reply(`⏳ Broadcasting to ${count}...`);
      const r = await broadcast({ message: caption, imageUrl: previewCache.currentUrl, mode });
      await reply(`✅ Done — Sent: *${r.sent}* / Failed: *${r.failed}*`);
      break;
    }
    case 'bcastgif': {
      if (!previewCache.currentUrl || previewCache.currentType !== 'gif') { await reply('❌ No GIF preview.'); return; }
      const caption = args.slice(1).join(' ') || '';
      const count = joinedGroups.size + activeDMs.size;
      if (count === 0) { await reply('📭 No targets.'); return; }
      await reply(`⏳ Broadcasting GIF to ${count}...`);
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
      await reply(`⏳ Broadcasting image to ${count}...`);
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
      await reply(`⏳ Broadcasting ad to ${count}...`);
      const r = await broadcast({ message: adText, mode: 'all' });
      await reply(`✅ Done — Sent: *${r.sent}* / Failed: *${r.failed}*`);
      break;
    }
    case 'summary': {
      resetDailyStats(); const s = dailyStats;
      await reply(`📊 *Today (${s.date})*\nJoined: *${s.joined}*\nFailed: *${s.failed}*\nDM replies: *${s.dmsReplied}*\nPics: *${s.picsSent}*\nVideos: *${s.videosSent}*\nBroadcasts: *${s.broadcastsSent}*\nGreetings: *${s.greetingsSent}*\nAI errors: *${s.aiErrors}*\nPending: *${s.pendingCreated}* / *${s.pendingResolved}*`);
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
  tests.push(`Rewind AI: ${rw.ok ? `✅ ${rw.ms}ms — "${(rw.raw || '').slice(0, 30)}"` : `❌ ${rw.status || ''} ${rw.error}`}`);
  const st = await scraperStatus();
  tests.push(`Scraper /status: ${st.ok ? '✅' : '❌ ' + st.error}`);
  return ['🧪 *Test Suite*', '', ...tests, '',
    `🔌 WhatsApp: ${connectionStatus === 'connected' ? '✅' : `❌ ${connectionStatus}`}`,
    `📱 Bot: ${botNumber || '—'}`,
    `👥 Groups: ${joinedGroups.size}`,
    `💬 DMs: ${activeDMs.size}`,
    `📋 Queue: ${joinQueue.length}`,
    `⏳ Pending: ${pendingRequests.size}`,
    `🕒 ${Date.now() - t0}ms`].join('\n');
}

// ================================================================
// EXPRESS + GUI
// ================================================================
const app = express();
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now(), status: connectionStatus, uptime: Math.floor((Date.now()-botStartTime)/1000) }));
app.get('/api/status', (req, res) => res.json({ status: connectionStatus, botNumber, groups: joinedGroups.size, dms: activeDMs.size, queue: joinQueue.length, pending: pendingRequests.size }));
app.get('/admin/qr', async (req, res) => {
  if (!qrDataUri) return res.status(404).json({ error: 'No QR' });
  const b64 = qrDataUri.replace(/^data:image\/\w+;base64,/, '');
  res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(Buffer.from(b64, 'base64'));
});
app.get('/admin/qr-data', (req, res) => res.json({ qr: qrDataUri, status: connectionStatus, botNumber }));
app.post('/admin/connect', (req, res) => { if (!sock) connectBot(); res.json({ ok: true }); });
app.post('/admin/reconnect', async (req, res) => { await disconnectBot(); setTimeout(connectBot, 1500); res.json({ ok: true }); });
app.post('/admin/disconnect', async (req, res) => { await disconnectBot(); res.json({ ok: true }); });
app.post('/admin/refresh-qr', (req, res) => { refreshQR(); res.json({ ok: true }); });
app.post('/admin/clear-session', (req, res) => {
  try { fs.rmSync(AUTH_FOLDER, { recursive: true, force: true }); } catch (e) {}
  res.json({ ok: true, msg: 'Session cleared. Click Reconnect.' });
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
    adminPhone: ADMIN_PHONE,
    adminLids: [...adminLids],
    pendingCount: pendingRequests.size,
    pendingList: [...pendingRequests.values()].map(p => ({ id: p.id, userName: p.userName, userPhone: p.userPhone, type: p.intent.type, query: p.intent.query }))
  });
});

const PANEL_HTML = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BreadBot v39.1</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:monospace;background:#0d1117;color:#c9d1d9;padding:16px}h1{font-size:20px;color:#58a6ff;margin-bottom:4px}.sub{font-size:12px;color:#8b949e;margin-bottom:16px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px}.card h2{font-size:12px;color:#8b949e;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px}button{background:#21262d;border:1px solid #30363d;color:#c9d1d9;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:13px;margin:3px;font-family:inherit}button:hover{background:#30363d;border-color:#58a6ff}button.primary{background:#238636;border-color:#2ea043;color:#fff}button.danger{background:#da3633;border-color:#f85149;color:#fff}#qrImg{width:100%;max-width:240px;border-radius:8px;margin:8px auto;display:block;background:#fff;padding:8px}.status-dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;vertical-align:middle}.s-connected{background:#3fb950;box-shadow:0 0 8px #3fb950}.s-qr{background:#d29922}.s-disconnected{background:#f85149}.s-reconnecting{background:#d29922;animation:pulse 1s infinite}.s-error{background:#f85149}@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}#logs,#msgs{height:300px;overflow-y:auto;font-size:12px;line-height:1.6;background:#0d1117;border-radius:6px;padding:8px}.log-entry{padding:3px 0;border-bottom:1px solid #21262d}.log-time{color:#484f58;margin-right:8px}.log-info{color:#58a6ff}.log-success{color:#3fb950}.log-warn{color:#d29922}.log-error{color:#f85149}.log-source{color:#8b949e;margin-right:6px}.stat-row{display:flex;justify-content:space-between;padding:5px 0;font-size:13px;border-bottom:1px solid #21262d}.stat-row:last-child{border-bottom:none}.stat-val{color:#58a6ff;font-weight:600}.msg-row{padding:6px 8px;margin:4px 0;border-radius:6px;background:#161b22;border-left:3px solid #58a6ff;font-size:12px}.msg-row.group{border-left-color:#a371f7}.msg-row.dm{border-left-color:#3fb950}.msg-meta{color:#8b949e;font-size:11px;margin-bottom:2px}.msg-name{color:#58a6ff;font-weight:600}.msg-text{color:#c9d1d9;word-break:break-word}.tag{display:inline-block;padding:1px 6px;border-radius:3px;font-size:10px;margin-left:6px;font-weight:600}.tag-group{background:#a371f7;color:#fff}.tag-dm{background:#3fb950;color:#000}.full-width{grid-column:1/-1}</style></head><body>
<h1>🥖 BreadBot v39.1</h1><div class="sub">Admin phone: <b id="adminPhone">—</b> · Admin LIDs: <b id="adminLids">—</b> · Scraper: <b id="scraperUrl">—</b></div>
<div class="grid">
<div class="card"><h2>Connection</h2><div style="margin-bottom:10px"><span class="status-dot" id="statusDot"></span><span id="statusText">Loading...</span></div><div class="stat-row"><span>Bot</span><span class="stat-val" id="botNum">—</span></div><div class="stat-row"><span>Uptime</span><span class="stat-val" id="statUptime">—</span></div><img id="qrImg" src="" style="display:none"><div style="margin-top:10px"><button class="primary" onclick="doAction('connect')">🔗 Start</button><button onclick="doAction('reconnect')">🔄 Reconnect</button><button onclick="doAction('refresh-qr')">♻️ Refresh QR</button><button class="danger" onclick="doAction('disconnect')">⛔ Disconnect</button><button onclick="doAction('clear-session')">🗑️ Clear Session</button><button onclick="testAI()">🧪 Test AI</button><button onclick="testScraper()">🔎 Test Scraper</button></div><pre id="testResult" style="margin-top:8px;font-size:11px;color:#8b949e;white-space:pre-wrap;max-height:200px;overflow:auto"></pre></div>
<div class="card"><h2>Groups & Queue</h2><div class="stat-row"><span>Joined groups</span><span class="stat-val" id="statGroups">—</span></div><div class="stat-row"><span>DM chats</span><span class="stat-val" id="statDMs">—</span></div><div class="stat-row"><span>Queue</span><span class="stat-val" id="statQueue">—</span></div><div class="stat-row"><span>Pending</span><span class="stat-val" id="statPending">—</span></div></div>
<div class="card"><h2>Scraper Usage</h2><div class="stat-row"><span>Searches (ok/fail)</span><span class="stat-val" id="scSearch">—</span></div><div class="stat-row"><span>GIFs (ok/fail)</span><span class="stat-val" id="scGif">—</span></div><div class="stat-row"><span>Last search</span><span class="stat-val" id="scLastSearch">—</span></div><div class="stat-row"><span>Last GIF</span><span class="stat-val" id="scLastGif">—</span></div></div>
<div class="card"><h2>Today</h2><div class="stat-row"><span>Joined / Failed</span><span class="stat-val" id="dayJoined">—</span></div><div class="stat-row"><span>DM replies</span><span class="stat-val" id="dayDMs">—</span></div><div class="stat-row"><span>Pics / Videos</span><span class="stat-val" id="dayPics">—</span></div><div class="stat-row"><span>Broadcasts</span><span class="stat-val" id="dayBC">—</span></div><div class="stat-row"><span>Greetings</span><span class="stat-val" id="dayGreet">—</span></div><div class="stat-row"><span>AI errors</span><span class="stat-val" id="dayAiErr">—</span></div><div class="stat-row"><span>Pending (new/done)</span><span class="stat-val" id="dayPending">—</span></div></div>
<div class="card full-width"><h2>⏳ Pending Requests</h2><div id="pending"></div></div>
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
async function refreshStats(){try{const d=await api('stats');setStatus(d.status);$('statUptime').textContent=fmt(d.uptime);$('botNum').textContent=d.botNumber||'—';$('statGroups').textContent=d.joinedGroups;$('statDMs').textContent=d.dmCount;$('statQueue').textContent=d.queueSize;$('statPending').textContent=d.pendingCount||0;$('scraperUrl').textContent=d.scraperUrl||'—';$('adminPhone').textContent=d.adminPhone||'—';$('adminLids').textContent=(d.adminLids||[]).join(', ')||'—';const ss=d.scraperStats||{};$('scSearch').textContent=(ss.searchSuccess||0)+'/'+(ss.searchFail||0);$('scGif').textContent=(ss.gifSuccess||0)+'/'+(ss.gifFail||0);$('scLastSearch').textContent=ss.lastSearchQuery||'—';$('scLastGif').textContent=ss.lastGifQuery||'—';const s=d.dailyStats||{};$('dayJoined').textContent=(s.joined||0)+' / '+(s.failed||0);$('dayDMs').textContent=s.dmsReplied||0;$('dayPics').textContent=(s.picsSent||0)+' / '+(s.videosSent||0);$('dayBC').textContent=s.broadcastsSent||0;$('dayGreet').textContent=s.greetingsSent||0;$('dayAiErr').textContent=s.aiErrors||0;$('dayPending').textContent=(s.pendingCreated||0)+' / '+(s.pendingResolved||0);
const pendBox=$('pending');pendBox.innerHTML='';for(const p of (d.pendingList||[])){const div=document.createElement('div');div.className='msg-row';div.innerHTML='<div class="msg-meta">ID: '+esc(p.id)+' · '+esc(p.type)+' · query "'+esc(p.query)+'"</div><div><span class="msg-name">'+esc(p.userName)+'</span> · 📱 '+esc(p.userPhone||'—')+'</div>';pendBox.appendChild(div);}if(!d.pendingList||d.pendingList.length===0)pendBox.innerHTML='<div style="color:#8b949e;font-size:12px">No pending.</div>';
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
setInterval(async () => { if (connectionStatus === 'connected' && sock) { try { await sock.sendPresenceUpdate('available'); } catch (e) {} } }, 4 * 60 * 1000);
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
  pushLog('info', 'system', `Boot port ${PORT}`);
  pushLog('info', 'system', `Admin phone: ${ADMIN_PHONE}`);
  pushLog('info', 'system', `Admin LIDs: ${[...adminLids].join(', ')}`);
  pushLog('info', 'system', `Scraper: ${SCRAPER_URL}`);
  scheduleGreetings();
  scheduleDailyReport();
  connectBot().catch(err => { console.error('Boot failed:', err); pushLog('error', 'system', `Boot failed: ${err.message}`); });
});
