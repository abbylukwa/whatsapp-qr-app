'use strict';

// ================================================================
// WHATSAPP BOT v34.0
// Any-link auto-join | Scraper preview → broadcast | Full GUI
// ================================================================

const express = require('express');
const fs = require('fs');
const path = require('path');
const NodeCache = require('node-cache');
const {
  makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  Browsers,
  fetchLatestBaileysVersion
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

const REWIND_KEY = process.env.REWIND_KEY || 'sk-rewind-31c3a65acc981512de959195485deec0';
const SCRAPER_URL = (process.env.SCRAPER_URL || 'https://intelligent-scraper.onrender.com').replace(/\/$/, '');

const JOIN_INTERVAL_MS = parseInt(process.env.JOIN_INTERVAL_MS || '480000', 10);
const JOIN_QUEUE_FILE = path.join(__dirname, 'join_queue.json');
const JOINED_GROUPS_FILE = path.join(__dirname, 'joined_groups.json');

const GREETING_MIN_HOURS = 4;
const GREETING_MAX_HOURS = 8;
const DAILY_REPORT_HOUR = parseInt(process.env.DAILY_REPORT_HOUR || '22', 10);
const BC_DELAY_MIN_MS = 2000;
const BC_DELAY_MAX_MS = 6000;

// ================================================================
// FORBIDDEN / FILLER FILTER
// ================================================================
const FORBIDDEN_REPLY_WORDS = [
  'cannot', "can't", 'unable to', 'i refuse', 'not allowed',
  'against my guidelines', 'as an ai', 'i am an ai', 'language model',
  'sorry, i', 'i apologize', 'token', 'api_key', 'console.log',
  'error:', 'stack trace', 'traceback', 'debug', 'http', 'json',
  'node.js', 'npm', 'how can i help you today', 'how may i help you',
  'is there anything else', 'anything else i can help', 'let me know if',
  'feel free to', 'i am here to help', "i'm here to help",
  'i am happy to help', "i'm happy to help", 'happy to assist',
  'how can i help', 'what can i do for you', 'do you need any',
  'please let me know', 'i hope this helps', 'hope this helps',
  'thank you for reaching out', 'thanks for reaching out',
  'don\'t hesitate to ask', 'do not hesitate', 'as an assistant',
  'greetings!', 'how are you today?', 'i understand that',
  'based on your query', 'to answer your question', 'in response to'
].map(w => w.toLowerCase());

function containsForbidden(text) {
  if (!text) return true;
  const low = text.toLowerCase();
  return FORBIDDEN_REPLY_WORDS.some(w => low.includes(w));
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

const processedMessages = new Set();
const messageHistory = new Map();
const activeChats = new Set();
const activeDMs = new Set();
const replyCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

let joinQueue = [];
let joinInProgress = false;
let lastJoinAt = 0;
const joinedGroups = new Map();
const lastGreetingAt = new Map();

// Scraper usage tracking
const scraperStats = {
  searchCalls: 0, searchSuccess: 0, searchFail: 0,
  gifCalls: 0, gifSuccess: 0, gifFail: 0,
  lastSearchQuery: null, lastSearchAt: null,
  lastGifQuery: null, lastGifAt: null
};

// Scraper preview cache (for broadcast preview flow)
let previewCache = {
  imageUrls: [],       // array of URLs from last search
  imageIndex: 0,       // which one is currently previewed
  gifUrls: [],
  gifIndex: 0,
  currentType: null,   // 'image' | 'gif'
  currentUrl: null,
  currentCaption: null
};

// Daily stats
let dailyStats = null;
let lastDailyReportDate = null;

function resetDailyStats() {
  const today = new Date().toISOString().slice(0, 10);
  if (lastDailyReportDate !== today) {
    dailyStats = { date: today, joined: 0, failed: 0, dmsReplied: 0, broadcastsSent: 0, greetingsSent: 0, scraperSearches: 0, scraperGifs: 0 };
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
  pushLog('info', 'state', `Loaded queue=${joinQueue.length}, groups=${joinedGroups.size}`);
}
function saveQueue() { try { fs.writeFileSync(JOIN_QUEUE_FILE, JSON.stringify(joinQueue, null, 2)); } catch (e) {} }
function saveGroups() { try { fs.writeFileSync(JOINED_GROUPS_FILE, JSON.stringify([...joinedGroups.entries()].map(([jid, v]) => ({ jid, ...v })), null, 2)); } catch (e) {} }

// ================================================================
// INVITE LINK PARSING
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
  if (!code) return false;
  if (joinQueue.some(q => q.code === code)) return false;
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
    if (res) {
      joinedGroups.set(res, { name: null, joinedAt: Date.now() });
      saveGroups();
      dailyStats.joined++;
      pushLog('success', 'join', `✅ Joined ${res}`);
    }
  } catch (e) {
    dailyStats.failed++;
    pushLog('error', 'join', `Failed ${item.code}: ${e.message}`);
  } finally {
    joinInProgress = false;
    setTimeout(processJoinQueue, JOIN_INTERVAL_MS);
  }
}

// ================================================================
// PHONE EXTRACTION
// ================================================================
function extractPhone(msg, senderJid) {
  const c = [msg.key?.participantPn, msg.key?.senderPn, msg.key?.remoteJidAlt, msg.key?.participantAlt, senderJid].filter(Boolean);
  for (const x of c) if (typeof x === 'string' && x.endsWith('@s.whatsapp.net')) return x.split('@')[0].split(':')[0].replace(/\D/g, '');
  return null;
}
function extractLid(msg, senderJid) {
  const c = [senderJid, msg.key?.remoteJid, msg.key?.participant].filter(Boolean);
  for (const x of c) if (typeof x === 'string' && x.includes('@lid')) return x.split('@')[0];
  return null;
}
function isAdminPhone(phone) { return phone && phone.replace(/\D/g, '') === ADMIN_PHONE; }

// ================================================================
// REWIND AI (DM only)
// ================================================================
async function askRewind(prompt, systemPrompt) {
  if (!REWIND_KEY) return null;
  try {
    const r = await axios.post('https://api.rewind.ai/v1/chat/completions', {
      model: 'rewind-uncensored',
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }]
    }, { headers: { 'Authorization': `Bearer ${REWIND_KEY}`, 'Content-Type': 'application/json' }, timeout: 15000 });
    return r.data?.choices?.[0]?.message?.content ? humanize(r.data.choices[0].message.content) : null;
  } catch (e) { console.error(`Rewind failed: ${e.message}`); return null; }
}

// ================================================================
// SCRAPER CLIENT (tracked)
// ================================================================
async function scraperSearch(query, site = 'darknaija') {
  scraperStats.searchCalls++;
  scraperStats.lastSearchQuery = query;
  scraperStats.lastSearchAt = Date.now();
  resetDailyStats();
  dailyStats.scraperSearches++;
  try {
    const r = await axios.post(`${SCRAPER_URL}/search`, { query, site }, { timeout: 30000 });
    const images = r.data?.images || [];
    scraperStats.searchSuccess++;
    return { ok: true, images };
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
  resetDailyStats();
  dailyStats.scraperGifs++;
  try {
    const r = await axios.get(`${SCRAPER_URL}/gif?q=${encodeURIComponent(query)}`, { timeout: 30000 });
    const gifs = r.data?.gifs || [];
    scraperStats.gifSuccess++;
    return { ok: true, gifs };
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

function detectImageIntent(text) {
  const low = (text || '').toLowerCase();
  const gifT = ['send gif', 'gif of', 'gif ya', 'gif ye'];
  const imgT = ['send pic', 'send image', 'send photo', 'show me', 'ndipe', 'nditumire', 'ndiratidze', 'ndoda mufananidzo', 'mufananidzo', 'pic of', 'image of', 'photo of', 'picture of'];
  if (gifT.some(t => low.includes(t))) {
    const cleaned = low.replace(/send gif( of| ya| ye)?|gif( of| ya| ye)?/g, '').trim();
    return { type: 'gif', query: cleaned || low };
  }
  if (imgT.some(t => low.includes(t))) {
    const cleaned = low.replace(/send (pic|image|photo)( of)?|show me|ndipe|nditumire|ndiratidze|ndoda mufananidzo|mufananidzo|pic of|image of|photo of|picture of/g, '').trim();
    return { type: 'image', query: cleaned || low };
  }
  return null;
}

// ================================================================
// GREETING SCHEDULER
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
    const minMs = GREETING_MIN_HOURS * 3600 * 1000;
    const maxMs = GREETING_MAX_HOURS * 3600 * 1000;
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
// DAILY SUMMARY
// ================================================================
function scheduleDailyReport() {
  setInterval(async () => {
    if (!sock || connectionStatus !== 'connected') return;
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    if (now.getHours() !== DAILY_REPORT_HOUR || lastDailyReportDate === today) return;
    lastDailyReportDate = today;
    resetDailyStats();
    const s = dailyStats || {};
    const summary = [
      `📊 *Daily Summary — ${today}*`, ``,
      `👥 Groups: *${joinedGroups.size}*`,
      `💬 DMs: *${activeDMs.size}*`,
      `📋 Queue: *${joinQueue.length}*`, ``,
      `*Today*`,
      `✅ Joined: *${s.joined || 0}*`,
      `❌ Failed: *${s.failed || 0}*`,
      `💌 DM replies: *${s.dmsReplied || 0}*`,
      `📢 Broadcasts: *${s.broadcastsSent || 0}*`,
      `👋 Greetings: *${s.greetingsSent || 0}*`,
      `🔎 Scraper searches: *${s.scraperSearches || 0}*`,
      `🎬 Scraper GIFs: *${s.scraperGifs || 0}*`, ``,
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
const COMMAND_LIST = `🥖 *BreadBot v34*

*Group joins (any link, DM or group)*
Just post/forward a link → auto-queued (8-min spacing)
!join <link> · !joinall <links...>
!queue · !clearsqueue · !groups · !leave <jid>

*Scraper preview → broadcast*
!pic <query> — scrape 1 image & send to you
!nextpic — cycle to next image
!gif <query> — scrape 1 GIF & send to you
!nextgif — cycle to next GIF
!bcastpic <caption> — broadcast previewed image to ALL
!bcastgif <caption> — broadcast previewed GIF to ALL
!bcastpicdm / !bcastpicgroup — same but DMs/groups only

*Broadcast (text)*
!all <message> — DMs + groups
!bcgroup <message> — groups only
!bcdm <message> — DMs only
!allimg <url> | <caption>
!ad <title> | <body> | [cta] | [link] | [style]
!bcad

*Diagnostics*
!test · !testall · !whoami · !stats · !ping · !summary
!scraperstats — scraper usage totals`;

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
        await alertAdmin(`✅ *BreadBot ONLINE*\n📱 ${botNumber}\n🕒 ${new Date().toLocaleString()}\n\nPost/forward any group link (DM or group) → auto-queued.\nDaily summary at ${DAILY_REPORT_HOUR}:00.`);
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
          setTimeout(() => { sock = null; connectBot(); }, delay);
        } else {
          connectionStatus = 'disconnected';
          pushLog('error', 'bot', code === DisconnectReason.loggedOut ? 'Logged out — rescan' : 'Max retries');
        }
      }
    });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const msg of messages) if (!msg.key.fromMe) await handleMessage(msg);
    });
  } catch (err) {
    isConnecting = false;
    pushLog('error', 'bot', `Connection failed: ${err.message}`);
    connectionStatus = 'error';
  }
}
async function disconnectBot() {
  if (sock) { try { sock.end(undefined); } catch (e) {} sock = null; connectionStatus = 'disconnected'; qrDataUri = null; isConnecting = false; pushLog('warn', 'bot', 'Disconnected'); }
}
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

  const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || '';
  const mediaType = msg.message?.imageMessage ? 'image' : msg.message?.videoMessage ? 'video' : msg.message?.audioMessage ? 'audio' : msg.message?.documentMessage ? 'document' : 'text';

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

  const isAdmin = isAdminPhone(phone);

  // ── ANY LINK (DM or group) → queue ──
  const codes = extractAllInviteCodes(text);
  if (codes.length > 0) {
    // Ignore links the bot itself posted
    let added = 0;
    for (const c of codes) if (queueJoin(c, phone || pushName, chatType)) added++;
    if (added > 0) {
      pushLog('info', 'join', `Queued ${added}/${codes.length} from ${phone || pushName} via ${chatType}`);
      // Only confirm in DM (don't spam the group)
      if (!isGroup) {
        try {
          await sock.sendMessage(chatJid, { text: `✅ Queued ${added} new link${added !== 1 ? 's' : ''}.\nQueue: ${joinQueue.length}\nNext join in ≤ ${Math.ceil(JOIN_INTERVAL_MS/60000)} min.` });
        } catch (e) {}
      }
      processJoinQueue();
    }
    // Don't return here — if admin also sends a command, let it through
  }

  // ── ADMIN DM commands ──
  if (!isGroup && isAdmin && text.startsWith('!')) {
    pushLog('info', 'admin', `Admin cmd: ${text.split(' ')[0]}`);
    await handleAdminCommand(text, chatJid, msg);
    return;
  }

  // ── GROUP: silent (greetings handled by scheduler) ──
  if (isGroup) return;

  // ── NON-ADMIN DM: Rewind + scraper ──
  if (!isGroup && !isAdmin) {
    if (!messageHistory.has(senderJid)) messageHistory.set(senderJid, []);
    const hist = messageHistory.get(senderJid);
    if (hist.includes(text)) return;
    hist.push(text);
    if (hist.length > 5) hist.shift();

    const lang = detectLanguage(text);
    const langName = LANG_NAMES[lang] || 'English';

    const intent = detectImageIntent(text);
    if (intent && intent.query) {
      if (intent.type === 'gif') {
        const r = await scraperGif(intent.query);
        if (r.ok && r.gifs.length > 0) {
          const caption = await askRewind(
            `User asked for a GIF of "${intent.query}". Short casual reply (max 8 words) with emoji. No filler.`,
            `You are Abby Faith Sithole, 23, Harare Zimbabwe. Casual WhatsApp. Reply in ${langName}. Max 8 words.`
          );
          const finalCaption = (caption && !containsForbidden(caption)) ? caption : '';
          try { await sock.sendMessage(chatJid, { video: { url: r.gifs[0] }, gifPlayback: true, caption: finalCaption }, { quoted: msg }); }
          catch (e) { await sock.sendMessage(chatJid, { text: r.gifs[0] }, { quoted: msg }); }
          resetDailyStats(); dailyStats.dmsReplied++;
          return;
        }
      } else {
        const r = await scraperSearch(intent.query);
        if (r.ok && r.images.length > 0) {
          const caption = await askRewind(
            `User asked for a picture of "${intent.query}". Short casual reply (max 8 words) with emoji. No filler.`,
            `You are Abby Faith Sithole, 23, Harare Zimbabwe. Casual WhatsApp. Reply in ${langName}. Max 8 words.`
          );
          const finalCaption = (caption && !containsForbidden(caption)) ? caption : '';
          try { await sock.sendMessage(chatJid, { image: { url: r.images[0] }, caption: finalCaption }, { quoted: msg }); }
          catch (e) { await sock.sendMessage(chatJid, { text: r.images[0] }, { quoted: msg }); }
          resetDailyStats(); dailyStats.dmsReplied++;
          return;
        }
      }
    }

    const systemPrompt = `You are Abby Faith Sithole, 23, from Harare, Zimbabwe. Friendly, warm, playful. Reply ONLY in ${langName}. Casual WhatsApp tone. No technical terms, no code, no logs, no URLs. 1-2 sentences. Never ask "how can I help you". Never offer assistance. Just respond naturally.`;
    const aiReply = await askRewind(text, systemPrompt);
    if (!aiReply) { pushLog('warn', 'ai', `No DM reply for ${pushName}`); return; }
    if (containsForbidden(aiReply)) { pushLog('warn', 'ai', `Dropped: ${aiReply.slice(0, 60)}`); return; }
    const final = humanize(aiReply);
    if (!final) return;
    await sock.sendMessage(chatJid, { text: final }, { quoted: msg });
    resetDailyStats(); dailyStats.dmsReplied++;
    pushLog('info', 'ai', `DM reply to ${pushName}`);
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
    case 'test': await reply(`✅ *Test*\nBot: *${botNumber}*\nStatus: *${connectionStatus}*\nGroups: *${joinedGroups.size}*\nDMs: *${activeDMs.size}*\nQueue: *${joinQueue.length}*`); break;
    case 'whoami': await reply(`🔍 JID: *${msg.key.participant || msg.key.remoteJid}*\nPhone: *${extractPhone(msg, chatJid) || '—'}*\nLID: *${extractLid(msg, chatJid) || '—'}*\nExpected: *${ADMIN_PHONE}*\nIs admin: *${isAdminPhone(extractPhone(msg, chatJid)) ? 'YES' : 'NO'}*`); break;
    case 'testall': { await reply('🧪 Testing...'); const r = await runFullTestSuite(); await reply(r); break; }
    case 'stats': await reply(`📊 *Stats*\nDMs: *${activeDMs.size}*\nGroups: *${joinedGroups.size}*\nQueue: *${joinQueue.length}*\nLogs: *${logBuffer.length}*\nUptime: *${Math.floor((Date.now()-botStartTime)/1000)}s*`); break;

    case 'scraperstats': await reply(`🔎 *Scraper Stats*\n\nSearches: *${scraperStats.searchSuccess}* ok / *${scraperStats.searchFail}* fail (of ${scraperStats.searchCalls})\nGIFs: *${scraperStats.gifSuccess}* ok / *${scraperStats.gifFail}* fail (of ${scraperStats.gifCalls})\nLast search: *${scraperStats.lastSearchQuery || '—'}*\nLast GIF: *${scraperStats.lastGifQuery || '—'}*`); break;

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

    // ── SCRAPER PREVIEW FLOW ──
    case 'pic': case 'search': {
      const q = args.slice(1).join(' ');
      if (!q) { await reply('❌ Usage: `!pic <query>`'); return; }
      await reply(`🔎 Searching images for *${q}*...`);
      const r = await scraperSearch(q);
      if (!r.ok || r.images.length === 0) { await reply(`❌ No results (${r.error || 'empty'})`); return; }
      previewCache.imageUrls = r.images;
      previewCache.imageIndex = 0;
      previewCache.currentType = 'image';
      previewCache.currentUrl = r.images[0];
      try { await sock.sendMessage(chatJid, { image: { url: r.images[0] }, caption: `Preview 1/${r.images.length}\nUse !nextpic for next, !bcastpic <caption> to broadcast` }); }
      catch (e) { await reply(`❌ Send failed: ${e.message}`); }
      break;
    }
    case 'nextpic': {
      if (previewCache.imageUrls.length === 0) { await reply('❌ No preview. Use `!pic <query>` first.'); return; }
      previewCache.imageIndex = (previewCache.imageIndex + 1) % previewCache.imageUrls.length;
      previewCache.currentUrl = previewCache.imageUrls[previewCache.imageIndex];
      try { await sock.sendMessage(chatJid, { image: { url: previewCache.currentUrl }, caption: `Preview ${previewCache.imageIndex + 1}/${previewCache.imageUrls.length}` }); }
      catch (e) { await reply(`❌ Send failed: ${e.message}`); }
      break;
    }
    case 'gif': {
      const q = args.slice(1).join(' ');
      if (!q) { await reply('❌ Usage: `!gif <query>`'); return; }
      await reply(`🔎 Searching GIFs for *${q}*...`);
      const r = await scraperGif(q);
      if (!r.ok || r.gifs.length === 0) { await reply(`❌ No results (${r.error || 'empty'})`); return; }
      previewCache.gifUrls = r.gifs;
      previewCache.gifIndex = 0;
      previewCache.currentType = 'gif';
      previewCache.currentUrl = r.gifs[0];
      try { await sock.sendMessage(chatJid, { video: { url: r.gifs[0] }, gifPlayback: true, caption: `GIF preview 1/${r.gifs.length}\nUse !nextgif, then !bcastgif <caption>` }); }
      catch (e) { await reply(`❌ Send failed: ${e.message}`); }
      break;
    }
    case 'nextgif': {
      if (previewCache.gifUrls.length === 0) { await reply('❌ No preview. Use `!gif <query>` first.'); return; }
      previewCache.gifIndex = (previewCache.gifIndex + 1) % previewCache.gifUrls.length;
      previewCache.currentUrl = previewCache.gifUrls[previewCache.gifIndex];
      try { await sock.sendMessage(chatJid, { video: { url: previewCache.currentUrl }, gifPlayback: true, caption: `GIF preview ${previewCache.gifIndex + 1}/${previewCache.gifUrls.length}` }); }
      catch (e) { await reply(`❌ Send failed: ${e.message}`); }
      break;
    }

    // ── BROADCAST ──
    case 'all': case 'bcgroup': case 'bcdm': {
      const message = args.slice(1).join(' ');
      if (!message) { await reply(`❌ Usage: \`!${cmd} <message>\``); return; }
      const mode = cmd === 'all' ? 'all' : (cmd === 'bcgroup' ? 'groups' : 'dms');
      const count = mode === 'all' ? (joinedGroups.size + activeDMs.size)
                  : mode === 'groups' ? joinedGroups.size : activeDMs.size;
      if (count === 0) { await reply(`📭 No ${mode} targets.`); return; }
      await reply(`⏳ Broadcasting to ${count} (${mode})...`);
      const r = await broadcast({ message, mode });
      await reply(`✅ Done — Sent: *${r.sent}* / Failed: *${r.failed}*`);
      break;
    }
    case 'bcastpic': case 'bcastpicdm': case 'bcastpicgroup': {
      if (!previewCache.currentUrl || previewCache.currentType !== 'image') { await reply('❌ No image preview. Use `!pic <query>` first.'); return; }
      const caption = args.slice(1).join(' ') || '';
      const mode = cmd === 'bcastpic' ? 'all' : cmd === 'bcastpicdm' ? 'dms' : 'groups';
      const count = mode === 'all' ? (joinedGroups.size + activeDMs.size)
                  : mode === 'groups' ? joinedGroups.size : activeDMs.size;
      if (count === 0) { await reply(`📭 No ${mode} targets.`); return; }
      await reply(`⏳ Broadcasting image to ${count} (${mode})...`);
      const r = await broadcast({ message: caption, imageUrl: previewCache.currentUrl, mode });
      await reply(`✅ Done — Sent: *${r.sent}* / Failed: *${r.failed}*`);
      break;
    }
    case 'bcastgif': {
      if (!previewCache.currentUrl || previewCache.currentType !== 'gif') { await reply('❌ No GIF preview. Use `!gif <query>` first.'); return; }
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
      await reply(`📊 *Today (${s.date})*\nJoined: *${s.joined}*\nFailed: *${s.failed}*\nDM replies: *${s.dmsReplied}*\nBroadcasts: *${s.broadcastsSent}*\nGreetings: *${s.greetingsSent}*\nScraper searches: *${s.scraperSearches}*\nScraper GIFs: *${s.scraperGifs}*`);
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
  const rw = await askRewind('Say OK', 'Test.');
  tests.push(`Rewind AI: ${rw ? '✅' : '❌'}`);
  const st = await scraperStatus();
  tests.push(`Scraper /status: ${st.ok ? '✅' : '❌ ' + st.error}`);
  return ['🧪 *Test Suite*', '', ...tests, '',
    `🔌 WhatsApp: ${connectionStatus === 'connected' ? '✅' : `❌ ${connectionStatus}`}`,
    `📱 Bot: ${botNumber || '—'}`,
    `👥 Groups: ${joinedGroups.size}`,
    `💬 DMs: ${activeDMs.size}`,
    `📋 Queue: ${joinQueue.length}`,
    `🕒 ${Date.now() - t0}ms`].join('\n');
}

// ================================================================
// EXPRESS + FULL GUI
// ================================================================
const app = express();
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now(), status: connectionStatus, uptime: Math.floor((Date.now()-botStartTime)/1000) }));
app.get('/api/status', (req, res) => res.json({ status: connectionStatus, botNumber, groups: joinedGroups.size, dms: activeDMs.size, queue: joinQueue.length }));
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
    dailyStats, scraperStats
  });
});

const PANEL_HTML = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BreadBot v34</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:monospace;background:#0d1117;color:#c9d1d9;padding:16px}h1{font-size:20px;color:#58a6ff;margin-bottom:4px}.sub{font-size:12px;color:#8b949e;margin-bottom:16px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px}.card h2{font-size:12px;color:#8b949e;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px}button{background:#21262d;border:1px solid #30363d;color:#c9d1d9;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:13px;margin:3px;font-family:inherit}button:hover{background:#30363d;border-color:#58a6ff}button.primary{background:#238636;border-color:#2ea043;color:#fff}button.danger{background:#da3633;border-color:#f85149;color:#fff}#qrImg{width:100%;max-width:240px;border-radius:8px;margin:8px auto;display:block;background:#fff;padding:8px}.status-dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;vertical-align:middle}.s-connected{background:#3fb950;box-shadow:0 0 8px #3fb950}.s-qr{background:#d29922}.s-disconnected{background:#f85149}.s-reconnecting{background:#d29922;animation:pulse 1s infinite}.s-error{background:#f85149}@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}#logs,#msgs{height:300px;overflow-y:auto;font-size:12px;line-height:1.6;background:#0d1117;border-radius:6px;padding:8px}.log-entry{padding:3px 0;border-bottom:1px solid #21262d}.log-time{color:#484f58;margin-right:8px}.log-info{color:#58a6ff}.log-success{color:#3fb950}.log-warn{color:#d29922}.log-error{color:#f85149}.log-source{color:#8b949e;margin-right:6px}.stat-row{display:flex;justify-content:space-between;padding:5px 0;font-size:13px;border-bottom:1px solid #21262d}.stat-row:last-child{border-bottom:none}.stat-val{color:#58a6ff;font-weight:600}.msg-row{padding:6px 8px;margin:4px 0;border-radius:6px;background:#161b22;border-left:3px solid #58a6ff;font-size:12px}.msg-row.group{border-left-color:#a371f7}.msg-row.dm{border-left-color:#3fb950}.msg-meta{color:#8b949e;font-size:11px;margin-bottom:2px}.msg-name{color:#58a6ff;font-weight:600}.msg-text{color:#c9d1d9;word-break:break-word}.tag{display:inline-block;padding:1px 6px;border-radius:3px;font-size:10px;margin-left:6px;font-weight:600}.tag-group{background:#a371f7;color:#fff}.tag-dm{background:#3fb950;color:#000}.full-width{grid-column:1/-1}</style></head><body>
<h1>🥖 BreadBot v34</h1><div class="sub">Admin: <b>263777627210</b> · Scraper: <b id="scraperUrl">—</b></div>
<div class="grid">
<div class="card"><h2>Connection</h2><div style="margin-bottom:10px"><span class="status-dot" id="statusDot"></span><span id="statusText">Loading...</span></div><div class="stat-row"><span>Bot</span><span class="stat-val" id="botNum">—</span></div><div class="stat-row"><span>Uptime</span><span class="stat-val" id="statUptime">—</span></div><img id="qrImg" src="" style="display:none"><div style="margin-top:10px"><button class="primary" onclick="doAction('connect')">🔗 Start</button><button onclick="doAction('reconnect')">🔄 Reconnect</button><button onclick="doAction('refresh-qr')">♻️ Refresh QR</button><button class="danger" onclick="doAction('disconnect')">⛔ Disconnect</button></div></div>
<div class="card"><h2>Groups & Queue</h2><div class="stat-row"><span>Joined groups</span><span class="stat-val" id="statGroups">—</span></div><div class="stat-row"><span>DM chats</span><span class="stat-val" id="statDMs">—</span></div><div class="stat-row"><span>Queue</span><span class="stat-val" id="statQueue">—</span></div><div class="stat-row"><span>Last join</span><span class="stat-val" id="lastJoin">—</span></div></div>
<div class="card"><h2>Scraper Usage</h2><div class="stat-row"><span>Searches (ok / fail)</span><span class="stat-val" id="scSearch">—</span></div><div class="stat-row"><span>GIFs (ok / fail)</span><span class="stat-val" id="scGif">—</span></div><div class="stat-row"><span>Last search</span><span class="stat-val" id="scLastSearch">—</span></div><div class="stat-row"><span>Last GIF</span><span class="stat-val" id="scLastGif">—</span></div></div>
<div class="card"><h2>Today</h2><div class="stat-row"><span>Joined</span><span class="stat-val" id="dayJoined">—</span></div><div class="stat-row"><span>Failed</span><span class="stat-val" id="dayFailed">—</span></div><div class="stat-row"><span>DM replies</span><span class="stat-val" id="dayDMs">—</span></div><div class="stat-row"><span>Broadcasts</span><span class="stat-val" id="dayBC">—</span></div><div class="stat-row"><span>Greetings</span><span class="stat-val" id="dayGreet">—</span></div><div class="stat-row"><span>Scraper calls</span><span class="stat-val" id="dayScraper">—</span></div></div>
<div class="card full-width"><h2>📨 Live Messages</h2><div id="msgs"></div></div>
<div class="card full-width"><h2>📜 Logs</h2><div id="logs"></div></div>
</div>
<script>
const $=id=>document.getElementById(id);
async function api(p,m='GET'){const r=await fetch('/admin/'+p,{method:m});return r.json();}
function fmt(s){const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),x=s%60;return h+'h '+m+'m '+x+'s';}
function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function setStatus(st){$('statusDot').className='status-dot s-'+st;const l={connected:'Connected',qr:'Waiting for scan',disconnected:'Disconnected',reconnecting:'Reconnecting',error:'Error'};$('statusText').textContent=l[st]||st;}
async function refreshStats(){try{const d=await api('stats');setStatus(d.status);$('statUptime').textContent=fmt(d.uptime);$('botNum').textContent=d.botNumber||'—';$('statGroups').textContent=d.joinedGroups;$('statDMs').textContent=d.dmCount;$('statQueue').textContent=d.queueSize;$('lastJoin').textContent=d.lastJoinAt?new Date(d.lastJoinAt).toLocaleTimeString():'never';$('scraperUrl').textContent=d.scraperUrl||'—';const ss=d.scraperStats||{};$('scSearch').textContent=(ss.searchSuccess||0)+' / '+(ss.searchFail||0);$('scGif').textContent=(ss.gifSuccess||0)+' / '+(ss.gifFail||0);$('scLastSearch').textContent=ss.lastSearchQuery||'—';$('scLastGif').textContent=ss.lastGifQuery||'—';const s=d.dailyStats||{};$('dayJoined').textContent=s.joined||0;$('dayFailed').textContent=s.failed||0;$('dayDMs').textContent=s.dmsReplied||0;$('dayBC').textContent=s.broadcastsSent||0;$('dayGreet').textContent=s.greetingsSent||0;$('dayScraper').textContent=(s.scraperSearches||0)+'/'+(s.scraperGifs||0);const q=await api('qr-data');if(q.qr&&q.status==='qr'){$('qrImg').src='/admin/qr?t='+Date.now();$('qrImg').style.display='block';}else{$('qrImg').style.display='none';}}catch(e){}}
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
  if (connectionStatus === 'connected' && sock) { try { await sock.sendPresenceUpdate('available'); } catch (e) {} }
}, 4 * 60 * 1000);
setInterval(() => { axios.get(`http://localhost:${PORT}/health`).catch(() => {}); }, 4 * 60 * 1000);
setInterval(processJoinQueue, 30 * 1000);

// ================================================================
// STARTUP
// ================================================================
loadState();
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  pushLog('info', 'system', `Boot port ${PORT}`);
  pushLog('info', 'system', `Scraper: ${SCRAPER_URL}`);
  pushLog('info', 'system', `Join interval: ${JOIN_INTERVAL_MS/60000} min`);
  scheduleGreetings();
  scheduleDailyReport();
  connectBot().catch(err => { console.error('Boot failed:', err); pushLog('error', 'system', `Boot failed: ${err.message}`); });
});
