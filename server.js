'use strict';

// ================================================================
// WHATSAPP BROADCAST BOT v25.0 — Public GUI + Full Test Suite
// LID-aware admin detection | Keep-alive | Test-all endpoint
// ================================================================

const express = require('express');
const fs = require('fs');
const NodeCache = require('node-cache');
const {
  makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  Browsers,
  fetchLatestBaileysVersion,
  jidNormalizedUser
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');
const axios = require('axios');

// ================================================================
// CONFIG
// ================================================================
const PORT = process.env.PORT || 10000;
const AUTH_FOLDER = 'auth_info';
const ADMIN_PHONE = process.env.ADMIN_PHONE || '263777627210';
const ADMIN_JID = `${ADMIN_PHONE}@s.whatsapp.net`;
const WEBSCRAPER_URL = process.env.WEBSCRAPER_URL || '';

const VENICE_KEY = process.env.VENICE_KEY || 'VENICE_INFERENCE_KEY_Jf3qRN_btIp0Z-hocTep0NddIJlN-OcptbUZd9_jxT';
const REWIND_KEY = process.env.REWIND_KEY || 'sk-rewind-31c3a65acc981512de959195485deec0';
const OPENAI_KEY = process.env.OPENAI_KEY || 'sk-proj-N89kAWkpf_IKN3s12S4SkKegf1RYb0uACOJ8t6C868ge1PI14XoGd5j0AjxmmuZ09NICRjU6zNT3BblkFJxLHZxc1Mv6UOqznR4bTffCJgV9vWOkDvkghG0ytPj82UeF1oV4kpvwtF8Y1Vr72LATS0e2xWoA';
const GEMINI_KEY = process.env.GEMINI_KEY || 'AQ.Ab8RN6LRJI9216qL7wV-x38fBNj8QOVqFqyCxxYJ851ClPwYGw';

// ================================================================
// LOG / LIVE MESSAGE BUFFERS
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

const _origError = console.error;
console.error = (...args) => { _origError.apply(console, args); pushLog('error', 'system', args.map(String).join(' ')); };

// ================================================================
// ADMIN LID PERSISTENCE — remembers admin across LID/phone changes
// ================================================================
const ADMIN_LIDS_FILE = 'admin_lids.json';
let adminLids = new Set();

function loadAdminLids() {
  try {
    if (fs.existsSync(ADMIN_LIDS_FILE)) {
      const data = JSON.parse(fs.readFileSync(ADMIN_LIDS_FILE, 'utf8'));
      adminLids = new Set(data.lids || []);
      console.log(`[ADMIN] Loaded ${adminLids.size} admin LIDs from disk`);
    }
  } catch (e) { console.error('Load admin LIDs failed:', e.message); }
}

function saveAdminLids() {
  try { fs.writeFileSync(ADMIN_LIDS_FILE, JSON.stringify({ lids: [...adminLids], updated: new Date().toISOString() }, null, 2)); }
  catch (e) { console.error('Save admin LIDs failed:', e.message); }
}

function registerAdminLid(lid) {
  if (!lid || adminLids.has(lid)) return;
  adminLids.add(lid);
  saveAdminLids();
  pushLog('success', 'admin', `Registered admin LID: ${lid}`);
}

// ================================================================
// ROBUST PHONE / LID EXTRACTION
// ================================================================
function extractPhone(msg, senderJid) {
  const candidates = [
    msg.key?.participantPn,
    msg.key?.senderPn,
    msg.key?.remoteJidAlt,
    msg.key?.participantAlt,
    senderJid
  ].filter(Boolean);
  for (const c of candidates) {
    if (typeof c === 'string' && c.endsWith('@s.whatsapp.net')) {
      return c.split('@')[0].split(':')[0];
    }
  }
  return null;
}

function extractLid(msg, senderJid) {
  const candidates = [senderJid, msg.key?.remoteJid, msg.key?.participant].filter(Boolean);
  for (const c of candidates) {
    if (typeof c === 'string' && c.includes('@lid')) return c.split('@')[0];
  }
  return null;
}

function isAdminSender(msg, phone, lid, senderJid) {
  // 1. Direct phone match
  if (phone && phone === ADMIN_PHONE) {
    if (lid) registerAdminLid(lid);
    return true;
  }
  // 2. Direct JID match
  if (senderJid && jidNormalizedUser(senderJid) === jidNormalizedUser(ADMIN_JID)) return true;
  // 3. Previously registered LID
  if (lid && adminLids.has(lid)) return true;
  // 4. Any alternate JID carrying the admin phone
  const alternates = [msg.key?.participantAlt, msg.key?.remoteJidAlt, msg.key?.participantPn, msg.key?.senderPn].filter(Boolean);
  for (const alt of alternates) {
    const altPhone = typeof alt === 'string' ? alt.split('@')[0].split(':')[0] : null;
    if (altPhone === ADMIN_PHONE) {
      if (lid) registerAdminLid(lid);
      return true;
    }
  }
  return false;
}

// ================================================================
// AI RESPONSE FILTER
// ================================================================
const FORBIDDEN_PATTERNS = [
  /<\|[^|>]*\|>/g,
  /<think>[\s\S]*?<\/think>/gi,
  /\{"token|"usage"|"prompt_tokens"|"completion_tokens"/gi,
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g,
  /sk-[A-Za-z0-9\-]{20,}/g,
  /VENICE_INFERENCE_KEY_[A-Za-z0-9_\-]+/g,
  /\b(?:api[_-]?key|secret|password)\s*[:=]\s*\S+/gi
];

function filterAIResponse(text) {
  if (!text) return text;
  let cleaned = text;
  for (const pattern of FORBIDDEN_PATTERNS) cleaned = cleaned.replace(pattern, '');
  return cleaned.replace(/\n{3,}/g, '\n\n').trim();
}

// ================================================================
// RATE LIMITER
// ================================================================
class RateLimiter {
  constructor(maxPerMinute = 5000) { this.maxPerMinute = maxPerMinute; this.windowMs = 60000; this.buckets = new Map(); }
  check(jid) {
    const now = Date.now(), ws = now - this.windowMs;
    if (!this.buckets.has(jid)) this.buckets.set(jid, []);
    const ts = this.buckets.get(jid).filter(t => t > ws);
    this.buckets.set(jid, ts);
    if (ts.length >= this.maxPerMinute) return { allowed: false, retryAfterMs: ts[0] - ws, remaining: 0 };
    return { allowed: true, retryAfterMs: 0, remaining: this.maxPerMinute - ts.length };
  }
  record(jid) { if (!this.buckets.has(jid)) this.buckets.set(jid, []); this.buckets.get(jid).push(Date.now()); }
  stats(jid) {
    const now = Date.now(), ws = now - this.windowMs;
    const ts = (this.buckets.get(jid) || []).filter(t => t > ws);
    return { sentLastMinute: ts.length, limit: this.maxPerMinute, remaining: Math.max(0, this.maxPerMinute - ts.length) };
  }
}
const globalRateLimiter = new RateLimiter(5000);

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
const replyCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

// ================================================================
// SHONA SLANG + TRANSLATION (preserved)
// ================================================================
const SHONA_SLANG_MAP = {
  "mboro":"dick / cock","beche":"pussy / vagina","nyoro":"wet sex / raw sex","kukwira":"fucking / riding","kunyisa":"fucking hard","kusvira":"fucking / making love","zamu":"breast","mazamu":"boobs / breasts","matako":"ass / buttocks","matsutso":"big booty / thick thighs","ndasvirwa":"I got fucked","ndasvira":"I fucked","shavi rebonde":"high sex drive / horny spirit","ndiri kupisa":"I'm hot / horny","ndiri kunzwa kupisa":"I'm feeling horny","ndoda nyoro":"I want raw/wet sex","ndoda mboro":"I want dick","ndoda beche":"I want pussy","ndakanyorova":"I'm wet","ndirikuda kukwirwa":"I want to be fucked","ndoda kukusvira":"I want to fuck you","ndoda kukukwira":"I want to ride/fuck you","ndoda kukuisa":"I want to put it in you","ndoda kukupa nyoro":"I want to give you raw sex","ndoda kukupa beche":"I want to give you pussy","ndoda kukupa mboro":"I want to give you dick","ndoda kukupa zamu":"I want to give you boobs","ndoda kukupa matako":"I want to give you ass","ndoda kukupa matsutso":"I want to give you big booty","gandanga":"wild/big pussy","gapu":"wet pussy","chihure":"slutty behavior / prostitution","kukoira":"thrusting / grinding during sex","kumwisa":"making someone squirt / cum","kutunda":"to cum / ejaculate","ndatunda":"I've cum / I'm cumming","ndirikuda kutunda":"I want to cum","ndoda kumwa muto":"I want to taste your juices / eat you out"
};
const SHONA_IMAGE_PROMPTS = [
  { pattern: /ndoda mufananidzo we/i, replace: "I want a picture of" },
  { pattern: /nditumire pic ye/i, replace: "send me a picture of" },
  { pattern: /ndipe mufananidzo we/i, replace: "give me a picture of" },
  { pattern: /ndiratidze mufananidzo we/i, replace: "show me a picture of" },
  { pattern: /ndoda kuona/i, replace: "I want to see" },
  { pattern: /ndiratidze/i, replace: "show me" },
  { pattern: /nditumire/i, replace: "send me" },
  { pattern: /mufananidzo/i, replace: "picture" },
  { pattern: /mifananidzo/i, replace: "pictures" }
];
function translateShonaPrompt(text) {
  let t = text;
  for (const item of SHONA_IMAGE_PROMPTS) t = t.replace(item.pattern, item.replace);
  return t.split(/\s+/).map(w => {
    const clean = w.toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, "");
    return SHONA_SLANG_MAP[clean] || w;
  }).join(' ');
}

// ================================================================
// AI FALLBACK CHAIN
// ================================================================
async function askAI(prompt, systemPrompt, jid) {
  if (VENICE_KEY) {
    try {
      const r = await axios.post('https://api.venice.ai/api/v1/chat/completions', { model: 'venice-uncensored', messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }] }, { headers: { 'Authorization': `Bearer ${VENICE_KEY}`, 'Content-Type': 'application/json' }, timeout: 15000 });
      if (r.data?.choices?.[0]?.message?.content) return filterAIResponse(r.data.choices[0].message.content);
    } catch (e) { console.error(`Venice failed: ${e.message}`); }
  }
  if (REWIND_KEY) {
    try {
      const r = await axios.post('https://api.rewind.ai/v1/chat/completions', { model: 'rewind-uncensored', messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }] }, { headers: { 'Authorization': `Bearer ${REWIND_KEY}`, 'Content-Type': 'application/json' }, timeout: 15000 });
      if (r.data?.choices?.[0]?.message?.content) return filterAIResponse(r.data.choices[0].message.content);
    } catch (e) { console.error(`Rewind failed: ${e.message}`); }
  }
  if (OPENAI_KEY) {
    try {
      const r = await axios.post('https://api.openai.com/v1/chat/completions', { model: 'gpt-4o-mini', messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }] }, { headers: { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' }, timeout: 15000 });
      if (r.data?.choices?.[0]?.message?.content) return filterAIResponse(r.data.choices[0].message.content);
    } catch (e) { console.error(`OpenAI failed: ${e.message}`); }
  }
  if (GEMINI_KEY) {
    try {
      const r = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_KEY}`, { contents: [{ parts: [{ text: `${systemPrompt}\n\nUser: ${prompt}` }] }] }, { timeout: 15000 });
      if (r.data?.candidates?.[0]?.content?.parts?.[0]?.text) return filterAIResponse(r.data.candidates[0].content.parts[0].text);
    } catch (e) { console.error(`Gemini failed: ${e.message}`); }
  }
  return null;
}

// ================================================================
// INDIVIDUAL AI TESTS (for /admin/test-all)
// ================================================================
async function testVenice() {
  const t0 = Date.now();
  try {
    const r = await axios.post('https://api.venice.ai/api/v1/chat/completions', { model: 'venice-uncensored', messages: [{ role: 'user', content: 'Reply with exactly: OK' }], max_tokens: 10 }, { headers: { 'Authorization': `Bearer ${VENICE_KEY}`, 'Content-Type': 'application/json' }, timeout: 10000 });
    return { ok: true, ms: Date.now() - t0, sample: (r.data?.choices?.[0]?.message?.content || '').slice(0, 40) };
  } catch (e) { return { ok: false, ms: Date.now() - t0, error: e.response?.status ? `HTTP ${e.response.status}` : e.message }; }
}
async function testRewind() {
  const t0 = Date.now();
  try {
    const r = await axios.post('https://api.rewind.ai/v1/chat/completions', { model: 'rewind-uncensored', messages: [{ role: 'user', content: 'Reply with exactly: OK' }], max_tokens: 10 }, { headers: { 'Authorization': `Bearer ${REWIND_KEY}`, 'Content-Type': 'application/json' }, timeout: 10000 });
    return { ok: true, ms: Date.now() - t0, sample: (r.data?.choices?.[0]?.message?.content || '').slice(0, 40) };
  } catch (e) { return { ok: false, ms: Date.now() - t0, error: e.response?.status ? `HTTP ${e.response.status}` : e.message }; }
}
async function testOpenAI() {
  const t0 = Date.now();
  try {
    const r = await axios.post('https://api.openai.com/v1/chat/completions', { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Reply with exactly: OK' }], max_tokens: 10 }, { headers: { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' }, timeout: 10000 });
    return { ok: true, ms: Date.now() - t0, sample: (r.data?.choices?.[0]?.message?.content || '').slice(0, 40) };
  } catch (e) { return { ok: false, ms: Date.now() - t0, error: e.response?.status ? `HTTP ${e.response.status}` : e.message }; }
}
async function testGemini() {
  const t0 = Date.now();
  try {
    const r = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_KEY}`, { contents: [{ parts: [{ text: 'Reply with exactly: OK' }] }] }, { timeout: 10000 });
    return { ok: true, ms: Date.now() - t0, sample: (r.data?.candidates?.[0]?.content?.parts?.[0]?.text || '').slice(0, 40) };
  } catch (e) { return { ok: false, ms: Date.now() - t0, error: e.response?.status ? `HTTP ${e.response.status}` : e.message }; }
}
async function testWebscrapper() {
  if (!WEBSCRAPER_URL) return { ok: false, error: 'WEBSCRAPER_URL not configured' };
  const t0 = Date.now();
  try {
    const r = await axios.get(WEBSCRAPER_URL, { timeout: 10000, responseType: 'arraybuffer', maxRedirects: 3 });
    const ct = r.headers?.['content-type'] || '';
    return { ok: true, ms: Date.now() - t0, status: r.status, contentType: ct, bytes: r.data?.length || 0 };
  } catch (e) { return { ok: false, ms: Date.now() - t0, error: e.response?.status ? `HTTP ${e.response.status}` : e.message }; }
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
// BROADCAST ENGINE
// ================================================================
class BroadcastEngine {
  static collectTargets(mode = 'joint') {
    const t = [];
    if (mode === 'dm' || mode === 'joint') for (const j of activeChats) if (j.endsWith('@s.whatsapp.net')) t.push({ jid: j, type: 'dm' });
    if (mode === 'group' || mode === 'joint') for (const j of activeChats) if (j.endsWith('@g.us')) t.push({ jid: j, type: 'group' });
    return t;
  }
  static async send({ message, image = null, mode = 'joint' }) {
    if (!sock) throw new Error('Bot not connected');
    const targets = this.collectTargets(mode);
    const results = { sent: 0, failed: 0, total: targets.length, errors: [], mode };
    pushLog('info', 'broadcast', `Broadcast start: ${targets.length} targets (${mode})`);
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      const lim = globalRateLimiter.check(t.jid);
      if (!lim.allowed) await new Promise(r => setTimeout(r, lim.retryAfterMs + 100));
      try {
        const c = image ? { image: image.buffer, mimetype: image.mimetype || 'image/jpeg', caption: message } : { text: message };
        await sock.sendMessage(t.jid, c);
        globalRateLimiter.record(t.jid);
        results.sent++;
      } catch (e) { results.failed++; results.errors.push({ jid: t.jid, error: e.message }); }
      if (i < targets.length - 1) await new Promise(r => setTimeout(r, Math.floor(Math.random() * 400) + 200));
    }
    pushLog('success', 'broadcast', `Broadcast done: ${results.sent}/${results.total}`);
    return results;
  }
}

// ================================================================
// COMMAND LIST
// ================================================================
const COMMAND_LIST = `🥖 *BreadBot — Commands*

*Diagnostics*
!test — basic bot status test
!testall — full test suite (all AI APIs, webscrapper, WhatsApp)
!whoami — show your IDs and admin status
!ping — latency check
!commands / !help — this list

*Stats*
!stats — DM/group counts, uptime
!adminlids — list registered admin LIDs

*Broadcasting*
!broadcast dm <msg> — all DMs
!broadcast group <msg> — all groups
!broadcast joint <msg> — both
!ad <title> | <body> | [cta] | [link] | [bold|minimal|fancy]
!bcad <dm|group|joint> — broadcast last built ad`;

// ================================================================
// CONNECTION (with lock)
// ================================================================
async function connectBot() {
  if (isConnecting) { pushLog('warn', 'bot', 'Connection already in progress'); return; }
  isConnecting = true;
  try {
    pushLog('info', 'bot', 'Initializing connection...');
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      browser: Browsers.macOS('Desktop'),
      logger: pino({ level: 'silent' }),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      getMessage: async () => undefined
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        qrDataUri = await QRCode.toDataURL(qr);
        connectionStatus = 'qr';
        pushLog('info', 'bot', 'QR generated, waiting for scan');
      }
      if (connection === 'open') {
        isConnecting = false;
        connectionStatus = 'connected';
        reconnectAttempts = 0;
        botStartTime = Date.now();
        botNumber = sock.user?.id?.split(':')[0]?.split('@')[0] || 'unknown';
        pushLog('success', 'bot', `✅ Connected as ${botNumber}`);
        try {
          await sock.sendMessage(ADMIN_JID, { text: `✅ *BreadBot ONLINE*\n\n📱 *${botNumber}*\n🕒 ${new Date().toLocaleString()}\n\n${COMMAND_LIST}` });
          pushLog('success', 'bot', `Admin notified at ${ADMIN_PHONE}`);
        } catch (e) { pushLog('warn', 'bot', `Admin notify failed: ${e.message}`); }
      }
      if (connection === 'close') {
        isConnecting = false;
        const code = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = code !== DisconnectReason.loggedOut;
        if (shouldReconnect && reconnectAttempts < MAX_RECONNECT) {
          reconnectAttempts++;
          const delay = Math.min(5000 * reconnectAttempts, 30000);
          connectionStatus = 'reconnecting';
          pushLog('warn', 'bot', `Disconnected (${code}), retry in ${delay/1000}s [${reconnectAttempts}/${MAX_RECONNECT}]`);
          setTimeout(() => { sock = null; connectBot(); }, delay);
        } else {
          connectionStatus = 'disconnected';
          pushLog('error', 'bot', code === DisconnectReason.loggedOut ? 'Logged out — rescan QR' : 'Max retries reached');
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
  if (sock) {
    try { sock.end(undefined); } catch (e) {}
    sock = null;
    connectionStatus = 'disconnected';
    qrDataUri = null;
    isConnecting = false;
    pushLog('warn', 'bot', 'Disconnected manually');
  }
}

function refreshQR() {
  qrDataUri = null;
  connectionStatus = 'disconnected';
  disconnectBot();
  setTimeout(() => connectBot(), 1500);
}

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

  pushLiveMessage({
    id: msgId,
    ts: new Date().toISOString(),
    chatJid, chatType, senderJid,
    senderName: pushName,
    phone: phone || '—',
    lid: lid || '—',
    text: text.slice(0, 200) || `[${mediaType}]`,
    mediaType
  });

  if (!text && mediaType === 'text') return;

  pushLog('info', 'message', `${chatType === 'group' ? '👥' : '💬'} ${pushName} (${phone || lid || 'unknown'})`, { preview: text.slice(0, 80) || `[${mediaType}]` });

  const isAdmin = isAdminSender(msg, phone, lid, senderJid);

  if (isAdmin && text.startsWith('!')) {
    pushLog('info', 'admin', `Admin command: ${text.split(' ')[0]}`);
    await handleAdminCommand(text, chatJid, msg);
    return;
  }

  if (isGroup) {
    const botBase = botNumber;
    const quoted = msg.message?.extendedTextMessage?.contextInfo?.participant;
    const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    const isMentioned = botBase && (text.includes(`@${botBase}`) || mentioned.some(j => j.includes(botBase)) || (quoted && quoted.includes(botBase)));
    if (!isMentioned) return;
  }

  if (!messageHistory.has(senderJid)) messageHistory.set(senderJid, []);
  const hist = messageHistory.get(senderJid);
  if (hist.includes(text)) return;
  hist.push(text);
  if (hist.length > 5) hist.shift();

  const isImagePrompt = /mufananidzo|pic|mifananidzo|kuona/i.test(text);
  const processedText = isImagePrompt ? translateShonaPrompt(text) : text;
  const isNsfw = Object.keys(SHONA_SLANG_MAP).some(s => text.toLowerCase().includes(s));
  const systemPrompt = isNsfw
    ? `You are Abby Faith Sithole, 23, from Harare, Zimbabwe. Naughty, flirty, uncensored. Mix Shona and English.`
    : `You are Abby Faith Sithole, 23, from Harare, Zimbabwe. Friendly, warm, playful. Mix a little Shona sometimes.`;

  const aiReply = await askAI(processedText, systemPrompt, chatJid);
  if (aiReply) {
    pushLog('info', 'ai', `AI reply to ${pushName}`);
    await sock.sendMessage(chatJid, { text: aiReply }, { quoted: msg });
  } else {
    pushLog('warn', 'ai', `No AI reply for ${pushName}`);
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
    case 'commands':
    case 'help':
      await reply(COMMAND_LIST);
      break;

    case 'ping':
      await reply(`🏓 Pong!\nStatus: *${connectionStatus}*\nUptime: *${Math.floor((Date.now()-botStartTime)/1000)}s*`);
      break;

    case 'test':
      await reply(`✅ *Test OK*\n\nBot: *${botNumber}*\nStatus: *${connectionStatus}*\nUptime: *${Math.floor((Date.now()-botStartTime)/1000)}s*\nChats: *${activeChats.size}*\nAdmin LIDs: *${adminLids.size}*`);
      break;

    case 'whoami':
      await reply(`🔍 *Who Are You?*\n\nYour JID: *${msg.key.participant || msg.key.remoteJid}*\nYour Phone: *${extractPhone(msg, chatJid) || 'not detected'}*\nYour LID: *${extractLid(msg, chatJid) || 'not detected'}*\nChat: *${chatJid}*\n\nRegistered admin LIDs:\n${[...adminLids].map(l => '• ' + l).join('\n') || '(none)'}\n\nAdmin phone expected: *${ADMIN_PHONE}*`);
      break;

    case 'adminlids':
      await reply(`📋 *Registered Admin LIDs*\n\n${[...adminLids].map(l => '• ' + l).join('\n') || '(none)'}\n\nAuto-register happens when a message arrives with phone *${ADMIN_PHONE}*.`);
      break;

    case 'testall': {
      await reply('🧪 *Running full test suite...* (may take ~15s)');
      const report = await runFullTestSuite();
      await reply(report);
      break;
    }

    case 'stats': {
      const dm = [...activeChats].filter(j => j.endsWith('@s.whatsapp.net')).length;
      const grp = [...activeChats].filter(j => j.endsWith('@g.us')).length;
      await reply(`📊 *Stats*\n\n👤 DMs: *${dm}*\n👥 Groups: *${grp}*\n📈 Log entries: *${logBuffer.length}*\n💬 Messages seen: *${liveMessages.length}*\n🔑 Admin LIDs: *${adminLids.size}*\n🕒 Uptime: *${Math.floor((Date.now()-botStartTime)/1000)}s*`);
      break;
    }

    case 'broadcast':
    case 'bc': {
      const valid = ['dm', 'group', 'joint'];
      const modeArg = args[1]?.toLowerCase();
      const mode = valid.includes(modeArg) ? modeArg : 'joint';
      const message = valid.includes(modeArg) ? args.slice(2).join(' ') : args.slice(1).join(' ');
      if (!message) { await reply(`❌ Usage: \`!broadcast [dm|group|joint] <message>\``); return; }
      await reply(`⏳ Broadcasting (${mode.toUpperCase()})...`);
      const r = await BroadcastEngine.send({ message, mode });
      await reply(`✅ *Done*\n✅ Sent: *${r.sent}*\n❌ Failed: *${r.failed}*`);
      break;
    }

    case 'ad': {
      const parts = args.slice(1).join(' ').split('|').map(p => p.trim());
      const [title, body, cta, link, style] = parts;
      if (!title || !body) { await reply(`❌ Usage: \`!ad <title> | <body> | [cta] | [link] | [style]\``); return; }
      const adText = AdBuilder.build({ title, body, cta, link, footer: 'Reply STOP to opt out', style: style || 'fancy' });
      await reply(`📢 *Preview:*\n\n${adText}`);
      replyCache.set('LAST_AD', adText);
      break;
    }

    case 'bcad': {
      const valid = ['dm', 'group', 'joint'];
      const modeArg = args[1]?.toLowerCase();
      const mode = valid.includes(modeArg) ? modeArg : 'joint';
      const adText = replyCache.get('LAST_AD');
      if (!adText) { await reply('❌ No ad built. Use !ad first.'); return; }
      await reply(`⏳ Broadcasting ad (${mode.toUpperCase()})...`);
      const r = await BroadcastEngine.send({ message: adText, mode });
      await reply(`✅ *Done*\n✅ Sent: *${r.sent}*\n❌ Failed: *${r.failed}*`);
      break;
    }

    default:
      await reply(`❓ Unknown: *!${cmd}*\nSend *!commands* for the list.`);
  }
}

// ================================================================
// FULL TEST SUITE
// ================================================================
async function runFullTestSuite() {
  const t0 = Date.now();
  const [venice, rewind, openai, gemini, webscrapper] = await Promise.all([
    testVenice(), testRewind(), testOpenAI(), testGemini(), testWebscrapper()
  ]);
  const fmt = (name, r) => r.ok
    ? `✅ *${name}* — ${r.ms}ms${r.sample ? `\n   ↳ _${r.sample}_` : ''}`
    : `❌ *${name}* — ${r.ms}ms\n   ↳ ${r.error}`;
  const results = [
    '🧪 *Full Test Suite Report*',
    '',
    fmt('Venice AI', venice),
    fmt('Rewind AI', rewind),
    fmt('OpenAI', openai),
    fmt('Gemini', gemini),
    fmt('Webscrapper', webscrapper),
    '',
    `🔌 *WhatsApp*: ${connectionStatus === 'connected' ? '✅ connected' : '❌ ' + connectionStatus}`,
    `📱 *Bot number*: ${botNumber || '—'}`,
    `💬 *Chats tracked*: ${activeChats.size}`,
    `👤 *DMs*: ${[...activeChats].filter(j => j.endsWith('@s.whatsapp.net')).length}`,
    `👥 *Groups*: ${[...activeChats].filter(j => j.endsWith('@g.us')).length}`,
    `🔑 *Admin LIDs*: ${adminLids.size}`,
    `📢 *Broadcast targets (joint)*: ${BroadcastEngine.collectTargets('joint').length}`,
    '',
    `🕒 *Total*: ${Date.now() - t0}ms`
  ].join('\n');
  pushLog('info', 'test', `Full test suite ran in ${Date.now() - t0}ms`);
  return results;
}

// ================================================================
// EXPRESS SERVER
// ================================================================
const app = express();
app.use(express.json());

// External cron health-check
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now(), status: connectionStatus, uptime: Math.floor((Date.now()-botStartTime)/1000) }));

app.get('/api/status', (req, res) => res.json({ status: connectionStatus, activeChats: activeChats.size, botNumber, rateLimit: globalRateLimiter.stats(ADMIN_JID) }));

app.post('/api/broadcast', async (req, res) => {
  const { message, mode = 'joint' } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });
  BroadcastEngine.send({ message, mode }).catch(e => pushLog('error', 'broadcast', e.message));
  res.json({ success: true });
});

app.get('/admin/qr', async (req, res) => {
  if (!qrDataUri) return res.status(404).json({ error: 'No QR' });
  const b64 = qrDataUri.replace(/^data:image\/\w+;base64,/, '');
  res.writeHead(200, { 'Content-Type': 'image/png' });
  res.end(Buffer.from(b64, 'base64'));
});
app.get('/admin/qr-data', (req, res) => res.json({ qr: qrDataUri, status: connectionStatus, botNumber }));
app.post('/admin/connect', (req, res) => { if (sock) return res.json({ ok: true }); connectBot(); res.json({ ok: true }); });
app.post('/admin/reconnect', async (req, res) => { await disconnectBot(); setTimeout(connectBot, 1500); res.json({ ok: true }); });
app.post('/admin/disconnect', async (req, res) => { await disconnectBot(); res.json({ ok: true }); });
app.post('/admin/refresh-qr', (req, res) => { refreshQR(); res.json({ ok: true }); });

app.get('/admin/logs', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  for (const e of logBuffer.slice(-100)) res.write(`data: ${JSON.stringify(e)}\n\n`);
  logClients.add(res);
  req.on('close', () => logClients.delete(res));
});

app.get('/admin/messages-stream', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  for (const m of liveMessages.slice(-100)) res.write(`data: ${JSON.stringify(m)}\n\n`);
  msgClients.add(res);
  req.on('close', () => msgClients.delete(res));
});

app.get('/admin/messages', (req, res) => res.json({ messages: liveMessages.slice(-100) }));

app.get('/admin/stats', (req, res) => {
  const dm = [...activeChats].filter(j => j.endsWith('@s.whatsapp.net')).length;
  const grp = [...activeChats].filter(j => j.endsWith('@g.us')).length;
  res.json({
    status: connectionStatus, botNumber,
    uptime: Math.floor((Date.now()-botStartTime)/1000),
    dmCount: dm, groupCount: grp, totalChats: activeChats.size,
    rateLimit: globalRateLimiter.stats(ADMIN_JID),
    logCount: logBuffer.length, messageCount: liveMessages.length,
    adminLids: [...adminLids]
  });
});

app.get('/admin/test-all', async (req, res) => {
  const [venice, rewind, openai, gemini, webscrapper] = await Promise.all([testVenice(), testRewind(), testOpenAI(), testGemini(), testWebscrapper()]);
  res.json({
    ts: new Date().toISOString(),
    whatsapp: { status: connectionStatus, botNumber, uptime: Math.floor((Date.now()-botStartTime)/1000) },
    ai: { venice, rewind, openai, gemini },
    webscrapper,
    broadcast: { jointTargets: BroadcastEngine.collectTargets('joint').length, dmTargets: BroadcastEngine.collectTargets('dm').length, groupTargets: BroadcastEngine.collectTargets('group').length },
    adminLids: [...adminLids],
    buffers: { logs: logBuffer.length, messages: liveMessages.length }
  });
});

// ================================================================
// HTML PANEL
// ================================================================
const PANEL_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>BreadBot Control Panel</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',monospace;background:#0d1117;color:#c9d1d9;padding:16px}
h1{font-size:20px;color:#58a6ff;margin-bottom:4px}
.sub{font-size:12px;color:#8b949e;margin-bottom:16px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}
.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px}
.card h2{font-size:12px;color:#8b949e;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px}
button{background:#21262d;border:1px solid #30363d;color:#c9d1d9;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:13px;margin:3px;font-family:inherit}
button:hover{background:#30363d;border-color:#58a6ff}
button.primary{background:#238636;border-color:#2ea043;color:#fff}
button.danger{background:#da3633;border-color:#f85149;color:#fff}
#qrImg{width:100%;max-width:240px;border-radius:8px;margin:8px auto;display:block;background:#fff;padding:8px}
.status-dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;vertical-align:middle}
.s-connected{background:#3fb950;box-shadow:0 0 8px #3fb950}
.s-qr{background:#d29922}.s-disconnected{background:#f85149}
.s-reconnecting{background:#d29922;animation:pulse 1s infinite}.s-error{background:#f85149}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
#logs,#msgs,#testOut{height:300px;overflow-y:auto;font-size:12px;line-height:1.6;background:#0d1117;border-radius:6px;padding:8px;font-family:monospace}
.log-entry{padding:3px 0;border-bottom:1px solid #21262d}
.log-time{color:#484f58;margin-right:8px}
.log-info{color:#58a6ff}.log-success{color:#3fb950}.log-warn{color:#d29922}.log-error{color:#f85149}
.log-source{color:#8b949e;margin-right:6px}
.stat-row{display:flex;justify-content:space-between;padding:5px 0;font-size:13px;border-bottom:1px solid #21262d}
.stat-row:last-child{border-bottom:none}
.stat-val{color:#58a6ff;font-weight:600}
.msg-row{padding:6px 8px;margin:4px 0;border-radius:6px;background:#161b22;border-left:3px solid #58a6ff;font-size:12px}
.msg-row.group{border-left-color:#a371f7}.msg-row.dm{border-left-color:#3fb950}
.msg-meta{color:#8b949e;font-size:11px;margin-bottom:2px}
.msg-name{color:#58a6ff;font-weight:600}
.msg-text{color:#c9d1d9;word-break:break-word}
.tag{display:inline-block;padding:1px 6px;border-radius:3px;font-size:10px;margin-left:6px;font-weight:600}
.tag-group{background:#a371f7;color:#fff}.tag-dm{background:#3fb950;color:#000}
.full-width{grid-column:1/-1}
pre{white-space:pre-wrap;font-size:11px}
</style></head><body>
<h1>🥖 BreadBot Control Panel</h1>
<div class="sub">v25.0 · Admin phone: <b>263777627210</b> · <span id="adminLidCount">0</span> LIDs registered</div>
<div class="grid">

<div class="card"><h2>Connection</h2>
<div style="margin-bottom:10px"><span class="status-dot" id="statusDot"></span><span id="statusText">Loading...</span></div>
<div class="stat-row"><span>Bot Number</span><span class="stat-val" id="botNum">—</span></div>
<div class="stat-row"><span>Uptime</span><span class="stat-val" id="statUptime">—</span></div>
<img id="qrImg" src="" alt="QR" style="display:none">
<div style="margin-top:10px">
<button class="primary" onclick="doAction('connect')">🔗 Start</button>
<button onclick="doAction('reconnect')">🔄 Reconnect</button>
<button onclick="doAction('refresh-qr')">♻️ Refresh QR</button>
<button class="danger" onclick="doAction('disconnect')">⛔ Disconnect</button>
</div></div>

<div class="card"><h2>Statistics</h2>
<div class="stat-row"><span>DMs tracked</span><span class="stat-val" id="statDM">—</span></div>
<div class="stat-row"><span>Groups tracked</span><span class="stat-val" id="statGroup">—</span></div>
<div class="stat-row"><span>Rate limit remaining</span><span class="stat-val" id="statRate">—</span></div>
<div class="stat-row"><span>Log entries</span><span class="stat-val" id="statLogs">—</span></div>
<div class="stat-row"><span>Messages seen</span><span class="stat-val" id="statMsgs">—</span></div>
<div class="stat-row"><span>Admin LIDs</span><span class="stat-val" id="statAdminLids">—</span></div>
</div>

<div class="card full-width"><h2>🧪 Test Suite</h2>
<button class="primary" onclick="runTests()">▶️ Run Full Test Suite</button>
<pre id="testOut">Click "Run Full Test Suite" to test all AI APIs, webscrapper, WhatsApp, and broadcast engine.</pre>
</div>

<div class="card full-width"><h2>📨 Live Messages (LID + Phone)</h2><div id="msgs"></div></div>
<div class="card full-width"><h2>📜 Real-Time Logs</h2><div id="logs"></div></div>
</div>
<script>
const $ = id => document.getElementById(id);
async function api(p, m='GET'){const r=await fetch('/admin/'+p,{method:m});return r.json();}
function fmt(s){const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),x=s%60;return h+'h '+m+'m '+x+'s';}
function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function setStatus(st){$('statusDot').className='status-dot s-'+st;const l={connected:'Connected',qr:'Waiting for scan',disconnected:'Disconnected',reconnecting:'Reconnecting',error:'Error'};$('statusText').textContent=l[st]||st;}
async function refreshStats(){try{const d=await api('stats');setStatus(d.status);$('statUptime').textContent=fmt(d.uptime);$('botNum').textContent=d.botNumber||'—';$('statDM').textContent=d.dmCount;$('statGroup').textContent=d.groupCount;$('statRate').textContent=d.rateLimit.remaining+'/'+d.rateLimit.limit;$('statLogs').textContent=d.logCount;$('statMsgs').textContent=d.messageCount;$('statAdminLids').textContent=d.adminLids?.length||0;$('adminLidCount').textContent=d.adminLids?.length||0;const q=await api('qr-data');if(q.qr&&q.status==='qr'){$('qrImg').src='/admin/qr?t='+Date.now();$('qrImg').style.display='block';}else{$('qrImg').style.display='none';}}catch(e){}}
async function doAction(a){await api(a,'POST');setTimeout(refreshStats,1000);}
async function runTests(){$('testOut').textContent='Running...';try{const r=await api('test-all');$('testOut').textContent=JSON.stringify(r,null,2);}catch(e){$('testOut').textContent='Error: '+e.message;}}
function connectLogs(){const es=new EventSource('/admin/logs');es.onmessage=e=>{try{const en=JSON.parse(e.data);const div=document.createElement('div');div.className='log-entry';const t=new Date(en.ts).toLocaleTimeString();div.innerHTML='<span class="log-time">'+t+'</span><span class="log-'+en.level+'">['+en.level.toUpperCase()+']</span> <span class="log-source">'+en.source+'</span>'+esc(en.message);const b=$('logs');b.appendChild(div);b.scrollTop=b.scrollHeight;while(b.children.length>300)b.removeChild(b.firstChild);}catch(e){}};es.onerror=()=>{es.close();setTimeout(connectLogs,5000);};}
function connectMessages(){const es=new EventSource('/admin/messages-stream');es.onmessage=e=>{try{const m=JSON.parse(e.data);const div=document.createElement('div');div.className='msg-row '+m.chatType;const t=new Date(m.ts).toLocaleTimeString();const tag=m.chatType==='group'?'<span class="tag tag-group">GROUP</span>':'<span class="tag tag-dm">DM</span>';div.innerHTML='<div class="msg-meta">'+t+tag+'</div><div><span class="msg-name">'+esc(m.senderName)+'</span> 📱 '+esc(m.phone)+' | 🆔 LID: '+esc(m.lid)+'</div><div class="msg-meta">Chat: '+esc(m.chatJid)+'</div><div class="msg-text">'+esc(m.text)+'</div>';const b=$('msgs');b.appendChild(div);b.scrollTop=b.scrollHeight;while(b.children.length>200)b.removeChild(b.firstChild);}catch(e){}};es.onerror=()=>{es.close();setTimeout(connectMessages,5000);};}
refreshStats();connectLogs();connectMessages();setInterval(refreshStats,5000);
</script></body></html>`;

app.get('/', (req, res) => res.send(PANEL_HTML));
app.get('/admin', (req, res) => res.send(PANEL_HTML));

// ================================================================
// KEEP-ALIVE (WhatsApp presence + Render spin-down prevention)
// ================================================================
setInterval(async () => {
  if (connectionStatus === 'connected' && sock) {
    try {
      await sock.sendPresenceUpdate('available');
      pushLog('info', 'keepalive', 'Presence ping sent');
    } catch (e) { pushLog('warn', 'keepalive', `Presence failed: ${e.message}`); }
  }
}, 4 * 60 * 1000);

setInterval(() => {
  axios.get(`http://localhost:${PORT}/health`).catch(() => {});
}, 4 * 60 * 1000);

// ================================================================
// STARTUP
// ================================================================
loadAdminLids();
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Panel: http://localhost:${PORT}/`);
  pushLog('info', 'system', `Server boot, port ${PORT}`);
  connectBot().catch(err => { console.error('Bot startup failed:', err); pushLog('error', 'system', `Boot failed: ${err.message}`); });
});
