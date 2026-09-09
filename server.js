'use strict';

const express = require('express');
const http = require('http');
const https = require('https');
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

const VERSION = '21.0';
const ADMIN = '263777627210';
const AUTH_FOLDER = 'auth_info';
const PORT = process.env.PORT || 10000;
const MAX_CACHED_MESSAGES = 10000;
const MESSAGE_PROCESS_BATCH = 50;

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

const GREETING_RESPONSES = [
  "Hey there! 👋",
  "Hello! How's it going?",
  "Hi! 😊",
  "Hey, what's up?",
  "Hello there!",
  "Hi, how can I help?",
];
const HOW_ARE_YOU_RESPONSES = [
  "I'm good, thanks! How about you?",
  "Doing great! 😊",
  "All good here, you?",
  "Fine, thanks for asking!",
  "Couldn't be better!",
];

let sock = null;
let qrCodeData = null;
let connectionStatus = 'disconnected';
let reconnectAttempts = 0;
let lastConnectedAt = 0;
let onlineMsgSent = false;
let botStartTime = Date.now();

let ADMIN_LID_JID = null;
const capturedAdminJids = new Set();
const lidToPhone = new Map();

const knownGroups = new Set();
const groupActivity = new Map();
const joinedGroupCodes = new Set();

const messageStore = [];

const broadcasts = new Map();
let broadcastIdCounter = 1;
let currentBroadcastMessage = '';

const msgRateLimiter = new Map();
const MSG_RATE_PER_USER = 10;
const MSG_RATE_WINDOW = 30000;

let waKeepAlive = null;
let lastKeepAlivePing = 0;

let joinQueue = [];
let isJoining = false;

const logger = pino({ level: 'silent' });
const msgRetryCounterCache = new NodeCache();
const groupMetadataCache = new NodeCache({ stdTTL: 300, useClones: false });

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
    const duration = randInt(HUMAN_CONFIG.typingDurationMin, HUMAN_CONFIG.typingDurationMax);
    await sleep(duration);
    await sock.sendPresenceUpdate('paused', jid);
  } catch (e) { }
}

function getRandomResponse(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function getRamMB() {
  try { return Math.round(process.memoryUsage().heapUsed / 1024 / 1024); } catch { return 0; }
}

function addMessageToCache(msg) {
  messageStore.push(msg);
  if (messageStore.length > MAX_CACHED_MESSAGES) {
    messageStore.shift();
  }
}

function getCachedMessages() {
  return messageStore;
}

function extractInviteCodes(text) {
  if (!text) return [];
  const regex = /chat\.whatsapp\.com\/([A-Za-z0-9]{10,})/g;
  const codes = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    codes.push(match[1]);
  }
  return codes;
}

async function stealthJoin(code) {
  if (!sock || connectionStatus !== 'connected') return null;
  if (joinedGroupCodes.has(code)) return null;

  if (isJoining) {
    return new Promise((resolve) => {
      joinQueue.push({ code, resolve });
    });
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
    if (added > 0) {
      saveJoinedGroups();
    }
  } catch (e) { }
}

const BROADCASTS_FILE = 'broadcasts.json';
const JOINED_GROUPS_FILE = 'joined_groups.json';
const ADMIN_LID_FILE = 'admin_lid.json';

function saveJoinedGroups() {
  try {
    const data = {
      groups: [...knownGroups],
      codes: [...joinedGroupCodes],
      savedAt: new Date().toISOString()
    };
    fs.writeFileSync(JOINED_GROUPS_FILE, JSON.stringify(data, null, 2));
  } catch (e) { }
}

function loadJoinedGroups() {
  try {
    if (fs.existsSync(JOINED_GROUPS_FILE)) {
      const data = JSON.parse(fs.readFileSync(JOINED_GROUPS_FILE, 'utf8'));
      if (data.groups) data.groups.forEach(g => knownGroups.add(g));
      if (data.codes) data.codes.forEach(c => joinedGroupCodes.add(c));
    }
  } catch (e) { }
}

function saveBroadcasts() {
  try {
    const d = {};
    broadcasts.forEach((v, k) => d[k] = {
      message: v.message,
      groups: v.groups,
      active: v.active,
      sentCount: v.sentCount,
      createdAt: v.createdAt,
      customInterval: v.customInterval
    });
    fs.writeFileSync(BROADCASTS_FILE, JSON.stringify(d, null, 2));
  } catch (e) { }
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
  } catch (e) { }
}

function saveAdminLid() {
  try {
    const data = {
      jid: ADMIN_LID_JID,
      savedAt: new Date().toISOString(),
      lidToPhone: Object.fromEntries(lidToPhone)
    };
    fs.writeFileSync(ADMIN_LID_FILE, JSON.stringify(data, null, 2));
  } catch (e) { }
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
  } catch (e) { }
}

async function resolveAdminLid() {
  try {
    const result = await sock.onWhatsApp(ADMIN + '@s.whatsapp.net');
    if (Array.isArray(result) && result.length > 0 && result[0].exists) {
      const r = result[0];
      if (r.lid) {
        ADMIN_LID_JID = r.lid + '@lid';
        lidToPhone.set(r.lid, ADMIN + '@s.whatsapp.net');
      } else if (r.jid && r.jid.endsWith('@lid')) {
        ADMIN_LID_JID = r.jid;
      }
      if (ADMIN_LID_JID) saveAdminLid();
    }
  } catch (e) { }
}

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
  if (msg?.key?.senderPn) {
    if (msg.key.senderPn.split(':')[0] === ADMIN) return true;
  }
  if (msg?.key?.participantPn) {
    if (msg.key.participantPn.split(':')[0] === ADMIN) return true;
  }
  return capturedAdminJids.has(jid) || capturedAdminJids.has(participant);
}

function getReplyJid(msg) {
  const sender = msg.key?.remoteJid;
  if (!isGroup(sender)) {
    return msg?.key?.participantPn || msg?.key?.senderPn || sender;
  }
  return sender;
}

function getBcInterval(bc) {
  return bc.customInterval || 6 * 3600000;
}

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
    } catch (e) {
      failed++;
    }
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

async function handleCasualMessage(text, replyJid, msg) {
  if (!text) return false;
  const lower = text.toLowerCase().trim();

  const greetings = ['hi', 'hello', 'hey', 'howdy', 'good morning', 'good afternoon', 'good evening', 'sup', 'yo'];
  if (greetings.some(g => lower.includes(g) || lower === g)) {
    const reply = getRandomResponse(GREETING_RESPONSES);
    await simulateTyping(replyJid);
    await humanDelay(HUMAN_CONFIG.minReplyDelay, HUMAN_CONFIG.maxReplyDelay);
    await sock.sendMessage(replyJid, { text: reply });
    return true;
  }

  const howAreYou = ['how are you', 'how are u', 'how you doing', 'how you doin', 'how r u', 'how r you'];
  if (howAreYou.some(h => lower.includes(h))) {
    const reply = getRandomResponse(HOW_ARE_YOU_RESPONSES);
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

async function handleAdminCommand(text, replyJid, msg) {
  const lower = text.toLowerCase().trim();

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

  if (lower === '!reconnect') {
    await sock.sendMessage(replyJid, { text: 'Reconnecting...' });
    try { if (sock) sock.end(); } catch {}
    reconnectAttempts = 0;
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

      '*Admin Setup:*\n' +
      '!iamadmin — Register your LID\n' +
      '!resolveadmin — Re-resolve admin LID\n' +
      '!reconnect — Force reconnect';
    await sock.sendMessage(replyJid, { text: txt });
    return true;
  }

  return false;
}

function startWAKeepAlive() {
  if (waKeepAlive) clearInterval(waKeepAlive);
  waKeepAlive = setInterval(async () => {
    if (!sock || connectionStatus !== 'connected') return;
    try {
      await sock.sendPresenceUpdate('available');
      lastKeepAlivePing = Date.now();
    } catch {}
  }, 30000);
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
    getMessage: async (key) => {
      for (const m of getCachedMessages()) {
        if (m.key.id === key.id) return m.message;
      }
      return proto.Message.create({ conversation: '' });
    },
    defaultQueryTimeoutMs: undefined,
    cachedGroupMetadata: async (jid) => groupMetadataCache.get(jid)
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      qrCodeData = qr;
    }
    if (connection === 'open') {
      connectionStatus = 'connected';
      reconnectAttempts = 0;
      lastConnectedAt = Date.now();
      if (!onlineMsgSent) {
        onlineMsgSent = true;
        try {
          await sock.sendMessage(ADMIN + '@s.whatsapp.net', { text: '🤖 Bot is online and ready.\nCommands: !help' });
        } catch (e) { }
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
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
        : true;
      if (shouldReconnect && reconnectAttempts < 10) {
        reconnectAttempts++;
        const delay = Math.min(5000 * Math.pow(2, reconnectAttempts - 1), 60000);
        setTimeout(() => startSock(), delay);
      } else if (!shouldReconnect) {
        process.exit(0);
      } else {
        process.exit(1);
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

        const admin = isAdmin(sender, msg);

        if (admin && text.startsWith('!')) {
          const replyJid = getReplyJid(msg);
          await handleAdminCommand(text, replyJid, msg);
          continue;
        }

        if (text && isGroupChat && !admin) {
          if (Math.random() < HUMAN_CONFIG.readReceiptChance) {
            try { await sock.readMessages([msg.key]); } catch {}
          }
          const handled = await handleCasualMessage(text, sender, msg);
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
    } catch (e) { }
  });

  sock.ev.on('warning', async (warn) => {
    try {
      await sock.sendMessage(ADMIN + '@s.whatsapp.net', { text: '⚠️ Warning: ' + warn });
    } catch (e) { }
  });
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/qr', (req, res) => {
  if (qrCodeData) {
    res.send(`
      <html><head><title>QR</title></head>
      <body style="display:flex;justify-content:center;align-items:center;height:100vh;background:#0a0a0a;">
        <div style="text-align:center;background:#1a1a1a;padding:40px;border-radius:20px;">
          <h1 style="color:#fff;">Scan QR</h1>
          <img src="data:image/png;base64,${qrCodeData}" style="border-radius:10px;border:2px solid #25D366;background:white;padding:10px;" />
          <p style="color:#888;">Open WhatsApp → Settings → Linked Devices</p>
        </div>
      </body>
    `);
  } else {
    res.send('<h1>Waiting for QR...</h1>');
  }
});

app.get('/', (req, res) => {
  res.json({
    status: connectionStatus,
    uptime: Math.floor((Date.now() - botStartTime) / 1000),
    groups: knownGroups.size,
    version: VERSION
  });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('[HTTP] Server running on port ' + PORT);
  console.log('[HTTP] QR: http://localhost:' + PORT + '/qr');
});

loadJoinedGroups();
loadBroadcasts();
loadAdminLid();

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
