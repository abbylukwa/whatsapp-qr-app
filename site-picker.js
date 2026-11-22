'use strict';
/* ═══════════════════════════════════════════════════════════════════════
 *  v92.9.12 SITE PICKER — the boss: "make the download be like nsfw.play
 *  returns a list of websites in the users language and user selects
 *  number and sends the number, so first test the sites before listing
 *  them. This happens to both gif pics n vids, and also select number of
 *  results they want sent. Make sure jobs don't crash and jobs are well
 *  calculated."
 *
 *  Flow for pics / gifs / videos (NSFW + safe):
 *    1. member asks ("nsfw.see blonde", "video of cats", "عکس هرات بفرست")
 *    2. the bot takes the top candidate sites for that kind, TESTS them
 *       LIVE (bounded parallel probes, 4s cap each), keeps the alive ones,
 *       and the caller replies with a NUMBERED MENU in the member's
 *       language. Video menus boost the chat's own region — with ARABIC
 *       as the DEFAULT when no locale is known (the boss's rule for this
 *       bot's audience).
 *    3. member replies with a number ("2"), optionally + result count
 *       ("2 5") — the bot hunts THAT site and delivers that many results.
 *
 *  Well-calculated jobs (nothing can crash or pile up):
 *    · probes: ≤ 6 sites per round, 2 rounds max, 4s timeout each,
 *      Promise.allSettled — one menu can never take longer than ~10s
 *      or throw;
 *    · the actual hunt is ONE queued job through the existing media
 *      queue (the same bounded pipe as every other download);
 *    · pending state: ONE entry per chat, 10-minute TTL, auto-expired;
 *    · a stale number after expiry is just a number — harmless.
 * ═══════════════════════════════════════════════════════════════════════ */
const siteHealth = require('./site-health');

const MENU_SITES      = 6;                       /* sites listed per menu      */
const PROBE_TIMEOUT   = 4000;                    /* ms per site test          */
const PROBE_ROUNDS    = 2;                       /* max candidate rounds      */
const PICK_TTL_MS     = 10 * 60 * 1000;          /* menu validity             */
const DEFAULT_COUNT   = { image: 5, gif: 5, video: 1 };
const MAX_COUNT       = { image: 10, gif: 10, video: 3 };
const SITE_KIND       = { image: 'images', gif: 'gifs', video: 'videos' };

/* chatJid -> { kind, nsfw, query, sites:[{n,name,url}], lang, cat, taskType, ts } */
const pending = new Map();
let log = function(){};

function init(logFn){ log = logFn || function(){}; return { menuSites: MENU_SITES, pickTtlMs: PICK_TTL_MS }; }

function pruneOne(chatJid){
  const p = pending.get(chatJid);
  if (p && Date.now() - p.ts > PICK_TTL_MS) pending.delete(chatJid);
}
function setPending(chatJid, p){
  pending.set(chatJid, Object.assign({}, p, { ts: Date.now() }));
  if (pending.size > 500) pending.delete(pending.keys().next().value);
}
function getPending(chatJid){
  pruneOne(chatJid);
  return pending.get(chatJid) || null;
}
function clearPending(chatJid){ pending.delete(chatJid); }
function pendingCount(){ return pending.size; }

/* the DEFAULT boost category — the boss: video downloads default ARABIC
 * when nothing better is known about the chat. Pictures/gifs ride the
 * chat's own locale without a fabricated default. */
function boostCategoryFor(kind, opts){
  const byPhone = siteHealth.categoryByPhone(opts && opts.phone);
  const byLang  = siteHealth.categoryByLang(opts && opts.lang);
  const cat = byPhone || byLang;
  if (cat) return cat;
  return kind === 'video' ? 'arab' : null;
}

/* prettify registry names: "persian-xvideos-persian-lang" → "Xvideos Persian" */
function prettyName(name, url){
  let n = String(name || siteHealth.siteNameByUrl(url) || url || 'site');
  n = n.replace(/-(img|vid|gif|images|videos|gifs|lang|hd)$/i, '')
       .replace(/^afghan-/, '')
       .replace(/-/g, ' ').trim();
  n = n.replace(/\b(xvideos|xhamster|pornhub|xnxx|eporner|redgifs|spankbang|youporn|tnaflix|thisvid|gaymales|porndig|megaporn|freeones|chaturbate|myfreecams|bongacams|stripchat|iwantclips|manyvids|hclips|beeg|sunporno|porncom|watchmygf|drtuber|Empflix|thumbzilla|motherless|txxx|upornia|shemalez|hdtube|voyeurhit|tubepornclassic|camsoda|cam4|bdsmlr|pornpics|kinkdir|okxxx|boinkis|yonalathu|yona)\b/ig,
    m => m.charAt(0).toUpperCase() + m.slice(1).toLowerCase());
  return n.slice(0, 34) || 'site';
}

/* WELL-CALCULATED JOBS — one GLOBAL probe gate: never more than
 * MENU_SITES real HTTP probes in flight across ALL chats combined
 * (each probe may buffer up to 4MB of HTML — this is a 512MB box that
 * also downloads media). Extra menus just wait their turn; a probe can
 * never leak its slot because the release sits in `finally`. */
let probingNow = 0;
const probeWaiters = [];
function probeSlot(){
  if (probingNow < MENU_SITES){ probingNow++; return Promise.resolve(); }
  return new Promise(res => probeWaiters.push(res));
}
function probeRelease(){
  probingNow--;
  const next = probeWaiters.shift();
  if (next){ probingNow++; next(); }
}

/* test candidates LIVE before they may be listed — bounded, never throws */
async function probeAlive(urls){
  const alive = [];
  let pool = urls.slice();
  for (let round = 0; round < PROBE_ROUNDS && alive.length < MENU_SITES && pool.length; round++){
    const batch = pool.splice(0, MENU_SITES);
    const rs = await Promise.allSettled(batch.map(async u => {
      await probeSlot();
      try { return await siteHealth.probeSite(u, PROBE_TIMEOUT); }
      finally { probeRelease(); }
    }));
    for (let i = 0; i < batch.length; i++){
      const r = rs[i];
      const ok = r.status === 'fulfilled' && r.value && r.value.ok === true;
      if (ok){ alive.push(batch[i]); if (alive.length >= MENU_SITES) break; }
    }
  }
  return alive;
}

/* build one menu: returns {ok, sites, boostCat} — the caller renders text
 * in the chat's language. Falls back to {ok:false} when NOTHING answers,
 * so the caller can run the old direct hunt instead of lying. */
async function buildMenu(chatJid, kind, nsfw, opts){
  opts = opts || {};
  const sk = SITE_KIND[kind];
  if (!sk) return { ok:false, reason:'bad-kind' };
  const boostCat = boostCategoryFor(kind, opts);
  /* healthyLinks: dead sites already excluded, locale tiers ordered,
   * fastest first — the candidates worth testing */
  const ranked = siteHealth.healthyLinks(sk, !!nsfw, null, boostCat);
  if (!ranked.length) return { ok:false, reason:'no-candidates', boostCat };
  const aliveUrls = await probeAlive(ranked);
  if (!aliveUrls.length){
    log('warn', 'picker', 'menu probe: 0 alive of ' + Math.min(ranked.length, MENU_SITES * PROBE_ROUNDS) + ' tested (' + sk + ') — falling back to direct hunt');
    return { ok:false, reason:'none-alive', boostCat };
  }
  const sites = aliveUrls.slice(0, MENU_SITES).map((url, i) => ({
    n: i + 1, url, name: prettyName(null, url)
  }));
  setPending(chatJid, {
    kind, nsfw: !!nsfw, query: String(opts.query || ''),
    sites, lang: opts.lang || null, cat: boostCat,
    taskType: opts.taskType || 'dmreply', senderJid: opts.senderJid || null, ts: Date.now()
  });
  log('info', 'picker', 'menu ready: ' + sites.length + ' alive sites for ' + kind + (nsfw ? ' (nsfw)' : '') + ' → ' + (chatJid.split('@')[0] || '') );
  return { ok:true, sites, boostCat, query: opts.query, kind, nsfw: !!nsfw };
}

/* resolve a bare-number reply against this chat's pending menu.
 * "2" → site 2, default count · "2 5" → site 2, 5 results · "2 x 5" too.
 * Returns null when there is no pending menu or the text isn't a pick. */
function parsePick(chatJid, text){
  const p = getPending(chatJid);
  if (!p) return null;
  const t = String(text || '').trim();
  /* "2" → site 2 · "2 5" / "2x5" / "2,5" → site 2, five results */
  let m = /^(\d{1,2})$/.exec(t);
  let siteN = null, count = null;
  if (m){ siteN = parseInt(m[1], 10); }
  else {
    m = /^(\d{1,2})\s*(?:x|×|\*|,|\/|\s)\s*(\d{1,2})$/.exec(t);
    if (m){ siteN = parseInt(m[1], 10); count = parseInt(m[2], 10); }
  }
  if (siteN === null) return null;
  const site = p.sites.find(s => s.n === siteN);
  if (!site){
    /* a number outside the menu — treat as no-pick (caller falls through);
     * drop the menu so stale numbers never grab a hunt */
    clearPending(chatJid);
    return { invalid: true, had: true };
  }
  clearPending(chatJid);
  const def = DEFAULT_COUNT[p.kind] || 5;
  const max = MAX_COUNT[p.kind] || 5;
  const pickedCount = count ? Math.max(1, Math.min(count, max)) : def;
  return { valid: true, site, kind: p.kind, nsfw: p.nsfw, query: p.query,
           count: pickedCount, defaultCount: !count,
           taskType: p.taskType, senderJid: p.senderJid, lang: p.lang, cat: p.cat };
}

module.exports = {
  init, buildMenu, parsePick, setPending, getPending, clearPending,
  pendingCount, boostCategoryFor, prettyName, probeAlive,
  MENU_SITES, PICK_TTL_MS, DEFAULT_COUNT, MAX_COUNT
};
