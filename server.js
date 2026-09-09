'use strict';

// =============================================================================
//  IMPORTS
// =============================================================================
const express = require('express');
const path = require('path');
const fs = require('fs');
const { Boom } = require('@hapi/boom');
const NodeCache = require('node-cache');
const {
  makeWASocket, DisconnectReason, fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore, useMultiFileAuthState, Browsers, proto
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');
const axios = require('axios');
const cheerio = require('cheerio');

// =============================================================================
//  CONFIGURATION
// =============================================================================
const VERSION = '22.1';
const ADMIN = '115110005706891@lid';
const EXCLUDED_PHONE = '64226434709';
const AUTH_FOLDER = 'auth_info';
const PORT = process.env.PORT || 10000;

// IMPORTANT: Replace these with fresh keys from your dashboards!
const GEMINI_API_KEY = 'YOUR_NEW_GEMINI_API_KEY';
const GEMINI_MODEL = 'gemini-3.8-flash';
const LLM7_API_KEY = 'YOUR_NEW_LLM7_API_KEY';
const LLM7_MODEL = 'gemini-3-flash';
const NAUGHTY_AI_PROVIDER = 'gemini'; // 'gemini', 'llm7', or 'static'

// Static naughty messages (fallback)
const NAUGHTY_MESSAGES = [
  "Hey, you're being naughty! 😈",
  "Stop it, you little devil! 🔥",
  "Oh my, what a mischievous one! 😏",
  "You're making me blush! 😳",
  "Tsk tsk, behave yourself! 😉",
  "Naughty, naughty! 🍑",
  "You're a handful, aren't you? 😜",
  "I like your style, but keep it PG! 😇",
  "Oops, someone's feeling playful! 🥵",
  "Careful, I might just respond in kind! 😘"
];

// =============================================================================
//  IMAGE SCRAPER CONFIG
// =============================================================================
const IMAGE_SITES = {
  naijauncut: {
    searchUrl: 'https://naijauncut.com/search',
    albumSelector: 'a.result-link',
    imageSelector: 'img.album-image, img.gallery-image, img.responsive',
    lazyAttr: 'data-src',
  },
  darknaija: {
    searchUrl: 'https://darknaija.com/search',
    albumSelector: 'a.album-link',
    imageSelector: 'img.media-image, img.picture',
    lazyAttr: 'data-original',
  }
};

const DOWNLOAD_FOLDER = path.join(__dirname, 'downloaded_images');
if (!fs.existsSync(DOWNLOAD_FOLDER)) fs.mkdirSync(DOWNLOAD_FOLDER, { recursive: true });

const imageCache = new NodeCache({ stdTTL: 3600, checkperiod: 120 });

// =============================================================================
//  STATE
// =============================================================================
let sock = null;
let qrDataUri = null;
let connectionStatus = 'disconnected';
let reconnectAttempts = 0;
let maxReconnectAttempts = 5;
let isInitialConnection = true; // Prevents reconnect loop before QR scan
let lastConnectedAt = 0;
let onlineMsgSent = false;
let botStartTime = Date.now();

let ADMIN_LID_JID = ADMIN;
const capturedAdminJids = new Set();
const lidToPhone = new Map();

const knownGroups = new Set();
const groupActivity = new Map();
const joinedGroupCodes = new Set();

const messageStore = [];

const broadcasts = new Map();
let broadcastIdCounter = 1;
let currentBroadcastMessage = '';

const logs = [];
function addLog(msg, type = 'info') {
  const entry = { time: new Date().toISOString(), msg, type };
  logs.push(entry);
  if (logs.length > 200) logs.shift();
  console.log(`[${type.toUpperCase()}] ${msg}`);
}

let waKeepAlive = null;
let joinQueue = [];
let isJoining = false;

const logger = pino({ level: 'silent' });
const msgRetryCounterCache = new NodeCache();
const groupMetadataCache = new NodeCache({ stdTTL: 300, useClones: false });

let sseClients = [];
const phoneCache = new Map();

// =============================================================================
//  HUMAN CONFIG
// =============================================================================
const HUMAN_CONFIG = {
  minReplyDelay: 2,
  maxReplyDelay: 8,
  minBroadcastDelay: 30,
  maxBroadcastDelay: 90,
  minJoinDelay: 3,
  maxJoinDelay: 10,
  typingDurationMin: 1500,
  typingDurationMax: 4000,
  readReceiptChance: 0.7,
  useTypingIndicator: true,
};

// =============================================================================
//  UTILITIES
// =============================================================================
function toBare(jid) {
  if (!jid) return '';
  return jid.split(':')[0]
    .replace('@s.whatsapp.net', '')
    .replace('@g.us', '')
    .replace('@lid', '')
    .replace('@newsletter', '')
    .replace('@broadcast', '');
}

function isGroup(jid) { return jid && jid.endsWith('@g.us'); }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function humanDelay(minSec, maxSec) {
  const delay = randInt(minSec * 1000, maxSec * 1000);
  await sleep(delay);
}

async function simulateTyping(jid) {
  if (!HUMAN_CONFIG.useTypingIndicator) return;
  try {
    await sock.sendPresenceUpdate('composing', jid);
    await sleep(randInt(HUMAN_CONFIG.typingDurationMin, HUMAN_CONFIG.typingDurationMax));
    await sock.sendPresenceUpdate('paused', jid);
  } catch {}
}

function getRandomResponse(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function getRamMB() {
  try { return Math.round(process.memoryUsage().heapUsed / 1024 / 1024); } catch { return 0; }
}

function addMessageToCache(msg) {
  messageStore.push(msg);
  if (messageStore.length > 10000) messageStore.shift();
}
function getCachedMessages() { return messageStore; }

function extractInviteCodes(text) {
  if (!text) return [];
  const regex = /chat\.whatsapp\.com\/([A-Za-z0-9]{10,})/g;
  const codes = [];
  let match;
  while ((match = regex.exec(text)) !== null) codes.push(match[1]);
  return codes;
}

// ---------- LID resolution ----------
async function resolvePhoneNumber(jid) {
  if (!jid) return null;
  if (phoneCache.has(jid)) return phoneCache.get(jid);
  if (jid.endsWith('@s.whatsapp.net')) {
    const bare = jid.split('@')[0];
    phoneCache.set(jid, bare);
    return bare;
  }
  if (jid.endsWith('@lid')) {
    try {
      const result = await sock.onWhatsApp(jid);
      if (Array.isArray(result) && result.length > 0 && result[0].exists) {
        const phoneJid = result[0].jid;
        if (phoneJid) {
          const bare = phoneJid.split('@')[0];
          phoneCache.set(jid, bare);
          return bare;
        }
      }
    } catch (e) { console.error('LID resolve error:', e.message); }
  }
  return null;
}

// ---------- AI naughty reply ----------
async function getAINaughtyReply(userMessage) {
  if (NAUGHTY_AI_PROVIDER === 'gemini' && GEMINI_API_KEY && GEMINI_API_KEY !== 'YOUR_NEW_GEMINI_API_KEY') {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-goog-api-key': GEMINI_API_KEY
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `You are a playful, naughty, flirty AI. Reply with a short cheeky message to: "${userMessage}"` }] }]
        })
      });
      const data = await response.json();
      return data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
    } catch (e) { console.error('Gemini error:', e.message); }
  }
  if (NAUGHTY_AI_PROVIDER === 'llm7' && LLM7_API_KEY && LLM7_API_KEY !== 'YOUR_NEW_LLM7_API_KEY') {
    try {
      const response = await fetch('https://api.llm7.io/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${LLM7_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: LLM7_MODEL,
          messages: [
            { role: 'system', content: 'You are a playful, naughty AI. Reply with a short cheeky message.' },
            { role: 'user', content: userMessage }
          ]
        })
      });
      const data = await response.json();
      return data?.choices?.[0]?.message?.content || null;
    } catch (e) { console.error('LLM7 error:', e.message); }
  }
  return null;
}

// ---------- IMAGE SCRAPER ----------
async function scrapeImages(site, searchQuery, maxImages = 10) {
  const siteConfig = IMAGE_SITES[site];
  if (!siteConfig) throw new Error(`Unknown site: ${site}`);

  const searchUrl = `${siteConfig.searchUrl}?q=${encodeURIComponent(searchQuery)}`;
  console.log(`🔍 Scraping ${site}: ${searchUrl}`);

  const { data: html } = await axios.get(searchUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    timeout: 10000
  });
  const $ = cheerio.load(html);

  const albumLinks = [];
  $(siteConfig.albumSelector).each((i, el) => {
    const href = $(el).attr('href');
    if (href) {
      const fullUrl = new URL(href, searchUrl).href;
      albumLinks.push(fullUrl);
    }
  });

  if (albumLinks.length === 0) {
    console.warn('⚠️ No album links found. Check selectors.');
    return [];
  }

  const albumUrl = albumLinks[0];
  console.log(`📁 Using album: ${albumUrl}`);

  const { data: albumHtml } = await axios.get(albumUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    timeout: 10000
  });
  const $$ = cheerio.load(albumHtml);

  const imageUrls = [];
  $$(siteConfig.imageSelector).each((i, el) => {
    let src = $$(el).attr('src');
    if (!src) src = $$(el).attr(siteConfig.lazyAttr);
    if (src) {
      const fullUrl = new URL(src, albumUrl).href;
      if (/\.(jpg|jpeg|png|gif|webp)$/i.test(fullUrl)) {
        imageUrls.push(fullUrl);
      }
    }
  });

  const unique = [...new Set(imageUrls)];
  console.log(`🖼️ Found ${unique.length} images.`);
  return unique.slice(0, maxImages);
}

async function downloadAndSendImages(site, searchQuery, chatJid, maxImages = 10) {
  try {
    const urls = await scrapeImages(site, searchQuery, maxImages);
    if (urls.length === 0) {
      await sock.sendMessage(chatJid, { text: '❌ No images found for that query.' });
      return;
    }

    let sent = 0;
    for (const url of urls) {
      let filePath = imageCache.get(url);
      if (!filePath) {
        const response = await axios.get(url, {
          responseType: 'stream',
          headers: { 'User-Agent': 'Mozilla/5.0' },
          timeout: 15000
        });
        const fileName = path.basename(url).split('?')[0] || `image_${Date.now()}.jpg`;
        filePath = path.join(DOWNLOAD_FOLDER, fileName);
        const writer = fs.createWriteStream(filePath);
        response.data.pipe(writer);
        await new Promise((resolve, reject) => {
          writer.on('finish', resolve);
          writer.on('error', reject);
        });
        imageCache.set(url, filePath);
        console.log(`✅ Downloaded: ${fileName}`);
      }

      await sock.sendMessage(chatJid, {
        image: { url: filePath },
        caption: "😈 Here's what you asked for"
      });
      sent++;
      await sleep(2000);
    }
    await sock.sendMessage(chatJid, { text: `✅ Sent ${sent} images.` });
  } catch (error) {
    console.error('Download/send error:', error.message);
    await sock.sendMessage(chatJid, { text: `❌ Error: ${error.message}` });
  }
}

// =============================================================================
//  PERSISTENCE
// =============================================================================
const BROADCASTS_FILE = 'broadcasts.json';
const JOINED_GROUPS_FILE = 'joined_groups.json';
const ADMIN_LID_FILE = 'admin_lid.json';

function saveJoinedGroups() {
  try {
    fs.writeFileSync(JOINED_GROUPS_FILE, JSON.stringify({
      groups: [...knownGroups], codes: [...joinedGroupCodes], savedAt: new Date().toISOString()
    }, null, 2));
  } catch {}
}
function loadJoinedGroups() {
  try {
    if (fs.existsSync(JOINED_GROUPS_FILE)) {
      const data = JSON.parse(fs.readFileSync(JOINED_GROUPS_FILE, 'utf8'));
      if (data.groups) data.groups.forEach(g => knownGroups.add(g));
      if (data.codes) data.codes.forEach(c => joinedGroupCodes.add(c));
    }
  } catch {}
}

function saveBroadcasts() {
  try {
    const d = {};
    broadcasts.forEach((v, k) => d[k] = {
      message: v.message, groups: v.groups, active: v.active,
      sentCount: v.sentCount, createdAt: v.createdAt, customInterval: v.customInterval
    });
    fs.writeFileSync(BROADCASTS_FILE, JSON.stringify(d, null, 2));
  } catch {}
}
function loadBroadcasts() {
  try {
    if (fs.existsSync(BROADCASTS_FILE)) {
      const d = JSON.parse(fs.readFileSync(BROADCASTS_FILE, 'utf8'));
      Object.entries(d).forEach(([id, b]) => {
        broadcasts.set(String(id), { ...b, active: false, interval: null });
      });
      broadcastIdCounter = Math.max(broadcastIdCounter, ...[...broadcasts.keys()].map(Number)) + 1;
    }
  } catch {}
}

function saveAdminLid() {
  try {
    fs.writeFileSync(ADMIN_LID_FILE, JSON.stringify({
      jid: ADMIN_LID_JID, savedAt: new Date().toISOString(),
      lidToPhone: Object.fromEntries(lidToPhone)
    }, null, 2));
  } catch {}
}
function loadAdminLid() {
  try {
    if (fs.existsSync(ADMIN_LID_FILE)) {
      const data = JSON.parse(fs.readFileSync(ADMIN_LID_FILE, 'utf8'));
      if (data.jid) {
        ADMIN_LID_JID = data.jid;
        if (data.lidToPhone) {
          for (const [k, v] of Object.entries(data.lidToPhone)) lidToPhone.set(k, v);
        }
      }
    }
  } catch {}
}

// =============================================================================
//  ADMIN DETECTION
// =============================================================================
async function resolveAdminLid() {}
function isAdmin(jid, msg) {
  if (!jid) return false;
  if (!isGroup(jid)) {
    const dmBare = toBare(jid);
    if (dmBare === ADMIN || (ADMIN_LID_JID && jid === ADMIN_LID_JID)) {
      capturedAdminJids.add(jid);
      return true;
    }
    return capturedAdminJids.has(jid);
  }
  const participant = msg?.key?.participant;
  if (participant && toBare(participant) === ADMIN) return true;
  if (ADMIN_LID_JID && participant === ADMIN_LID_JID) return true;
  if (participant?.endsWith('@lid')) {
    const mapped = lidToPhone.get(toBare(participant));
    if (mapped && toBare(mapped) === ADMIN) return true;
  }
  if (msg?.key?.senderPn && msg.key.senderPn.split(':')[0] === ADMIN) return true;
  if (msg?.key?.participantPn && msg.key.participantPn.split(':')[0] === ADMIN) return true;
  return capturedAdminJids.has(jid) || capturedAdminJids.has(participant);
}

function getReplyJid(msg) {
  const sender = msg.key?.remoteJid;
  if (!isGroup(sender)) return msg?.key?.participantPn || msg?.key?.senderPn || sender;
  return sender;
}

// =============================================================================
//  BROADCAST SYSTEM
// =============================================================================
function getBcInterval(bc) { return bc.customInterval || 6 * 3600000; }

function startBc(id) {
  const bc = broadcasts.get(id);
  if (!bc) return;
  if (bc.interval) clearInterval(bc.interval);
  bc.active = true;
  bc.sentCount = bc.sentCount || 0;
  sendBcMsg(id);
  bc.interval = setInterval(() => sendBcMsg(id), getBcInterval(bc));
  saveBroadcasts();
}

async function sendBcMsg(id) {
  const bc = broadcasts.get(id);
  if (!bc || !bc.active || !sock || connectionStatus !== 'connected') return;
  const targets = bc.groups && bc.groups.length > 0 ? bc.groups : [...knownGroups];
  if (!targets.length) return;
  let sent = 0, failed = 0;
  for (const g of targets) {
    try {
      await simulateTyping(g);
      await sock.sendMessage(g, { text: bc.message });
      sent++;
      const delay = randInt(HUMAN_CONFIG.minBroadcastDelay * 1000, HUMAN_CONFIG.maxBroadcastDelay * 1000);
      await sleep(delay);
    } catch (e) { failed++; }
  }
  bc.sentCount = (bc.sentCount || 0) + sent;
  bc.lastSent = new Date().toISOString();
  bc.lastSentCount = sent;
  saveBroadcasts();
}

function stopBc(id) {
  const bc = broadcasts.get(id);
  if (!bc) return;
  if (bc.interval) clearInterval(bc.interval);
  bc.active = false;
  bc.interval = null;
  saveBroadcasts();
}

function stopAllBc() {
  for (const [id] of broadcasts.entries()) stopBc(id);
}

function resumeBroadcasts() {
  for (const [id, bc] of broadcasts.entries()) {
    if (bc.active) {
      if (bc.interval) clearInterval(bc.interval);
      bc.interval = setInterval(() => sendBcMsg(id), getBcInterval(bc));
    }
  }
}

// =============================================================================
//  CASUAL & NAUGHTY MESSAGE HANDLER
// =============================================================================
async function handleCasualMessage(text, replyJid, isGroupChat, senderJid) {
  if (!text) return false;
  const lower = text.toLowerCase().trim();

  // --- AI Image Request Detection ---
  // If the user asks for images in a casual way, the AI will detect it
  // and trigger the image download
  const imageKeywords = ['boobs', 'horny', 'sexy', 'nude', 'nsfw', 'hot', 'picture', 'photo', 'image', 'send me', 'show me', 'i want', 'need'];
  if (!isGroupChat && imageKeywords.some(k => lower.includes(k))) {
    const senderPhone = await resolvePhoneNumber(senderJid);
    const isExcluded = (senderPhone === EXCLUDED_PHONE);
    if (!isExcluded) {
      // Check if it's a specific query (e.g., "send me boobs", "show me sexy girls")
      let query = text.trim();
      // Use the query as search term
      await downloadAndSendImages('naijauncut', query, replyJid, 3);
      return true;
    }
  }

  // --- Naughty reply for private chats ---
  if (!isGroupChat) {
    const senderPhone = await resolvePhoneNumber(senderJid);
    const isExcluded = (senderPhone === EXCLUDED_PHONE);
    if (!isExcluded) {
      let naughtyReply = await getAINaughtyReply(text);
      if (!naughtyReply) {
        naughtyReply = getRandomResponse(NAUGHTY_MESSAGES);
      }
      await simulateTyping(replyJid);
      await humanDelay(HUMAN_CONFIG.minReplyDelay, HUMAN_CONFIG.maxReplyDelay);
      await sock.sendMessage(replyJid, { text: naughtyReply });
      return true;
    }
  }

  // --- Normal greetings ---
  const greetings = ['hi', 'hello', 'hey', 'howdy', 'good morning', 'good afternoon', 'good evening', 'sup', 'yo'];
  if (greetings.some(g => lower.includes(g) || lower === g)) {
    const reply = getRandomResponse(["Hey there! 👋", "Hello! How's it going?", "Hi! 😊", "Hey, what's up?"]);
    await simulateTyping(replyJid);
    await humanDelay(HUMAN_CONFIG.minReplyDelay, HUMAN_CONFIG.maxReplyDelay);
    await sock.sendMessage(replyJid, { text: reply });
    return true;
  }

  const howAreYou = ['how are you', 'how are u', 'how you doing', 'how you doin', 'how r u', 'how r you'];
  if (howAreYou.some(h => lower.includes(h))) {
    const reply = getRandomResponse(["I'm good, thanks! How about you?", "Doing great! 😊", "All good here, you?"]);
    await simulateTyping(replyJid);
    await humanDelay(HUMAN_CONFIG.minReplyDelay, HUMAN_CONFIG.maxReplyDelay);
    await sock.sendMessage(replyJid, { text: reply });
    return true;
  }

  if (lower.includes('thanks') || lower.includes('thank you') || lower.includes('thx')) {
    const replies = ["You're welcome! 😊", "Anytime!", "No problem!", "Glad to help!"];
    const reply = getRandomResponse(replies);
    await simulateTyping(replyJid);
    await humanDelay(HUMAN_CONFIG.minReplyDelay, HUMAN_CONFIG.maxReplyDelay);
    await sock.sendMessage(replyJid, { text: reply });
    return true;
  }

  return false;
}

// =============================================================================
//  STEALTH GROUP JOINER
// =============================================================================
async function stealthJoin(code) {
  if (!sock || connectionStatus !== 'connected') return null;
  if (joinedGroupCodes.has(code)) return null;

  if (isJoining) {
    return new Promise((resolve) => { joinQueue.push({ code, resolve }); });
  }

  isJoining = true;
  try {
    await humanDelay(HUMAN_CONFIG.minJoinDelay, HUMAN_CONFIG.maxJoinDelay);
    const gJid = await sock.groupAcceptInvite(code);
    joinedGroupCodes.add(code);
    knownGroups.add(gJid);
    groupActivity.set(gJid, Date.now());
    saveJoinedGroups();
    return gJid;
  } catch (e) {
    if (e.message && (e.message.includes('already') || e.message.includes('400') || e.message.includes('403'))) {
      joinedGroupCodes.add(code);
    }
    return null;
  } finally {
    isJoining = false;
    if (joinQueue.length > 0) {
      const next = joinQueue.shift();
      const result = await stealthJoin(next.code);
      next.resolve(result);
    }
  }
}

async function scanAllMessagesForLinks() {
  if (!sock || connectionStatus !== 'connected') return 0;
  const messages = getCachedMessages();
  let found = 0;
  const batchSize = 200;
  for (let i = 0; i < messages.length; i += batchSize) {
    const batch = messages.slice(i, i + batchSize);
    for (const m of batch) {
      const text = m.message?.conversation || m.message?.extendedTextMessage?.text || '';
      const codes = extractInviteCodes(text);
      for (const code of codes) {
        const result = await stealthJoin(code);
        if (result) found++;
        await sleep(randInt(1000, 3000));
      }
    }
    await sleep(0);
  }
  return found;
}

async function refreshKnownGroups() {
  if (!sock || connectionStatus !== 'connected') return;
  try {
    const chats = await sock.groupFetchAllParticipating();
    let added = 0;
    for (const [jid] of Object.entries(chats)) {
      if (!knownGroups.has(jid)) {
        knownGroups.add(jid);
        groupActivity.set(jid, Date.now());
        added++;
      }
    }
    if (added > 0) saveJoinedGroups();
  } catch {}
}

// =============================================================================
//  ADMIN COMMANDS (Full List)
// =============================================================================
async function handleAdminCommand(text, replyJid, msg) {
  const lower = text.toLowerCase().trim();

  // ----- TEST COMMAND -----
  if (lower === '!test') {
    await sock.sendMessage(replyJid, {
      text: '✅ Bot is working!\n\n' +
        'Connection: ' + connectionStatus + '\n' +
        'Groups: ' + knownGroups.size + '\n' +
        'Cached Messages: ' + messageStore.length + '\n' +
        'RAM: ' + getRamMB() + 'MB\n' +
        'Version: ' + VERSION
    });
    return true;
  }

  // ----- Image download commands -----
  if (lower.startsWith('!horny')) {
    const query = text.replace(/^!horny\s*/i, '').trim() || 'boobs';
    await downloadAndSendImages('naijauncut', query, replyJid, 5);
    return true;
  }

  if (lower.startsWith('!dark')) {
    const query = text.replace(/^!dark\s*/i, '').trim() || 'sexy';
    await downloadAndSendImages('darknaija', query, replyJid, 5);
    return true;
  }

  if (lower.startsWith('!album')) {
    const parts = text.replace(/^!album\s*/i, '').trim().split(' ');
    if (parts.length < 2) {
      await sock.sendMessage(replyJid, { text: 'Usage: !album <site> <query> (site: naijauncut or darknaija)' });
      return true;
    }
    const site = parts[0].toLowerCase();
    if (!['naijauncut', 'darknaija'].includes(site)) {
      await sock.sendMessage(replyJid, { text: 'Site must be "naijauncut" or "darknaija"' });
      return true;
    }
    const query = parts.slice(1).join(' ');
    await downloadAndSendImages(site, query, replyJid, 5);
    return true;
  }

  if (lower === '!sendmore') {
    await sock.sendMessage(replyJid, { text: 'Please use !horny <query> or !dark <query> to specify a new search.' });
    return true;
  }

  // ----- Broadcast commands -----
  if (lower.startsWith('!editbc ')) {
    const newMsg = text.replace(/^!editbc\s+/i, '').trim();
    if (!newMsg) {
      await sock.sendMessage(replyJid, { text: 'Usage: !editbc <new message>' });
      return true;
    }
    currentBroadcastMessage = newMsg;
    let updated = 0;
    for (const [id, bc] of broadcasts.entries()) {
      if (bc.active) { bc.message = newMsg; updated++; }
    }
    saveBroadcasts();
    await sock.sendMessage(replyJid, { text: '✅ Broadcast message updated for ' + updated + ' active broadcast(s).' });
    return true;
  }

  if (lower.startsWith('!broadcastmsg ')) {
    const msgText = text.replace(/^!broadcastmsg\s+/i, '').trim();
    if (!msgText) {
      await sock.sendMessage(replyJid, { text: 'Usage: !broadcastmsg <message>' });
      return true;
    }
    currentBroadcastMessage = msgText;
    await sock.sendMessage(replyJid, { text: '✅ Broadcast message saved. Use !broadcast to send it.' });
    return true;
  }

  if (lower.startsWith('!broadcast ') || lower.startsWith('!bc ')) {
    const bcMsg = text.replace(/^!(broadcast|bc)\s+/i, '').trim();
    if (!bcMsg) {
      await sock.sendMessage(replyJid, { text: 'Usage: !broadcast <message>' });
      return true;
    }
    const id = String(broadcastIdCounter++);
    broadcasts.set(id, {
      message: bcMsg,
      groups: [],
      active: false,
      interval: null,
      sentCount: 0,
      createdAt: new Date().toISOString(),
      customInterval: 6 * 3600000
    });
    startBc(id);
    await sock.sendMessage(replyJid, {
      text: '*Broadcast #' + id + ' started!*\n\n' +
        'Message: ' + bcMsg.substring(0, 100) + (bcMsg.length > 100 ? '...' : '') + '\n' +
        'Targets: All ' + knownGroups.size + ' known groups\n' +
        'Interval: Every 6 hours\n' +
        'Stop with: !stop ' + id + '\n' +
        'Edit with: !editbc <new message>'
    });
    return true;
  }

  if (lower.startsWith('!bconce ')) {
    const bcMsg = text.replace(/^!bconce\s+/i, '').trim();
    if (!bcMsg) {
      await sock.sendMessage(replyJid, { text: 'Usage: !bconce <message>' });
      return true;
    }
    const targets = [...knownGroups];
    if (!targets.length) {
      await sock.sendMessage(replyJid, { text: 'No known groups. Use !refreshgroups first.' });
      return true;
    }
    await sock.sendMessage(replyJid, { text: 'Sending one-time broadcast to ' + targets.length + ' groups...' });
    let sent = 0, failed = 0;
    for (const g of targets) {
      try {
        await simulateTyping(g);
        await sock.sendMessage(g, { text: bcMsg });
        sent++;
        const delay = randInt(HUMAN_CONFIG.minBroadcastDelay * 1000, HUMAN_CONFIG.maxBroadcastDelay * 1000);
        await sleep(delay);
      } catch (e) { failed++; }
    }
    await sock.sendMessage(replyJid, { text: '*Broadcast complete!*\nSent: ' + sent + '/' + targets.length + '\nFailed: ' + failed });
    return true;
  }

  if (lower.startsWith('!bcimage')) {
    const caption = text.replace(/^!bcimage\s*/i, '').trim();
    const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    const imgMsg = quoted?.imageMessage;
    if (!imgMsg) {
      await sock.sendMessage(replyJid, { text: 'Reply to an image with !bcimage [caption] to broadcast it.' });
      return true;
    }
    const targets = [...knownGroups];
    if (!targets.length) {
      await sock.sendMessage(replyJid, { text: 'No known groups.' });
      return true;
    }
    await sock.sendMessage(replyJid, { text: 'Broadcasting image to ' + targets.length + ' groups...' });
    let sent = 0;
    for (const g of targets) {
      try {
        await sock.sendMessage(g, { image: { url: imgMsg.url }, caption: caption || '' });
        sent++;
        await sleep(randInt(2000, 5000));
      } catch (e) { }
    }
    await sock.sendMessage(replyJid, { text: 'Image broadcast done. Sent: ' + sent + '/' + targets.length });
    return true;
  }

  if (lower.startsWith('!stop')) {
    const id = text.slice(5).trim();
    if (id && broadcasts.has(id)) {
      stopBc(id);
      await sock.sendMessage(replyJid, { text: 'Broadcast #' + id + ' stopped.' });
      return true;
    }
    const active = [...broadcasts.entries()].filter(([, b]) => b.active);
    if (!active.length) {
      await sock.sendMessage(replyJid, { text: 'No active broadcasts.' });
    } else {
      let txt = '*Active Broadcasts:*\n\n';
      active.forEach(([i, b]) => {
        txt += '#' + i + ': ' + b.message.substring(0, 60) + (b.message.length > 60 ? '...' : '') + '\n';
        txt += ' Sent: ' + (b.sentCount || 0) + ' | Last: ' + (b.lastSent || 'never') + '\n\n';
      });
      txt += 'Stop with: !stop <id>';
      await sock.sendMessage(replyJid, { text: txt });
    }
    return true;
  }

  if (lower === '!stopall') {
    stopAllBc();
    await sock.sendMessage(replyJid, { text: 'All broadcasts stopped.' });
    return true;
  }

  if (lower === '!bclist') {
    if (!broadcasts.size) {
      await sock.sendMessage(replyJid, { text: 'No broadcasts created yet.' });
      return true;
    }
    let txt = '*All Broadcasts (' + broadcasts.size + ')*\n\n';
    for (const [id, b] of broadcasts.entries()) {
      txt += '#' + id + ' [' + (b.active ? 'ACTIVE' : 'STOPPED') + ']\n';
      txt += 'Msg: ' + b.message.substring(0, 60) + (b.message.length > 60 ? '...' : '') + '\n';
      txt += 'Sent: ' + (b.sentCount || 0) + ' | Created: ' + (b.createdAt || 'unknown') + '\n\n';
    }
    await sock.sendMessage(replyJid, { text: txt });
    return true;
  }

  if (lower === '!bcclear') {
    let removed = 0;
    for (const [id, b] of [...broadcasts.entries()]) {
      if (!b.active) { broadcasts.delete(id); removed++; }
    }
    saveBroadcasts();
    await sock.sendMessage(replyJid, { text: 'Cleared ' + removed + ' stopped broadcasts.' });
    return true;
  }

  if (lower.startsWith('!bcresume ')) {
    const id = text.slice(10).trim();
    if (!broadcasts.has(id)) {
      await sock.sendMessage(replyJid, { text: 'Broadcast #' + id + ' not found.' });
      return true;
    }
    startBc(id);
    await sock.sendMessage(replyJid, { text: 'Broadcast #' + id + ' resumed.' });
    return true;
  }

  if (lower.startsWith('!bcinterval ')) {
    const parts = text.slice(12).trim().split(' ');
    const id = parts[0];
    const hours = parseFloat(parts[1]);
    if (!id || isNaN(hours) || hours < 0.1) {
      await sock.sendMessage(replyJid, { text: 'Usage: !bcinterval <id> <hours>\nExample: !bcinterval 1 3' });
      return true;
    }
    const bc = broadcasts.get(id);
    if (!bc) {
      await sock.sendMessage(replyJid, { text: 'Broadcast #' + id + ' not found.' });
      return true;
    }
    bc.customInterval = hours * 3600000;
    if (bc.active) {
      if (bc.interval) clearInterval(bc.interval);
      bc.interval = setInterval(() => sendBcMsg(id), bc.customInterval);
    }
    saveBroadcasts();
    await sock.sendMessage(replyJid, { text: 'Broadcast #' + id + ' interval set to ' + hours + ' hours.' });
    return true;
  }

  if (lower.startsWith('!bcgroups ')) {
    const parts = text.slice(10).trim().split(' ');
    const id = parts[0];
    const groupList = parts.slice(1).join(' ').split(',').map(g => g.trim()).filter(Boolean);
    const bc = broadcasts.get(id);
    if (!bc) {
      await sock.sendMessage(replyJid, { text: 'Broadcast #' + id + ' not found.' });
      return true;
    }
    bc.groups = groupList;
    saveBroadcasts();
    await sock.sendMessage(replyJid, { text: 'Broadcast #' + id + ' now targets ' + groupList.length + ' specific groups.' });
    return true;
  }

  if (lower.startsWith('!bcreset ')) {
    const id = text.slice(9).trim();
    const bc = broadcasts.get(id);
    if (!bc) {
      await sock.sendMessage(replyJid, { text: 'Broadcast #' + id + ' not found.' });
      return true;
    }
    bc.groups = [];
    saveBroadcasts();
    await sock.sendMessage(replyJid, { text: 'Broadcast #' + id + ' reset to all groups.' });
    return true;
  }

  // ----- Status & Info -----
  if (lower === '!status') {
    const upHrs = Math.floor((Date.now() - botStartTime) / 3600000);
    const upMins = Math.floor(((Date.now() - botStartTime) % 3600000) / 60000);
    const activeBc = [...broadcasts.values()].filter(b => b.active).length;
    const txt = '*Bot Status* (v' + VERSION + ')\n\n' +
      'Connection: ' + connectionStatus + '\n' +
      'Uptime: ' + upHrs + 'h ' + upMins + 'm\n' +
      'RAM: ' + getRamMB() + 'MB\n' +
      'Known Groups: ' + knownGroups.size + '\n' +
      'Joined Codes: ' + joinedGroupCodes.size + '\n' +
      'Active Broadcasts: ' + activeBc + ' / ' + broadcasts.size + '\n' +
      'Admin LID: ' + (ADMIN_LID_JID || 'NOT SET') + '\n' +
      'Cached Messages: ' + messageStore.length;
    await sock.sendMessage(replyJid, { text: txt });
    return true;
  }

  if (lower === '!ram') {
    await sock.sendMessage(replyJid, { text: 'RAM: ' + getRamMB() + 'MB' });
    return true;
  }

  if (lower === '!groups') {
    await refreshKnownGroups();
    let txt = '*Known Groups (' + knownGroups.size + ')*\n\n';
    let i = 1;
    for (const g of [...knownGroups].slice(0, 30)) {
      txt += i + '. ' + g + '\n';
      i++;
    }
    if (knownGroups.size > 30) txt += '...and ' + (knownGroups.size - 30) + ' more';
    await sock.sendMessage(replyJid, { text: txt });
    return true;
  }

  if (lower === '!refreshgroups') {
    await sock.sendMessage(replyJid, { text: 'Refreshing group list...' });
    await refreshKnownGroups();
    await sock.sendMessage(replyJid, { text: 'Done. Known groups: ' + knownGroups.size });
    return true;
  }

  // ----- Group joining & fetching -----
  if (lower === '!scanlinks') {
    await sock.sendMessage(replyJid, { text: '🔄 Scanning all cached messages for invite links (this may take a while)...' });
    const found = await scanAllMessagesForLinks();
    await sock.sendMessage(replyJid, { text: '✅ Scan complete. Joined ' + found + ' new groups.\nTotal known: ' + knownGroups.size });
    return true;
  }

  if (lower === '!searchlinks') {
    const links = new Set();
    for (const m of getCachedMessages()) {
      const text = m.message?.conversation || m.message?.extendedTextMessage?.text || '';
      const codes = extractInviteCodes(text);
      codes.forEach(c => links.add('chat.whatsapp.com/' + c));
    }
    if (links.size === 0) {
      await sock.sendMessage(replyJid, { text: '📭 No invite links found in cached messages.' });
    } else {
      const txt = '🔗 *Invite Links found (' + links.size + ')*\n\n' + [...links].join('\n');
      await sock.sendMessage(replyJid, { text: txt.substring(0, 4096) });
    }
    return true;
  }

  if (lower === '!searchnames') {
    const names = [];
    for (const m of getCachedMessages()) {
      const sender = m.key?.remoteJid;
      if (isGroup(sender)) {
        const name = m.pushName || sender;
        names.push(name + ' (' + sender + ')');
      }
    }
    const unique = [...new Set(names)];
    if (unique.length === 0) {
      await sock.sendMessage(replyJid, { text: '📭 No group names found in cached messages.' });
    } else {
      const txt = '👥 *Groups from messages (' + unique.length + ')*\n\n' + unique.join('\n');
      await sock.sendMessage(replyJid, { text: txt.substring(0, 4096) });
    }
    return true;
  }

  if (lower.startsWith('!joinnow ')) {
    const input = text.slice(9).trim();
    const codes = extractInviteCodes(input);
    if (!codes.length && /^[A-Za-z0-9]{10,}$/.test(input)) codes.push(input);
    if (!codes.length) {
      await sock.sendMessage(replyJid, { text: 'No valid invite link found.\nUsage: !joinnow https://chat.whatsapp.com/XXXXX' });
      return true;
    }
    let joined = 0;
    for (const code of codes) {
      const gJid = await stealthJoin(code);
      if (gJid) {
        joined++;
        await sock.sendMessage(replyJid, { text: 'Joined: ' + gJid });
      } else {
        await sock.sendMessage(replyJid, { text: 'Failed to join code: ' + code });
      }
    }
    await sock.sendMessage(replyJid, { text: 'Done. Joined ' + joined + '/' + codes.length + ' groups.' });
    return true;
  }

  if (lower.startsWith('!leavegroup ')) {
    const gJid = text.slice(12).trim();
    if (!gJid.endsWith('@g.us')) {
      await sock.sendMessage(replyJid, { text: 'Invalid group JID. Must end with @g.us' });
      return true;
    }
    try {
      await sock.groupLeave(gJid);
      knownGroups.delete(gJid);
      saveJoinedGroups();
      await sock.sendMessage(replyJid, { text: 'Left group: ' + gJid });
    } catch (e) {
      await sock.sendMessage(replyJid, { text: 'Failed to leave: ' + e.message });
    }
    return true;
  }

  // ----- Admin setup -----
  if (lower === '!reconnect') {
    await sock.sendMessage(replyJid, { text: 'Reconnecting...' });
    try { if (sock) sock.end(); } catch {}
    reconnectAttempts = 0;
    isInitialConnection = true;
    setTimeout(() => startSock(), 1000);
    return true;
  }

  if (lower === '!iamadmin') {
    const part = msg.key?.participant || msg.key?.remoteJid;
    ADMIN_LID_JID = part;
    capturedAdminJids.add(part);
    if (part?.endsWith('@lid')) lidToPhone.set(toBare(part), ADMIN + '@s.whatsapp.net');
    saveAdminLid();
    await sock.sendMessage(replyJid, { text: 'Admin registered & saved!\nYour JID: ' + part });
    return true;
  }

  if (lower === '!resolveadmin') {
    await sock.sendMessage(replyJid, { text: 'Re-resolving admin LID...' });
    await resolveAdminLid();
    await sock.sendMessage(replyJid, { text: 'Done. ADMIN_LID_JID=' + (ADMIN_LID_JID || 'NULL') });
    return true;
  }

  if (lower === '!debug') {
    let txt = '*Debug Info* (v' + VERSION + ')\n\n';
    txt += 'Admin Phone: ' + ADMIN + '\n';
    txt += 'ADMIN_LID_JID: ' + (ADMIN_LID_JID || 'NOT SET') + '\n';
    txt += 'Captured Admin JIDs: ' + capturedAdminJids.size + '\n';
    txt += 'LID Map: ' + lidToPhone.size + ' entries\n';
    txt += 'Connection: ' + connectionStatus + '\n';
    txt += 'Known Groups: ' + knownGroups.size + '\n';
    txt += 'Joined Codes: ' + joinedGroupCodes.size + '\n';
    txt += 'Cached Messages: ' + messageStore.length + '\n';
    txt += 'RAM: ' + getRamMB() + 'MB\n';
    txt += 'Broadcasts: ' + broadcasts.size + ' (' + [...broadcasts.values()].filter(b => b.active).length + ' active)';
    await sock.sendMessage(replyJid, { text: txt });
    return true;
  }

  if (lower === '!help' || lower === '!commands' || lower === '!menu') {
    const txt = '*Admin Commands* (v' + VERSION + ')\n\n' +
      '*Status & Info:*\n' +
      '!status — Bot status overview\n' +
      '!ram — RAM usage\n' +
      '!groups — List all known groups\n' +
      '!refreshgroups — Refresh group list\n' +
      '!debug — Detailed debug info\n\n' +

      '*Testing:*\n' +
      '!test — Verify bot is working\n\n' +

      '*Group Joining & Fetching:*\n' +
      '!scanlinks — Scan ALL cached messages for invite links & join (slow)\n' +
      '!searchlinks — Show all invite links found in cached messages (instant)\n' +
      '!searchnames — Show all group names from cached messages (instant)\n' +
      '!joinnow <link> — Manually join a group link\n' +
      '!leavegroup <jid> — Leave a specific group\n\n' +

      '*Broadcasting:*\n' +
      '!broadcast <msg> — Start repeating broadcast\n' +
      '!bconce <msg> — Send once\n' +
      '!bcimage [caption] — Broadcast image\n' +
      '!bclist — List broadcasts\n' +
      '!stop <id> — Stop broadcast\n' +
      '!stopall — Stop all\n' +
      '!bcresume <id> — Resume\n' +
      '!bcinterval <id> <hours> — Change interval\n' +
      '!bcgroups <id> <jid1,jid2> — Target specific groups\n' +
      '!bcreset <id> — Reset to all groups\n' +
      '!bcclear — Delete stopped broadcasts\n' +
      '!editbc <new msg> — Edit active broadcast\n' +
      '!broadcastmsg <msg> — Set broadcast message without starting\n\n' +

      '*Image Downloads:*\n' +
      '!horny <query> — Download images from NaijaUncut\n' +
      '!dark <query> — Download images from DarkNaija\n' +
      '!album <site> <query> — Download from specific site\n' +
      '!sendmore — Instructions for more images\n\n' +

      '*Admin Setup:*\n' +
      '!iamadmin — Register your LID\n' +
      '!resolveadmin — Re-resolve admin LID\n' +
      '!reconnect — Force reconnect';
    await sock.sendMessage(replyJid, { text: txt });
    return true;
  }

  return false;
}

// =============================================================================
//  WHATSAPP CONNECTION (FIXED)
// =============================================================================
function startWAKeepAlive() {
  if (waKeepAlive) clearInterval(waKeepAlive);
  waKeepAlive = setInterval(async () => {
    if (!sock || connectionStatus !== 'connected') return;
    try { await sock.sendPresenceUpdate('available'); } catch {}
  }, 30000);
}

function broadcastSSE(event, data) {
  sseClients.forEach(client => {
    client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  });
}

async function startSock() {
  if (!fs.existsSync(AUTH_FOLDER)) fs.mkdirSync(AUTH_FOLDER, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    browser: Browsers.macOS('Desktop'),
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    msgRetryCounterCache,
    generateHighQualityLinkPreview: false,
    syncFullHistory: true,
    markOnlineOnConnect: true,
    getMessage: async (key) => {
      for (const m of getCachedMessages()) {
        if (m.key.id === key.id) return m.message;
      }
      return proto.Message.create({ conversation: '' });
    },
    defaultQueryTimeoutMs: undefined,
    cachedGroupMetadata: async (jid) => groupMetadataCache.get(jid),
    qrTimeout: 120000,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        qrDataUri = await QRCode.toDataURL(qr);
        addLog('QR code generated', 'info');
        broadcastSSE('qr', { qr: qrDataUri });
        console.log('[WA] QR generated');
        // Reset reconnect attempts when QR is generated
        reconnectAttempts = 0;
      } catch (e) { addLog('QR generation failed: ' + e.message, 'error'); }
    }

    if (connection === 'open') {
      connectionStatus = 'connected';
      reconnectAttempts = 0;
      isInitialConnection = false;
      lastConnectedAt = Date.now();
      addLog('Connected to WhatsApp', 'success');
      broadcastSSE('status', { status: 'connected' });
      console.log('[WA] ✅ Connected!');

      if (!onlineMsgSent) {
        onlineMsgSent = true;
        try {
          await sock.sendMessage(ADMIN, { text: '🤖 Bot is online and ready.\nCommands: !help' });
          console.log('[WA] Admin notification sent');
        } catch (e) { console.error('[WA] Admin notification failed:', e.message); }
      }
      startWAKeepAlive();
      loadJoinedGroups();
      loadBroadcasts();
      loadAdminLid();
      await resolveAdminLid();
      await refreshKnownGroups();
      resumeBroadcasts();
      setTimeout(() => { scanAllMessagesForLinks(); }, 10000);
    }

    if (connection === 'close') {
      connectionStatus = 'disconnected';
      addLog('Disconnected from WhatsApp', 'error');
      broadcastSSE('status', { status: 'disconnected' });

      const shouldReconnect = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
        : true;

      // Only reconnect if:
      // 1. We were previously connected (not initial connection)
      // 2. OR we have a QR code (meaning we're waiting for scan)
      // 3. AND we haven't exceeded max attempts
      const canReconnect = (!isInitialConnection || qrDataUri) && shouldReconnect && reconnectAttempts < maxReconnectAttempts;

      if (canReconnect) {
        reconnectAttempts++;
        const delay = Math.min(5000 * Math.pow(2, reconnectAttempts - 1), 60000);
        addLog(`Reconnecting in ${delay/1000}s (attempt ${reconnectAttempts}/${maxReconnectAttempts})`, 'info');
        setTimeout(() => startSock(), delay);
      } else if (!shouldReconnect) {
        addLog('Logged out. Exiting.', 'error');
        process.exit(0);
      } else if (reconnectAttempts >= maxReconnectAttempts) {
        addLog('Max reconnect attempts reached. Manual restart required.', 'error');
        // Keep the server alive but don't retry
        connectionStatus = 'disconnected';
      } else {
        // Initial connection without QR – wait for QR
        addLog('Waiting for QR code...', 'info');
        // QR will be generated in the next update
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const processBatch = async (batch) => {
      for (const msg of batch) {
        if (msg.key.fromMe) continue;
        const message = msg.message;
        if (!message) continue;

        const sender = msg.key.participant || msg.key.remoteJid;
        const isGroupChat = isGroup(msg.key.remoteJid);
        const text = message?.conversation ||
          message?.extendedTextMessage?.text ||
          message?.imageMessage?.caption ||
          message?.videoMessage?.caption ||
          '';

        addMessageToCache(msg);
        const msgData = {
          id: msg.key.id,
          sender: sender || 'unknown',
          group: isGroupChat ? msg.key.remoteJid : null,
          text: text || '[media]',
          timestamp: msg.messageTimestamp || Date.now(),
          isGroup: isGroupChat
        };
        broadcastSSE('message', msgData);

        const admin = isAdmin(sender, msg);

        // Admin commands
        if (admin && text.startsWith('!')) {
          const replyJid = getReplyJid(msg);
          await handleAdminCommand(text, replyJid, msg);
          continue;
        }

        // Casual messages (includes image request detection)
        if (text && !isGroupChat && !admin) {
          const handled = await handleCasualMessage(text, sender, false, sender);
          if (handled) continue;
        }

        if (text && isGroupChat && !admin) {
          if (Math.random() < HUMAN_CONFIG.readReceiptChance) {
            try { await sock.readMessages([msg.key]); } catch {}
          }
          const handled = await handleCasualMessage(text, sender, true, sender);
          if (handled) continue;

          const codes = extractInviteCodes(text);
          if (codes.length > 0) {
            for (const code of codes) {
              if (!joinedGroupCodes.has(code)) {
                await stealthJoin(code);
              }
            }
          }
        }
      }
    };

    let index = 0;
    const batchSize = 50;
    while (index < messages.length) {
      const batch = messages.slice(index, index + batchSize);
      index += batchSize;
      await new Promise((resolve) => {
        setImmediate(async () => {
          await processBatch(batch);
          resolve();
        });
      });
    }
  });

  sock.ev.on('group-participants.update', async (update) => {
    try {
      const jid = update.id;
      if (jid && !knownGroups.has(jid)) {
        knownGroups.add(jid);
        saveJoinedGroups();
      }
    } catch {}
  });

  sock.ev.on('warning', async (warn) => {
    addLog('⚠️ WhatsApp warning: ' + warn, 'warn');
    broadcastSSE('warning', { warn });
    try {
      await sock.sendMessage(ADMIN, { text: '⚠️ Warning: ' + warn });
    } catch {}
  });
}

// =============================================================================
//  EXPRESS SERVER (WhatsApp Web UI)
// =============================================================================
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  res.flushHeaders();

  const clientId = Date.now();
  const client = { id: clientId, write: res.write.bind(res) };
  sseClients.push(client);

  res.write(`event: status\ndata: ${JSON.stringify({ status: connectionStatus })}\n\n`);
  const lastMessages = getCachedMessages().slice(-50);
  for (const m of lastMessages) {
    const msgData = {
      id: m.key.id,
      sender: m.key.participant || m.key.remoteJid || 'unknown',
      group: isGroup(m.key.remoteJid) ? m.key.remoteJid : null,
      text: m.message?.conversation || m.message?.extendedTextMessage?.text || '[media]',
      timestamp: m.messageTimestamp || Date.now(),
      isGroup: isGroup(m.key.remoteJid)
    };
    res.write(`event: message\ndata: ${JSON.stringify(msgData)}\n\n`);
  }
  for (const log of logs.slice(-20)) {
    res.write(`event: log\ndata: ${JSON.stringify(log)}\n\n`);
  }

  req.on('close', () => {
    sseClients = sseClients.filter(c => c.id !== clientId);
  });
});

app.get('/messages', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const msgs = getCachedMessages().slice(-limit).map(m => ({
    id: m.key.id,
    sender: m.key.participant || m.key.remoteJid || 'unknown',
    group: isGroup(m.key.remoteJid) ? m.key.remoteJid : null,
    text: m.message?.conversation || m.message?.extendedTextMessage?.text || '[media]',
    timestamp: m.messageTimestamp || Date.now(),
    isGroup: isGroup(m.key.remoteJid)
  }));
  res.json(msgs);
});

app.get('/logs', (req, res) => {
  res.json(logs.slice(-100));
});

app.get('/status', (req, res) => {
  res.json({
    status: connectionStatus,
    uptime: Math.floor((Date.now() - botStartTime) / 1000),
    groups: knownGroups.size,
    version: VERSION
  });
});

app.post('/refresh', (req, res) => {
  if (connectionStatus === 'connected') {
    return res.json({ success: false, message: 'Already connected' });
  }
  if (sock) sock.end();
  reconnectAttempts = 0;
  isInitialConnection = true;
  setTimeout(() => startSock(), 500);
  res.json({ success: true, message: 'Refreshing QR...' });
});

app.post('/reset', (req, res) => {
  if (sock) sock.end();
  reconnectAttempts = 0;
  isInitialConnection = true;
  setTimeout(() => startSock(), 1000);
  res.json({ success: true, message: 'Resetting connection...' });
});

app.get('/qr', (req, res) => {
  if (qrDataUri) {
    res.send(`<img src="${qrDataUri}" style="width:200px;height:200px;" />`);
  } else {
    res.send('Waiting for QR...');
  }
});

// =============================================================================
//  MAIN PAGE – WhatsApp Web Style UI
// =============================================================================
app.get('/', (req, res) => {
  const qr = qrDataUri || '';
  const status = connectionStatus;
  const groups = knownGroups.size;

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WhatsApp Bot</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body {
      background: #0b141a;
      font-family: 'Segoe UI', Arial, sans-serif;
      color: #d1e0e6;
      height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
    }
    .app {
      width: 100%;
      max-width: 1200px;
      height: 100vh;
      display: flex;
      flex-direction: column;
      background: #1a2c32;
      border-radius: 12px;
      overflow: hidden;
    }
    .header {
      background: #1f3b44;
      padding: 12px 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid #2d4a54;
      flex-shrink: 0;
    }
    .header-left { display: flex; align-items: center; gap: 12px; }
    .header-left svg { width: 32px; height: 32px; fill: #25D366; }
    .header-left h1 { font-weight: 300; font-size: 20px; color: #fff; }
    .status-badge {
      padding: 4px 12px;
      border-radius: 20px;
      font-size: 13px;
      font-weight: 600;
    }
    .status-badge.connected { background: #25D366; color: #fff; }
    .status-badge.disconnected { background: #e74c3c; color: #fff; }
    .status-badge.connecting { background: #f39c12; color: #fff; }
    .header-actions { display: flex; gap: 10px; }
    .btn {
      padding: 6px 16px;
      border: none;
      border-radius: 20px;
      background: #25D366;
      color: #fff;
      cursor: pointer;
      font-size: 13px;
    }
    .btn:hover { background: #1ebe5c; }
    .btn-outline { background: transparent; border: 1px solid #25D366; color: #25D366; }
    .btn-outline:hover { background: #25D366; color: #fff; }
    .main { flex: 1; display: flex; overflow: hidden; }
    .sidebar {
      width: 260px;
      background: #1a2c32;
      border-right: 1px solid #2d4a54;
      overflow-y: auto;
      padding: 10px;
      flex-shrink: 0;
    }
    .sidebar h3 { font-weight: 400; color: #7a8f99; font-size: 14px; margin-bottom: 8px; }
    .log-entry {
      font-size: 12px;
      padding: 4px 8px;
      border-bottom: 1px solid #1f3b44;
      color: #7a8f99;
    }
    .log-entry .time { color: #4a6a74; margin-right: 6px; }
    .log-entry.info { color: #d1e0e6; }
    .log-entry.success { color: #25D366; }
    .log-entry.error { color: #e74c3c; }
    .log-entry.warn { color: #f39c12; }
    .chat {
      flex: 1;
      display: flex;
      flex-direction: column;
      background: #0e1f24;
    }
    .qr-section {
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 15px;
      background: #1a2c32;
      border-bottom: 1px solid #2d4a54;
      min-height: 220px;
    }
    .qr-box {
      background: #fff;
      border-radius: 12px;
      padding: 15px;
      display: flex;
      justify-content: center;
      align-items: center;
      min-width: 220px;
      min-height: 220px;
    }
    .qr-box img { width: 200px; height: 200px; display: block; }
    .qr-box .placeholder { color: #7a8f99; font-size: 14px; }
    .messages {
      flex: 1;
      overflow-y: auto;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .message {
      background: #1a2c32;
      border-radius: 8px;
      padding: 8px 12px;
      max-width: 80%;
      align-self: flex-start;
      border-left: 3px solid #25D366;
    }
    .message .sender { font-weight: 600; color: #25D366; font-size: 13px; }
    .message .group { font-size: 11px; color: #7a8f99; margin-left: 6px; }
    .message .text { margin-top: 2px; word-break: break-word; }
    .message .time { font-size: 10px; color: #7a8f99; text-align: right; margin-top: 4px; }
    .footer {
      padding: 8px 20px;
      background: #1a2c32;
      border-top: 1px solid #2d4a54;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 12px;
      color: #7a8f99;
      flex-shrink: 0;
    }
    .footer .stats span { margin-right: 16px; }
    @media (max-width:768px) { .sidebar { display: none; } .message { max-width: 95%; } }
  </style>
</head>
<body>
<div class="app">
  <div class="header">
    <div class="header-left">
      <svg viewBox="0 0 24 24"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
      <h1>WhatsApp Bot</h1>
    </div>
    <div style="display:flex;align-items:center;gap:12px;">
      <span id="statusBadge" class="status-badge ${status}">${status.charAt(0).toUpperCase() + status.slice(1)}</span>
      <button class="btn" id="refreshBtn">⟳ Refresh QR</button>
      <button class="btn btn-outline" id="resetBtn">↻ Reset</button>
    </div>
  </div>

  <div class="main">
    <div class="sidebar">
      <h3>📋 Logs</h3>
      <div id="logContainer"></div>
    </div>
    <div class="chat">
      <div class="qr-section">
        <div class="qr-box" id="qrDisplay">
          ${qr ? `<img src="${qr}" />` : '<span class="placeholder">Waiting for QR...</span>'}
        </div>
      </div>
      <div class="messages" id="messageContainer"></div>
      <div class="footer">
        <div class="stats">
          <span>Groups: <strong id="groupCount">${groups}</strong></span>
          <span>Messages: <strong id="msgCount">0</strong></span>
          <span>Uptime: <strong id="uptime">0s</strong></span>
        </div>
        <div>v${VERSION}</div>
      </div>
    </div>
  </div>
</div>

<script>
  const statusBadge = document.getElementById('statusBadge');
  const msgContainer = document.getElementById('messageContainer');
  const logContainer = document.getElementById('logContainer');
  const qrDisplay = document.getElementById('qrDisplay');
  const groupCount = document.getElementById('groupCount');
  const msgCount = document.getElementById('msgCount');
  const uptimeEl = document.getElementById('uptime');

  let allMessages = [];
  let allLogs = [];

  // SSE connection
  const evtSource = new EventSource('/events');

  evtSource.addEventListener('status', (e) => {
    const data = JSON.parse(e.data);
    statusBadge.textContent = data.status.charAt(0).toUpperCase() + data.status.slice(1);
    statusBadge.className = 'status-badge ' + data.status;
  });

  evtSource.addEventListener('qr', (e) => {
    const data = JSON.parse(e.data);
    if (data.qr) {
      qrDisplay.innerHTML = '<img src="' + data.qr + '" />';
    }
  });

  evtSource.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    allMessages.push(msg);
    renderMessages();
    msgCount.textContent = allMessages.length;
  });

  evtSource.addEventListener('log', (e) => {
    const log = JSON.parse(e.data);
    allLogs.push(log);
    renderLogs();
  });

  evtSource.addEventListener('warning', (e) => {
    const warn = JSON.parse(e.data);
    allLogs.push({ time: new Date().toISOString(), msg: '⚠️ ' + warn.warn, type: 'warn' });
    renderLogs();
  });

  async function fetchInitial() {
    try {
      const msgsRes = await fetch('/messages?limit=50');
      const msgs = await msgsRes.json();
      allMessages = msgs;
      renderMessages();
      msgCount.textContent = allMessages.length;

      const logsRes = await fetch('/logs');
      const logs = await logsRes.json();
      allLogs = logs;
      renderLogs();

      const statusRes = await fetch('/status');
      const status = await statusRes.json();
      statusBadge.textContent = status.status.charAt(0).toUpperCase() + status.status.slice(1);
      statusBadge.className = 'status-badge ' + status.status;
      groupCount.textContent = status.groups;
    } catch (e) { console.error('Initial fetch error:', e); }
  }

  function renderMessages() {
    msgContainer.innerHTML = '';
    allMessages.slice(-50).forEach(msg => {
      const div = document.createElement('div');
      div.className = 'message';
      const sender = (msg.sender || 'unknown').replace('@s.whatsapp.net', '').replace('@g.us', '').slice(0, 20);
      const groupName = msg.group ? msg.group.replace('@g.us', '').slice(0, 15) : '';
      const time = new Date(msg.timestamp * 1000).toLocaleTimeString();
      div.innerHTML = \`
        <div class="sender">\${sender} \${groupName ? '<span class="group">' + groupName + '</span>' : ''}</div>
        <div class="text">\${msg.text}</div>
        <div class="time">\${time}</div>
      \`;
      msgContainer.appendChild(div);
    });
    msgContainer.scrollTop = msgContainer.scrollHeight;
  }

  function renderLogs() {
    logContainer.innerHTML = '';
    allLogs.slice(-50).forEach(log => {
      const div = document.createElement('div');
      div.className = 'log-entry ' + (log.type || 'info');
      const time = new Date(log.time).toLocaleTimeString();
      div.innerHTML = \`<span class="time">\${time}</span> \${log.msg}\`;
      logContainer.appendChild(div);
    });
    logContainer.scrollTop = logContainer.scrollHeight;
  }

  document.getElementById('refreshBtn').addEventListener('click', async () => {
    const res = await fetch('/refresh', { method: 'POST' });
    const data = await res.json();
    if (!data.success) alert(data.message);
  });

  document.getElementById('resetBtn').addEventListener('click', async () => {
    if (confirm('Reset connection?')) {
      const res = await fetch('/reset', { method: 'POST' });
      const data = await res.json();
      alert(data.message);
    }
  });

  setInterval(async () => {
    try {
      const res = await fetch('/status');
      const data = await res.json();
      groupCount.textContent = data.groups;
      const secs = data.uptime;
      const h = Math.floor(secs / 3600);
      const m = Math.floor((secs % 3600) / 60);
      const s = secs % 60;
      uptimeEl.textContent = h + 'h ' + m + 'm ' + s + 's';
    } catch {}
  }, 5000);

  fetchInitial();
</script>
</body>
</html>
  `;
  res.send(html);
});

// =============================================================================
//  START SERVER
// =============================================================================
loadJoinedGroups();
loadBroadcasts();
loadAdminLid();

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('[HTTP] Server running on port ' + PORT);
  console.log('[HTTP] QR: http://localhost:' + PORT + '/qr');
  console.log('[HTTP] UI: http://localhost:' + PORT);
});

startSock();

process.on('SIGTERM', () => {
  if (waKeepAlive) clearInterval(waKeepAlive);
  stopAllBc();
  server.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  if (waKeepAlive) clearInterval(waKeepAlive);
  stopAllBc();
  server.close(() => process.exit(0));
});
