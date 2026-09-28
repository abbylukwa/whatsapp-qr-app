/* ══════════════════════════════════════════════════════════════
 *  BreadBot v71.5 — THE AI BRAIN (brain.js)
 *  "Why aren't the decisions made by an AI?"
 *  Until now every decision was a hardcoded regex:
 *    detectMediaIntent / detectNsfw / detectGroupLinkRequest /
 *    parseCasualAdmin / isVague — keyword lists that misfire and
 *    make the bot send wrong, unnecessary replies.
 *  The brain replaces keyword-guessing with ONE AI call that looks
 *  at the message + context and DECIDES:
 *      run a command  ·  fetch media  ·  chat  ·  stay silent
 *  The old regexes stay in server.js as the FALLBACK for when the
 *  AI pool is down — the bot can only get smarter, never dumber.
 *
 *  Uses the SAME dynamic provider pool as the chat persona
 *  (API_1..API_12 env keys, auto-detected Gemini/Groq/OpenAI/
 *  OpenRouter). Routing calls run at temperature 0.15 with short
 *  timeouts so a decision never blocks a chat for long.
 *
 *  Guardrails (so "smart" never becomes "expensive" or "spammy"):
 *    · AI_BRAIN=false in env kills it everywhere (regex fallback only)
 *    · sliding-window rate limit (default 24 decisions/min)
 *    · 5-minute decision cache for repeated texts
 *    · in-flight dedup (same text sent twice = one call)
 *    · hard deadline (default 11s) — after that: fallback
 *    · confidence < 0.55 = ignore (silence beats a wrong send)
 * ══════════════════════════════════════════════════════════════ */
const axios = require('axios');

/* ── tunables (env overridable) ─────────────────────────────── */
const BRAIN_TIMEOUT_MS   = Math.max(3000, parseInt(process.env.BRAIN_TIMEOUT_MS   || '11000', 10));
const BRAIN_MAX_PER_MIN  = Math.max(1,   parseInt(process.env.BRAIN_MAX_PER_MIN  || '24',    10));
const BRAIN_CACHE_TTL_MS = Math.max(0,   parseInt(process.env.BRAIN_CACHE_TTL_MS || '300000', 10));
const BRAIN_MIN_CONF     = Math.min(1, Math.max(0, parseFloat(process.env.BRAIN_MIN_CONF || '0.55')));
const BRAIN_MAX_QUERY    = 100;    /* search query length cap */
const BRAIN_MAX_ARGS     = 300;    /* command args length cap  */
const BRAIN_MAX_REPLY    = 400;    /* chat draft length cap    */

/* the ONLY commands the brain may map to — mirrors the real admin
 * command set in server.js. Anything else the model invents is
 * dropped (never "guess-executed"). */
const ADMIN_COMMANDS = new Set([
  'setmain','main','clearmain','join','admins','registry','common',
  'help','ping','status','jobs','flow','test','testall','aitest',
  'scraperstatus','whoami','stats','summary','logs','errors','count',
  'groups','inbox','mode','groupchat','brain','broadcast','bcgroup',
  'bcdm','all','send','antilink','welcome','goodbye','setwelcome',
  'setgoodbye','promote','demote','kick','tagall','mute','unmute',
  'lock','unlock','pic','nextpic','gif','nextgif','dl','download',
  'music','st','nsfwvideo','menu','study','deadlines','pdf','docs',
  'forgetdocs','updates','tasks','canceltask','today','week',
  'timetable','weather','pause','resume','offline','online','limit',
  'unlimit','force','ad','adsend'
]);

/* action vocabulary per mode — anything else is rejected */
const MODE_ACTIONS = {
  admin: ['command','chat','ignore'],
  group: ['media','gif','video','music','link','ignore'],
  dm:    ['media','gif','video','music','link','chat','ignore']
};

/* ── state ──────────────────────────────────────────────────── */
let DEPS = null;                 /* { getProviders, markOk, markFail, log } */
let enabled = (process.env.AI_BRAIN || 'true') !== 'false';
let callTimes = [];              /* sliding rate window          */
let cache = new Map();           /* key -> { dec, ts }           */
let inflight = new Map();        /* key -> Promise<decision>     */
const stats = { decisions:0, cacheHits:0, rateLimited:0, fallbacks:0, breakdown:{} };

function bump(action){ stats.breakdown[action] = (stats.breakdown[action] || 0) + 1; }

/* ══════════════════════════════════════════════════════════════
 *  INIT — server.js hands the brain the provider pool
 * ══════════════════════════════════════════════════════════════ */
function initBrain(deps){
  if (!deps || typeof deps.getProviders !== 'function'){
    throw new Error('brain.initBrain: getProviders() is required');
  }
  DEPS = {
    getProviders: deps.getProviders,
    markOk:  deps.markOk  || function(){},
    markFail: deps.markFail || function(){},
    log: deps.log || function(){}
  };
  DEPS.log('info','brain','AI Brain ready — decisions: AI first, regex fallback' +
    (enabled ? '' : ' (DISABLED by AI_BRAIN=false)'));
}

function isEnabled(){ return enabled && !!DEPS && !process.env.LOADTEST; }
function setEnabled(v){
  enabled = !!v;
  if (DEPS) DEPS.log('info','brain','AI Brain ' + (enabled ? 'ENABLED' : 'DISABLED') + ' by admin');
}
function brainStats(){
  const now = Date.now();
  return {
    enabled, decisions: stats.decisions, cacheHits: stats.cacheHits,
    rateLimited: stats.rateLimited, fallbacks: stats.fallbacks,
    callsLastMin: callTimes.filter(t => now - t < 60000).length,
    maxPerMin: BRAIN_MAX_PER_MIN,
    providers: DEPS ? DEPS.getProviders().length : 0,
    breakdown: Object.assign({}, stats.breakdown)
  };
}

/* ══════════════════════════════════════════════════════════════
 *  RATE + CACHE
 * ══════════════════════════════════════════════════════════════ */
function rateOk(){
  const now = Date.now();
  callTimes = callTimes.filter(t => now - t < 60000);
  if (callTimes.length >= BRAIN_MAX_PER_MIN) return false;
  callTimes.push(now);
  return true;
}
function cacheKey(text, ctx){
  const norm = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 160);
  return ctx.mode + '|' + norm;
}
function cacheGet(k){
  if (!BRAIN_CACHE_TTL_MS) return null;
  const e = cache.get(k);
  if (!e) return null;
  if (Date.now() - e.ts > BRAIN_CACHE_TTL_MS){ cache.delete(k); return null; }
  return e.dec;
}
function cacheSet(k, dec){
  if (!BRAIN_CACHE_TTL_MS || !dec) return;
  if (cache.size > 300){
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
  cache.set(k, { dec, ts: Date.now() });
}

/* ══════════════════════════════════════════════════════════════
 *  JSON EXTRACTION — models wrap JSON in prose/fences; survive it
 * ══════════════════════════════════════════════════════════════ */
function extractJson(s){
  if (!s) return null;
  let t = String(s).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++){
    const c = t[i];
    if (inStr){
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}'){
      depth--;
      if (!depth){
        try { const o = JSON.parse(t.slice(start, i + 1)); return (o && typeof o === 'object') ? o : null; }
        catch(e){ return null; }
      }
    }
  }
  return null;
}

/* validate + normalise a raw model answer → decision | null */
function sanitizeDec(raw, mode){
  if (!raw || typeof raw !== 'object') return null;
  const allowed = MODE_ACTIONS[mode] || [];
  const action = String(raw.action || '').toLowerCase().trim();
  if (!allowed.includes(action)) return null;
  const dec = { action };
  let conf = Number(raw.confidence);
  if (!isFinite(conf)) conf = 0.7;
  dec.confidence = Math.min(1, Math.max(0, conf));
  dec.nsfw = raw.nsfw === true || raw.nsfw === 'true';
  if (raw.command !== undefined) dec.command = String(raw.command).toLowerCase().replace(/[^a-z]/g, '').slice(0, 24);
  if (raw.args   !== undefined) dec.args   = String(raw.args).replace(/\s+/g, ' ').trim().slice(0, BRAIN_MAX_ARGS);
  if (raw.query  !== undefined) dec.query  = String(raw.query).replace(/\s+/g, ' ').trim().slice(0, BRAIN_MAX_QUERY);
  if (raw.reply  !== undefined) dec.reply  = String(raw.reply).trim().slice(0, BRAIN_MAX_REPLY);
  if (action === 'command' && (!dec.command || !ADMIN_COMMANDS.has(dec.command))) return null;
  if ((action === 'media' || action === 'gif' || action === 'video' || action === 'music') && !dec.query) return null;
  return dec;
}

/* ══════════════════════════════════════════════════════════════
 *  PROVIDER CALL — same pool as the chat persona, but cold:
 *  temperature 0.15, small max_tokens, per-call timeout, and a
 *  HARD DEADLINE across the whole failover walk.
 * ══════════════════════════════════════════════════════════════ */
async function callProvider(p, system, prompt, timeoutMs){
  const r = await axios.post(p.url, {
    model: p.model,
    messages: [
      { role:'system', content: system },
      { role:'user',   content: prompt }
    ],
    max_tokens: 220, temperature: 0.15
  }, { headers: { 'Authorization': 'Bearer ' + p.key, 'Content-Type': 'application/json' },
       timeout: Math.max(3000, timeoutMs) });
  return r.data?.choices?.[0]?.message?.content;
}

async function askBrainJson(system, prompt){
  const list = DEPS.getProviders() || [];
  if (!list.length) return null;
  const deadline = Date.now() + BRAIN_TIMEOUT_MS;
  for (let i = 0; i < list.length && Date.now() < deadline; i++){
    const p = list[i];
    const left = deadline - Date.now();
    if (left < 3500) break;                       /* no point starting a doomed call */
    try {
      const txt = await callProvider(p, system, prompt, Math.min(left, 9000));
      const raw = extractJson(txt);
      if (!raw){ DEPS.log('warn','brain', p.name + ': no JSON in answer — next provider'); continue; }
      DEPS.markOk(p, 0);
      return raw;
    } catch(e){
      /* network/model errors ARE provider failures — the pool cools them down */
      DEPS.markFail(p, e);
      DEPS.log('warn','brain', p.name + ': ' + (e.response?.status ? 'HTTP ' + e.response.status : e.message));
      continue;
    }
  }
  return null;
}

/* ══════════════════════════════════════════════════════════════
 *  PROMPTS — the "common sense". Written as classification, not
 *  chat: short, few-shot, mode-scoped. The model must understand
 *  intent (English / Shona / Ndebele / slang) instead of matching
 *  keywords like the old regexes did.
 * ══════════════════════════════════════════════════════════════ */
const BASE_SYS =
  'You are the decision engine of BreadBot, a WhatsApp bot. One message arrives; you decide what the bot should do. ' +
  'Answer with ONLY a JSON object — no markdown fences, no prose, no explanation. ' +
  'Users write English, Shona, Ndebele or slang ("ndipe mapic ekute" = wants pictures of cats). Understand INTENT, never keywords. ' +
  'Extract the ACTUAL subject of a content request into "query" (strip send/give/please/greetings). ' +
  'When the message is unclear, accidental, or not really for the bot: choose ignore — silence beats a wrong reply. ' +
  'Set "confidence" 0-1. Set "nsfw":true only when the request or topic is clearly adult/sexual.';

const ADMIN_SYS = BASE_SYS +
  ' MODE: ADMIN — the owner texts the bot. Allowed actions: "command", "chat", "ignore". ' +
  '- "command": the message asks for something one of these bot commands does. Put the command in "command" (no "!") and everything else in "args". ONLY these commands exist: ' +
  Array.from(ADMIN_COMMANDS).join(', ') + '. ' +
  '- "chat": plain question/small talk for the assistant. - "ignore": not for the bot. ' +
  'Examples: "how many dms today" -> {"action":"command","command":"stats","confidence":0.8} | ' +
  '"send good morning to the group" -> {"action":"command","command":"bcgroup","args":"Good morning","confidence":0.85} | ' +
  '"post the advert" -> {"action":"command","command":"bcad","confidence":0.8} | ' +
  '"ok cool" -> {"action":"ignore","confidence":0.9}';

const GROUP_SYS = BASE_SYS +
  ' MODE: GROUP — a member posted in the main WhatsApp group. The bot NEVER chats in groups; most group messages deserve silence. ' +
  'Allowed actions: "media" (explicit want for PICTURES), "gif", "video", "music" (song/audio), "link" (asks for the WhatsApp group/join link), "ignore". ' +
  '- ignore: greetings, small talk, members talking to each other, questions asked to the group (not the bot), opinions, no clear content request. ' +
  'Examples: "pics of harare" -> {"action":"media","query":"harare","confidence":0.9} | ' +
  '"mhoroi" -> {"action":"ignore","confidence":0.95} | "who has Monday notes?" -> {"action":"ignore","confidence":0.9} | ' +
  '"send group link" -> {"action":"link","confidence":0.9} | "ndipe ma gifs ekute" -> {"action":"gif","query":"cats","confidence":0.85}';

const DM_SYS = BASE_SYS +
  ' MODE: DM — private chat with a contact; the bot persona chats here. Allowed actions: "media","gif","video","music","link","chat","ignore". ' +
  '- "chat": conversation, greetings, flirting, questions, feelings — anything they want a reply TO. If the message is sexual/flirty in intent set "nsfw":true (a separate roleplay mode is gated on it). ' +
  '- "media"/"gif"/"video"/"music": explicit request for that content. - "link": asks for the group link. ' +
  '- "ignore": single characters, chain/forward junk, obviously meant for someone else. ' +
  'Examples: "hey" -> {"action":"chat","confidence":0.95} | "send me a gif of cats" -> {"action":"gif","query":"cats","confidence":0.9} | ' +
  '"can I get the group link" -> {"action":"link","confidence":0.9} | "u there?" -> {"action":"chat","confidence":0.9}';

const MODE_SYS = { admin: ADMIN_SYS, group: GROUP_SYS, dm: DM_SYS };

function buildPrompt(text, ctx){
  const parts = [];
  parts.push('From: ' + (ctx.senderName || 'unknown') +
    (ctx.mode === 'group' ? ' (in group: ' + (ctx.groupName || 'main') + ')' : '') +
    (ctx.isAdmin ? ' [ADMIN]' : ''));
  if (ctx.nsfwWindow !== undefined) parts.push('Adult-content window: ' + (ctx.nsfwWindow ? 'OPEN' : 'closed (replies must not be adult now)'));
  if (Array.isArray(ctx.recent) && ctx.recent.length){
    parts.push('Recent messages in this chat (latest last):');
    for (const r of ctx.recent.slice(-6)) parts.push('- ' + String(r).replace(/\s+/g,' ').slice(0, 120));
  }
  parts.push('LATEST message to decide: "' + String(text).replace(/\s+/g,' ').trim().slice(0, 300) + '"');
  parts.push('Decide now. JSON only.');
  return parts.join('\n');
}

/* ══════════════════════════════════════════════════════════════
 *  aiDecide — THE one call. Returns a decision object or null
 *  (null = "no AI opinion" → server.js falls back to the old
 *  regex chain, so behaviour can only improve).
 * ══════════════════════════════════════════════════════════════ */
async function aiDecide(text, ctx){
  if (!isEnabled()) return null;
  ctx = ctx || {};
  const mode = MODE_SYS[ctx.mode] ? ctx.mode : 'dm';
  const clean = String(text || '').trim();
  if (!clean || clean.length > 500) return null;

  const k = cacheKey(clean, ctx);
  const hit = cacheGet(k);
  if (hit){ stats.cacheHits++; return hit; }
  if (inflight.has(k)){
    try { return await inflight.get(k); } catch(e){ return null; }
  }
  if (!rateOk()){ stats.rateLimited++; return null; }

  const job = (async () => {
    const raw = await askBrainJson(MODE_SYS[mode], buildPrompt(clean, ctx));
    if (!raw){ stats.fallbacks++; return null; }
    const dec = sanitizeDec(raw, mode);
    if (!dec){
      stats.fallbacks++;
      DEPS.log('warn','brain','rejected malformed decision (mode ' + mode + ')');
      return null;
    }
    /* low-confidence = the AI itself is guessing — treat as ignore
     * in media/command modes so the bot never acts on a hunch */
    if (dec.confidence < BRAIN_MIN_CONF && dec.action !== 'ignore' && dec.action !== 'chat'){
      DEPS.log('info','brain','low confidence ' + Math.round(dec.confidence * 100) + '% → ignore');
      return { action:'ignore', confidence: dec.confidence, nsfw: dec.nsfw };
    }
    stats.decisions++; bump(dec.action);
    DEPS.log('info','brain','[' + mode + '] ' + dec.action +
      (dec.command ? ' !' + dec.command + (dec.args ? ' ' + dec.args : '') : '') +
      (dec.query ? ' "' + dec.query + '"' : '') +
      (dec.nsfw ? ' [nsfw]' : '') +
      ' (' + Math.round(dec.confidence * 100) + '%)');
    return dec;
  })();

  inflight.set(k, job);
  try {
    const dec = await job;
    if (dec) cacheSet(k, dec);
    return dec;
  } finally {
    inflight.delete(k);
  }
}

module.exports = { initBrain, aiDecide, isEnabled, setEnabled, brainStats, extractJson, sanitizeDec };
