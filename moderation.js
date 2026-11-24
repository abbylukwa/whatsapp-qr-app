/* ══════════════════════════════════════════════════════════════
 *  MODERATION (v92.9.18) — the boss: "auto ban scammers links and
 *  auto kick those people sending more than 2 group links at once ...
 *  I want them both timed not to be suspicious."
 *
 *  WHY TIMED: a bot that kicks 0.2s after the message looks like a bot
 *  (and burns the account). A human mod reads, thinks, acts. So every
 *  action lands on a RANDOM human-timed delay: warns 3-8s, kicks
 *  30-90s, re-entry kicks 10-25s. Deletion of the scam message is
 *  immediate only when the antilink delete already is (silent, common
 *  in groups); the VISIBLE consequence is always delayed.
 *
 *  LADDER (per user, persisted to data/moderation.json):
 *   · group links (chat.whatsapp.com/...): 3+ AT ONCE or 3 in 10 min
 *     → scheduled KICK + ban record. 1-2 → silent record only (the
 *     existing antilink may still delete them).
 *   · scam links (shorteners + money/phishing patterns): 1st → delete
 *     + timed casual warn; 2nd → scheduled KICK + BAN + admin report.
 *   · banned user speaks again after rejoining → fast timed kick.
 *   · every step is reported to the admin with the reason + evidence. ═ */
const fs   = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, 'data', 'moderation.json');
let state = { banned: {}, strikes: {} };
try { const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); if (j && j.banned) state = j; } catch (e) {}

let saveT = null;
function save(){
  if (saveT) return;
  saveT = setTimeout(() => { saveT = null;
    try { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
          fs.writeFileSync(STATE_FILE, JSON.stringify(state)); } catch (e) {}
  }, 4000);
  if (saveT.unref) saveT.unref();
}

let io = { kick: null, del: null, warn: null, report: null };   /* injected */
function configure(cb){ Object.assign(io, cb || {}); }
const rnd  = (a, b) => Math.floor(a + Math.random() * (b - a));

const SCAM_DOMAINS = /(^|\.)(bit\.ly|tinyurl\.com|cutt\.ly|tiny\.cc|is\.gd|rebrand\.ly|shorturl\.at|rb\.gy|t\.ly|ow\.ly|shorte\.be|adf\.ly)$/i;
const SCAM_TEXT = /(double your|make money|earn .{0,15}(daily|per day)|investment (plan|platform)|forex|betting tips|fixed match|crypto (double|doubler)|100% (profit|win)|free followers|free data|login[- ]verify|account[- ]?secure|verify your (account|number)|whatsapp (lottery|promo)|ceo (musk|binance)|giveaway.*dm)/i;
const WA_GROUP_LINK = /chat\.whatsapp\.com\/(?:invite\/)?[A-Za-z0-9_-]{10,}/gi;
const URL_RE = /https?:\/\/[^\s<>"']{4,}/gi;

function classify(text){
  const t = String(text || '');
  const urls = (t.match(URL_RE) || []).map(u => { try { return new URL(u).hostname; } catch (e) { return ''; } });
  const groupLinks = (t.match(WA_GROUP_LINK) || []).length;
  const scam = (SCAM_TEXT.test(t) && urls.length > 0) || urls.some(h => SCAM_DOMAINS.test(h)) ||
               /(wa\.me\/.*\?|api\.whatsapp\.com\/send\?)/i.test(t);
  return { urls, groupLinks, scam };
}

/* the human-timed engine — every visible action waits its random beat */
function schedule(delayMs, fn, what){
  setTimeout(() => { try { fn(); } catch (e) {} }, delayMs);
}
function kickWith(chat, user, reason, evidence){
  schedule(rnd(30000, 90000), () => {
    if (io.kick) io.kick(chat, user, reason);
    state.banned[user] = { at: Date.now(), chat, reason };
    save();
    if (io.report) io.report('🚪 ' + String(user).split('@')[0] + ' removed from the group (' + reason + ')\n' + (evidence || '').slice(0, 300));
  }, 'kick');
}
const WARNS = [
  'hey, group links don\'t go here 🙏',
  'bro this chat is for requests only — no links',
  'no links here please 🙂',
  'links aren\'t allowed in this one, thanks'
];
function warnWith(chat, user, text){
  schedule(rnd(3000, 8000), () => { if (io.warn) io.warn(chat, text || WARNS[Math.floor(Math.random() * WARNS.length)]); }, 'warn');
}

/* ── the entry point: called for EVERY focus-group message ─────── */
function check(chat, user, text, isAdmin){
  if (isAdmin || !text) return false;
  const key = chat + '|' + user;
  const now = Date.now();
  state.strikes[key] = (state.strikes[key] || []).filter(s => now - s.at < 30 * 60 * 1000);
  const c = classify(text);

  /* banned user spoke again → fast, still-human kick */
  if (state.banned[user]){
    schedule(rnd(10000, 25000), () => { if (io.kick) io.kick(chat, user, 'banned — rejoined'); }, 're-kick');
    if (io.report) io.report('🔁 ' + String(user).split('@')[0] + ' came back after a ban — timed kick scheduled.');
    return true;
  }

  /* the boss: MORE THAN 2 group links → kick */
  if (c.groupLinks >= 3){
    kickWith(chat, user, '3+ group links (spam)', text);
    return true;
  }
  if (c.groupLinks > 0){
    state.strikes[key].push({ at: now, type: 'grouplink', n: c.groupLinks });
    const gl = state.strikes[key].filter(s => s.type === 'grouplink').reduce((a, s) => a + s.n, 0);
    save();
    if (gl >= 3){ kickWith(chat, user, 'group links ×' + gl + ' in a window', text); return true; }
    warnWith(chat, user);                        /* 1-2 links: human-timed nudge */
    return false;                                 /* let the normal flow continue */
  }

  /* scam links: warn first, kick+ban second */
  if (c.scam){
    const scams = state.strikes[key].filter(s => s.type === 'scam').length;
    if (scams >= 1){ kickWith(chat, user, 'scam link (2nd)', text); return true; }
    state.strikes[key].push({ at: now, type: 'scam' });
    save();
    if (io.del) io.del(chat, null, text);          /* message gone quietly */
    warnWith(chat, user);
    if (io.report) io.report('⚠️ Scam link caught (1st) — ' + String(user).split('@')[0] + ' warned; next one is a timed kick.\n' + text.slice(0, 200));
    return true;                                   /* message handled — do not reply/engage */
  }
  return false;
}

module.exports = { configure, check, classify, _state: () => state, _setState: (s) => { state = s; } };
