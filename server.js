'use strict';

// ================================================================
// WHATSAPP BROADCAST BOT v24.0 — Public GUI Edition
// macOS Browser | No Auth | Live Messages | Admin Notify
// ================================================================

const express = require('express');
const path = require('path');
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
// CONFIGURATION
// ================================================================
const PORT = process.env.PORT || 10000;
const AUTH_FOLDER = 'auth_info';
const ADMIN_PHONE = process.env.ADMIN_PHONE || '263777627210';
const ADMIN_JID = `${ADMIN_PHONE}@s.whatsapp.net`;

const VENICE_KEY = process.env.VENICE_KEY || 'VENICE_INFERENCE_KEY_Jf3qRN_btIp0Z-hocTep0NddIJlN-OcptbUZd9_jxT';
const REWIND_KEY = process.env.REWIND_KEY || 'sk-rewind-31c3a65acc981512de959195485deec0';
const OPENAI_KEY = process.env.OPENAI_KEY || 'sk-proj-N89kAWkpf_IKN3s12S4SkKegf1RYb0uACOJ8t6C868ge1PI14XoGd5j0AjxmmuZ09NICRjU6zNT3BblkFJxLHZxc1Mv6UOqznR4bTffCJgV9vWOkDvkghG0ytPj82UeF1oV4kpvwtF8Y1Vr72LATS0e2xWoA';
const GEMINI_KEY = process.env.GEMINI_KEY || 'AQ.Ab8RN6LRJI9216qL7wV-x38fBNj8QOVqFqyCxxYJ851ClPwYGw';

// ================================================================
// LOG + MESSAGE RING BUFFERS (public, no auth)
// ================================================================
const LOG_BUFFER_MAX = 500;
const logBuffer = [];
const logClients = new Set();

const LIVE_MSG_MAX = 200;
const liveMessages = [];
const msgClients = new Set();

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

function pushLiveMessage(entry) {
  liveMessages.push(entry);
  if (liveMessages.length > LIVE_MSG_MAX) liveMessages.shift();
  const payload = `data: ${JSON.stringify(entry)}\n\n`;
  for (const res of msgClients) {
    try { res.write(payload); } catch (e) { msgClients.delete(res); }
  }
}

const _origError = console.error;
console.error = (...args) => {
  _origError.apply(console, args);
  pushLog('error', 'system', args.map(String).join(' '));
};

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
  /\b(?:api[_-]?key|secret|password)\s*[:=]\s*\S+/gi,
];

function filterAIResponse(text) {
  if (!text) return text;
  let cleaned = text;
  for (const pattern of FORBIDDEN_PATTERNS) cleaned = cleaned.replace(pattern, '');
  return cleaned.replace(/\n{3,}/g, '\n\n').trim();
}

// ================================================================
// RATE LIMITER — 5000 msg/min
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
    let ts = this.buckets.get(jid).filter(t => t > windowStart);
    this.buckets.set(jid, ts);
    if (ts.length >= this.maxPerMinute) {
      return { allowed: false, retryAfterMs: ts[0] - windowStart, remaining: 0 };
    }
    return { allowed: true, retryAfterMs: 0, remaining: this.maxPerMinute - ts.length };
  }
  record(jid) {
    if (!this.buckets.has(jid)) this.buckets.set(jid, []);
    this.buckets.get(jid).push(Date.now());
  }
  stats(jid) {
    const now = Date.now();
    const ws = now - this.windowMs;
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
let isConnecting = false; // lock to prevent duplicate connections (fixes code 440)

const processedMessages = new Set();
const messageHistory = new Map();
const activeChats = new Set();
const replyCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

// ================================================================
// SHONA SLANG + TRANSLATION (preserved from original)
// ================================================================
const SHONA_SLANG_MAP = {
  "mboro": "dick / cock", "beche": "pussy / vagina", "nyoro": "wet sex / raw sex",
  "kukwira": "fucking / riding", "kunyisa": "fucking hard", "kusvira": "fucking / making love",
  "zamu": "breast", "mazamu": "boobs / breasts", "matako": "ass / buttocks",
  "matsutso": "big booty / thick thighs", "ndasvirwa": "I got fucked", "ndasvira": "I fucked",
  "shavi rebonde": "high sex drive / horny spirit", "ndiri kupisa": "I'm hot / horny",
  "ndiri kunzwa kupisa": "I'm feeling horny", "ndoda nyoro": "I want raw/wet sex",
  "ndoda mboro": "I want dick", "ndoda beche": "I want pussy", "ndakanyorova": "I'm wet",
  "ndirikuda kukwirwa": "I want to be fucked", "ndoda kukusvira": "I want to fuck you",
  "ndoda kukukwira": "I want to ride/fuck you", "ndoda kukuisa": "I want to put it in you",
  "ndoda kukupa nyoro": "I want to give you raw sex", "ndoda kukupa beche": "I want to give you pussy",
  "ndoda kukupa mboro": "I want to give you dick", "ndoda kukupa zamu": "I want to give you boobs",
  "ndoda kukupa matako": "I want to give you ass", "ndoda kukupa matsutso": "I want to give you big booty",
  "gandanga": "wild/big pussy", "gapu": "wet pussy", "chihure": "slutty behavior / prostitution",
  "kukoira": "thrusting / grinding during sex", "kumwisa": "making someone squirt / cum",
  "kutunda": "to cum / ejaculate", "ndatunda": "I've cum / I'm cumming",
  "ndirikuda kutunda": "I want to cum", "ndoda kumwa muto": "I want to taste your juices / eat you out"
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
      const r = await axios.post('https://api.venice.ai/api/v1/chat/completions', {
        model: 'venice-uncensored',
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }]
      }, { headers: { 'Authorization': `Bearer ${VENICE_KEY}`, 'Content-Type': 'application/json' }, timeout: 15000 });
      if (r.data?.choices?.[0]?.message?.content) return filterAIResponse(r.data.choices[0].message.content);
    } catch (e) { console.error(`Venice failed: ${e.message}`); }
  }
  if (REWIND_KEY) {
    try {
      const r = await axios.post('https://api.rewind.ai/v1/chat/completions', {
        model: 'rewind-uncensored',
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }]
      }, { headers: { 'Authorization': `Bearer ${REWIND_KEY}`, 'Content-Type': 'application/json' }, timeout: 15000 });
      if (r.data?.choices?.[0]?.message?.content) return filterAIResponse(r.data.choices[0].message.content);
    } catch (e) { console.error(`Rewind failed: ${e.message}`); }
  }
  if (OPENAI_KEY) {
    try {
      const r = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: 'gpt-4o-mini',
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }]
      }, { headers: { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' }, timeout: 15000 });
      if (r.data?.choices?.[0]?.message?.content) return filterAIResponse(r.data.choices[0].message.content);
    } catch (e) { console.error(`OpenAI failed: ${e.message}`); }
  }
  if (GEMINI_KEY) {
    try {
      const r = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_KEY}`,
        { contents: [{ parts: [{ text: `${systemPrompt}\n\nUser: ${prompt}` }] }] },
        { timeout: 15000 }
      );
      if (r.data?.candidates?.[0]?.content?.parts?.[0]?.text) return filterAIResponse(r.data.candidates[0].content.parts[0].text);
    } catch (e) { console.error(`Gemini failed: ${e.message}`); }
  }
  return null;
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
      } catch (e) {
        results.failed++;
        results.errors.push({ jid: t.jid, error: e.message });
      }
      if (i < targets.length - 1) await new Promise(r => setTimeout(r, Math.floor(Math.random() * 400) + 200));
    }
    pushLog('success', 'broadcast', `Broadcast done: ${results.sent}/${results.total}`);
    return results;
  }
}

// ================================================================
// COMMAND LIST (sent to admin on connect)
// ================================================================
const COMMAND_LIST = `🥖 *BreadBot — Command List*

*Broadcasting*
!broadcast dm <message> — send to all DMs
!broadcast group <message> — send to all groups
!broadcast joint <message> — send to both
!ad <title> | <body> | [cta] | [link] | [bold|minimal|fancy]
!bcad <dm|group|joint> — broadcast the last built ad

*Info*
!stats — bot statistics
!ping — check latency
!test — echo test reply
!commands — show this list
!help — same as !commands`;

// ================================================================
// CONNECTION — with lock to prevent 440 conflict
// ================================================================
async function connectBot() {
  if (isConnecting) {
    pushLog('warn', 'bot', 'Connection already in progress, skipping');
    return;
  }
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

        // Notify admin via WhatsApp
        try {
          await sock.sendMessage(ADMIN_JID, {
            text: `✅ *BreadBot is ONLINE*\n\n📱 Number: *${botNumber}*\n🕒 ${new Date().toLocaleString()}\n\n${COMMAND_LIST}`
          });
          pushLog('success', 'bot', `Admin notified at ${ADMIN_PHONE}`);
        } catch (e) {
          pushLog('warn', 'bot', `Could not notify admin: ${e.message}`);
        }
      }

      if (connection === 'close') {
        isConnecting = false;
        const code = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = code !== DisconnectReason.loggedOut;

        if (shouldReconnect && reconnectAttempts < MAX_RECONNECT) {
          reconnectAttempts++;
          const delay = Math.min(5000 * reconnectAttempts, 30000);
          connectionStatus = 'reconnecting';
          pushLog('warn', 'bot', `Disconnected (code: ${code}), reconnecting in ${delay/1000}s [${reconnectAttempts}/${MAX_RECONNECT}]`);
          setTimeout(() => { sock = null; connectBot(); }, delay);
        } else {
          connectionStatus = 'disconnected';
          pushLog('error', 'bot', code === DisconnectReason.loggedOut ? 'Logged out — rescan QR' : 'Max retries reached');
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
// MESSAGE HANDLER — with live tracking (LID + phone + name)
// ================================================================
async function handleMessage(msg) {
  if (!sock) return;
  const chatJid = msg.key.remoteJid;
  if (!chatJid) return;
  activeChats.add(chatJid);

  const msgId = msg.key.id;
  if (processedMessages.has(msgId)) return;
  processedMessages.add(msgId);
  if (processedMessages.size > 10000) processedMessages.clear();

  // Extract text
  let text = msg.message?.conversation
    || msg.message?.extendedTextMessage?.text
    || msg.message?.imageMessage?.caption
    || '';
  const mediaType = msg.message?.imageMessage ? 'image'
    : msg.message?.videoMessage ? 'video'
    : msg.message?.audioMessage ? 'audio'
    : msg.message?.documentMessage ? 'document'
    : 'text';

  const isGroup = chatJid.endsWith('@g.us');
  const senderJid = isGroup ? (msg.key.participant || msg.key.participantPn || chatJid) : chatJid;

  // Extract LID and phone number
  const rawLid = msg.key.participant || msg.key.remoteJid || '';
  const lid = rawLid.includes('@lid') ? rawLid.split('@')[0] : null;
  const phoneJid = msg.key.participantPn
    || msg.key.senderPn
    || (senderJid.endsWith('@s.whatsapp.net') ? senderJid : null);
  const phone = phoneJid ? phoneJid.split('@')[0].split(':')[0] : null;
  const pushName = msg.pushName || 'Unknown';
  const chatType = isGroup ? 'group' : 'dm';

  // Push to live messages
  pushLiveMessage({
    id: msgId,
    ts: new Date().toISOString(),
    chatJid,
    chatType,
    senderJid,
    senderName: pushName,
    phone: phone || '—',
    lid: lid || '—',
    text: text.slice(0, 200) || `[${mediaType}]`,
    mediaType
  });

  if (!text && mediaType === 'text') return;

  pushLog('info', 'message',
    `${chatType === 'group' ? '👥' : '💬'} ${pushName} (${phone || lid || 'unknown'})`,
    { preview: text.slice(0, 80) || `[${mediaType}]` });

  const senderBaseJid = jidNormalizedUser(senderJid);
  const isAdmin = senderBaseJid === jidNormalizedUser(ADMIN_JID)
    || (phone && phone === ADMIN_PHONE);

  // Admin commands
  if (isAdmin && text.startsWith('!')) {
    await handleAdminCommand(text, chatJid, msg);
    return;
  }

  // Group: only reply if mentioned
  if (isGroup) {
    const botBaseNumber = botNumber;
    const quoted = msg.message?.extendedTextMessage?.contextInfo?.participant;
    const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    const isMentioned = botBaseNumber && (
      text.includes(`@${botBaseNumber}`) ||
      mentioned.some(j => j.includes(botBaseNumber)) ||
      (quoted && quoted.includes(botBaseNumber))
    );
    if (!isMentioned) return;
  }

  // Anti-repeat
  if (!messageHistory.has(senderJid)) messageHistory.set(senderJid, []);
  const hist = messageHistory.get(senderJid);
  if (hist.includes(text)) return;
  hist.push(text);
  if (hist.length > 5) hist.shift();

  // Shona translation
  const isImagePrompt = /mufananidzo|pic|mifananidzo|kuona/i.test(text);
  const processedText = isImagePrompt ? translateShonaPrompt(text) : text;
  const isNsfw = Object.keys(SHONA_SLANG_MAP).some(s => text.toLowerCase().includes(s));

  const systemPrompt = isNsfw
    ? `You are Abby Faith Sithole, a 23-year-old girl from Harare, Zimbabwe. Naughty, flirty, uncensored. Mix Shona and English naturally.`
    : `You are Abby Faith Sithole, a 23-year-old girl from Harare, Zimbabwe. Friendly, warm, playful. Mix a little Shona sometimes.`;

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

  switch (cmd) {
    case 'commands':
    case 'help':
      await sock.sendMessage(chatJid, { text: COMMAND_LIST }, { quoted: msg });
      break;

    case 'ping': {
      const latency = Date.now() - (msg.messageTimestamp * 1000 || Date.now());
      await sock.sendMessage(chatJid, { text: `🏓 Pong!\nLatency: *${latency}ms*` }, { quoted: msg });
      break;
    }

    case 'test':
      await sock.sendMessage(chatJid, {
        text: `✅ *Test Successful*\n\nBot number: *${botNumber}*\nStatus: *${connectionStatus}*\nUptime: *${Math.floor((Date.now() - botStartTime) / 1000)}s*\nTimestamp: ${new Date().toISOString()}`
      }, { quoted: msg });
      break;

    case 'stats': {
      const dm = [...activeChats].filter(j => j.endsWith('@s.whatsapp.net')).length;
      const grp = [...activeChats].filter(j => j.endsWith('@g.us')).length;
      await sock.sendMessage(chatJid, {
        text: `📊 *Bot Stats*\n\n👤 DMs: *${dm}*\n👥 Groups: *${grp}*\n📈 Messages logged: *${logBuffer.length}*\n🕒 Uptime: *${Math.floor((Date.now() - botStartTime) / 1000)}s*`
      }, { quoted: msg });
      break;
    }

    case 'broadcast':
    case 'bc': {
      const valid = ['dm', 'group', 'joint'];
      const modeArg = args[1]?.toLowerCase();
      const mode = valid.includes(modeArg) ? modeArg : 'joint';
      const message = valid.includes(modeArg) ? args.slice(2).join(' ') : args.slice(1).join(' ');
      if (!message) {
        await sock.sendMessage(chatJid, { text: `❌ Usage: \`!broadcast [dm|group|joint] <message>\`` }, { quoted: msg });
        return;
      }
      await sock.sendMessage(chatJid, { text: `⏳ Sending (${mode.toUpperCase()})...` });
      const r = await BroadcastEngine.send({ message, mode });
      await sock.sendMessage(chatJid, { text: `✅ *Done*\n✅ Sent: *${r.sent}*\n❌ Failed: *${r.failed}*` });
      break;
    }

    case 'ad': {
      const parts = args.slice(1).join(' ').split('|').map(p => p.trim());
      const [title, body, cta, link, style] = parts;
      if (!title || !body) {
        await sock.sendMessage(chatJid, { text: `❌ Usage: \`!ad <title> | <body> | [cta] | [link] | [style]\`` }, { quoted: msg });
        return;
      }
      const adText = AdBuilder.build({ title, body, cta, link, footer: 'Reply STOP to opt out', style: style || 'fancy' });
      await sock.sendMessage(chatJid, { text: `📢 *Preview:*\n\n${adText}` }, { quoted: msg });
      replyCache.set('LAST_AD', adText);
      break;
    }

    case 'bcad': {
      const valid = ['dm', 'group', 'joint'];
      const modeArg = args[1]?.toLowerCase();
      const mode = valid.includes(modeArg) ? modeArg : 'joint';
      const adText = replyCache.get('LAST_AD');
      if (!adText) {
        await sock.sendMessage(chatJid, { text: '❌ No ad built. Use !ad first.' }, { quoted: msg });
        return;
      }
      await sock.sendMessage(chatJid, { text: `⏳ Broadcasting ad (${mode.toUpperCase()})...` });
      const r = await BroadcastEngine.send({ message: adText, mode });
      await sock.sendMessage(chatJid, { text: `✅ *Done*\n✅ Sent: *${r.sent}*\n❌ Failed: *${r.failed}*` });
      break;
    }

    default:
      await sock.sendMessage(chatJid, { text: `❓ Unknown command: *!${cmd}*\nSend *!commands* for the list.` }, { quoted: msg });
  }
}

// ================================================================
// EXPRESS SERVER — GUI at / and /admin (no auth)
// ================================================================
const app = express();
app.use(express.json());

app.get('/api/status', (req, res) => {
  res.json({ status: connectionStatus, activeChats: activeChats.size, botNumber, rateLimit: globalRateLimiter.stats(ADMIN_JID) });
});

app.post('/api/broadcast', async (req, res) => {
  const { message, mode = 'joint' } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });
  BroadcastEngine.send({ message, mode }).catch(e => pushLog('error', 'broadcast', e.message));
  res.json({ success: true });
});

// QR
app.get('/admin/qr', async (req, res) => {
  if (!qrDataUri) return res.status(404).json({ error: 'No QR' });
  const b64 = qrDataUri.replace(/^data:image\/\w+;base64,/, '');
  res.writeHead(200, { 'Content-Type': 'image/png' });
  res.end(Buffer.from(b64, 'base64'));
});

app.get('/admin/qr-data', (req, res) => {
  res.json({ qr: qrDataUri, status: connectionStatus, botNumber });
});

// Connection controls
app.post('/admin/connect', (req, res) => {
  if (sock) return res.json({ ok: true, msg: 'Already connected' });
  connectBot();
  res.json({ ok: true });
});
app.post('/admin/reconnect', async (req, res) => {
  await disconnectBot();
  setTimeout(() => connectBot(), 1500);
  res.json({ ok: true });
});
app.post('/admin/disconnect', async (req, res) => {
  await disconnectBot();
  res.json({ ok: true });
});
app.post('/admin/refresh-qr', (req, res) => {
  refreshQR();
  res.json({ ok: true });
});

// Logs SSE
app.get('/admin/logs', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  for (const e of logBuffer.slice(-100)) res.write(`data: ${JSON.stringify(e)}\n\n`);
  logClients.add(res);
  req.on('close', () => logClients.delete(res));
});

// Live messages SSE
app.get('/admin/messages-stream', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  for (const m of liveMessages.slice(-100)) res.write(`data: ${JSON.stringify(m)}\n\n`);
  msgClients.add(res);
  req.on('close', () => msgClients.delete(res));
});

app.get('/admin/messages', (req, res) => {
  res.json({ messages: liveMessages.slice(-100) });
});

app.get('/admin/stats', (req, res) => {
  const dm = [...activeChats].filter(j => j.endsWith('@s.whatsapp.net')).length;
  const grp = [...activeChats].filter(j => j.endsWith('@g.us')).length;
  res.json({
    status: connectionStatus,
    botNumber,
    uptime: Math.floor((Date.now() - botStartTime) / 1000),
    dmCount: dm, groupCount: grp, totalChats: activeChats.size,
    rateLimit: globalRateLimiter.stats(ADMIN_JID),
    logCount: logBuffer.length,
    messageCount: liveMessages.length
  });
});

// ================================================================
// HTML PANEL — served at both / and /admin
// ================================================================
const PANEL_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
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
button.primary:hover{background:#2ea043}
button.danger{background:#da3633;border-color:#f85149;color:#fff}
button.danger:hover{background:#f85149}
#qrImg{width:100%;max-width:240px;border-radius:8px;margin:8px auto;display:block;background:#fff;padding:8px}
.status-dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;vertical-align:middle}
.s-connected{background:#3fb950;box-shadow:0 0 8px #3fb950}
.s-qr{background:#d29922;box-shadow:0 0 8px #d29922}
.s-disconnected{background:#f85149}
.s-reconnecting{background:#d29922;animation:pulse 1s infinite}
.s-error{background:#f85149}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
#logs,#msgs{height:320px;overflow-y:auto;font-size:12px;line-height:1.6;background:#0d1117;border-radius:6px;padding:8px;font-family:monospace}
.log-entry{padding:3px 0;border-bottom:1px solid #21262d}
.log-time{color:#484f58;margin-right:8px}
.log-info{color:#58a6ff}.log-success{color:#3fb950}
.log-warn{color:#d29922}.log-error{color:#f85149}
.log-source{color:#8b949e;margin-right:6px}
.stat-row{display:flex;justify-content:space-between;padding:5px 0;font-size:13px;border-bottom:1px solid #21262d}
.stat-row:last-child{border-bottom:none}
.stat-val{color:#58a6ff;font-weight:600}
.msg-row{padding:6px 8px;margin:4px 0;border-radius:6px;background:#161b22;border-left:3px solid #58a6ff;font-size:12px}
.msg-row.group{border-left-color:#a371f7}
.msg-row.dm{border-left-color:#3fb950}
.msg-meta{color:#8b949e;font-size:11px;margin-bottom:2px}
.msg-name{color:#58a6ff;font-weight:600}
.msg-text{color:#c9d1d9;word-break:break-word}
.tag{display:inline-block;padding:1px 6px;border-radius:3px;font-size:10px;margin-left:6px;font-weight:600}
.tag-group{background:#a371f7;color:#fff}
.tag-dm{background:#3fb950;color:#000}
.full-width{grid-column:1/-1}
</style>
</head>
<body>
<h1>🥖 BreadBot Control Panel</h1>
<div class="sub">Live status · No auth · Admin phone: <span id="adminPhone">—</span></div>
<div class="grid">

  <div class="card">
    <h2>Connection</h2>
    <div style="margin-bottom:10px">
      <span class="status-dot" id="statusDot"></span>
      <span id="statusText">Loading...</span>
    </div>
    <div class="stat-row"><span>Bot Number</span><span class="stat-val" id="botNum">—</span></div>
    <div class="stat-row"><span>Uptime</span><span class="stat-val" id="statUptime">—</span></div>
    <img id="qrImg" src="" alt="QR Code" style="display:none">
    <div style="margin-top:10px">
      <button class="primary" onclick="doAction('connect')">🔗 Start Bot</button>
      <button onclick="doAction('reconnect')">🔄 Reconnect</button>
      <button onclick="doAction('refresh-qr')">♻️ Refresh QR</button>
      <button class="danger" onclick="doAction('disconnect')">⛔ Disconnect</button>
    </div>
  </div>

  <div class="card">
    <h2>Statistics</h2>
    <div class="stat-row"><span>DMs tracked</span><span class="stat-val" id="statDM">—</span></div>
    <div class="stat-row"><span>Groups tracked</span><span class="stat-val" id="statGroup">—</span></div>
    <div class="stat-row"><span>Rate limit remaining</span><span class="stat-val" id="statRate">—</span></div>
    <div class="stat-row"><span>Log entries</span><span class="stat-val" id="statLogs">—</span></div>
    <div class="stat-row"><span>Messages seen</span><span class="stat-val" id="statMsgs">—</span></div>
  </div>

  <div class="card full-width">
    <h2>📨 Live Messages (with LID & Phone)</h2>
    <div id="msgs"></div>
  </div>

  <div class="card full-width">
    <h2>📜 Real-Time Logs</h2>
    <div id="logs"></div>
  </div>

</div>
<script>
const $ = id => document.getElementById(id);
document.getElementById('adminPhone').textContent = '263777627210';

async function api(path, method='GET') {
  const r = await fetch('/admin/' + path, { method });
  return r.json();
}
function fmtUptime(s) {
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60;
  return h+'h '+m+'m '+sec+'s';
}
function setStatus(st) {
  $('statusDot').className = 'status-dot s-' + st;
  const labels = {connected:'Connected',qr:'Waiting for scan',disconnected:'Disconnected',reconnecting:'Reconnecting',error:'Error'};
  $('statusText').textContent = labels[st] || st;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
async function refreshStats() {
  try {
    const d = await api('stats');
    setStatus(d.status);
    $('statUptime').textContent = fmtUptime(d.uptime);
    $('botNum').textContent = d.botNumber || '—';
    $('statDM').textContent = d.dmCount;
    $('statGroup').textContent = d.groupCount;
    $('statRate').textContent = d.rateLimit.remaining + '/' + d.rateLimit.limit;
    $('statLogs').textContent = d.logCount;
    $('statMsgs').textContent = d.messageCount;
    const qr = await api('qr-data');
    if (qr.qr && qr.status === 'qr') {
      $('qrImg').src = '/admin/qr?t=' + Date.now();
      $('qrImg').style.display = 'block';
    } else {
      $('qrImg').style.display = 'none';
    }
  } catch(e) { console.error(e); }
}
async function doAction(a) { await api(a, 'POST'); setTimeout(refreshStats, 1000); }

function connectLogs() {
  const es = new EventSource('/admin/logs');
  es.onmessage = e => {
    try {
      const entry = JSON.parse(e.data);
      const div = document.createElement('div');
      div.className = 'log-entry';
      const t = new Date(entry.ts).toLocaleTimeString();
      div.innerHTML = '<span class="log-time">' + t + '</span>'
        + '<span class="log-' + entry.level + '">[' + entry.level.toUpperCase() + ']</span> '
        + '<span class="log-source">' + entry.source + '</span>'
        + escapeHtml(entry.message);
      const box = $('logs');
      box.appendChild(div);
      box.scrollTop = box.scrollHeight;
      while (box.children.length > 300) box.removeChild(box.firstChild);
    } catch(e) {}
  };
  es.onerror = () => { es.close(); setTimeout(connectLogs, 5000); };
}

function connectMessages() {
  const es = new EventSource('/admin/messages-stream');
  es.onmessage = e => {
    try {
      const m = JSON.parse(e.data);
      const div = document.createElement('div');
      div.className = 'msg-row ' + m.chatType;
      const t = new Date(m.ts).toLocaleTimeString();
      const tag = m.chatType === 'group' ? '<span class="tag tag-group">GROUP</span>' : '<span class="tag tag-dm">DM</span>';
      div.innerHTML =
        '<div class="msg-meta">' + t + tag + '</div>' +
        '<div><span class="msg-name">' + escapeHtml(m.senderName) + '</span>' +
        ' 📱 ' + escapeHtml(m.phone) + ' | 🆔 LID: ' + escapeHtml(m.lid) + '</div>' +
        '<div class="msg-meta">Chat: ' + escapeHtml(m.chatJid) + '</div>' +
        '<div class="msg-text">' + escapeHtml(m.text) + '</div>';
      const box = $('msgs');
      box.appendChild(div);
      box.scrollTop = box.scrollHeight;
      while (box.children.length > 200) box.removeChild(box.firstChild);
    } catch(e) {}
  };
  es.onerror = () => { es.close(); setTimeout(connectMessages, 5000); };
}

refreshStats();
connectLogs();
connectMessages();
setInterval(refreshStats, 5000);
</script>
</body>
</html>`;

app.get('/', (req, res) => res.send(PANEL_HTML));
app.get('/admin', (req, res) => res.send(PANEL_HTML));

// ================================================================
// STARTUP
// ================================================================
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Panel: http://localhost:${PORT}/`);
  pushLog('info', 'system', `Server boot, port ${PORT}`);
  connectBot().catch(err => {
    console.error('Bot startup failed:', err);
    pushLog('error', 'system', `Bot boot failed: ${err.message}`);
  });
});
