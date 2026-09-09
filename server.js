'use strict';
// =============================================================================
//  IMPORTS
// =============================================================================
const express = require('express');
const path = require('path');
const fs = require('fs');
const NodeCache = require('node-cache');
const {
    makeWASocket,
    DisconnectReason,
    useMultiFileAuthState,
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');
const axios = require('axios');
const cheerio = require('cheerio');

// =============================================================================
//  CONFIGURATION – ALL YOUR REAL VALUES KEPT INTACT
// =============================================================================
const VERSION = '22.1';

// ─── ADMIN – NOW SUPPORTS BOTH LID AND PHONE NUMBER ───
const ADMIN_LID = '115110005706891@lid';      // Your original LID
const ADMIN_PHONE = '263777627210';            // Your phone number (added)
const EXCLUDED_PHONE = '64226434709';          // Your excluded number

const AUTH_FOLDER = 'auth_info';
const PORT = process.env.PORT || 10000;

// AI API Keys – YOUR REAL VALUES (unchanged)
const GEMINI_API_KEY = 'AQ.Ab8RN6L4xBKiQ5j1RUIZSp6OEOlF-6zAVSiTQqqRGIa4iIOrQA';
const GEMINI_MODEL = 'gemini-3.8-flash';
const LLM7_API_KEY = 'MrZ30o/mVA68zW1ATWSZx5peFFRON0Lk+ug9jyL6Zaw6+bq2YBxdzggcNcNIENuKGABhcs1T+8bRVJJ1cPkUR7/RoELgY09mv17xp7QEq4v2MuJC3SzEaC1Aa2otyi/4agFDPcv83s/jh2Md';
const LLM7_MODEL = 'gemini-3-flash';
const NAUGHTY_AI_PROVIDER = 'gemini';

// Static naughty messages (fallback)
const NAUGHTY_MESSAGES = [
    "Hey, you're being naughty! ",
    "Stop it, you little devil! ",
    "Oh my, what a mischievous one! ",
    "You're making me blush! ",
    "Tsk tsk, behave yourself! ",
    "Naughty, naughty! ",
    "You're a handful, aren't you? ",
    "I like your style, but keep it PG! ",
    "Oops, someone's feeling playful! ",
    "Careful, I might just respond in kind! "
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
let botStartTime = Date.now();
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

// ─── NEW: Bot is PAUSED until admin says !start ───
let botPaused = true;          // ← BOT DOES NOT AUTO‑CONNECT
let botEnabled = false;        // ← Only true after !start

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

let joinQueue = [];
let isJoining = false;
const logger = pino({ level: 'silent' });
const msgRetryCounterCache = new NodeCache();
const groupMetadataCache = new NodeCache({ stdTTL: 300, useClones: false });
let sseClients = [];
const phoneCache = new Map();

// ─── RATE LIMITING – PREVENTS BAN ───
const messageQueue = [];
let isProcessingQueue = false;
const MAX_MESSAGES_PER_SECOND = 5;
const QUEUE_MAX_SIZE = 10000;

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

function isGroup(jid) {
    return jid && jid.endsWith('@g.us');
}

function randInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

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

function getRandomResponse(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function getRamMB() {
    try {
        return Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    } catch {
        return 0;
    }
}

function addMessageToCache(msg) {
    messageStore.push(msg);
    if (messageStore.length > 10000) messageStore.shift();
}

function getCachedMessages() {
    return messageStore;
}

function extractInviteCodes(text) {
    if (!text) return [];
    const regex = /chat\.whatsapp\.com\/([A-Za-z0-9]{10,})/g;
    const codes = [];
    let match;
    while ((match = regex.exec(text)) !== null) codes.push(match[1]);
    return codes;
}

// ─── LID resolution ───
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
        } catch (e) {
            console.error('LID resolve error:', e.message);
        }
    }
    return null;
}

// ─── AI naughty reply ───
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
        } catch (e) {
            console.error('Gemini error:', e.message);
        }
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
        } catch (e) {
            console.error('LLM7 error:', e.message);
        }
    }
    return null;
}

// ─── IMAGE SCRAPER ───
async function scrapeImages(site, searchQuery, maxImages = 10) {
    const siteConfig = IMAGE_SITES[site];
    if (!siteConfig) throw new Error(`Unknown site: ${site}`);
    const searchUrl = `${siteConfig.searchUrl}?q=${encodeURIComponent(searchQuery)}`;
    console.log(` Scraping ${site}: ${searchUrl}`);
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
    console.log(` Using album: ${albumUrl}`);
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
    console.log(`️ Found ${unique.length} images.`);
    return unique.slice(0, maxImages);
}

async function downloadAndSendImages(site, searchQuery, chatJid, maxImages = 10) {
    try {
        const urls = await scrapeImages(site, searchQuery, maxImages);
        if (urls.length === 0) {
            await sendMessageWithQueue(chatJid, { text: '❌ No images found for that query.' });
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
            await sendMessageWithQueue(chatJid, {
                image: { url: filePath },
                caption: " Here's what you asked for"
            });
            sent++;
            await sleep(2000);
        }
        await sendMessageWithQueue(chatJid, { text: `✅ Sent ${sent} images.` });
    } catch (error) {
        console.error('Download/send error:', error.message);
        await sendMessageWithQueue(chatJid, { text: `❌ Error: ${error.message}` });
    }
}

// =============================================================================
//  RATE‑LIMITED MESSAGE QUEUE
// =============================================================================
async function processMessageQueue() {
    if (isProcessingQueue) return;
    isProcessingQueue = true;
    while (messageQueue.length > 0) {
        // If queue exceeds max, pause and warn
        if (messageQueue.length > QUEUE_MAX_SIZE) {
            console.warn(`⚠️ Queue overflow (${messageQueue.length} messages). Pausing for 10s...`);
            await sleep(10000);
        }
        const batch = messageQueue.splice(0, MAX_MESSAGES_PER_SECOND);
        const promises = batch.map(({ jid, content }) =>
            sock.sendMessage(jid, content).catch(e => console.error('Send error:', e.message))
        );
        await Promise.all(promises);
        // Wait 1 second between batches to respect rate limit
        await sleep(1000);
    }
    isProcessingQueue = false;
}

async function sendMessageWithQueue(jid, content) {
    if (!sock || connectionStatus !== 'connected') {
        console.warn('⚠️ Not connected, message dropped.');
        return;
    }
    messageQueue.push({ jid, content });
    if (messageQueue.length > QUEUE_MAX_SIZE) {
        console.warn(`⚠️ Queue approaching limit (${messageQueue.length}).`);
    }
    // Start processing if not already
    if (!isProcessingQueue) {
        processMessageQueue().catch(e => console.error('Queue error:', e));
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
            groups: [...knownGroups],
            codes: [...joinedGroupCodes],
            savedAt: new Date().toISOString()
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
            message: v.message,
            groups: v.groups,
            active: v.active,
            sentCount: v.sentCount,
            createdAt: v.createdAt,
            customInterval: v.customInterval
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
            jid: ADMIN_LID,
            phone: ADMIN_PHONE,
            savedAt: new Date().toISOString(),
            lidToPhone: Object.fromEntries(lidToPhone)
        }, null, 2));
    } catch {}
}

function loadAdminLid() {
    try {
        if (fs.existsSync(ADMIN_LID_FILE)) {
            const data = JSON.parse(fs.readFileSync(ADMIN_LID_FILE, 'utf8'));
            if (data.lidToPhone) {
                for (const [k, v] of Object.entries(data.lidToPhone)) lidToPhone.set(k, v);
            }
        }
    } catch {}
}

// =============================================================================
//  ADMIN DETECTION – NOW SUPPORTS BOTH LID AND PHONE
// =============================================================================
function isAdmin(jid, msg) {
    if (!jid) return false;

    // Check direct message from admin (LID or phone)
    if (!isGroup(jid)) {
        const dmBare = toBare(jid);
        // Check against LID
        if (dmBare === toBare(ADMIN_LID) || jid === ADMIN_LID) {
            capturedAdminJids.add(jid);
            return true;
        }
        // Check against phone number
        if (dmBare === ADMIN_PHONE || jid === `${ADMIN_PHONE}@s.whatsapp.net`) {
            capturedAdminJids.add(jid);
            return true;
        }
        return capturedAdminJids.has(jid);
    }

    // Group message: check participant
    const participant = msg?.key?.participant;
    if (participant) {
        const pBare = toBare(participant);
        if (pBare === toBare(ADMIN_LID) || participant === ADMIN_LID) return true;
        if (pBare === ADMIN_PHONE || participant === `${ADMIN_PHONE}@s.whatsapp.net`) return true;
        if (capturedAdminJids.has(participant)) return true;
    }
    return false;
}

function getReplyJid(msg) {
    const sender = msg.key?.remoteJid;
    if (!isGroup(sender)) {
        return msg?.key?.participant || sender;
    }
    return sender;
}

// =============================================================================
//  BROADCAST SYSTEM
// =============================================================================
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
            await sendMessageWithQueue(g, { text: bc.message });
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

// =============================================================================
//  CASUAL & NAUGHTY MESSAGE HANDLER
// =============================================================================
async function handleCasualMessage(text, replyJid, isGroupChat, senderJid) {
    if (!text) return false;
    const lower = text.toLowerCase().trim();

    // --- AI Image Request Detection (private only) ---
    const imageKeywords = ['boobs', 'horny', 'sexy', 'nude', 'nsfw', 'hot', 'picture', 'photo', 'image', 'send me', 'show me', 'i want', 'need'];
    if (!isGroupChat && imageKeywords.some(k => lower.includes(k))) {
        const senderPhone = await resolvePhoneNumber(senderJid);
        const isExcluded = (senderPhone === EXCLUDED_PHONE);
        if (!isExcluded) {
            await downloadAndSendImages('naijauncut', text.trim(), replyJid, 3);
            return true;
        }
    }

    // --- Naughty reply for private chats (if not excluded) ---
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
            await sendMessageWithQueue(replyJid, { text: naughtyReply });
            return true;
        }
    }

    // --- Normal greeting replies (for groups or excluded user) ---
    const greetings = ['hi', 'hello', 'hey', 'howdy', 'good morning', 'good afternoon', 'good evening', 'sup', 'yo'];
    if (greetings.some(g => lower.includes(g) || lower === g)) {
        const reply = getRandomResponse(["Hey there! ", "Hello! How's it going?", "Hi! ", "Hey, what's up?"]);
        await simulateTyping(replyJid);
        await humanDelay(HUMAN_CONFIG.minReplyDelay, HUMAN_CONFIG.maxReplyDelay);
        await sendMessageWithQueue(replyJid, { text: reply });
        return true;
    }

    const howAreYou = ['how are you', 'how are u', 'how you doing', 'how you doin', 'how r u', 'how r you'];
    if (howAreYou.some(h => lower.includes(h))) {
        const reply = getRandomResponse(["I'm good, thanks! How about you?", "Doing great! ", "All good here, you?"]);
        await simulateTyping(replyJid);
        await humanDelay(HUMAN_CONFIG.minReplyDelay, HUMAN_CONFIG.maxReplyDelay);
        await sendMessageWithQueue(replyJid, { text: reply });
        return true;
    }

    if (lower.includes('thanks') || lower.includes('thank you') || lower.includes('thx')) {
        const replies = ["You're welcome! ", "Anytime!", "No problem!", "Glad to help!"];
        const reply = getRandomResponse(replies);
        await simulateTyping(replyJid);
        await humanDelay(HUMAN_CONFIG.minReplyDelay, HUMAN_CONFIG.maxReplyDelay);
        await sendMessageWithQueue(replyJid, { text: reply });
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
        if (added > 0) saveJoinedGroups();
    } catch {}
}

// =============================================================================
//  ADMIN COMMANDS – FULL CONTROL
// =============================================================================
async function handleAdminCommand(text, replyJid, msg) {
    const lower = text.toLowerCase().trim();

    // ─── !START – BOT GOES LIVE ───
    if (lower === '!start') {
        if (botEnabled) {
            await sendMessageWithQueue(replyJid, { text: '⚠️ Bot is already running.' });
            return true;
        }
        botPaused = false;
        botEnabled = true;
        await sendMessageWithQueue(replyJid, { text: '✅ Bot is now ACTIVE. Connecting to WhatsApp...' });
        // Trigger connection
        startSock().catch(e => console.error('Start error:', e));
        return true;
    }

    // ─── !STOP – BOT DISCONNECTS ───
    if (lower === '!stop') {
        if (!botEnabled) {
            await sendMessageWithQueue(replyJid, { text: '⚠️ Bot is already stopped.' });
            return true;
        }
        botEnabled = false;
        botPaused = true;
        if (sock) {
            try {
                await sock.logout();
            } catch {}
            sock = null;
        }
        connectionStatus = 'disconnected';
        qrDataUri = null;
        await sendMessageWithQueue(replyJid, { text: '🛑 Bot stopped. Use !start to re‑enable.' });
        return true;
    }

    // ─── !TEST ───
    if (lower === '!test') {
        await sendMessageWithQueue(replyJid, {
            text: '✅ Bot is working!\n\n' +
                'Connection: ' + connectionStatus + '\n' +
                'Groups: ' + knownGroups.size + '\n' +
                'Cached Messages: ' + messageStore.length + '\n' +
                'RAM: ' + getRamMB() + 'MB\n' +
                'Version: ' + VERSION + '\n' +
                'Bot Enabled: ' + botEnabled + '\n' +
                'Queue Size: ' + messageQueue.length
        });
        return true;
    }

    // ─── Image download commands ───
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
            await sendMessageWithQueue(replyJid, { text: 'Usage: !album <site> <query> (site: naijauncut or darknaija)' });
            return true;
        }
        const site = parts[0].toLowerCase();
        if (!['naijauncut', 'darknaija'].includes(site)) {
            await sendMessageWithQueue(replyJid, { text: 'Site must be "naijauncut" or "darknaija"' });
            return true;
        }
        const query = parts.slice(1).join(' ');
        await downloadAndSendImages(site, query, replyJid, 5);
        return true;
    }

    // ─── Broadcast commands ───
    if (lower.startsWith('!editbc ')) {
        const newMsg = text.replace(/^!editbc\s+/i, '').trim();
        if (!newMsg) {
            await sendMessageWithQueue(replyJid, { text: 'Usage: !editbc <message>' });
            return true;
        }
        currentBroadcastMessage = newMsg;
        let updated = 0;
        for (const [id, bc] of broadcasts.entries()) {
            if (bc.active) {
                bc.message = newMsg;
                updated++;
            }
        }
        saveBroadcasts();
        await sendMessageWithQueue(replyJid, { text: '✅ Broadcast message updated for ' + updated + ' active broadcast(s).' });
        return true;
    }

    if (lower.startsWith('!broadcastmsg ')) {
        const msgText = text.replace(/^!broadcastmsg\s+/i, '').trim();
        if (!msgText) {
            await sendMessageWithQueue(replyJid, { text: 'Usage: !broadcastmsg <message>' });
            return true;
        }
        currentBroadcastMessage = msgText;
        await sendMessageWithQueue(replyJid, { text: '✅ Broadcast message saved. Use !broadcast to send it.' });
        return true;
    }

    if (lower.startsWith('!broadcast ') || lower.startsWith('!bc ')) {
        const bcMsg = text.replace(/^!(broadcast|bc)\s+/i, '').trim();
        if (!bcMsg) {
            await sendMessageWithQueue(replyJid, { text: 'Usage: !broadcast <message>' });
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
        await sendMessageWithQueue(replyJid, {
            text: '*Broadcast #' + id + ' started!*\n\n' +
                'Message: ' + bcMsg.substring(0, 100) + (bcMsg.length > 100 ? '...' : '') + '\n' +
                'Targets: All ' + knownGroups.size + ' known groups\n' +
                'Interval: Every 6 hours\n' +
                'Stop with: !stop ' + id + '\n' +
                'Edit with: !editbc <message>'
        });
        return true;
    }

    if (lower.startsWith('!bconce ')) {
        const bcMsg = text.replace(/^!bconce\s+/i, '').trim();
        if (!bcMsg) {
            await sendMessageWithQueue(replyJid, { text: 'Usage: !bconce <message>' });
            return true;
        }
        const targets = [...knownGroups];
        if (!targets.length) {
            await sendMessageWithQueue(replyJid, { text: 'No known groups. Use !refreshgroups first.' });
            return true;
        }
        await sendMessageWithQueue(replyJid, { text: 'Sending one-time broadcast to ' + targets.length + ' groups...' });
        let sent = 0,
            failed = 0;
        for (const g of targets) {
            try {
                await simulateTyping(g);
                await sendMessageWithQueue(g, { text: bcMsg });
                sent++;
                const delay = randInt(HUMAN_CONFIG.minBroadcastDelay * 1000, HUMAN_CONFIG.maxBroadcastDelay * 1000);
                await sleep(delay);
            } catch (e) {
                failed++;
            }
        }
        await sendMessageWithQueue(replyJid, {
            text: '*Broadcast complete!*\nSent: ' + sent + '/' + targets.length + '\nFailed: ' + failed
        });
        return true;
    }

    if (lower.startsWith('!bcimage')) {
        const caption = text.replace(/^!bcimage\s*/i, '').trim();
        const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        const imgMsg = quoted?.imageMessage;
        if (!imgMsg) {
            await sendMessageWithQueue(replyJid, { text: 'Reply to an image with !bcimage [caption] to broadcast it.' });
            return true;
        }
        const targets = [...knownGroups];
        if (!targets.length) {
            await sendMessageWithQueue(replyJid, { text: 'No known groups.' });
            return true;
        }
        await sendMessageWithQueue(replyJid, { text: 'Broadcasting image to ' + targets.length + ' groups...' });
        let sent = 0;
        for (const g of targets) {
            try {
                await sendMessageWithQueue(g, { image: { url: imgMsg.url }, caption: caption || '' });
                sent++;
                await sleep(randInt(2000, 5000));
            } catch (e) {}
        }
        await sendMessageWithQueue(replyJid, { text: 'Image broadcast done. Sent: ' + sent + '/' + targets.length });
        return true;
    }

    if (lower.startsWith('!stop')) {
        const id = text.slice(5).trim();
        if (id && broadcasts.has(id)) {
            stopBc(id);
            await sendMessageWithQueue(replyJid, { text: 'Broadcast #' + id + ' stopped.' });
            return true;
        }
        const active = [...broadcasts.entries()].filter(([, b]) => b.active);
        if (!active.length) {
            await sendMessageWithQueue(replyJid, { text: 'No active broadcasts.' });
        } else {
            let txt = '*Active Broadcasts:*\n\n';
            active.forEach(([i, b]) => {
                txt += '#' + i + ': ' + b.message.substring(0, 60) + (b.message.length > 60 ? '...' : '') + '\n';
                txt += ' Sent: ' + (b.sentCount || 0) + ' | Last: ' + (b.lastSent || 'never') + '\n\n';
            });
            txt += 'Stop with: !stop <id>';
            await sendMessageWithQueue(replyJid, { text: txt });
        }
        return true;
    }

    if (lower === '!stopall') {
        stopAllBc();
        await sendMessageWithQueue(replyJid, { text: 'All broadcasts stopped.' });
        return true;
    }

    if (lower === '!bclist') {
        if (!broadcasts.size) {
            await sendMessageWithQueue(replyJid, { text: 'No broadcasts created yet.' });
            return true;
        }
        let txt = '*All Broadcasts (' + broadcasts.size + ')*\n\n';
        for (const [id, b] of broadcasts.entries()) {
            txt += '#' + id + ' [' + (b.active ? 'ACTIVE' : 'STOPPED') + ']\n';
            txt += 'Msg: ' + b.message.substring(0, 60) + (b.message.length > 60 ? '...' : '') + '\n';
            txt += 'Sent: ' + (b.sentCount || 0) + ' | Created: ' + (b.createdAt || 'unknown') + '\n\n';
        }
        await sendMessageWithQueue(replyJid, { text: txt });
        return true;
    }

    if (lower === '!bcclear') {
        let removed = 0;
        for (const [id, b] of [...broadcasts.entries()]) {
            if (!b.active) {
                broadcasts.delete(id);
                removed++;
            }
        }
        saveBroadcasts();
        await sendMessageWithQueue(replyJid, { text: 'Cleared ' + removed + ' stopped broadcasts.' });
        return true;
    }

    if (lower.startsWith('!bcresume ')) {
        const id = text.slice(10).trim();
        if (!broadcasts.has(id)) {
            await sendMessageWithQueue(replyJid, { text: 'Broadcast #' + id + ' not found.' });
            return true;
        }
        startBc(id);
        await sendMessageWithQueue(replyJid, { text: 'Broadcast #' + id + ' resumed.' });
        return true;
    }

    if (lower.startsWith('!bcinterval ')) {
        const parts = text.slice(12).trim().split(' ');
        const id = parts[0];
        const hours = parseFloat(parts[1]);
        if (!id || isNaN(hours) || hours < 0.1) {
            await sendMessageWithQueue(replyJid, { text: 'Usage: !bcinterval <id> <hours>\nExample: !bcinterval 1 3' });
            return true;
        }
        const bc = broadcasts.get(id);
        if (!bc) {
            await sendMessageWithQueue(replyJid, { text: 'Broadcast #' + id + ' not found.' });
            return true;
        }
        bc.customInterval = hours * 3600000;
        if (bc.active) {
            if (bc.interval) clearInterval(bc.interval);
            bc.interval = setInterval(() => sendBcMsg(id), bc.customInterval);
        }
        saveBroadcasts();
        await sendMessageWithQueue(replyJid, { text: 'Broadcast #' + id + ' interval set to ' + hours + ' hours.' });
        return true;
    }

    if (lower.startsWith('!bcgroups ')) {
        const parts = text.slice(10).trim().split(' ');
        const id = parts[0];
        const groupList = parts.slice(1).join(' ').split(',').map(g => g.trim()).filter(Boolean);
        const bc = broadcasts.get(id);
        if (!bc) {
            await sendMessageWithQueue(replyJid, { text: 'Broadcast #' + id + ' not found.' });
            return true;
        }
        bc.groups = groupList;
        saveBroadcasts();
        await sendMessageWithQueue(replyJid, { text: 'Broadcast #' + id + ' now targets ' + groupList.length + ' specific groups.' });
        return true;
    }

    if (lower.startsWith('!bcreset ')) {
        const id = text.slice(9).trim();
        const bc = broadcasts.get(id);
        if (!bc) {
            await sendMessageWithQueue(replyJid, { text: 'Broadcast #' + id + ' not found.' });
            return true;
        }
        bc.groups = [];
        saveBroadcasts();
        await sendMessageWithQueue(replyJid, { text: 'Broadcast #' + id + ' reset to all groups.' });
        return true;
    }

    // ─── Status & Info ───
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
            'Admin LID: ' + ADMIN_LID + '\n' +
            'Admin Phone: ' + ADMIN_PHONE + '\n' +
            'Cached Messages: ' + messageStore.length + '\n' +
            'Queue Size: ' + messageQueue.length + '\n' +
            'Bot Enabled: ' + botEnabled;
        await sendMessageWithQueue(replyJid, { text: txt });
        return true;
    }

    if (lower === '!ram') {
        await sendMessageWithQueue(replyJid, { text: 'RAM: ' + getRamMB() + 'MB' });
        return true;
    }

    if (lower === '!groups') {
        await refreshKnownGroups();
        await sendMessageWithQueue(replyJid, { text: 'Known groups: ' + knownGroups.size + '\nJoined codes: ' + joinedGroupCodes.size });
        return true;
    }

    if (lower === '!refreshgroups') {
        await refreshKnownGroups();
        await sendMessageWithQueue(replyJid, { text: 'Groups refreshed. Found ' + knownGroups.size + ' groups.' });
        return true;
    }

    if (lower === '!scanlinks') {
        await sendMessageWithQueue(replyJid, { text: 'Scanning cached messages for invite links...' });
        const found = await scanAllMessagesForLinks();
        await sendMessageWithQueue(replyJid, { text: 'Scan complete. Joined ' + found + ' new groups.' });
        return true;
    }

    if (lower === '!join') {
        const parts = text.split(' ');
        if (parts.length < 2) {
            await sendMessageWithQueue(replyJid, { text: 'Usage: !join <invite_code>' });
            return true;
        }
        const code = parts[1].trim();
        const result = await stealthJoin(code);
        if (result) {
            await sendMessageWithQueue(replyJid, { text: '✅ Joined group: ' + result });
        } else {
            await sendMessageWithQueue(replyJid, { text: '❌ Failed to join or already joined.' });
        }
        return true;
    }

    if (lower === '!admin') {
        await sendMessageWithQueue(replyJid, {
            text: 'Admin LID: ' + ADMIN_LID + '\nAdmin Phone: ' + ADMIN_PHONE + '\nExcluded Phone: ' + EXCLUDED_PHONE
        });
        return true;
    }

    return false;
}

// =============================================================================
//  SOCKET INITIALISATION – PAUSED UNTIL !start
// =============================================================================
async function startSock() {
    if (!botEnabled) {
        console.log('⏳ Bot is paused. Waiting for !start command...');
        return;
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        browser: ['Chrome (Linux)', '', ''],
        syncFullHistory: false,
        logger: logger,
        msgRetryCounterCache,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // ─── QR CODE → IMAGE ───
        if (qr) {
            try {
                qrDataUri = await QRCode.toDataURL(qr);
                console.log('✅ QR Code image generated.');
            } catch (err) {
                console.error('❌ QR generation failed:', err);
                qrDataUri = null;
            }
            connectionStatus = 'waiting_for_qr';
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            if (shouldReconnect && botEnabled) {
                console.log('🔄 Connection closed – reconnecting in 5s...');
                setTimeout(() => startSock(), 5000);
            } else if (statusCode === DisconnectReason.loggedOut) {
                console.log('🚪 Logged out. Wiping auth folder...');
                try {
                    fs.rmSync('./auth_info', { recursive: true, force: true });
                } catch (_) {}
                if (botEnabled) setTimeout(() => startSock(), 3000);
            }
            connectionStatus = 'disconnected';
            sock = null;
        }

        if (connection === 'open') {
            console.log('✅ WhatsApp connection OPEN!');
            connectionStatus = 'connected';
            qrDataUri = null;
            if (sock.user) {
                console.log(`✅ Logged in with LID: ${sock.user.id}`);
            }
            // Load persisted data
            loadJoinedGroups();
            loadBroadcasts();
            loadAdminLid();
            await refreshKnownGroups();
            resumeBroadcasts();
            botStartTime = Date.now();
        }
    });

    // ─── MESSAGE HANDLER ───
    sock.ev.on('messages.upsert', async ({ messages }) => {
        if (!botEnabled) return;
        for (const msg of messages) {
            if (msg.key?.fromMe) continue;
            const remoteJid = msg.key?.remoteJid;
            if (!remoteJid) continue;

            const text = msg.message?.conversation ||
                msg.message?.extendedTextMessage?.text ||
                msg.message?.imageMessage?.caption ||
                '';

            const senderJid = msg.key?.participant || remoteJid;
            const isGroupChat = isGroup(remoteJid);

            // Cache message for link scanning
            addMessageToCache(msg);

            // ─── ADMIN COMMAND CHECK ───
            if (isAdmin(remoteJid, msg) || isAdmin(senderJid, msg)) {
                const replyJid = getReplyJid(msg);
                const handled = await handleAdminCommand(text, replyJid, msg);
                if (handled) continue;
            }

            // ─── CASUAL MESSAGE HANDLER ───
            if (text) {
                const replyJid = getReplyJid(msg);
                await handleCasualMessage(text, replyJid, isGroupChat, senderJid);
            }
        }
    });

    // ─── GROUP UPDATE HANDLER ───
    sock.ev.on('groups.update', async (updates) => {
        for (const update of updates) {
            if (update.participants?.action === 'add') {
                for (const p of update.participants.participants) {
                    if (p === sock.user?.id) {
                        knownGroups.add(update.id);
                        saveJoinedGroups();
                    }
                }
            }
        }
    });
}

// =============================================================================
//  EXPRESS SERVER
// =============================================================================
const app = express();
app.use(express.json());
app.use(express.static('public'));

// ─── QR ENDPOINT ───
app.get('/api/qr', (req, res) => {
    if (connectionStatus === 'connected') {
        return res.json({ status: 'authenticated', user: sock?.user?.id || null });
    }
    if (qrDataUri) {
        return res.json({ status: 'qr', qr: qrDataUri });
    }
    if (!botEnabled) {
        return res.json({ status: 'paused', message: 'Bot is paused. Send !start to admin.' });
    }
    return res.json({ status: 'loading' });
});

// ─── PAIRING CODE ───
app.post('/api/pair', async (req, res) => {
    const { phoneNumber } = req.body;
    if (!phoneNumber) return res.status(400).json({ error: 'Phone number required.' });
    if (!sock) return res.status(503).json({ error: 'Socket not ready.' });
    if (!botEnabled) return res.status(403).json({ error: 'Bot is paused. Use !start first.' });

    try {
        const clean = phoneNumber.replace('+', '').replace(/\s/g, '');
        const code = await sock.requestPairingCode(clean);
        res.json({ success: true, pairingCode: code });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ─── PHONE → LID RESOLVER ───
app.post('/api/resolve-lid', async (req, res) => {
    const { phoneNumber } = req.body;
    if (!phoneNumber) return res.status(400).json({ error: 'Phone number required.' });
    if (!sock) return res.status(503).json({ error: 'Socket not ready.' });

    try {
        const clean = phoneNumber.replace('+', '').replace(/\s/g, '');
        const result = await sock.onWhatsApp(clean);
        if (result && result.length > 0 && result[0].exists) {
            res.json({
                exists: true,
                jid: result[0].jid,
                lid: result[0].lid || null,
                verifiedName: result[0].verifiedName || null,
            });
        } else {
            res.json({ exists: false });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ─── STATUS ENDPOINT ───
app.get('/api/status', (req, res) => {
    res.json({
        status: connectionStatus,
        enabled: botEnabled,
        groups: knownGroups.size,
        queue: messageQueue.length,
        ram: getRamMB(),
        uptime: Math.floor((Date.now() - botStartTime) / 1000),
    });
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── MEMORY MONITOR – Auto‑restart if RAM > 512MB ───
setInterval(() => {
    const ram = getRamMB();
    if (ram > 512) {
        console.warn(`⚠️ High RAM usage: ${ram}MB. Restarting...`);
        process.exit(1);
    }
}, 60000);

// ─── START SERVER ───
app.listen(PORT, () => {
    console.log(`🌐 Server running on http://localhost:${PORT}`);
    console.log('⏳ Bot is PAUSED. Send !start to your admin number to activate.');
    console.log(`Admin LID: ${ADMIN_LID}`);
    console.log(`Admin Phone: ${ADMIN_PHONE}`);
});

// Load persisted data on startup
loadJoinedGroups();
loadBroadcasts();
loadAdminLid();

// ─── DO NOT AUTO‑CONNECT – WAIT FOR !start ───
// The bot will NOT connect until admin sends !start.
