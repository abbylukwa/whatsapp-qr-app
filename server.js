'use strict';

// ================================================================
// WHATSAPP BOT v28.0
// Group: Ollama (qwen2:0.5b) | DM: Rewind + Scraper
// Phone-only admin | Humanized replies | Anti-repetition
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
const ADMIN_PHONE = (process.env.ADMIN_PHONE || '263777627210').replace(/\D/g, '');
const ADMIN_JID = `${ADMIN_PHONE}@s.whatsapp.net`;

// --- AI Configuration ---
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2:0.5b';
const REWIND_KEY = process.env.REWIND_KEY || 'sk-rewind-31c3a65acc981512de959195485deec0';
const SCRAPER_URL = (process.env.SCRAPER_URL || '').replace(/\/$/, '');

// ================================================================
// FORBIDDEN WORDS & HUMANIZER
// ================================================================
const FORBIDDEN_REPLY_WORDS = [
  'no', 'cannot', "can't", 'unable to', 'i refuse', 'not allowed',
  'against my guidelines', 'as an ai', 'i am an ai', 'language model',
  'sorry, i', 'i apologize', 'token', 'api_key', 'console.log',
  'error:', 'stack trace', 'traceback', 'debug'
].map(w => w.toLowerCase());

function containsForbidden(text) {
  if (!text) return true;
  const low = text.toLowerCase();
  return FORBIDDEN_REPLY_WORDS.some(w => low.includes(w));
}

function humanize(text) {
  if (!text) return '';
  let t = text;
  t = t.replace(/```[\s\S]*?```/g, '');
  t = t.split('\n').filter(line => {
    const l = line.trim().toLowerCase();
    if (!l) return true;
    if (/^\[?(info|warn|error|debug|trace)\]?[: ]/.test(l)) return false;
    if (/^\d{4}-\d{2}-\d{2}/.test(l)) return false;
    if (/^at\s+\w+/.test(l)) return false;
    if (/^(console\.|process\.|require\()/.test(l)) return false;
    return true;
  }).join('\n');
  t = t.replace(/\n{3,}/g, '\n\n').trim();
  return t;
}

// ================================================================
// LANGUAGE DETECTION (Simplified for Group Ollama)
// ================================================================
const SHONA_MARKERS = ['ndi', 'uri', 'kuti', 'here', 'izvi', 'zvakanaka', 'sei', 'ndoda', 'unoda', 'mhoro', 'mangwanani', 'masikati', 'manheru', 'ndapota', 'zvinhu', 'vanhu', 'kuita', 'kuenda', 'kuuya'];
const LANG_NAMES = { sn: 'Shona', en: 'English' };

function detectLanguage(text) {
  if (!text) return 'en';
  const words = text.toLowerCase().split(/\s+/);
  const score = (markers) => words.filter(w => markers.includes(w)).length;
  const shonaScore = score(SHONA_MARKERS);
  return shonaScore > 0 ? 'sn' : 'en';
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
const replyCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

// ================================================================
// PHONE EXTRACTION (Admin = Phone Only)
// ================================================================
function extractPhone(msg, senderJid) {
  const candidates = [msg.key?.participantPn, msg.key?.senderPn, msg.key?.remoteJidAlt, msg.key?.participantAlt, senderJid].filter(Boolean);
  for (const c of candidates) {
    if (typeof c === 'string' && c.endsWith('@s.whatsapp.net')) return c.split('@')[0].split(':')[0].replace(/\D/g, '');
  }
  return null;
}
function extractLid(msg, senderJid) {
  const candidates = [senderJid, msg.key?.remoteJid, msg.key?.participant].filter(Boolean);
  for (const c of candidates) if (typeof c === 'string' && c.includes('@lid')) return c.split('@')[0];
  return null;
}
function isAdminPhone(phone) {
  if (!phone) return false;
  return phone.replace(/\D/g, '') === ADMIN_PHONE;
}

// ================================================================
// AI FUNCTIONS
// ================================================================

// --- Ollama (for Groups) ---
async function askOllama(prompt, systemPrompt) {
  if (!OLLAMA_URL) return null;
  try {
    const r = await axios.post(`${OLLAMA_URL}/api/chat`, {
      model: OLLAMA_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt }
      ],
      stream: false
    }, { timeout: 30000 });
    const text = r.data?.message?.content;
    return text ? humanize(text) : null;
  } catch (e) {
    console.error(`Ollama failed: ${e.message}`);
    return null;
  }
}

// --- Rewind AI (for DMs) ---
async function askRewind(prompt, systemPrompt) {
  if (!REWIND_KEY) return null;
  try {
    const r = await axios.post('https://api.rewind.ai/v1/chat/completions', {
      model: 'rewind-uncensored',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt }
      ]
    }, {
      headers: { 'Authorization': `Bearer ${REWIND_KEY}`, 'Content-Type': 'application/json' },
      timeout: 15000
    });
    return r.data?.choices?.[0]?.message?.content ? humanize(r.data.choices[0].message.content) : null;
  } catch (e) {
    console.error(`Rewind failed: ${e.message}`);
    return null;
  }
}

// ================================================================
// WEB SCRAPER BRIDGE (For DMs)
// ================================================================
async function scraperSearch(query, source = 'pornpics') {
  if (!SCRAPER_URL) return { ok: false, error: 'SCRAPER_URL not set' };
  try {
    const r = await axios.post(`${SCRAPER_URL}/search`, { query, q: query, source }, { timeout: 30000 });
    return { ok: true, data: r.data };
  } catch (e) { return { ok: false, error: e.response?.status ? `HTTP ${e.response.status}` : e.message }; }
}
async function scraperStatus() {
  if (!SCRAPER_URL) return { ok: false, error: 'SCRAPER_URL not set' };
  try {
    const r = await axios.get(`${SCRAPER_URL}/status`, { timeout: 10000 });
    return { ok: true, data: r.data };
  } catch (e) { return { ok: false, error: e.response?.status ? `HTTP ${e.response.status}` : e.message }; }
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
  static async send({ message, mode = 'joint' }) {
    if (!sock) throw new Error('Bot not connected');
    const targets = this.collectTargets(mode);
    const results = { sent: 0, failed: 0, total: targets.length, errors: [], mode };
    pushLog('info', 'broadcast', `Broadcast start: ${targets.length} targets (${mode})`);
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      try { await sock.sendMessage(t.jid, { text: message }); results.sent++; }
      catch (e) { results.failed++; results.errors.push({ jid: t.jid, error: e.message }); }
      if (i < targets.length - 1) await new Promise(r => setTimeout(r, 150));
    }
    pushLog('success', 'broadcast', `Broadcast done: ${results.sent}/${results.total}`);
    return results;
  }
}

// ================================================================
// COMMAND LIST
// ================================================================
const COMMAND_LIST = `🥖 *BreadBot Commands*

*Diagnostics*
!test — bot status
!testall — test all AI + scraper + WhatsApp
!whoami — show your IDs (debug admin)
!ping — latency
!commands / !help — this list

*Stats*
!stats — counts and uptime

*Broadcasting*
!broadcast dm|group|joint <msg>
!ad <title> | <body> | [cta] | [link] | [style]
!bcad <dm|group|joint>

*Scraper*
!search <query> — search images`;

// ================================================================
// CONNECTION
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
        pushLog('info', 'bot', 'QR generated');
      }
      if (connection === 'open') {
        isConnecting = false;
        connectionStatus = 'connected';
        reconnectAttempts = 0;
        botStartTime = Date.now();
        botNumber = sock.user?.id?.split(':')[0]?.split('@')[0] || 'unknown';
        pushLog('success', 'bot', `✅ Connected as ${botNumber}`);
        try {
          await sock.sendMessage(ADMIN_JID, { text: `✅ *BreadBot ONLINE*\n📱 *${botNumber}*\n🕒 ${new Date().toLocaleString()}\n\n${COMMAND_LIST}` });
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
    id: msgId, ts: new Date().toISOString(), chatJid, chatType, senderJid,
    senderName: pushName, phone: phone || '—', lid: lid || '—',
    text: text.slice(0, 200) || `[${mediaType}]`, mediaType
  });

  if (!text && mediaType === 'text') return;

  pushLog('info', 'message', `${chatType === 'group' ? '👥' : '💬'} ${pushName} (${phone || lid || 'unknown'})`, { preview: text.slice(0, 80) || `[${mediaType}]` });

  const isAdmin = isAdminPhone(phone);

  if (isAdmin && text.startsWith('!')) {
    pushLog('info', 'admin', `Admin command: ${text.split(' ')[0]} (phone ${phone})`);
    await handleAdminCommand(text, chatJid, msg);
    return;
  }

  // --- GROUP LOGIC (Ollama only) ---
  if (isGroup) {
    // Anti-repetition: avoid replying to the same text from the same user
    const historyKey = `group_${senderJid}`;
    if (!messageHistory.has(historyKey)) messageHistory.set(historyKey, []);
    const hist = messageHistory.get(historyKey);
    if (hist.includes(text)) {
      pushLog('info', 'group', `Duplicate message from ${pushName} skipped.`);
      return;
    }
    hist.push(text);
    if (hist.length > 10) hist.shift();

    // Only reply if mentioned or a 10% chance for casual interaction
    const botBase = botNumber;
    const quoted = msg.message?.extendedTextMessage?.contextInfo?.participant;
    const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    const isMentioned = botBase && (text.includes(`@${botBase}`) || mentioned.some(j => j.includes(botBase)) || (quoted && quoted.includes(botBase)));
    const casualChance = Math.random() < 0.10;
    if (!isMentioned && !casualChance) return;

    const lang = detectLanguage(text);
    const langName = LANG_NAMES[lang] || 'English';

    const systemPrompt = `You are BreadBot, a cool and witty Zimbabwean guy in a WhatsApp group. Your name is Bread. You are friendly and humorous. You speak casually, mixing English and light Shona slang. NEVER use deep Shona. Keep replies short, natural, and human. No technical jargon, no code, no logs. If you don't understand or can't reply, say exactly: NO.`;

    const aiReply = await askOllama(text, systemPrompt);
    if (!aiReply) { pushLog('warn', 'ai', `No group reply for ${pushName}`); return; }

    if (containsForbidden(aiReply)) {
      pushLog('warn', 'ai', `Group reply dropped (forbidden word): ${aiReply.slice(0, 60)}`);
      return;
    }

    const final = humanize(aiReply);
    if (!final) { pushLog('warn', 'ai', 'Group reply empty after humanize'); return; }

    await sock.sendMessage(chatJid, { text: final }, { quoted: msg });
    pushLog('info', 'ai', `Group reply sent to ${pushName} via Ollama`);
    return;
  }

  // --- DM LOGIC (Rewind + Scraper) ---
  if (!isGroup) {
    const isImagePrompt = /mufananidzo|pic|mifananidzo|kuona/i.test(text);
    let processedText = text;

    if (isImagePrompt && SCRAPER_URL) {
      const query = text.replace(/mufananidzo|pic|mifananidzo|kuona|ndoda|ndipe|ndiratidze|nditumire/gi, '').trim();
      if (query) {
        pushLog('info', 'scraper', `DM image request: "${query}"`);
        const scraperResult = await scraperSearch(query);
        if (scraperResult.ok) {
          processedText = `The user asked for an image of "${query}". The scraper found: ${JSON.stringify(scraperResult.data).slice(0, 500)}. Provide a natural, human reply about this.`;
        } else {
          processedText = `The user asked for an image of "${query}" but the scraper is offline. Reply apologetically in a casual, human way.`;
        }
      }
    }

    const systemPrompt = `You are Abby Faith Sithole, 23, from Harare, Zimbabwe. Friendly, warm, playful. Reply in English or Shona. Keep it casual and human. No technical terms, no code, no logs, no over-explaining. Just a natural chat reply.`;

    const aiReply = await askRewind(processedText, systemPrompt);
    if (!aiReply) { pushLog('warn', 'ai', `No DM reply for ${pushName}`); return; }

    if (containsForbidden(aiReply)) {
      pushLog('warn', 'ai', `DM reply dropped (forbidden word): ${aiReply.slice(0, 60)}`);
      return;
    }

    const final = humanize(aiReply);
    if (!final) { pushLog('warn', 'ai', 'DM reply empty after humanize'); return; }

    await sock.sendMessage(chatJid, { text: final }, { quoted: msg });
    pushLog('info', 'ai', `DM reply sent to ${pushName} via Rewind`);
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
    case 'test': await reply(`✅ *Test OK*\nBot: *${botNumber}*\nStatus: *${connectionStatus}*\nUptime: *${Math.floor((Date.now()-botStartTime)/1000)}s*`); break;
    case 'whoami': await reply(`🔍 *Who Are You?*\n\nJID: *${msg.key.participant || msg.key.remoteJid}*\nPhone: *${extractPhone(msg, chatJid) || 'not detected'}*\nLID: *${extractLid(msg, chatJid) || 'not detected'}*\nChat: *${chatJid}*\n\nAdmin phone expected: *${ADMIN_PHONE}*\nIs admin: *${isAdminPhone(extractPhone(msg, chatJid)) ? 'YES' : 'NO'}*`); break;
    case 'testall': { await reply('🧪 Running full test suite...'); const report = await runFullTestSuite(); await reply(report); break; }
    case 'stats': {
      const dm = [...activeChats].filter(j => j.endsWith('@s.whatsapp.net')).length;
      const grp = [...activeChats].filter(j => j.endsWith('@g.us')).length;
      await reply(`📊 *Stats*\nDMs: *${dm}*\nGroups: *${grp}*\nLogs: *${logBuffer.length}*\nMessages: *${liveMessages.length}*\nUptime: *${Math.floor((Date.now()-botStartTime)/1000)}s*`);
      break;
    }
    case 'broadcast': case 'bc': {
      const valid = ['dm', 'group', 'joint'];
      const modeArg = args[1]?.toLowerCase();
      const mode = valid.includes(modeArg) ? modeArg : 'joint';
      const message = valid.includes(modeArg) ? args.slice(2).join(' ') : args.slice(1).join(' ');
      if (!message) { await reply(`❌ Usage: \`!broadcast [dm|group|joint] <message>\``); return; }
      await reply(`⏳ Broadcasting (${mode.toUpperCase()})...`);
      const r = await BroadcastEngine.send({ message, mode });
      await reply(`✅ Done — Sent: *${r.sent}* / Failed: *${r.failed}*`);
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
      await reply(`⏳ Broadcasting ad...`);
      const r = await BroadcastEngine.send({ message: adText, mode });
      await reply(`✅ Done — Sent: *${r.sent}* / Failed: *${r.failed}*`);
      break;
    }
    case 'search': {
      const q = args.slice(1).join(' ');
      if (!q) { await reply('❌ Usage: `!search <query>`'); return; }
      await reply(`🔎 Searching scraper for: *${q}*...`);
      const r = await scraperSearch(q);
      if (!r.ok) { await reply(`❌ Scraper error: ${r.error}`); return; }
      await reply(`✅ *Scraper result:*\n${JSON.stringify(r.data).slice(0, 1500)}`);
      break;
    }
    default: await reply(`❓ Unknown: *!${cmd}* — send *!commands*`);
  }
}

// ================================================================
// FULL TEST SUITE
// ================================================================
async function runFullTestSuite() {
  const t0 = Date.now();
  const tests = [];
  // Test Ollama
  const ollamaTest = await askOllama('Say OK', 'Test.');
  tests.push(`Ollama (${OLLAMA_MODEL}): ${ollamaTest ? '✅ reachable' : '❌ failed'}`);
  // Test Rewind
  if (REWIND_KEY) { const s = Date.now(); const r = await askRewind('Say OK', 'Test.'); tests.push(`Rewind: ${r ? `✅ ${Date.now()-s}ms` : '❌ failed'}`); }
  else tests.push(`Rewind: ⚠️ not configured`);
  // Test Scraper
  const sc = await scraperStatus();
  tests.push(`Scraper: ${sc.ok ? '✅ reachable' : `❌ ${sc.error}`}`);

  return [
    '🧪 *Full Test Suite*', '',
    ...tests, '',
    `🔌 WhatsApp: ${connectionStatus === 'connected' ? '✅ connected' : `❌ ${connectionStatus}`}`,
    `📱 Bot: ${botNumber || '—'}`,
    `💬 Chats: ${activeChats.size}`,
    `🕒 Total: ${Date.now() - t0}ms`
  ].join('\n');
}

// ================================================================
// EXPRESS + PANEL
// ================================================================
const app = express();
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now(), status: connectionStatus, uptime: Math.floor((Date.now()-botStartTime)/1000) }));
app.get('/api/status', (req, res) => res.json({ status: connectionStatus, activeChats: activeChats.size, botNumber }));
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
  const dm = [...activeChats].filter(j => j.endsWith('@s.whatsapp.net')).length;
  const grp = [...activeChats].filter(j => j.endsWith('@g.us')).length;
  res.json({ status: connectionStatus, botNumber, uptime: Math.floor((Date.now()-botStartTime)/1000), dmCount: dm, groupCount: grp, totalChats: activeChats.size, logCount: logBuffer.length, messageCount: liveMessages.length, scraperConfigured: !!SCRAPER_URL, ollamaConfigured: !!OLLAMA_URL });
});

const PANEL_HTML = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BreadBot v28</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:monospace;background:#0d1117;color:#c9d1d9;padding:16px}h1{font-size:20px;color:#58a6ff;margin-bottom:4px}.sub{font-size:12px;color:#8b949e;margin-bottom:16px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px}.card h2{font-size:12px;color:#8b949e;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px}button{background:#21262d;border:1px solid #30363d;color:#c9d1d9;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:13px;margin:3px;font-family:inherit}button:hover{background:#30363d;border-color:#58a6ff}button.primary{background:#238636;border-color:#2ea043;color:#fff}button.danger{background:#da3633;border-color:#f85149;color:#fff}#qrImg{width:100%;max-width:240px;border-radius:8px;margin:8px auto;display:block;background:#fff;padding:8px}.status-dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;vertical-align:middle}.s-connected{background:#3fb950;box-shadow:0 0 8px #3fb950}.s-qr{background:#d29922}.s-disconnected{background:#f85149}.s-reconnecting{background:#d29922;animation:pulse 1s infinite}.s-error{background:#f85149}@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}#logs,#msgs{height:300px;overflow-y:auto;font-size:12px;line-height:1.6;background:#0d1117;border-radius:6px;padding:8px}.log-entry{padding:3px 0;border-bottom:1px solid #21262d}.log-time{color:#484f58;margin-right:8px}.log-info{color:#58a6ff}.log-success{color:#3fb950}.log-warn{color:#d29922}.log-error{color:#f85149}.log-source{color:#8b949e;margin-right:6px}.stat-row{display:flex;justify-content:space-between;padding:5px 0;font-size:13px;border-bottom:1px solid #21262d}.stat-row:last-child{border-bottom:none}.stat-val{color:#58a6ff;font-weight:600}.msg-row{padding:6px 8px;margin:4px 0;border-radius:6px;background:#161b22;border-left:3px solid #58a6ff;font-size:12px}.msg-row.group{border-left-color:#a371f7}.msg-row.dm{border-left-color:#3fb950}.msg-meta{color:#8b949e;font-size:11px;margin-bottom:2px}.msg-name{color:#58a6ff;font-weight:600}.msg-text{color:#c9d1d9;word-break:break-word}.tag{display:inline-block;padding:1px 6px;border-radius:3px;font-size:10px;margin-left:6px;font-weight:600}.tag-group{background:#a371f7;color:#fff}.tag-dm{background:#3fb950;color:#000}.full-width{grid-column:1/-1}</style></head><body>
<h1>🥖 BreadBot v28</h1><div class="sub">Admin phone: <b>263777627210</b> · Scraper: <b id="scraperStat">—</b> · Ollama: <b id="ollamaStat">—</b></div>
<div class="grid">
<div class="card"><h2>Connection</h2><div style="margin-bottom:10px"><span class="status-dot" id="statusDot"></span><span id="statusText">Loading...</span></div><div class="stat-row"><span>Bot Number</span><span class="stat-val" id="botNum">—</span></div><div class="stat-row"><span>Uptime</span><span class="stat-val" id="statUptime">—</span></div><img id="qrImg" src="" style="display:none"><div style="margin-top:10px"><button class="primary" onclick="doAction('connect')">🔗 Start</button><button onclick="doAction('reconnect')">🔄 Reconnect</button><button onclick="doAction('refresh-qr')">♻️ Refresh QR</button><button class="danger" onclick="doAction('disconnect')">⛔ Disconnect</button></div></div>
<div class="card"><h2>Statistics</h2><div class="stat-row"><span>DMs</span><span class="stat-val" id="statDM">—</span></div><div class="stat-row"><span>Groups</span><span class="stat-val" id="statGroup">—</span></div><div class="stat-row"><span>Logs</span><span class="stat-val" id="statLogs">—</span></div><div class="stat-row"><span>Messages</span><span class="stat-val" id="statMsgs">—</span></div></div>
<div class="card full-width"><h2>📨 Live Messages (LID + Phone)</h2><div id="msgs"></div></div>
<div class="card full-width"><h2>📜 Logs</h2><div id="logs"></div></div>
</div>
<script>
const $=id=>document.getElementById(id);
async function api(p,m='GET'){const r=await fetch('/admin/'+p,{method:m});return r.json();}
function fmt(s){const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),x=s%60;return h+'h '+m+'m '+x+'s';}
function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function setStatus(st){$('statusDot').className='status-dot s-'+st;const l={connected:'Connected',qr:'Waiting for scan',disconnected:'Disconnected',reconnecting:'Reconnecting',error:'Error'};$('statusText').textContent=l[st]||st;}
async function refreshStats(){try{const d=await api('stats');setStatus(d.status);$('statUptime').textContent=fmt(d.uptime);$('botNum').textContent=d.botNumber||'—';$('statDM').textContent=d.dmCount;$('statGroup').textContent=d.groupCount;$('statLogs').textContent=d.logCount;$('statMsgs').textContent=d.messageCount;$('scraperStat').textContent=d.scraperConfigured?'✅':'❌';$('ollamaStat').textContent=d.ollamaConfigured?'✅':'❌';const q=await api('qr-data');if(q.qr&&q.status==='qr'){$('qrImg').src='/admin/qr?t='+Date.now();$('qrImg').style.display='block';}else{$('qrImg').style.display='none';}}catch(e){}}
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
  if (connectionStatus === 'connected' && sock) {
    try { await sock.sendPresenceUpdate('available'); pushLog('info', 'keepalive', 'Presence ping'); } catch (e) {}
  }
}, 4 * 60 * 1000);
setInterval(() => { axios.get(`http://localhost:${PORT}/health`).catch(() => {}); }, 4 * 60 * 1000);

// ================================================================
// STARTUP
// ================================================================
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  pushLog('info', 'system', `Boot port ${PORT}`);
  pushLog('info', 'system', `Ollama: ${OLLAMA_URL} (model: ${OLLAMA_MODEL})`);
  pushLog('info', 'system', `Scraper: ${SCRAPER_URL ? SCRAPER_URL : 'NOT configured (set SCRAPER_URL)'}`);
  connectBot().catch(err => { console.error('Boot failed:', err); pushLog('error', 'system', `Boot failed: ${err.message}`); });
});
