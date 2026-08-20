// ================================================================================
//  WHATSAPP BOT v19.0 — Stealth Group Joiner + Broadcaster
//  Features: Auto-join any group link (stealth) + Broadcast to all groups
//  Admin commands for full control
// ================================================================================

'use strict';

// ================================================================================
//  SECTION 1: IMPORTS
// ================================================================================
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

// ================================================================================
//  SECTION 2: CONFIGURATION
// ================================================================================
const VERSION = '19.0';
const ADMIN = '263777627210';          // Admin phone number (no + or spaces)
const AUTH_FOLDER = 'auth_info';
const PORT = process.env.PORT || 10000;
const MAX_RAM_MB = 512;
const RAM_ABORT_PCT = 80;
const BROADCASTS_FILE = 'broadcasts.json';
const ADMIN_LID_FILE = path.join(__dirname, 'admin_lid.json');
const JOINED_GROUPS_FILE = path.join(__dirname, 'joined_groups.json');

// ================================================================================
//  SECTION 3: STATE
// ================================================================================
let sock = null;
let qrCodeData = null;
let connectionStatus = 'disconnected';
let reconnectAttempts = 0;
let lastConnectedAt = 0;
let onlineMsgSent = false;
let botStartTime = Date.now();

// Admin LID tracking (for LID-based WhatsApp groups)
let ADMIN_LID_JID = null;
const capturedAdminJids = new Set();
const lidToPhone = new Map();

// Group tracking
const knownGroups = new Set();          // All known group JIDs
const groupActivity = new Map();        // groupJid -> last activity timestamp
const joinedGroupCodes = new Set();     // Invite codes already joined
const messageStore = new Map();         // msgId -> msg
const msgRetryCounterCache = new NodeCache();
const groupMetadataCache = new NodeCache({ stdTTL: 300, useClones: false });

// Broadcast system
const broadcasts = new Map();           // id -> broadcast object
let broadcastIdCounter = 1;

// Rate limiting
const msgRateLimiter = new Map();
const MSG_RATE_PER_USER = 10;
const MSG_RATE_WINDOW = 30000;

// Keep-alive
let waKeepAlive = null;
let lastKeepAlivePing = 0;

const logger = pino({ level: 'silent' });

// ================================================================================
//  SECTION 4: UTILITIES
// ================================================================================
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

function getRamMB() {
  try { return Math.round(process.memoryUsage().heapUsed / 1024 / 1024); } catch { return 0; }
}
function isRamSafe() { return getRamMB() < (MAX_RAM_MB * RAM_ABORT_PCT / 100); }

function httpGet(url, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch { resolve(data); }
        } else reject(new Error('HTTP ' + res.statusCode));
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('HTTP_TIMEOUT')); });
  });
}

// ================================================================================
//  SECTION 5: PERSISTENCE
// ================================================================================
function saveJoinedGroups() {
  try {
    const data = {
      groups: [...knownGroups],
      codes: [...joinedGroupCodes],
      savedAt: new Date().toISOString()
    };
    fs.writeFileSync(JOINED_GROUPS_FILE, JSON.stringify(data, null, 2));
  } catch (e) { console.error('[Save] Groups error:', e.message); }
}

function loadJoinedGroups() {
  try {
    if (fs.existsSync(JOINED_GROUPS_FILE)) {
      const data = JSON.parse(fs.readFileSync(JOINED_GROUPS_FILE, 'utf8'));
      if (data.groups) data.groups.forEach(g => knownGroups.add(g));
      if (data.codes) data.codes.forEach(c => joinedGroupCodes.add(c));
      console.log('[Load] Loaded ' + knownGroups.size + ' groups, ' + joinedGroupCodes.size + ' codes');
    }
  } catch (e) { console.error('[Load] Groups error:', e.message); }
}

function saveBroadcasts() {
  try {
    const d = {};
    broadcasts.forEach((v, k) => d[k] = { message: v.message, groups: v.groups, active: v.active, sentCount: v.sentCount, createdAt: v.createdAt });
    fs.writeFileSync(BROADCASTS_FILE, JSON.stringify(d, null, 2));
  } catch (e) { console.error('[BC] Save err:', e.message); }
}

function loadBroadcasts() {
  try {
    if (fs.existsSync(BROADCASTS_FILE)) {
      const d = JSON.parse(fs.readFileSync(BROADCASTS_FILE, 'utf8'));
      Object.entries(d).forEach(([id, b]) => {
        broadcasts.set(String(id), { ...b, active: false, interval: null });
      });
      broadcastIdCounter = Math.max(broadcastIdCounter, ...[...broadcasts.keys()].map(Number)) + 1;
      console.log('[BC] Loaded ' + broadcasts.size + ' broadcasts');
    }
  } catch (e) { console.error('[BC] Load err:', e.message); }
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
        console.log('[AdminLid] Loaded: ' + ADMIN_LID_JID);
      }
    }
  } catch (e) { console.error('[AdminLid] Load failed:', e.message); }
}

function saveAdminLid() {
  try {
    const data = { jid: ADMIN_LID_JID, savedAt: new Date().toISOString(), lidToPhone: Object.fromEntries(lidToPhone) };
    fs.writeFileSync(ADMIN_LID_FILE, JSON.stringify(data, null, 2));
    console.log('[AdminLid] Saved: ' + ADMIN_LID_JID);
  } catch (e) { console.error('[AdminLid] Save failed:', e.message); }
}

// ================================================================================
//  SECTION 6: ADMIN DETECTION
// ================================================================================
async function resolveAdminLid() {
  try {
    const result = await sock.onWhatsApp(ADMIN + '@s.whatsapp.net');
    console.log('[AdminLid] onWhatsApp result:', JSON.stringify(result));
    if (Array.isArray(result) && result.length > 0 && result[0].exists) {
      const r = result[0];
      if (r.lid) {
        ADMIN_LID_JID = r.lid + '@lid';
        lidToPhone.set(r.lid, ADMIN + '@s.whatsapp.net');
      } else if (r.jid && r.jid.endsWith('@lid')) {
        ADMIN_LID_JID = r.jid;
      }
      if (ADMIN_LID_JID) {
        saveAdminLid();
        console.log('[AdminLid] SET: ' + ADMIN_LID_JID);
      }
    }
  } catch (e) { console.error('[AdminLid] onWhatsApp error:', e.message); }
}

function isAdmin(jid, msg) {
  if (!jid) return false;
  // DM check
  if (!isGroup(jid)) {
    const dmBare = toBare(jid);
    if (dmBare === ADMIN || (ADMIN_LID_JID && jid === ADMIN_LID_JID)) {
      captureAdminJid(jid, msg);
      return true;
    }
    // Check captured JIDs
    if (capturedAdminJids.has(jid)) return true;
    return false;
  }
  // Group checks
  const participant = msg?.key?.participant;
  if (participant && toBare(participant) === ADMIN) return true;
  if (ADMIN_LID_JID && participant === ADMIN_LID_JID) return true;
  if (participant?.endsWith('@lid')) {
    const mapped = lidToPhone.get(toBare(participant));
    if (mapped && toBare(mapped) === ADMIN) return true;
  }
  if (msg?.key?.senderPn) {
    const pn = msg.key.senderPn.split(':')[0];
    if (pn === ADMIN) return true;
  }
  if (msg?.key?.participantPn) {
    const pn = msg.key.participantPn.split(':')[0];
    if (pn === ADMIN) return true;
  }
  if (participant && capturedAdminJids.has(participant)) return true;
  return false;
}

function captureAdminJid(dmJid, msg) {
  capturedAdminJids.add(dmJid);
  if (msg?.key?.participant) capturedAdminJids.add(msg.key.participant);
  const ppn = msg?.key?.participantPn || msg?.key?.senderPn;
  if (ppn) capturedAdminJids.add(ppn);
}

function getReplyJid(msg) {
  const sender = msg.key?.remoteJid;
  if (!isGroup(sender)) {
    const ppn = msg?.key?.participantPn || msg?.key?.senderPn;
    if (ppn) return ppn;
  }
  return sender;
}

// ================================================================================
//  SECTION 7: BROADCAST SYSTEM
// ================================================================================
function getBcInterval() {
  // Default: broadcast every 6 hours
  return 6 * 3600000;
}

function startBc(id) {
  const bc = broadcasts.get(id);
  if (!bc) return;
  if (bc.interval) clearInterval(bc.interval);
  bc.active = true;
  bc.sentCount = bc.sentCount || 0;
  sendBcMsg(id);
  bc.interval = setInterval(() => sendBcMsg(id), getBcInterval());
  saveBroadcasts();
  console.log('[BC] Started broadcast #' + id);
}

async function sendBcMsg(id) {
  const bc = broadcasts.get(id);
  if (!bc || !bc.active || !sock || connectionStatus !== 'connected') return;

  // Use all known groups if no specific groups set
  const targets = bc.groups && bc.groups.length > 0 ? bc.groups : [...knownGroups];
  if (!targets.length) {
    console.log('[BC] No groups to broadcast to for #' + id);
    return;
  }

  let sent = 0;
  let failed = 0;
  for (const g of targets) {
    try {
      await sock.sendMessage(g, { text: bc.message });
      sent++;
      await sleep(randInt(1500, 4000)); // Stealth delay between sends
    } catch (e) {
      failed++;
      console.error('[BC] Failed to send to ' + g + ': ' + e.message);
    }
  }
  bc.sentCount = (bc.sentCount || 0) + sent;
  bc.lastSent = new Date().toISOString();
  bc.lastSentCount = sent;
  saveBroadcasts();
  console.log('[BC] #' + id + ' sent to ' + sent + '/' + targets.length + ' groups (' + failed + ' failed)');
}

function stopBc(id) {
  const bc = broadcasts.get(id);
  if (!bc) return;
  if (bc.interval) clearInterval(bc.interval);
  bc.active = false;
  bc.interval = null;
  saveBroadcasts();
  console.log('[BC] Stopped broadcast #' + id);
}

function stopAllBc() {
  for (const [id] of broadcasts.entries()) stopBc(id);
}

// Resume active broadcasts after reconnect
function resumeBroadcasts() {
  for (const [id, bc] of broadcasts.entries()) {
    if (bc.active) {
      if (bc.interval) clearInterval(bc.interval);
      bc.interval = setInterval(() => sendBcMsg(id), getBcInterval());
      console.log('[BC] Resumed broadcast #' + id);
    }
  }
}

// ================================================================================
//  SECTION 8: STEALTH GROUP JOINER
// ================================================================================
// Extract all WhatsApp invite codes from a text string
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

// Stealthily join a group by invite code
async function stealthJoin(code) {
  if (!sock || connectionStatus !== 'connected') return null;
  if (joinedGroupCodes.has(code)) {
    console.log('[Join] Already joined code: ' + code);
    return null;
  }
  try {
    // Random delay for stealth (1-5 seconds)
    await sleep(randInt(1000, 5000));
    const gJid = await sock.groupAcceptInvite(code);
    joinedGroupCodes.add(code);
    knownGroups.add(gJid);
    groupActivity.set(gJid, Date.now());
    saveJoinedGroups();
    console.log('[Join] Joined group: ' + gJid + ' (code: ' + code + ')');
    return gJid;
  } catch (e) {
    console.log('[Join] Failed to join code ' + code + ': ' + e.message);
    // Mark as seen even if failed (to avoid retry spam)
    if (e.message && (e.message.includes('already') || e.message.includes('400') || e.message.includes('403'))) {
      joinedGroupCodes.add(code);
    }
    return null;
  }
}

// Scan all stored messages for invite links and join them
async function scanAndJoinFromMessages() {
  if (!sock || connectionStatus !== 'connected') return;
  console.log('[Scan] Scanning ' + messageStore.size + ' stored messages for invite links...');
  let found = 0;

  for (const [, m] of messageStore.entries()) {
    const t = m.message?.conversation || m.message?.extendedTextMessage?.text || '';
    const codes = extractInviteCodes(t);
    for (const code of codes) {
      const gJid = await stealthJoin(code);
      if (gJid) found++;
    }
  }

  // Also scan Baileys internal store
  try {
    const store = sock.store;
    if (store?.messages) {
      for (const jid of Object.keys(store.messages)) {
        const msgs = store.messages[jid];
        if (!msgs) continue;
        const msgList = msgs instanceof Map ? [...msgs.values()] : (Array.isArray(msgs) ? msgs : []);
        for (const m of msgList.slice(-200)) {
          const t = m.message?.conversation || m.message?.extendedTextMessage?.text || '';
          const codes = extractInviteCodes(t);
          for (const code of codes) {
            const gJid = await stealthJoin(code);
            if (gJid) found++;
          }
        }
      }
    }
  } catch (e) { console.log('[Scan] store.messages error: ' + e.message); }

  console.log('[Scan] Done. Joined ' + found + ' new groups. Total known: ' + knownGroups.size);
  return found;
}

// Fetch all groups the bot is currently participating in
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
      console.log('[Groups] Refreshed: +' + added + ' new, total=' + knownGroups.size);
    }
  } catch (e) { console.error('[Groups] Refresh error:', e.message); }
}

// ================================================================================
//  SECTION 9: ADMIN COMMANDS HANDLER
// ================================================================================
async function handleAdminCommand(text, replyJid, msg) {
  const lower = text.toLowerCase().trim();

  // ─── !status ───────────────────────────────────────────────────────────────
  if (lower === '!status') {
    const upHrs = Math.floor((Date.now() - botStartTime) / 3600000);
    const upMins = Math.floor(((Date.now() - botStartTime) % 3600000) / 60000);
    const activeBc = [...broadcasts.values()].filter(b => b.active).length;
    const txt =
      '*Bot Status* (v' + VERSION + ')\n\n' +
      'Connection: ' + connectionStatus + '\n' +
      'Uptime: ' + upHrs + 'h ' + upMins + 'm\n' +
      'RAM: ' + getRamMB() + 'MB / ' + MAX_RAM_MB + 'MB\n' +
      'Known Groups: ' + knownGroups.size + '\n' +
      'Joined Codes: ' + joinedGroupCodes.size + '\n' +
      'Active Broadcasts: ' + activeBc + ' / ' + broadcasts.size + '\n' +
      'Admin LID: ' + (ADMIN_LID_JID || 'NOT SET — send !iamadmin in a group') + '\n' +
      'LID Map: ' + lidToPhone.size + ' entries';
    await sock.sendMessage(replyJid, { text: txt });
    return true;
  }

  // ─── !ram ──────────────────────────────────────────────────────────────────
  if (lower === '!ram') {
    await sock.sendMessage(replyJid, {
      text: 'RAM: ' + getRamMB() + 'MB / ' + MAX_RAM_MB + 'MB (' + Math.round(getRamMB() / MAX_RAM_MB * 100) + '%)'
    });
    return true;
  }

  // ─── !groups ───────────────────────────────────────────────────────────────
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

  // ─── !refreshgroups ────────────────────────────────────────────────────────
  if (lower === '!refreshgroups') {
    await sock.sendMessage(replyJid, { text: 'Refreshing group list...' });
    await refreshKnownGroups();
    await sock.sendMessage(replyJid, { text: 'Done. Known groups: ' + knownGroups.size });
    return true;
  }

  // ─── !scanlinks ────────────────────────────────────────────────────────────
  if (lower === '!scanlinks') {
    await sock.sendMessage(replyJid, { text: 'Scanning all messages for group invite links...' });
    const found = await scanAndJoinFromMessages();
    await sock.sendMessage(replyJid, { text: 'Scan complete. Joined ' + (found || 0) + ' new groups.\nTotal known: ' + knownGroups.size });
    return true;
  }

  // ─── !broadcast <message> ──────────────────────────────────────────────────
  if (lower.startsWith('!broadcast ') || lower.startsWith('!bc ')) {
    const bcMsg = text.replace(/^!(broadcast|bc)\s+/i, '').trim();
    if (!bcMsg) {
      await sock.sendMessage(replyJid, { text: 'Usage: !broadcast <message>\nExample: !broadcast Hello everyone!' });
      return true;
    }
    const id = String(broadcastIdCounter++);
    broadcasts.set(id, {
      message: bcMsg,
      groups: [],           // empty = all known groups
      active: false,
      interval: null,
      sentCount: 0,
      createdAt: new Date().toISOString()
    });
    startBc(id);
    await sock.sendMessage(replyJid, {
      text: '*Broadcast #' + id + ' started!*\n\nMessage: ' + bcMsg.substring(0, 100) + (bcMsg.length > 100 ? '...' : '') + '\nTargets: All ' + knownGroups.size + ' known groups\nInterval: Every 6 hours\n\nStop with: !stop ' + id
    });
    return true;
  }

  // ─── !bconce <message> — send once, no repeat ──────────────────────────────
  if (lower.startsWith('!bconce ')) {
    const bcMsg = text.replace(/^!bconce\s+/i, '').trim();
    if (!bcMsg) {
      await sock.sendMessage(replyJid, { text: 'Usage: !bconce <message>' });
      return true;
    }
    const targets = [...knownGroups];
    if (!targets.length) {
      await sock.sendMessage(replyJid, { text: 'No known groups to broadcast to. Use !refreshgroups first.' });
      return true;
    }
    await sock.sendMessage(replyJid, { text: 'Sending one-time broadcast to ' + targets.length + ' groups...' });
    let sent = 0;
    let failed = 0;
    for (const g of targets) {
      try {
        await sock.sendMessage(g, { text: bcMsg });
        sent++;
        await sleep(randInt(1500, 4000));
      } catch (e) {
        failed++;
        console.error('[BCOnce] Failed ' + g + ': ' + e.message);
      }
    }
    await sock.sendMessage(replyJid, {
      text: '*Broadcast complete!*\nSent: ' + sent + '/' + targets.length + '\nFailed: ' + failed
    });
    return true;
  }

  // ─── !bcimage <caption> — broadcast an image (reply to image with this) ────
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
      } catch (e) { console.error('[BCImg] Failed ' + g + ': ' + e.message); }
    }
    await sock.sendMessage(replyJid, { text: 'Image broadcast done. Sent: ' + sent + '/' + targets.length });
    return true;
  }

  // ─── !stop <id> — stop a broadcast ────────────────────────────────────────
  if (lower.startsWith('!stop')) {
    const id = text.slice(5).trim();
    if (id && broadcasts.has(id)) {
      stopBc(id);
      await sock.sendMessage(replyJid, { text: 'Broadcast #' + id + ' stopped.' });
      return true;
    }
    // List active broadcasts
    const active = [...broadcasts.entries()].filter(([, b]) => b.active);
    if (!active.length) {
      await sock.sendMessage(replyJid, { text: 'No active broadcasts.' });
    } else {
      let txt = '*Active Broadcasts:*\n\n';
      active.forEach(([i, b]) => {
        txt += '#' + i + ': ' + b.message.substring(0, 60) + (b.message.length > 60 ? '...' : '') + '\n';
        txt += '  Sent: ' + (b.sentCount || 0) + ' times | Last: ' + (b.lastSent || 'never') + '\n\n';
      });
      txt += 'Stop with: !stop <id>';
      await sock.sendMessage(replyJid, { text: txt });
    }
    return true;
  }

  // ─── !stopall — stop all broadcasts ───────────────────────────────────────
  if (lower === '!stopall') {
    stopAllBc();
    await sock.sendMessage(replyJid, { text: 'All broadcasts stopped.' });
    return true;
  }

  // ─── !bclist — list all broadcasts ────────────────────────────────────────
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

  // ─── !bcclear — delete all stopped broadcasts ─────────────────────────────
  if (lower === '!bcclear') {
    let removed = 0;
    for (const [id, b] of [...broadcasts.entries()]) {
      if (!b.active) { broadcasts.delete(id); removed++; }
    }
    saveBroadcasts();
    await sock.sendMessage(replyJid, { text: 'Cleared ' + removed + ' stopped broadcasts.' });
    return true;
  }

  // ─── !bcresume <id> — resume a stopped broadcast ──────────────────────────
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

  // ─── !bcinterval <id> <hours> — change broadcast interval ─────────────────
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

  // ─── !bcgroups <id> <group1,group2,...> — target specific groups ───────────
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

  // ─── !bcreset <id> — reset to all groups ──────────────────────────────────
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

  // ─── !joinnow <link> — manually join a group link ─────────────────────────
  if (lower.startsWith('!joinnow ')) {
    const input = text.slice(9).trim();
    const codes = extractInviteCodes(input);
    // Also try raw code
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
        await sock.sendMessage(replyJid, { text: 'Failed to join code: ' + code + ' (may already be joined or invalid)' });
      }
    }
    await sock.sendMessage(replyJid, { text: 'Done. Joined ' + joined + '/' + codes.length + ' groups.' });
    return true;
  }

  // ─── !leavegroup <jid> — leave a specific group ───────────────────────────
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

  // ─── !reconnect ────────────────────────────────────────────────────────────
  if (lower === '!reconnect') {
    await sock.sendMessage(replyJid, { text: 'Reconnecting...' });
    try {
      if (sock) { sock.ev.removeAllListeners('connection.update'); sock.end(); }
    } catch {}
    reconnectAttempts = 0;
    setTimeout(() => startSock(), 1000);
    return true;
  }

  // ─── !iamadmin — register admin LID ───────────────────────────────────────
  if (lower === '!iamadmin') {
    const part = msg.key?.participant || msg.key?.remoteJid;
    ADMIN_LID_JID = part;
    capturedAdminJids.add(part);
    if (part?.endsWith('@lid')) {
      lidToPhone.set(toBare(part), ADMIN + '@s.whatsapp.net');
    }
    saveAdminLid();
    await sock.sendMessage(replyJid, {
      text: 'Admin registered & saved!\nYour JID: ' + part + '\nADMIN_LID_JID: ' + ADMIN_LID_JID
    });
    return true;
  }

  // ─── !resolveadmin — force re-resolve admin LID ───────────────────────────
  if (lower === '!resolveadmin') {
    await sock.sendMessage(replyJid, { text: 'Re-resolving admin LID...' });
    await resolveAdminLid();
    await sock.sendMessage(replyJid, { text: 'Done. ADMIN_LID_JID=' + (ADMIN_LID_JID || 'NULL') });
    return true;
  }

  // ─── !debug ────────────────────────────────────────────────────────────────
  if (lower === '!debug') {
    let txt = '*Debug Info* (v' + VERSION + ')\n\n';
    txt += 'Admin Phone: ' + ADMIN + '\n';
    txt += 'ADMIN_LID_JID: ' + (ADMIN_LID_JID || 'NOT SET') + '\n';
    txt += 'Captured Admin JIDs: ' + capturedAdminJids.size + '\n';
    txt += 'LID Map: ' + lidToPhone.size + ' entries\n';
    txt += 'Connection: ' + connectionStatus + '\n';
    txt += 'Known Groups: ' + knownGroups.size + '\n';
    txt += 'Joined Codes: ' + joinedGroupCodes.size + '\n';
    txt += 'Message Store: ' + messageStore.size + '\n';
    txt += 'RAM: ' + getRamMB() + 'MB / ' + MAX_RAM_MB + 'MB\n';
    txt += 'Broadcasts: ' + broadcasts.size + ' (' + [...broadcasts.values()].filter(b => b.active).length + ' active)\n';
    await sock.sendMessage(replyJid, { text: txt });
    return true;
  }

  // ─── !help / !commands ─────────────────────────────────────────────────────
  if (lower === '!help' || lower === '!commands' || lower === '!menu') {
    const txt =
      '*Admin Commands* (v' + VERSION + ')\n\n' +
      '*Status & Info:*\n' +
      '!status — Bot status overview\n' +
      '!ram — RAM usage\n' +
      '!groups — List all known groups\n' +
      '!refreshgroups — Refresh group list\n' +
      '!debug — Detailed debug info\n\n' +
      '*Group Joining:*\n' +
      '!scanlinks — Scan messages for invite links & join\n' +
      '!joinnow <link> — Manually join a group link\n' +
      '!leavegroup <jid> — Leave a specific group\n\n' +
      '*Broadcasting:*\n' +
      '!broadcast <msg> — Start repeating broadcast to all groups\n' +
      '!bconce <msg> — Send once to all groups (no repeat)\n' +
      '!bcimage [caption] — Broadcast image (reply to image)\n' +
      '!bclist — List all broadcasts\n' +
      '!stop <id> — Stop a broadcast\n' +
      '!stopall — Stop all broadcasts\n' +
      '!bcresume <id> — Resume a stopped broadcast\n' +
      '!bcinterval <id> <hours> — Change broadcast interval\n' +
      '!bcgroups <id> <jid1,jid2> — Target specific groups\n' +
      '!bcreset <id> — Reset to all groups\n' +
      '!bcclear — Delete all stopped broadcasts\n\n' +
      '*Admin Setup:*\n' +
      '!iamadmin — Register your LID (send in a group)\n' +
      '!resolveadmin — Force re-resolve admin LID\n' +
      '!reconnect — Force reconnect\n';
    await sock.sendMessage(replyJid, { text: txt });
    return true;
  }

  return false; // Not an admin command
}

// ================================================================================
//  SECTION 10: WHATSAPP CONNECTION
// ================================================================================
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
  console.log('[WA] Starting v' + VERSION + '...');
  connectionStatus = 'connecting';

  if (!fs.existsSync(AUTH_FOLDER)) fs.mkdirSync(AUTH_FOLDER, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version } = await fetchLatestBaileysVersion();
  console.log('[WA] Baileys v' + version.join('.'));

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
      const s = messageStore.get(key.id);
      return s?.message || proto.Message.create({ conversation: '' });
    },
    defaultQueryTimeoutMs: undefined,
    cachedGroupMetadata: async (jid) => groupMetadataCache.get(jid)
  });

  // ─── Connection Update ──────────────────────────────────────────────────────
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      connectionStatus = 'qr';
      try {
        qrCodeData = await QRCode.toDataURL(qr, { width: 300, margin: 2, color: { dark: '#000000', light: '#ffffff' } });
        console.log('[WA] QR code generated — scan at http://localhost:' + PORT);
      } catch {}
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      qrCodeData = null;
      connectionStatus = 'disconnected';

      if (code === DisconnectReason.loggedOut) {
        console.log('[WA] Logged out. Clearing auth...');
        try { fs.rmSync(AUTH_FOLDER, { recursive: true, force: true }); } catch {}
        reconnectAttempts = 0;
      }

      reconnectAttempts++;
      const delay = Math.min(3000 + reconnectAttempts * 2000, 30000);
      console.log('[WA] Disconnected (code=' + code + '). Reconnecting in ' + delay + 'ms (attempt ' + reconnectAttempts + ')...');
      setTimeout(() => startSock(), delay);
    }

    if (connection === 'open') {
      console.log('[WA] CONNECTED');
      reconnectAttempts = 0;
      lastConnectedAt = Date.now();
      connectionStatus = 'connected';
      qrCodeData = null;
      startWAKeepAlive();

      // Refresh known groups
      await refreshKnownGroups();

      // Scan for invite links after a short delay
      setTimeout(async () => {
        await scanAndJoinFromMessages();
      }, 8000);

      // Resolve admin LID
      await resolveAdminLid();

      // Resume any active broadcasts
      resumeBroadcasts();

      // Send online notification to admin
      if (!onlineMsgSent) {
        onlineMsgSent = true;
        try {
          await sock.sendMessage(ADMIN + '@s.whatsapp.net', {
            text:
              '*Bot Online!* (v' + VERSION + ')\n\n' +
              'Known Groups: ' + knownGroups.size + '\n' +
              'Active Broadcasts: ' + [...broadcasts.values()].filter(b => b.active).length + '\n' +
              'Admin LID: ' + (ADMIN_LID_JID || 'NOT SET — send !iamadmin in a group') + '\n' +
              'RAM: ' + getRamMB() + 'MB / ' + MAX_RAM_MB + 'MB\n\n' +
              'Send !help for all commands.'
          });
          console.log('[WA] Online notification sent to admin.');
        } catch (e) { console.error('[WA] Online notification failed:', e.message); }
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // ─── Message Handler ────────────────────────────────────────────────────────
  sock.ev.on('messages.upsert', async (upsert) => {
    const isNotify = upsert.type === 'notify';
    const isAppend = upsert.type === 'append';
    if (!isNotify && !isAppend) return;

    try {
      for (const msg of upsert.messages) {
        const sender = msg.key?.remoteJid;
        const fromMe = msg.key?.fromMe;
        if (!sender) continue;

        // Store message
        if (msg.key.id) messageStore.set(msg.key.id, msg);
        // Trim store
        if (messageStore.size > 1000) {
          const first = messageStore.keys().next().value;
          if (first) messageStore.delete(first);
        }

        // Track groups
        if (isGroup(sender)) {
          knownGroups.add(sender);
          groupActivity.set(sender, Date.now());
        }

        // Build LID map
        const ppn = msg.key?.participantPn || msg.key?.senderPn;
        const participant = msg.key?.participant;
        if (ppn && participant?.endsWith('@lid')) {
          const pnBare = toBare(ppn);
          if (pnBare.match(/^\d+$/) && pnBare.length > 8) {
            lidToPhone.set(toBare(participant), ppn);
          }
        }

        // For history messages: only store, don't process
        if (isAppend) continue;

        const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
        if (!text && !fromMe) continue;
        if (fromMe) continue; // Skip our own messages

        const adminCheck = isAdmin(sender, msg);
        const replyJid = getReplyJid(msg);

        // ─── AUTO-JOIN: Detect invite links in any message ──────────────────
        if (text) {
          const codes = extractInviteCodes(text);
          for (const code of codes) {
            console.log('[AutoJoin] Found invite code: ' + code + ' in message from ' + toBare(participant || sender));
            // Join stealthily in background (don't await to avoid blocking)
            stealthJoin(code).catch(e => console.error('[AutoJoin] Error:', e.message));
          }
        }

        // ─── ADMIN DM COMMANDS ──────────────────────────────────────────────
        if (adminCheck && !isGroup(sender)) {
          try {
            const handled = await handleAdminCommand(text, replyJid, msg);
            if (!handled && text) {
              // Unknown command — show help
              await sock.sendMessage(replyJid, {
                text: 'Unknown command: "' + text.substring(0, 50) + '"\n\nSend *!help* for all commands.'
              });
            }
          } catch (e) {
            console.error('[Admin] Command error:', e.message);
            try { await sock.sendMessage(replyJid, { text: 'Error: ' + e.message }); } catch {}
          }
        }

        // ─── ADMIN GROUP COMMANDS (admin sends !command in a group) ─────────
        if (adminCheck && isGroup(sender) && text.startsWith('!')) {
          try {
            await handleAdminCommand(text, replyJid, msg);
          } catch (e) {
            console.error('[Admin] Group command error:', e.message);
          }
        }
      }
    } catch (e) {
      console.error('[MSG] Unhandled error:', e.message, e.stack?.substring(0, 200));
    }
  });

  // ─── Group Events ───────────────────────────────────────────────────────────
  sock.ev.on('group-participants.update', async (data) => {
    try {
      if (!data?.id) return;
      knownGroups.add(data.id);
      groupActivity.set(data.id, Date.now());
      // Refresh metadata cache
      try {
        const meta = await sock.groupMetadata(data.id);
        if (meta) groupMetadataCache.set(data.id, meta);
      } catch {}
    } catch (e) { console.error('[Groups] Participant event error:', e.message); }
  });

  // ─── History Sync ───────────────────────────────────────────────────────────
  sock.ev.on('messaging-history.set', ({ messages, contacts }) => {
    try {
      // Build LID map from contacts
      if (contacts?.length) {
        for (const c of contacts) {
          if (c.id?.endsWith('@lid') && c.jid && c.jid.endsWith('@s.whatsapp.net')) {
            lidToPhone.set(toBare(c.id), c.jid);
          }
        }
      }
      // Store messages
      if (messages?.length) {
        let stored = 0;
        for (const m of messages) {
          if (m.key?.id) {
            messageStore.set(m.key.id, m);
            stored++;
            // Track groups from history
            const s = m.key?.remoteJid;
            if (s && isGroup(s)) knownGroups.add(s);
            // Build LID map from history
            const ppn2 = m.key?.participantPn || m.key?.senderPn;
            const part2 = m.key?.participant;
            if (ppn2 && part2?.endsWith('@lid')) {
              const pnBare = toBare(ppn2);
              if (pnBare.match(/^\d+$/) && pnBare.length > 8) {
                lidToPhone.set(toBare(part2), ppn2);
              }
            }
          }
        }
        console.log('[History] Stored ' + stored + ' messages, groups: ' + knownGroups.size);
      }
      // Trim store
      while (messageStore.size > 1000) {
        const first = messageStore.keys().next().value;
        if (first) messageStore.delete(first);
      }
    } catch (e) { console.error('[History]', e.message); }
  });

  // ─── Chat/Group Updates ─────────────────────────────────────────────────────
  sock.ev.on('chats.update', (chats) => {
    try {
      for (const c of (chats || [])) {
        if (c.id?.endsWith('@g.us')) knownGroups.add(c.id);
      }
    } catch {}
  });

  sock.ev.on('groups.update', (groups) => {
    try {
      for (const g of (groups || [])) {
        if (g.id) knownGroups.add(g.id);
      }
    } catch {}
  });

  // ─── LID Resolution Events ──────────────────────────────────────────────────
  sock.ev.on('contacts.upsert', (contacts) => {
    try {
      for (const c of (contacts || [])) {
        if (c.id?.endsWith('@lid') && c.jid && c.jid.endsWith('@s.whatsapp.net')) {
          lidToPhone.set(toBare(c.id), c.jid);
        }
      }
    } catch {}
  });

  sock.ev.on('contacts.update', (contacts) => {
    try {
      for (const c of (contacts || [])) {
        if (c.id?.endsWith('@lid') && c.jid && c.jid.endsWith('@s.whatsapp.net')) {
          lidToPhone.set(toBare(c.id), c.jid);
        }
      }
    } catch {}
  });

  sock.ev.on('chats.phoneNumberShare', ({ lid, jid }) => {
    try {
      if (lid && jid) {
        lidToPhone.set(toBare(lid), jid);
        console.log('[LID] phoneNumberShare: ' + toBare(lid) + ' -> ' + jid);
      }
    } catch {}
  });
}

// ================================================================================
//  SECTION 11: EXPRESS WEB SERVER (QR Code + Status)
// ================================================================================
const app = express();
app.use(express.json());

// QR Code page
app.get('/', (req, res) => {
  if (connectionStatus === 'connected') {
    return res.send(`
      <!DOCTYPE html><html><head><title>WhatsApp Bot</title>
      <meta http-equiv="refresh" content="10">
      <style>body{font-family:Arial,sans-serif;text-align:center;padding:40px;background:#f0f0f0;}
      .status{background:#25D366;color:white;padding:20px;border-radius:10px;font-size:24px;margin:20px auto;max-width:400px;}
      .info{background:white;padding:20px;border-radius:10px;margin:20px auto;max-width:400px;text-align:left;}
      </style></head><body>
      <h1>WhatsApp Bot v${VERSION}</h1>
      <div class="status">CONNECTED</div>
      <div class="info">
        <p><b>Groups:</b> ${knownGroups.size}</p>
        <p><b>Broadcasts:</b> ${broadcasts.size} (${[...broadcasts.values()].filter(b => b.active).length} active)</p>
        <p><b>RAM:</b> ${getRamMB()}MB / ${MAX_RAM_MB}MB</p>
        <p><b>Joined Codes:</b> ${joinedGroupCodes.size}</p>
      </div>
      </body></html>
    `);
  }
  if (connectionStatus === 'qr' && qrCodeData) {
    return res.send(`
      <!DOCTYPE html><html><head><title>WhatsApp Bot — Scan QR</title>
      <meta http-equiv="refresh" content="30">
      <style>body{font-family:Arial,sans-serif;text-align:center;padding:40px;background:#f0f0f0;}
      img{border:4px solid #25D366;border-radius:10px;padding:10px;background:white;}
      h2{color:#333;}</style></head><body>
      <h1>WhatsApp Bot v${VERSION}</h1>
      <h2>Scan QR Code with WhatsApp</h2>
      <img src="${qrCodeData}" width="300" height="300" />
      <p style="color:#666">Page auto-refreshes every 30 seconds</p>
      </body></html>
    `);
  }
  res.send(`
    <!DOCTYPE html><html><head><title>WhatsApp Bot</title>
    <meta http-equiv="refresh" content="5">
    <style>body{font-family:Arial,sans-serif;text-align:center;padding:40px;}</style></head><body>
    <h1>WhatsApp Bot v${VERSION}</h1>
    <p>Status: <b>${connectionStatus}</b></p>
    <p>Connecting... (auto-refresh in 5s)</p>
    </body></html>
  `);
});

// Status API
app.get('/status', (req, res) => {
  res.json({
    version: VERSION,
    status: connectionStatus,
    groups: knownGroups.size,
    joinedCodes: joinedGroupCodes.size,
    broadcasts: broadcasts.size,
    activeBroadcasts: [...broadcasts.values()].filter(b => b.active).length,
    ram: getRamMB(),
    maxRam: MAX_RAM_MB,
    uptime: Math.floor((Date.now() - botStartTime) / 1000)
  });
});

// Groups API
app.get('/groups', (req, res) => {
  res.json({ groups: [...knownGroups], count: knownGroups.size });
});

// Broadcasts API
app.get('/broadcasts', (req, res) => {
  const list = [];
  broadcasts.forEach((b, id) => {
    list.push({ id, message: b.message, active: b.active, sentCount: b.sentCount, groups: b.groups?.length || 0, createdAt: b.createdAt });
  });
  res.json({ broadcasts: list });
});

const server = http.createServer(app);
server.listen(PORT, () => {
  console.log('[Express] Server running on port ' + PORT);
});

// ================================================================================
//  SECTION 12: CRASH PROTECTION
// ================================================================================
process.on('uncaughtException', (err) => {
  console.error('[CRASH] Uncaught exception:', err.message, err.stack?.substring(0, 300));
});

process.on('unhandledRejection', (reason) => {
  console.error('[CRASH] Unhandled rejection:', reason?.message || reason);
});

// ================================================================================
//  SECTION 13: STARTUP
// ================================================================================
async function main() {
  console.log('='.repeat(60));
  console.log('  WhatsApp Bot v' + VERSION + ' — Stealth Joiner + Broadcaster');
  console.log('  Admin: ' + ADMIN);
  console.log('='.repeat(60));

  // Load persisted data
  loadAdminLid();
  loadJoinedGroups();
  loadBroadcasts();

  // Start WhatsApp connection
  await startSock();
}

main().catch(e => {
  console.error('[MAIN] Fatal error:', e.message);
  process.exit(1);
});
