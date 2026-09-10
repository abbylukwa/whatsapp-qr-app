'use strict';

// ============================================================
// ABBY BOT v3.0 — Abby Faith Sithole, 23, Zim 🇿🇼
// WhatsApp AI Girl Bot with NSFW scraping, multi-AI fallback
// ============================================================

const express = require('express');
const path = require('path');
const fs = require('fs-extra');
const NodeCache = require('node-cache');
const {
    makeWASocket, DisconnectReason,
    useMultiFileAuthState, Browsers,
    makeInMemoryStore, fetchLatestBaileysVersion,
    downloadContentFromMessage
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');
const axios = require('axios');

// ============================================================
// CONFIGURATION
// ============================================================
const PORT = process.env.PORT || 10000;
const AUTH_FOLDER = 'auth_info';
const SCRAPER_URL = 'https://intelligent-scraper.onrender.com';

// Admin Details
const ADMIN_PHONE = '263777627210'; // Your phone number
const ADMIN_JID = `${ADMIN_PHONE}@s.whatsapp.net`;

// API Keys
const REWIND_KEY = 'sk-rewind-31c3a65acc981512de959195485deec0';
const OPENAI_KEY = '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';
const VENICE_KEY = 'VENICE_INFERENCE_KEY_Jf3qRN_btIp0Z-hocTep0NddIJlN-OcptbUZd9_jxT';
const SDAPI_KEY = '3ly3xiizOmBF6WoDZaALK1iZuy4tvNFe6zTOC7qvtIaogKta2Xn7WcglITqW';
const GEMINI_KEY = 'AQ.Ab8RN6LRJI9216qL7wV-x38fBNj8QOVqFqyCxxYJ851ClPwYGw';

// Abby's Persona
const ABBY_PROFILE = {
    name: 'Abby Faith Sithole',
    age: 23,
    location: 'Harare, Zimbabwe 🇿🇼',
    status: 'Single & ready to mingle 😘',
    vibe: 'Horny, playful, flirty, naughty Zim girl who loves to have fun',
    likes: ['dancing', 'partying', 'sexting', 'nudes', 'late night chats', 'braai', 'amapiano'],
    body: 'Curvy, thick thighs, big booty, perky boobs, soft brown skin',
    personality: "I'm just a girl who loves to have fun. Not looking for anything serious, just good vibes and good... you know 😏"
};

// ============================================================
// STATE & CACHES
// ============================================================
let sock = null;
let qrDataUri = null;
let connectionStatus = 'disconnected';
let botStartTime = Date.now();

const processedMessages = new Set();
const messageHistory = new Map(); // jid -> [messages] for anti-repeat
const userSessions = new Map(); // jid -> { lastMsg, context, nsfwCount }
const groupLinks = new Map(); // groupName -> { link, addedBy, addedAt }
const activeChats = new Set(); // Track all JIDs that have messaged the bot

// Admin Broadcast Verification State
let pendingBroadcastImage = null; // { buffer, mimetype, caption }

const replyCache = new NodeCache({ stdTTL: 300, checkperiod: 60 }); // 5min anti-repeat

// ============================================================
// LOGS SYSTEM
// ============================================================
const logs = [];
function addLog(msg, type = 'info') {
    const entry = { time: new Date().toISOString(), msg, type };
    logs.push(entry);
    if (logs.length > 500) logs.shift();
    console.log(`[${type.toUpperCase()}] ${msg}`);
}

// Send logs directly to Admin WhatsApp
async function sendLogToAdmin(msg, type = 'info') {
    if (!sock) return;
    try {
        const emoji = type === 'error' ? '❌' : type === 'success' ? '✅' : 'ℹ️';
        await sock.sendMessage(ADMIN_JID, { text: `${emoji} *[LOG - ${type.toUpperCase()}]*\n${msg}` });
    } catch (err) {
        console.error('Failed to send log to admin:', err);
    }
}

// ============================================================
// UTILITIES
// ============================================================
function toBare(jid) {
    if (!jid) return '';
    return jid.split(':')[0].replace('@s.whatsapp.net', '').replace('@g.us', '');
}
function isGroup(jid) { return jid && jid.endsWith('@g.us'); }
function isInbox(jid) { return jid && jid.endsWith('@s.whatsapp.net'); }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function simulateTyping(jid) {
    if (!sock) return;
    try {
        await sock.sendPresenceUpdate('composing', jid);
        await sleep(randInt(1500, 3500));
        await sock.sendPresenceUpdate('paused', jid);
    } catch {}
}

// ============================================================
// KEYWORD RECOGNITION (FALLBACKS)
// ============================================================
const NSFW_KEYWORDS = [
    'pussy', 'boobs', 'nude', 'naked', 'remove bra', 'send pic', 'horny', 
    'fuck', 'dick', 'cock', 'ass', 'panties', 'undress', 'vagina', 'tits',
    'sex', 'porn', 'video', 'pusst', 'braa', 'show me'
];

const CONSTANT_NAUGHTY_REPLIES = [
    "Mmm, you're making me so wet right now... 😏",
    "I wish you were here to touch me... 🙈",
    "Stop talking and come make me scream baby. 💦",
    "You like what you see? I can show you more if you treat me right. 😘",
    "I'm literally in bed thinking about you right now... 🤤",
    "Let's play a game... you tell me what you want to do to me, and I might just let you. 😉",
    "Zim girls do it best, you know that right? 🇿🇼🔥"
];

const CASUAL_REPLIES = [
    "Hey! What's up? 😊",
    "Just chilling, listening to some Amapiano. You? 🎶",
    "Aww, that's sweet of you!",
    "Haha you're funny! I like your vibe.",
    "Tell me more about yourself babe."
];

// ============================================================
// MULTI-AI FALLBACK CHAIN
// ============================================================
async function askAI(prompt, systemPrompt, jid) {
    // 1. Venice AI (Primary Uncensored)
    try {
        addLog('Attempting Venice AI...', 'info');
        const res = await axios.post('https://api.venice.ai/api/v1/chat/completions', {
            model: 'venice-uncensored',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: prompt }
            ]
        }, {
            headers: { 'Authorization': `Bearer ${VENICE_KEY}`, 'Content-Type': 'application/json' },
            timeout: 8000
        });
        if (res.data?.choices?.[0]?.message?.content) {
            addLog('Venice AI Success', 'success');
            return res.data.choices[0].message.content;
        }
    } catch (err) {
        addLog(`Venice AI Failed: ${err.message}`, 'error');
    }

    // 2. Rewind AI (Secondary Uncensored)
    try {
        addLog('Attempting Rewind AI...', 'info');
        const res = await axios.post('https://api.rewind.ai/v1/chat/completions', {
            model: 'rewind-uncensored',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: prompt }
            ]
        }, {
            headers: { 'Authorization': `Bearer ${REWIND_KEY}`, 'Content-Type': 'application/json' },
            timeout: 8000
        });
        if (res.data?.choices?.[0]?.message?.content) {
            addLog('Rewind AI Success', 'success');
            return res.data.choices[0].message.content;
        }
    } catch (err) {
        addLog(`Rewind AI Failed: ${err.message}`, 'error');
    }

    // 3. OpenAI (Tertiary)
    try {
        addLog('Attempting OpenAI...', 'info');
        const res = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: prompt }
            ]
        }, {
            headers: { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
            timeout: 8000
        });
        if (res.data?.choices?.[0]?.message?.content) {
            addLog('OpenAI Success', 'success');
            return res.data.choices[0].message.content;
        }
    } catch (err) {
        addLog(`OpenAI Failed: ${err.message}`, 'error');
    }

    // 4. Gemini (Quaternary)
    try {
        addLog('Attempting Gemini...', 'info');
        const res = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`, {
            contents: [{ parts: [{ text: `${systemPrompt}\n\nUser: ${prompt}` }] }]
        }, { timeout: 8000 });
        if (res.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
            addLog('Gemini Success', 'success');
            return res.data.candidates[0].content.parts[0].text;
        }
    } catch (err) {
        addLog(`Gemini Failed: ${err.message}`, 'error');
    }

    // 5. Hardcoded Fallback
    addLog('All AIs offline. Using constant fallback.', 'warning');
    await sendLogToAdmin('All AI models failed or rate-limited. Using constant fallbacks.', 'error');
    
    const isNaughty = NSFW_KEYWORDS.some(kw => prompt.toLowerCase().includes(kw));
    return isNaughty ? getRandomResponse(CONSTANT_NAUGHTY_REPLIES) : getRandomResponse(CASUAL_REPLIES);
}

// ============================================================
// MEDIA SCRAPER INTEGRATION
// ============================================================
async function fetchMediaFromScraper(query, type = 'image') {
    try {
        if (type === 'gif') {
            const res = await axios.get(`${SCRAPER_URL}/gif?q=${encodeURIComponent(query)}&limit=1`);
            if (res.data?.success && res.data?.gifs?.length > 0) {
                return res.data.gifs[0].url;
            }
        } else {
            const res = await axios.post(`${SCRAPER_URL}/search`, { query, limit: 1 });
            if (res.data?.success && res.data?.images?.length > 0) {
                return res.data.images[0].url;
            }
        }
    } catch (err) {
        addLog(`Scraper failed for ${query}: ${err.message}`, 'error');
    }
    return null;
}

// ============================================================
// WHATSAPP CONNECTION
// ============================================================
async function connectToWhatsApp() {
    if (isConnecting) return;
    isConnecting = true;
    connectionStatus = 'connecting';
    addLog('Connecting to WhatsApp...', 'info');

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Desktop'),
        syncFullHistory: false
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrDataUri = await QRCode.toDataURL(qr);
            connectionStatus = 'qr';
            addLog('New QR Code generated.', 'info');
        }

        if (connection === 'close') {
            qrDataUri = null;
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            addLog(`Connection closed. Reconnecting: ${shouldReconnect}`, 'warning');
            connectionStatus = 'disconnected';
            isConnecting = false;

            if (shouldReconnect && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                reconnectAttempts++;
                await sleep(5000);
                connectToWhatsApp();
            } else {
                addLog('Max reconnect attempts reached or logged out.', 'error');
            }
        } else if (connection === 'open') {
            qrDataUri = null;
            connectionStatus = 'connected';
            isConnecting = false;
            reconnectAttempts = 0;
            addLog('WhatsApp Connected Successfully! 🎉', 'success');
            await sendLogToAdmin('Abby Bot is now ONLINE and active! 🚀', 'success');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;
        for (const msg of m.messages) {
            try {
                await handleIncomingMessage(msg);
            } catch (err) {
                addLog(`Error handling message: ${err.message}`, 'error');
            }
        }
    });
}

// ============================================================
// INCOMING MESSAGE HANDLER
// ============================================================
async function handleIncomingMessage(msg) {
    if (!msg.message) return;
    const jid = msg.key.remoteJid;
    const fromMe = msg.key.fromMe;

    if (fromMe) return; // Ignore self

    const msgId = msg.key.id;
    if (processedMessages.has(msgId)) return;
    processedMessages.add(msgId);

    // Track active chats for broadcasts
    activeChats.add(jid);

    const senderName = msg.pushName || 'Babe';
    const body = msg.message.conversation || 
                 msg.message.extendedTextMessage?.text || 
                 msg.message.imageMessage?.caption || '';

    const cleanBody = body.trim().toLowerCase();

    // 1. ADMIN COMMANDS
    if (jid === ADMIN_JID) {
        if (cleanBody.startsWith('.join ')) {
            const link = body.slice(6).trim();
            try {
                const code = link.split('chat.whatsapp.com/')[1];
                if (code) {
                    await sock.groupAcceptInvite(code);
                    await sock.sendMessage(ADMIN_JID, { text: '✅ Successfully joined the group!' });
                    addLog(`Joined group via link: ${link}`, 'success');
                } else {
                    await sock.sendMessage(ADMIN_JID, { text: '❌ Invalid group link.' });
                }
            } catch (err) {
                await sock.sendMessage(ADMIN_JID, { text: `❌ Failed to join: ${err.message}` });
            }
            return;
        }

        if (cleanBody.startsWith('.broadcast ')) {
            const text = body.slice(11).trim();
            let successCount = 0;
            for (const chat of activeChats) {
                try {
                    await sock.sendMessage(chat, { text });
                    successCount++;
                    await sleep(500);
                } catch {}
            }
            await sock.sendMessage(ADMIN_JID, { text: `📢 Broadcast sent to ${successCount} chats.` });
            return;
        }

        // Admin "I'm Horny" Broadcast Verification System
        if (cleanBody === 'im horny' || cleanBody === '.imhorny') {
            await sock.sendMessage(ADMIN_JID, { text: '😏 *Naughty Broadcast Mode Activated!*\n\nPlease send or forward the nude image you want to broadcast to all inboxes. I will ask you to verify it first.' });
            return;
        }

        // Capture image for broadcast verification
        if (msg.message.imageMessage) {
            try {
                const stream = await downloadContentFromMessage(msg.message.imageMessage, 'image');
                let buffer = Buffer.from([]);
                for await (const chunk of stream) {
                    buffer = Buffer.concat([buffer, chunk]);
                }
                pendingBroadcastImage = {
                    buffer,
                    mimetype: msg.message.imageMessage.mimetype,
                    caption: msg.message.imageMessage.caption || ''
                };

                // Send back to admin to verify
                await sock.sendMessage(ADMIN_JID, {
                    image: buffer,
                    caption: `❓ *VERIFICATION REQUIRED*\n\nIs this the actual nude you want to send to ALL inboxes?\n\nReply with:\n👉 *.confirm* to send\n👉 *.cancel* to cancel`
                });
            } catch (err) {
                await sock.sendMessage(ADMIN_JID, { text: `❌ Failed to process image: ${err.message}` });
            }
            return;
        }

        if (cleanBody === '.confirm') {
            if (!pendingBroadcastImage) {
                await sock.sendMessage(ADMIN_JID, { text: '❌ No pending broadcast image found.' });
                return;
            }
            await sock.sendMessage(ADMIN_JID, { text: '🚀 Broadcasting verified nude to all inboxes... Please wait.' });
            
            let successCount = 0;
            for (const chat of activeChats) {
                if (isInbox(chat) && chat !== ADMIN_JID) {
                    try {
                        await sock.sendMessage(chat, {
                            image: pendingBroadcastImage.buffer,
                            mimetype: pendingBroadcastImage.mimetype,
                            caption: pendingBroadcastImage.caption || "Look what I just took for you... do you like it? 😏💦"
                        });
                        successCount++;
                        await sleep(1000);
                    } catch {}
                }
            }
            await sock.sendMessage(ADMIN_JID, { text: `✅ Broadcast complete! Sent to ${successCount} inboxes.` });
            pendingBroadcastImage = null;
            return;
        }

        if (cleanBody === '.cancel') {
            pendingBroadcastImage = null;
            await sock.sendMessage(ADMIN_JID, { text: '❌ Broadcast cancelled.' });
            return;
        }

        if (cleanBody === '.stats') {
            const uptime = Math.floor((Date.now() - botStartTime) / 1000);
            await sock.sendMessage(ADMIN_JID, {
                text: `📊 *BOT STATUS*\n\nUptime: ${uptime}s\nActive Chats: ${activeChats.size}\nGroup Links Saved: ${groupLinks.size}`
            });
            return;
        }
    }

    // 2. GROUP LINK COLLECTOR (Every weekend grouping)
    const groupLinkRegex = /chat\.whatsapp.com\/([a-zA-Z0-9-_]{20,26})/g;
    let match;
    while ((match = groupLinkRegex.exec(body)) !== null) {
        const link = match[0];
        const code = match[1];
        if (!groupLinks.has(code)) {
            groupLinks.set(code, {
                link: `https://${link}`,
                addedBy: senderName,
                addedAt: new Date().toISOString()
            });
            addLog(`Saved new group link: ${link}`, 'info');
        }
    }

    // 3. ANTI-REPEAT / ANTI-LOOP PROTECTION
    const cacheKey = `${jid}:${cleanBody}`;
    if (replyCache.has(cacheKey)) {
        addLog(`Blocked duplicate message loop from ${jid}`, 'warning');
        return;
    }
    replyCache.set(cacheKey, true);

    // Keep history of last 3 messages to prevent repeating the same response
    if (!messageHistory.has(jid)) messageHistory.set(jid, []);
    const history = messageHistory.get(jid);
    if (history.includes(cleanBody)) {
        addLog(`User repeating themselves. Ignoring to prevent loop.`, 'warning');
        return;
    }
    history.push(cleanBody);
    if (history.length > 3) history.shift();

    // 4. INBOX VS GROUP LOGIC
    if (isGroup(jid)) {
        // Casual, friendly, non-NSFW chat in groups
        if (cleanBody.includes('abby') || cleanBody.includes('faith')) {
            await simulateTyping(jid);
            const systemPrompt = `You are Abby Faith Sithole, a friendly 23-year-old girl from Harare, Zimbabwe. You are chatting in a public WhatsApp group. Keep your replies short, casual, friendly, and completely clean (no NSFW, no adult talk). Use some Zim slang like 'bho', 'babe', 'sharp'.`;
            const reply = await askAI(body, systemPrompt, jid);
            await sock.sendMessage(jid, { text: reply }, { quoted: msg });
        }
    } else if (isInbox(jid)) {
        // Flirty, naughty, NSFW chat in Inbox
        await simulateTyping(jid);

        // Check if requesting nudes/porn
        const wantsNSFW = NSFW_KEYWORDS.some(kw => cleanBody.includes(kw));
        if (wantsNSFW) {
            addLog(`${senderName} requested NSFW content. Fetching from scraper...`, 'info');
            const mediaUrl = await fetchMediaFromScraper(cleanBody, cleanBody.includes('gif') ? 'gif' : 'image');
            
            if (mediaUrl) {
                try {
                    await sock.sendMessage(jid, {
                        image: { url: mediaUrl },
                        caption: getRandomResponse(CONSTANT_NAUGHTY_REPLIES)
                    }, { quoted: msg });
                    addLog(`Sent scraped NSFW media to ${senderName}`, 'success');
                    return;
                } catch (err) {
                    addLog(`Failed to send scraped media: ${err.message}`, 'error');
                }
            }
        }

        // Standard flirty chat
        const systemPrompt = `You are Abby Faith Sithole, a flirty, naughty, single 23-year-old girl from Harare, Zimbabwe. You are chatting in a private inbox with a guy. You want to have fun, you love sexting, and you are highly flirty. Keep your replies short, natural, and extremely flirty. Never mention you are an AI or a bot. Use Zim slang like 'bho', 'mufunge', 'babe' naturally.`;
        const reply = await askAI(body, systemPrompt, jid);
        await sock.sendMessage(jid, { text: reply }, { quoted: msg });
    }
}

// ============================================================
// EXPRESS SERVER FOR QR & ADMIN PANEL
// ============================================================
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
    if (connectionStatus === 'connected') {
        res.send(`
            <html>
                <head><title>Abby Bot Status</title><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/water.css@2/out/water.css"></head>
                <body>
                    <h1>Abby Bot is ONLINE 🟢</h1>
                    <p>Connected as Abby Faith Sithole (23, Zim)</p>
                    <p>Uptime: ${Math.floor((Date.now() - botStartTime) / 1000)}s</p>
                    <h2>Group Links Collected (${groupLinks.size})</h2>
                    <ul>
                        ${Array.from(groupLinks.values()).map(g => `<li><a href="${g.link}" target="_blank">${g.link}</a> (Added by ${g.addedBy})</li>`).join('')}
                    </ul>
                </body>
            </html>
        `);
    } else if (connectionStatus === 'qr' && qrDataUri) {
        res.send(`
            <html>
                <head><title>Scan QR Code</title><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/water.css@2/out/water.css"></head>
                <body>
                    <h1>Scan QR to Connect Abby Bot</h1>
                    <img src="${qrDataUri}" alt="QR Code" style="border: 4px solid #333; padding: 10px; background: white;"/>
                    <p>Refresh page if QR expires.</p>
                </body>
            </html>
        `);
    } else {
        res.send(`
            <html>
                <head><title>Connecting...</title><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/water.css@2/out/water.css"></head>
                <body>
                    <h1>Connecting to WhatsApp... Status: ${connectionStatus}</h1>
                    <script>setTimeout(() => location.reload(), 3000);</script>
                </body>
            </html>
        `);
    }
});

// Start Bot & Server
app.listen(PORT, () => {
    addLog(`Admin Panel running on port ${PORT}`, 'info');
    connectToWhatsApp();
});
