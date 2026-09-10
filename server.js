'use strict';

// ================================================================
// WHATSAPP BROADCAST BOT v23.0
// DMs & Groups — separately or jointly
// Advertisement message builder
// Rate limit: 5,000 messages/minute
// Real Shona +18 Slang & Anti-Spam Integration
// ================================================================

const express = require('express');
const path = require('path');
const fs = require('fs');
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
// RATE LIMITER — 5,000 messages per minute
// ================================================================
class RateLimiter {
    constructor(maxPerMinute = 5000) {
        this.maxPerMinute = maxPerMinute;
        this.windowMs = 60000; // 1 minute
        this.buckets = new Map(); // jid -> timestamps[]
    }

    check(jid) {
        const now = Date.now();
        const windowStart = now - this.windowMs;

        if (!this.buckets.has(jid)) {
            this.buckets.set(jid, []);
        }

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
        if (!this.buckets.has(jid)) {
            this.buckets.set(jid, []);
        }
        this.buckets.get(jid).push(Date.now());
    }

    stats(jid) {
        const now = Date.now();
        const windowStart = now - this.windowMs;
        const timestamps = (this.buckets.get(jid) || []).filter(ts => ts > windowStart);
        return {
            sentLastMinute: timestamps.length,
            limit: this.maxPerMinute,
            remaining: Math.max(0, this.maxPerMinute - timestamps.length)
        };
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

const processedMessages = new Set();
const messageHistory = new Map();    // jid -> [messages] for anti-repeat
const userSessions = new Map();      // jid -> { lastMsg, context, nsfwCount }
const activeChats = new Set();       // All JIDs that have messaged the bot

// Broadcast state
let pendingBroadcastImage = null;    // { buffer, mimetype, caption }
let broadcastTargets = [];           // [{ jid, type: 'dm'|'group', name }]
let broadcastMode = 'joint';         // 'dm' | 'group' | 'joint'
let broadcastProgress = null;        // { sent, failed, total, status }

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

// Shona Image Prompt Translation Map
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
        if (SHONA_SLANG_MAP[cleanWord]) {
            return SHONA_SLANG_MAP[cleanWord];
        }
        return word;
    });

    return mappedWords.join(' ');
}

// ================================================================
// AI FALLBACK CHAIN
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
                return res.data.choices[0].message.content;
            }
        } catch (err) {
            console.error(`Venice AI failed: ${err.message}`);
        }
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
                return res.data.choices[0].message.content;
            }
        } catch (err) {
            console.error(`Rewind AI failed: ${err.message}`);
        }
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
                return res.data.choices[0].message.content;
            }
        } catch (err) {
            console.error(`OpenAI failed: ${err.message}`);
        }
    }

    if (GEMINI_KEY) {
        try {
            const res = await axios.post(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_KEY}`,
                {
                    contents: [{ parts: [{ text: `${systemPrompt}\n\nUser: ${prompt}` }] }]
                },
                { timeout: 15000 }
            );
            if (res.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
                return res.data.candidates[0].content.parts[0].text;
            }
        } catch (err) {
            console.error(`Gemini failed: ${err.message}`);
        }
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
                    `*${title || 'SPECIAL OFFER'}*`,
                    '',
                    body || '',
                    cta ? `\n👉 *${cta}*` : '',
                    link ? `\n📎 ${link}` : '',
                    footer ? `\n_${footer}_` : ''
                ].filter(Boolean).join('\n');

            case 'minimal':
                return [
                    title || '',
                    body || '',
                    cta || '',
                    link || ''
                ].filter(Boolean).join('\n\n');

            case 'fancy':
            default:
                const lines = [];
                lines.push('╔══════════════════════════╗');
                lines.push(`║  ✨ ${(title || 'SPECIAL OFFER').toUpperCase()}  ✨`);
                lines.push('╚══════════════════════════╝');
                lines.push('');
                if (body) lines.push(body);
                lines.push('');
                if (cta) lines.push(`🔥 *${cta}*`);
                if (link) lines.push(`📎 ${link}`);
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
                    ? {
                        image: image.buffer,
                        mimetype: image.mimetype || 'image/jpeg',
                        caption: message
                    }
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

        return results;
    }
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

    const isGroupChat = jid.endsWith('@g.us');
    const senderJid = isGroupChat ? msg.key.participant : jid;
    const isAdmin = senderJid === ADMIN_JID;

    if (isGroupChat && !isAdmin && !shouldReplyToGroup(msg, sock.user?.id)) {
        return;
    }

    if (!messageHistory.has(senderJid)) {
        messageHistory.set(senderJid, []);
    }
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
        await sock.sendMessage(jid, { text: aiReply }, { quoted: msg });
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
                await sock.sendMessage(jid, {
                    text: `❌ *Usage:* \`!broadcast [dm|group|joint] <message>\``
                }, { quoted: msg });
                return;
            }

            await sock.sendMessage(jid, { text: `⏳ Sending broadcast (mode: ${mode.toUpperCase()})...` });
            const results = await BroadcastEngine.send({ message, mode });
            await sock.sendMessage(jid, {
                text: `✅ *Broadcast Complete*\n📤 Sent: *${results.sent}*\n❌ Failed: *${results.failed}*`
            });
            break;
        }

        case 'ad': {
            const parts = rest.split('|').map(p => p.trim());
            const [title, body, cta, link, style] = parts;

            if (!title || !body) {
                await sock.sendMessage(jid, {
                    text: `📢 *Ad Builder*\n\nUsage: \`!ad <title> | <body> | [cta] | [link] | [style]\``
                }, { quoted: msg });
                return;
            }

            const adText = AdBuilder.build({ title, body, cta, link, footer: 'Reply STOP to opt out', style: style || 'fancy' });
            await sock.sendMessage(jid, { text: `📢 *Ad Preview:*\n\n${adText}` }, { quoted: msg });
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
            await sock.sendMessage(jid, {
                text: `✅ *Ad Broadcast Complete*\n📤 Sent: *${results.sent}*\n❌ Failed: *${results.failed}*`
            });
            break;
        }

        case 'stats': {
            const dmCount = [...activeChats].filter(j => j.endsWith('@s.whatsapp.net')).length;
            const groupCount = [...activeChats].filter(j => j.endsWith('@g.us')).length;
            await sock.sendMessage(jid, {
                text: `📊 *Bot Stats*\n💬 DMs: *${dmCount}*\n👥 Groups: *${groupCount}*`
            });
            break;
        }
    }
}

// ================================================================
// EXPRESS SERVER & STARTUP
// ================================================================
const app = express();
app.use(express.json());

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

    BroadcastEngine.send({ message, mode }).then(results => {
        console.log(`Broadcast complete: ${results.sent}/${results.total}`);
    });

    res.json({ success: true, message: 'Broadcast started' });
});

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true,
        browser: Browsers.ubuntu('Chrome'),
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, qr } = update;
        if (qr) {
            qrDataUri = await QRCode.toDataURL(qr);
            connectionStatus = 'qr';
        }
        if (connection === 'open') {
            connectionStatus = 'connected';
            console.log('✅ Bot connected to WhatsApp!');
        }
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
            if (!msg.key.fromMe) {
                await handleMessage(msg);
            }
        }
    });
}

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    startBot().catch(console.error);
});
