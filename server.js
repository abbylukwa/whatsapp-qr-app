'use strict';

// ================================================================
// WHATSAPP BROADCAST BOT v23.0
// DMs & Groups — separately or jointly
// Advertisement message builder
// Rate limit: 5,000 messages/minute
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

// API Keys (set via env vars in production)
const VENICE_KEY = process.env.VENICE_KEY || '';
const REWIND_KEY = process.env.REWIND_KEY || '';
const OPENAI_KEY = process.env.OPENAI_KEY || '';
const GEMINI_KEY = process.env.GEMINI_KEY || '';

// ================================================================
// RATE LIMITER — 5,000 messages per minute
// ================================================================
class RateLimiter {
    constructor(maxPerMinute = 5000) {
        this.maxPerMinute = maxPerMinute;
        this.windowMs = 60_000; // 1 minute
        this.buckets = new Map(); // jid -> timestamps[]
    }

    /**
     * Check if sending to this JID is allowed.
     * Returns { allowed: boolean, retryAfterMs: number, remaining: number }
     */
    check(jid) {
        const now = Date.now();
        const windowStart = now - this.windowMs;

        if (!this.buckets.has(jid)) {
            this.buckets.set(jid, []);
        }

        // Prune old entries
        let timestamps = this.buckets.get(jid).filter(ts => ts > windowStart);
        this.buckets.set(jid, timestamps);

        if (timestamps.length >= this.maxPerMinute) {
            const oldest = timestamps[0];
            const retryAfterMs = oldest - windowStart;
            return { allowed: false, retryAfterMs: Math.max(0, retryAfterMs), remaining: 0 };
        }

        return { allowed: true, retryAfterMs: 0, remaining: this.maxPerMinute - timestamps.length };
    }

    /**
     * Record a send to this JID.
     */
    record(jid) {
        if (!this.buckets.has(jid)) {
            this.buckets.set(jid, []);
        }
        this.buckets.get(jid).push(Date.now());
    }

    /**
     * Get current usage stats.
     */
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
const groupLinks = new Map();        // groupName -> { link, addedBy, addedAt }
const activeChats = new Set();       // All JIDs that have messaged the bot

// Broadcast state
let pendingBroadcastImage = null;    // { buffer, mimetype, caption }
let broadcastTargets = [];           // [{ jid, type: 'dm'|'group', name }]
let broadcastMode = 'joint';         // 'dm' | 'group' | 'joint'
let broadcastProgress = null;        // { sent, failed, total, status }

const replyCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

// ================================================================
// LOGS SYSTEM
// ================================================================
const logs = [];
function addLog(msg, type = 'info') {
    const entry = { time: new Date().toISOString(), msg, type };
    logs.push(entry);
    if (logs.length > 500) logs.shift();
    console.log(`[${type.toUpperCase()}] ${msg}`);
}

async function sendLogToAdmin(msg, type = 'info') {
    if (!sock) return;
    try {
        const emoji = type === 'error' ? '❌' : type === 'success' ? '✅' : 'ℹ️';
        await sock.sendMessage(ADMIN_JID, { text: `${emoji} *[LOG - ${type.toUpperCase()}]*\n${msg}` });
    } catch (err) {
        console.error('Failed to send log to admin:', err);
    }
}

// ================================================================
// UTILITIES
// ================================================================
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

// ================================================================
// ADVERTISEMENT MESSAGE BUILDER
// ================================================================
class AdBuilder {
    /**
     * Build a formatted advertisement message.
     * @param {Object} opts
     * @param {string} opts.title - Ad headline
     * @param {string} opts.body - Main ad copy
     * @param {string} [opts.cta] - Call to action
     * @param {string} [opts.link] - URL or phone number
     * @param {string} [opts.footer] - Footer text
     * @param {string} [opts.style] - 'bold' | 'fancy' | 'minimal'
     * @returns {string} Formatted ad text
     */
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

    /**
     * Build a broadcast announcement (admin-style).
     */
    static broadcast(title, body, cta, link) {
        return [
            `📢 *BROADCAST: ${title}*`,
            '━━━━━━━━━━━━━━━━━━',
            '',
            body,
            '',
            cta ? `▶️ *${cta}*` : '',
            link ? `🔗 ${link}` : '',
            '',
            '━━━━━━━━━━━━━━━━━━',
            '_Sent by Abby Bot • Reply STOP to opt out_'
        ].filter(Boolean).join('\n');
    }
}

// ================================================================
// BROADCAST ENGINE — DMs, Groups, or Joint
// ================================================================
class BroadcastEngine {
    /**
     * Collect all known targets.
     */
    static collectTargets(mode = 'joint') {
        const targets = [];

        if (mode === 'dm' || mode === 'joint') {
            for (const jid of activeChats) {
                if (isInbox(jid)) {
                    targets.push({ jid, type: 'dm', name: toBare(jid) });
                }
            }
        }

        if (mode === 'group' || mode === 'joint') {
            for (const jid of activeChats) {
                if (isGroup(jid)) {
                    targets.push({ jid, type: 'group', name: toBare(jid) });
                }
            }
        }

        return targets;
    }

    /**
     * Send a broadcast message to all targets with rate limiting.
     * @param {string} message - Text message to broadcast
     * @param {Object} [image] - Optional image { buffer, mimetype }
     * @param {string} mode - 'dm' | 'group' | 'joint'
     * @returns {Object} { sent, failed, errors }
     */
    static async send({ message, image = null, mode = 'joint' }) {
        if (!sock) throw new Error('Bot not connected');

        const targets = this.collectTargets(mode);
        const results = { sent: 0, failed: 0, total: targets.length, errors: [], mode };

        addLog(`Broadcast starting: ${targets.length} targets (mode: ${mode})`, 'info');

        for (let i = 0; i < targets.length; i++) {
            const target = targets[i];

            // Rate limit check
            const limit = globalRateLimiter.check(target.jid);
            if (!limit.allowed) {
                const waitMs = limit.retryAfterMs + 100;
                addLog(`Rate limit hit for ${target.jid}, waiting ${waitMs}ms`, 'info');
                await sleep(waitMs);
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
                addLog(`✅ Sent to ${target.type}: ${target.name}`, 'success');
            } catch (err) {
                results.failed++;
                results.errors.push({ jid: target.jid, name: target.name, error: err.message });
                addLog(`❌ Failed ${target.type}: ${target.name} — ${err.message}`, 'error');
            }

            // Small delay between messages to avoid triggering spam detection
            if (i < targets.length - 1) {
                await sleep(randInt(200, 600));
            }

            // Progress update every 50 messages
            if ((i + 1) % 50 === 0 || i === targets.length - 1) {
                broadcastProgress = {
                    sent: results.sent,
                    failed: results.failed,
                    total: results.total,
                    status: i === targets.length - 1 ? 'complete' : 'in-progress'
                };
                addLog(`Progress: ${results.sent}/${results.total} sent, ${results.failed} failed`, 'info');
            }
        }

        addLog(`Broadcast complete: ${results.sent} sent, ${results.failed} failed`, 'success');
        broadcastProgress = { ...results, status: 'complete' };
        return results;
    }
}

// ================================================================
// AI FALLBACK CHAIN
// ================================================================
async function askAI(prompt, systemPrompt, jid) {
    // 1. Venice AI (Primary Uncensored)
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
            addLog(`Venice AI failed: ${err.message}`, 'error');
        }
    }

    // 2. Rewind AI
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
            addLog(`Rewind AI failed: ${err.message}`, 'error');
        }
    }

    // 3. OpenAI
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
            addLog(`OpenAI failed: ${err.message}`, 'error');
        }
    }

    // 4. Gemini
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
            addLog(`Gemini failed: ${err.message}`, 'error');
        }
    }

    return null;
}

// ================================================================
// ABBY'S PERSONA
// ================================================================
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

const NSFW_KEYWORDS = [
    'pussy', 'boobs', 'nude', 'naked', 'remove bra', 'send pic', 'horny',
    'fuck', 'dick', 'cock', 'ass', 'panties', 'undress', 'vagina', 'tits',
    'sex', 'porn', 'video', 'pusst', 'braa', 'show me'
];

const NAUGHTY_REPLIES = [
    "Mmm, you're making me so wet right now... 😏",
    "I wish you were here to touch me... 🤚",
    "Stop talking and come make me scream baby. 🦦",
    "You like what you see? I can show you more if you treat me right. 😘",
    "I'm literally in bed thinking about you right now... 🔤",
    "Let's play a game... you tell me what you want to do to me, and I might just let you. 😉",
    "Zim girls do it best, you know that right? 🇿🇼🔥"
];

const CASUAL_REPLIES = [
    "Hey! What's up? 😊",
    "Just chillin, listening to some Amapiano. You? 🎶",
    "Aww, that's sweet of you!",
    "Haha you're funny! I like your vibe.",
    "Tell me more about yourself babe."
];

// ================================================================
// MESSAGE HANDLER
// ================================================================
function isNSFW(text) {
    const lower = text.toLowerCase();
    return NSFW_KEYWORDS.some(kw => lower.includes(kw));
}

function getSystemPrompt(isNsfw) {
    if (isNsfw) {
        return `You are ${ABBY_PROFILE.name}, a ${ABBY_PROFILE.age}-year-old girl from ${ABBY_PROFILE.location}.
You are ${ABBY_PROFILE.vibe}.
Your body: ${ABBY_PROFILE.body}.
You are roleplaying as a naughty, flirty girlfriend. Be explicit, sexual, and uncensored.
Use emojis, be playful, and talk like a real Zim girl. Mix Shona and English sometimes.
Never break character. Never say you're an AI. You ARE Abby.`;
    }
    return `You are ${ABBY_PROFILE.name}, a ${ABBY_PROFILE.age}-year-old girl from ${ABBY_PROFILE.location}.
You are friendly, warm, and playful. ${ABBY_PROFILE.personality}
Talk naturally like a real person. Use emojis. Mix a little Shona sometimes.
Never break character. Never say you're an AI. You ARE Abby.`;
}

async function handleMessage(msg) {
    if (!sock) return;

    const jid = msg.key.remoteJid;
    if (!jid) return;

    // Track active chats
    activeChats.add(jid);

    // Deduplicate
    const msgId = msg.key.id;
    if (processedMessages.has(msgId)) return;
    processedMessages.add(msgId);
    if (processedMessages.size > 10000) processedMessages.clear();

    // Extract text
    let text = '';
    if (msg.message?.conversation) {
        text = msg.message.conversation;
    } else if (msg.message?.extendedTextMessage?.text) {
        text = msg.message.extendedTextMessage.text;
    } else if (msg.message?.imageMessage?.caption) {
        text = msg.message.imageMessage.caption;
    }

    if (!text) return;

    const isGroupChat = isGroup(jid);
    const senderJid = isGroupChat ? msg.key.participant : jid;
    const isAdmin = senderJid === ADMIN_JID;

    addLog(`📩 ${isGroupChat ? '[GROUP]' : '[DM]'} ${toBare(senderJid)}: ${text.substring(0, 100)}`);

    // ================================================================
    // ADMIN COMMANDS
    // ================================================================
    if (isAdmin && text.startsWith('!')) {
        await handleAdminCommand(text, jid, msg);
        return;
    }

    // ================================================================
    // NORMAL CHAT
    // ================================================================
    const nsfw = isNSFW(text);

    // Check reply cache
    const cacheKey = `${senderJid}:${text.substring(0, 50)}`;
    const cached = replyCache.get(cacheKey);
    if (cached) {
        await sock.sendMessage(jid, { text: cached }, { quoted: msg });
        return;
    }

    // Simulate typing
    await simulateTyping(jid);

    // Try AI
    const systemPrompt = getSystemPrompt(nsfw);
    const aiReply = await askAI(text, systemPrompt, jid);

    let reply;
    if (aiReply) {
        reply = aiReply;
    } else {
        // Fallback to canned replies
        reply = nsfw
            ? NAUGHTY_REPLIES[Math.floor(Math.random() * NAUGHTY_REPLIES.length)]
            : CASUAL_REPLIES[Math.floor(Math.random() * CASUAL_REPLIES.length)];
    }

    // Cache reply
    replyCache.set(cacheKey, reply);

    // Send
    await sock.sendMessage(jid, { text: reply }, { quoted: msg });
    addLog(`💬 Replied to ${toBare(senderJid)}`);
}

// ================================================================
// ADMIN COMMAND HANDLER
// ================================================================
async function handleAdminCommand(text, jid, msg) {
    const args = text.slice(1).trim().split(/\s+/);
    const cmd = args[0].toLowerCase();
    const rest = args.slice(1).join(' ');

    switch (cmd) {

        // === BROADCAST ===
        case 'broadcast':
        case 'bc': {
            // !broadcast dm|group|joint <message>
            const modeArg = args[1]?.toLowerCase();
            const validModes = ['dm', 'group', 'joint'];
            const mode = validModes.includes(modeArg) ? modeArg : 'joint';
            const message = validModes.includes(modeArg) ? args.slice(2).join(' ') : args.slice(1).join(' ');

            if (!message) {
                await sock.sendMessage(jid, {
                    text: `❌ *Usage:* \`!broadcast [dm|group|joint] <message>\`\n\nExample:\n\`!broadcast dm Hey everyone!\`\n\`!broadcast group Important update\`\n\`!broadcast joint Big announcement!\``
                }, { quoted: msg });
                return;
            }

            await sock.sendMessage(jid, {
                text: `📢 *Broadcast Starting*\nMode: *${mode.toUpperCase()}*\nMessage: _${message.substring(0, 200)}${message.length > 200 ? '...' : ''}_\n\n⏳ Sending...`
            }, { quoted: msg });

            const results = await BroadcastEngine.send({ message, mode });

            await sock.sendMessage(jid, {
                text: `✅ *Broadcast Complete*\n━━━━━━━━━━━━━━━━━━\n📤 Sent: *${results.sent}*\n❌ Failed: *${results.failed}*\n📊 Total: *${results.total}*\n🎯 Mode: *${mode.toUpperCase()}*`
            });
            break;
        }

        // === BROADCAST WITH IMAGE ===
        case 'bcimg':
        case 'broadcastimg': {
            // !bcimg dm|group|joint <caption>
            // (image must be sent as reply or next message)
            const modeArg = args[1]?.toLowerCase();
            const validModes = ['dm', 'group', 'joint'];
            const mode = validModes.includes(modeArg) ? modeArg : 'joint';
            const caption = validModes.includes(modeArg) ? args.slice(2).join(' ') : args.slice(1).join(' ');

            // Check if message has a quoted image
            const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
            if (quotedMsg?.imageMessage) {
                const stream = await downloadContentFromMessage(quotedMsg.imageMessage, 'image');
                const buffer = await streamToBuffer(stream);
                pendingBroadcastImage = { buffer, mimetype: quotedMsg.imageMessage.mimetype || 'image/jpeg', caption };
                broadcastMode = mode;

                await sock.sendMessage(jid, {
                    text: `📸 *Image Broadcast Queued*\nMode: *${mode.toUpperCase()}*\nCaption: _${caption || '(none)'}_\n\nSend \`!sendbc\` to execute.`
                }, { quoted: msg });
            } else {
                await sock.sendMessage(jid, {
                    text: `❌ Reply to an image with \`!bcimg [dm|group|joint] <caption>\` to queue an image broadcast.`
                }, { quoted: msg });
            }
            break;
        }

        case 'sendbc': {
            if (!pendingBroadcastImage) {
                await sock.sendMessage(jid, { text: '❌ No pending image broadcast. Use !bcimg first.' }, { quoted: msg });
                return;
            }

            const { buffer, mimetype, caption } = pendingBroadcastImage;
            await sock.sendMessage(jid, { text: `⏳ Sending image broadcast (mode: ${broadcastMode})...` });

            const results = await BroadcastEngine.send({
                message: caption || '',
                image: { buffer, mimetype },
                mode: broadcastMode
            });

            pendingBroadcastImage = null;
            await sock.sendMessage(jid, {
                text: `✅ *Image Broadcast Complete*\n📤 Sent: *${results.sent}*\n❌ Failed: *${results.failed}*\n📊 Total: *${results.total}*`
            });
            break;
        }

        // === ADVERTISEMENT BUILDER ===
        case 'ad': {
            // !ad title | body | cta | link | style
            const parts = rest.split('|').map(p => p.trim());
            const [title, body, cta, link, style] = parts;

            if (!title || !body) {
                await sock.sendMessage(jid, {
                    text: `📢 *Ad Builder*\n\nUsage: \`!ad <title> | <body> | [cta] | [link] | [fancy|bold|minimal]\`\n\nExample:\n\`!ad BIG SALE | 50% off everything! | Shop Now | https://myshop.com | fancy\``
                }, { quoted: msg });
                return;
            }

            const adText = AdBuilder.build({ title, body, cta, link, footer: 'Reply STOP to opt out', style: style || 'fancy' });

            await sock.sendMessage(jid, { text: `📢 *Ad Preview:*\n\n${adText}\n\n━━━━━━━━━━━━━━━━━━\nSend \`!bcad dm|group|joint\` to broadcast this ad.` }, { quoted: msg });

            // Store for broadcast
            pendingBroadcastImage = null;
            broadcastTargets = [];
            broadcastMode = 'joint';
            // Store the ad text temporarily
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
                text: `✅ *Ad Broadcast Complete*\n📤 Sent: *${results.sent}*\n❌ Failed: *${results.failed}*\n📊 Total: *${results.total}*`
            });
            break;
        }

        // === STATS ===
        case 'stats': {
            const dmCount = [...activeChats].filter(isInbox).length;
            const groupCount = [...activeChats].filter(isGroup).length;
            const rateStats = globalRateLimiter.stats(jid);
            const uptime = Math.floor((Date.now() - botStartTime) / 1000);
            const hours = Math.floor(uptime / 3600);
            const mins = Math.floor((uptime % 3600) / 60);

            await sock.sendMessage(jid, {
                text: `📊 *Bot Stats*\n━━━━━━━━━━━━━━━━━━\n🟢 Status: *${connectionStatus}*\n⏱ Uptime: *${hours}h ${mins}m*\n💬 DM Chats: *${dmCount}*\n👥 Group Chats: *${groupCount}*\n📨 Total Active: *${activeChats.size}*\n⚡ Rate Limit: *${rateStats.sentLastMinute}/${rateStats.limit}* msgs/min\n🔑 Admin: *${toBare(ADMIN_JID)}*`
            });
            break;
        }

        // === LIST TARGETS ===
        case 'targets':
        case 'list': {
            const modeArg = args[1]?.toLowerCase();
            const targets = BroadcastEngine.collectTargets(modeArg || 'joint');

            if (targets.length === 0) {
                await sock.sendMessage(jid, { text: '📭 No targets found.' });
                return;
            }

            const dmTargets = targets.filter(t => t.type === 'dm');
            const groupTargets = targets.filter(t => t.type === 'group');

            let report = `📋 *Broadcast Targets*\n━━━━━━━━━━━━━━━━━━\n`;
            report += `💬 DMs: *${dmTargets.length}*\n`;
            report += `👥 Groups: *${groupTargets.length}*\n`;
            report += `📊 Total: *${targets.length}*\n\n`;

            if (dmTargets.length > 0 && dmTargets.length <= 20) {
                report += `*DMs:*\n${dmTargets.map(t => `  • ${t.name}`).join('\n')}\n`;
            }
            if (groupTargets.length > 0 && groupTargets.length <= 20) {
                report += `\n*Groups:*\n${groupTargets.map(t => `  • ${t.name}`).join('\n')}\n`;
            }

            await sock.sendMessage(jid, { text: report });
            break;
        }

        // === HELP ===
        case 'help':
        default: {
            await sock.sendMessage(jid, {
                text: `🤖 *Abby Bot v23.0 — Admin Commands*

*Broadcasting:*
\`!broadcast [dm|group|joint] <msg>\` — Send text broadcast
\`!bcimg [dm|group|joint] <caption>\` — Queue image broadcast (reply to image)
\`!sendbc\` — Execute queued image broadcast

*Advertisements:*
\`!ad <title> | <body> | [cta] | [link] | [style]\` — Build ad
\`!bcad [dm|group|joint]\` — Broadcast last ad

*Info:*
\`!stats\` — Bot statistics
\`!targets [dm|group|joint]\` — List broadcast targets
\`!help\` — This menu

*Rate Limit:* 5,000 msgs/min`
            });
            break;
        }
    }
}

// ================================================================
// STREAM TO BUFFER HELPER
// ================================================================
async function streamToBuffer(stream) {
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

// ================================================================
// WHATSAPP CONNECTION
// ================================================================
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome'),
        logger: pino({ level: 'silent' }),
        getMessage: async (key) => {
            // Basic message store for quoted replies
            return { conversation: 'Message not available' };
        }
    });

    // QR Code generation
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrDataUri = await QRCode.toDataURL(qr);
            connectionStatus = 'qr';
            addLog('QR Code generated — scan to connect', 'info');
        }

        if (connection === 'open') {
            connectionStatus = 'connected';
            qrDataUri = null;
            botStartTime = Date.now();
            addLog('✅ Bot connected to WhatsApp!', 'success');
            await sendLogToAdmin('Bot is now online and ready! 🟢', 'success');
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            connectionStatus = shouldReconnect ? 'reconnecting' : 'disconnected';
            addLog(`Connection closed. Reconnecting: ${shouldReconnect}`, 'error');

            if (shouldReconnect) {
                await sleep(5000);
                startBot();
            } else {
                addLog('Logged out. Please delete auth_info folder and restart.', 'error');
                await sendLogToAdmin('⚠️ Bot logged out! Please re-scan QR.', 'error');
            }
        }
    });

    // Credential updates
    sock.ev.on('creds.update', saveCreds);

    // Message handler
    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
            if (!msg.key.fromMe) {
                await handleMessage(msg);
            }
        }
    });

    // Group updates
    sock.ev.on('group-participants.update', async (update) => {
        addLog(`Group update in ${update.id}: ${update.action} ${update.participants.join(', ')}`);
    });
}

// ================================================================
// EXPRESS SERVER — Web Dashboard
// ================================================================
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// API: Get QR Code
app.get('/api/qr', (req, res) => {
    if (qrDataUri) {
        res.json({ qr: qrDataUri, status: 'qr' });
    } else if (connectionStatus === 'connected') {
        res.json({ qr: null, status: 'connected' });
    } else {
        res.json({ qr: null, status: connectionStatus });
    }
});

// API: Get status
app.get('/api/status', (req, res) => {
    const dmCount = [...activeChats].filter(isInbox).length;
    const groupCount = [...activeChats].filter(isGroup).length;
    const rateStats = globalRateLimiter.stats(ADMIN_JID);

    res.json({
        status: connectionStatus,
        uptime: Math.floor((Date.now() - botStartTime) / 1000),
        activeChats: activeChats.size,
        dmChats: dmCount,
        groupChats: groupCount,
        rateLimit: rateStats,
        broadcastProgress: broadcastProgress,
        logs: logs.slice(-50)
    });
});

// API: Get logs
app.get('/api/logs', (req, res) => {
    res.json({ logs: logs.slice(-100) });
});

// API: Get targets
app.get('/api/targets', (req, res) => {
    const mode = req.query.mode || 'joint';
    const targets = BroadcastEngine.collectTargets(mode);
    res.json({ targets, total: targets.length, mode });
});

// API: Send broadcast (from web panel)
app.post('/api/broadcast', async (req, res) => {
    const { message, mode = 'joint' } = req.body;
    if (!message) return res.status(400).json({ error: 'Message required' });
    if (!['dm', 'group', 'joint'].includes(mode)) return res.status(400).json({ error: 'Invalid mode' });

    // Run broadcast async
    BroadcastEngine.send({ message, mode }).then(results => {
        addLog(`Web broadcast complete: ${results.sent}/${results.total}`, 'success');
    });

    res.json({ success: true, message: 'Broadcast started' });
});

// API: Build ad
app.post('/api/ad', (req, res) => {
    const { title, body, cta, link, style } = req.body;
    if (!title || !body) return res.status(400).json({ error: 'Title and body required' });

    const adText = AdBuilder.build({ title, body, cta, link, style: style || 'fancy' });
    replyCache.set('LAST_AD', adText);
    res.json({ success: true, ad: adText });
});

// API: Broadcast ad
app.post('/api/bcad', async (req, res) => {
    const { mode = 'joint' } = req.body;
    const adText = replyCache.get('LAST_AD');
    if (!adText) return res.status(400).json({ error: 'No ad built yet' });

    BroadcastEngine.send({ message: adText, mode }).then(results => {
        addLog(`Ad broadcast complete: ${results.sent}/${results.total}`, 'success');
    });

    res.json({ success: true, message: 'Ad broadcast started' });
});

// Serve dashboard
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ================================================================
// STARTUP
// ================================================================
async function main() {
    // Ensure auth folder exists
    if (!fs.existsSync(AUTH_FOLDER)) {
        fs.mkdirSync(AUTH_FOLDER, { recursive: true });
    }

    // Ensure public folder exists
    if (!fs.existsSync(path.join(__dirname, 'public'))) {
        fs.mkdirSync(path.join(__dirname, 'public'), { recursive: true });
    }

    // Start WhatsApp connection
    startBot().catch(err => {
        addLog(`Bot startup error: ${err.message}`, 'error');
    });

    // Start Express server
    app.listen(PORT, () => {
        addLog(`🌐 Web dashboard running on port ${PORT}`, 'success');
        console.log(`Server running on http://localhost:${PORT}`);
    });
}

main().catch(err => {
    console.error('Fatal startup error:', err);
    process.exit(1);
});
