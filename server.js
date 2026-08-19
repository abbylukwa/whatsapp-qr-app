// ════════════════════════════════════════════════════════════════════════════════
//  WHATSAPP BOT v19.0
//  Aion Labs AI Group Manager | NSFW xvideos | All Downloads
//  v19: DownloaderX integration — yt-dlp-exec (universal), Facebook DL, all platforms fixed
//  v16 FIX: Admin detection — was reading r.jid (phone) instead of r.lid (actual LID)
// ════════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
//  SECTION 1: IMPORTS
// ═══════════════════════════════════════════════════════════════
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
const ytdl = require('ytdl-core');
const yts = require('yt-search');
let playdl = null;
try { playdl = require('play-dl'); console.log('[Init] play-dl v1.9.7 loaded'); } catch (e) { console.log('[Init] play-dl not available'); }
let translator = null;
try { translator = require('google-translate-api'); console.log('[Init] google-translate-api loaded'); } catch (e) { console.log('[Init] google-translate-api not available'); }
let xvideosLib = null;
try { xvideosLib = require('@rodrigogs/xvideos'); console.log('[Init] @rodrigogs/xvideos loaded'); } catch (e) { console.log('[Init] @rodrigogs/xvideos not available — NSFW search disabled'); }
// v19: yt-dlp-exec — auto-downloads yt-dlp binary, handles YouTube/TikTok/IG/FB bot detection
let ytdlpExec = null;
try { ytdlpExec = require('yt-dlp-exec'); console.log('[Init] yt-dlp-exec loaded — yt-dlp binary auto-managed'); } catch (e) { console.log('[Init] yt-dlp-exec not available — using fallback dlYtDlp'); }


// v18: yt-dlp auto-install (downloads binary if not found)
let YTDLP_PATH = 'yt-dlp'; // default: system yt-dlp
async function ensureYtDlp() {
  const { execSync } = require('child_process');
  const fs = require('fs');
  // Check 1: system PATH
  try { execSync('yt-dlp --version', { timeout: 5000 }); console.log('[Init] yt-dlp found in PATH'); return; } catch {}
  // Check 2: project dir (put there by build.sh on Render)
  const localPath = path.join(__dirname, 'yt-dlp');
  if (fs.existsSync(localPath)) {
    try { execSync('"' + localPath + '" --version', { timeout: 5000 }); YTDLP_PATH = localPath; console.log('[Init] yt-dlp found at ' + localPath); return; } catch {}
  }
  // Check 3: /tmp (runtime download)
  const tmpPath = '/tmp/yt-dlp';
  if (fs.existsSync(tmpPath)) {
    try { execSync('"' + tmpPath + '" --version', { timeout: 5000 }); YTDLP_PATH = tmpPath; console.log('[Init] yt-dlp found at /tmp/yt-dlp'); return; } catch {}
  }
  // Not found — download it to project dir (persists across restarts on Render)
  console.log('[Init] yt-dlp not found, downloading...');
  try {
    const https = require('https');
    const url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
    const file = fs.createWriteStream(localPath);
    await new Promise((resolve, reject) => {
      https.get(url, { timeout: 60000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          https.get(res.headers.location, { timeout: 60000 }, (res2) => res2.pipe(file)).on('error', reject);
          return;
        }
        res.pipe(file);
      }).on('error', reject);
      file.on('finish', () => { file.close(); resolve(); });
    });
    fs.chmodSync(localPath, 0o755);
    YTDLP_PATH = localPath;
    console.log('[Init] yt-dlp downloaded to ' + localPath);
  } catch (e) {
    console.log('[Init] yt-dlp download failed: ' + e.message + ' — METHOD 7 will be unavailable');
  }
}
ensureYtDlp(); // run at startup


// ═══════════════════════════════════════════════════════════════
//  SECTION 2: CONFIGURATION
// ═══════════════════════════════════════════════════════════════
const VERSION = '17.0';
const ADMIN = '263777627210';
const AUTH_FOLDER = 'auth_info';
const PORT = process.env.PORT || 10000;
const MAX_RAM_MB = 512;
const RAM_ABORT_PCT = 80;
const MAX_MEDIA_MB = 20;
const GROUP_AUDIO_MAX_MB = 8;
const DL_TIMEOUT = 120000;
const TASK_TIMEOUT = 180000;
const WEATHER_KEY = '50ccfd9cde049c4e20ba75923f25f2a5';
const CITY = 'Harare';

// Exact group invite codes from admin
const GROUP_INVITES = {
  music: 'BZctjb1BYYG8abO1I0RlXd',
  movies: 'IkmEipLjNjP6VmhNmJdvGS'
};
const GROUP_LABELS = { music: 'MUSIC', movies: 'MOVIES' };
const BLOCKED_NUMBERS = ['64226434709'];

// Invidious instances (v18: refreshed + dynamic fetch at startup)
let INVIDIOUS_INSTANCES = [
  'https://invidious.nerdvpn.de',
  'https://invidious.fdn.fr',
  'https://inv.nadeko.net',
  'https://yt.drgnz.club',
  'https://invidious.materialio.us',
  'https://invidious.jing.rocks',
  'https://iv.datura.network',
  'https://invidious.protokolla.fi',
  'https://invidious.privacyredirect.com',
  'https://iv.ggtyler.dev'
];
// v18: Dynamically fetch fresh Invidious instances at startup
async function refreshInvidiousInstances() {
  try {
    const data = await httpGet('https://api.invidious.io/instances.json', { timeout: 10000 });
    if (!Array.isArray(data)) return;
    const working = data
      .filter(i => i[1]?.type === 'https' && i[1]?.api && !i[1]?.stats?.error)
      .sort((a, b) => (b[1]?.stats?.usage?.users?.total || 0) - (a[1]?.stats?.usage?.users?.total || 0))
      .slice(0, 15)
      .map(i => 'https://' + i[1]?.uri);
    if (working.length >= 3) { INVIDIOUS_INSTANCES = working; console.log('[Init] Invidious: ' + working.length + ' dynamic instances loaded'); }
  } catch (e) { console.log('[Init] Invidious dynamic fetch failed, using hardcoded list'); }
}
setTimeout(() => refreshInvidiousInstances(), 5000);

// Piped instances (v18: refreshed + dynamic fetch at startup)
let PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.adminforge.de',
  'https://pipedapi.r4fo.com',
  'https://api.piped.projectsegfau.lt',
  'https://pipedapi.in.projectsegfau.lt',
  'https://piped-api.privacy.com.de',
  'https://pipedapi.leptons.xyz',
  'https://api.piped.yt'
];
// v18: Dynamically fetch fresh Piped instances at startup
async function refreshPipedInstances() {
  try {
    const data = await httpGet('https://piped-instances.kavin.rocks/', { timeout: 10000 });
    if (!Array.isArray(data)) return;
    const working = data
      .filter(i => i?.api_url && i?.status === 200 && i?.cdn_rotation === undefined)
      .sort((a, b) => (b?.usage?.users || 0) - (a?.usage?.users || 0))
      .slice(0, 15)
      .map(i => i.api_url.replace(/\/$/, ''));
    if (working.length >= 3) { PIPED_INSTANCES = working; console.log('[Init] Piped: ' + working.length + ' dynamic instances loaded'); }
  } catch (e) { console.log('[Init] Piped dynamic fetch failed, using hardcoded list'); }
}
setTimeout(() => refreshPipedInstances(), 7000);

// Cobalt instance for social media (Instagram, TikTok, Twitter)
const COBALT_URL = process.env.COBALT_URL || 'https://api.cobalt.tools';

// ═══ AI CONFIGURATION — All AIs available in both groups + inbox ═══
const AI_CONFIG = {
  aion: {
    name: 'Aion', baseUrl: 'https://api.aionlabs.ai/v1',
    apiKey: 'alv2_V9-XG4wlj5e52dDf6JvyuCN6aMHvK78o8hxfIvhfojI', model: 'aion-labs/aion-3.0-mini',
    mode: 'both', desc: 'Aion Labs AI — primary group manager'
  },
  dadgpt: {
    name: 'DadGPT', baseUrl: 'https://www.dadgpt.live/v1',
    apiKey: process.env.DADGPT_API_KEY || '', model: 'dadgpt-default',
    mode: 'both', desc: 'General AI chat'
  },
  groq: {
    name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1',
    apiKey: process.env.GROQ_API_KEY || '', model: 'llama-3.3-70b-versatile',
    mode: 'both', desc: 'Fast AI — group replies + decisions'
  },
  zai: {
    name: 'Zai', baseUrl: 'https://api.zai.chat/v1',
    apiKey: process.env.ZAI_API_KEY || '', model: 'default',
    mode: 'both', desc: 'Zai AI — group interaction'
  },
  uncensored: {
    name: 'Uncensored AI',
    baseUrl: process.env.UNCENSORED_API_URL || '',
    apiKey: process.env.UNCENSORED_API_KEY || '', model: 'default',
    mode: 'both', desc: 'Uncensored AI chat'
  }
};

// AI routing: which AI for which purpose
const AI_ROUTES = {
  group_reply: ['aion', 'groq', 'zai'],        // Shallow group replies to members
  group_decision: ['aion', 'groq'],               // Content posting decisions
  inbox_chat: ['dadgpt', 'uncensored', 'aion'],   // Deep inbox conversations
  member_benefit: ['dadgpt', 'aion', 'groq', 'zai'] // Member benefit AIs
};

// NSFW for members
const NSFW_API_URL = process.env.NSFW_API_URL || '';
const XNXX_API_URL = process.env.XNXX_API_URL || '';
const TRANSLATE_ENABLED = true;
const WEB_SEARCH_ENABLED = true;

// ═══════════════════════════════════════════════════════════════
//  SECTION 3: MUSIC & TV DATA
// ═══════════════════════════════════════════════════════════════
const MUSIC_GENRES = {
  amapiano: ['amapiano 2025 new','amapiano mix 2025','south african amapiano','amapiano zim','zim amapiano 2025'],
  dancehall: ['zim dancehall 2025','jah prayzah 2025','winky d 2025 new','zimdancehall mix','shona dancehall'],
  afrobeats: ['afrobeats 2025 new','afrobeats mix','burna boy 2025','wizkid 2025'],
  rnb: ['R&B 2025 new','afro R&B slow','rnb slow jams 2025'],
  slowjams: ['slow jams 2025','rnb slow jams mix','emotional songs 2025'],
  afropop: ['afropop 2025','african pop music','afropop hits'],
  gqom: ['gqom 2025','gqom mix','south african gqom'],
  hiphop: ['hip hop 2025','rap new releases','hip hop hits'],
  zim_classics: ['zimbabwe music classics','zim old school hits','oliver mtukudzi','thomas mapfumo','zim classics mix'],
  gospel: ['zim gospel 2025','shona gospel songs','gospel music zimbabwe'],
  love_songs: ['love songs 2025','romantic songs mix','african love songs'],
  throwbacks_2k: ['2000s throwback songs','2000s rnb hits','2000s music mix','y2k throwback'],
  pop: ['pop music 2025','top pop hits','pop mix 2025'],
  trap: ['trap music 2025','afro trap','trap beats'],
  lofi: ['lofi hip hop','lofi beats','chill lofi mix'],
  soul: ['soul music 2025','neo soul','classic soul hits']
};
const MUSIC_VIDEO_QUERIES = {
  amapiano: ['amapiano music video 2025 short','amapiano visualizer'],
  afrobeats: ['afrobeats music video 2025','afrobeats official video short'],
  dancehall: ['dancehall music video 2025','zim dancehall video'],
  rnb: ['rnb music video 2025','rnb official video'],
  pop: ['pop music video 2025','official music video short'],
  zim_classics: ['oliver mtukudzi video','zim classic music video']
};
const PLAYLIST_QUERIES = {
  top_zim_songs: ['top zimbabwe songs 2025','zim hits 2025 mix'],
  love_songs: ['african love songs mix','love songs 2025 playlist'],
  amapiano: ['amapiano 2025 mix','amapiano playlist'],
  '2k_throwbacks': ['2000s throwback mix','y2k hits playlist']
};

const MOVIES_PROGRAMMING_BLOCKS = {
  morning_laughs: { name: 'Morning Laughs', hours: [5,6,7,8], theme: 'Light comedy', categories: ['zim_skits','memes'], caption_style: 'energetic_morning' },
  comedy_central: { name: 'Comedy Central ZW', hours: [9,10,11], theme: 'Pure Zim comedy', categories: ['zim_skits','zim_creators'], caption_style: 'comedy_focus' },
  viral_hour: { name: 'Viral Hour', hours: [12,13,14], theme: 'Trending content', categories: ['funny_videos','dance'], caption_style: 'hype' },
  afternoon_binge: { name: 'Afternoon Binge', hours: [15,16,17], theme: 'Skit compilations', categories: ['zim_skits','zim_creators','funny_videos'], caption_style: 'binge' },
  prime_time: { name: 'Prime Time', hours: [18,19,20], theme: 'Best new releases', categories: ['zim_skits','zim_creators','dance'], caption_style: 'premium' },
  late_night: { name: 'Late Night Laughs', hours: [21,22,23], theme: 'Funny compilations', categories: ['memes','funny_videos'], caption_style: 'late_night' },
  replay: { name: 'Best Of Replay', hours: [0,1,2,3,4], theme: 'Replaying best', categories: ['zim_skits','funny_videos','dance'], caption_style: 'chill' }
};
const MOVIES_QUERIES = {
  zim_skits: ['zim skits 2025','zimbabwe comedy skits','zim funny videos','mad boss skits','ntando testimony skits'],
  funny_videos: ['funny videos 2025','african funny videos','comedy videos compilation','try not to laugh'],
  dance: ['african dance videos','dance challenge 2025','zim dance videos','amapiano dance challenge'],
  memes: ['meme videos 2025','funny memes compilation','tiktok funny videos'],
  zim_creators: ['zim content creators','zimbabwe youtubers','zim comedy 2025','zim viral videos','mad boss new','gonyeti','naakmusiq zim']
};
const ZIM_ARTISTS = ['Jah Prayzah','Winky D','Oliver Mtukudzi','Thomas Mapfumo','Sulumani Chimbetu','Alick Macheso','Soul Musaka','ExQ','Takura','Holy Ten','Michael Magenga','Baba Harare','Kae Chaps','Rutope','Nutty O','Feli Nandi','Mbeu','Hwinza','Shopy','Brythreesixty','Ti Gonzi','Killer T','Freeman HKD','Mechanic Manyeruke'];

// ═══════════════════════════════════════════════════════════════
//  SECTION 4: STATE
// ═══════════════════════════════════════════════════════════════
let sock = null, qrCodeData = null, connectionStatus = 'disconnected', isAdminOnline = false;
// v16.1 FIX: Hard-coded admin LID — bot is hosted on another device so phone JID won't resolve
// Admin phone: 263777627210 | Admin LID from logs: 115110005706891@lid
const recentMessages = [], MAX_FEED = 200;
const broadcasts = new Map();
let broadcastIdCounter = 1;
const knownGroups = new Set();
const groupMembers = new Map();       // groupJid -> Set of full JIDs (as-is from WhatsApp)
const lidToPhone = new Map();          // bareLid -> phoneJid
const groupAdmins = new Map();       // groupJid -> Set of admin full JIDs (from groupMetadata.participants[].admin)
const groupActivity = new Map();
const messageStore = new Map();
const msgRetryCounterCache = new NodeCache();
const logger = pino({ level: 'info' });
let weatherCache = { data: null, fetchedAt: 0 };
const genreRotation = { music: '', movies: '' };
const recentPostHashes = [], recentPostHashesSet = new Set(), recentPostTitles = new Set();
const MAX_HASHES = 500;
const groupPaused = { music: false, movies: false };
let lastGroupShare = 0, botStartTime = Date.now();
let scheduleSlots = [], testRunning = false, testCompleted = false;
const pendingDownloads = new Map();
const targetGroups = { music: null, movies: null };
let morningTutorialSent = false;
const downloadHistory = new Map();
const downloadFallbacks = new Map();
let lastKeepAlivePing = 0, onlineMsgSent = false, reconnectAttempts = 0, lastConnectedAt = 0;
let ADMIN_LID_JID = '115110005706891@lid'; // v16.1 FIX: Hard-coded — was null, causing admin detection failure on remote host
const ADMIN_LID_FILE = path.join(__dirname, 'admin_lid.json');
function loadAdminLid() {
  try {
    if (fs.existsSync(ADMIN_LID_FILE)) {
      const data = JSON.parse(fs.readFileSync(ADMIN_LID_FILE, 'utf8'));
      if (data.jid) {
        ADMIN_LID_JID = data.jid;
        if (data.lidToPhone) { for (const [k, v] of Object.entries(data.lidToPhone)) { lidToPhone.set(k, v); } }
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
const msgRateLimiter = new Map();
const MSG_RATE_PER_USER = 5, MSG_RATE_WINDOW = 30000;
let schedTickInterval = null;
let groupDlMethod = 6; // 1=ytdl, 2=play-dl, 3=Invidious, 4=Piped, 5=Cobalt, 6=Smart (default: cascade all)
const aiSessions = new Map();
const aiSelections = new Map();
const nsfwSelections = new Map();
const groupAiReplyCooldown = new Map();
const GROUP_AI_COOLDOWN_MS = 45000; // 45s between AI replies per group (reduced from 2min)
const memberJoinTimestamps = new Map();
const memberLeftSet = new Set();
let translationCount = 0;
const TRANSLATE_RATE_LIMIT = 30;
let translationHourStart = Date.now();
const fileConfirmations = new Map(); // bareJid -> { title, timestamp }
const aiHealthCache = { results: null, fetchedAt: 0, TTL: 300000 };
const groupMetadataCache = new NodeCache({ stdTTL: 300, useClones: false }); // v13: 5-min cache — official Baileys recommendation to avoid rate bans

// ═══════════════════════════════════════════════════════════════
//  SECTION 5: RAM MONITOR
// ═══════════════════════════════════════════════════════════════
function getRamMB() { try { return Math.round(process.memoryUsage().heapUsed / 1024 / 1024); } catch { return 0; } }
function isRamSafe() { return getRamMB() < (MAX_RAM_MB * RAM_ABORT_PCT / 100); }
function logRam(tag) { const mb = getRamMB(); console.log('[' + (tag||'RAM') + '] ' + mb + 'MB / ' + MAX_RAM_MB + 'MB (' + Math.round(mb/MAX_RAM_MB*100) + '%)'); }

// ═══════════════════════════════════════════════════════════════
//  SECTION 6: TASK QUEUE
// ═══════════════════════════════════════════════════════════════
let taskQueueRunning = false, currentTaskName = '', taskQueue = [];
async function enqueueTask(name, fn) {
  return new Promise((resolve, reject) => { taskQueue.push({ name, fn, resolve, reject }); processQueue(); });
}
async function processQueue() {
  if (taskQueueRunning || taskQueue.length === 0) return;
  taskQueueRunning = true;
  const task = taskQueue.shift(); currentTaskName = task.name; logRam('TASK[' + task.name + ']');
  if (!isRamSafe()) { console.log('[TASK] Aborted ' + task.name + ' - RAM'); taskQueueRunning = false; currentTaskName = ''; task.reject(new Error('RAM_ABORT')); if (taskQueue.length > 0) setImmediate(processQueue); return; }
  const timer = setTimeout(() => { console.log('[TASK] Timeout: ' + task.name); taskQueueRunning = false; currentTaskName = ''; task.reject(new Error('TASK_TIMEOUT')); if (taskQueue.length > 0) setImmediate(processQueue); }, TASK_TIMEOUT);
  try { const result = await task.fn(); clearTimeout(timer); task.resolve(result); }
  catch (err) { clearTimeout(timer); task.reject(err); }
  logRam('TASK_END[' + task.name + ']'); taskQueueRunning = false; currentTaskName = '';
  if (taskQueue.length > 0) setImmediate(processQueue);
}
function queueSize() { return taskQueue.length + (taskQueueRunning ? 1 : 0); }
function isBotBusy() { return taskQueueRunning || taskQueue.length > 2; }

// ═══════════════════════════════════════════════════════════════
//  SECTION 7: UTILITIES
// ═══════════════════════════════════════════════════════════════
function toBare(jid) {
  if (!jid) return '';
  return jid.split(':')[0].replace('@s.whatsapp.net','').replace('@g.us','').replace('@lid','').replace('@newsletter','').replace('@broadcast','');
}

// Extract YouTube video ID from URL
function ytVideoId(url) {
  const m = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

// ═══ v14.1 ADMIN DETECTION — Back to v11 simple approach + 3 LID discovery methods ═══
// v11 approach (synchronous, no metadata): direct match, senderPn, lidToPhone map
// Problem: In LID groups, senderPn=undefined, participant=@lid, lidToPhone stays empty
// v14.1 adds 3 ways to populate the LID map so v11's logic can work:
//   1. onWhatsApp() on connect → tries to get admin's actual JID
//   2. DM auto-capture → when admin DMs bot, store ALL their JIDs
//   3. !iamadmin command → admin registers their group LID manually

// Resolve admin phone to LID using onWhatsApp()
// Baileys v6.7.24 source: onWhatsApp returns { jid: id, exists: contact, lid }
// where id = phone JID, lid = LID hex. THE BUG was using r.jid instead of r.lid.
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
  } catch (e) {
    console.error('[AdminLid] onWhatsApp error:', e.message);
  }
}


// v14.1: Simple synchronous isAdmin — same logic as your v11 + LID match
// This is SYNCHRONOUS like v11 (no async/await needed for message processing)
function isAdmin(jid, msg) {
  if (!jid) return false;
  // DM: remoteJid is phone@s.whatsapp.net → direct match
  if (!isGroup(jid)) {
    // v16.1 FIX: Also match by LID in DMs (bot hosted on another device — sender may appear as @lid)
    const dmBare = toBare(jid);
    if (dmBare === ADMIN || dmBare === '115110005706891' || jid === ADMIN_LID_JID) {
      // DM from admin — capture ALL their JIDs for group matching later
      captureAdminJid(jid, msg);
      return true;
    }
    return false;
  }
  // Group checks
  const participant = msg?.key?.participant;
  // 1. Direct phone JID participant (non-LID groups)
  if (participant && toBare(participant) === ADMIN) return true;
  // 2. LID direct match (if we resolved admin's LID via onWhatsApp or !iamadmin)
  if (ADMIN_LID_JID && participant === ADMIN_LID_JID) {
    console.log('[Admin] LID-Direct');
    return true;
  }
  // 3. lidToPhone map (built from senderPn, onWhatsApp, or DM capture)
  if (participant?.endsWith('@lid')) {
    const mapped = lidToPhone.get(toBare(participant));
    if (mapped && toBare(mapped) === ADMIN) { console.log('[Admin] LID-Map'); return true; }
  }
  // 4. senderPn field (v6.7.19+, your v11 approach — works when WhatsApp sends it)
  if (msg?.key?.senderPn) {
    const pn = msg.key.senderPn.split(':')[0];
    if (pn === ADMIN) { console.log('[Admin] senderPn'); return true; }
  }
  // 5. participantPn (alternative to senderPn)
  if (msg?.key?.participantPn) {
    const pn = msg.key.participantPn.split(':')[0];
    if (pn === ADMIN) { console.log('[Admin] participantPn'); return true; }
  }
  // 6. Check captured admin JIDs from DMs
  if (participant && capturedAdminJids.has(participant)) { console.log('[Admin] CapturedDM'); return true; }
  return false;
}

// v14.1: When admin DMs the bot, capture ALL their JIDs so we can match in groups
const capturedAdminJids = new Set();
function captureAdminJid(dmJid, msg) {
  capturedAdminJids.add(dmJid);
  // If DM has a participant field (might be LID), capture it too
  if (msg?.key?.participant) capturedAdminJids.add(msg.key.participant);
  // If DM remoteJid is different from participant, capture both
  const ppn = msg?.key?.participantPn || msg?.key?.senderPn;
  if (ppn) capturedAdminJids.add(ppn);
  if (capturedAdminJids.size > 0) {
    console.log('[AdminCapture] Admin DM detected. Captured ' + capturedAdminJids.size + ' JIDs:');
    for (const j of capturedAdminJids) console.log('[AdminCapture]   ' + j);
  }
}

// v13: Check if a JID is admin of a specific group (uses cached metadata)
function isGroupAdmin(groupJid, participantJid, msg) {
  if (!participantJid) return false;
  const meta = groupMetadataCache.get(groupJid);
  if (!meta?.participants) return false;
  const ppn = msg?.key?.participantPn || msg?.key?.senderPn;
  for (const p of meta.participants) {
    // FIX: Check booleans too (same as isAdmin)
    const isAdm = p.admin === 'admin' || p.admin === 'superadmin' || p.isAdmin === true || p.isSuperAdmin === true;
    if (!isAdm) continue;
    if (p.id === participantJid) return true;
    // FIX: p.jid not p.phoneNumber (v6.7.24)
    if (ppn && (p.id === ppn || (p.jid && p.jid === ppn))) return true;
  }
  return false;
}

// v13: Get the JID to reply to. participantPn (v6.7.19+) is the reliable phone JID.
function getReplyJid(msg) {
  const sender = msg.key?.remoteJid;
  // For DMs: use participantPn if available (handles LID DMs)
  if (!isGroup(sender)) {
    const ppn = msg?.key?.participantPn || msg?.key?.senderPn;
    if (ppn) return ppn;
  }
  return sender;
}

// v13: Get phone JID for a participant. Uses participantPn (v6.7.19+) as primary source.
// onWhatsApp() removed — it does NOT work with LIDs (GitHub #1522)
function resolvePhoneJid(participantJid, msg) {
  if (!participantJid) return null;
  // Already a phone JID
  if (participantJid.endsWith('@s.whatsapp.net')) return participantJid;
  // v13: Use participantPn from message key (most reliable, v6.7.19+)
  const ppn = msg?.key?.participantPn || msg?.key?.senderPn;
  if (ppn && ppn.endsWith('@s.whatsapp.net')) return ppn;
  // Check lidToPhone map (built from participantPn/senderPn on every incoming message)
  const bare = toBare(participantJid);
  const mapped = lidToPhone.get(bare);
  if (mapped && mapped.endsWith('@s.whatsapp.net')) return mapped;
  // Try direct bare + @s.whatsapp.net (works if WhatsApp gave us the phone directly)
  if (bare.length > 8 && bare.match(/^\d+$/)) return bare + '@s.whatsapp.net';
  return participantJid; // fallback to original (WhatsApp can still send to @lid)
}

function isGroup(jid) { return jid && jid.endsWith('@g.us'); }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function cleanTmp() {
  try { const files = fs.readdirSync('/tmp').filter(f => f.startsWith('wabot_')); files.forEach(f => { try { fs.unlinkSync(path.join('/tmp', f)); } catch {} }); if (files.length) console.log('[Clean] ' + files.length + ' temp files'); } catch {}
}

function httpPost(url, body, headers) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const mod = urlObj.protocol === 'https:' ? https : http;
    const postData = typeof body === 'string' ? body : JSON.stringify(body);
    const opts = { hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData), ...(headers || {}) } };
    const req = mod.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { if (res.statusCode >= 200 && res.statusCode < 300) { try { resolve(JSON.parse(data)); } catch { resolve(data); } } else reject(new Error('HTTP ' + res.statusCode + ': ' + data.substring(0, 200))); });
    });
    req.on('error', reject); req.setTimeout(30000, () => { req.destroy(); reject(new Error('HTTP_TIMEOUT')); }); req.write(postData); req.end();
  });
}
function httpGet(url, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { if (res.statusCode >= 200 && res.statusCode < 300) { try { resolve(JSON.parse(data)); } catch { resolve(data); } } else reject(new Error('HTTP ' + res.statusCode)); });
    });
    req.on('error', reject); req.setTimeout(15000, () => { req.destroy(); reject(new Error('HTTP_TIMEOUT')); });
  });
}
function httpGetBuffer(url, timeoutMs) {
  timeoutMs = timeoutMs || DL_TIMEOUT;
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: timeoutMs }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.destroy();
        const loc = res.headers.location;
        if (!loc.startsWith('http')) { reject(new Error('BAD_REDIRECT')); return; }
        httpGetBuffer(loc, timeoutMs).then(resolve).catch(reject); return;
      }
      if (res.statusCode !== 200) { res.destroy(); reject(new Error('HTTP ' + res.statusCode)); return; }
      const chunks = []; let size = 0;
      res.on('data', c => { chunks.push(c); size += c.length; });
      res.on('end', () => { const buf = Buffer.concat(chunks); resolve({ buffer: buf, size, mimetype: res.headers['content-type'] || '' }); });
      res.on('error', reject);
    });
    req.on('error', reject); req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('HTTP_TIMEOUT')); });
  });
}

// ═══════════════════════════════════════════════════════════════
//  SECTION 8: DUPLICATE CHECKER
// ═══════════════════════════════════════════════════════════════
function contentHash(text) { if (!text) return ''; return (typeof text === 'string' ? text : JSON.stringify(text)).substring(0, 200).trim().toLowerCase().replace(/\s+/g, ' '); }
function isDuplicate(content) { const h = contentHash(typeof content === 'string' ? content : content.text || content.caption || ''); return h ? recentPostHashesSet.has(h) : false; }
function isTitleDuplicate(title) { return title ? recentPostTitles.has(title.trim().toLowerCase().substring(0, 80)) : false; }
function recordPost(content, title) {
  const h = contentHash(typeof content === 'string' ? content : content.text || content.caption || '');
  if (h && !recentPostHashesSet.has(h)) { recentPostHashes.push(h); recentPostHashesSet.add(h); while (recentPostHashes.length > MAX_HASHES) { const r = recentPostHashes.shift(); recentPostHashesSet.delete(r); } }
  if (title) { const t = title.trim().toLowerCase().substring(0, 80); recentPostTitles.add(t); while (recentPostTitles.size > MAX_HASHES) { const f = recentPostTitles.values().next().value; if (f) recentPostTitles.delete(f); } }
}

// ═══════════════════════════════════════════════════════════════
//  SECTION 9: WEATHER
// ═══════════════════════════════════════════════════════════════
async function fetchWeather() {
  if (weatherCache.data && (Date.now() - weatherCache.fetchedAt) < 3 * 3600000) return weatherCache.data;
  try { const data = await httpGet('https://wttr.in/' + encodeURIComponent(CITY) + '?format=j1'); const cur = data?.current_condition?.[0]; if (cur) { const w = { weather: [{ id: parseInt(cur.weatherCode) || 800, description: cur.weatherDesc?.[0]?.value || 'clear', main: 'clear' }], main: { temp: parseInt(cur.temp_C) || 25, humidity: parseInt(cur.humidity) || 50 } }; weatherCache = { data: w, fetchedAt: Date.now() }; return w; } } catch {}
  try { const data = await httpGet('https://api.openweathermap.org/data/2.5/weather?q=' + CITY + '&appid=' + WEATHER_KEY + '&units=metric'); if (data?.weather) { weatherCache = { data, fetchedAt: Date.now() }; return data; } } catch {}
  return weatherCache.data || { weather: [{ id: 800, description: 'clear' }], main: { temp: 25 } };
}
function getMood(weather) {
  if (!weather?.weather?.[0]) return 'chill';
  const code = weather.weather[0].id, temp = weather.main?.temp || 25;
  if (code >= 200 && code < 300) return 'intense';
  if (code >= 300 && code < 600) return 'sad';
  if (code >= 600 && code < 800) return 'cozy';
  if (code === 800) return temp > 25 ? 'hype' : 'chill';
  return 'reflective';
}

// ═══════════════════════════════════════════════════════════════
//  SECTION 10: MEME APIs
// ═══════════════════════════════════════════════════════════════
async function fetchRandomMeme() { try { const d = await httpGet('https://justmeme.wtf/api/v1/random'); return d?.template?.url || null; } catch { return null; } }
async function fetchTrendingMeme() { try { const d = await httpGet('https://justmeme.wtf/api/v1/trending'); if (d?.trending?.length) return d.trending[randInt(0, Math.min(d.trending.length - 1, 9))].url || null; return null; } catch { return null; } }

// ═══════════════════════════════════════════════════════════════
//  SECTION 11: YOUTUBE SEARCH
// ═══════════════════════════════════════════════════════════════
async function ytSearch(query) { try { const r = await yts(query); return r.videos?.length ? r.videos : []; } catch (e) { console.error('[YT] Search failed:', e.message); return []; } }

// ═══════════════════════════════════════════════════════════════
//  SECTION 12: DOWNLOAD ENGINES (5 Methods + Smart Cascade)
// ═══════════════════════════════════════════════════════════════

// METHOD 1: ytdl-core (v15: fixed 410 with consent cookie + better headers)
async function dlYtdl(url, type, maxMB) {
  const ext = type === 'audio' ? 'opus' : 'mp4';
  const tmpFile = path.join('/tmp', 'wabot_' + Date.now() + '.' + ext);
  return new Promise((resolve, reject) => {
    if (!isRamSafe()) return reject(new Error('RAM_ABORT'));
    const opts = type === 'audio' ? { filter: 'audioonly', quality: 'highestaudio' } : { filter: 'videoandaudio', quality: 'lowest' };
    const stream = ytdl(url, { ...opts, requestOptions: { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', 'Cookie': 'CONSENT=YES+1; VISITOR_INFO1_LIVE=; YSC=', 'Accept-Language': 'en-US,en;q=0.9' } } });
    const ws = fs.createWriteStream(tmpFile); let settled = false;
    const done = (err, val) => { if (!settled) { settled = true; if (err) { try { fs.unlinkSync(tmpFile); } catch {} reject(err); } else resolve(val); } };
    stream.pipe(ws);
    stream.on('progress', (_, dl) => { if (dl > maxMB * 1024 * 1024) { stream.destroy(); ws.destroy(); done(new Error('SIZE_LIMIT')); } if (!isRamSafe()) { stream.destroy(); ws.destroy(); done(new Error('RAM_ABORT')); } });
    ws.on('finish', () => { try { const s = fs.statSync(tmpFile); if (s.size > maxMB * 1024 * 1024) { done(new Error('SIZE_LIMIT')); return; } if (s.size < 10000) { done(new Error('FILE_TOO_SMALL')); return; } done({ file: tmpFile, size: s.size }); } catch (e) { done(e); } });
    stream.on('error', e => done(e)); ws.on('error', e => done(e));
    setTimeout(() => { if (!settled) { stream.destroy(); ws.destroy(); done(new Error('DL_TIMEOUT')); } }, DL_TIMEOUT);
  });
}

// METHOD 2: play-dl (fallback)
async function dlPlayDl(url, type, maxMB) {
  if (!playdl) throw new Error('play-dl not available');
  if (!isRamSafe()) throw new Error('RAM_ABORT');
  const ext = type === 'audio' ? 'webm' : 'mp4';
  const tmpFile = path.join('/tmp', 'wabot_pd_' + Date.now() + '.' + ext);
  let resolved = false;
  try {
    let stream;
    if (type === 'audio') { stream = await playdl.stream(url, { quality: 0 }); if (!stream?.audio) throw new Error('No audio stream'); }
    else { stream = await playdl.stream(url, { quality: 144 }); if (!stream) throw new Error('No video stream'); }
    const srcStream = type === 'audio' ? stream.audio : stream;
    const ws = fs.createWriteStream(tmpFile); let downloaded = 0;
    const cleanup = () => { if (resolved) return; resolved = true; try { srcStream.destroy(); } catch {} try { ws.destroy(); } catch {} try { fs.unlinkSync(tmpFile); } catch {} };
    return new Promise((resolve, reject) => {
      srcStream.on('data', (chunk) => { downloaded += chunk.length; if (downloaded > maxMB * 1024 * 1024) { cleanup(); reject(new Error('SIZE_LIMIT')); } if (!isRamSafe()) { cleanup(); reject(new Error('RAM_ABORT')); } });
      srcStream.pipe(ws);
      ws.on('finish', () => { resolved = true; try { const s = fs.statSync(tmpFile); if (s.size > maxMB * 1024 * 1024 || s.size < 10000) { fs.unlinkSync(tmpFile); reject(s.size < 10000 ? new Error('FILE_TOO_SMALL') : new Error('SIZE_LIMIT')); return; } resolve({ file: tmpFile, size: s.size }); } catch (e) { reject(e); } });
      srcStream.on('error', e => { cleanup(); reject(e); }); ws.on('error', e => { cleanup(); reject(e); });
      setTimeout(() => { if (!resolved) { cleanup(); reject(new Error('DL_TIMEOUT')); } }, DL_TIMEOUT);
    });
  } catch (e) { try { fs.unlinkSync(tmpFile); } catch {} throw e; }
}

// METHOD 3: Invidious API (v15: uses PROXY endpoint so download goes through Invidious, not Google)
async function dlInvidious(url, type, maxMB) {
  const videoId = ytVideoId(url);
  if (!videoId) throw new Error('Not a YouTube URL');
  for (const instance of INVIDIOUS_INSTANCES) {
    try {
      const data = await httpGet(instance + '/api/v1/videos/' + videoId, { timeout: 10000 });
      if (!data || !data.adaptiveFormats) continue;
      let itag = null, ext = 'm4a';
      if (type === 'audio') {
        const audioFormats = data.adaptiveFormats.filter(f => f.type?.startsWith('audio/')).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
        if (audioFormats.length) { itag = audioFormats[0].itag; ext = audioFormats[0].container || 'm4a'; }
      } else {
        const vidFormats = data.formatStreams?.filter(f => f.type?.startsWith('video/')).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
        if (vidFormats?.length) { itag = vidFormats[0].itag; ext = 'mp4'; }
      }
      if (!itag) continue;
      // v15: Use Invidious proxy (download through Invidious server, NOT Google directly)
      const proxyUrl = instance + '/latest_version?id=' + videoId + '&itag=' + itag + '&local=true';
      console.log('[Invidious] Trying proxy: ' + instance + ' itag=' + itag);
      const result = await httpGetBuffer(proxyUrl, DL_TIMEOUT);
      if (result.size > maxMB * 1024 * 1024) throw new Error('SIZE_LIMIT');
      if (result.size < 10000) throw new Error('FILE_TOO_SMALL');
      const tmpFile = path.join('/tmp', 'wabot_inv_' + Date.now() + '.' + ext);
      fs.writeFileSync(tmpFile, result.buffer);
      return { file: tmpFile, size: result.size };
    } catch (e) { console.log('[Invidious] ' + instance + ' failed: ' + e.message); continue; }
  }
  throw new Error('All Invidious instances failed');
}

// METHOD 4: Piped API (v15: prefers proxyUrl to avoid Google blocks)
async function dlPiped(url, type, maxMB) {
  const videoId = ytVideoId(url);
  if (!videoId) throw new Error('Not a YouTube URL');
  for (const instance of PIPED_INSTANCES) {
    try {
      const data = await httpGet(instance + '/streams/' + videoId, { timeout: 10000 });
      if (!data) continue;
      let streamUrl = null, ext = 'm4a';
      if (type === 'audio') {
        const audioStreams = (data.audioStreams || []).filter(s => !s.videoOnly && (s.url || s.proxyUrl)).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
        if (audioStreams.length) {
          // v15: Prefer proxyUrl (routed through Piped proxy, not Google)
          streamUrl = audioStreams[0].proxyUrl || audioStreams[0].url;
          ext = 'm4a';
        }
      } else {
        const vidStreams = (data.videoStreams || []).filter(s => !s.videoOnly && (s.url || s.proxyUrl)).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
        if (vidStreams.length) {
          streamUrl = vidStreams[0].proxyUrl || vidStreams[0].url;
          ext = 'mp4';
        }
      }
      if (!streamUrl) continue;
      console.log('[Piped] Trying: ' + instance + ' proxy=' + (streamUrl.includes('piped') ? 'Y' : 'N'));
      const result = await httpGetBuffer(streamUrl, DL_TIMEOUT);
      if (result.size > maxMB * 1024 * 1024) throw new Error('SIZE_LIMIT');
      if (result.size < 10000) throw new Error('FILE_TOO_SMALL');
      const tmpFile = path.join('/tmp', 'wabot_piped_' + Date.now() + '.' + ext);
      fs.writeFileSync(tmpFile, result.buffer);
      return { file: tmpFile, size: result.size };
    } catch (e) { console.log('[Piped] ' + instance + ' failed: ' + e.message); continue; }
  }
  throw new Error('All Piped instances failed');
}

// METHOD 5: Cobalt API (for Instagram, TikTok, Twitter, Reddit, SoundCloud)
async function dlCobalt(url, maxMB) {
  try {
    const result = await httpPost(COBALT_URL + '/', {
      url: url,
      downloadMode: 'auto',
      audioFormat: 'mp3',
      filenameStyle: 'basic'
    }, { 'Accept': 'application/json' });
    if (result.status === 'error') throw new Error('Cobalt: ' + (result.error?.code || 'unknown error'));
    const fileUrl = result.url;
    if (!fileUrl) throw new Error('Cobalt: no file URL in response');
    const dl = await httpGetBuffer(fileUrl, DL_TIMEOUT);
    if (dl.size > maxMB * 1024 * 1024) throw new Error('SIZE_LIMIT');
    const ext = (result.filename || '').split('.').pop() || 'mp4';
    const tmpFile = path.join('/tmp', 'wabot_cobalt_' + Date.now() + '.' + ext);
    fs.writeFileSync(tmpFile, dl.buffer);
    return { file: tmpFile, size: dl.size };
  } catch (e) {
    console.log('[Cobalt] Failed: ' + e.message);
    throw e;
  }
}

// Universal URL downloader (for get <url> command)
async function downloadFromUrl(url, maxMB, _depth) {
  _depth = _depth || 0; maxMB = maxMB || MAX_MEDIA_MB;
  if (!isRamSafe()) throw new Error('RAM_ABORT');
  const parsed = new URL(url);
  const ext = path.extname(parsed.pathname).split('?')[0] || '.bin';
  const safeExt = ext.replace(/[^a-z0-9]/gi, '').substring(0, 10) || 'bin';
  const tmpFile = path.join('/tmp', 'wabot_url_' + Date.now() + '.' + safeExt);
  return new Promise((resolve, reject) => {
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.get(url, { timeout: DL_TIMEOUT }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.destroy(); safeDeleteFile(tmpFile);
        if (_depth >= 3) { reject(new Error('TOO_MANY_REDIRECTS')); return; }
        const redir = res.headers.location;
        if (!redir.startsWith('http')) { reject(new Error('INVALID_REDIRECT')); return; }
        downloadFromUrl(redir, maxMB, _depth + 1).then(resolve).catch(reject); return;
      }
      if (res.statusCode !== 200) { safeDeleteFile(tmpFile); reject(new Error('HTTP ' + res.statusCode)); return; }
      let downloaded = 0; const ws = fs.createWriteStream(tmpFile); let dlSettled = false;
      const dlReject = (err) => { if (!dlSettled) { dlSettled = true; try { res.destroy(); } catch {} try { ws.destroy(); } catch {} safeDeleteFile(tmpFile); reject(err); } };
      res.on('data', (chunk) => { downloaded += chunk.length; if (downloaded > maxMB * 1024 * 1024) dlReject(new Error('SIZE_LIMIT')); if (!isRamSafe()) dlReject(new Error('RAM_ABORT')); });
      res.pipe(ws);
      ws.on('finish', () => { try { const s = fs.statSync(tmpFile); if (s.size < 1000) { dlReject(new Error('FILE_TOO_SMALL')); return; } if (!dlSettled) { dlSettled = true; resolve({ file: tmpFile, size: s.size, mimetype: res.headers['content-type'] || '' }); } } catch (e) { dlReject(e); } });
      res.on('error', e => dlReject(e)); ws.on('error', e => dlReject(e));
    });
    req.on('error', (e) => { try { safeDeleteFile(tmpFile); } catch {} reject(e); });
    req.setTimeout(DL_TIMEOUT, () => { req.destroy(); try { safeDeleteFile(tmpFile); } catch {} reject(new Error('DL_TIMEOUT')); });
  });
}

// METHOD 7: yt-dlp — v19: uses yt-dlp-exec (auto-managed binary) with spawn fallback
// yt-dlp-exec auto-downloads the yt-dlp binary and handles YouTube/TikTok/IG/FB bot detection
async function dlYtDlp(url, type, maxMB) {
  if (!isRamSafe()) throw new Error('RAM_ABORT');
  const videoId = ytVideoId(url);
  const ext = type === 'audio' ? 'mp3' : 'mp4';
  const tmpFile = path.join('/tmp', 'wabot_ytdlp_' + Date.now() + '.' + ext);

  // v19: Try yt-dlp-exec first (auto-managed binary, more reliable)
  if (ytdlpExec) {
    try {
      const opts = {
        output: tmpFile,
        noPlaylist: true,
        maxFilesize: (maxMB * 1024 * 1024).toString(),
      };
      if (type === 'audio') {
        opts.extractAudio = true;
        opts.audioFormat = 'mp3';
        opts.audioQuality = '128K';
      } else {
        opts.format = 'worst[ext=mp4]/worstvideo[ext=mp4]+worstaudio/best[ext=mp4]';
        opts.mergeOutputFormat = 'mp4';
      }
      console.log('[DL] yt-dlp-exec downloading: ' + url.substring(0, 60));
      await ytdlpExec(url, opts);
      if (fs.existsSync(tmpFile)) {
        const s = fs.statSync(tmpFile);
        if (s.size >= 10000 && s.size <= maxMB * 1024 * 1024) {
          console.log('[DL] yt-dlp-exec OK: ' + (s.size/1024/1024).toFixed(1) + 'MB');
          return { file: tmpFile, size: s.size };
        }
        try { fs.unlinkSync(tmpFile); } catch {}
        if (s.size < 10000) throw new Error('FILE_TOO_SMALL');
        throw new Error('SIZE_LIMIT');
      }
      throw new Error('No output file');
    } catch (e) {
      console.log('[DL] yt-dlp-exec failed: ' + e.message.substring(0, 80) + ', trying spawn fallback...');
      try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch {}
    }
  }

  // Fallback: spawn yt-dlp binary (from v18 auto-install)
  if (!videoId) throw new Error('Not a YouTube URL');
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err, val) => { if (!settled) { settled = true; if (err) { try { fs.unlinkSync(tmpFile); } catch {} reject(err); } else resolve(val); } };
    const args = [
      '--no-playlist', '--max-filesize', (maxMB * 1024 * 1024).toString(),
      '-o', tmpFile,
      '--ffmpeg-location', '/usr/bin/ffmpeg',
    ];
    if (type === 'audio') {
      args.unshift('-x', '--audio-format', 'mp3', '--audio-quality', '128K');
    } else {
      args.unshift('-f', 'worst[ext=mp4]', '--merge-output-format', 'mp4');
    }
    args.push(url);
    const child = require('child_process').spawn(YTDLP_PATH, args, { timeout: DL_TIMEOUT });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('close', code => {
      if (settled) return;
      if (code === 0) {
        try {
          const s = fs.statSync(tmpFile);
          if (s.size < 10000) { done(new Error('FILE_TOO_SMALL')); return; }
          done({ file: tmpFile, size: s.size });
        } catch (e) { done(e); }
      } else {
        const msg = stderr.split('\n').filter(l => l.includes('ERROR')).pop()?.trim() || ('yt-dlp exit code ' + code);
        done(new Error(msg));
      }
    });
    child.on('error', e => done(e));
    setTimeout(() => { if (!settled) { child.kill('SIGKILL'); done(new Error('DL_TIMEOUT')); } }, DL_TIMEOUT);
  });
}

// METHOD 8: TikTok download via tikwm.com API (works from servers!)
async function dlTikTok(url, maxMB) {
  // Normalize URL (tikwm needs the full URL or short URL)
  let tikUrl = url;
  if (!url.includes('tiktok.com') && !url.includes('vm.tiktok')) throw new Error('Not a TikTok URL');
  // First resolve any short URL
  if (url.includes('vm.tiktok')) tikUrl = url; // tikwm handles short URLs fine

  const apiUrl = 'https://www.tikwm.com/api/?url=' + encodeURIComponent(tikUrl) + '&hd=1';
  const data = await httpGet(apiUrl);
  if (!data || data.code !== 0) throw new Error('tikwm: ' + (data?.msg || 'failed'));

  // Pick download URL: prefer HD play (video) or play (no watermark SD)
  const dlUrl = data.data?.play || data.data?.hdplay || data.data?.music;
  if (!dlUrl) throw new Error('tikwm: no download URL in response');

  const result = await httpGetBuffer(dlUrl, DL_TIMEOUT);
  if (result.size > maxMB * 1024 * 1024) throw new Error('SIZE_LIMIT');
  if (result.size < 10000) throw new Error('FILE_TOO_SMALL');

  const isAudio = !data.data.play && !data.data.hdplay && data.data.music;
  const ext = isAudio ? 'mp3' : 'mp4';
  const tmpFile = path.join('/tmp', 'wabot_tiktok_' + Date.now() + '.' + ext);
  fs.writeFileSync(tmpFile, result.buffer);
  return { file: tmpFile, size: result.size };
}

// METHOD 9: Instagram/Reels download via multiple public APIs (v18: no Cobalt JWT needed)
async function dlInstagram(url, maxMB) {
  if (!url.includes('instagram.com') && !url.includes('instagr.am')) throw new Error('Not an Instagram URL');

  // Attempt 1: reelsave.io API (no auth needed)
  try {
    const result = await httpPost('https://api.reelsave.io/download', { url: url }, { 'Accept': 'application/json' });
    const mediaUrl = result?.url || result?.downloadUrl || result?.data?.url;
    if (mediaUrl) {
      console.log('[IG] reelsave OK');
      const dl = await httpGetBuffer(mediaUrl, DL_TIMEOUT);
      if (dl.size > maxMB * 1024 * 1024) throw new Error('SIZE_LIMIT');
      if (dl.size < 10000) throw new Error('FILE_TOO_SMALL');
      const ext = (mediaUrl.split('.').pop() || 'mp4').split('?')[0];
      const tmpFile = path.join('/tmp', 'wabot_ig_' + Date.now() + '.' + ext);
      fs.writeFileSync(tmpFile, dl.buffer);
      return { file: tmpFile, size: dl.size };
    }
  } catch (e) { console.log('[IG] reelsave failed: ' + e.message); }

  // Attempt 2: SaveInsta API (no auth needed)
  try {
    const apiUrl = 'https://api.saveinsta.app/api/v1/media?url=' + encodeURIComponent(url);
    const result = await httpGet(apiUrl);
    const mediaUrl = result?.data?.[0]?.url || result?.url || result?.downloadUrl;
    if (mediaUrl) {
      console.log('[IG] saveinsta OK');
      const dl = await httpGetBuffer(mediaUrl, DL_TIMEOUT);
      if (dl.size > maxMB * 1024 * 1024) throw new Error('SIZE_LIMIT');
      if (dl.size < 10000) throw new Error('FILE_TOO_SMALL');
      const ext = (mediaUrl.split('.').pop() || 'mp4').split('?')[0];
      const tmpFile = path.join('/tmp', 'wabot_ig2_' + Date.now() + '.' + ext);
      fs.writeFileSync(tmpFile, dl.buffer);
      return { file: tmpFile, size: dl.size };
    }
  } catch (e) { console.log('[IG] saveinsta failed: ' + e.message); }

  // Attempt 3: Instagram oEmbed thumbnail (last resort — at least get something)
  // Try to scrape the page for the video URL
  try {
    console.log('[IG] Trying page scrape...');
    const pageData = await httpGet(url, { timeout: 10000 });
    if (typeof pageData === 'string') {
      // Look for video_url in the page source
      const videoMatch = pageData.match(/"video_url":"([^"]+)"/);
      if (videoMatch) {
        const videoUrl = videoMatch[1].replace(/\u0026/g, '&');
        console.log('[IG] Page scrape found video URL');
        const dl = await httpGetBuffer(videoUrl, DL_TIMEOUT);
        if (dl.size > maxMB * 1024 * 1024) throw new Error('SIZE_LIMIT');
        if (dl.size < 10000) throw new Error('FILE_TOO_SMALL');
        const tmpFile = path.join('/tmp', 'wabot_ig3_' + Date.now() + '.mp4');
        fs.writeFileSync(tmpFile, dl.buffer);
        return { file: tmpFile, size: dl.size };
      }
    }
  } catch (e) { console.log('[IG] Page scrape failed: ' + e.message); }

  throw new Error('All Instagram methods failed');
}

// METHOD 10: Universal social media downloader (auto-detects platform)
// v18: No Cobalt dependency — uses platform-specific APIs
async function dlSocialMedia(url, maxMB) {
  const u = url.toLowerCase();
  if (u.includes('tiktok.com') || u.includes('vm.tiktok')) return await dlTikTok(url, maxMB);
  if (u.includes('instagram.com') || u.includes('instagr.am')) return await dlInstagram(url, maxMB);
  // For Twitter/X: use fixupX API (no auth needed)
  if (u.includes('twitter.com') || u.includes('x.com')) {
    try {
      const tweetId = url.match(/(?:status|statuses)\/(\d+)/)?.[1];
      if (!tweetId) throw new Error('No tweet ID found');
      const fixupUrl = 'https://api.fixupx.com/tweet/' + tweetId;
      const result = await httpGet(fixupUrl, { timeout: 10000 });
      const mediaUrl = result?.media?.[0]?.url || result?.video?.[0]?.url;
      if (mediaUrl) {
        const dl = await httpGetBuffer(mediaUrl, DL_TIMEOUT);
        if (dl.size > maxMB * 1024 * 1024) throw new Error('SIZE_LIMIT');
        if (dl.size < 10000) throw new Error('FILE_TOO_SMALL');
        const ext = (mediaUrl.split('.').pop() || 'mp4').split('?')[0];
        const tmpFile = path.join('/tmp', 'wabot_tw_' + Date.now() + '.' + ext);
        fs.writeFileSync(tmpFile, dl.buffer);
        return { file: tmpFile, size: dl.size };
      }
    } catch (e) { console.log('[TW] fixupx failed: ' + e.message); }
    throw new Error('Twitter download failed: ' + (e?.message || 'unknown'));
  }
  // For SoundCloud/other: try direct URL download
  try { return await downloadFromUrl(url, maxMB); } catch (e) { throw new Error('Download failed: ' + e.message); }
}

// METHOD 11: Universal yt-dlp-exec downloader (from DownloaderX approach)
// Works for YouTube, TikTok, Instagram, Facebook, Twitter, Reddit, SoundCloud + 1000+ sites
// This is the v19 PRIMARY method — yt-dlp handles bot detection for all platforms
async function dlYtDlpExec(url, type, maxMB) {
  if (!ytdlpExec) throw new Error('yt-dlp-exec not available');
  if (!isRamSafe()) throw new Error('RAM_ABORT');
  const ext = type === 'audio' ? 'mp3' : 'mp4';
  const tmpFile = path.join('/tmp', 'wabot_ytdlxe_' + Date.now() + '.' + ext);
  const opts = {
    output: tmpFile,
    noPlaylist: true,
    maxFilesize: (maxMB * 1024 * 1024).toString(),
  };
  if (type === 'audio') {
    opts.extractAudio = true;
    opts.audioFormat = 'mp3';
    opts.audioQuality = '128K';
  } else {
    opts.format = 'worst[ext=mp4]/worstvideo[ext=mp4]+worstaudio/best[ext=mp4]';
    opts.mergeOutputFormat = 'mp4';
  }
  console.log('[DL] yt-dlp-exec universal: ' + url.substring(0, 80));
  await ytdlpExec(url, opts);
  if (fs.existsSync(tmpFile)) {
    const s = fs.statSync(tmpFile);
    if (s.size >= 10000 && s.size <= maxMB * 1024 * 1024) {
      console.log('[DL] yt-dlp-exec universal OK: ' + (s.size/1024/1024).toFixed(1) + 'MB');
      return { file: tmpFile, size: s.size };
    }
    try { fs.unlinkSync(tmpFile); } catch {}
    if (s.size < 10000) throw new Error('FILE_TOO_SMALL');
    throw new Error('SIZE_LIMIT');
  }
  throw new Error('yt-dlp-exec: no output file');
}

// METHOD 12: Facebook-specific download via yt-dlp-exec
async function dlFacebook(url, maxMB) {
  if (!url.includes('facebook.com') && !url.includes('fb.watch') && !url.includes('fb.com')) throw new Error('Not a Facebook URL');
  return await dlYtDlpExec(url, 'video', maxMB);
}

function safeDeleteFile(f) { try { if (f) fs.unlinkSync(f); } catch {} }

// ═══ SMART CASCADE v19: yt-dlp-exec (universal) → platform-specific → legacy fallbacks ═══
// v19 from DownloaderX: yt-dlp-exec handles YouTube, TikTok, Instagram, Facebook + 1000+ sites
// Falls back to platform-specific APIs, then legacy methods
async function smartDownload(url, type, maxMB) {
  const isYT = ytVideoId(url);
  const errors = [];
  const u = url.toLowerCase();

  // v19: UNIVERSAL — try yt-dlp-exec FIRST for ALL platforms (handles bot detection)
  // This single method covers YouTube, TikTok, Instagram, Facebook, Twitter, Reddit, etc.
  try {
    logRam('DL[yt-dlp-exec]');
    const r = await dlYtDlpExec(url, type, maxMB);
    console.log('[DL] yt-dlp-exec OK (universal): ' + (r.size/1024/1024).toFixed(1) + 'MB');
    return r;
  } catch (e) {
    errors.push('yt-dlp-exec: ' + e.message.substring(0, 80));
    console.log('[DL] yt-dlp-exec fail: ' + e.message.substring(0, 60));
  }

  // Platform-specific fallbacks (lighter weight, no binary needed)
  const u2 = u;

  // TikTok: tikwm API (fast, no binary needed)
  if (u2.includes('tiktok.com') || u2.includes('vm.tiktok')) {
    try { logRam('DL[tikwm]'); const r = await dlTikTok(url, maxMB); return r; } catch (e) { errors.push('tikwm: ' + e.message); }
    throw new Error('TikTok failed: ' + errors.join(' | '));
  }

  // Instagram: reelsave + saveinsta + page scrape
  if (u2.includes('instagram.com') || u2.includes('instagr.am')) {
    try { logRam('DL[ig]'); const r = await dlInstagram(url, maxMB); return r; } catch (e) { errors.push('instagram: ' + e.message); }
    throw new Error('Instagram failed: ' + errors.join(' | '));
  }

  // Twitter/X: fixupX
  if (u2.includes('twitter.com') || u2.includes('x.com')) {
    try { return await dlSocialMedia(url, maxMB); } catch (e) { errors.push('twitter: ' + e.message); }
    throw new Error('Twitter failed: ' + errors.join(' | '));
  }

  // YouTube-specific fallbacks (yt-dlp-exec already tried above, but try individual methods)
  if (isYT) {
    // Method 7: yt-dlp CLI (spawn fallback)
    try { logRam('DL[yt-dlp]'); const r = await dlYtDlp(url, type, maxMB); console.log('[DL] yt-dlp spawn OK'); return r; } catch (e) { errors.push('yt-dlp: ' + e.message.substring(0, 80)); }
    // Method 4: Piped (dynamically refreshed)
    try { logRam('DL[piped]'); const r = await dlPiped(url, type, maxMB); return r; } catch (e) { errors.push('Piped: ' + e.message); }
    // Method 3: Invidious (dynamically refreshed)
    try { logRam('DL[invidious]'); const r = await dlInvidious(url, type, maxMB); return r; } catch (e) { errors.push('Invidious: ' + e.message); }
    // Method 2: play-dl
    if (playdl) { try { logRam('DL[playdl]'); const r = await dlPlayDl(url, type, maxMB); return r; } catch (e) { errors.push('play-dl: ' + e.message); } }
    // Method 1: ytdl-core (last resort)
    try { logRam('DL[ytdl]'); const r = await dlYtdl(url, type, maxMB); return r; } catch (e) { errors.push('ytdl: ' + e.message); }
    throw new Error('All YouTube methods failed: ' + errors.join(' | '));
  }

  // Non-YouTube, non-social: try direct URL download
  try { const r = await downloadFromUrl(url, maxMB); return r; } catch (e) { errors.push('direct: ' + e.message); }
  throw new Error('All methods failed: ' + errors.join(' | '));
}

// Download method registry
const DOWNLOAD_METHODS = {
  1: { name: 'ytdl-core', fn: (url, type, max) => dlYtdl(url, type, max), desc: 'Standard (ytdl-core)', youtube: true },
  2: { name: 'play-dl', fn: (url, type, max) => dlPlayDl(url, type, max), desc: 'Fallback (play-dl)', youtube: true },
  3: { name: 'Invidious', fn: (url, type, max) => dlInvidious(url, type, max), desc: 'Privacy API (Invidious)', youtube: true },
  4: { name: 'Piped', fn: (url, type, max) => dlPiped(url, type, max), desc: 'Privacy API (Piped)', youtube: true },
  5: { name: 'Cobalt', fn: (url, type, max) => dlCobalt(url, max), desc: 'Multi-platform (Cobalt)', youtube: false },
  6: { name: 'Smart', fn: smartDownload, desc: 'v19: yt-dlp-exec→ALL platforms', youtube: true },
  7: { name: 'yt-dlp', fn: (url, type, max) => dlYtDlp(url, type, max), desc: 'yt-dlp-exec + spawn fallback', youtube: true },
  8: { name: 'TikTok', fn: (url, type, max) => dlTikTok(url, max), desc: 'TikTok via tikwm', youtube: false },
  9: { name: 'Instagram', fn: (url, type, max) => dlInstagram(url, max), desc: 'Instagram via reelsave+saveinsta', youtube: false },
  10: { name: 'Social', fn: (url, type, max) => dlSocialMedia(url, max), desc: 'Auto-detect: TT/IG/TW/FB', youtube: false },
  11: { name: 'yt-dlp-exec', fn: (url, type, max) => dlYtDlpExec(url, type, max), desc: 'Universal (yt-dlp-exec) ALL sites', youtube: false },
  12: { name: 'Facebook', fn: (url, type, max) => dlFacebook(url, max), desc: 'Facebook via yt-dlp-exec', youtube: false },
};

function getGroupDlFn() { return DOWNLOAD_METHODS[groupDlMethod]?.fn || smartDownload; }
function getGroupDlName() { return DOWNLOAD_METHODS[groupDlMethod]?.name || 'Smart'; }

// ════════════════════════════════════════════════════════════════════════════════════════════
//  SECTION 13: AI SYSTEM — All AIs for groups (decisions + interaction) + inbox
// ════════════════════════════════════════════════════════════════════════════════════════════

// v12: Returns 'configured', 'no_key', or 'no_url'
function getAiConfigStatus(key) {
  const c = AI_CONFIG[key];
  if (!c) return 'missing';
  if (!c.apiKey || c.apiKey === '') return 'no_key';
  if (key === 'uncensored' && (!c.baseUrl || c.baseUrl === '')) return 'no_url';
  return 'configured';
}

function isAiAvailable(key) {
  return getAiConfigStatus(key) === 'configured';
}

function getAvailableAis(mode) {
  return Object.entries(AI_CONFIG).filter(([k, c]) => isAiAvailable(k) && (c.mode === mode || c.mode === 'both')).map(([k]) => k);
}

function getAisForPurpose(purpose) {
  const keys = AI_ROUTES[purpose] || [];
  return keys.filter(k => isAiAvailable(k));
}

async function callAi(providerKey, messages, maxTokens) {
  const cfg = AI_CONFIG[providerKey];
  if (!cfg?.apiKey) throw new Error(providerKey + ' not configured');
  maxTokens = maxTokens || 1024;
  const result = await httpPost(cfg.baseUrl + '/chat/completions', {
    model: cfg.model, messages, max_tokens: maxTokens, temperature: 0.8
  }, { 'Authorization': 'Bearer ' + cfg.apiKey });
  const reply = result?.choices?.[0]?.message?.content;
  if (!reply) throw new Error('No reply from ' + providerKey);
  return reply;
}

async function callAiWithFallback(providerKey, messages, maxTokens, purpose) {
  const mode = purpose || AI_CONFIG[providerKey]?.mode || 'both';
  const routeKeys = AI_ROUTES[purpose] || getAvailableAis(mode);
  // Try requested first
  if (isAiAvailable(providerKey)) {
    try { return { reply: await callAi(providerKey, messages, maxTokens), provider: providerKey }; } catch (e) { console.log('[AI] ' + providerKey + ' failed, trying fallback...'); }
  }
  // Fallback through route
  for (const key of routeKeys) {
    if (key === providerKey) continue;
    try { return { reply: await callAi(key, messages, maxTokens), provider: key, usedFallback: true }; } catch {}
  }
  // Last resort: any available AI
  for (const key of getAvailableAis('both')) {
    try { return { reply: await callAi(key, messages, maxTokens), provider: key, usedFallback: true }; } catch {}
  }
  throw new Error('All AIs unavailable');
}

// v12: Cached AI health check (5min TTL). Shows 'no API key' vs 'offline'
async function checkAiHealth(forceRefresh) {
  if (!forceRefresh && aiHealthCache.results && (Date.now() - aiHealthCache.fetchedAt) < aiHealthCache.TTL) {
    return aiHealthCache.results;
  }
  const results = {};
  for (const [key, cfg] of Object.entries(AI_CONFIG)) {
    const status = getAiConfigStatus(key);
    if (status === 'no_key') { results[key] = { online: false, reason: 'no API key set (set ' + key.toUpperCase() + '_API_KEY env)' }; continue; }
    if (status === 'no_url') { results[key] = { online: false, reason: 'no API URL set (set ' + key.toUpperCase() + '_API_URL env)' }; continue; }
    if (status === 'missing') { results[key] = { online: false, reason: 'not defined' }; continue; }
    try {
      const start = Date.now();
      await callAi(key, [{ role: 'user', content: 'Hi' }], 10);
      results[key] = { online: true, latency: (Date.now() - start) + 'ms' };
    } catch (e) { results[key] = { online: false, reason: e.message.substring(0, 80) }; }
  }
  aiHealthCache.results = results;
  aiHealthCache.fetchedAt = Date.now();
  return results;
}

// AI Content Decider — uses AI to pick genre/content based on weather, time, mood
async function aiDecideContent(channelKey, weather) {
  const available = getAisForPurpose('group_decision');
  if (!available.length) return null;
  const provider = available[0];
  const hour = (new Date().getUTCHours() + 2) % 24;
  const mood = getMood(weather);
  const temp = weather?.main?.temp || 25;
  const desc = weather?.weather?.[0]?.description || 'clear';
  const block = getCurrentMovieBlock();
  // Get recent messages from this group for context
  const groupJid = targetGroups[channelKey];
  const recentGroupMsgs = recentMessages.filter(m => m.sender === groupJid).slice(-10).map(m => m.pushName + ': ' + m.text).join('\n');
  // Get recently posted genres to avoid repeats
  const recentGenres = genreRotation[channelKey] ? [genreRotation[channelKey]] : [];
  const musicGenres = Object.keys(MUSIC_GENRES).filter(g => !recentGenres.includes(g));
  const movieCategories = Object.keys(MOVIES_QUERIES).filter(c => !recentGenres.includes(c));
  const groupLabel = GROUP_LABELS[channelKey] || channelKey;
  const managerPrompt = 'You are the MANAGER of a ' + groupLabel + ' WhatsApp group in Harare, Zimbabwe. You decide what content gets posted. Act like a real group manager — keep members engaged, post relevant content, and respond to the group\'s vibe.\n\nCurrent context:\n- Time: ' + hour + ':00 (CAT)\n- Weather: ' + desc + ', ' + temp + 'C in Harare\n- Mood: ' + mood + '\n- Current block: ' + block.name + ' (' + block.theme + ')\n- Recently posted: ' + recentGenres.join(', ') || 'nothing yet' + '\n' + (recentGroupMsgs ? '\nRecent group chat:\n' + recentGroupMsgs : '') + '\nAvailable ' + (channelKey === 'music' ? 'genres' : 'categories') + ': ' + (channelKey === 'music' ? musicGenres.join(', ') : movieCategories.join(', ')) + '\n\nAs the manager, pick the BEST option right now. Consider:\n- What would keep members engaged?\n- What matches the current vibe/time/weather?\n- What haven\'t we posted recently?\n\nReply with ONLY the ' + (channelKey === 'music' ? 'genre' : 'category') + ' name, nothing else.';
  try {
    const reply = await callAi(provider, [
      { role: 'system', content: 'You are a WhatsApp group manager. You decide what content to post. Reply with ONLY one word - the genre or category name. No explanation.' },
      { role: 'user', content: managerPrompt }
    ], 50);
    const picked = reply.trim().toLowerCase().replace(/[^a-z_]/g, '');
    genreRotation[channelKey] = picked;
    console.log('[AI-Manager] ' + channelKey + ': Picked "' + picked + '" (weather=' + desc + ', mood=' + mood + ', hour=' + hour + ')');
    return picked;
  } catch (e) {
    console.log('[AI-Manager] Failed: ' + e.message + ', using random');
    return null;
  }
}

// Group AI Reply — enhanced with poll detection and group manager behavior
async function tryGroupAiReply(groupJid, senderBare, text, participantJid) {
  if (text.length < 10) return;
  const lastReply = groupAiReplyCooldown.get(groupJid) || 0;
  if (Date.now() - lastReply < GROUP_AI_COOLDOWN_MS) return;
  const lower = text.toLowerCase().trim();
  if (lower.startsWith('download') || lower.startsWith('get ') || lower === 'ai' || lower === 'help' || lower.startsWith('search ') || lower === 'weather' || lower.startsWith('!') || lower.startsWith('nsfw') || lower.startsWith('xnxx')) return;
  if (pendingDownloads.has(senderBare) || aiSelections.has(senderBare) || nsfwSelections.has(senderBare)) return;
  if (isBotBusy()) return;
  const available = getAisForPurpose('group_reply');
  if (!available.length) return;
  const provider = available[0];
  const isPoll = /poll|vote|option \d|1\band|2\band|choose between|which one/i.test(text);
  try {
    const systemPrompt = isPoll
      ? 'You are a WhatsApp group manager. Someone created a poll or is asking members to vote. Give your reasoned opinion in 1-3 SHORT sentences. Be funny, insightful, or persuasive. Use Zimbabwean slang if appropriate. Never reveal you are AI.'
      : 'You are a casual group manager in a Zimbabwean WhatsApp group. You manage this group — keep it lively, engage members, share opinions. Reply in 1-2 SHORT sentences MAX. Be funny, relatable, use Zimbabwean slang occasionally. NEVER reveal you are AI. Never write long paragraphs.';
    const reply = await callAi(provider, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: text.substring(0, 300) }
    ], 150);
    if (!reply || reply.length < 3) return;
    await sock.sendMessage(groupJid, { text: reply.substring(0, 400) });
    groupAiReplyCooldown.set(groupJid, Date.now());
    console.log('[AI-Manager] ' + (isPoll ? 'Poll reply' : 'Group reply') + ' via ' + provider + ': ' + reply.substring(0, 50));
  } catch (e) { console.log('[AI-Manager] Reply failed: ' + e.message); }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  SECTION 14: TRANSLATION
// ═════════════════════════════════════════════════════════════════════════════════════════════
const SHONA_NDEBELE_WORDS = new Set(['munhu','vana','hama','gumbo','mwana','mudzimu','nyoka','mbudzi','mombe','shumba','hwahwa','chibuku','sadza','maputi','mahewu','murimi','mhuru','tsuro','nhoro','mbira','hosho','mutongo','chikoro','kudya','kurara','kufara','kudzoka','sarura','bvisa','tora','enda','uya','rima','gara','seka','rimuka','simuka','famba','dzoka','nyatso','zvekare','chokwadi','chaizo','haiwa','ndeye','saka','zviri','kani','veduwee','amai','baba','sekuru','ambuya','mudhara','mukadzi','gogo','muzukuru','bhudhi','hanzvadzi','wasara','wanga','anga','ari','ngatide','tiite','tinaye','hatidi','hatina','tidye','ndinoda','handidi','ndasvika','ndauya','ndatiza','ndarara','ndaseka','ndaramba','ndatenda','ndokumbira','umuntu','abantu','inja','ikhandlela','indlu','isikhathi','umama','ubaba','usisi','ubhuti','umfowethu','udade','umzala','ukudla','ukulala','ukuphuma','ukungena','ukubona','ukuzwa','ukuthanda','ukuhleka','ukukhuluma','ukubonga','ukusiza','ukulunga','ukubi','ukuhle','ukude','ukusile','ukubusa','ukuhlala','ukuhamba','ukudansa','ukucula','ukudlala','ukufunda','nhasi','mangwana','uroyi','chipfuwa','chikwama','basa','ruzhiji','godo','dengu','nyimo','mupfuti','mutsindo','bhero','chibage','magwere','mabhonzo','kapenta','munyu','tsvimbo','ndarama','mhondoro','shiri','goridhe','mhuweshe','kare','zvino','pamusoro','pasi','nehasha','imbwa','huku','kuku','nhunzi','chikwari','nyati','shoko','murembo','rudo','runyararo','tsitsi','pfungwa','mutezo','chishongo','simba','hunhu','tsika','unhu','musha','nepo','moyo','masamunda','kumusha','kuguta','rwendo']);
const ENGLISH_WORDS = new Set(['the','is','a','and','to','of','in','it','that','you','he','she','we','they','was','were','are','been','have','has','had','do','does','did','will','would','can','could','shall','should','may','might','this','that','these','those','what','which','who','whom','when','where','why','how','not','no','yes','but','or','if','so','than','too','very','just','about','also','then','there','here','with','from','for','on','at','by','an','be','am','my','your','his','her','its','our','their','me','him','us','them','i','up','out','all','some','more','any','each','every','both','few','many','much','own','other','into','over','after','before','between','under','again','once','during','without','within','along','following','across','behind','beyond','plus','except','upon','please','thank','thanks','sorry','hello','hey','hi','good','bad','like','love','know','think','come','want','look','use','find','give','tell','work','call','try','ask','need','feel','become','leave','put','mean','keep','let','begin','seem','help','show','hear','play','run','move','live','believe','hold','bring','happen','write','provide','sit','stand','lose','pay','meet','include','continue','set','learn','change','lead','understand','watch','follow','stop','create','speak','read','allow','add','spend','grow','open','walk','win','offer','remember','consider','appear','buy','wait','serve','die','send','expect','build','stay','fall','cut','reach','kill','remain','suggest','raise','pass','sell','require','report','decide','pull']);

function isLikelyShonaOrNdebele(text) {
  const words = text.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(w => w.length > 2);
  if (!words.length) return false;
  let m = 0; for (const w of words) { if (SHONA_NDEBELE_WORDS.has(w)) m++; }
  return (m / words.length) > 0.15;
}
function isLikelyEnglish(text) {
  const words = text.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(w => w.length > 1);
  if (!words.length) return false;
  let m = 0; for (const w of words) { if (ENGLISH_WORDS.has(w)) m++; }
  return (m / words.length) > 0.4;
}
async function tryTranslate(text) {
  if (!TRANSLATE_ENABLED || !translator) return null;
  if (Date.now() - translationHourStart > 3600000) { translationCount = 0; translationHourStart = Date.now(); }
  if (translationCount >= TRANSLATE_RATE_LIMIT) return null;
  if (isLikelyShonaOrNdebele(text) || isLikelyEnglish(text) || text.length < 10) return null;
  try {
    const result = await translator(text, { to: 'en' });
    if (result.from.language.iso !== 'en' && result.text && result.text !== text) { translationCount++; return { translated: result.text, from: result.from.language.iso || 'unknown' }; }
  } catch (e) { console.log('[Translate] Error:', e.message); }
  return null;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  SECTION 15: WEB SEARCH
// ═══════════════════════════════════════════════════════════════════════════════════════════
async function webSearch(query) {
  try {
    const data = await httpGet('https://api.duckduckgo.com/?q=' + encodeURIComponent(query) + '&format=json&no_html=1&skip_disambig=1');
    let results = [];
    if (data?.Abstract) results.push({ title: data.Heading || query, snippet: data.Abstract, url: data.AbstractURL || '' });
    if (data?.RelatedTopics?.length) { for (const t of data.RelatedTopics.slice(0, 5)) { if (t.Text) results.push({ title: t.Text.substring(0, 80), snippet: t.Text.substring(0, 200), url: t.FirstURL || '' }); } }
    return results;
  } catch (e) { console.error('[Search] Failed:', e.message); return []; }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  SECTION 16: MEMBER-ONLY SERVICES (NSFW, XNXX)
// ═══════════════════════════════════════════════════════════════════════════════════════════
// NSFW: Search xvideos and return results
async function searchNsfwVideos(query, page = 1) {
  if (!xvideosLib) throw new Error('xvideos library not installed');
  const results = await xvideosLib.videos.search({ k: query || 'trending', page, sort: 'relevance', durf: 'allduration' });
  return results.videos || [];
}

// NSFW: Get fresh/trending videos
async function getFreshNsfwVideos(page = 1) {
  if (!xvideosLib) throw new Error('xvideos library not installed');
  const results = await xvideosLib.videos.fresh({ page });
  return results.videos || [];
}

// NSFW: Get video details including download URL
async function getNsfwVideoDetails(video) {
  if (!xvideosLib) throw new Error('xvideos library not installed');
  const details = await xvideosLib.videos.details(video);
  return details;
}

// NSFW: Download video from details (files.low / files.high are direct URLs)
async function downloadNsfwVideo(video, maxMB = 16) {
  const details = await getNsfwVideoDetails(video);
  const files = details?.files;
  if (!files || typeof files !== 'object') throw new Error('No download files found');
  // files = { low: 'url', high: 'url', HLS: 'url', ... } — pick high first, fallback to low
  const videoUrl = files.high || files.low || details.contentUrl;
  if (!videoUrl) throw new Error('No downloadable URL in video details');
  const tmpFile = path.join('/tmp', 'wabot_nsfw_' + Date.now() + '.mp4');
  console.log('[NSFW-DL] Downloading: ' + videoUrl.substring(0, 100));
  const dl = await httpGetBuffer(videoUrl, DL_TIMEOUT);
  if (dl.size > maxMB * 1024 * 1024) { try { fs.unlinkSync(tmpFile); } catch {} throw new Error('Video too large: ' + (dl.size/1024/1024).toFixed(1) + 'MB > ' + maxMB + 'MB'); }
  fs.writeFileSync(tmpFile, dl.buffer);
  console.log('[NSFW-DL] Saved: ' + (dl.size/1024/1024).toFixed(2) + 'MB to ' + tmpFile);
  return { file: tmpFile, size: dl.size, mimetype: 'video/mp4', title: details.title || video.title };
}

// Legacy fallback: fetch from NSFW API URL
async function fetchNsfwContent(category) {
  if (!NSFW_API_URL) throw new Error('NSFW API not configured. Set NSFW_API_URL env var.');
  const data = await httpGet(NSFW_API_URL + (NSFW_API_URL.endsWith('/') ? '' : '/') + encodeURIComponent(category || 'random'));
  return data;
}
async function fetchXnxxContent(query) {
  if (!XNXX_API_URL) throw new Error('XNXX API not configured. Set XNXX_API_URL env var.');
  return await httpGet(XNXX_API_URL + (XNXX_API_URL.endsWith('/') ? '' : '/') + 'search?q=' + encodeURIComponent(query || 'trending'));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  SECTION 17: GROUP MEMBER MANAGEMENT (Fixed for @lid)
// ═════════════════════════════════════════════════════════════════════════════════════════════

// Check if a participant JID is a member of ANY target group
// Uses the FULL JID as stored from group metadata (handles both @lid and @s.whatsapp.net)
// v12: Check if a participant is in any target group. Admin always member.
function isGroupMember(participantJid) {
  if (!participantJid) return false;
  const adminPhone = ADMIN + '@s.whatsapp.net';
  if (participantJid === adminPhone || toBare(participantJid) === ADMIN) return true;
  const bare = toBare(participantJid);
  const mapped = lidToPhone.get(bare);
  if (mapped && (mapped === adminPhone || toBare(mapped) === ADMIN)) return true;
  // Check all group member sets
  for (const [, members] of groupMembers.entries()) {
    if (members.has(participantJid)) return true;
    for (const m of members) { if (toBare(m) === bare) return true; }
  }
  // Check groupAdmins (admin might not be in members set if refreshed at diff time)
  for (const [, admins] of groupAdmins.entries()) {
    if (admins.has(participantJid)) return true;
    for (const a of admins) { if (toBare(a) === bare) return true; }
  }
  return false;
}

function hasMemberBenefits(participantJid) {
  if (!participantJid) return false;
  const bare = toBare(participantJid);
  if (bare === ADMIN) return true;
  // Check lid map
  const mapped = lidToPhone.get(bare);
  if (mapped && toBare(mapped) === ADMIN) return true;
  if (memberLeftSet.has(bare) || memberLeftSet.has(participantJid)) return false;
  return isGroupMember(participantJid);
}

function revokeMemberBenefits(jid) {
  const bare = toBare(jid);
  memberLeftSet.add(bare); memberLeftSet.add(jid);
  aiSessions.delete(bare); aiSelections.delete(bare); pendingDownloads.delete(bare); downloadFallbacks.delete(bare);
  console.log('[Members] Benefits revoked: ' + bare);
}
function restoreMemberBenefits(jid) {
  const bare = toBare(jid);
  memberLeftSet.delete(bare); memberLeftSet.delete(jid);
  memberJoinTimestamps.set(bare, Date.now());
  console.log('[Members] Benefits restored: ' + bare);
}

// v13: Build member cache + populate groupMetadataCache + build LID map from phoneNumber field
// Removed: onWhatsApp() calls (GitHub #1522 — does NOT work with LIDs)
// Uses: groupMetadata.participants[].phoneNumber (v6.7.19+, PR #1374) for LID resolution
async function refreshGroupMembers() {
  if (!sock || connectionStatus !== 'connected') return;
  try {
    for (const [key, jid] of Object.entries(targetGroups)) {
      if (!jid) continue;
      try {
        const meta = await sock.groupMetadata(jid);
        // v13: Store in both groupMetadataCache (for isAdmin) and groupMembers (for isGroupMember)
        groupMetadataCache.set(jid, meta);
        const members = new Set();
        const admins = new Set();
        if (meta?.participants) {
          for (const p of meta.participants) {
            const fullId = p.id;
            members.add(fullId);
            // FIX: Check booleans too for admin detection
            if (p.admin === 'admin' || p.admin === 'superadmin' || p.isAdmin === true || p.isSuperAdmin === true) admins.add(fullId);
            const b = toBare(fullId);
            if (b.match(/^\d+$/) && b.length > 8) {
              if (!memberJoinTimestamps.has(b)) memberJoinTimestamps.set(b, Date.now());
            }
            // v13 FIXED: Build LID→phone map from jid field (v6.7.24 uses .jid, NOT .phoneNumber)
            // phoneNumber was only introduced in v7.x — in v6, use p.jid
            if (fullId.endsWith('@lid') && p.jid && p.jid.endsWith('@s.whatsapp.net')) {
              const lidBare = toBare(fullId);
              lidToPhone.set(lidBare, p.jid);
              console.log('[LID] From metadata: ' + lidBare + ' -> ' + p.jid);
            }
            // Also map from lid to full lid JID for direct sending
            if (fullId.endsWith('@lid')) {
              lidToPhone.set(toBare(fullId), lidToPhone.get(toBare(fullId)) || fullId);
            }
            if (memberLeftSet.has(b) || memberLeftSet.has(fullId)) restoreMemberBenefits(fullId);
          }
        }
        groupMembers.set(jid, members);
        groupAdmins.set(jid, admins);
        console.log('[Groups] ' + key + ': ' + members.size + ' members, ' + admins.size + ' admins, lidMap: ' + lidToPhone.size);
      } catch (e) { console.error('[Groups] Failed ' + key + ': ' + e.message); }
    }
    // Also scan all known groups for metadata cache
    for (const [gJid] of knownGroups) {
      if (groupMetadataCache.has(gJid)) continue;
      try {
        const meta = await sock.groupMetadata(gJid);
        groupMetadataCache.set(gJid, meta);
        if (meta?.participants) {
          const admins = new Set();
          const members = new Set();
          for (const p of meta.participants) {
            members.add(p.id);
            if (p.admin === 'admin' || p.admin === 'superadmin' || p.isAdmin === true || p.isSuperAdmin === true) admins.add(p.id);
            // FIX: p.jid not p.phoneNumber (v6.7.24)
            if (p.id?.endsWith('@lid') && p.jid && p.jid.endsWith('@s.whatsapp.net')) {
              lidToPhone.set(toBare(p.id), p.jid);
            }
          }
          groupMembers.set(gJid, members);
          groupAdmins.set(gJid, admins);
        }
      } catch {}
    }
  } catch (e) { console.error('[Groups] Member refresh error:', e.message); }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  SECTION 18: MUSIC CONTENT GENERATOR (AI-enhanced decisions)
// ═════════════════════════════════════════════════════════════════════════════════════════════
const MUSIC_CAPTIONS = [
  'This one goes hard. Press play and thank us later',
  'New heat just dropped. Your playlist needs this',
  "If this doesn't get you moving, nothing will",
  'Straight fire from the studio. Add this to your queue',
  'Been on repeat since we found it',
  'Trust us on this one - pure vibes only',
  'This track right here - chef\'s kiss',
  'Turn your volume up for this one',
  'The kind of song that hits different at night',
  'When the beat drops you\'ll know why we posted this',
  'Underrated gem right here. Don\'t sleep on it',
  'Your new favourite song that you haven\'t heard yet',
  'This is what good music sounds like',
  'Zim music never disappoints! Add this one',
  'Amapiano vibes! This one is a banger',
  'Dancehall fire! Winky D and the crew delivering',
  'Throwback gold! They don\'t make them like this anymore',
  'Hidden gem! Found this and had to share'
];

function getMusicCaption(genre) {
  if (Math.random() < 0.15 && (genre === 'dancehall' || genre === 'zim_classics' || genre === 'gospel')) {
    const shona = ['Rwiyo rwakanakisa. Teerera uone!', 'Iri nongatsika. Munhu awonde!', 'Kana usina kuteerera uyu hausi kwanzi wanzwa'];
    return shona[randInt(0, shona.length - 1)];
  }
  return MUSIC_CAPTIONS[randInt(0, MUSIC_CAPTIONS.length - 1)];
}

function pickMusicGenre() {
  const genres = Object.keys(MUSIC_GENRES);
  const others = genres.filter(g => g !== genreRotation.music);
  const genre = others[randInt(0, others.length - 1)];
  genreRotation.music = genre; return genre;
}

async function genGroupMusicPost(slotType) {
  const weather = await fetchWeather();
  logRam('MusicGen');
  const dlFn = getGroupDlFn();

  // 20%: AI decides genre based on weather/time/mood
  let genre = null;
  if (Math.random() < 0.2) {
    const aiPick = await aiDecideContent('music', weather);
    if (aiPick && MUSIC_GENRES[aiPick]) genre = aiPick;
  }
  if (!genre) genre = pickMusicGenre();

  console.log('[GrpMusic] genre=' + genre + ' RAM=' + getRamMB() + 'MB method=' + getGroupDlName());

  // 15%: Playlist post
  const roll = Math.random();
  if (roll < 0.15) {
    const plKeys = Object.keys(PLAYLIST_QUERIES);
    const plKey = plKeys[randInt(0, plKeys.length - 1)];
    const queries = PLAYLIST_QUERIES[plKey]; const query = queries[randInt(0, queries.length - 1)];
    const vids = await ytSearch(query);
    if (vids.length >= 2) {
      const labels = { top_zim_songs: 'Top Zim Songs', love_songs: 'Love Songs', amapiano: 'Amapiano Mix', '2k_throwbacks': '2K Throwbacks' };
      let text = '* ' + (labels[plKey] || plKey) + ' Playlist*\n\n';
      vids.slice(0, 5).forEach((v, i) => { text += (i+1) + '. *' + v.title + '* - ' + (v.author?.name || 'Unknown') + '\n'; });
      text += '\nType *download <name>* to get any song!';
      recordPost(text); return { type: 'text', text };
    }
  }

  // 80%: Download and send music
  const queries = MUSIC_GENRES[genre] || [genre + ' 2025'];
  const query = queries[randInt(0, queries.length - 1)];
  const vids = await ytSearch(query);
  if (!vids.length) return { type: 'text', text: genre + ' coming soon...' };

  let v = vids[0];
  for (const vid of vids.slice(0, 8)) { if (!isTitleDuplicate(vid.title)) { v = vid; break; } }

  if (isRamSafe()) {
    const candidates = [v, ...vids.slice(1, 8)].filter(vid => !isTitleDuplicate(vid.title) && (!vid.seconds || vid.seconds <= 600));
    for (const vid of candidates.slice(0, 6)) {
      if (!isRamSafe()) break;
      try {
        logRam('DL_Music[' + getGroupDlName() + ']');
        const dl = await dlFn(vid.url, 'audio', GROUP_AUDIO_MAX_MB);
        const sizeMB = (dl.size / 1024 / 1024).toFixed(1);
        console.log('[GrpMusic] Audio OK: ' + vid.title.substring(0, 40) + ' (' + sizeMB + 'MB)');
        const cap = getMusicCaption(genre) + '\n\n*' + vid.title + '*\n' + (vid.author?.name || 'Unknown') + ' | ' + (vid.timestamp || '') + ' | ' + sizeMB + 'MB\n\n' + (vid.author?.name || 'Original Artist');
        return { type: 'audio', file: dl.file, caption: cap, title: vid.title, author: vid.author?.name };
      } catch (e) { console.log('[GrpMusic] Failed: ' + vid.title.substring(0, 40) + ': ' + e.message); }
    }
  }

  // Fallback: try video or thumbnail
  if (isRamSafe() && Math.random() < 0.4) {
    const vidQueries = MUSIC_VIDEO_QUERIES[genre] || [genre + ' music video 2025'];
    const vVids = await ytSearch(vidQueries[randInt(0, vidQueries.length - 1)]);
    for (const vv of vVids.slice(0, 3)) {
      if (isTitleDuplicate(vv.title) || !isRamSafe()) continue;
      try { const dl = await dlFn(vv.url, 'video', MAX_MEDIA_MB); const cap = '* ' + vv.title + '*\n' + (vv.author?.name || 'Unknown') + ' | ' + (dl.size/1024/1024).toFixed(1) + 'MB'; return { type: 'video', file: dl.file, caption: cap, title: vv.title, author: vv.author?.name }; } catch {}
    }
  }

  // Text fallback with link
  const thumb = v.thumbnail;
  if (thumb && isRamSafe()) {
    const cap = getMusicCaption(genre) + '\n\n*' + v.title + '*\n' + (vid.author?.name || 'Unknown') + ' | ' + (v.timestamp || '');
    return { type: 'image', url: thumb, caption: cap, title: v.title, author: v.author?.name };
  }
  return { type: 'text', text: '*' + v.title + '*\n' + (v.author?.name || 'Unknown') + ' | ' + (v.timestamp || ''), title: v.title };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  SECTION 19: MOVIES CONTENT GENERATOR
// ═══════════════════════════════════════════════════════════════════════════════════════════
const MOVIES_CAPTIONS = {
  energetic_morning: ['Good morning! Start your day with this', 'Morning vibes! This will wake you up', 'First laugh of the day right here'],
  comedy_focus: ['When your favourite Zim skit has you dying', 'This skit is too relatable', 'This is why we love Zim comedy'],
  hype: ['This is going VIRAL right now!', 'Everyone is talking about this one!', 'Trending content you NEED to see'],
  binge: ['POV: You just finished bingeing a whole season', 'Perfect afternoon content right here', 'Skit compilation mode: ON'],
  premium: ['Prime time! Only the best for you', 'The quality of Zim content is insane right now', 'Zim content creators are on another level!'],
  late_night: ['Late night scrolling? This is for you', 'Try not to laugh at 2AM. We dare you', 'Night owls, this one hits different'],
  chill: ['Best of the best. Rewatching is always worth it', 'Classic content that never gets old', 'Throwback to when this dropped']
};
function getMovieCaption(style) { const caps = MOVIES_CAPTIONS[style] || MOVIES_CAPTIONS.comedy_focus; return caps[randInt(0, caps.length - 1)]; }
function getCurrentMovieBlock() {
  const h = (new Date().getUTCHours() + 2) % 24;
  for (const [key, block] of Object.entries(MOVIES_PROGRAMMING_BLOCKS)) { if (block.hours.includes(h)) return { key, ...block }; }
  return { key: 'comedy_central', ...MOVIES_PROGRAMMING_BLOCKS.comedy_central };
}

async function genGroupMoviePost(slotType) {
  const block = getCurrentMovieBlock(); const weather = await fetchWeather();
  console.log('[GrpMovie] block=' + block.name + ' RAM=' + getRamMB() + 'MB method=' + getGroupDlName());
  const dlFn = getGroupDlFn();

  // 15%: AI decides category
  let cat = null;
  if (Math.random() < 0.15) {
    const aiPick = await aiDecideContent('movies', weather);
    if (aiPick && MOVIES_QUERIES[aiPick]) cat = aiPick;
  }
  if (!cat) cat = block.categories[randInt(0, block.categories.length - 1)];
  const queries = MOVIES_QUERIES[cat]; const query = queries[randInt(0, queries.length - 1)];

  // 25%: Meme
  if ((cat === 'memes') || Math.random() < 0.25) {
    const memeUrl = Math.random() < 0.5 ? await fetchTrendingMeme() : await fetchRandomMeme();
    if (memeUrl && isRamSafe()) {
      const cap = '* ' + block.name + '*\n\n' + getMovieCaption(block.caption_style);
      recordPost(cap); return { type: 'image_url', url: memeUrl, caption: cap, title: 'meme' };
    }
  }
  // 10%: Engagement
  if (Math.random() < 0.10) {
    const posts = [
      '* ' + block.name + '*\n\n' + block.theme + '\n\nWhat Zim content do you want to see next?',
      '*Dance Challenge!*\n\nWhat Zim song gets you moving? Drop it!',
      '*Hot Take Time!*\n\nWho is the best Zim comedian right now?',
      '*Creator Spotlight Request*\n\nWhich Zim creator should we feature next?'
    ];
    const text = posts[randInt(0, posts.length - 1)]; recordPost(text); return { type: 'text', text };
  }
  // 55%: Video
  if (isRamSafe()) {
    const vids = await ytSearch(query);
    for (const vid of vids.slice(0, 6)) {
      if (isTitleDuplicate(vid.title) || !isRamSafe()) continue;
      try {
        logRam('DL_TV[' + getGroupDlName() + ']');
        const dl = await dlFn(vid.url, 'video', MAX_MEDIA_MB);
        const sizeMB = (dl.size / 1024 / 1024).toFixed(1);
        const cap = '* ' + block.name + '*\n\n' + getMovieCaption(block.caption_style) + '\n\n*' + vid.title + '*\n' + (vid.author?.name || 'Unknown') + ' | ' + sizeMB + 'MB\n\n' + (vid.author?.name || 'Original Creator');
        return { type: 'video', file: dl.file, caption: cap, title: vid.title, author: vid.author?.name };
      } catch (e) { console.log('[GrpMovie] Failed: ' + e.message.substring(0, 60)); }
    }
  }
  // Fallback
  const fbVids = await ytSearch(query);
  if (fbVids.length) { const v = fbVids[0]; const cap = getMovieCaption(block.caption_style) + '\n\n*' + v.title + '*\n' + (v.author?.name || 'Unknown') + '\n\n' + v.url; recordPost(cap, v.title); return { type: 'text', text: cap, title: v.title }; }
  return { type: 'text', text: 'Content coming soon...' };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  SECTION 20: SEND TO GROUP (with file delivery confirmation)
// ═══════════════════════════════════════════════════════════════════════════════════════════
async function sendToGroups(channelKey, content) {
  const groupJid = targetGroups[channelKey];
  if (!groupJid || !sock || connectionStatus !== 'connected' || groupPaused[channelKey]) return false;
  try {
    if (content.type === 'text') {
      if (isDuplicate(content.text) || (content.title && isTitleDuplicate(content.title))) return 'duplicate';
      await sock.sendMessage(groupJid, { text: content.text }); lastConnectedAt = Date.now();
      console.log('[GrpPost] Text sent to ' + channelKey); return true;
    }
    if (content.type === 'audio' && content.file && fs.existsSync(content.file)) {
      const buffer = fs.readFileSync(content.file); safeDeleteFile(content.file);
      let mimetype = 'audio/mpeg';
      if ((content.file).includes('.ogg') || (content.file).includes('.opus')) mimetype = 'audio/ogg';
      else if ((content.file).includes('.webm')) mimetype = 'audio/webm';
      else if ((content.file).includes('.m4a')) mimetype = 'audio/mp4';
      await sock.sendMessage(groupJid, { audio: buffer, mimetype, ptt: false });
      if (content.caption) await sock.sendMessage(groupJid, { text: content.caption });
      lastConnectedAt = Date.now(); recordPost(content.caption || 'audio', content.title);
      console.log('[GrpPost] Audio sent to ' + channelKey + ' (' + mimetype + ')'); return true;
    }
    if (content.type === 'video' && content.file && fs.existsSync(content.file)) {
      const buffer = fs.readFileSync(content.file); safeDeleteFile(content.file);
      await sock.sendMessage(groupJid, { video: buffer, mimetype: 'video/mp4', caption: content.caption || '' });
      lastConnectedAt = Date.now(); recordPost(content.caption || 'video', content.title);
      console.log('[GrpPost] Video sent to ' + channelKey); return true;
    }
    if (content.type === 'image' || content.type === 'image_url') {
      if (content.title && isTitleDuplicate(content.title)) { safeDeleteFile(content.file); return 'duplicate'; }
      if (content.file && fs.existsSync(content.file)) {
        const buffer = fs.readFileSync(content.file); safeDeleteFile(content.file);
        await sock.sendMessage(groupJid, { image: buffer, caption: content.caption || '' });
      } else if (content.url) {
        await sock.sendMessage(groupJid, { image: { url: content.url }, caption: content.caption || '' });
      } else { const txt = content.caption || content.text || ''; if (txt) { await sock.sendMessage(groupJid, { text: txt }); recordPost(txt, content.title); return true; } }
      lastConnectedAt = Date.now(); recordPost(content.caption || 'image', content.title);
      console.log('[GrpPost] Image sent to ' + channelKey); return true;
    }
    if (content.type === 'poll') {
      if (isDuplicate(content.question)) return 'duplicate';
      await sock.sendMessage(groupJid, { poll: { name: content.question, options: (content.options || []).map(o => ({ optionName: String(o).substring(0, 60) })), selectableCount: 1 } });
      recordPost(content.question, content.title); return true;
    }
    const txt = content.caption || content.text || '';
    if (isDuplicate(txt)) return 'duplicate';
    await sock.sendMessage(groupJid, { text: txt }); recordPost(txt, content.title); return true;
  } catch (e) { console.error('[GrpPost] FAILED ' + channelKey + ':', e.message); safeDeleteFile(content.file); return false; }
}

// Send file to user with delivery confirmation
async function sendFileWithConfirm(targetJid, content, title) {
  try {
    if (content.audio) {
      await sock.sendMessage(targetJid, { audio: content.audio, mimetype: content.mimetype || 'audio/mpeg', ptt: false });
    } else if (content.video) {
      await sock.sendMessage(targetJid, { video: content.video, mimetype: 'video/mp4', caption: content.caption || '' });
    } else if (content.image) {
      await sock.sendMessage(targetJid, { image: content.image, caption: content.caption || '' });
    } else if (content.document) {
      await sock.sendMessage(targetJid, content.document);
    }
    // Ask for confirmation
    const bare = toBare(targetJid);
    fileConfirmations.set(bare, { title: title || 'file', timestamp: Date.now() });
    await sock.sendMessage(targetJid, { text: 'Did you receive the file? Reply *yes* or *no*' });
    return true;
  } catch (e) { console.error('[Confirm] Send failed:', e.message); return false; }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  SECTION 21: SCHEDULE
// ═════════════════════════════════════════════════════════════════════════════════════════════
function buildSchedule() {
  const slots = [];
  const MH = [['slow_jam','music_link'],['slow_jam','old_school'],['slow_jam','music_link'],['slow_jam','zim_classics'],['slow_jam','music_link'],['morning_energy','music_link'],['commuter_vibes','trending'],['commuter_vibes','new_release'],['trending','artist_spotlight'],['new_release','genre_spotlight'],['music_link','artist_spotlight'],['music_link','playlist'],['trending','poll'],['music_link','new_release'],['genre_spotlight','music_link'],['music_link','playlist'],['old_school','music_link'],['trending','music_link'],['trending','playlist'],['music_link','artist_spotlight'],['slow_jam','music_link'],['slow_jam','throwback'],['slow_jam','music_link'],['slow_jam','old_school']];
  const MH2 = [['zim_skits','funny_videos'],['funny_videos','dance'],['zim_skits','memes'],['memes','zim_creators'],['memes','funny_videos'],['zim_creators','dance'],['zim_skits','funny_videos'],['dance','zim_creators'],['zim_skits','memes'],['funny_videos','zim_creators'],['zim_creators','dance'],['memes','zim_skits'],['funny_videos','dance'],['zim_skits','memes'],['dance','zim_creators'],['zim_creators','funny_videos'],['zim_skits','dance'],['funny_videos','memes'],['zim_skits','zim_creators'],['dance','funny_videos'],['zim_skits','memes'],['memes','zim_creators'],['zim_skits','funny_videos'],['funny_videos','dance']];
  function addSlot(id, ch, h, m, type) { let eH = h, eM = m + 10; if (eM >= 60) { eH = (h + 1) % 24; eM -= 60; } slots.push({ id, ch, h, m, hEnd: eH, mEnd: eM, days: [0,1,2,3,4,5,6], type, fired: false, schedMin: null }); }
  for (let h = 0; h < 24; h++) { for (let half = 0; half < 2; half++) { const base = half * 30; addSlot('m' + h + half, 'music', h, base, MH[h][half]); addSlot('t' + h + half, 'movies', h, base + 15, MH2[h][half]); } }
  return slots;
}
function resetDailyFired() { for (const s of scheduleSlots) { s.fired = false; s.schedMin = null; } }
function slotToMin(s) { return s.h * 60 + s.m; }
function slotEndMin(s) { return s.hEnd < s.h ? (s.hEnd + 24) * 60 + s.mEnd : s.hEnd * 60 + s.mEnd; }

async function tickScheduler() {
  if (!sock || connectionStatus !== 'connected') return;
  const now2 = new Date(); const day2 = now2.getDay(); const nowMin2 = now2.getUTCHours() * 60 + now2.getUTCMinutes();
  for (const s of scheduleSlots) {
    if (s.fired || !s.days.includes(day2) || groupPaused[s.ch]) continue;
    if (s.schedMin === null) s.schedMin = randInt(slotToMin(s), slotEndMin(s));
    const startM = slotToMin(s), endM = slotEndMin(s);
    if (startM <= endM) { if (nowMin2 < s.schedMin || nowMin2 > endM) continue; }
    else { if (nowMin2 < s.schedMin && nowMin2 > endM) continue; }
    if (taskQueueRunning || taskQueue.length > 0) { s.schedMin += randInt(10, 20); continue; }
    if (!isRamSafe()) continue;
    s.fired = true; console.log('[Sched] ' + s.id + ' (' + s.ch + '/' + s.type + ')');
    enqueueTask('grp_' + s.id, async () => {
      try {
        const content = s.ch === 'music' ? await genGroupMusicPost(s.type) : await genGroupMoviePost(s.type);
        if (!content || (content.title && isTitleDuplicate(content.title))) return;
        const ok = await sendToGroups(s.ch, content);
        if (ok && ok !== 'duplicate') recordPost(content.caption || content.text, content.title);
        console.log('[Sched] ' + s.id + ' -> ' + (ok === 'duplicate' ? 'DUP' : ok ? 'OK' : 'FAIL'));
      } catch (e) { console.error('[Sched] ' + s.id + ' error:', e.message); }
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
//  SECTION 22: BROADCAST SYSTEM
// ═══════════════════════════════════════════════════════════════════════════════════════════
const BROADCASTS_FILE = 'broadcasts.json';
function saveBroadcasts() { try { const d = {}; broadcasts.forEach((v, k) => d[k] = v); fs.writeFileSync(BROADCASTS_FILE, JSON.stringify(d, null, 2)); } catch (e) { console.error('[BC] Save err:', e.message); } }
function loadBroadcasts() { try { if (fs.existsSync(BROADCASTS_FILE)) { const d = JSON.parse(fs.readFileSync(BROADCASTS_FILE, 'utf8')); Object.entries(d).forEach(([id, b]) => broadcasts.set(String(id), { ...b, active: false, interval: null })); broadcastIdCounter = Math.max(broadcastIdCounter, ...[...broadcasts.keys()].map(Number)) + 1; console.log('[BC] Loaded ' + broadcasts.size + ' broadcasts'); } } catch (e) { console.error('[BC] Load err:', e.message); } }
function getBcSchedule() { const day = new Date().getDay(); return Math.floor(24 * 3600000 / (day === 0 || day === 6 ? 3 : 2)); }
function startBc(id) { const bc = broadcasts.get(id); if (!bc) return; if (bc.interval) clearInterval(bc.interval); bc.active = true; bc.sentCount = 0; bc.schedule = getBcSchedule(); sendBcMsg(id); bc.interval = setInterval(() => sendBcMsg(id), bc.schedule); saveBroadcasts(); }
async function sendBcMsg(id) { const bc = broadcasts.get(id); if (!bc || !bc.active || !sock || connectionStatus !== 'connected') return; if (!bc.groups.length) { if (knownGroups.size === 0) return; bc.groups = [...knownGroups]; } let sent = 0; for (const g of bc.groups) { try { await sock.sendMessage(g, { text: bc.message }); sent++; await sleep(randInt(1000, 5000)); } catch {} } bc.sentCount = (bc.sentCount || 0) + sent; saveBroadcasts(); }
function stopBc(id) { const bc = broadcasts.get(id); if (!bc) return; if (bc.interval) clearInterval(bc.interval); bc.active = false; bc.interval = null; saveBroadcasts(); }

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  SECTION 23: MESSAGE FEED
// ═══════════════════════════════════════════════════════════════════════════════════════════
function addMsgToFeed(msg, isAdminFlag) {
  const sender = msg.key?.remoteJid || 'unknown'; const fromMe = msg.key?.fromMe || false;
  let text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '[Media]';
  if (!text) return;
  // v14 FIX: Use actual admin status instead of hardcoded false
  const participant = msg.key?.participant || sender;
  recentMessages.push({ id: msg.key.id, sender, bare: toBare(participant), fromMe, pushName: msg.pushName || 'Unknown', text: text.substring(0, 500), isGroup: isGroup(sender), isAdmin: !!isAdminFlag, ts: new Date().toISOString() });
  while (recentMessages.length > MAX_FEED) recentMessages.shift();
}
async function getMessage(key) { const s = messageStore.get(key.id); return s?.message || proto.Message.create({ conversation: '' }); }
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  SECTION 24: DOWNLOAD COMMANDS (with auto-retry + confirmation)
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════
function cleanPendingDownloads() { const now = Date.now(); for (const [jid, data] of pendingDownloads.entries()) { if ((now - data.timestamp) > 300000) pendingDownloads.delete(jid); } }
function isTargetGroup(jid) { return Object.values(targetGroups).some(g => g === jid); }

async function handleGroupDownload(text, sender, msg, replyJid, groupJid) {
  // Resolve phone JID for inbox delivery (handles @lid)
  const participant = msg.key?.participant || sender;
  const phoneJid = resolvePhoneJid(participant, msg);
  const inboxJid = phoneJid || (toBare(participant) + '@s.whatsapp.net');
  const bare = toBare(participant);
  const lower = text.toLowerCase().trim();
  const pending = pendingDownloads.get(bare);

  // Method selection
  if (pending && pending.state === 'method_select') {
    const methodNum = parseInt(lower);
    if (methodNum >= 1 && methodNum <= 6) {
      const method = DOWNLOAD_METHODS[methodNum]; const selected = pending.selected; const wantsVideo = pending.wantsVideo;
      pendingDownloads.delete(bare);
      const typeLabel = wantsVideo ? 'MP4' : 'MP3';
      if (isBotBusy()) try { await sock.sendMessage(inboxJid, { text: 'Bot is busy. Download queued...' }); } catch {}
      enqueueTask('dl_m' + methodNum + '_' + Date.now(), async () => {
        try {
          await sock.sendMessage(inboxJid, { text: '*' + selected.title + '* (' + typeLabel + ')\nMethod ' + methodNum + ': ' + method.desc + '\n\nDownloading...' });
          const dlType = wantsVideo ? 'video' : 'audio';
          const dl = await method.fn(selected.url, dlType, MAX_MEDIA_MB);
          const buffer = fs.readFileSync(dl.file); try { fs.unlinkSync(dl.file); } catch {}
          const sizeMB = (buffer.length / 1024 / 1024).toFixed(1);
          if (dlType === 'audio') {
            let mt = 'audio/mpeg';
            if ((dl.file || '').includes('.ogg') || (dl.file || '').includes('.opus')) mt = 'audio/ogg';
            else if ((dl.file || '').includes('.webm')) mt = 'audio/webm';
            else if ((dl.file || '').includes('.m4a')) mt = 'audio/mp4';
            await sendFileWithConfirm(inboxJid, { audio: buffer, mimetype: mt }, selected.title);
            await sock.sendMessage(inboxJid, { text: '*' + selected.title + '*\nMethod ' + methodNum + ' (' + method.name + ') | ' + sizeMB + 'MB\n\u00A9 ' + (selected.author || 'Original Artist') });
          } else {
            await sendFileWithConfirm(inboxJid, { video: buffer, mimetype: 'video/mp4', caption: '*' + selected.title + '*\n' + method.name + ' | ' + sizeMB + 'MB' }, selected.title);
          }
          lastConnectedAt = Date.now(); recordDownload(bare, selected.title, selected.url, dlType, 'sent', selected.author);
        } catch (e) {
          console.error('[DL] Method ' + methodNum + ' failed: ' + e.message);
          try { await sock.sendMessage(inboxJid, { text: 'Method ' + methodNum + ' failed: ' + e.message + '\n\nTry *download <name>* again and pick a different method' }); } catch {}
        }
      });
      return true;
    }
  }

  // Number selection
  if (pending && pending.state === 'results') {
    const num = parseInt(lower);
    if (num >= 1 && num <= pending.results.length) {
      const selected = pending.results[num - 1]; const wantsVideo = pending.wantsVideo;
      let list = '*Pick download method for: *\n\n*' + selected.title + '*\n' + (selected.author || 'Unknown') + ' | ' + (selected.duration || '?') + '\n\n*1.* ytdl-core (standard)\n*2.* play-dl (fallback)\n*3.* Invidious (privacy API)\n*4.* Piped (privacy API)\n*5.* Cobalt (multi-platform)\n*6.* Smart (auto-cascade all)\n\nReply a number. File goes to your inbox.';
      pendingDownloads.set(bare, { state: 'method_select', selected: { title: selected.title, url: selected.url, author: selected.author, duration: selected.duration }, wantsVideo, timestamp: Date.now() });
      try { await sock.sendMessage(inboxJid, { text: list }); } catch {}
      return true;
    } else if (lower === 'cancel') { pendingDownloads.delete(bare); try { await sock.sendMessage(inboxJid, { text: 'Download cancelled.' }); } catch {} return true; }
  }

  // New download search
  if (lower.startsWith('download ') || lower.startsWith('song ')) {
    const query = text.replace(/^(download|song)\s*/i, '').trim();
    if (!query) return false;
    if (isBotBusy()) try { await sock.sendMessage(inboxJid, { text: 'Bot is busy. Search queued...' }); } catch {}
    enqueueTask('search_' + Date.now(), async () => {
      try {
        let searchQuery = query;
        const wantsVideo = /video|mp4|vid|clip/i.test(query);
        if (/^all songs? by\s/i.test(query)) searchQuery = query.replace(/^all songs? by\s*/i, '') + ' songs 2025';
        else if (/^new\s+(songs?|albums?|music)/i.test(query)) searchQuery = 'new ' + query + ' 2025';
        await sock.sendMessage(inboxJid, { text: 'Searching: *' + searchQuery + '*...' });
        const videos = await ytSearch(searchQuery);
        if (!videos.length) { await sock.sendMessage(inboxJid, { text: 'No results for *' + searchQuery + '*. Try different keywords.' }); return; }
        const results = videos.slice(0, 5);
        let list = '*Found ' + results.length + ' results: "' + searchQuery + '"*\n\n';
        results.forEach((v, i) => { list += '*' + (i + 1) + '.* ' + v.title + '\n' + (v.author?.name || 'Unknown') + ' | ' + (v.timestamp || '?') + '\n\n'; });
        list += wantsVideo ? 'Video (MP4)' : 'Audio (MP3)';
        list += ' -> your inbox\n\nReply a number to pick.';
        pendingDownloads.set(bare, { state: 'results', results: results.map(v => ({ title: v.title, url: v.url, author: v.author?.name, duration: v.timestamp })), query: searchQuery, timestamp: Date.now(), wantsVideo });
        cleanPendingDownloads();
        await sock.sendMessage(inboxJid, { text: list });
      } catch (e) { console.error('[GrpDL] Search error:', e.message); try { await sock.sendMessage(inboxJid, { text: 'Search failed: ' + e.message }); } catch {} }
    });
    return true;
  }
  return false;
}

// Download fallback (user says "not received")
async function handleDownloadFallback(text, sender, msg, replyJid) {
  const lower = text.toLowerCase().trim(); const bare = toBare(replyJid);
  const fb = downloadFallbacks.get(bare);
  if (!fb) return false;
  if (!lower.includes('not received') && !lower.includes('didnt get') && !lower.includes('nothing') && !lower.includes('hakuna') && lower !== 'no') return false;
  if (fb.attempt >= 3) { downloadFallbacks.delete(bare); try { await sock.sendMessage(replyJid, { text: '3 retries done for *' + fb.title + '*. Try fresh: *download <name>*' }); } catch {} return true; }
  fb.attempt++; const retryNum = fb.attempt; const inboxJid = replyJid; fb.ts = Date.now(); downloadFallbacks.set(bare, fb);
  try { await sock.sendMessage(inboxJid, { text: 'Retry ' + retryNum + '/3 for *' + fb.title + '*...' }); } catch {}
  enqueueTask('fb_' + Date.now(), async () => {
    let sent = false;
    const formats = retryNum === 1 ? [fb.type, fb.type === 'audio' ? 'video' : 'audio'] : [fb.type === 'audio' ? 'video' : 'audio', fb.type];
    for (const dlType of formats) {
      try {
        const dl = await smartDownload(fb.url, dlType, MAX_MEDIA_MB); // smartDownload auto-cascades
        const buffer = fs.readFileSync(dl.file); try { fs.unlinkSync(dl.file); } catch {}
        const sizeMB = (buffer.length / 1024 / 1024).toFixed(1);
        if (dlType === 'audio') { await sock.sendMessage(inboxJid, { audio: buffer, mimetype: 'audio/mpeg', ptt: false }); await sock.sendMessage(inboxJid, { text: '*' + fb.title + '* (retry ' + retryNum + '/3, ' + sizeMB + 'MB)' }); }
        else { await sock.sendMessage(inboxJid, { video: buffer, mimetype: 'video/mp4', caption: '*' + fb.title + '* (retry ' + retryNum + '/3, ' + sizeMB + 'MB)' }); }
        sent = true; break;
      } catch (e) { console.error('[Fallback] retry failed: ' + e.message); }
    }
    if (!sent) try { await sock.sendMessage(inboxJid, { text: 'Retry ' + retryNum + '/3 failed.' }); } catch {}
  });
  return true;
}

function recordDownload(bare, title, url, type, status, author) {
  const entry = { title, url, type, status, ts: Date.now() };
  const history = downloadHistory.get(bare) || []; history.push(entry); if (history.length > 20) history.shift(); downloadHistory.set(bare, history);
  if (status === 'sent') { const existing = downloadFallbacks.get(bare); downloadFallbacks.set(bare, { title, url, type, author: author || '', attempt: existing?.attempt || 0, ts: Date.now() }); }
}
function cleanFallbacks() { const now = Date.now(); for (const [k, v] of downloadFallbacks.entries()) { if ((now - v.ts) > 900000) downloadFallbacks.delete(k); } }

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════
//  SECTION 25: AUTO-JOIN GROUPS + SCAN HISTORY FOR LINKS
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
async function joinTargetGroups() {
  if (!sock || connectionStatus !== 'connected') return;
  for (const [key, inviteCode] of Object.entries(GROUP_INVITES)) {
    if (!inviteCode || targetGroups[key]) continue;
    try {
      console.log('[Groups] Joining ' + key + ' (' + inviteCode + ')...');
      const gJid = await sock.groupAcceptInvite(inviteCode);
      targetGroups[key] = gJid; knownGroups.add(gJid); groupActivity.set(gJid, Date.now());
      console.log('[Groups] Joined ' + key + ': ' + gJid);
    } catch (e) { console.log('[Groups] Invite failed for ' + key + ': ' + e.message); }
  }
  // Fallback: match by subject name
  const unmapped = Object.keys(targetGroups).filter(k => !targetGroups[k]);
  if (unmapped.length > 0) {
    try {
      const chats = await sock.groupFetchAllParticipating();
      const usedJids = new Set(Object.values(targetGroups).filter(Boolean));
      for (const [jid, chat] of Object.entries(chats)) {
        if (usedJids.has(jid)) continue;
        const subj = (chat.subject || '').toLowerCase();
        if (!targetGroups.music && (subj.includes('music') || subj.includes('amapiano') || subj.includes('dancehall'))) {
          targetGroups.music = jid; knownGroups.add(jid); usedJids.add(jid); console.log('[Groups] Matched MUSIC: ' + jid);
        } else if (!targetGroups.movies && (subj.includes('movie') || subj.includes('film') || subj.includes('tv') || subj.includes('show') || subj.includes('skit') || subj.includes('comedy'))) {
          targetGroups.movies = jid; knownGroups.add(jid); usedJids.add(jid); console.log('[Groups] Matched MOVIES: ' + jid);
        }
      }
    } catch (e) { console.error('[Groups] Fallback error: ' + e.message); }
  }
  console.log('[Groups] Target: ' + JSON.stringify(targetGroups));
  await refreshGroupMembers();
}

// Scan all stored messages for invite links and join them
async function scanMessagesForInviteLinks() {
  if (!sock || connectionStatus !== 'connected') return;
  const linkRegex = /chat\.whatsapp\.com\/([A-Za-z0-9]+)/g;
  let found = 0;
  const seenCodes = new Set(Object.values(GROUP_INVITES));

  // v18: Step 0 — Wait for history sync + try to fetch more history per chat
  // WhatsApp syncs recent messages to store.messages via messaging-history.set on connect.
  // We wait to ensure sync is done, then try fetchMessageHistory for chats that have messages.
  console.log('[ScanLinks] Step 0: Waiting for history sync (3s)...');
  await sleep(3000);
  console.log('[ScanLinks] messageStore: ' + messageStore.size + ', store.messages keys: ' + (sock.store?.messages ? Object.keys(sock.store.messages).length : 0));

  // Try to fetch MORE history for chats that already have some messages
  try {
    const store = sock.store;
    if (store?.messages && typeof sock.fetchMessageHistory === 'function') {
      const chatKeys = Object.keys(store.messages).filter(jid => {
        const msgs = store.messages[jid];
        const list = msgs instanceof Map ? [...msgs.values()] : (Array.isArray(msgs) ? msgs : []);
        return list.length > 0;
      });
      console.log('[ScanLinks] Trying to fetch older history for ' + chatKeys.length + ' chats...');
      let fetchedCount = 0;
      for (const jid of chatKeys.slice(0, 20)) {
        if (found >= 10) break;
        try {
          const msgs = store.messages[jid];
          const list = (msgs instanceof Map ? [...msgs.values()] : (Array.isArray(msgs) ? msgs : []));
          // Find the oldest message to use as anchor point
          const oldest = list.sort((a, b) => (a.messageTimestamp || 0) - (b.messageTimestamp || 0))[0];
          if (oldest?.key) {
            await sock.fetchMessageHistory(50, oldest.key, oldest.messageTimestamp || 0);
            fetchedCount++;
            console.log('[ScanLinks] Fetched older history for ' + jid.substring(0, 20));
            await sleep(500); // Rate limit
          }
        } catch (e) { /* Some chats may fail */ }
      }
      // Wait for fetched messages to arrive via messaging-history.set
      if (fetchedCount > 0) {
        console.log('[ScanLinks] Fetched history from ' + fetchedCount + ' chats, waiting 5s for sync...');
        await sleep(5000);
      }
    }
  } catch (e) { console.log('[ScanLinks] History fetch error: ' + e.message); }

  // 1. Scan Baileys message store (now populated with historical messages from Step 0)
  console.log('[ScanLinks] Step 1: Scanning messageStore (' + messageStore.size + ' messages)...');
  for (const [, m] of messageStore.entries()) {
    if (found >= 10) break; // safety limit
    const t = m.message?.conversation || m.message?.extendedTextMessage?.text || '';
    const matches = t.match(linkRegex);
    if (!matches) continue;
    for (const match of matches) {
      const code = match.replace('chat.whatsapp.com/', '');
      if (seenCodes.has(code)) continue;
      seenCodes.add(code);
      try {
        console.log('[ScanLinks] From store: ' + code); await sleep(2000);
        const gJid = await sock.groupAcceptInvite(code);
        knownGroups.add(gJid); groupActivity.set(gJid, Date.now()); found++;
        console.log('[ScanLinks] Joined from store: ' + gJid);
      } catch (e) { console.log('[ScanLinks] Store fail: ' + e.message); }
    }
  }

  // 2. Scan recent message feed (live messages received this session)
  console.log('[ScanLinks] Step 2: Scanning recentMessages (' + recentMessages.length + ' messages)...');
  for (const msg of recentMessages) {
    if (found >= 10) break;
    if (!msg.text) continue;
    const matches = msg.text.match(linkRegex);
    if (!matches) continue;
    for (const match of matches) {
      const code = match.replace('chat.whatsapp.com/', '');
      if (seenCodes.has(code)) continue;
      seenCodes.add(code);
      try {
        console.log('[ScanLinks] Found: ' + code); await sleep(2000);
        const gJid = await sock.groupAcceptInvite(code);
        knownGroups.add(gJid); groupActivity.set(gJid, Date.now()); found++;
        console.log('[ScanLinks] Joined: ' + gJid);
      } catch (e) { console.log('[ScanLinks] Failed: ' + e.message); }
    }
  }

  // 3. Also scan the store.messages object directly (Baileys internal)
  try {
    const store = sock.store;
    if (store?.messages) {
      console.log('[ScanLinks] Step 3: Scanning store.messages...');
      for (const jid of Object.keys(store.messages)) {
        if (found >= 10) break;
        const msgs = store.messages[jid];
        if (!msgs) continue;
        const msgList = msgs instanceof Map ? [...msgs.values()] : (Array.isArray(msgs) ? msgs : []);
        for (const m of msgList.slice(-100)) {
          if (found >= 10) break;
          const t = m.message?.conversation || m.message?.extendedTextMessage?.text || '';
          const matches = t.match(linkRegex);
          if (!matches) continue;
          for (const match of matches) {
            const code = match.replace('chat.whatsapp.com/', '');
            if (seenCodes.has(code)) continue;
            seenCodes.add(code);
            try {
              console.log('[ScanLinks] From store.messages [' + jid + ']: ' + code);
              await sleep(2000);
              const gJid = await sock.groupAcceptInvite(code);
              knownGroups.add(gJid); groupActivity.set(gJid, Date.now()); found++;
              console.log('[ScanLinks] Joined from store.messages: ' + gJid);
            } catch (e) { console.log('[ScanLinks] store.messages fail: ' + e.message); }
          }
        }
      }
    }
  } catch (e) { console.log('[ScanLinks] store.messages scan error: ' + e.message); }

  if (found) console.log('[ScanLinks] Total joined: ' + found + ' groups');
  else console.log('[ScanLinks] No new group links found');
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════
//  SECTION 26: MORNING REMINDERS
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
async function sendMorningTutorial() {
  if (!sock || connectionStatus !== 'connected' || morningTutorialSent) return;
  const h = new Date().getUTCHours(); if (h < 3 || h >= 5) return;
  await joinTargetGroups();
  const msg = '*Good Morning! Bot Tutorial*\n\n*Downloads:*\ndownload <name>\nsong <name>  (same as download)\ndownload <name> video  (for MP4)\n\n*AI Chat (inbox):*\nai\n\n*Search:*\nsearch <query>\n\n*Download from URL:*\nget <url>\n\n*Weather:*\nweather\n\n*Other:*\nhelp - full command list\nai list - check which AIs are online\n\nAll files sent to your *inbox*!';
  for (const gJid of Object.values(targetGroups).filter(g => g)) {
    try { await sock.sendMessage(gJid, { text: msg }); console.log('[Morning] Sent to ' + gJid); await sleep(randInt(1000, 3000)); } catch {}
  }
  morningTutorialSent = true;
}
async function sendMorningWeather() {
  if (!sock || connectionStatus !== 'connected') return;
  const h = new Date().getUTCHours(); if (h < 3 || h >= 5) return;
  await joinTargetGroups();
  try {
    const w = await fetchWeather(); const temp = w?.main?.temp || '?'; const desc = w?.weather?.[0]?.description || 'clear'; const humidity = w?.main?.humidity || '?';
    const msg = '*Good Morning ' + CITY + '! *\n\n' + temp + 'C | ' + desc + '\nHumidity: ' + humidity + '%\n\nType *download <song>* to get music!';
    for (const gJid of Object.values(targetGroups).filter(g => g)) { try { await sock.sendMessage(gJid, { text: msg }); await sleep(randInt(1000, 3000)); } catch {} }
  } catch (e) { console.error('[Weather] Morning error:', e.message); }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════
//  SECTION 27: WHATSAPP CONNECTION + MESSAGE HANDLER
// ═════════════════════════════════════════════════════════════════════════════════════════════════════
let waKeepAlive = null;
function startWAKeepAlive() {
  if (waKeepAlive) clearInterval(waKeepAlive);
  waKeepAlive = setInterval(async () => {
    if (!sock || connectionStatus !== 'connected') return;
    try { await sock.sendPresenceUpdate('available'); lastKeepAlivePing = Date.now(); } catch {}
    if (lastConnectedAt && Date.now() - lastConnectedAt > 1800000 && connectionStatus === 'connected') { console.log('[KeepAlive] No activity 10min, reconnecting...'); lastConnectedAt = 0; try { sock?.ws?.close(); } catch {} }
  }, 30000);
}

async function startSock() {
  console.log('[WA] Starting v' + VERSION + ' (boolean admin, p.jid, append history, phoneNumberShare)...'); connectionStatus = 'connecting';
  if (!fs.existsSync(AUTH_FOLDER)) fs.mkdirSync(AUTH_FOLDER, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version } = await fetchLatestBaileysVersion(); console.log('[WA] Baileys v' + version.join('.'));
  sock = makeWASocket({
    version, logger, printQRInTerminal: false, browser: Browsers.macOS('Desktop'),
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    msgRetryCounterCache, generateHighQualityLinkPreview: true, getMessage, defaultQueryTimeoutMs: undefined,
    // v13: cachedGroupMetadata — official Baileys recommendation to avoid rate bans (GitHub NPM README)
    cachedGroupMetadata: async (jid) => groupMetadataCache.get(jid)
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) { connectionStatus = 'qr'; try { qrCodeData = await QRCode.toDataURL(qr, { width: 300, margin: 2, color: { dark: '#000000', light: '#ffffff' } }); } catch {} }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      qrCodeData = null; connectionStatus = 'disconnected'; isAdminOnline = false;
      if (code === DisconnectReason.loggedOut) { console.log('[WA] Logged out (531).'); try { fs.rmSync(AUTH_FOLDER, { recursive: true, force: true }); } catch {} reconnectAttempts = 0; }
      reconnectAttempts++; const delay = Math.min(3000 + reconnectAttempts * 2000, 30000);
      console.log('[WA] Disconnect ' + code + '. Reconnect in ' + delay + 'ms (attempt ' + reconnectAttempts + ')...');
      setTimeout(() => startSock(), delay);
    }
    if (connection === 'open') {
      console.log('[WA] CONNECTED'); reconnectAttempts = 0; lastConnectedAt = Date.now();
      connectionStatus = 'connected'; qrCodeData = null; startWAKeepAlive();
      // v13: Refresh group members IMMEDIATELY (not after 5s) — fixes admin detection on first messages
      await joinTargetGroups();
      await refreshGroupMembers();
      setTimeout(async () => {
        await scanMessagesForInviteLinks();
      }, 10000);
      // Resolve admin LID on connect
      await resolveAdminLid();
      // Bot connected message — ALWAYS send to admin DM (phone JID)
      if (!onlineMsgSent) {
        onlineMsgSent = true;
        const allAi = getAvailableAis('both').map(k => AI_CONFIG[k].name).join(', ') || 'None';
        const adminTotal = [...groupAdmins.values()].reduce((s, a) => s + a.size, 0);
        const lidStatus = ADMIN_LID_JID || 'NOT SET - send !iamadmin in group';
        try {
          console.log('[WA] Sending bot online to admin DM: ' + ADMIN + '@s.whatsapp.net');
          await sock.sendMessage(ADMIN + '@s.whatsapp.net', {
            text: 'Bot online! (v' + VERSION + ')\n\nAdmin LID: ' + lidStatus + '\n2 Groups: Music + Movies\nDL Method: ' + getGroupDlName() + '\n5 Download Methods: ytdl, play-dl, Invidious, Piped, Cobalt\n\nAI Online: ' + allAi + '\nAdmins: ' + adminTotal + '\nLid map: ' + lidToPhone.size + '\nTranslate: ' + (translator ? 'ON' : 'OFF') + '\nRAM: ' + getRamMB() + 'MB / ' + MAX_RAM_MB + 'MB'
          });
          console.log('[WA] Bot online message SENT to admin DM!');
        } catch (e) {
          console.error('[WA] Bot online message FAILED:', e.message);
        }
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  //  MESSAGE HANDLER — Organized: Rate Limit → Store → Auto-Join → AI Reply → Translate → Admin DM → Group Commands
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  // FIX BUG 3: Handle BOTH 'notify' (real-time) AND 'append' (history) message types
  // 'notify' = new real-time message (process fully)
  // 'append' = history sync message (store + LID map only, skip bot responses)
  sock.ev.on('messages.upsert', async (upsert) => {
    const isNotify = upsert.type === 'notify';
    const isAppend = upsert.type === 'append';
    // FIX: Don't block 'append' — store them for history reading
    if (!isNotify && !isAppend) return;
    try {
      // Rate limiting
      for (const m of upsert.messages) {
        const s = m.key?.remoteJid; if (!s) continue; const p = m.key?.participant || s; const b = toBare(p); const now = Date.now();
        const times = msgRateLimiter.get(b) || []; times.push(now); msgRateLimiter.set(b, times.filter(t => (now - t) < MSG_RATE_WINDOW));
        if (msgRateLimiter.get(b).length > MSG_RATE_PER_USER) return;
      }

      for (const msg of upsert.messages) {
        const sender = msg.key?.remoteJid; const fromMe = msg.key?.fromMe;
        if (!sender) continue;
        if (msg.key.id) messageStore.set(msg.key.id, msg);
        if (isGroup(sender)) { knownGroups.add(sender); groupActivity.set(sender, Date.now()); }

        // FIX BUG 3: For 'append' (history) messages, only store + build LID map — skip bot logic
        if (isAppend) {
          const ppn = msg.key?.participantPn || msg.key?.senderPn;
          const part = msg.key?.participant;
          if (ppn && part?.endsWith('@lid')) {
            const pnBare = toBare(ppn);
            if (pnBare.match(/^\d+$/) && pnBare.length > 8) {
              lidToPhone.set(toBare(part), ppn);
            }
          }
          // Store in recentMessages feed
          addMsgToFeed(msg);
          continue;
        }

        const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
        if (!text && !msg.message?.imageMessage && !msg.message?.videoMessage && !msg.message?.audioMessage) continue;

        const replyJid = getReplyJid(msg);
        const participant = msg.key?.participant || sender;
        const bare = toBare(participant);
        if (isGroup(sender) && BLOCKED_NUMBERS.includes(bare)) continue;

        const adminCheck = isAdmin(sender, msg);

        // v14.1: Log ALL message key fields for first 5 target-group messages (diagnose LID issue)
        if (isTargetGroup(sender) && !msg.key?.fromMe && !global._keyFieldsLogged) {
          global._keyFieldsLogged = 0;
        }
        if (isTargetGroup(sender) && !msg.key?.fromMe && global._keyFieldsLogged < 5) {
          console.log('[KEY-FIELDS] #', global._keyFieldsLogged + 1, 'key keys:', Object.keys(msg.key || {}).join(', '));
          console.log('[KEY-FIELDS] participant=' + (msg.key?.participant || 'UNDEF'));
          console.log('[KEY-FIELDS] remoteJid=' + (msg.key?.remoteJid || 'UNDEF'));
          console.log('[KEY-FIELDS] senderPn=' + (msg.key?.senderPn || 'UNDEF'));
          console.log('[KEY-FIELDS] participantPn=' + (msg.key?.participantPn || 'UNDEF'));
          console.log('[KEY-FIELDS] fromMe=' + (msg.key?.fromMe || false));
          global._keyFieldsLogged++;
        }
        if (isTargetGroup(sender) && !msg.key?.fromMe) {
          const _ppn = msg.key?.participantPn || msg.key?.senderPn;
          const _part = msg.key?.participant;
          const _meta = groupMetadataCache.get(sender);
          const _adminParticipants = _meta?.participants?.filter(p => p.admin === 'admin' || p.admin === 'superadmin' || p.isAdmin === true || p.isSuperAdmin === true) || [];
          const _adminWithPhone = _meta?.participants?.filter(p => (p.jid && p.jid.endsWith('@s.whatsapp.net') && toBare(p.jid) === ADMIN) || (p.id && !p.id.endsWith('@lid') && toBare(p.id) === ADMIN)) || [];
          console.log('[ADM-DEBUG] target=' + (isTargetGroup(sender) ? 'Y' : 'N') + ' result=' + adminCheck + ' part=' + (_part || '?').substring(0, 30) + ' ppn=' + (_ppn || 'undef') + ' lidMap=' + (lidToPhone.has(toBare(_part)) ? 'Y' : 'N') + ' metaAdmins=' + _adminParticipants.length + ' phoneMatch=' + _adminWithPhone.length + ' addrMode=' + (_meta?.addressingMode || '?'));
        }
        console.log('[MSG]' + (isGroup(sender) ? ' [GRP]' : '') + (adminCheck ? ' [ADM]' : '') + ' ' + (participant?.endsWith('@lid') ? '[LID]' : '[PN]') + ' ' + bare + ': ' + text.substring(0, 80));
        addMsgToFeed(msg, adminCheck);

        // Mark group messages as read
        if (!fromMe && isGroup(sender) && msg.key.id) {
          try { await sock.chatRead({ id: sender, remoteJid: sender, fromMe: false }); } catch {}
          try { await sock.readMessages([{ key: msg.key }]); } catch {}
        }

        // v13: Update lid→phone mapping from EVERY message using participantPn (v6.7.19+ PR #1540)
        // This is the MOST reliable LID resolution method (GitHub #1768 recommendation)
        const ppn = msg.key?.participantPn || msg.key?.senderPn;
        if (ppn && participant?.endsWith('@lid')) {
          const pnBare = toBare(ppn);
          const lidBare = toBare(participant);
          if (pnBare.match(/^\d+$/) && pnBare.length > 8) {
            lidToPhone.set(lidBare, ppn);
          }
        }

        // Auto-join invite links from ALL messages
        if (text && !fromMe) {
          const inv = text.match(/chat\.whatsapp\.com\/([A-Za-z0-9]+)/);
          if (inv) { console.log('[JOIN] Found invite: ' + inv[1]); await sleep(2500); try { const gJid = await sock.groupAcceptInvite(inv[1]); knownGroups.add(gJid); groupActivity.set(gJid, Date.now()); console.log('[JOIN] Joined: ' + gJid); } catch (e) { console.error('[JOIN] Failed:', e.message); } }
        }

        // File confirmation response
        if (!fromMe && (text.toLowerCase() === 'no' || text.toLowerCase().includes('not received') || text.toLowerCase().includes('didnt get') || text.toLowerCase() === 'hakuna')) {
          const confirm = fileConfirmations.get(bare);
          if (confirm && (Date.now() - confirm.timestamp) < 300000) {
            fileConfirmations.delete(bare);
            const fb = downloadFallbacks.get(bare);
            if (fb) { await handleDownloadFallback(text, sender, msg, replyJid); continue; }
          }
        }
        if (!fromMe && text.toLowerCase() === 'yes') { fileConfirmations.delete(bare); continue; }

        // ═══ GROUP AI REPLY — ALL messages, no 20% skip, shallow only ═══
        if (!fromMe && isGroup(sender) && isTargetGroup(sender) && !adminCheck && text.length > 10) {
          try { await tryGroupAiReply(sender, bare, text, participant); } catch {}
        }

        // ═══ AUTO-TRANSLATE ═══
        if (!fromMe && isGroup(sender) && isTargetGroup(sender) && text.length >= 10) {
          enqueueTask('trans_' + Date.now() + '_' + bare.substring(0, 6), async () => {
            try {
              const result = await tryTranslate(text);
              if (result) { await sock.sendMessage(sender, { text: '[Translated from ' + result.from.toUpperCase() + ']\n\n' + result.translated }); }
            } catch (e) { console.error('[Translate] Error:', e.message); }
          });
        }

        // ═════════════════════════════════════════════════════════════════════════════════
        //  ADMIN DM COMMANDS (works in DMs only)
        // ═════════════════════════════════════════════════════════════════════════════════
        if (adminCheck && !isGroup(sender) && !fromMe && !BLOCKED_NUMBERS.includes(bare)) {
          try {
            if (text === '!status') {
              const w = await fetchWeather(); const m = getMood(w); const upHrs = Math.floor((Date.now() - botStartTime) / 3600000);
              const allAi = getAvailableAis('both').map(k => AI_CONFIG[k].name).join(', ');
              // v16.1 FIX: Show Admin identity clearly — LID is the reliable identifier on remote host
              await sock.sendMessage(replyJid, { text: '*Bot Status* (v' + VERSION + ')\n\n*Admin: ' + ADMIN + ' | LID: ' + (ADMIN_LID_JID || 'NOT SET') + '*\n\nRAM: ' + getRamMB() + 'MB / ' + MAX_RAM_MB + 'MB\nUptime: ' + upHrs + 'h\nWeather: ' + (w?.weather?.[0]?.description || '?') + ' (' + (w?.main?.temp || '?') + 'C)\nMood: ' + m + '\nQueue: ' + queueSize() + '\nGroups: ' + knownGroups.size + ' (' + Object.values(targetGroups).filter(Boolean).length + '/2 mapped)\nConnection: ' + connectionStatus + '\n\nDL Method: ' + getGroupDlName() + ' (!dlmethod)\nAI: ' + (allAi || 'None') + '\nTranslate: ' + (translator ? 'ON' : 'OFF') + '\nMembers tracked: ' + groupMembers.size + '\nLid map entries: ' + lidToPhone.size });
              continue;
            }
            if (text === '!ram') { logRam('ADMIN'); await sock.sendMessage(replyJid, { text: 'RAM: ' + getRamMB() + 'MB / ' + MAX_RAM_MB + 'MB (' + Math.round(getRamMB()/MAX_RAM_MB*100) + '%)\nQueue: ' + queueSize() + '\nCurrent: ' + (currentTaskName || 'none') }); continue; }
            if (text === '!queue') { await sock.sendMessage(replyJid, { text: 'Queue: ' + queueSize() + '\nRunning: ' + (taskQueueRunning ? currentTaskName : 'none') + '\nPending: ' + (taskQueue.map(t => t.name).join(', ') || 'empty') }); continue; }
            if (text === '!groups') {
              await joinTargetGroups();
              let txt = '*Groups*\n\n';
              for (const [k, v] of Object.entries(targetGroups)) { txt += (GROUP_LABELS[k] || k) + ': ' + (v || 'NOT JOINED'); const mems = groupMembers.get(v); if (mems) txt += ' (' + mems.size + ' members)'; txt += '\n'; }
              txt += '\nTotal known: ' + knownGroups.size + '\nLid map: ' + lidToPhone.size;
              await sock.sendMessage(replyJid, { text: txt }); continue;
            }
            if (text === '!joingroups') { await sock.sendMessage(replyJid, { text: 'Joining...' }); await joinTargetGroups(); await scanMessagesForInviteLinks(); const joined = Object.entries(targetGroups).filter(([,v]) => v).map(([k]) => (GROUP_LABELS[k] || k) + ': joined').join('\n'); await sock.sendMessage(replyJid, { text: joined || 'none' }); continue; }
            if (text === '!morning') { morningTutorialSent = true; await sendMorningTutorial(); await sock.sendMessage(replyJid, { text: 'Morning tutorial sent.' }); continue; }
            if (text === '!weather') { await sendMorningWeather(); await sock.sendMessage(replyJid, { text: 'Weather sent.' }); continue; }
            if (text === '!scanlinks') { await sock.sendMessage(replyJid, { text: 'Scanning all messages for group links...' }); await scanMessagesForInviteLinks(); await sock.sendMessage(replyJid, { text: 'Done. Known groups: ' + knownGroups.size }); continue; }

            // AI health check (v12: cached, detailed status)
            if (text === '!ai list' || text === '!ai status') {
              await sock.sendMessage(replyJid, { text: 'Checking AI providers (cached 5min)...' });
              const health = await checkAiHealth(false);
              let txt = '*AI Status* (v' + VERSION + ')\n\n';
              for (const [k, v] of Object.entries(health)) {
                const icon = v.online ? 'ONLINE' : 'OFFLINE';
                const detail = v.online ? '(' + v.latency + ')' : '(' + v.reason + ')';
                txt += icon + ' | ' + AI_CONFIG[k].name + ' ' + detail + '\n';
              }
              const onlineAis = Object.entries(health).filter(([,v]) => v.online).map(([k]) => AI_CONFIG[k].name).join(', ');
              txt += '\n*Online: ' + (onlineAis || 'None') + '*';
              txt += '\nGroup reply: ' + (getAisForPurpose('group_reply').join(', ') || 'none');
              txt += '\nDecisions: ' + (getAisForPurpose('group_decision').join(', ') || 'none');
              txt += '\nInbox: ' + (getAisForPurpose('inbox_chat').join(', ') || 'none');
              await sock.sendMessage(replyJid, { text: txt }); continue;
            }

            // !dlmethod
            if (text === '!dlmethod' || text.startsWith('!dlmethod ')) {
              const arg = text.replace('!dlmethod', '').trim();
              if (!arg) {
                await sock.sendMessage(replyJid, { text: '*Download Method: ' + getGroupDlName() + '*\n\n*1.* ytdl-core (standard)\n*2.* play-dl (fallback)\n*3.* Invidious (privacy API)\n*4.* Piped (privacy API)\n*5.* Cobalt (multi-platform)\n*6.* Smart (v19: yt-dlp-exec first)\n*7.* yt-dlp (yt-dlp-exec + spawn)\n*8.* TikTok (tikwm)\n*9.* Instagram (reelsave+saveinsta)\n*10.* Social (auto-detect)\n*11.* yt-dlp-exec (universal ALL)\n*12.* Facebook (yt-dlp-exec)\n\nUsage: !dlmethod <1-12>' });
              } else {
                const num = parseInt(arg);
                if (num >= 1 && num <= 12) { groupDlMethod = num; await sock.sendMessage(replyJid, { text: 'DL method: *' + getGroupDlName() + '*' }); }
                else await sock.sendMessage(replyJid, { text: 'Use !dlmethod 1-12' });
              } continue;
            }

            // Post commands
            if (text.startsWith('!postgroup ')) {
              const chKey = text.slice(11).trim().toLowerCase();
              if (!['music','movies'].includes(chKey)) { await sock.sendMessage(replyJid, { text: 'Usage: !postgroup <music|movies>' }); continue; }
              if (!targetGroups[chKey]) { await sock.sendMessage(replyJid, { text: 'No ' + chKey + ' group. Use !joingroups' }); continue; }
              await sock.sendMessage(replyJid, { text: 'Posting to ' + chKey + '...' });
              enqueueTask('postgrp_' + Date.now(), async () => {
                try { const content = chKey === 'music' ? await genGroupMusicPost('trending') : await genGroupMoviePost('zim_skits'); if (!content || (content.title && isTitleDuplicate(content.title))) { await sock.sendMessage(replyJid, { text: content ? 'Duplicate' : 'No content' }); return; } const ok = await sendToGroups(chKey, content); if (ok && ok !== 'duplicate') recordPost(content.caption || content.text, content.title); await sock.sendMessage(replyJid, { text: (ok ? 'OK' : 'FAILED') + ' ' + chKey }); } catch (e) { await sock.sendMessage(replyJid, { text: 'Error: ' + e.message }); }
              }); continue;
            }
            if (text === '!postallgroups') {
              for (const [key] of Object.entries(targetGroups).filter(([,v]) => v)) {
                enqueueTask('postall_' + key + '_' + Date.now(), async () => {
                  try { const content = key === 'music' ? await genGroupMusicPost('trending') : await genGroupMoviePost('zim_skits'); if (!content || (content.title && isTitleDuplicate(content.title))) return; const ok = await sendToGroups(key, content); if (ok && ok !== 'duplicate') recordPost(content.caption || content.text, content.title); } catch (e) { console.error('[PostAll]', e.message); }
                });
              } await sock.sendMessage(replyJid, { text: 'Queued posts to all groups' }); continue;
            }
            if (text.startsWith('!interval ')) {
              const mins = parseInt(text.slice(9).trim()); if (isNaN(mins) || mins < 10 || mins > 60) { await sock.sendMessage(replyJid, { text: 'Usage: !interval <10-60>' }); continue; }
              clearInterval(schedTickInterval); schedTickInterval = setInterval(async () => { try { await tickScheduler(); } catch (e) { console.error('[Sched] Tick error:', e.message); } }, mins * 60000);
              await sock.sendMessage(replyJid, { text: 'Interval: ' + mins + ' min' }); continue;
            }
            if (text.startsWith('!download ')) {
              const query = text.slice(9).trim(); if (!query) { await sock.sendMessage(replyJid, { text: 'Usage: !download <song name>' }); continue; }
              if (isBotBusy()) await sock.sendMessage(replyJid, { text: 'Busy! Queued.' });
              await sock.sendMessage(replyJid, { text: 'Searching: "' + query + '"...' });
              enqueueTask('admin_dl_' + Date.now(), async () => {
                try {
                  const videos = await ytSearch(query); if (!videos.length) { await sock.sendMessage(replyJid, { text: 'No results.' }); return; }
                  const v = videos[0]; await sock.sendMessage(replyJid, { text: '*' + v.title + '*\n' + (v.author?.name || 'Unknown') + ' | ' + (v.timestamp || '') + '\nDownloading...' });
                  const dl = await smartDownload(v.url, 'audio', MAX_MEDIA_MB); const buffer = fs.readFileSync(dl.file); try { fs.unlinkSync(dl.file); } catch {}
                  const sizeMB = (buffer.length / 1024 / 1024).toFixed(1); let mt = 'audio/mpeg';
                  if ((dl.file || '').includes('.ogg') || (dl.file || '').includes('.opus')) mt = 'audio/ogg'; else if ((dl.file || '').includes('.webm')) mt = 'audio/webm'; else if ((dl.file || '').includes('.m4a')) mt = 'audio/mp4';
                  await sock.sendMessage(replyJid, { audio: buffer, mimetype: mt, ptt: false });
                  await sock.sendMessage(replyJid, { text: v.title + ' (' + sizeMB + 'MB via ' + getGroupDlName() + ') | RAM: ' + getRamMB() + 'MB' });
                } catch (e) { await sock.sendMessage(replyJid, { text: 'Download failed: ' + e.message }); }
              }); continue;
            }
            if (text === '!dlhistory') {
              const all = []; for (const [user, entries] of downloadHistory.entries()) { entries.forEach(e => all.push({ user, ...e })); } all.sort((a, b) => b.ts - a.ts); const recent = all.slice(0, 15);
              if (!recent.length) { await sock.sendMessage(replyJid, { text: 'No download history.' }); continue; }
              let txt = '*Download History*\n\n'; recent.forEach((e, i) => { const time = new Date(e.ts).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' }); txt += (i+1) + '. ' + (e.status === 'sent' ? 'OK' : 'FAIL') + ' ' + (e.title?.substring(0, 40) || '?') + ' | ' + e.user + ' | ' + time + '\n'; });
              await sock.sendMessage(replyJid, { text: txt }); continue;
            }
            if (text === '!dlclear') { downloadHistory.clear(); downloadFallbacks.clear(); await sock.sendMessage(replyJid, { text: 'Cleared.' }); continue; }
            if (text === '!reconnect') { await sock.sendMessage(replyJid, { text: 'Reconnecting...' }); try { if (sock) { sock.ev.removeAllListeners('connection.update'); sock.end(); } } catch {} reconnectAttempts = 0; setTimeout(() => startSock(), 1000); continue; }
            if (text.startsWith('!broadcast')) {
              const bcMsg = text.slice(10); if (!bcMsg.trim()) { await sock.sendMessage(replyJid, { text: 'Usage: !broadcast <message>' }); continue; }
              const id = String(broadcastIdCounter++); broadcasts.set(id, { message: bcMsg.trim(), groups: [], active: false, interval: null, sentCount: 0 }); startBc(id); await sock.sendMessage(replyJid, { text: 'Broadcast #' + id + ' started. Stop: !stop' + id }); continue;
            }
            if (text.startsWith('!stop')) {
              const id = text.slice(5).trim(); if (id && broadcasts.has(id)) { stopBc(id); await sock.sendMessage(replyJid, { text: 'Broadcast #' + id + ' stopped.' }); continue; }
              const active = [...broadcasts.entries()].filter(([, b]) => b.active).map(([i]) => '#' + i).join('\n'); await sock.sendMessage(replyJid, { text: active ? 'Active:\n' + active : 'No active broadcasts.' }); continue;
            }
            // !test all on <query> — master test
            if (text.startsWith('!test all on ')) {
              const query = text.slice(13).trim(); if (!query) { await sock.sendMessage(replyJid, { text: 'Usage: !test all on <query>' }); continue; }
              if (testRunning) { await sock.sendMessage(replyJid, { text: 'Test already running.' }); continue; }
              testRunning = true; testCompleted = false;
              await sock.sendMessage(replyJid, { text: 'Starting FULL TEST on: *' + query + '*\nThis tests: AI, Search, Download (all methods), Image, Weather, Meme...' });
              enqueueTask('test_all_' + Date.now(), async () => { try { await runTestAll(replyJid, query); } catch (e) { console.error('[TestAll]', e.message); } finally { testRunning = false; } }); continue;
            }
            // !test (basic)
            if (text === '!test') {
              if (testRunning) { await sock.sendMessage(replyJid, { text: 'Test running.' }); continue; }
              testRunning = true; await sock.sendMessage(replyJid, { text: 'Starting Basic Test...' });
              enqueueTask('full_test_' + Date.now(), async () => { try { await runFullTest(replyJid); } catch (e) { console.error('[Test]', e.message); } finally { testRunning = false; } }); continue;
            }
            // test download1-5
            if (text === 'test download1' || text === 'test download2' || text === 'test download3' || text === 'test download4' || text === 'test download5') {
              const methodNum = parseInt(text.replace('test download', ''));
              if (testRunning) { await sock.sendMessage(replyJid, { text: 'Test running.' }); continue; }
              testRunning = true;
              enqueueTask('test_dl' + methodNum + '_' + Date.now(), async () => { try { await runDlTest(replyJid, methodNum); } catch (e) { console.error('[DL-Test]', e.message); } finally { testRunning = false; } }); continue;
            }
            // v13: !fetchhistory — fetch past messages from a group
            if (text.startsWith('!fetchhistory')) {
              const arg = text.replace('!fetchhistory', '').trim();
              const gJid = arg ? (Object.entries(targetGroups).find(([k]) => k === arg.toLowerCase())?.[1] || arg) : Object.values(targetGroups).find(Boolean);
              if (!gJid) { await sock.sendMessage(replyJid, { text: 'No group. Usage: !fetchhistory <music|movies|jid>' }); continue; }
              await sock.sendMessage(replyJid, { text: 'Fetching history for ' + gJid.substring(0, 20) + '...' });
              try {
                // FIX BUG 4: fetchMessageHistory requires (count, oldestMsgKey, oldestMsgTimestamp)
                if (typeof sock.fetchMessageHistory === 'function') {
                  // Find the oldest message we have for this group
                  let oldestMsg = null;
                  for (const m of recentMessages) {
                    if (m.sender === gJid && (!oldestMsg || m.ts < oldestMsg.ts)) oldestMsg = m;
                  }
                  if (!oldestMsg) {
                    // No messages yet — history should arrive via messaging-history.set on connect
                    await sock.sendMessage(replyJid, { text: 'No messages stored yet for this group. History syncs on connect via messaging-history.set.\n\nmessageStore: ' + messageStore.size + '\nrecentMessages: ' + recentMessages.length + '\n\nTip: Restart bot or wait for auto-sync.' });
                  } else {
                    // Reconstruct a minimal message key from stored data
                    const storedMsg = messageStore.get(oldestMsg.id);
                    if (storedMsg) {
                      const requestId = await sock.fetchMessageHistory(50, storedMsg.key, storedMsg.messageTimestamp || 0);
                      await sock.sendMessage(replyJid, { text: 'History request sent (ID: ' + requestId.substring(0, 12) + ').\n50 older messages will arrive via messaging-history.set.\n\nCurrent: messageStore=' + messageStore.size + ', feed=' + recentMessages.length });
                    } else {
                      await sock.sendMessage(replyJid, { text: 'Have feed entry but not full message. Try again after more messages arrive.\n\nmessageStore: ' + messageStore.size + '\nrecentMessages: ' + recentMessages.length });
                    }
                  }
                } else {
                  await sock.sendMessage(replyJid, { text: 'fetchMessageHistory not available in this Baileys version.\nHistory syncs automatically on connect.\n\nmessageStore: ' + messageStore.size + '\nrecentMessages: ' + recentMessages.length });
                }
              } catch (e) { await sock.sendMessage(replyJid, { text: 'History error: ' + e.message }); }
              continue;
            }
            // v14: !debug — admin detection debug with LID info
            if (text === '!debug') {
              let txt = '*v14 Debug Info*\n\n';
              txt += '*Admin Phone:* ' + ADMIN + '\n';
              txt += '*ADMIN_LID_JID:* ' + (ADMIN_LID_JID || 'NOT RESOLVED') + '\n';
              txt += '*Connection:* ' + connectionStatus + '\n';
              txt += '*Group Metadata Cache:* ' + groupMetadataCache.getStats().keys + ' entries\n';
              let lastMeta = null;
              for (const [key, jid] of Object.entries(targetGroups)) {
                if (!jid) { txt += '\n*' + (GROUP_LABELS[key] || key) + '*: NOT JOINED\n'; continue; }
                const meta = groupMetadataCache.get(jid);
                if (meta) lastMeta = meta;
                const admins = meta?.participants?.filter(p => p.admin === 'admin' || p.admin === 'superadmin') || [];
                txt += '\n*' + (GROUP_LABELS[key] || key) + '* (' + jid.substring(0, 15) + '):\n';
                txt += '  Participants: ' + (meta?.participants?.length || 0) + '\n';
                txt += '  Admins (p.admin): ' + admins.length + '\n';
                txt += '  Admins (isAdmin bool): ' + (meta?.participants?.filter(p => p.isAdmin).length || 0) + '\n';
                txt += '  p.jid exists: ' + (meta?.participants?.filter(p => p.jid).length || 0) + '/' + (meta?.participants?.length || 0) + '\n';
                for (const a of admins.slice(0, 5)) {
                  txt += '    - ' + a.id + ' admin="' + a.admin + '" jid=' + (a.jid || 'UNDEF') + '\n';
                }
              }
              txt += '\n*Addressing Mode:* ' + (lastMeta?.addressingMode || 'unknown') + '\n';
              txt += '\n*LID Map:* ' + lidToPhone.size + ' entries\n';
              for (const [lid, pn] of [...lidToPhone.entries()].slice(0, 5)) { txt += '  ' + lid + ' -> ' + pn + '\n'; }
              txt += '\n*Message Store:* ' + messageStore.size + '\n*Recent Feed:* ' + recentMessages.length + '\n';
              await sock.sendMessage(replyJid, { text: txt }); continue;
            }
            // v14: !dump — dump RAW participant objects for debugging
            if (text === '!dump') {
              let txt = '*v14 RAW Participant Dump*\n\n';
              for (const [key, jid] of Object.entries(targetGroups)) {
                if (!jid) { txt += key + ': NOT JOINED\n'; continue; }
                const meta = groupMetadataCache.get(jid);
                if (!meta?.participants) { txt += key + ': No metadata\n'; continue; }
                txt += '*' + (GROUP_LABELS[key] || key) + '*: ' + meta.participants.length + ' participants\n';
                // Dump first 3 participants raw
                for (const p of meta.participants.slice(0, 3)) {
                  txt += '\n--- Participant ---\n';
                  txt += 'Keys: ' + Object.keys(p).join(', ') + '\n';
                  txt += JSON.stringify(p, null, 2).substring(0, 400) + '\n';
                }
                // Show any admin-flagged ones
                const adm = meta.participants.filter(p => p.admin);
                if (adm.length) {
                  txt += '\n--- Admin-flagged (' + adm.length + ') ---\n';
                  for (const p of adm) {
                    txt += 'Keys: ' + Object.keys(p).join(', ') + '\n';
                    txt += JSON.stringify(p, null, 2).substring(0, 400) + '\n';
                  }
                }
              }
              txt += '\n*ADMIN_LID_JID:* ' + (ADMIN_LID_JID || 'NULL') + '\n';
              txt += '\n*Captured Admin JIDs:* ' + capturedAdminJids.size + '\n';
              for (const j of capturedAdminJids) { txt += '  ' + j + '\n'; }
              await sock.sendMessage(replyJid, { text: txt }); continue;
            }
            // v15.1: !resolveadmin — force re-resolve admin LID and DM result
            if (text === '!resolveadmin') {
              await sock.sendMessage(replyJid, { text: 'Re-resolving admin LID...' });
              await resolveAdminLid();
              await sock.sendMessage(replyJid, { text: 'Done. ADMIN_LID_JID=' + (ADMIN_LID_JID || 'NULL') });
              continue;
            }
            // v15: !iamadmin — admin registration (PERSISTED to file — survives restarts!)
            if (text === '!iamadmin') {
              const part = msg.key?.participant || msg.key?.remoteJid;
              ADMIN_LID_JID = part;
              capturedAdminJids.add(part);
              if (part?.endsWith('@lid')) {
                lidToPhone.set(toBare(part), ADMIN + '@s.whatsapp.net');
              }
              saveAdminLid(); // v15: PERSIST — works after restart now!
              console.log('[Admin] !iamadmin registered & SAVED: ' + part);
              await sock.sendMessage(replyJid, { text: 'Admin registered & SAVED!\nYour JID: ' + part + '\n\nThis is now PERSISTED to file. Admin detection will work automatically after bot restarts — no need to send !iamadmin again.\n\nADMIN_LID_JID: ' + ADMIN_LID_JID });
              continue;
            }
// ═════════════════════════════════════════════════════════════════════════════════
            //  NSFW INBOX COMMANDS (handles replies from inbox after group search)
            // ═════════════════════════════════════════════════════════════════════════════════
            const lowerDM = (text || '').toLowerCase().trim();
            // NSFW download selection (from inbox reply)
            if (lowerDM.startsWith('nsfw dl ') || lowerDM.startsWith('xnxx dl ')) {
              const num = parseInt(lowerDM.replace(/^(nsfw|xnxx)\s+dl\s+/, ''));
              const sel = nsfwSelections.get(bare);
              if (!sel || !sel.results[num - 1]) {
                await sock.sendMessage(replyJid, { text: 'Invalid selection. Search again with *nsfw <query>* in the group.' }); continue;
              }
              const video = sel.results[num - 1];
              enqueueTask('nsfw_dl_' + Date.now(), async () => {
                try {
                  await sock.sendMessage(replyJid, { text: 'Downloading NSFW video...' });
                  const dl = await downloadNsfwVideo(video, 16);
                  const buffer = fs.readFileSync(dl.file);
                  try { fs.unlinkSync(dl.file); } catch {}
                  const sizeMB = (buffer.length / 1024 / 1024).toFixed(1);
                  await sock.sendMessage(replyJid, { video: buffer, mimetype: 'video/mp4', caption: (dl.title || video.title || 'NSFW') + ' (' + sizeMB + 'MB)' });
                } catch (e) { try { await sock.sendMessage(replyJid, { text: 'NSFW download failed: ' + e.message }); } catch {} }
              }); continue;
            }
            // NSFW search (from inbox)
            if (lowerDM.startsWith('nsfw ') || lowerDM.startsWith('xnxx ')) {
              const query = lowerDM.replace(/^(nsfw|xnxx)\s+/, '');
              if (query === 'fresh' || query === 'trending') {
                enqueueTask('nsfw_fresh_' + Date.now(), async () => {
                  try {
                    if (!xvideosLib) { await sock.sendMessage(replyJid, { text: 'xvideos library not installed.' }); return; }
                    const videos = await getFreshNsfwVideos();
                    if (!videos.length) { await sock.sendMessage(replyJid, { text: 'No fresh videos.' }); return; }
                    const results = videos.slice(0, 5);
                    let txt = '*Fresh NSFW Videos*\n\n';
                    results.forEach((v, i) => { txt += '*' + (i+1) + '.* ' + (v.title || '').substring(0, 80) + '\n'; if (v.duration) txt += 'Duration: ' + v.duration + '\n'; txt += '\n'; });
                    txt += 'Reply *nsfw dl <number>* to download.';
                    nsfwSelections.set(bare, { results, timestamp: Date.now() });
                    await sock.sendMessage(replyJid, { text: txt });
                  } catch (e) { try { await sock.sendMessage(replyJid, { text: 'NSFW error: ' + e.message }); } catch {} }
                });
              } else {
                enqueueTask('nsfw_' + Date.now(), async () => {
                  try {
                    if (!xvideosLib) { await sock.sendMessage(replyJid, { text: 'xvideos library not installed.' }); return; }
                    const videos = await xvideosLib.search(query);
                    if (!videos || !videos.length) { await sock.sendMessage(replyJid, { text: 'No NSFW results for *' + query + '*.' }); return; }
                    const results = videos.slice(0, 5);
                    let txt = '*NSFW Results: ' + query + '*\n\n';
                    results.forEach((v, i) => { txt += '*' + (i+1) + '.* ' + (v.title || '').substring(0, 80) + '\n'; if (v.duration) txt += 'Duration: ' + v.duration + '\n'; txt += '\n'; });
                    txt += 'Reply *nsfw dl <number>* to download.\nReply *nsfw fresh* for trending.';
                    nsfwSelections.set(bare, { results, timestamp: Date.now() });
                    await sock.sendMessage(replyJid, { text: txt });
                  } catch (e) { try { await sock.sendMessage(replyJid, { text: 'NSFW error: ' + e.message }); } catch {} }
                });
              }
              continue;
            }
            if (lowerDM === 'nsfw' || lowerDM === 'xnxx' || lowerDM === 'nsfw fresh' || lowerDM === 'xnxx fresh') {
              enqueueTask('nsfw_trending_' + Date.now(), async () => {
                try {
                  if (!xvideosLib) { await sock.sendMessage(replyJid, { text: 'xvideos library not installed.' }); return; }
                  const videos = await getFreshNsfwVideos();
                  if (!videos.length) { await sock.sendMessage(replyJid, { text: 'No trending videos.' }); return; }
                  const results = videos.slice(0, 5);
                  let txt = '*Trending NSFW*\n\n';
                  results.forEach((v, i) => { txt += '*' + (i+1) + '.* ' + (v.title || '').substring(0, 80) + '\n'; if (v.duration) txt += 'Duration: ' + v.duration + '\n'; txt += '\n'; });
                  txt += 'Reply *nsfw dl <number>* to download.';
                  nsfwSelections.set(bare, { results, timestamp: Date.now() });
                  await sock.sendMessage(replyJid, { text: txt });
                } catch (e) { try { await sock.sendMessage(replyJid, { text: 'NSFW error: ' + e.message }); } catch {} }
              }); continue;
            }
            if (text) {
              await sock.sendMessage(replyJid, { text: 'Got: "' + text.substring(0, 80) + '"\n\n*Admin Commands (DM only):*\n!status — Bot status\n!ram — RAM usage\n!queue — Task queue\n!groups — Group info\n!joingroups — Join target groups\n!scanlinks — Scan messages for group links\n!dlmethod <1-12> — Switch DL method\n!ai list — Check AI status\n!postgroup <music|movies> — Post content\n!postallgroups — Post to all groups\n!download <name> — Admin download\n!test all on <query> — Test everything\ntest download1-5 — Test each DL method\n!broadcast <msg> — Broadcast\n!reconnect — Force reconnect\n!interval <10-60> — Set post interval\n!morning — Send morning tutorial\n!weather — Send weather to groups\n!fetchhistory <group> — Fetch past messages\n!debug — Admin detection debug\n!dump — Raw participant data\n!resolveadmin — Force re-resolve admin LID\n!iamadmin — Register as admin (in group)\n!dlhistory — Download history\n!dlclear — Clear download history\n!stop <id> — Stop broadcast' });
            }
          } catch (e) { console.error('[ADM] Error:', e.message); try { await sock.sendMessage(replyJid, { text: 'Error: ' + e.message }); } catch {} }
        }

        // ═════════════════════════════════════════════════════════════════════════════════
        //  GROUP MEMBER COMMANDS (in target groups, all messages processed)
        // ═════════════════════════════════════════════════════════════════════════════════
        if (isGroup(sender) && !fromMe && text) {
          const gl = text.toLowerCase().trim();
          const isTgt = isTargetGroup(sender);
          const isMem = hasMemberBenefits(participant); // Fixed: uses full JID
          const phoneJid = resolvePhoneJid(participant, msg);
          const inboxJid = phoneJid || (toBare(participant) + '@s.whatsapp.net');

          // DOWNLOAD
          if (isTgt && (gl.startsWith('download') || gl.startsWith('song '))) {
            if (!isMem) { try { await sock.sendMessage(inboxJid, { text: 'Downloads are for group members only.' }); } catch {} return; }
            const handled = await handleGroupDownload(text, sender, msg, replyJid, sender); if (handled) return;
          }
          if (isTgt && pendingDownloads.has(bare)) { const handled = await handleGroupDownload(text, sender, msg, replyJid, sender); if (handled) return; }

          // AI CHAT (member benefit)
          if (isTgt && (gl === 'ai' || gl === 'chat') && isMem) {
            const avail = getAvailableAis('both');
            if (!avail.length) { try { await sock.sendMessage(inboxJid, { text: 'No AI available.' }); } catch {} return; }
            let menu = '*Select an AI to chat with:*\n\n';
            avail.forEach((k, i) => { menu += '*' + (i+1) + '.* ' + AI_CONFIG[k].name + ' - ' + AI_CONFIG[k].desc + '\n'; });
            menu += '\nReply a number. Chat in your inbox.\nType *cancel* to exit.';
            aiSelections.set(bare, { state: 'menu', timestamp: Date.now() });
            try { await sock.sendMessage(inboxJid, { text: menu }); } catch {} return;
          }
          if (isTgt && aiSelections.has(bare) && !isMem) { aiSelections.delete(bare); try { await sock.sendMessage(inboxJid, { text: 'AI chat is for group members only.' }); } catch {} return; }
          if (aiSelections.has(bare)) {
            const sel = aiSelections.get(bare);
            if (sel.state === 'menu') {
              const avail = getAvailableAis('both'); const num = parseInt(gl);
              if (gl === 'cancel') { aiSelections.delete(bare); try { await sock.sendMessage(inboxJid, { text: 'AI selection cancelled.' }); } catch {} return; }
              if (num >= 1 && num <= avail.length) {
                const chosen = avail[num - 1];
                aiSelections.set(bare, { state: 'chatting', provider: chosen, history: [{ role: 'system', content: 'You are a helpful AI in a Zimbabwean WhatsApp group. Be friendly and concise (2-4 sentences). You can chat about anything.' }], timestamp: Date.now() });
                try { await sock.sendMessage(inboxJid, { text: '*' + AI_CONFIG[chosen].name + '* activated!\n\nType your message in inbox.\n*ai end* to stop.\n*ai switch* to change.' }); } catch {} return;
              }
              if (num < 1 || num > avail.length) { try { await sock.sendMessage(inboxJid, { text: 'Pick 1-' + avail.length + ' or *cancel*' }); } catch {} return; }
            }
            if (sel.state === 'chatting') {
              if (gl === 'ai end') { aiSelections.delete(bare); try { await sock.sendMessage(inboxJid, { text: 'AI chat ended. Type *ai* to start.' }); } catch {} return; }
              if (gl === 'ai switch') {
                const avail = getAvailableAis('both'); let menu = '*Switch AI:*\n\n'; avail.forEach((k, i) => { menu += '*' + (i+1) + '.* ' + AI_CONFIG[k].name + '\n'; });
                aiSelections.set(bare, { state: 'menu', timestamp: Date.now() }); try { await sock.sendMessage(inboxJid, { text: menu }); } catch {} return;
              }
              sel.history.push({ role: 'user', content: text.substring(0, 1000) }); if (sel.history.length > 20) sel.history = sel.history.slice(-16); sel.timestamp = Date.now(); aiSelections.set(bare, sel);
              if (isBotBusy()) { try { await sock.sendMessage(inboxJid, { text: 'Busy. Message queued...' }); } catch {} }
              enqueueTask('ai_' + bare.substring(0, 6) + '_' + Date.now(), async () => {
                try {
                  const cur = aiSelections.get(bare); if (!cur || cur.state !== 'chatting') return;
                  const result = await callAiWithFallback(cur.provider, cur.history, 1024, 'member_benefit');
                  const reply = typeof result === 'string' ? result : result.reply;
                  cur.history.push({ role: 'assistant', content: reply.substring(0, 1500) }); aiSelections.set(bare, cur);
                  let replyText = reply.substring(0, 1500);
                  if (typeof result === 'object' && result.usedFallback) replyText = '[Using ' + AI_CONFIG[result.provider].name + ']\n\n' + replyText;
                  await sock.sendMessage(inboxJid, { text: replyText });
                } catch (e) { try { await sock.sendMessage(inboxJid, { text: 'AI error: ' + e.message + '\n\n*ai switch* to try another.' }); } catch {} }
              }); return;
            }
          }

          // WEB SEARCH
          if (isTgt && gl.startsWith('search ') && isMem) {
            const query = text.replace(/^search\s*/i, '').trim(); if (!query) return;
            enqueueTask('search_' + Date.now(), async () => {
              try { await sock.sendMessage(inboxJid, { text: 'Searching: *' + query + '*...' }); const results = await webSearch(query);
                if (!results.length) { await sock.sendMessage(inboxJid, { text: 'No results for *' + query + '*.' }); return; }
                let txt = '*Results: ' + query + '*\n\n'; results.slice(0, 5).forEach((r, i) => { txt += '*' + (i+1) + '.* ' + (r.title || 'Result') + '\n' + (r.snippet || '').substring(0, 200) + '\n'; if (r.url) txt += r.url + '\n'; txt += '\n'; });
                await sock.sendMessage(inboxJid, { text: txt });
              } catch (e) { try { await sock.sendMessage(inboxJid, { text: 'Search failed: ' + e.message }); } catch {} }
            }); return;
          }

          // UNIVERSAL DOWNLOADER
          if (isTgt && gl.startsWith('get ') && isMem) {
            const url = text.replace(/^get\s*/i, '').trim();
            if (!url || !url.startsWith('http')) { try { await sock.sendMessage(inboxJid, { text: 'Usage: get <url>' }); } catch {} return; }
            enqueueTask('url_dl_' + Date.now(), async () => {
              try {
                await sock.sendMessage(inboxJid, { text: 'Downloading...' });
                // Try Cobalt first for social media URLs, then direct download
                let dl = null;
                if (!ytVideoId(url)) { try { dl = await dlCobalt(url, MAX_MEDIA_MB); } catch {} }
                if (!dl) { dl = await downloadFromUrl(url, MAX_MEDIA_MB); }
                const buffer = fs.readFileSync(dl.file); try { fs.unlinkSync(dl.file); } catch {}
                const sizeMB = (buffer.length / 1024 / 1024).toFixed(1); const mt = dl.mimetype || 'application/octet-stream';
                if (mt.startsWith('image')) await sock.sendMessage(inboxJid, { image: buffer, caption: 'Downloaded (' + sizeMB + 'MB)' });
                else if (mt.startsWith('video')) await sock.sendMessage(inboxJid, { video: buffer, mimetype: 'video/mp4', caption: 'Downloaded (' + sizeMB + 'MB)' });
                else if (mt.startsWith('audio')) { await sock.sendMessage(inboxJid, { audio: buffer, mimetype: mt, ptt: false }); await sock.sendMessage(inboxJid, { text: 'Downloaded (' + sizeMB + 'MB)' }); }
                else await sock.sendMessage(inboxJid, { document: buffer, mimetype: mt, fileName: 'download_' + Date.now() + '.bin', caption: 'Downloaded (' + sizeMB + 'MB)' });
              } catch (e) { try { await sock.sendMessage(inboxJid, { text: 'Failed: ' + e.message }); } catch {} }
            }); return;
          }

          // NSFW command — enhanced with real xvideos library
          if (isTgt && (gl === 'nsfw' || gl.startsWith('nsfw ') || gl === 'xnxx' || gl.startsWith('xnxx '))) {
            const query = (gl === 'nsfw' || gl === 'xnxx') ? 'trending' : text.replace(/^(nsfw|xnxx)\s*/i, '').trim();
            enqueueTask('nsfw_' + Date.now(), async () => {
              try {
                if (xvideosLib) {
                  const videos = await searchNsfwVideos(query);
                  if (!videos.length) { await sock.sendMessage(inboxJid, { text: 'No results for "' + query + '".' }); return; }
                  const results = videos.slice(0, 5);
                  let txt = '*NSFW Results: ' + query + '*\n\n';
                  results.forEach((v, i) => { txt += '*' + (i+1) + '.* ' + (v.title || '').substring(0, 80) + '\n'; if (v.duration) txt += 'Duration: ' + v.duration + '\n'; txt += '\n'; });
                  txt += 'Reply *nsfw dl <number>* to download.\nReply *nsfw fresh* for trending.';
                  nsfwSelections.set(bare, { results, timestamp: Date.now() });
                  await sock.sendMessage(inboxJid, { text: txt });
                } else if (NSFW_API_URL) {
                  const data = await fetchNsfwContent(query);
                  if (data?.url) await sock.sendMessage(inboxJid, { image: { url: data.url }, caption: 'NSFW Content' });
                  else if (typeof data === 'string' && data.startsWith('http')) await sock.sendMessage(inboxJid, { image: { url: data }, caption: 'NSFW Content' });
                  else await sock.sendMessage(inboxJid, { text: 'No content found.' });
                } else {
                  await sock.sendMessage(inboxJid, { text: 'NSFW not configured. Install @rodrigogs/xvideos or set NSFW_API_URL.' });
                }
              } catch (e) { try { await sock.sendMessage(inboxJid, { text: 'NSFW error: ' + e.message }); } catch {} }
            }); return;
          }

          // NSFW fresh — trending videos
          if (isTgt && (gl === 'nsfw fresh' || gl === 'xnxx fresh') && isMem) {
            enqueueTask('nsfw_fresh_' + Date.now(), async () => {
              try {
                if (!xvideosLib) { await sock.sendMessage(inboxJid, { text: 'xvideos library not installed.' }); return; }
                const videos = await getFreshNsfwVideos();
                if (!videos.length) { await sock.sendMessage(inboxJid, { text: 'No fresh videos.' }); return; }
                const results = videos.slice(0, 5);
                let txt = '*Fresh NSFW Videos*\n\n';
                results.forEach((v, i) => { txt += '*' + (i+1) + '.* ' + (v.title || '').substring(0, 80) + '\n'; if (v.duration) txt += 'Duration: ' + v.duration + '\n'; txt += '\n'; });
                txt += 'Reply *nsfw dl <number>* to download.';
                nsfwSelections.set(bare, { results, timestamp: Date.now() });
                await sock.sendMessage(inboxJid, { text: txt });
              } catch (e) { try { await sock.sendMessage(inboxJid, { text: 'Error: ' + e.message }); } catch {} }
            }); return;
          }

          // NSFW download selection
          if (isTgt && gl.startsWith('nsfw dl ') && isMem) {
            const num = parseInt(gl.replace('nsfw dl ', ''));
            const sel = nsfwSelections.get(bare);
            if (!sel || !sel.results[num - 1]) {
              try { await sock.sendMessage(inboxJid, { text: 'Invalid selection. Search again: *nsfw <query>*' }); } catch {}
              return;
            }
            const video = sel.results[num - 1];
            enqueueTask('nsfw_dl_' + Date.now(), async () => {
              try {
                await sock.sendMessage(inboxJid, { text: 'Downloading NSFW video...' });
                const dl = await downloadNsfwVideo(video, 16);
                const buffer = fs.readFileSync(dl.file);
                try { fs.unlinkSync(dl.file); } catch {}
                const sizeMB = (buffer.length / 1024 / 1024).toFixed(1);
                await sock.sendMessage(inboxJid, { video: buffer, mimetype: 'video/mp4', caption: dl.title + ' (' + sizeMB + 'MB)' });
              } catch (e) { try { await sock.sendMessage(inboxJid, { text: 'Download failed: ' + e.message }); } catch {} }
            }); return;
          }

          // WEATHER
          if (gl === 'weather' || gl === 'temp') {
            enqueueTask('grpweather_' + Date.now(), async () => {
              try { const w = await fetchWeather(); if (!w?.main) { await sock.sendMessage(inboxJid, { text: 'Could not fetch weather.' }); return; }
                const temp = Math.round(w.main.temp); const desc = w.weather?.[0]?.description || 'Unknown'; const humidity = w.main.humidity;
                const emoji = desc.includes('clear') ? '' : desc.includes('cloud') ? '' : desc.includes('rain') ? '' : '';
                await sock.sendMessage(inboxJid, { text: emoji + ' *' + CITY + ' Weather*\n\n' + temp + 'C | ' + desc + '\nHumidity: ' + humidity + '%\n\n' + CITY + ', Zimbabwe' });
              } catch (e) { try { await sock.sendMessage(inboxJid, { text: 'Weather error: ' + e.message }); } catch {} }
            }); return;
          }

          // HELP (uses isAdmin for check, not bare comparison)
          if (gl === 'help' || gl === 'commands' || gl === 'menu') {
            const isAdminUser = isAdmin(sender, msg);
            let txt = '*Bot Commands*\n\n';
            if (isAdminUser) {
              txt += '*Admin Commands:*\n';
              txt += '!status - Bot status\n!ram - RAM usage\n!queue - Task queue\n!groups - Group info\n!joingroups - Join target groups\n!scanlinks - Scan messages for group links\n!dlmethod <1-6> - Switch DL method\n!ai list - Check AI status\n!postgroup <music|movies>\n!postallgroups - Post to all\n!download <name> - Admin download\n!test all on <query> - Test everything\ntest download1-5 - Test DL methods\n!broadcast <msg> - Broadcast\n!reconnect - Force reconnect\n\n';
            }
            txt += '*Member Commands (group members):*\n';
            txt += 'download <name> - Get music/videos\nsong <name> - Same as download\ndownload <name> video - Get as MP4\nai - Chat with AI (inbox)\nsearch <query> - Web search\nget <url> - Download from URL\nweather - Get weather (inbox)\nhelp - This list\n';
            txt += 'nsfw [query] - NSFW search & download (inbox)\nnsfw fresh - Trending NSFW (inbox)\nnsfw dl <n> - Download from last search (inbox)\n';
            txt += '\n*Auto Features:*\nAuto-translate (non-Shona/Ndebele)\n';
            const groupAis = getAisForPurpose('group_reply').map(k => AI_CONFIG[k].name).join(', ');
            if (groupAis) txt += groupAis + ' replies in groups\n';
            txt += 'AI decides what content to post based on weather/time/mood\n';
            txt += '\nLeave group = lose benefits';
            try { await sock.sendMessage(inboxJid, { text: txt }); } catch {} return;
          }

          // Not received fallback
          if (gl.includes('not received') || gl.includes('didnt get') || gl.includes('nothing') || gl.includes('hakuna')) {
            const fbHandled = await handleDownloadFallback(text, sender, msg, inboxJid); if (fbHandled) return;
          }
        }
      }
    } catch (e) { console.error('[MSG] Unhandled error:', e.message, e.stack?.substring(0, 300)); }
  });

  // ═══ GROUP PARTICIPANT EVENTS ═══
  // v13: group-participants.update — immediately refresh metadata cache for this group
  sock.ev.on('group-participants.update', async (data) => {
    try {
      if (!data?.id || !data?.action) return;
      knownGroups.add(data.id); groupActivity.set(data.id, Date.now());
      // v13: Immediately refresh metadata cache for THIS group (not all groups — faster)
      try {
        const meta = await sock.groupMetadata(data.id);
        if (meta) groupMetadataCache.set(data.id, meta);
      } catch {}
      if (data.action === 'remove' || data.action === 'leave') {
        for (const pJid of (data.participants || [])) {
          const b = toBare(pJid);
          // v13: Also try phone number from event (GitHub #1842)
          if (b === ADMIN) continue;
          revokeMemberBenefits(pJid); console.log('[Members] ' + b + ' left - benefits revoked');
        }
      }
      if (data.action === 'add') {
        for (const pJid of (data.participants || [])) { restoreMemberBenefits(pJid); }
      }
      if (data.action === 'promote' || data.action === 'demote') {
        console.log('[Members] ' + data.action + ' in ' + data.id + ' — metadata cache refreshed');
      }
      // Refresh member lists in background (debounced — not immediate)
      setTimeout(() => refreshGroupMembers(), 5000);
    } catch (e) { console.error('[Members] Event error:', e.message); }
  });

  // v13: messaging-history.set — also populates recentMessages feed for past message reading
sock.ev.on('messaging-history.set', ({ messages, chats, contacts }) => {
  try {
    // Store contacts for LID→PN resolution
    // FIX BUG 6: Use c.jid not c.phoneNumber (v6.7.24 — phoneNumber is v7.x only)
    if (contacts?.length) {
      for (const c of contacts) {
        if (c.id?.endsWith('@lid') && c.jid && c.jid.endsWith('@s.whatsapp.net')) {
          lidToPhone.set(toBare(c.id), c.jid);
        }
      }
    }
    if (messages?.length) {
      let stored = 0;
      for (const m of messages) {
        if (m.key?.id) {
          messageStore.set(m.key.id, m);
          stored++;
          // v13: Also add to recentMessages feed (was missing in v12)
          const sender = m.key?.remoteJid;
          const text = m.message?.conversation || m.message?.extendedTextMessage?.text || '';
          if (text && sender) {
            recentMessages.push({
              id: m.key.id, sender, bare: toBare(sender),
              fromMe: m.key?.fromMe || false, pushName: m.pushName || 'Unknown',
              text: text.substring(0, 500), isGroup: isGroup(sender),
              isAdmin: false, ts: new Date((m.messageTimestamp || 0) * 1000).toISOString()
            });
          }
          // v13: Build LID map from history messages too
          const ppn = m.key?.participantPn || m.key?.senderPn;
          const part = m.key?.participant;
          if (ppn && part?.endsWith('@lid')) {
            const pnBare = toBare(ppn);
            if (pnBare.match(/^\d+$/) && pnBare.length > 8) {
              lidToPhone.set(toBare(part), ppn);
            }
          }
        }
      }
      console.log('[History] Stored ' + stored + ' messages, feed: ' + recentMessages.length + ', lidMap: ' + lidToPhone.size);
    }
    while (messageStore.size > 500) { const first = messageStore.keys().next().value; if (first) messageStore.delete(first); }
    while (recentMessages.length > MAX_FEED) recentMessages.shift();
  } catch (e) { console.error('[History]', e.message); }
});
  sock.ev.on('chats.update', (chats) => { try { for (const c of (chats || [])) { if (c.id?.endsWith('@g.us')) knownGroups.add(c.id); } } catch (e) { console.error('[Chat] Update error:', e.message); } });
  sock.ev.on('groups.update', (groups) => { try { for (const g of (groups || [])) { if (g.id) { knownGroups.add(g.id); console.log('[GRP] ' + (g.subject || g.id) + ' (' + (g.participants?.length || 0) + ' members)'); } } } catch (e) { console.error('[GRP] Update error:', e.message); } });
  // FIX BUG 7: Use c.jid not c.phoneNumber (v6.7.24 — phoneNumber is v7.x only)
  sock.ev.on('contacts.upsert', (contacts) => { try { for (const c of (contacts || [])) { if (c.id?.endsWith('@lid') && c.jid && c.jid.endsWith('@s.whatsapp.net')) { lidToPhone.set(toBare(c.id), c.jid); } } } catch {} });
  // contacts.update — same fix
  sock.ev.on('contacts.update', (contacts) => { try { for (const c of (contacts || [])) { if (c.id?.endsWith('@lid') && c.jid && c.jid.endsWith('@s.whatsapp.net')) { lidToPhone.set(toBare(c.id), c.jid); } } } catch {} });
  // FIX BUG 8: Listen for chats.phoneNumberShare event (v6.7.24) for LID↔PN mapping
  sock.ev.on('chats.phoneNumberShare', ({ lid, jid }) => { try { if (lid && jid) { lidToPhone.set(toBare(lid), jid); console.log('[LID] phoneNumberShare: ' + toBare(lid) + ' -> ' + jid); } } catch {} });
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  SECTION 28: EXPRESS
// ═════════════════════════════════════════════════════════════════════════════════════════════
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
// ═══════════════════════════════════════════════════════════════
//  WEB UI: Admin Command Endpoint — sends a command as if admin DM'd the bot
// ═══════════════════════════════════════════════════════════════
app.post('/api/admin-cmd', async (req, res) => {
  const { cmd } = req.body || {};
  if (!cmd) return res.json({ ok: false, error: 'No command provided' });
  if (!sock || connectionStatus !== 'connected') return res.json({ ok: false, error: 'Bot not connected' });
  try {
    // Simulate admin DM by processing the command directly
    const replyJid = ADMIN + '@s.whatsapp.net';
    const fakeMsg = { key: { remoteJid: replyJid, fromMe: false, id: 'webui_' + Date.now() }, message: { conversation: cmd }, pushName: 'WebUI' };
    // Inject into message handler by emitting a fake upsert
    sock.ev.emit('messages.upsert', { messages: [fakeMsg], type: 'notify' });
    res.json({ ok: true, result: 'Command "' + cmd + '" sent to bot. Check your WhatsApp DM for response.' });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
//  WEB UI: Member Command Endpoint — sends a command as if a group member sent it
// ═══════════════════════════════════════════════════════════════
app.post('/api/member-cmd', async (req, res) => {
  const { cmd } = req.body || {};
  if (!cmd) return res.json({ ok: false, error: 'No command provided' });
  if (!sock || connectionStatus !== 'connected') return res.json({ ok: false, error: 'Bot not connected' });
  try {
    // Find a target group to simulate the command from
    const groupJid = targetGroups.music || targetGroups.movies || [...knownGroups][0];
    if (!groupJid) return res.json({ ok: false, error: 'No group joined yet. Use !joingroups first.' });
    const senderJid = ADMIN + '@s.whatsapp.net';
    const fakeMsg = { key: { remoteJid: groupJid, fromMe: false, id: 'webui_mem_' + Date.now(), participant: senderJid }, message: { conversation: cmd }, pushName: 'WebUI' };
    sock.ev.emit('messages.upsert', { messages: [fakeMsg], type: 'notify' });
    res.json({ ok: true, result: 'Member command "' + cmd + '" sent. Response will go to your WhatsApp inbox.' });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
//  WEB UI: Test Download Endpoint — SSE streaming with full traceback
// ═══════════════════════════════════════════════════════════════
app.get('/api/test-download', async (req, res) => {
  const method = parseInt(req.query.method) || 6;
  const query = req.query.query || 'amapiano 2025';

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  const send = (type, msg, extra) => {
    const data = JSON.stringify({ type, msg, ts: new Date().toISOString(), ...( extra || {}) });
    res.write('data: ' + data + '\n\n');
  };

  const dlMethod = DOWNLOAD_METHODS[method];
  if (!dlMethod) { send('error', 'Invalid method: ' + method); res.end(); return; }

  send('info', '═══ Download Test: ' + dlMethod.name + ' (Method ' + method + ') ═══');
  send('info', 'Query: "' + query + '"');
  send('info', 'RAM: ' + getRamMB() + 'MB / ' + MAX_RAM_MB + 'MB');
  send('info', 'Bot connected: ' + connectionStatus);

  let step = 0;
  const t = async (name, fn) => {
    step++;
    send('step', '[Step ' + step + '] ' + name + '...');
    const start = Date.now();
    try {
      if (!isRamSafe()) throw new Error('RAM too high: ' + getRamMB() + 'MB');
      const r = await fn();
      const elapsed = Date.now() - start;
      const detail = typeof r === 'string' ? r : JSON.stringify(r).substring(0, 300);
      send('pass', '[PASS] ' + name + ' (' + elapsed + 'ms): ' + detail);
      return r;
    } catch (e) {
      const elapsed = Date.now() - start;
      send('fail', '[FAIL] ' + name + ' (' + elapsed + 'ms): ' + e.message);
      if (e.stack) send('trace', 'Stack trace:\n' + e.stack.substring(0, 800));
      return null;
    }
  };

  try {
    // For non-YouTube methods (TikTok, Instagram, Social), use query as direct URL or skip YT search
    if (dlMethod.youtube) {
      // Step 1: YouTube Search
      const videos = await t('YouTube Search: "' + query + '"', async () => {
        const v = await ytSearch(query);
        if (!v.length) throw new Error('No results found for: ' + query);
        return v.length + ' results. Top: ' + (v[0]?.title?.substring(0, 80) || 'none') + ' | URL: ' + (v[0]?.url || 'none');
      });

      // Step 2: Get video URL
      let videoUrl = null;
      await t('Get Video URL', async () => {
        const v = await ytSearch(query);
        if (!v.length) throw new Error('No videos found');
        videoUrl = v[0].url;
        return 'URL: ' + videoUrl + ' | Duration: ' + (v[0].timestamp || 'unknown') + ' | Views: ' + (v[0].views || 'unknown');
      });

      if (!videoUrl) { send('error', 'Cannot proceed without video URL'); res.end(); return; }

      // Step 3: Audio Download
      let audioFile = null;
      await t('Audio Download (' + dlMethod.name + ')', async () => {
        send('info', 'Attempting audio download via ' + dlMethod.name + '...');
        send('info', 'URL: ' + videoUrl);
        const dl = await dlMethod.fn(videoUrl, 'audio', MAX_MEDIA_MB);
        audioFile = dl.file;
        const mb = (dl.size / 1024 / 1024).toFixed(2);
        send('info', 'File: ' + dl.file + ' | Size: ' + mb + 'MB');
        if (dl.size < 10000) throw new Error('File too small: ' + dl.size + ' bytes');
        if (dl.size > MAX_MEDIA_MB * 1024 * 1024) throw new Error('File too large: ' + mb + 'MB > ' + MAX_MEDIA_MB + 'MB limit');
        return mb + 'MB audio downloaded successfully';
      });

      // Step 4: Cleanup
      await t('Cleanup temp file', async () => {
        if (audioFile) { try { fs.unlinkSync(audioFile); return 'Deleted: ' + audioFile; } catch (e) { return 'Could not delete: ' + e.message; } }
        return 'No file to clean';
      });

      // Step 5: RAM after
      await t('RAM After Download', async () => {
        const mb = getRamMB();
        const pct = Math.round(mb / MAX_RAM_MB * 100);
        return mb + 'MB / ' + MAX_RAM_MB + 'MB (' + pct + '%) - ' + (isRamSafe() ? 'SAFE' : 'HIGH');
      });
    } else {
      // Non-YouTube method (TikTok, Instagram, Social) — use query as URL
      const testUrl = query.startsWith('http') ? query :
        (method === 8 ? 'https://vm.tiktok.com/ZM6QxQBvP/' :
         method === 9 ? 'https://www.instagram.com/reel/example/' :
         'https://vm.tiktok.com/ZM6QxQBvP/');

      send('info', 'Testing ' + dlMethod.name + ' with URL: ' + testUrl);
      let testFile = null;
      await t('Download (' + dlMethod.name + ')', async () => {
        send('info', 'URL: ' + testUrl);
        const dl = await dlMethod.fn(testUrl, 'audio', MAX_MEDIA_MB);
        testFile = dl.file;
        const mb = (dl.size / 1024 / 1024).toFixed(2);
        return mb + 'MB downloaded from ' + testUrl.substring(0, 60);
      });

      await t('Cleanup', async () => {
        if (testFile) { try { fs.unlinkSync(testFile); return 'Deleted'; } catch { return 'Skip'; } }
        return 'No file';
      });

      await t('RAM After', async () => {
        const mb = getRamMB();
        return mb + 'MB / ' + MAX_RAM_MB + 'MB (' + Math.round(mb / MAX_RAM_MB * 100) + '%)';
      });
    }

    send('done', '═══ Test Complete: ' + dlMethod.name + ' ═══');
  } catch (e) {
    send('error', 'Unhandled error: ' + e.message);
    if (e.stack) send('trace', e.stack.substring(0, 800));
  }

  res.end();
});

// ═══════════════════════════════════════════════════════════════
//  WEB UI: Test AI Endpoint — SSE streaming with full traceback
// ═══════════════════════════════════════════════════════════════
app.get('/api/test-ai', async (req, res) => {
  const provider = req.query.provider || 'all';
  const message = req.query.message || 'Say hello in 5 words';

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  const send = (type, msg, extra) => {
    const data = JSON.stringify({ type, msg, ts: new Date().toISOString(), ...(extra || {}) });
    res.write('data: ' + data + '\n\n');
  };

  send('info', '═══ AI Agent Test ═══');
  send('info', 'Provider: ' + provider);
  send('info', 'Message: "' + message + '"');
  send('info', 'RAM: ' + getRamMB() + 'MB / ' + MAX_RAM_MB + 'MB');

  const testProvider = async (key) => {
    const cfg = AI_CONFIG[key];
    if (!cfg) { send('fail', '[' + key + '] Not found in AI_CONFIG'); return; }
    send('step', '─── Testing: ' + cfg.name + ' (' + key + ') ───');
    send('info', 'Base URL: ' + (cfg.baseUrl || 'NOT SET'));
    send('info', 'Model: ' + (cfg.model || 'NOT SET'));
    send('info', 'API Key: ' + (cfg.apiKey ? cfg.apiKey.substring(0, 8) + '...' : 'NOT SET'));
    const status = getAiConfigStatus(key);
    send('info', 'Config status: ' + status);
    if (status !== 'configured') {
      send('fail', '[' + cfg.name + '] SKIP — ' + status + (status === 'no_key' ? ' (set ' + key.toUpperCase() + '_API_KEY env var)' : ''));
      return;
    }
    const start = Date.now();
    try {
      send('info', 'Sending test message: "' + message + '"');
      const reply = await callAi(key, [{ role: 'user', content: message }], 50);
      const elapsed = Date.now() - start;
      send('pass', '[PASS] ' + cfg.name + ' (' + elapsed + 'ms): ' + reply.substring(0, 200));
    } catch (e) {
      const elapsed = Date.now() - start;
      send('fail', '[FAIL] ' + cfg.name + ' (' + elapsed + 'ms): ' + e.message);
      if (e.stack) send('trace', 'Stack:\n' + e.stack.substring(0, 600));
    }
  };

  try {
    if (provider === 'all') {
      send('info', 'Testing all ' + Object.keys(AI_CONFIG).length + ' AI providers...');
      for (const key of Object.keys(AI_CONFIG)) {
        await testProvider(key);
        await new Promise(r => setTimeout(r, 500));
      }
    } else {
      await testProvider(provider);
    }

    // Summary
    send('info', '─── Summary ───');
    const available = getAvailableAis('both');
    send('info', 'Configured providers: ' + (available.length ? available.join(', ') : 'NONE'));
    send('info', 'Group reply AIs: ' + (getAisForPurpose('group_reply').join(', ') || 'none'));
    send('info', 'Inbox chat AIs: ' + (getAisForPurpose('inbox_chat').join(', ') || 'none'));
    send('info', 'RAM after: ' + getRamMB() + 'MB');
    send('done', '═══ AI Test Complete ═══');
  } catch (e) {
    send('error', 'Unhandled error: ' + e.message);
    if (e.stack) send('trace', e.stack.substring(0, 800));
  }

  res.end();
});

// Test NSFW search
app.get('/api/test-nsfw', async (req, res) => {
  const query = req.query.query || 'trending';
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();
  const send = (type, msg, extra) => {
    res.write('data: ' + JSON.stringify({ type, msg, ts: new Date().toISOString(), ...(extra || {}) }) + '\n\n');
  };
  try {
    send('info', 'Testing NSFW search: ' + query);
    if (!xvideosLib) { send('fail', 'xvideos library not installed. Run: npm install @rodrigogs/xvideos'); res.end(); return; }
    send('info', 'Searching xvideos for: ' + query);
    const videos = await searchNsfwVideos(query);
    send('pass', 'Found ' + videos.length + ' videos');
    if (videos.length) {
      for (let i = 0; i < Math.min(3, videos.length); i++) {
        send('info', (i+1) + '. ' + (videos[i].title || 'Untitled').substring(0, 80) + (videos[i].duration ? ' (' + videos[i].duration + ')' : ''));
      }
    }
    send('done', 'NSFW search test complete');
  } catch (e) { send('fail', 'Error: ' + e.message); }
  res.end();
});

// Test NSFW download
app.get('/api/test-nsfw-dl', async (req, res) => {
  const query = req.query.query || 'trending';
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();
  const send = (type, msg, extra) => {
    res.write('data: ' + JSON.stringify({ type, msg, ts: new Date().toISOString(), ...(extra || {}) }) + '\n\n');
  };
  try {
    send('info', 'Testing NSFW download: ' + query);
    if (!xvideosLib) { send('fail', 'xvideos library not installed'); res.end(); return; }
    const videos = await searchNsfwVideos(query);
    if (!videos.length) { send('fail', 'No videos found'); res.end(); return; }
    const video = videos[0];
    send('info', 'Selected: ' + (video.title || 'Untitled').substring(0, 80));
    send('info', 'Fetching video details...');
    const details = await getNsfwVideoDetails(video);
    send('info', 'Title: ' + (details.title || 'N/A'));
    const files = details.files;
    const videoUrl = files?.high || files?.low || details.contentUrl;
    if (!videoUrl) { send('fail', 'No download URL in video details'); res.end(); return; }
    send('info', 'Using: ' + (files?.high ? 'HIGH' : files?.low ? 'LOW' : 'contentUrl'));
    send('info', 'Downloading...');
    const tmpFile = path.join('/tmp', 'wabot_nsfw_test_' + Date.now() + '.mp4');
    const dl = await httpGetBuffer(videoUrl, DL_TIMEOUT);
    fs.writeFileSync(tmpFile, dl.buffer);
    const sizeMB = (dl.size / 1024 / 1024).toFixed(2);
    send('pass', 'Downloaded: ' + sizeMB + 'MB');
    try { fs.unlinkSync(tmpFile); send('pass', 'Cleaned up temp file'); } catch {}
    send('done', 'NSFW download test complete!');
  } catch (e) { send('fail', 'Error: ' + e.message); if (e.stack) send('trace', e.stack.substring(0, 500)); }
  res.end();
});

// AI Manager decision test
app.post('/api/ai-decide', async (req, res) => {
  const { group } = req.body || {};
  if (!group || !['music', 'movies'].includes(group)) {
    return res.json({ ok: false, error: 'Invalid group. Use "music" or "movies".' });
  }
  try {
    const weather = await fetchWeather();
    const decision = await aiDecideContent(group, weather);
    const genreRotation_current = genreRotation[group];
    res.json({ ok: true, group, decision: decision || 'random (AI unavailable)', weather: { temp: weather?.main?.temp, desc: weather?.weather?.[0]?.description, mood: getMood(weather) }, recentGenre: genreRotation_current, hour: (new Date().getUTCHours() + 2) % 24 });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// Poll reasoning test
app.post('/api/ai-poll', async (req, res) => {
  const { poll_text } = req.body || {};
  if (!poll_text) return res.json({ ok: false, error: 'Provide poll_text' });
  try {
    const available = getAisForPurpose('group_reply');
    if (!available.length) return res.json({ ok: false, error: 'No AI available' });
    const provider = available[0];
    const reply = await callAi(provider, [
      { role: 'system', content: 'You are a WhatsApp group manager. Someone created a poll. Give your reasoned opinion in 1-3 SHORT sentences. Be funny, insightful, or persuasive.' },
      { role: 'user', content: poll_text }
    ], 200);
    res.json({ ok: true, provider, reasoning: reply });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.get('/api/status', (req, res) => {
  res.json({ connection: connectionStatus, adminOnline: isAdminOnline, qrAvailable: !!qrCodeData, ramMB: getRamMB(), queueSize: queueSize(), currentTask: currentTaskName, groups: knownGroups.size, targetGroups: Object.fromEntries(Object.entries(targetGroups).map(([k, v]) => [k, v ? 'set' : 'null'])), reconnectAttempts, uptime: Math.round((Date.now() - botStartTime) / 1000), version: VERSION, adminLidJid: ADMIN_LID_JID || null, groupDlMethod, groupDlName: getGroupDlName(), aiOnline: getAvailableAis('both').map(k => AI_CONFIG[k].name), translate: !!translator, memberCount: [...groupMembers.values()].reduce((s, m) => s + m.size, 0), adminCount: [...groupAdmins.values()].reduce((s, a) => s + a.size, 0), lidMapSize: lidToPhone.size });
});
app.get('/health', (req, res) => { res.status(connectionStatus === 'connected' ? 200 : 503).json({ ok: connectionStatus === 'connected', connection: connectionStatus, uptime: Math.round((Date.now() - botStartTime) / 1000) }); });
app.get('/ping', (req, res) => { lastKeepAlivePing = Date.now(); res.status(200).send('pong'); });
app.get('/api/qr', (req, res) => res.json({ qr: qrCodeData }));
app.get('/api/messages', (req, res) => res.json(recentMessages.slice(-100)));
app.post('/api/reconnect', (req, res) => { qrCodeData = null; connectionStatus = 'disconnected'; if (sock) { try { sock.ev.removeAllListeners('connection.update'); } catch {} try { sock.end(); } catch {} } try { fs.rmSync(AUTH_FOLDER, { recursive: true, force: true }); } catch {} res.json({ ok: true }); reconnectAttempts = 0; setTimeout(() => startSock(), 1000); });
setInterval(() => { try { const preq = http.get('http://localhost:' + PORT + '/ping', (res) => { res.resume(); lastKeepAlivePing = Date.now(); }); preq.on('error', () => {}); } catch {} }, 5 * 60000);

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  SECTION 29: CRASH PROTECTION
// ═════════════════════════════════════════════════════════════════════════════════════════════
process.on('uncaughtException', (err) => { console.error('[FATAL] uncaughtException:', err.message); console.error(err.stack?.substring(0, 500) || ''); });
process.on('unhandledRejection', (r) => { console.error('[FATAL] unhandledRejection:', typeof r === 'object' ? JSON.stringify(r)?.substring(0, 200) : String(r)); });
setInterval(() => {
  if (connectionStatus === 'disconnected' && reconnectAttempts > 5) { console.log('[Watchdog] Too many reconnects...'); reconnectAttempts = 0; try { if (sock) { sock.ev.removeAllListeners('connection.update'); sock.end(); } } catch {} setTimeout(() => startSock(), 1000); }
  if (connectionStatus === 'connecting' && (Date.now() - lastConnectedAt > 60000) && reconnectAttempts > 0) { console.log('[Watchdog] Stuck connecting...'); reconnectAttempts = 0; try { sock?.end(); } catch {} }
  cleanTmp(); while (messageStore.size > 200) { const first = messageStore.keys().next().value; if (first) messageStore.delete(first); else break; }
}, 60000);

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  SECTION 30: MAIN STARTUP
// ═════════════════════════════════════════════════════════════════════════════════════════════
cleanTmp(); loadBroadcasts(); scheduleSlots = buildSchedule(); logRam('BOOT');
const now = new Date(); const msToMidnight = (24 - now.getUTCHours() - 1) * 3600000 + (60 - now.getUTCMinutes()) * 60000;
setTimeout(() => { resetDailyFired(); setInterval(resetDailyFired, 24 * 3600000); }, msToMidnight);
schedTickInterval = setInterval(async () => { try { await tickScheduler(); } catch (e) { console.error('[Sched] Tick error:', e.message); } }, 1800000);
setInterval(async () => { try { await sendMorningTutorial(); await sleep(2000); await sendMorningWeather(); } catch (e) { console.error('[Morning] Error:', e.message); } }, 1800000);
setInterval(() => { morningTutorialSent = false; }, 24 * 3600000);
setInterval(async () => { try { await joinTargetGroups(); } catch (e) { console.error('[Groups] Rejoin error:', e.message); } }, 2 * 3600000);
setInterval(() => logRam('MON'), 300000);
setInterval(() => refreshGroupMembers(), 30 * 60000);
setInterval(() => { const now2 = Date.now(); for (const [k, times] of msgRateLimiter.entries()) { const filtered = times.filter(t => (now2 - t) < MSG_RATE_WINDOW); if (filtered.length === 0) msgRateLimiter.delete(k); else msgRateLimiter.set(k, filtered); } }, 300000);
setInterval(cleanPendingDownloads, 60000);
setInterval(cleanFallbacks, 60000);
setInterval(() => { const now2 = Date.now(); for (const [k, v] of aiSelections.entries()) { if ((now2 - v.timestamp) > 600000) aiSelections.delete(k); } for (const [k, v] of nsfwSelections.entries()) { if ((now2 - v.timestamp) > 600000) nsfwSelections.delete(k); } }, 600000);
setInterval(() => { const cutoff = Date.now() - 7 * 86400000; for (const [k, entries] of downloadHistory.entries()) { const recent = entries.filter(e => e.ts > cutoff); if (recent.length === 0) downloadHistory.delete(k); else downloadHistory.set(k, recent); } }, 3600000);
setInterval(() => { const cutoff = Date.now() - 30 * 86400000; for (const [k, ts] of memberJoinTimestamps.entries()) { if (ts < cutoff) memberJoinTimestamps.delete(k); } }, 86400000);
setInterval(() => { const cutoff = Date.now() - 300000; for (const [k, v] of fileConfirmations.entries()) { if (v.timestamp < cutoff) fileConfirmations.delete(k); } }, 60000);

const server = app.listen(PORT, () => console.log('[Server] Port ' + PORT + ' | v' + VERSION));
loadAdminLid(); // v15: Load persisted admin LID BEFORE connecting
startSock().catch(err => console.error('[WA] Fatal:', err));

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  SECTION 31: TEST SUITES
// ═════════════════════════════════════════════════════════════════════════════════════════════
async function sendTestMsg(jid, step, name, status, detail) {
  const ram = getRamMB(); const icon = status === 'PASS' ? 'OK' : status === 'FAIL' ? 'FAIL' : '...';
  console.log('[TEST] Step ' + step + ' (' + name + '): ' + status + ' | RAM ' + ram + 'MB');
  try { await sock.sendMessage(jid, { text: icon + ' *Step ' + step + ': ' + name + '*\n' + status + ' | RAM: ' + ram + 'MB/' + MAX_RAM_MB + 'MB\n' + detail }); } catch {}
}

async function runFullTest(adminJid) {
  const results = []; let step = 0; const wait = ms => new Promise(r => setTimeout(r, ms));
  async function testStep(name, fn) { step++; try { const r = await fn(); const d = typeof r === 'string' ? r : JSON.stringify(r).substring(0, 300); results.push({ step, name, status: 'PASS', detail: d }); await sendTestMsg(adminJid, step, name, 'PASS', d); } catch (e) { results.push({ step, name, status: 'FAIL', detail: e.message }); await sendTestMsg(adminJid, step, name, 'FAIL', e.message); } await wait(2000); }
  await testStep('RAM Monitor', () => getRamMB() + 'MB, safe: ' + isRamSafe());
  await testStep('Utilities', () => 'toBare(ADMIN): ' + toBare(ADMIN + '@s.whatsapp.net'));
  await testStep('Weather', async () => { const w = await fetchWeather(); return CITY + ': ' + (w?.main?.temp) + 'C'; });
  await testStep('Mood', async () => { const w = await fetchWeather(); return 'mood: ' + getMood(w); });
  await testStep('YouTube Search', async () => { const v = await ytSearch('amapiano 2025'); return 'found: ' + v.length; });
  await testStep('Meme API', async () => { const u = await fetchRandomMeme(); return u ? 'got meme' : 'no meme'; });
  await testStep('DL Method', () => getGroupDlName() + ' (' + groupDlMethod + ')');
  await testStep('AI Providers', () => { const a = getAvailableAis('both'); return 'available: ' + (a.length ? a.join(', ') : 'NONE (check env keys)'); });
  await testStep('Admin Detection (v13)', () => { const mc = groupMetadataCache.getStats(); return 'metaCache: ' + mc.keys + ', admins: ' + [...groupAdmins.values()].reduce((s,a) => s + a.size, 0) + ', lidMap: ' + lidToPhone.size + ', participantPn support: ' + (true ? 'YES' : 'NO'); });
  await testStep('Translation', () => 'loaded: ' + !!translator + ', words: ' + SHONA_NDEBELE_WORDS.size);
  await testStep('Web Search', async () => { const r = await webSearch('zimbabwe'); return 'results: ' + r.length; });
  await testStep('Schedule', () => buildSchedule().length + ' slots');
  await testStep('Members', () => 'tracked: ' + groupMembers.size + ', lidMap: ' + lidToPhone.size);
  await wait(2000);
  const passed = results.filter(r => r.status === 'PASS').length;
  let summary = '*TEST COMPLETE* (v' + VERSION + ')\n\nPassed: ' + passed + '/' + results.length + '\nFailed: ' + (results.length - passed) + '/' + results.length + '\nRAM: ' + getRamMB() + 'MB\n\n';
  for (const r of results) { summary += (r.status === 'PASS' ? 'OK' : 'FAIL') + ' ' + r.step + '. ' + r.name + ': ' + r.detail.substring(0, 80) + '\n'; }
  try { await sock.sendMessage(adminJid, { text: summary }); } catch {}
  testRunning = false; testCompleted = true;
}

async function runDlTest(adminJid, methodNum) {
  const method = DOWNLOAD_METHODS[methodNum];
  if (!method?.fn) { await sock.sendMessage(adminJid, { text: 'Invalid method: ' + methodNum }); return; }
  await sock.sendMessage(adminJid, { text: '*Download Test: ' + method.name + '*\nStarting...' });
  const results = []; let step = 0; const wait = ms => new Promise(r => setTimeout(r, ms));
  async function t(name, fn) { step++; try { if (!isRamSafe()) throw new Error('RAM too high'); const r = await fn(); const d = typeof r === 'string' ? r : JSON.stringify(r).substring(0, 200); results.push({ step, name, status: 'PASS', detail: d }); await sendTestMsg(adminJid, step, name, 'PASS', d); } catch (e) { results.push({ step, name, status: 'FAIL', detail: e.message }); await sendTestMsg(adminJid, step, name, 'FAIL', e.message); } await wait(1500); }
  await t('Search', async () => { const v = await ytSearch('amapiano 2025 short'); return v.length + ' results. Top: ' + (v[0]?.title?.substring(0, 60) || 'none'); });
  await t('Audio (<5MB)', async () => { const v = await ytSearch('lofi beats 1 minute'); if (!v.length) throw new Error('No results'); const dl = await method.fn(v[0].url, 'audio', 5); const mb = (dl.size/1024/1024).toFixed(2); safeDeleteFile(dl.file); return mb + 'MB'; });
  await t('Zim Music', async () => { const a = ZIM_ARTISTS[randInt(0, ZIM_ARTISTS.length - 1)]; const v = await ytSearch(a + ' 2025'); if (!v.length) throw new Error('No results'); const dl = await method.fn(v[0].url, 'audio', GROUP_AUDIO_MAX_MB); const mb = (dl.size/1024/1024).toFixed(2); safeDeleteFile(dl.file); return a + ': ' + mb + 'MB'; });
  await t('Video (<12MB)', async () => { const v = await ytSearch('funny short 30 seconds'); if (!v.length) throw new Error('No results'); const dl = await method.fn(v[0].url, 'video', 12); const mb = (dl.size/1024/1024).toFixed(2); safeDeleteFile(dl.file); return mb + 'MB'; });
  await t('Image (URL)', async () => { const u = await fetchRandomMeme(); if (!u) throw new Error('No meme'); const dl = await downloadFromUrl(u, 2); const mb = (dl.size/1024/1024).toFixed(2); safeDeleteFile(dl.file); return mb + 'MB'; });
  await t('RAM After', () => getRamMB() + 'MB (' + Math.round(getRamMB()/MAX_RAM_MB*100) + '%)');
  const passed = results.filter(r => r.status === 'PASS').length;
  let summary = '*Download Test: ' + method.name + '*\n\nPassed: ' + passed + '/' + results.length + '\nRAM: ' + getRamMB() + 'MB\n\n';
  for (const r of results) { summary += (r.status === 'PASS' ? 'OK' : 'FAIL') + ' ' + r.step + '. ' + r.name + ': ' + r.detail.substring(0, 80) + '\n'; }
  if (passed < results.length) summary += '\nTip: Use *!dlmethod* to switch.';
  try { await sock.sendMessage(adminJid, { text: summary }); } catch {}
}

// !test all on <query> — Tests EVERYTHING with real values
async function runTestAll(adminJid, query) {
  const results = []; let step = 0; const wait = ms => new Promise(r => setTimeout(r, ms));
  async function t(name, fn) { step++; try { if (!isRamSafe()) throw new Error('RAM: ' + getRamMB() + 'MB'); const r = await fn(); const d = typeof r === 'string' ? r : JSON.stringify(r).substring(0, 300); results.push({ step, name, status: 'PASS', detail: d }); await sendTestMsg(adminJid, step, name, 'PASS', d); } catch (e) { results.push({ step, name, status: 'FAIL', detail: e.message }); await sendTestMsg(adminJid, step, name, 'FAIL', e.message); } await wait(2000); }

  await t('RAM', () => getRamMB() + 'MB / ' + MAX_RAM_MB + 'MB');
  await t('Weather', async () => { const w = await fetchWeather(); return CITY + ': ' + (w?.main?.temp) + 'C, ' + (w?.weather?.[0]?.description) + ', mood=' + getMood(w); });
  await t('YouTube Search: "' + query + '"', async () => { const v = await ytSearch(query); return v.length + ' results. Top: ' + (v[0]?.title?.substring(0, 80) || 'none'); });
  await t('AI Chat (Groq or fallback)', async () => { const r = await callAiWithFallback('groq', [{ role: 'user', content: 'Say hi in 5 words' }], 30, 'group_reply'); return (typeof r === 'string' ? r : r.reply).substring(0, 100); });
  await t('Web Search: "' + query + '"', async () => { const r = await webSearch(query); return r.length + ' results' + (r[0] ? '. Top: ' + r[0].title?.substring(0, 60) : ''); });
  await t('Meme API', async () => { const u = await fetchRandomMeme(); return u ? 'OK: ' + u.substring(0, 60) : 'No meme'; });
  await t('Download Audio (Smart cascade)', async () => { const v = await ytSearch(query + ' short'); if (!v.length) throw new Error('No search results'); const dl = await smartDownload(v[0].url, 'audio', 5); const mb = (dl.size/1024/1024).toFixed(2); safeDeleteFile(dl.file); return v[0].title.substring(0, 50) + ' (' + mb + 'MB)'; });
  await t('Download Video (Smart cascade)', async () => { const v = await ytSearch(query + ' short video'); if (!v.length) throw new Error('No results'); const dl = await smartDownload(v[0].url, 'video', 12); const mb = (dl.size/1024/1024).toFixed(2); safeDeleteFile(dl.file); return (dl.size/1024/1024).toFixed(2) + 'MB'; });
  await t('Image Download', async () => { const u = await fetchRandomMeme(); if (!u) throw new Error('No meme URL'); const dl = await downloadFromUrl(u, 2); const mb = (dl.size/1024/1024).toFixed(2); safeDeleteFile(dl.file); return mb + 'MB (' + (dl.mimetype || '?') + ')'; });
  await t('AI Content Decision', async () => { const w = await fetchWeather(); const pick = await aiDecideContent('music', w); return 'AI picked: ' + (pick || 'random fallback'); });
  await t('Member System', () => 'members: ' + groupMembers.size + ', admins: ' + [...groupAdmins.values()].reduce((s,a) => s + a.size, 0) + ', lidMap: ' + lidToPhone.size + ', revoked: ' + memberLeftSet.size);
  await t('Translation', () => 'translator: ' + !!translator + ', shona_words: ' + SHONA_NDEBELE_WORDS.size + ', en_words: ' + ENGLISH_WORDS.size);
  await t('Schedule', () => buildSchedule().length + ' slots, ' + Object.keys(MOVIES_PROGRAMMING_BLOCKS).length + ' Movies blocks');
  await t('RAM Final', () => getRamMB() + 'MB (' + Math.round(getRamMB()/MAX_RAM_MB*100) + '%)');

  await wait(2000);
  const passed = results.filter(r => r.status === 'PASS').length;
  let summary = '*TEST ALL COMPLETE* (v' + VERSION + ')\nQuery: "' + query + '"\n\nPassed: ' + passed + '/' + results.length + '\nFailed: ' + (results.length - passed) + '/' + results.length + '\nRAM: ' + getRamMB() + 'MB\n\n';
  for (const r of results) { summary += (r.status === 'PASS' ? 'OK' : 'FAIL') + ' ' + r.step + '. ' + r.name + ': ' + r.detail.substring(0, 100) + '\n'; }
  try { await sock.sendMessage(adminJid, { text: summary }); } catch {}
  testRunning = false; testCompleted = true;
}
