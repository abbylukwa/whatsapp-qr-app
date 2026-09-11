'use strict';

// ================================================================
// WHATSAPP BROADCAST BOT v23.1 — Admin GUI Edition
// DMs & Groups — separately or jointly
// Advertisement message builder
// Rate limit: 5,000 messages/minute
// Real Shona +18 Slang & Anti-Spam Integration
// Admin-only GUI: QR, logs, stats, connection control
// ================================================================

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const NodeCache = require('node-cache');
const {
  makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  Browsers,
  makeInMemoryStore,
  fetchLatestBaileysVersion,
  downloadContentFromMessage
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');
const axios = require('axios');
const basicAuth = require('express-basic-auth');

// ================================================================
// CONFIGURATION
// ================================================================
const PORT = process.env.PORT || 10000;
const AUTH_FOLDER = 'auth_info';
const ADMIN_PHONE = process.env.ADMIN_PHONE || '263777627210';
const ADMIN_JID = `${ADMIN_PHONE}@s.whatsapp.net`;

// API Keys
const VENICE_KEY = process.env.VENICE_KEY || 'VENICE_INFERENCE_KEY_Jf3qRN_btIp0Z-hocTep0NddIJlN-OcptbUZd9_jxT';
const REWIND_KEY = process.env.REWIND_KEY || 'sk-rewind-31c3a65acc981512de959195485deec0';
const OPENAI_KEY = process.env.OPENAI_KEY || 'sk-proj-N89kAWkpf_IKN3s12S4SkKegf1RYb0uACOJ8t6C868ge1PI14XoGd5j0AjxmmuZ09NICRjU6zNT3BblkFJxLHZxc1Mv6UOqznR4bTffCJgV9vWOkDvkghG0ytPj82UeF1oV4kpvwtF8Y1Vr72LATS0e2xWoA';
const GEMINI_KEY = process.env.GEMINI_KEY || 'AQ.Ab8RN6LRJI9216qL7wV-x38fBNj8QOVqFqyCxxYJ851ClPwYGw';

// ================================================================
// ADMIN AUTH — only admin sees GUI & logs
// ================================================================
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || crypto.randomBytes(8).toString('hex');

const adminAuth = basicAuth({
  users: { [ADMIN_USER]: ADMIN_PASS },
  challenge: true,
  realm: 'BreadBot Admin Panel',
});

// ================================================================
// LOG RING BUFFER — real-time logs (admin-only via SSE)
// ================================================================
const LOG_BUFFER_MAX = 500;
const logBuffer = [];
const logClients = new Set();

function pushLog(level, source, message, meta = {}) {
  const entry = {
    id: Date.now() + Math.random(),
    ts: new Date().toISOString(),
    level, source, message,
    meta: Object.keys(meta).length ? meta : undefined,
  };
  logBuffer.push(entry);
  if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();

  const payload = `data: ${JSON.stringify(entry)}\n\n`;
  for (const res of logClients) {
    try { res.write(payload); } catch (e) { logClients.delete(res); }
  }
}

// Intercept console.error for error logging
const _origError = console.error;
console.error = (...args) => {
  _origError.apply(console, args);
  pushLog('error', 'system', args.map(String).join(' '));
};

// ================================================================
// AI RESPONSE FILTER — strip tokens / metadata / internal info
// ================================================================
const FORBIDDEN_PATTERNS = [
  /<\|[^|>]*\|>/g,                    // special tokens: <|im_end|> etc.
  /<think>[\s\S]*?<\/think>/gi,       // thinking traces
  /\{"token|"usage"|"prompt_tokens"|"completion_tokens"/gi,
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g,  // Bearer tokens
  /sk-[A-Za-z0-9\-]{20,}/g,           // OpenAI-style keys
  /VENICE_INFERENCE_KEY_[A-Za-z0-9_\-]+/g,
  /\b(?:api[_-]?key|secret|password)\s*[:=]\s*\S+/gi,
];

function filterAIResponse(text) {
  if (!text) return text;
  let cleaned = text;
  for (const pattern of FORBIDDEN_PATTERNS) {
    cleaned = cleaned.replace(pattern, '');
  }
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();
  return cleaned;
}

// ================================================================
// RATE LIMITER — 5,000 messages per minute
// ================================================================
class RateLimiter {
  constructor(maxPerMinute = 5000) {
    this.maxPerMinute = maxPerMinute;
    this.windowMs = 60000;
    this.buckets = new Map();
  }
  check(jid) {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    if (!this.buckets.has(jid)) this.buckets.set(jid, []);
    let timestamps = this.buckets.get(jid).filter(ts => ts > windowStart);
    this.buckets.set(jid, timestamps);
    if (timestamps.length >= this.maxPerMinute) {
      const oldest = timestamps[0];
      const retryAfterMs = oldest - windowStart;
      return { allowed: false, retryAfterMs: Math.max(0, retryAfterMs), remaining: 0 };
    }
    return { allowed: true, retryAfterMs: 0, remaining: this.maxPerMinute - timestamps.length };
  }
  record(jid) {
    if (!this.buckets.has(jid)) this.buckets.set(jid, []);
    this.buckets.get(jid).push(Date.now());
  }
  stats(jid) {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    const timestamps = (this.buckets.get(jid) || []).filter(ts => ts > windowStart);
    return { sentLastMinute: timestamps.length, limit: this.maxPerMinute, remaining: Math.max(0, this.maxPerMinute - timestamps.length) };
  }
}
const globalRateLimiter = new RateLimiter(5000);

// ================================================================
// STATE & CACHES
// ================================================================
let sock = null;
let qrDataUri = null;
let connectionStatus = 'disconnected';
let botStartTime = Date.now();
let reconnectAttempts = 0;
const MAX_RECONNECT = 10;

const processedMessages = new Set();
const messageHistory = new Map();
const userSessions = new Map();
const activeChats = new Set();

let pendingBroadcastImage = null;
let broadcastTargets = [];
let broadcastMode = 'joint';
let broadcastProgress = null;
const replyCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

// ================================================================
// REAL SHONA +18 SLANG & TRANSLATION DICTIONARY
// ================================================================
const SHONA_SLANG_MAP = {
  "mboro": "dick / cock",
  "beche": "pussy / vagina",
  "nyoro": "wet sex / raw sex",
  "kukwira": "fucking / riding",
  "kunyisa": "fucking hard",
  "kusvira": "fucking / making love",
  "zamu": "breast",
  "mazamu": "boobs / breasts",
  "matako": "ass / buttocks",
  "matsutso": "big booty / thick thighs",
  "ndasvirwa": "I got fucked",
  "ndasvira": "I fucked",
  "shavi rebonde": "high sex drive / horny spirit",
  "ndiri kupisa": "I'm hot / horny",
  "ndiri kunzwa kupisa": "I'm feeling horny",
  "ndoda nyoro": "I want raw/wet sex",
  "ndoda mboro": "I want dick",
  "ndoda beche": "I want pussy",
  "ndakanyorova": "I'm wet",
  "ndirikuda kukwirwa": "I want to be fucked",
  "ndoda kukusvira": "I want to fuck you",
  "ndoda kukukwira": "I want to ride/fuck you",
  "ndoda kukuisa": "I want to put it in you",
  "ndoda kukupa nyoro": "I want to give you raw sex",
  "ndoda kukupa beche": "I want to give you pussy",
  "ndoda kukupa mboro": "I want to give you dick",
  "ndoda kukupa zamu": "I want to give you boobs",
  "ndoda kukupa matako": "I want to give you ass",
  "ndoda kukupa matsutso": "I want to give you big booty",
  "gandanga": "wild/big pussy",
  "gapu": "wet pussy",
  "chihure": "slutty behavior / prostitution",
  "kukoira": "thrusting / grinding during sex",
  "kumwisa": "making someone squirt / cum",
  "kutunda": "to cum / ejaculate",
  "ndatunda": "I've cum / I'm cumming",
  "ndirikuda kutunda": "I want to cum",
  "ndoda kumwa muto": "I want to taste your juices / eat you out"
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
  let translated = text;
  for (const item of SHONA_IMAGE_PROMPTS) {
    translated = translated.replace(item.pattern, item.replace);
  }
  const words = translated.split(/\s+/);
  const mappedWords = words.map(word => {
    const cleanWord = word.toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, "");
    if (SHONA_SLANG_MAP[cleanWord]) return SHONA_SLANG_MAP[cleanWord];
    return word;
  });
  return mappedWords.join(' ');
}

// ================================================================
// AI FALLBACK CHAIN (with response filtering)
// ================================================================
async function askAI(prompt, systemPrompt, jid) {
  if (VENICE_KEY) {
    try {
      const res = await axios.post('https://api.venice.ai/api/v1/chat/completions', {
        model: 'venice-uncensored',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt }
        ]
      }, {
        headers: { 'Authorization': `Bearer ${VENICE_KEY}`, 'Content-Type': 'application/json' },
        timeout: 15000
      });
      if (res.data?.choices?.[0]?.message?.content) {
        return filterAIResponse(res.data.choices[0].message.content);
      }
    } catch (err) { console.error(`Venice AI failed: ${err.message}`); }
  }

  if (REWIND_KEY) {
    try {
      const res = await axios.post('https://api.rewind.ai/v1/chat/completions', {
        model: 'rewind-uncensored',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt }
        ]
      }, {
        headers: { 'Authorization': `Bearer ${REWIND_KEY}`, 'Content-Type': 'application/json' },
        timeout: 15000
      });
      if (res.data?.choices?.[0]?.message?.content) {
        return filterAIResponse(res.data.choices[0].message.content);
      }
    } catch (err) { console.error(`Rewind AI failed: ${err.message}`); }
  }

  if (OPENAI_KEY) {
    try {
      const res = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt }
        ]
      }, {
        headers: { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
        timeout: 15000
      });
      if (res.data?.choices?.[0]?.message?.content) {
        return filterAIResponse(res.data.choices[0].message.content);
      }
    } catch (err) { console.error(`OpenAI failed: ${err.message}`); }
  }

  if (GEMINI_KEY) {
    try {
      const res = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_KEY}`,
        { contents: [{ parts: [{ text: `${systemPrompt}\n\nUser: ${prompt}` }] }] },
        { timeout: 15000 }
      );
      if (res.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
        return filterAIResponse(res.data.candidates[0].content.parts[0].text);
      }
    } catch (err) { console.error(`Gemini failed: ${err.message}`); }
  }

  return null;
}

// ================================================================
// ADVERTISEMENT MESSAGE BUILDER
// ================================================================
class AdBuilder {
  static build(opts = {}) {
    const { title, body, cta, link, footer, style = 'fancy' } = opts;
    switch (style) {
      case 'bold':
        return [
          `*${title || 'SPECIAL OFFER'}*`, '', body || '',
          cta ? `\n *${cta}*` : '', link ? `\n ${link}` : '',
          footer ? `\n_${footer}_` : ''
        ].filter(Boolean).join('\n');
      case 'minimal':
        return [title || '', body || '', cta || '', link || ''].filter(Boolean).join('\n\n');
      case 'fancy':
      default:
        const lines = [];
        lines.push('╔══════════════════════════╗');
        lines.push(`║ ✨ ${(title || 'SPECIAL OFFER').toUpperCase()} ✨`);
        lines.push('╚══════════════════════════╝');
        lines.push('');
        if (body) lines.push(body);
        lines.push('');
        if (cta) lines.push(` *${cta}*`);
        if (link) lines.push(` ${link}`);
        if (footer) lines.push(`\n_${footer}_`);
        return lines.join('\n');
    }
  }
}

// ================================================================
// ANTI-SPAM & GROUP MESSAGE FILTER
// ================================================================
function shouldReplyToGroup(msg, botJid) {
  const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
  if (!botJid) return false;
  const botNumber = botJid.split('@')[0];
  if (text.includes(`@${botNumber}`)) return true;
  const quotedParticipant = msg.message?.extendedTextMessage?.contextInfo?.participant;
  if (quotedParticipant === botJid) return true;
  return false;
}

// ================================================================
// BROADCAST ENGINE — DMs, Groups, or Joint
// ================================================================
class BroadcastEngine {
  static collectTargets(mode = 'joint') {
    const targets = [];
    if (mode === 'dm' || mode === 'joint') {
      for (const jid of activeChats) {
        if (jid.endsWith('@s.whatsapp.net')) {
          targets.push({ jid, type: 'dm', name: jid.split('@')[0] });
        }
      }
    }
    if (mode === 'group' || mode === 'joint') {
      for (const jid of activeChats) {
        if (jid.endsWith('@g.us')) {
          targets.push({ jid, type: 'group', name: jid.split('@')[0] });
        }
      }
    }
    return targets;
  }

  static async send({ message, image = null, mode = 'joint' }) {
    if (!sock) throw new Error('Bot not connected');
    const targets = this.collectTargets(mode);
    const results = { sent: 0, failed: 0, total: targets.length, errors: [], mode };
    console.log(`Broadcast starting: ${targets.length} targets (mode: ${mode})`);
    pushLog('info', 'broadcast', `开始广播: ${targets.length} 个目标 (mode: ${mode})`);

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      const limit = globalRateLimiter.check(target.jid);
      if (!limit.allowed) {
        const waitMs = limit.retryAfterMs + 100;
        console.log(`Rate limit hit for ${target.jid}, waiting ${waitMs}ms`);
        await new Promise(r => setTimeout(r, waitMs));
      }
      try {
        const msgContent = image
          ? { image: image.buffer, mimetype: image.mimetype || 'image/jpeg', caption: message }
          : { text: message };
        await sock.sendMessage(target.jid, msgContent);
        globalRateLimiter.record(target.jid);
        results.sent++;
        console.log(`✅ Sent to ${target.type}: ${target.name}`);
      } catch (err) {
        results.failed++;
        results.errors.push({ jid: target.jid, name: target.name, error: err.message });
        console.error(`❌ Failed ${target.type}: ${target.name} — ${err.message}`);
      }
      if (i < targets.length - 1) {
        await new Promise(r => setTimeout(r, Math.floor(Math.random() * 400) + 200));
      }
    }
    pushLog('success', 'broadcast', `广播完成: ${results.sent}/${results.total}`);
    return results;
  }
}

// ================================================================
// CONNECTION CONTROL — reconnect / disconnect / QR refresh
// ================================================================
async function connectBot() {
  try {
    pushLog('info', 'bot', '正在初始化连接...');
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      browser: Browsers.ubuntu('Chrome'),
      logger: pino({ level: 'silent' })
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        qrDataUri = await QRCode.toDataURL(qr);
        connectionStatus = 'qr';
        pushLog('info', 'bot', 'QR 码已生成，等待扫描');
      }

      if (connection === 'open') {
        connectionStatus = 'connected';
        reconnectAttempts = 0;
        botStartTime = Date.now();
        pushLog('success', 'bot', '✅ 已连接到 WhatsApp');
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = code !== DisconnectReason.loggedOut;

        if (shouldReconnect && reconnectAttempts < MAX_RECONNECT) {
          reconnectAttempts++;
          const delay = Math.min(5000 * reconnectAttempts, 30000);
          connectionStatus = 'reconnecting';
          pushLog('warn', 'bot',
            `连接断开 (code: ${code})，${delay/1000}s 后重连 [${reconnectAttempts}/${MAX_RECONNECT}]`);
          setTimeout(connectBot, delay);
        } else {
          connectionStatus = 'disconnected';
          pushLog('error', 'bot',
            code === DisconnectReason.loggedOut
              ? '已登出，需要重新扫描 QR 码'
              : '达到最大重连次数，请手动重连');
        }
      }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const msg of messages) {
        if (!msg.key.fromMe) await handleMessage(msg);
      }
    });
  } catch (err) {
    pushLog('error', 'bot', `连接失败: ${err.message}`);
    connectionStatus = 'error';
  }
}

async function disconnectBot() {
  if (sock) {
    try { sock.end(undefined); } catch (e) {}
    sock = null;
    connectionStatus = 'disconnected';
    qrDataUri = null;
    pushLog('warn', 'bot', '已手动断开连接');
  }
}

function refreshQR() {
  if (connectionStatus === 'qr') {
    qrDataUri = null;
    connectionStatus = 'disconnected';
  }
  disconnectBot();
  setTimeout(() => connectBot(), 1500);
}

// ================================================================
// MAIN MESSAGE HANDLER
// ================================================================
async function handleMessage(msg) {
  if (!sock) return;
  const jid = msg.key.remoteJid;
  if (!jid) return;
  activeChats.add(jid);

  const msgId = msg.key.id;
  if (processedMessages.has(msgId)) return;
  processedMessages.add(msgId);
  if (processedMessages.size > 10000) processedMessages.clear();

  let text = '';
  if (msg.message?.conversation) {
    text = msg.message.conversation;
  } else if (msg.message?.extendedTextMessage?.text) {
    text = msg.message.extendedTextMessage.text;
  } else if (msg.message?.imageMessage?.caption) {
    text = msg.message.imageMessage.caption;
  }
  if (!text) return;

  pushLog('info', 'message',
    `收到消息 from ${jid}${jid.endsWith('@g.us') ? ' (群组)' : ''}`,
    { preview: text.slice(0, 80) });

  const isGroupChat = jid.endsWith('@g.us');
  const senderJid = isGroupChat ? msg.key.participant : jid;
  const isAdmin = senderJid === ADMIN_JID;

  if (isGroupChat && !isAdmin && !shouldReplyToGroup(msg, sock.user?.id)) {
    return;
  }

  if (!messageHistory.has(senderJid)) messageHistory.set(senderJid, []);
  const history = messageHistory.get(senderJid);
  if (history.includes(text)) {
    console.log(`[ANTI-REPEAT] Ignoring duplicate message from ${senderJid}`);
    return;
  }
  history.push(text);
  if (history.length > 5) history.shift();

  const isImagePrompt = /mufananidzo|pic|mifananidzo|kuona/i.test(text);
  let processedText = text;
  if (isImagePrompt) {
    processedText = translateShonaPrompt(text);
    console.log(`[TRANSLATION] Translated Shona image prompt: "${text}" -> "${processedText}"`);
  }

  const isNsfw = Object.keys(SHONA_SLANG_MAP).some(slang => text.toLowerCase().includes(slang));

  if (isAdmin && text.startsWith('!')) {
    await handleAdminCommand(text, jid, msg);
    return;
  }

  const systemPrompt = isNsfw
    ? `You are Abby Faith Sithole, a 23-year-old girl from Harare, Zimbabwe. You are naughty, flirty, and uncensored. Use emojis, be playful, and talk like a real Zim girl. Mix Shona and English naturally.`
    : `You are Abby Faith Sithole, a 23-year-old girl from Harare, Zimbabwe. You are friendly, warm, and playful. Mix a little Shona sometimes.`;

  const aiReply = await askAI(processedText, systemPrompt, jid);

  if (aiReply) {
    pushLog('info', 'ai', `AI 已回复 ${jid}`, { filtered: true });
    await sock.sendMessage(jid, { text: aiReply }, { quoted: msg });
  } else {
    pushLog('warn', 'ai', `AI 无回复 ${jid}`);
  }
}

// ================================================================
// ADMIN COMMAND HANDLER
// ================================================================
async function handleAdminCommand(text, jid, msg) {
  const args = text.slice(1).trim().split(/\s+/);
  const cmd = args[0].toLowerCase();
  const rest = args.slice(1).join(' ');

  switch (cmd) {
    case 'broadcast':
    case 'bc': {
      const modeArg = args[1]?.toLowerCase();
      const validModes = ['dm', 'group', 'joint'];
      const mode = validModes.includes(modeArg) ? modeArg : 'joint';
      const message = validModes.includes(modeArg) ? args.slice(2).join(' ') : args.slice(1).join(' ');
      if (!message) {
        await sock.sendMessage(jid, { text: `❌ *Usage:* \`!broadcast [dm|group|joint] <message>\`` }, { quoted: msg });
        return;
      }
      await sock.sendMessage(jid, { text: `⏳ Sending broadcast (mode: ${mode.toUpperCase()})...` });
      const results = await BroadcastEngine.send({ message, mode });
      await sock.sendMessage(jid, { text: `✅ *Broadcast Complete*\n Sent: *${results.sent}*\n❌ Failed: *${results.failed}*` });
      break;
    }
    case 'ad': {
      const parts = rest.split('|').map(p => p.trim());
      const [title, body, cta, link, style] = parts;
      if (!title || !body) {
        await sock.sendMessage(jid, { text: ` *Ad Builder*\n\nUsage: \`!ad <title> | <body> | [cta] | [link] | [style]\`` }, { quoted: msg });
        return;
      }
      const adText = AdBuilder.build({ title, body, cta, link, footer: 'Reply STOP to opt out', style: style || 'fancy' });
      await sock.sendMessage(jid, { text: ` *Ad Preview:*\n\n${adText}` }, { quoted: msg });
      replyCache.set('LAST_AD', adText);
      break;
    }
    case 'bcad': {
      const modeArg = args[1]?.toLowerCase();
      const validModes = ['dm', 'group', 'joint'];
      const mode = validModes.includes(modeArg) ? modeArg : 'joint';
      const adText = replyCache.get('LAST_AD');
      if (!adText) {
        await sock.sendMessage(jid, { text: '❌ No ad built yet. Use !ad first.' }, { quoted: msg });
        return;
      }
      await sock.sendMessage(jid, { text: `⏳ Broadcasting ad (mode: ${mode.toUpperCase()})...` });
      const results = await BroadcastEngine.send({ message: adText, mode });
      await sock.sendMessage(jid, { text: `✅ *Ad Broadcast Complete*\n Sent: *${results.sent}*\n❌ Failed: *${results.failed}*` });
      break;
    }
    case 'stats': {
      const dmCount = [...activeChats].filter(j => j.endsWith('@s.whatsapp.net')).length;
      const groupCount = [...activeChats].filter(j => j.endsWith('@g.us')).length;
      await sock.sendMessage(jid, { text: ` *Bot Stats*\n DMs: *${dmCount}*\n Groups: *${groupCount}*` });
      break;
    }
  }
}

// ================================================================
// EXPRESS SERVER & GUI ROUTES
// ================================================================
const app = express();
app.use(express.json());

// --- Public API (original) ---
app.get('/api/status', (req, res) => {
  res.json({
    status: connectionStatus,
    activeChats: activeChats.size,
    rateLimit: globalRateLimiter.stats(ADMIN_JID)
  });
});

app.post('/api/broadcast', async (req, res) => {
  const { message, mode = 'joint' } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });
  pushLog('info', 'broadcast', `广播启动 (mode: ${mode})`);
  BroadcastEngine.send({ message, mode }).then(results => {
    pushLog('success', 'broadcast', `广播完成: ${results.sent}/${results.total}`);
  });
  res.json({ success: true, message: 'Broadcast started' });
});

// --- Admin-only routes ---

// QR code image (admin only)
app.get('/admin/qr', adminAuth, async (req, res) => {
  if (!qrDataUri) return res.status(404).json({ error: 'No QR code available' });
  const base64 = qrDataUri.replace(/^data:image\/\w+;base64,/, '');
  res.writeHead(200, { 'Content-Type': 'image/png' });
  res.end(Buffer.from(base64, 'base64'));
});

// QR data (JSON)
app.get('/admin/qr-data', adminAuth, (req, res) => {
  res.json({ qr: qrDataUri, status: connectionStatus });
});

// Connection control
app.post('/admin/connect', adminAuth, async (req, res) => {
  if (sock) return res.json({ ok: true, msg: 'Already connected' });
  connectBot();
  res.json({ ok: true, msg: 'Connecting...' });
});

app.post('/admin/reconnect', adminAuth, async (req, res) => {
  await disconnectBot();
  setTimeout(() => connectBot(), 1500);
  res.json({ ok: true, msg: 'Reconnecting...' });
});

app.post('/admin/disconnect', adminAuth, async (req, res) => {
  await disconnectBot();
  res.json({ ok: true, msg: 'Disconnected' });
});

app.post('/admin/refresh-qr', adminAuth, (req, res) => {
  refreshQR();
  res.json({ ok: true, msg: 'QR refreshing...' });
});

// Real-time logs via SSE (admin only)
app.get('/admin/logs', adminAuth, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  for (const entry of logBuffer.slice(-100)) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  }
  logClients.add(res);
  req.on('close', () => logClients.delete(res));
});

// System stats (AI performance, downloads, message counts)
app.get('/admin/stats', adminAuth, (req, res) => {
  const dmCount = [...activeChats].filter(j => j.endsWith('@s.whatsapp.net')).length;
  const groupCount = [...activeChats].filter(j => j.endsWith('@g.us')).length;
  res.json({
    status: connectionStatus,
    uptime: Math.floor((Date.now() - botStartTime) / 1000),
    dmCount,
    groupCount,
    totalChats: activeChats.size,
    rateLimit: globalRateLimiter.stats(ADMIN_JID),
    logCount: logBuffer.length
  });
});

// --- Admin panel HTML (admin only) ---
app.get('/admin', adminAuth, (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>BreadBot 管理面板</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',monospace;
     background:#0d1117;color:#c9d1d9;padding:16px}
h1{font-size:18px;color:#58a6ff;margin-bottom:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px}
.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px}
.card h2{font-size:13px;color:#8b949e;text-transform:uppercase;margin-bottom:10px}
button{background:#21262d;border:1px solid #30363d;color:#c9d1d9;
       padding:8px 14px;border-radius:6px;cursor:pointer;font-size:13px;margin:3px}
button:hover{background:#30363d;border-color:#58a6ff}
button.primary{background:#238636;border-color:#2ea043;color:#fff}
button.danger{background:#da3633;border-color:#f85149;color:#fff}
#qrImg{width:100%;max-width:260px;border-radius:8px;margin:8px auto;display:block;background:#fff;padding:8px}
.status-dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px}
.s-connected{background:#3fb950}.s-qr{background:#d29922}
.s-disconnected{background:#f85149}.s-reconnecting{background:#d29922}
.s-error{background:#f85149}
#logs{height:340px;overflow-y:auto;font-size:12px;line-height:1.6;
      background:#0d1117;border-radius:6px;padding:8px;font-family:monospace}
.log-entry{padding:2px 0;border-bottom:1px solid #21262d}
.log-time{color:#484f58;margin-right:8px}
.log-info{color:#58a6ff}.log-success{color:#3fb950}
.log-warn{color:#d29922}.log-error{color:#f85149}
.log-source{color:#8b949e;margin-right:6px}
.stat-row{display:flex;justify-content:space-between;padding:4px 0;font-size:13px}
.stat-val{color:#58a6ff;font-weight:600}
</style>
</head>
<body>
<h1>🥖 BreadBot 管理面板</h1>
<div class="grid">

  <div class="card">
    <h2>连接状态</h2>
    <div style="margin-bottom:10px">
      <span class="status-dot" id="statusDot"></span>
      <span id="statusText">加载中...</span>
    </div>
    <img id="qrImg" src="" alt="QR 码" style="display:none">
    <div>
      <button class="primary" onclick="doAction('connect')">🔗 启动 Bot</button>
      <button onclick="doAction('reconnect')">🔄 重连</button>
      <button onclick="doAction('refresh-qr')">♻️ 刷新 QR</button>
      <button class="danger" onclick="doAction('disconnect')">⛔ 断开</button>
    </div>
  </div>

  <div class="card">
    <h2>系统统计</h2>
    <div class="stat-row"><span>运行时间</span><span class="stat-val" id="statUptime">-</span></div>
    <div class="stat-row"><span>私聊数</span><span class="stat-val" id="statDM">-</span></div>
    <div class="stat-row"><span>群组数</span><span class="stat-val" id="statGroup">-</span></div>
    <div class="stat-row"><span>速率限制剩余</span><span class="stat-val" id="statRate">-</span></div>
    <div class="stat-row"><span>日志条数</span><span class="stat-val" id="statLogs">-</span></div>
  </div>

  <div class="card" style="grid-column:1/-1">
    <h2>实时日志（仅管理员可见）</h2>
    <div id="logs"></div>
  </div>

</div>
<script>
const $ = id => document.getElementById(id);

async function api(path, method='GET') {
  const r = await fetch('/admin/' + path, { method });
  return r.json();
}

function fmtUptime(s) {
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60;
  return h+'h '+m+'m '+sec+'s';
}

function setStatus(st) {
  const dot = $('statusDot');
  dot.className = 'status-dot s-' + st;
  const labels = {connected:'已连接',qr:'等待扫码',disconnected:'未连接',
                  reconnecting:'重连中',error:'错误'};
  $('statusText').textContent = labels[st] || st;
}

async function refreshStats() {
  try {
    const d = await api('stats');
    setStatus(d.status);
    $('statUptime').textContent = fmtUptime(d.uptime);
    $('statDM').textContent = d.dmCount;
    $('statGroup').textContent = d.groupCount;
    $('statRate').textContent = d.rateLimit.remaining + '/' + d.rateLimit.limit;
    $('statLogs').textContent = d.logCount;

    const qr = await api('qr-data');
    if (qr.qr && qr.status === 'qr') {
      $('qrImg').src = '/admin/qr?t=' + Date.now();
      $('qrImg').style.display = 'block';
    } else {
      $('qrImg').style.display = 'none';
    }
  } catch(e) { console.error('Stats refresh failed', e); }
}

async function doAction(action) {
  await api(action, 'POST');
  setTimeout(refreshStats, 1000);
}

function connectLogs() {
  const es = new EventSource('/admin/logs');
  es.onmessage = (e) => {
    try {
      const entry = JSON.parse(e.data);
      const div = document.createElement('div');
      div.className = 'log-entry';
      const t = new Date(entry.ts).toLocaleTimeString();
      div.innerHTML = '<span class="log-time">' + t + '</span>'
        + '<span class="log-' + entry.level + '">[' + entry.level.toUpperCase() + ']</span> '
        + '<span class="log-source">' + entry.source + '</span>'
        + escapeHtml(entry.message);
      const logs = $('logs');
      logs.appendChild(div);
      logs.scrollTop = logs.scrollHeight;
    } catch(err) {}
  };
  es.onerror = () => { es.close(); setTimeout(connectLogs, 5000); };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

refreshStats();
connectLogs();
setInterval(refreshStats, 5000);
</script>
</body>
</html>`);
});

// ================================================================
// STARTUP
// ================================================================
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Admin panel: http://localhost:${PORT}/admin`);
  console.log(`Admin user: ${ADMIN_USER}`);
  if (!process.env.ADMIN_PASS) {
    console.log(`Auto-generated admin password: ${ADMIN_PASS}`);
  }
  pushLog('info', 'system', `服务器启动，端口 ${PORT}`);
  connectBot().catch(err => {
    console.error('Bot startup failed:', err);
    pushLog('error', 'system', `Bot 启动失败: ${err.message}`);
  });
});
