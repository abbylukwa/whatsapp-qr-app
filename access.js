/* ═══════════════════════════════════════════════════════════════════════
 *  v87 ACCESS CONTROL — the bot talks ONLY to who/where you allow
 *
 *  config/allowed-numbers.txt — DM whitelist (one number per line).
 *      The admin number is auto-added here at every boot.
 *      Rules: admin → full (chat + commands); listed number → COMMANDS
 *      ONLY (media downloads, translate, sites, fetch); anyone else →
 *      completely ignored (no read receipt, no reply, not even opened).
 *
 *  config/allowed-groups.txt — group whitelist (one invite link or group
 *      JID per line). The bot NEVER reacts in a group that is not here —
 *      it cannot be lured into an unknown open group.
 *      Extra rule: inside an allowed group the bot replies ONLY to
 *      messages in non-Shona / non-English languages (Persian, Arabic…).
 *      Shona/English chatter = silence. Admin traffic bypasses every gate.
 *
 *  NSFW designated group: !nsfwgroup on [link|jid] (admin) marks ONE
 *      group. Until activation the bot sends nothing there; after
 *      activation it speaks Persian NSFW there — and NSFW is sent to
 *      that group ONLY. The flag survives reboots (data/access-state.json).
 *
 *  This module is dependency-free (fs/path only) on purpose: the crash
 *  tests require it directly without booting WhatsApp.
 * ═══════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');

const NUMBERS_FILE = path.join(__dirname, 'config', 'allowed-numbers.txt');
const GROUPS_FILE  = path.join(__dirname, 'config', 'allowed-groups.txt');
const BLOCKED_FILE = path.join(__dirname, 'config', 'blocked-groups.txt');
const STATE_FILE   = path.join(__dirname, 'data', 'access-state.json');
/* v92.9.11 — the boss: "any blocked number shall not and will not receive
 * any message especially groups" and "add that number to be able to
 * download files in DM and ai replies also". Two new lists:
 *   · config/blocked-numbers.txt — HARD blacklist. No reply, no read
 *     receipt, no media, no broadcast, no pending resolve — checked in
 *     handleMessage BEFORE the message is even opened, and AGAIN inside
 *     sendBuffer so no scheduler/broadcast/admin path can bypass.
 *   · config/ai-numbers.txt — whitelisted numbers that ALSO get AI
 *     replies in DM (allowed-numbers.txt is still required for commands).
 *     Listed numbers otherwise get COMMANDS-ONLY service. */
const BLOCKED_NUMBERS_FILE = path.join(__dirname, 'config', 'blocked-numbers.txt');
const AI_NUMBERS_FILE      = path.join(__dirname, 'config', 'ai-numbers.txt');

/* ═══ v92.9.6 HARD GROUP BLACKLIST ═══
 * The boss: the bot "is sending messages to the wrong … groups — in the
 * groups KCC youth fellowship and KCC bubble study it should never send
 * anything". These two (plus anything in config/blocked-groups.txt) are
 * BLOCKHOLES: no reply, no media, no admin echo, no read receipt, no
 * verification prompt — and the check runs again inside sendBuffer so a
 * scheduler/broadcast/brain path can never sneak past the handler. */
const BLOCKED_HEADER = [
  '# ═══ BLOCKED GROUPS (v92.9.6) ═══',
  '# The bot NEVER sends anything to these groups. One per line:',
  '#   · a group NAME (matched case-insensitively, e.g. KCC Youth Fellowship)',
  '#   · a group JID ending in @g.us',
  '#   · a group invite link',
  '# Lines starting with # are comments. The two KCC groups are permanent.',
  ''
].join('\n');
const BLOCKED_NAME_PATTERNS = [
  /kcc\s+youth/i,          /* "KCC Youth Fellowship" and any wording around it */
  /kcc\s+bubble/i          /* "KCC Bubble Study" */
];
const PERMANENT_BLOCKED_LINES = ['KCC Youth Fellowship', 'KCC Bubble Study'];

const NUMBERS_HEADER = [
  '# ═══ ALLOWED NUMBERS (v87) ═══',
  '# One WhatsApp number per line — the bot replies to THESE ONLY.',
  '# Formats: +27614159817 · 27614159817 · 0771122334 (Zimbabwe local)',
  '# The admin number is added automatically at every boot (do not remove).',
  '# Lines starting with # are comments. Edit freely, save, restart (or !reloadaccess).',
  ''
].join('\n');

/* v92.9.11 HARD NUMBER BLACKLIST header */
const BLOCKED_NUMBERS_HEADER = [
  '# ═══ BLOCKED NUMBERS (v92.9.11) ═══',
  '# The bot NEVER sends anything to these numbers — no reply, no read',
  '# receipt, no media, no broadcast, no admin echo. One number per line:',
  '# Formats: +263771234567 · 263771234567 (any spacing is fine).',
  '# The check runs BEFORE the message is even opened, and again at the',
  '# final send boundary — no path can bypass it. The admin number is',
  '# refused here on purpose (you cannot block yourself by mistake).',
  ''
].join('\n');

/* v92.9.11 AI-ENABLED DM NUMBERS header */
const AI_NUMBERS_HEADER = [
  '# ═══ AI-REPLY NUMBERS (v92.9.11) ═══',
  '# Numbers here get AI replies in DM (persona chat with memory), ON TOP',
  '# of the command service every whitelisted number already has.',
  '# The number must ALSO be in config/allowed-numbers.txt — commands',
  '# always win over chat: media intents, .play, next, !commands are',
  '# served first; only plain conversation reaches the AI.',
  ''
].join('\n');

const GROUPS_HEADER = [
  '# ═══ ALLOWED GROUPS (v87) ═══',
  '# One WhatsApp group invite link (or a group JID ending in @g.us) per line.',
  '# The bot talks ONLY in these groups. Invite links are matched by their',
  '# CODE, so extra query junk (?s=cl&p=a&iam=2…) is ignored — and pasting',
  '# the same link twice stays ONE entry.',
  '# Lines starting with # are comments. Edit freely, save, restart (or !reloadaccess).',
  ''
].join('\n');

/* ── normalization ──────────────────────────────────────────────────── */
function digitsOnly(s){ return String(s || '').replace(/\D+/g, ''); }
function normalizePhone(input){
  if (!input) return null;
  const jid = String(input);
  if (jid.endsWith('@g.us')) return null;              /* groups are not phones */
  const raw = jid.split('@')[0];
  let d = digitsOnly(raw);
  if (!d) return null;
  if (d.startsWith('0') && d.length >= 9 && d.length <= 10){
    d = '263' + d.slice(1);                            /* Zimbabwe local → intl */
  }
  /* strip a single leading country-code duplicate like 263263… is NOT
   * auto-corrected — keep honest; compare in normalized space only */
  return d;
}
function phoneFromJid(jid){
  if (!jid || String(jid).endsWith('@g.us')) return null;
  const d = digitsOnly(String(jid).split('@')[0]);
  return d || null;
}
function isGroupJid(jid){ return !!jid && String(jid).endsWith('@g.us'); }

/* ── invite links: pull the CODE out of any link shape ──────────────── */
function parseInviteCode(link){
  if (!link) return null;
  const s = String(link).trim();
  const m = /chat\.whatsapp\.com\/(?:invite\/)?([A-Za-z0-9]{15,40})/.exec(s);
  if (m) return m[1];
  /* a bare code pasted alone (20-22 chars typical) */
  if (/^[A-Za-z0-9]{18,30}$/.test(s)) return s;
  return null;
}

/* ── file helpers ───────────────────────────────────────────────────── */
function readLines(file){
  try {
    return fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map(l => l.replace(/\s+#.*$/, '').trim())       /* inline comments */
      .filter(l => l && !l.startsWith('#'));
  } catch (e) { return []; }
}
function writeLines(file, header, lines){
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, header + lines.join('\n') + (lines.length ? '\n' : ''));
}

/* ── numbers ────────────────────────────────────────────────────────── */
let allowedNumbers = [];                                 /* normalized digits */
function loadNumbers(adminPhone){
  const lines = readLines(NUMBERS_FILE);
  allowedNumbers = [...new Set(lines.map(normalizePhone).filter(Boolean))];
  /* auto-add the admin number — idempotent, every load */
  const adm = normalizePhone(adminPhone);
  if (adm && !allowedNumbers.includes(adm)){
    allowedNumbers.push(adm);
    const rawLines = readLines(NUMBERS_FILE);
    writeLines(NUMBERS_FILE, NUMBERS_HEADER, [...rawLines, '+' + adm]);
  }
  return allowedNumbers;
}
function addNumber(input){
  const p = normalizePhone(input);
  if (!p) return { ok: false, error: 'not a phone number: ' + input };
  if (!readLines(NUMBERS_FILE).length){
    writeLines(NUMBERS_FILE, NUMBERS_HEADER, ['+' + p]);
  } else {
    const raw = readLines(NUMBERS_FILE);
    const norm = raw.map(normalizePhone).filter(Boolean);
    if (norm.includes(p)) return { ok: true, added: false, number: p, count: norm.length };
    writeLines(NUMBERS_FILE, NUMBERS_HEADER, [...raw, '+' + p]);
  }
  allowedNumbers = readLines(NUMBERS_FILE).map(normalizePhone).filter(Boolean);
  return { ok: true, added: true, number: p, count: allowedNumbers.length };
}
function removeNumber(input){
  const p = normalizePhone(input);
  if (!p) return { ok: false, error: 'not a phone number: ' + input };
  const raw = readLines(NUMBERS_FILE);
  const left = raw.filter(l => normalizePhone(l) !== p);
  if (left.length === raw.length) return { ok: false, error: 'not in the list: +' + p };
  writeLines(NUMBERS_FILE, NUMBERS_HEADER, left);
  allowedNumbers = left.map(normalizePhone).filter(Boolean);
  return { ok: true, removed: p, count: allowedNumbers.length };
}
function isAllowedNumber(phoneOrJid, adminPhone){
  const adm = normalizePhone(adminPhone);
  const p = normalizePhone(phoneOrJid);
  if (!p) return false;
  if (adm && p === adm) return true;                     /* admin always allowed */
  return allowedNumbers.includes(p);
}

/* ── v92.9.11 BLOCKED NUMBERS + AI-REPLY NUMBERS ───────────────────── */
let blockedNumbers = [];                                 /* normalized digits */
let aiNumbers      = [];                                 /* normalized digits */
function loadBlockedNumbers(adminPhone){
  const adm = normalizePhone(adminPhone);
  const raw = readLines(BLOCKED_NUMBERS_FILE);
  /* the admin can never be blacklisted — a self-block would make the bot
   * mute its own boss and look like a wrong-recipient bug */
  blockedNumbers = [...new Set(raw.map(normalizePhone).filter(Boolean))].filter(p => p !== adm);
  if (adm && raw.some(l => normalizePhone(l) === adm)){
    writeLines(BLOCKED_NUMBERS_FILE, BLOCKED_NUMBERS_HEADER,
      raw.filter(l => normalizePhone(l) !== adm));       /* silently strip */
  }
  return blockedNumbers;
}
function loadAiNumbers(){
  aiNumbers = [...new Set(readLines(AI_NUMBERS_FILE).map(normalizePhone).filter(Boolean))];
  return aiNumbers;
}
function isBlockedNumber(phoneOrJid){
  const p = normalizePhone(phoneOrJid);
  if (!p) return false;
  return blockedNumbers.includes(p);
}
function isAiNumber(phoneOrJid){
  const p = normalizePhone(phoneOrJid);
  if (!p) return false;
  return aiNumbers.includes(p);
}
function addBlockedNumber(input, adminPhone){
  const p = normalizePhone(input);
  if (!p) return { ok: false, error: 'not a phone number: ' + input };
  const adm = normalizePhone(adminPhone);
  if (adm && p === adm) return { ok: false, error: 'that is the admin number — it can never be blocked' };
  if (!readLines(BLOCKED_NUMBERS_FILE).length){
    writeLines(BLOCKED_NUMBERS_FILE, BLOCKED_NUMBERS_HEADER, ['+' + p]);
  } else {
    const raw = readLines(BLOCKED_NUMBERS_FILE);
    if (raw.map(normalizePhone).filter(Boolean).includes(p)) return { ok: true, added: false, number: p, count: blockedNumbers.length };
    writeLines(BLOCKED_NUMBERS_FILE, BLOCKED_NUMBERS_HEADER, [...raw, '+' + p]);
  }
  loadBlockedNumbers(adminPhone);
  return { ok: true, added: true, number: p, count: blockedNumbers.length };
}
function removeBlockedNumber(input, adminPhone){
  const p = normalizePhone(input);
  if (!p) return { ok: false, error: 'not a phone number: ' + input };
  const raw = readLines(BLOCKED_NUMBERS_FILE);
  const left = raw.filter(l => normalizePhone(l) !== p);
  if (left.length === raw.length) return { ok: false, error: 'not in the list: +' + p };
  writeLines(BLOCKED_NUMBERS_FILE, BLOCKED_NUMBERS_HEADER, left);
  loadBlockedNumbers(adminPhone);
  return { ok: true, removed: p, count: blockedNumbers.length };
}
function addAiNumber(input){
  const p = normalizePhone(input);
  if (!p) return { ok: false, error: 'not a phone number: ' + input };
  const raw = readLines(AI_NUMBERS_FILE);
  if (raw.map(normalizePhone).filter(Boolean).includes(p)) return { ok: true, added: false, number: p, count: aiNumbers.length };
  if (!raw.length) writeLines(AI_NUMBERS_FILE, AI_NUMBERS_HEADER, ['+' + p]);
  else writeLines(AI_NUMBERS_FILE, AI_NUMBERS_HEADER, [...raw, '+' + p]);
  loadAiNumbers();
  return { ok: true, added: true, number: p, count: aiNumbers.length };
}
function removeAiNumber(input){
  const p = normalizePhone(input);
  if (!p) return { ok: false, error: 'not a phone number: ' + input };
  const raw = readLines(AI_NUMBERS_FILE);
  const left = raw.filter(l => normalizePhone(l) !== p);
  if (left.length === raw.length) return { ok: false, error: 'not in the list: +' + p };
  writeLines(AI_NUMBERS_FILE, AI_NUMBERS_HEADER, left);
  loadAiNumbers();
  return { ok: true, removed: p, count: aiNumbers.length };
}
function blockedNumberList(){ return blockedNumbers.slice(); }
function aiNumberList(){ return aiNumbers.slice(); }

/* ── groups ─────────────────────────────────────────────────────────── */
let allowedGroupCodes = [];                              /* invite codes      */
let allowedGroupJids  = [];                              /* raw @g.us entries */
let blockedLines      = [];                              /* file entries      */
let state = { inviteToJid: {}, designated: null, activated: false, activeGroups: {} };

function loadGroups(){
  const lines = readLines(GROUPS_FILE);
  const codes = new Set(), jids = new Set();
  for (const l of lines){
    const code = parseInviteCode(l);
    if (code) { codes.add(code); continue; }
    if (isGroupJid(l)) jids.add(l.trim());
  }
  allowedGroupCodes = [...codes];                        /* dedupes same link */
  allowedGroupJids  = [...jids];
  blockedLines = readLines(BLOCKED_FILE);                /* v92.9.6 blacklist */
  loadState();
  return { codes: allowedGroupCodes, jids: allowedGroupJids };
}
function loadState(){
  try { state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; }
  catch (e) { /* first boot — defaults stand */ }
  return state;
}
function saveState(){
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
function addGroup(linkOrJid){
  const code = parseInviteCode(linkOrJid);
  const raw = readLines(GROUPS_FILE);
  if (code){
    if (allowedGroupCodes.includes(code)) return { ok: true, added: false, code, count: allowedGroupCodes.length };
    writeLines(GROUPS_FILE, GROUPS_HEADER, [...raw, 'https://chat.whatsapp.com/' + code]);
    loadGroups();
    return { ok: true, added: true, code, count: allowedGroupCodes.length };
  }
  if (isGroupJid(linkOrJid)){
    const jid = String(linkOrJid).trim();
    if (allowedGroupJids.includes(jid)) return { ok: true, added: false, jid, count: allowedGroupJids.length };
    writeLines(GROUPS_FILE, GROUPS_HEADER, [...raw, jid]);
    loadGroups();
    return { ok: true, added: true, jid, count: allowedGroupJids.length };
  }
  return { ok: false, error: 'not an invite link or @g.us JID: ' + linkOrJid };
}
/* the bot learned which group an invite code actually is (joined it,
 * or saw groupGetInviteInfo) → remember code→JID so the whitelist
 * matches the REAL group, never the link text */
function registerInviteJid(code, jid){
  if (!code || !isGroupJid(jid)) return false;
  if (state.inviteToJid[code] === jid) return true;
  state.inviteToJid[code] = jid;
  saveState();
  return true;
}
function isAllowedGroup(chatJid){
  if (!isGroupJid(chatJid)) return false;
  if (allowedGroupJids.includes(chatJid)) return true;
  for (const code of allowedGroupCodes){
    if (state.inviteToJid[code] === chatJid) return true;
  }
  return false;
}
/* ── v92.9.6 HARD BLACKLIST — KCC Youth Fellowship / KCC Bubble Study ── */
function normalizeName(s){
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function nameIsBlocked(subject){
  const n = normalizeName(subject);
  if (!n) return false;
  if (BLOCKED_NAME_PATTERNS.some(re => re.test(n))) return true;
  for (const line of blockedLines){
    const ln = normalizeName(line);
    /* a name line matches when one contains the other (both directions —
     * the file may hold the short form, the WhatsApp subject the long one) */
    if (ln && (n.includes(ln) || ln.includes(n))) return true;
  }
  return false;
}
function isBlockedChat(chatJid, subject){
  if (!isGroupJid(chatJid)) return false;
  /* JID lines in the file match directly; invite-code lines match through
   * the learned code→JID map; name lines match the live WhatsApp subject. */
  for (const l of blockedLines){
    const t = l.trim();
    if (t === chatJid) return true;
    const code = parseInviteCode(t);
    if (code && state.inviteToJid[code] === chatJid) return true;
  }
  return nameIsBlocked(subject);
}
function addBlocked(entry){
  const raw = String(entry || '').trim();
  if (!raw) return { ok: false, error: 'empty' };
  const rawFile = readLines(BLOCKED_FILE);
  const norm = normalizeName(raw);
  if (rawFile.some(l => normalizeName(l) === norm)) return { ok: true, added: false, count: blockedLines.length };
  writeLines(BLOCKED_FILE, BLOCKED_HEADER, [...rawFile, raw]);
  blockedLines = readLines(BLOCKED_FILE);
  return { ok: true, added: true, count: blockedLines.length };
}
function removeBlocked(entry){
  const rawFile = readLines(BLOCKED_FILE);
  const norm = normalizeName(entry);
  const left = rawFile.filter(l => {
    if (PERMANENT_BLOCKED_LINES.some(p => normalizeName(p) === normalizeName(l))) return true;  /* the two KCC groups stay */
    return normalizeName(l) !== norm;
  });
  if (left.length === rawFile.length) return { ok: false, error: 'not in the list' };
  writeLines(BLOCKED_FILE, BLOCKED_HEADER, left);
  blockedLines = readLines(BLOCKED_FILE);
  return { ok: true, removed: entry, count: blockedLines.length };
}
function blockedEntries(){ return blockedLines.slice(); }

/* ── v92.9.6 REQUEST-ACTIVATED GROUPS — silence until the boss acts ───
 * The boss: "I will tell it which groups to send by requesting a video
 * in that group so that it activated." A group is BORN SILENT; it opens
 * when the ADMIN makes a media request inside it (search / .play / next
 * / !download) and stays open until the admin closes it (!groupoff).
 * Persisted in access-state.json so reboots keep the boss's choices. */
function activateGroup(chatJid, meta){
  if (!isGroupJid(chatJid)) return false;
  state.activeGroups = state.activeGroups || {};
  state.activeGroups[chatJid] = {
    by: (meta && meta.by) || 'admin-request',
    name: (meta && meta.name) || null,
    ts: Date.now()
  };
  saveState();
  return true;
}
function deactivateGroup(chatJid){
  if (!state.activeGroups || !state.activeGroups[chatJid]) return false;
  delete state.activeGroups[chatJid];
  saveState();
  return true;
}
function isGroupActive(chatJid){
  return !!(state.activeGroups && state.activeGroups[chatJid]);
}
function activeGroupList(){
  return Object.entries(state.activeGroups || {}).map(([jid, v]) => ({ jid, name: v.name, by: v.by, ts: v.ts }));
}

/* ── NSFW designated group + activation ─────────────────────────────── */
function setDesignated(jid){ state.designated = isGroupJid(jid) ? jid : null; saveState(); return state.designated; }
function getDesignated(){ return state.designated; }
function isDesignated(chatJid){ return !!state.designated && chatJid === state.designated; }
function setNsfwActivated(v){ state.activated = !!v; saveState(); return state.activated; }
function isNsfwActivated(){ return !!state.activated; }

/* ═══ v92.9.10 PER-GROUP CAPABILITIES — the boss approves AI / NSFW /
 * music per group from the discovery DM ("yes" = allow all three, or
 * pick with "ai yes" / "music no"). Defaults keep the old service up:
 * AI chatter OFF and NSFW OFF until the admin allows them, music ON
 * (media requests were always the core service in activated groups). ═══ */
function setGroupFeatures(chatJid, feats){
  if (!isGroupJid(chatJid)) return null;
  state.groupFeatures = state.groupFeatures || {};
  const prev = state.groupFeatures[chatJid] || {};
  state.groupFeatures[chatJid] = {
    ai:    feats.ai    !== undefined ? !!feats.ai    : !!prev.ai,
    nsfw:  feats.nsfw  !== undefined ? !!feats.nsfw  : !!prev.nsfw,
    music: feats.music !== undefined ? !!feats.music : (prev.music !== false),
    by:    feats.by    || prev.by || 'admin',
    ts: Date.now()
  };
  saveState();
  return state.groupFeatures[chatJid];
}
function getGroupFeatures(chatJid){
  if (state.groupFeatures && state.groupFeatures[chatJid]) return state.groupFeatures[chatJid];
  return { ai: false, nsfw: false, music: true };   /* default: silent on chatter, media works */
}
function groupFeature(chatJid, key){
  const f = getGroupFeatures(chatJid);
  return !!f[key];
}

/* ── policies (pure — the crash tests exercise these directly) ──────── */
/* DM: 'full' (admin) · 'commands' (listed number) · 'ignore' (everyone else) */
function dmPolicy(senderJid, isAdmin){
  if (isAdmin) return 'full';
  if (isAllowedNumber(senderJid)) return 'commands';
  return 'ignore';
}
/* Languages the bot treats as "home" — it stays SILENT about them in groups. */
const HOME_LANGS = ['en', 'sn', 'nd', 'mixed'];
function shouldReplyGroup(langCode){
  return !HOME_LANGS.includes(String(langCode || 'en').toLowerCase());
}
/* Group send matrix — the single decision the whole group flow funnels into.
 * v92.9.6 (boss rule): silence is the DEFAULT everywhere.
 *   · blacklisted groups (KCC Youth Fellowship / KCC Bubble Study and any
 *     entry in config/blocked-groups.txt) NEVER get anything — not even
 *     admin echoes;
 *   · a group that is not on the whitelist never gets anything (the old
 *     foreign-language open-door is gone — language no longer opens doors);
 *   · a whitelisted group stays silent until the ADMIN activates it by
 *     making a media request inside it;
 *   · an activated group serves everyone in it (the boss opted it in). */
function groupDecision(chatJid, langCode, isAdmin, subject){
  if (!isGroupJid(chatJid))            return { reply: false, reason: 'not-a-group' };
  if (isBlockedChat(chatJid, subject)) return { reply: false, reason: 'group-blacklisted' };
  if (!isAllowedGroup(chatJid))        return { reply: false, reason: 'group-not-allowed' };
  if (!isGroupActive(chatJid))         return { reply: false, reason: 'group-not-activated' };
  return { reply: true, reason: isAdmin ? 'admin' : 'activated-media-group' };
}

/* ── boot ───────────────────────────────────────────────────────────── */
function init(adminPhone){
  if (!fs.existsSync(NUMBERS_FILE)){
    const adm = normalizePhone(adminPhone);
    writeLines(NUMBERS_FILE, NUMBERS_HEADER, adm ? ['+' + adm, '+27614159817'] : ['+27614159817']);
  }
  if (!fs.existsSync(GROUPS_FILE)){
    writeLines(GROUPS_FILE, GROUPS_HEADER, ['https://chat.whatsapp.com/GRmW5TzQNQpLnLyGnHQxMW']);
  }
  if (!fs.existsSync(BLOCKED_FILE)){
    writeLines(BLOCKED_FILE, BLOCKED_HEADER, PERMANENT_BLOCKED_LINES);
  }
  /* v92.9.11: fresh blacklist/AI files with headers on first boot */
  if (!fs.existsSync(BLOCKED_NUMBERS_FILE)){
    writeLines(BLOCKED_NUMBERS_FILE, BLOCKED_NUMBERS_HEADER, []);
  }
  if (!fs.existsSync(AI_NUMBERS_FILE)){
    writeLines(AI_NUMBERS_FILE, AI_NUMBERS_HEADER, []);
  }
  loadNumbers(adminPhone);
  loadGroups();
  loadBlockedNumbers(adminPhone);
  loadAiNumbers();
  return { numbers: allowedNumbers.length, groups: allowedGroupCodes.length + allowedGroupJids.length, blocked: blockedLines.length,
           blockedNumbers: blockedNumbers.length, aiNumbers: aiNumbers.length };
}

module.exports = {
  normalizePhone, phoneFromJid, isGroupJid, parseInviteCode,
  init, loadNumbers, loadGroups, loadState, saveState,
  addNumber, removeNumber, isAllowedNumber, allowedNumbers: () => allowedNumbers,
  addGroup, registerInviteJid, isAllowedGroup,
  allowedGroupCodes: () => allowedGroupCodes, allowedGroupJids: () => allowedGroupJids,
  /* v92.9.6 blacklist + request-activation */
  isBlockedChat, nameIsBlocked, addBlocked, removeBlocked, blockedEntries, BLOCKED_FILE,
  /* v92.9.11 number blacklist + AI-reply numbers */
  loadBlockedNumbers, isBlockedNumber, addBlockedNumber, removeBlockedNumber, blockedNumberList, BLOCKED_NUMBERS_FILE,
  loadAiNumbers, isAiNumber, addAiNumber, removeAiNumber, aiNumberList, AI_NUMBERS_FILE,
  activateGroup, deactivateGroup, isGroupActive, activeGroupList,
  setDesignated, getDesignated, isDesignated, setNsfwActivated, isNsfwActivated,
  setGroupFeatures, getGroupFeatures, groupFeature,
  dmPolicy, shouldReplyGroup, groupDecision, HOME_LANGS,
  NUMBERS_FILE, GROUPS_FILE, STATE_FILE
};
