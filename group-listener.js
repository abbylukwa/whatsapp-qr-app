/* ═══════════════════════════════════════════════════════════════════════
 *  v90 LISTEN-FIRST — the boss: "I want the bot to first listen to groups
 *  before auto replying … by just reading a couple of messages the bot
 *  will get to know … which groups it should do all the stuff."
 *
 *  Every whitelisted group starts in OBSERVE: the bot reads silently,
 *  builds a profile (language, who talks, how many messages, whether
 *  anyone addresses the bot or asks for media). After a couple of
 *  messages it decides:
 *
 *    ENGAGE  — someone asked for media / mentioned the bot → full service
 *    SILENT  — pure human conversation → bot reads, replies to NOTHING
 *              automatically; explicit commands (!cmd / local verbs)
 *              STILL WORK. Re-checked every 10 min: chatter turning into
 *              requests flips it back to engage by itself.
 *
 *  Admin overrides persist: !listen (observe again) · !engage · !silence
 *  data/group-listener.json keeps decisions across reboots.
 * ═══════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'data', 'group-listener.json');
const RING = 30;                       /* messages kept per group */
const DECIDE_AFTER = 3;                /* decide after N observed messages */
const SILENT_RECHECK_MS = 10 * 60 * 1000;
const OBSERVE_MAX_MS = 8 * 60 * 1000;  /* never observe longer than 8min */

let profiles = {};                     /* chatJid -> profile */
let modes = {};                        /* chatJid -> admin override mode */
let intents = null;                   /* injected: text -> intent|null */
let isCommandFn = null;               /* injected: text -> bool (explicit cmd) */
let log = function(){};

function load(){
  try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {};
        modes = j.modes || {}; profiles = j.profiles || {}; }
  catch (e) { modes = {}; profiles = {}; }
}
function save(){
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    /* persist decisions only — rings stay in memory */
    fs.writeFileSync(FILE, JSON.stringify({ modes, decisions }, null, 1));
  } catch (e) {}
}
let decisions = {};                    /* chatJid -> { mode, decidedAt, why } */

function profile(chatJid){
  if (!profiles[chatJid]) profiles[chatJid] = { msgs: [], firstAt: 0, lastAt: 0, langCounts: {}, intents: 0, mentions: 0, senders: {} };
  return profiles[chatJid];
}

/* does this text look bot-directed? */
function botDirected(text){
  if (!text) return false;
  if (isCommandFn && isCommandFn(text)) return true;
  if (intents && intents(text)) return true;
  if (/@?\b(bot|bread|breadbot)\b/i.test(String(text))) return true;
  return false;
}

function observe(chatJid, opts = {}){
  const p = profile(chatJid);
  const now = Date.now();
  if (!p.firstAt) p.firstAt = now;
  p.lastAt = now;
  p.msgs.push({ t: now, s: opts.senderJid || '', x: String(opts.text || '').slice(0, 160) });
  if (p.msgs.length > RING) p.msgs.shift();
  if (opts.lang) p.langCounts[opts.lang] = (p.langCounts[opts.lang] || 0) + 1;
  if (opts.senderJid) p.senders[opts.senderJid] = (p.senders[opts.senderJid] || 0) + 1;
  if (botDirected(opts.text)){ p.intents++; p.lastIntentAt = now; }
}

function decide(chatJid){
  const p = profile(chatJid);
  const override = modes[chatJid];
  if (override) return override;
  if (p.intents > 0) return 'engage';                       /* someone called the bot */
  if (p.msgs.length >= DECIDE_AFTER) return 'silent';       /* pure chatter → stay out */
  return 'observe';                                          /* not sure yet — keep reading */
}

function canAutoEngage(chatJid){
  const m = decide(chatJid);
  /* silent ≠ commands: only AUTO media/chatter is gated */
  return m === 'engage';
}
/* true while we're still profiling — used for a one-time "listening" note */
function isObserving(chatJid){
  const p = profile(chatJid);
  const m = modes[chatJid] || decide(chatJid);
  if (m !== 'observe') return false;
  const age = Date.now() - (p.firstAt || 0);
  return p.msgs.length < DECIDE_AFTER && age < OBSERVE_MAX_MS;
}

/* silent groups: every 10 min of new chatter, give them a fresh look —
 * if messages since the last decision contain a request → engage again */
function recheck(){
  const now = Date.now();
  for (const chatJid of Object.keys(profiles)){
    const p = profiles[chatJid];
    if (!p.lastIntentAt) continue;
    if (modes[chatJid]) continue;                            /* admin override stands */
    const recentIntent = (p.msgs || []).some(m => m.t > (decisions[chatJid]?.decidedAt || 0) && botDirected(m.x));
    if (recentIntent && decide(chatJid) !== 'engage'){
      decisions[chatJid] = { mode: 'engage', decidedAt: now, why: 'new request after silence' };
      save();
      log('info', 'listener', chatJid + ' → ENGAGE (new request in a silent group)');
    }
  }
}
setInterval(recheck, SILENT_RECHECK_MS).unref();

/* admin overrides */
function setMode(chatJid, mode){
  if (!['observe', 'engage', 'silent'].includes(mode)) return false;
  modes[chatJid] = mode;
  decisions[chatJid] = { mode, decidedAt: Date.now(), why: 'admin override' };
  save();
  return true;
}
function clearMode(chatJid){ delete modes[chatJid]; delete decisions[chatJid]; save(); }
function modeOf(chatJid){ return modes[chatJid] || decide(chatJid); }
function summary(){
  const out = { groups: Object.keys(profiles).length, byMode: { observe: 0, engage: 0, silent: 0 }, overrides: Object.keys(modes).length };
  for (const c of Object.keys(profiles)){
    const m = modeOf(c);
    out.byMode[m] = (out.byMode[m] || 0) + 1;
  }
  return out;
}
function profileSummary(chatJid){
  const p = profiles[chatJid];
  if (!p) return null;
  const langs = Object.entries(p.langCounts).sort((a, b) => b[1] - a[1]).map(([l, n]) => l + '×' + n).join(', ');
  return { msgs: p.msgs.length, intents: p.intents, senders: Object.keys(p.senders).length,
           langs: langs || '—', mode: modeOf(chatJid) };
}
function init(opts = {}){
  intents = opts.intentFn || null;
  isCommandFn = opts.commandFn || null;
  log = opts.log || log;
  load();
  const s = summary();
  log('info', 'listener', `listen-first ready — ${s.groups} group(s) known, ${s.overrides} admin override(s)`);
  return s;
}

module.exports = { init, observe, canAutoEngage, isObserving, setMode, clearMode, modeOf, summary, profileSummary, decide };
