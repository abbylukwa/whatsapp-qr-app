/* ══════════════════════════════════════════════════════════════
 *  FOCUS MODE (v92.9.16) — the boss: "it won't interact with anyone
 *  except this group and the admin ... no matter what, even if it
 *  crashes it doesn't ever send to anyone else."
 *
 *  THREE layers, all fail-closed:
 *   1. INVITE LOCK — the group is pinned by its invite code
 *      (HGW3IdVbDJyImOgp1BFqT7). On connect the code is resolved to the
 *      real group JID (sock.groupGetInviteInfo) and persisted to
 *      data/focus_group.json; the persisted JID survives reboots.
 *   2. SEND KILL SWITCH — sendBuffer (the ONE choke point every send
 *      goes through) refuses ANY jid that is not the admin or the focus
 *      group. A crashed handler cannot make the bot talk to a stranger:
 *      the gate is above every code path, by construction.
 *   3. ROUTER GATE — messages.upsert drops non-whitelisted chats before
 *      any processing (no AI, no media, no bytes — bandwidth too).
 *
 *  SESSIONS: "same search needs different results" + "2 videos per
 *  query, next and preview, 3+ users at once" — every user in the
 *  focus group gets their OWN session (chat|user key): a user's "next"
 *  never collides with another user's search. Results never repeat
 *  within a session (the dedup cache + idx cursor guarantee it), and a
 *  repeated query after exhaustion re-hunts with a rotated slot, so the
 *  same search surfaces DIFFERENT results.
 *
 *  MEDIA LIMIT: video queries are capped at 2 per request (the boss's
 *  number — bandwidth-aware); pics/gifs keep the normal batch. ═══ */
const fs   = require('fs');
const path = require('path');

/* v92.9.29: FOCUS_STATE_FILE env override — tests must never touch the
 * live data/focus_group.json (the drift-swap persists, so a test that
 * runs against the real path would corrupt live state). */
const STATE_FILE = process.env.FOCUS_STATE_FILE || path.join(__dirname, 'data', 'focus_group.json');
const FOCUS_INVITE = (process.env.FOCUS_GROUP_INVITE || 'HGW3IdVbDJyImOgp1BFqT7').trim();

let adminJid = '';                       /* set at boot from server config */
let focusJids = new Set();               /* resolved group JID(s) */
try {
  const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  if (j && j.jid) focusJids.add(j.jid);
} catch (e) { /* resolve on first connect */ }

function setAdminJid(j){ if (j && typeof j === 'string') adminJid = j; }

/* v92.9.28 LID-NATIVE DMs — since the LID migration WhatsApp can deliver
 * a 1:1 chat with remoteJid like '998877@lid.whatsapp.net' even when the
 * contact is a normal phone number. The admin's OWN DM can arrive as an
 * @lid jid, and a raw string compare against ADMIN_JID would silently
 * drop the boss — the bot would look dead to its owner in real life.
 * The resolver maps an @lid base back to a phone-number base using the
 * group-participant pairs (every group member carries BOTH id (pn) and
 * lid fields in group metadata). Fail-closed: a lid that does not
 * resolve to the admin is refused, never guessed. */
let lidResolver = null;
function setLidResolver(fn){ if (typeof fn === 'function') lidResolver = fn; }
function addFocusJid(jid){
  if (!jid || typeof jid !== 'string' || !jid.endsWith('@g.us')) return false;
  if (focusJids.has(jid)) return true;
  focusJids.add(jid);
  try { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
        fs.writeFileSync(STATE_FILE, JSON.stringify({ invite: FOCUS_INVITE, jid: jid, at: Date.now() })); } catch (e) {}
  return true;
}
function resolveInviteCode(){ return FOCUS_INVITE; }

/* ═══ v92.9.29 TWO-FACTOR IDENTITY — the boss: "make a 3-way or 2-factor
 * verification like group JID and group link verification, same for the
 * phone number verification and phone JID." ═══
 *
 * GROUP 2FA — factor 1: the JID is in the focus set (persisted). Factor 2:
 * the pinned invite LINK resolves to that SAME JID. Only when BOTH agree
 * is the group fully verified. If they disagree, the LINK is ground truth
 * (the invite code is pinned in env/config and cannot be spoofed by
 * someone re-creating a group with a similar name): the stale JID is
 * replaced by the link-resolved one and the change is persisted.
 *
 * PHONE 2FA — factor 1: the phone NUMBER equals the admin's. Factor 2:
 * the exact JID form matches (the pn JID equals the admin JID, or an
 * @lid JID resolves through the harvested pair map back to the admin's
 * number). Both factors must hold for DM service; the group member who
 * DMs has neither. */
let linkVerified = false;
let lastGroupVerifyAt = 0;
function verifyGroupLink(resolvedJid){
  lastGroupVerifyAt = Date.now();
  if (!resolvedJid || typeof resolvedJid !== 'string' || !resolvedJid.endsWith('@g.us')){
    linkVerified = false;
    return { ok: false, reason: 'invite resolve failed — group stays JID-persisted only, retry scheduled' };
  }
  if (focusJids.has(resolvedJid)){
    linkVerified = true;
    return { ok: true, jid: resolvedJid, factors: ['jid-in-focus-set', 'link-resolves-to-same-jid'] };
  }
  /* Link is ground truth — swap the stale JID out */
  const stale = [...focusJids];
  focusJids.clear(); focusJids.add(resolvedJid);
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ invite: FOCUS_INVITE, jid: resolvedJid, at: Date.now() }));
  } catch (e) {}
  linkVerified = true;
  return { ok: true, jid: resolvedJid, factors: ['link-resolved', 'stale-jid-replaced:' + stale.join('|')] };
}
function isGroupLinkVerified(){ return linkVerified && focusJids.size > 0; }

function verifyAdmin2FA(jid){
  if (!jid || typeof jid !== 'string' || !adminJid) return { ok: false, factors: [] };
  const at = jid.indexOf('@');
  const dom = at > -1 ? jid.slice(at + 1) : '';
  const base = jid.split('@')[0].split(':')[0];
  const adminBase = adminJid.split('@')[0].split(':')[0];
  const factors = [];
  if (dom === 's.whatsapp.net'){
    /* Factor 1: number matches. Factor 2: exact JID matches. */
    if (base === adminBase) factors.push('phone-number');
    if ((base + '@s.whatsapp.net') === adminJid) factors.push('phone-jid');
    return { ok: factors.length === 2, factors };
  }
  if (dom === 'lid.whatsapp.net'){
    /* Factor 1: LID resolves to the admin's NUMBER. Factor 2: the
     * resolved number reconstructs the exact admin JID. */
    const pn = (lidResolver && lidResolver(base)) || null;
    if (pn && String(pn) === adminBase) factors.push('phone-number');
    if (pn && (String(pn) + '@s.whatsapp.net') === adminJid) factors.push('phone-jid-via-lid');
    return { ok: factors.length === 2, factors };
  }
  return { ok: false, factors };
}
/* THE kill-switch predicate — fail closed: unknown jid = refused */
function isAllowedJid(jid){
  if (!jid || typeof jid !== 'string') return false;
  if (jid === 'status@broadcast') return false;
  /* v92.9.28: admin DM arriving as an @lid jid — resolve lid→pn and
   * allow ONLY when the resolved phone is the admin. Everyone else
   * (group members DMing, strangers, other bots) stays refused. */
  const at = jid.indexOf('@');
  const dom = at > -1 ? jid.slice(at + 1) : '';
  const base = jid.split('@')[0].split(':')[0];
  if (dom === 's.whatsapp.net' && adminJid && (base + '@s.whatsapp.net') === adminJid) return true;
  if (dom === 'lid.whatsapp.net'){
    const pnBase  = (lidResolver && lidResolver(base)) || null;
    return !!(pnBase && adminJid && (String(pnBase) + '@s.whatsapp.net') === adminJid);
  }
  return focusJids.has(jid);
}

/* ── per-USER sessions ─────────────────────────────────────────── */
const sessions = new Map();              /* 'chat|user' → search state */
const SESSION_TTL = 30 * 60 * 1000;      /* 30 min like NEXT_TTL */
function noteRequester(chatJid, userJid){
  if (chatJid && userJid) sessions._last = { chat: chatJid, user: userJid, at: Date.now() };
}
function peekRequester(chatJid){
  const L = sessions._last;
  return (L && L.chat === chatJid) ? L.user : null;
}
function rememberUserSession(chatJid, userJid, st){
  if (!chatJid || !userJid || !st) return;
  sessions.set(chatJid + '|' + userJid, Object.assign({}, st, { at: Date.now() }));
}
function getUserSession(chatJid, userJid){
  const k = chatJid + '|' + userJid;
  const st = sessions.get(k);
  if (st && Date.now() - st.at > SESSION_TTL){ sessions.delete(k); return null; }
  return st || null;
}
/* swap a user's session in as the chat's active search so the existing
 * sendRelevantBatch/handleNextMedia pipeline serves THAT user */
function adoptUserSession(chatJid, userJid, adopt){
  const st = getUserSession(chatJid, userJid);
  if (!st) return null;
  if (typeof adopt === 'function') adopt(chatJid, st);
  return st;
}
function capVideoCount(n){ return Math.max(1, Math.min(parseInt(n || 2, 10) || 2, 2)); }   /* the boss: 2 videos */

/* ── parsers (any language) ────────────────────────────────────── */
/* media-type spec words: English, Persian, Spanish, Portuguese, French,
 * Arabic, Swahili, Shona, Chinese, Hindi, Russian, Indonesian */
const SPEC_RE = /\b(video|videos|vid|vids|clip|movie|film|ویدیو|فيديو|视频|वीडियो|видео|bideo|video s)\b|\b(pic|pics|photo|photos|image|images|picture|pictures|jpg|عکس|صورة|照片|तस्बिर|фото|foto|imagen|imagen s|picha|foto s|mufananidzo)\b|\b(gif|gifs|animated|گیف|جيف|动图|gif s|gitp)\b/i;
function detectSpec(text){
  const t = String(text || '').toLowerCase();
  if (!t) return '';
  if (/(^|\s)(gif|gifs|گیف|جيف|动图|gitp)($|\s)/.test(t) || 'gif' === t) return 'gif';
  if (/(video|vid|clip|movie|film|ویدیو|فيديو|视频|वीडियो|видео|bideo)/.test(t)) return 'video';
  if (/(pic|photo|image|picture|jpg|عکس|صورة|照片|фото|foto|imagen|picha|mufananidzo)/.test(t)) return 'image';
  return '';
}
const PREVIEW_RE = /^(preview|previews|show me|tarisa|پیش نمایش|vista previa|aperçu|превью|預覽|pratinjau|অাগের)\s*$/i;
function isPreviewRequest(text){ return PREVIEW_RE.test(String(text || '').trim()); }

module.exports = { setAdminJid, setLidResolver, addFocusJid, resolveInviteCode, verifyGroupLink, isGroupLinkVerified, verifyAdmin2FA, isAllowedJid, noteRequester, peekRequester, rememberUserSession, getUserSession, adoptUserSession, capVideoCount, detectSpec, isPreviewRequest, _state: () => ({ adminJid, focusJids: [...focusJids], linkVerified, lastGroupVerifyAt }) };
