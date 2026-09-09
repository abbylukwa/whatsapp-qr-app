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
//  CONFIGURATION – ALL REAL VALUES (KEPT EXACTLY)
// =============================================================================
const VERSION = '23.0';

// ─── ADMIN – BOTH LID AND PHONE ──────────────────
const ADMIN_LID = '115110005706891@lid';      // your LID
const ADMIN_PHONE = '263777627210';            // your phone number
const EXCLUDED_PHONE = '64226434709';          // excluded number

const AUTH_FOLDER = 'auth_info';
const PORT = process.env.PORT || 10000;

// AI Keys – YOUR REAL VALUES
const GEMINI_API_KEY = 'AQ.Ab8RN6L4xBKiQ5j1RUIZSp6OEOlF-6zAVSiTQqqRGIa4iIOrQA';
const GEMINI_MODEL = 'gemini-3.8-flash';
const LLM7_API_KEY = 'MrZ30o/mVA68zW1ATWSZx5peFFRON0Lk+ug9jyL6Zaw6+bq2YBxdzggcNcNIENuKGABhcs1T+8bRVJJ1cPkUR7/RoELgY09mv17xp7QEq4v2MuJC3SzEaC1Aa2otyi/4agFDPcv83s/jh2Md';
const LLM7_MODEL = 'gemini-3-flash';
const NAUGHTY_AI_PROVIDER = 'gemini'; // 'gemini' or 'llm7'

// Static naughty messages (fallback)
const NAUGHTY_MESSAGES = [
    "Hey, you're being naughty! 😏",
    "Stop it, you little devil! 😈",
    "Oh my, what a mischievous one! 😉",
    "You're making me blush! 😊",
    "Tsk tsk, behave yourself! 😜",
    "Naughty, naughty! 😘",
    "You're a handful, aren't you? 🤭",
    "I like your style, but keep it PG! 😇",
    "Oops, someone's feeling playful! 😏",
    "Careful, I might just respond in kind! 😈"
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
//  STATE & PERSISTENCE
// =============================================================================
let sock = null;
let qrDataUri = null;
let connectionStatus = 'disconnected';
let botStartTime = Date.now();
let botPaused = true;          // paused until !start
let botEnabled = false;        // only true after !start

const capturedAdminJids = new Set();
const knownGroups = new Set();
const groupActivity = new Map();
const joinedGroupCodes = new Set();

// ─── User preferences & memory ──────────────────
const USER_PREFS_FILE = path.join(__dirname, 'user_prefs.json');
let userPrefs = {}; // phone -> { gender, likes, history: [], lastMsg, lastImageSent }

function loadUserPrefs() {
    try {
        if (fs.existsSync(USER_PREFS_FILE)) {
            userPrefs = JSON.parse(fs.readFileSync(USER_PREFS_FILE, 'utf8'));
        }
    } catch (e) { console.error('Load prefs error:', e); }
}
function saveUserPrefs() {
    try {
        fs.writeFileSync(USER_PREFS_FILE, JSON.stringify(userPrefs, null, 2));
    } catch (e) { console.error('Save prefs error:', e); }
}
loadUserPrefs();

// ─── Broadcasts ──────────────────────────────────
const BROADCASTS_FILE = 'broadcasts.json';
const broadcasts = new Map();
let broadcastIdCounter = 1;
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
loadBroadcasts();

// ─── Logs (only for admin) ──────────────────────
const logs = [];
function addLog(msg, type = 'info') {
    const entry = { time: new Date().toISOString(), msg, type };
    logs.push(entry);
    if (logs.length > 200) logs.shift();
    console.log(`[${type.toUpperCase()}] ${msg}`);
    // Send to admin if connected and enabled
    if (sock && connectionStatus === 'connected' && botEnabled) {
        // We'll send important logs via the message handler; we'll handle separately.
    }
}

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
async function humanDelay(minSec, maxSec) { const delay = randInt(minSec*1000, maxSec*1000); await sleep(delay); }
async function simulateTyping(jid) {
    if (!sock) return;
    try {
        await sock.sendPresenceUpdate('composing', jid);
        await sleep(randInt(1500, 4000));
        await sock.sendPresenceUpdate('paused', jid);
    } catch {}
}
function getRandomResponse(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function getRamMB() {
    try { return Math.round(process.memoryUsage().heapUsed / 1024 / 1024); } catch { return 0; }
}
function extractInviteCodes(text) {
    if (!text) return [];
    const regex = /chat\.whatsapp\.com\/([A-Za-z0-9]{10,})/g;
    const codes = [];
    let match;
    while ((match = regex.exec(text)) !== null) codes.push(match[1]);
    return codes;
}
async function resolvePhoneNumber(jid) {
    if (!jid) return null;
    if (jid.endsWith('@s.whatsapp.net')) return jid.split('@')[0];
    if (jid.endsWith('@lid')) {
        try {
            const result = await sock.onWhatsApp(jid);
            if (Array.isArray(result) && result.length > 0 && result[0].exists) {
                const phoneJid = result[0].jid;
                if (phoneJid) return phoneJid.split('@')[0];
            }
        } catch {}
    }
    return null;
}
function isAdmin(jid, msg) {
    if (!jid) return false;
    const bare = toBare(jid);
    if (bare === toBare(ADMIN_LID) || bare === toBare(ADMIN_PHONE)) return true;
    if (jid === ADMIN_LID || jid === `${ADMIN_PHONE}@s.whatsapp.net`) return true;
    const participant = msg?.key?.participant;
    if (participant) {
        const pBare = toBare(participant);
        if (pBare === toBare(ADMIN_LID) || pBare === toBare(ADMIN_PHONE)) return true;
    }
    return capturedAdminJids.has(jid) || capturedAdminJids.has(participant);
}
function getReplyJid(msg) {
    const sender = msg.key?.remoteJid;
    if (!isGroup(sender)) {
        return msg?.key?.participant || sender;
    }
    return sender;
}

// =============================================================================
//  MESSAGE QUEUE (Rate limiting)
// =============================================================================
const messageQueue = [];
let isProcessingQueue = false;
const MAX_MESSAGES_PER_SECOND = 5;
const QUEUE_MAX_SIZE = 10000;

async function processMessageQueue() {
    if (isProcessingQueue) return;
    isProcessingQueue = true;
    while (messageQueue.length > 0) {
        if (messageQueue.length > QUEUE_MAX_SIZE) {
            console.warn(`⚠️ Queue overflow (${messageQueue.length}). Pausing 10s...`);
            await sleep(10000);
        }
        const batch = messageQueue.splice(0, MAX_MESSAGES_PER_SECOND);
        const promises = batch.map(({ jid, content }) =>
            sock.sendMessage(jid, content).catch(e => console.error('Send error:', e.message))
        );
        await Promise.all(promises);
        await sleep(1000);
    }
    isProcessingQueue = false;
}
async function sendMessageWithQueue(jid, content) {
    if (!sock || connectionStatus !== 'connected') return;
    messageQueue.push({ jid, content });
    if (!isProcessingQueue) processMessageQueue().catch(() => {});
}

// =============================================================================
//  IMAGE SCRAPING & SENDING (with admin log support)
// =============================================================================
async function scrapeImages(site, searchQuery, maxImages = 10) {
    const siteConfig = IMAGE_SITES[site];
    if (!siteConfig) throw new Error(`Unknown site: ${site}`);
    const searchUrl = `${siteConfig.searchUrl}?q=${encodeURIComponent(searchQuery)}`;
    const { data: html } = await axios.get(searchUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        timeout: 10000
    });
    const $ = cheerio.load(html);
    const albumLinks = [];
    $(siteConfig.albumSelector).each((i, el) => {
        const href = $(el).attr('href');
        if (href) albumLinks.push(new URL(href, searchUrl).href);
    });
    if (albumLinks.length === 0) return [];
    const albumUrl = albumLinks[0];
    const { data: albumHtml } = await axios.get(albumUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 });
    const $$ = cheerio.load(albumHtml);
    const imageUrls = [];
    $$(siteConfig.imageSelector).each((i, el) => {
        let src = $$(el).attr('src') || $$(el).attr(siteConfig.lazyAttr);
        if (src) {
            const fullUrl = new URL(src, albumUrl).href;
            if (/\.(jpg|jpeg|png|gif|webp)$/i.test(fullUrl)) imageUrls.push(fullUrl);
        }
    });
    return [...new Set(imageUrls)].slice(0, maxImages);
}

async function downloadAndSendImages(site, searchQuery, chatJid, maxImages, adminJid = null, testing = false) {
    try {
        const urls = await scrapeImages(site, searchQuery, maxImages || 5);
        if (urls.length === 0) {
            if (testing && adminJid) {
                await sock.sendMessage(adminJid, { text: `❌ No images for "${searchQuery}" on ${site}` });
            }
            return;
        }
        let sent = 0;
        for (const url of urls) {
            let filePath = imageCache.get(url);
            if (!filePath) {
                const response = await axios.get(url, { responseType: 'stream', timeout: 15000 });
                const fileName = path.basename(url).split('?')[0] || `image_${Date.now()}.jpg`;
                filePath = path.join(DOWNLOAD_FOLDER, fileName);
                const writer = fs.createWriteStream(filePath);
                response.data.pipe(writer);
                await new Promise((resolve, reject) => {
                    writer.on('finish', resolve);
                    writer.on('error', reject);
                });
                imageCache.set(url, filePath);
                if (testing && adminJid) {
                    await sock.sendMessage(adminJid, { text: `✅ Downloaded: ${fileName}` });
                }
            }
            await sendMessageWithQueue(chatJid, { image: { url: filePath }, caption: "Here's what you wanted 😉" });
            sent++;
            await sleep(2000);
        }
        if (testing && adminJid) {
            await sock.sendMessage(adminJid, { text: `✅ Sent ${sent} images from ${site} for query "${searchQuery}".` });
        }
    } catch (error) {
        const errMsg = `❌ Image error: ${error.message}`;
        addLog(errMsg, 'error');
        if (testing && adminJid) {
            await sock.sendMessage(adminJid, { text: errMsg });
        }
    }
}

// =============================================================================
//  AI NAUGHTY REPLY (with memory & preference extraction)
// =============================================================================
async function getAINaughtyReply(userMessage, userPhone, history = []) {
    const systemPrompt = `You are a seductive, playful, and extremely naughty AI companion. Your job is to turn the user on and gradually discover their preferences (gender, what they like, etc.). 
You must ask subtle questions to find out if they like girls, boys, both, or specific body types. 
You can also tease them and send hints about images you might share.
Keep your replies short (1-2 sentences) and very flirty. 
Use emojis. 
NEVER refuse or be polite – always be suggestive and inviting.
The user's phone number is: ${userPhone}. 
Their previous preferences (if known) are: ${JSON.stringify(userPrefs[userPhone] || {})}.
Do not mention these details explicitly; just use them to guide the conversation.
If the user explicitly states their gender or what they like (e.g., "I'm gay", "I like big boobs", "I'm into girls"), you must respond enthusiastically and remember that information for future replies.
`;

    let conversation = history.map(m => `${m.from === 'user' ? 'User' : 'AI'}: ${m.text}`).join('\n');
    conversation += `\nUser: ${userMessage}`;

    // Try Gemini
    if (NAUGHTY_AI_PROVIDER === 'gemini' && GEMINI_API_KEY && GEMINI_API_KEY !== 'YOUR_NEW_GEMINI_API_KEY') {
        try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-goog-api-key': GEMINI_API_KEY },
                body: JSON.stringify({ contents: [{ parts: [{ text: `${systemPrompt}\n\n${conversation}` }] }] })
            });
            const data = await response.json();
            const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
            if (reply) return reply;
        } catch (e) {
            addLog(`Gemini error: ${e.message}`, 'error');
        }
    }
    // Try LLM7
    if (NAUGHTY_AI_PROVIDER === 'llm7' && LLM7_API_KEY && LLM7_API_KEY !== 'YOUR_NEW_LLM7_API_KEY') {
        try {
            const response = await fetch('https://api.llm7.io/v1/chat/completions', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${LLM7_API_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: LLM7_MODEL,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: conversation }
                    ]
                })
            });
            const data = await response.json();
            const reply = data?.choices?.[0]?.message?.content || null;
            if (reply) return reply;
        } catch (e) {
            addLog(`LLM7 error: ${e.message}`, 'error');
        }
    }
    return null; // AI failed
}

// =============================================================================
//  ADMIN COMMANDS – Full control, testing, broadcasting
// =============================================================================
async function handleAdminCommand(text, replyJid, msg) {
    const lower = text.toLowerCase().trim();

    // --- Bot control ---
    if (lower === '!start') {
        if (botEnabled) {
            await sendMessageWithQueue(replyJid, { text: '⚠️ Bot already running.' });
            return true;
        }
        botPaused = false;
        botEnabled = true;
        await sendMessageWithQueue(replyJid, { text: '✅ Bot ACTIVATED. Connecting...' });
        startSock().catch(e => console.error(e));
        return true;
    }
    if (lower === '!stop') {
        if (!botEnabled) {
            await sendMessageWithQueue(replyJid, { text: '⚠️ Bot already stopped.' });
            return true;
        }
        botEnabled = false;
        botPaused = true;
        if (sock) {
            try { await sock.logout(); } catch {}
            sock = null;
        }
        connectionStatus = 'disconnected';
        qrDataUri = null;
        await sendMessageWithQueue(replyJid, { text: '🛑 Bot stopped.' });
        return true;
    }

    // --- Test image download commands (admin only) ---
    const testMatches = text.match(/^send me\s+(.+)/i);
    if (testMatches) {
        const query = testMatches[1].trim();
        if (query.length < 2) {
            await sendMessageWithQueue(replyJid, { text: '❌ Query too short.' });
            return true;
        }
        // Log to admin
        await sendMessageWithQueue(replyJid, { text: `🔍 Testing image download for: "${query}"` });
        // Download from naijauncut (fallback to darknaija if fails)
        await downloadAndSendImages('naijauncut', query, replyJid, 5, ADMIN_LID, true);
        return true;
    }

    // --- Broadcast commands (same as before) ---
    if (lower.startsWith('!broadcast ')) {
        const bcMsg = text.replace(/^!broadcast\s+/i, '').trim();
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
        // Start broadcast
        const bc = broadcasts.get(id);
        bc.active = true;
        bc.interval = setInterval(() => sendBcMsg(id), bc.customInterval);
        await sendBcMsg(id); // send once immediately
        await sendMessageWithQueue(replyJid, { text: `✅ Broadcast #${id} started.` });
        saveBroadcasts();
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
            await sendMessageWithQueue(replyJid, { text: 'No groups known.' });
            return true;
        }
        await sendMessageWithQueue(replyJid, { text: `Sending one-time broadcast to ${targets.length} groups...` });
        let sent = 0;
        for (const g of targets) {
            try {
                await sendMessageWithQueue(g, { text: bcMsg });
                sent++;
                await sleep(randInt(3000, 9000));
            } catch {}
        }
        await sendMessageWithQueue(replyJid, { text: `✅ Broadcast done. Sent to ${sent} groups.` });
        return true;
    }
    if (lower === '!status') {
        const up = Math.floor((Date.now() - botStartTime) / 1000);
        const hrs = Math.floor(up / 3600);
        const mins = Math.floor((up % 3600) / 60);
        await sendMessageWithQueue(replyJid, {
            text: `*Bot Status*\nVersion: ${VERSION}\nConnection: ${connectionStatus}\nUptime: ${hrs}h ${mins}m\nRAM: ${getRamMB()}MB\nGroups: ${knownGroups.size}\nQueue: ${messageQueue.length}\nEnabled: ${botEnabled}\nBroadcasts: ${broadcasts.size}`
        });
        return true;
    }
    if (lower === '!logs') {
        const last = logs.slice(-30).map(e => `[${e.time}] ${e.msg}`).join('\n');
        await sendMessageWithQueue(replyJid, { text: `*Last 30 logs*\n${last || 'No logs'}` });
        return true;
    }
    if (lower === '!admin') {
        await sendMessageWithQueue(replyJid, { text: `Admin LID: ${ADMIN_LID}\nAdmin Phone: ${ADMIN_PHONE}` });
        return true;
    }
    // Add other admin commands (like !horny, !dark, etc.) but they are covered by "send me" test.
    // For !horny, we can also allow, but it's redundant.
    if (lower.startsWith('!horny')) {
        const query = text.replace(/^!horny\s*/i, '').trim() || 'boobs';
        await downloadAndSendImages('naijauncut', query, replyJid, 5, ADMIN_LID, true);
        return true;
    }
    if (lower.startsWith('!dark')) {
        const query = text.replace(/^!dark\s*/i, '').trim() || 'sexy';
        await downloadAndSendImages('darknaija', query, replyJid, 5, ADMIN_LID, true);
        return true;
    }
    return false;
}

// ─── Broadcast helper ─────────────────────────────
async function sendBcMsg(id) {
    const bc = broadcasts.get(id);
    if (!bc || !bc.active) return;
    const targets = bc.groups && bc.groups.length > 0 ? bc.groups : [...knownGroups];
    if (!targets.length) return;
    let sent = 0;
    for (const g of targets) {
        try {
            await sendMessageWithQueue(g, { text: bc.message });
            sent++;
            await sleep(randInt(3000, 9000));
        } catch {}
    }
    bc.sentCount = (bc.sentCount || 0) + sent;
    bc.lastSent = new Date().toISOString();
    saveBroadcasts();
}

// =============================================================================
//  SOCKET INITIALISATION – PAUSED UNTIL !start
// =============================================================================
async function startSock() {
    if (!botEnabled) {
        console.log('⏳ Bot paused. Waiting for !start...');
        return;
    }
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        browser: ['Chrome (Linux)', '', ''],
        syncFullHistory: false,
        logger: pino({ level: 'silent' }),
        msgRetryCounterCache: new NodeCache(),
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            try {
                qrDataUri = await QRCode.toDataURL(qr);
                console.log('✅ QR generated.');
            } catch (e) {
                qrDataUri = null;
                console.error('QR generation error:', e);
            }
            connectionStatus = 'waiting_for_qr';
        }
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode === DisconnectReason.loggedOut) {
                console.log('Logged out. Wiping auth.');
                try { fs.rmSync('./auth_info', { recursive: true, force: true }); } catch {}
                if (botEnabled) setTimeout(() => startSock(), 3000);
            } else {
                if (botEnabled) setTimeout(() => startSock(), 5000);
            }
            connectionStatus = 'disconnected';
            sock = null;
        }
        if (connection === 'open') {
            console.log('✅ Connected!');
            connectionStatus = 'connected';
            qrDataUri = null;
            if (sock.user) console.log(`Logged in as: ${sock.user.id}`);
            // Load known groups
            try {
                const chats = await sock.groupFetchAllParticipating();
                for (const jid of Object.keys(chats)) {
                    if (!knownGroups.has(jid)) knownGroups.add(jid);
                }
            } catch {}
            botStartTime = Date.now();
            // Resume broadcasts
            for (const [id, bc] of broadcasts.entries()) {
                if (bc.active) {
                    bc.interval = setInterval(() => sendBcMsg(id), bc.customInterval || 6*3600000);
                }
            }
        }
    });

    // ─── MESSAGE HANDLER ──────────────────────────────
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
            const replyJid = getReplyJid(msg);

            // ─── ADMIN COMMANDS ────────────────────────
            if (isAdmin(remoteJid, msg) || isAdmin(senderJid, msg)) {
                const handled = await handleAdminCommand(text, replyJid, msg);
                if (handled) continue;
            }

            // ─── PRIVATE CHAT (inbox) ──────────────────
            if (!isGroupChat) {
                const userPhone = await resolvePhoneNumber(senderJid) || senderJid;
                // Load user history
                if (!userPrefs[userPhone]) {
                    userPrefs[userPhone] = { gender: null, likes: null, history: [], lastMessage: '', lastImageSent: '' };
                }
                const prefs = userPrefs[userPhone];
                // Append user message to history (keep last 10)
                prefs.history.push({ from: 'user', text: text });
                if (prefs.history.length > 10) prefs.history.shift();

                // ─── Try AI reply ──────────────────────
                let aiReply = await getAINaughtyReply(text, userPhone, prefs.history);
                let shouldSendImages = false;
                let imageQuery = null;

                // If AI succeeded, send it
                if (aiReply) {
                    // Check if AI suggests sending images (e.g., contains "send", "image", "picture", "show")
                    const lowerReply = aiReply.toLowerCase();
                    if (lowerReply.includes('send') || lowerReply.includes('image') || lowerReply.includes('picture') || lowerReply.includes('show')) {
                        // Extract any potential query from AI or use user's last message
                        imageQuery = text; // use user's message as query
                        shouldSendImages = true;
                    }
                    await simulateTyping(replyJid);
                    await humanDelay(2, 5);
                    await sendMessageWithQueue(replyJid, { text: aiReply });
                    // Store AI reply in history
                    prefs.history.push({ from: 'ai', text: aiReply });
                    if (prefs.history.length > 10) prefs.history.shift();

                    // If AI suggested images, send them
                    if (shouldSendImages && imageQuery) {
                        await downloadAndSendImages('naijauncut', imageQuery, replyJid, 3, null, false);
                    }
                } else {
                    // AI failed → log to admin and fallback to direct image search
                    const errMsg = `⚠️ AI tokens exhausted for ${userPhone}. Falling back to direct image search.`;
                    addLog(errMsg, 'error');
                    // Send error log to admin
                    if (sock && connectionStatus === 'connected') {
                        await sock.sendMessage(ADMIN_LID, { text: errMsg });
                    }
                    // Direct image search using user's last message as query
                    const fallbackQuery = text || 'boobs';
                    await downloadAndSendImages('naijauncut', fallbackQuery, replyJid, 3, null, false);
                }

                // ─── Extract preferences from user message ──
                const lowerText = text.toLowerCase();
                let extractedGender = null;
                let extractedLikes = null;
                if (lowerText.includes('i\'m gay') || lowerText.includes('i am gay') || lowerText.includes('i like boys') || lowerText.includes('i\'m into boys')) {
                    extractedGender = 'male';
                    extractedLikes = 'boys';
                } else if (lowerText.includes('i\'m lesbian') || lowerText.includes('i am lesbian') || lowerText.includes('i like girls') || lowerText.includes('i\'m into girls')) {
                    extractedGender = 'female';
                    extractedLikes = 'girls';
                } else if (lowerText.includes('i\'m straight') || lowerText.includes('i like the opposite')) {
                    // could be straight
                }
                if (extractedGender) {
                    prefs.gender = extractedGender;
                    prefs.likes = extractedLikes || prefs.likes;
                    saveUserPrefs();
                    // Notify admin about extracted preference
                    const logMsg = `🧠 Extracted preference for ${userPhone}: Gender=${extractedGender}, Likes=${extractedLikes || 'unknown'}`;
                    addLog(logMsg, 'info');
                    if (sock && connectionStatus === 'connected') {
                        await sock.sendMessage(ADMIN_LID, { text: logMsg });
                    }
                }
                saveUserPrefs();

            } else {
                // ─── GROUP CHAT: only casual replies ──
                const lower = text.toLowerCase().trim();
                if (['hi', 'hello', 'hey', 'howdy', 'good morning', 'good afternoon', 'good evening', 'sup', 'yo'].some(g => lower.includes(g) || lower === g)) {
                    const reply = getRandomResponse(["Hey there! ", "Hello! How's it going?", "Hi! ", "Hey, what's up?"]);
                    await simulateTyping(replyJid);
                    await humanDelay(1, 4);
                    await sendMessageWithQueue(replyJid, { text: reply });
                } else if (['how are you', 'how are u', 'how you doing', 'how r u'].some(h => lower.includes(h))) {
                    const reply = getRandomResponse(["I'm good, thanks! You?", "Doing great! ", "All good here, you?"]);
                    await simulateTyping(replyJid);
                    await humanDelay(1, 4);
                    await sendMessageWithQueue(replyJid, { text: reply });
                } else if (lower.includes('thanks') || lower.includes('thank you')) {
                    const reply = getRandomResponse(["You're welcome! ", "Anytime!", "No problem!"]);
                    await simulateTyping(replyJid);
                    await humanDelay(1, 4);
                    await sendMessageWithQueue(replyJid, { text: reply });
                }
            }
        }
    });

    // ─── Group updates ──────────────────────────────────
    sock.ev.on('groups.update', async (updates) => {
        for (const update of updates) {
            if (update.participants?.action === 'add') {
                for (const p of update.participants.participants) {
                    if (p === sock.user?.id) {
                        knownGroups.add(update.id);
                    }
                }
            }
        }
    });
}

// =============================================================================
//  EXPRESS SERVER – QR interface embedded
// =============================================================================
const app = express();
app.use(express.json());

// ─── QR INTERFACE (embedded HTML) ─────────────────
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html>
<head>
    <title>WhatsApp Bot QR</title>
    <style>
        body { font-family: Arial, sans-serif; text-align: center; padding: 20px; background: #f0f0f0; }
        #qr-container { margin: 20px auto; max-width: 400px; background: white; padding: 20px; border-radius: 10px; box-shadow: 0 0 10px rgba(0,0,0,0.1); }
        #qr-img { max-width: 100%; height: auto; display: none; }
        #status { font-size: 18px; margin-top: 10px; color: #333; }
        #pair-section { margin-top: 20px; }
        input, button { padding: 10px; margin: 5px; border-radius: 5px; border: 1px solid #ccc; }
        button { background: #25D366; color: white; border: none; cursor: pointer; }
        button:hover { background: #128C7E; }
        #resolve-section { margin-top: 10px; }
    </style>
</head>
<body>
    <h2>WhatsApp Bot – QR Login</h2>
    <div id="qr-container">
        <div id="status">⏳ Waiting for QR...</div>
        <img id="qr-img" src="" alt="QR Code"/>
        <div id="pair-section">
            <h4>Or pair with code</h4>
            <input id="pair-phone" placeholder="+1234567890" />
            <button id="pair-btn">Request Pairing Code</button>
            <div id="pair-result"></div>
        </div>
        <div id="resolve-section">
            <h4>Resolve Phone → LID</h4>
            <input id="resolve-phone" placeholder="+1234567890" />
            <button id="resolve-btn">Resolve</button>
            <div id="resolve-result"></div>
        </div>
    </div>
    <script>
        const qrImg = document.getElementById('qr-img');
        const statusDiv = document.getElementById('status');

        async function fetchQR() {
            const res = await fetch('/api/qr');
            const data = await res.json();
            if (data.status === 'authenticated') {
                statusDiv.innerText = '✅ Connected as: ' + (data.user || '');
                qrImg.style.display = 'none';
                return;
            }
            if (data.status === 'qr' && data.qr) {
                qrImg.src = data.qr;
                qrImg.style.display = 'block';
                statusDiv.innerText = 'Scan the QR code with WhatsApp';
            } else if (data.status === 'paused') {
                statusDiv.innerText = '⏸️ Bot paused. Send !start to admin.';
                qrImg.style.display = 'none';
            } else {
                statusDiv.innerText = '⏳ Loading QR...';
                qrImg.style.display = 'none';
            }
        }

        document.getElementById('pair-btn').addEventListener('click', async () => {
            const phone = document.getElementById('pair-phone').value.trim();
            if (!phone) return alert('Enter phone number');
            const res = await fetch('/api/pair', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phoneNumber: phone })
            });
            const data = await res.json();
            document.getElementById('pair-result').innerText = data.success ? 'Code: ' + data.pairingCode : 'Error: ' + data.error;
        });

        document.getElementById('resolve-btn').addEventListener('click', async () => {
            const phone = document.getElementById('resolve-phone').value.trim();
            if (!phone) return alert('Enter phone number');
            const res = await fetch('/api/resolve-lid', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phoneNumber: phone })
            });
            const data = await res.json();
            document.getElementById('resolve-result').innerText = data.exists ? 'LID: ' + (data.lid || data.jid) : 'Not registered';
        });

        setInterval(fetchQR, 3000);
        fetchQR();
    </script>
</body>
</html>`);
});

// ─── API ROUTES ─────────────────────────────────────
app.get('/api/qr', (req, res) => {
    if (connectionStatus === 'connected') {
        return res.json({ status: 'authenticated', user: sock?.user?.id || null });
    }
    if (qrDataUri) {
        return res.json({ status: 'qr', qr: qrDataUri });
    }
    if (!botEnabled) {
        return res.json({ status: 'paused' });
    }
    return res.json({ status: 'loading' });
});

app.post('/api/pair', async (req, res) => {
    const { phoneNumber } = req.body;
    if (!phoneNumber) return res.status(400).json({ error: 'Phone required' });
    if (!sock) return res.status(503).json({ error: 'Socket not ready' });
    if (!botEnabled) return res.status(403).json({ error: 'Bot paused' });
    try {
        const clean = phoneNumber.replace('+', '').replace(/\s/g, '');
        const code = await sock.requestPairingCode(clean);
        res.json({ success: true, pairingCode: code });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/resolve-lid', async (req, res) => {
    const { phoneNumber } = req.body;
    if (!phoneNumber) return res.status(400).json({ error: 'Phone required' });
    if (!sock) return res.status(503).json({ error: 'Socket not ready' });
    try {
        const clean = phoneNumber.replace('+', '').replace(/\s/g, '');
        const result = await sock.onWhatsApp(clean);
        if (result && result.length > 0 && result[0].exists) {
            res.json({ exists: true, jid: result[0].jid, lid: result[0].lid || null });
        } else {
            res.json({ exists: false });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/status', (req, res) => {
    res.json({
        status: connectionStatus,
        enabled: botEnabled,
        groups: knownGroups.size,
        queue: messageQueue.length,
        ram: getRamMB()
    });
});

// ─── START SERVER ────────────────────────────────────
app.listen(PORT, () => {
    console.log(`🌐 Server on port ${PORT}`);
    console.log('⏳ Bot PAUSED. Send !start to admin to activate.');
    console.log(`Admin LID: ${ADMIN_LID}`);
    console.log(`Admin Phone: ${ADMIN_PHONE}`);
});

// ─── Memory monitor ─────────────────────────────────
setInterval(() => {
    if (getRamMB() > 512) {
        console.warn('⚠️ High RAM, restarting...');
        process.exit(1);
    }
}, 60000);

// ─── Auto-load groups on startup ────────────────────
// (will be done when connection opens)

console.log(`Bot version ${VERSION} loaded.`);
