/* ═══════════════════════════════════════════════════════════════════════
 *  v88 SITE HEALTH — self-healing layer for the site registry
 *
 *  Every registry site's search URL is PROBED (real HTTP fetch + result
 *  check, same method that built the registry). Sites that stop working
 *  (403/429/503 walls, parked shells, DNS death) are automatically
 *  EXCLUDED from media searches for a cooldown, then re-probed and
 *  silently revived if they recover. The bot never sends a user a link
 *  chain that starts with a corpse.
 *
 *  data/site-health.json  — persisted health map (survives reboots)
 *  · probe on boot (background) + every 6h + on demand (!sitehealth check)
 *  · live failures (a download that dies) mark the site too
 *  · GET /api/site-health + !sitehealth for the admin
 * ═══════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const REGISTRY_FILE = path.join(__dirname, 'config', 'sites.json');
const HEALTH_FILE   = path.join(__dirname, 'data', 'site-health.json');

const PROBE_INTERVAL_MS = 6 * 60 * 60 * 1000;   /* 6h */
const DEAD_COOLDOWN_MS  = 30 * 60 * 1000;       /* dead → skipped 30min */
const PROBE_CONC        = 3;                     /* gentle — avoid 429s */
const PROBE_QUERY       = process.env.SITE_PROBE_QUERY || 'amateur';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

let registry = [];
let categoryShares = {};                         /* zimbabwe -> [southafrica] */
let health = {};                                 /* url -> {ok, status, ms, lastCheck, fails, lastError} */
let probing = false;
let log = function(){};                          /* injected pushLog */

function loadRegistry(){
  try {
    const j = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
    registry = j.sites || [];
    categoryShares = j.categoryShares || {};
  } catch (e) { registry = []; categoryShares = {}; }
  return registry;
}
/* v89 LOCALIZATION — the boss: Zimbabwe has no own tube sites but South
 * Africa does, so they share. A boosted category searches its OWN sites
 * first, then any shared neighbours', then the rest of the world. */
function categoriesFor(cat){
  if (!cat) return [];
  return [cat].concat(Array.isArray(categoryShares[cat]) ? categoryShares[cat] : []);
}
/* sender's phone country code → registry category (v89 localization) */
const PHONE_COUNTRY = {
  '263': 'zimbabwe', '27': 'southafrica',
  '234': 'africa', '254': 'africa', '256': 'africa', '233': 'africa', '220': 'africa', '221': 'africa', '225': 'africa', '227': 'africa', '229': 'africa', '237': 'africa', '241': 'africa', '242': 'africa', '243': 'africa', '250': 'africa', '251': 'africa', '252': 'africa', '253': 'africa', '257': 'africa', '258': 'africa', '260': 'africa', '261': 'africa', '264': 'africa', '265': 'africa', '266': 'africa', '267': 'africa', '268': 'africa', '269': 'africa',
  '20': 'arab', '212': 'arab', '213': 'arab', '216': 'arab', '218': 'arab', '222': 'arab', '249': 'arab', '963': 'arab', '964': 'arab', '965': 'arab', '966': 'arab', '967': 'arab', '968': 'arab', '971': 'arab', '973': 'arab', '974': 'arab',
  '98': 'persian', '91': 'indian',
  '49': 'euro', '33': 'euro', '39': 'euro', '34': 'euro', '351': 'euro', '31': 'euro', '32': 'euro', '46': 'euro', '47': 'euro', '45': 'euro', '380': 'euro', '7': 'euro', '48': 'euro', '420': 'euro', '36': 'euro', '30': 'euro', '43': 'euro', '41': 'euro', '353': 'euro', '40': 'euro', '359': 'euro', '385': 'euro', '386': 'euro', '421': 'euro',
  '90': 'more', '81': 'more', '82': 'more', '52': 'more', '54': 'more', '55': 'more', '57': 'more', '51': 'more', '58': 'more'
};
/* detected chat language → registry category (v89 localization) */
const LANG_CATEGORY = {
  sn: 'zimbabwe', nd: 'zimbabwe', zu: 'southafrica', xh: 'southafrica', st: 'southafrica', af: 'southafrica', tn: 'southafrica',
  fa: 'persian', ar: 'arab', hi: 'indian', ur: 'indian', bn: 'indian', ta: 'indian',
  yo: 'africa', ig: 'africa', ha: 'africa', sw: 'africa', am: 'africa',
  fr: 'euro', de: 'euro', it: 'euro', es: 'euro', pt: 'euro', ru: 'euro', nl: 'euro', pl: 'euro', uk: 'euro', ro: 'euro', el: 'euro', hu: 'euro', cs: 'euro', sv: 'euro',
  tr: 'more', ja: 'more', ko: 'more'
};
function categoryByPhone(phone){
  const digits = String(phone || '').replace(/\D/g, '');
  const codes = Object.keys(PHONE_COUNTRY).sort((a, b) => b.length - a.length);
  for (const cc of codes){ if (digits.startsWith(cc)) return PHONE_COUNTRY[cc]; }
  return null;
}
function categoryByLang(lang){ return LANG_CATEGORY[String(lang || '').toLowerCase()] || null; }
function loadHealth(){
  try { health = JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf8')) || {}; }
  catch (e) { health = {}; }
  return health;
}
function saveHealth(){
  try {
    fs.mkdirSync(path.dirname(HEALTH_FILE), { recursive: true });
    fs.writeFileSync(HEALTH_FILE, JSON.stringify(health, null, 1));
  } catch (e) {}
}

/* ── probe ONE site search URL (the real working check) ─────────────── */
async function probeSite(template, timeoutMs = 14000){
  const url = String(template).replace(/\{query\}/g, encodeURIComponent(PROBE_QUERY));
  const t0 = Date.now();
  try {
    const r = await axios.get(url, { timeout: timeoutMs, maxRedirects: 4,
      validateStatus: s => s >= 200 && s < 400,
      maxContentLength: 4 * 1024 * 1024,
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' } });
    const html = String(r.data || '');
    if (!/<html|<!doctype/i.test(html)) return { ok: false, why: 'not-html', status: r.status };
    if (html.length < 20000) return { ok: false, why: 'shell(' + Math.round(html.length/1024) + 'KB)', status: r.status };
    const links = (html.match(/href="[^"]+"/g) || []).length;
    if (links < 10) return { ok: false, why: 'no-links(' + links + ')', status: r.status };
    return { ok: true, status: r.status, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, why: e.response ? 'http-' + e.response.status : (e.code || 'error'),
             status: e.response ? e.response.status : null };
  }
}

function markOk(url, ms){
  const h = health[url] || { fails: 0 };
  health[url] = { ok: true, status: 200, ms: ms || 0, lastCheck: Date.now(), fails: 0, lastError: null };
  saveHealth();
}
function markFail(url, why){
  const h = health[url] || { fails: 0 };
  h.ok = false; h.lastError = String(why || 'fail').slice(0, 80);
  h.lastCheck = Date.now(); h.fails = (h.fails || 0) + 1;
  health[url] = h;
  saveHealth();
}

/* ── the ordered chain the scraper calls use ───────────────────────────
 * 1. the member's !site pick (unconditionally — their choice)
 * 2. their LOCAL category's sites (phone country / chat language — v89),
 *    plus shared neighbours (Zimbabwe ↔ Mzansi), fastest first
 * 3. healthy registry links for the kind/nsfw
 * 4. everything else known-healthy (MY_LINKS env rides inside server.js)
 * Dead sites (recently failed, inside cooldown) are EXCLUDED. */
function healthyLinks(kind, nsfw, preferUrl, boostCat){
  const now = Date.now();
  const rows = registry.filter(s =>
    s.kind === kind && (!nsfw || s.nsfw !== false));
  const boostCats = categoriesFor(boostCat);
  const scored = rows.map(s => {
    const h = health[s.url];
    const dead = h && h.ok === false && (now - (h.lastCheck || 0)) < DEAD_COOLDOWN_MS;
    const catIdx = boostCats.indexOf(s.category);          /* -1 = rest of world */
    return { url: s.url, name: s.name, dead, catIdx,
             ms: h && h.ok ? (h.ms || 9999) : 5000 };
  });
  const live = scored.filter(x => !x.dead);
  /* own category first, then shared neighbours, then the world —
   * inside each tier the fastest probed site rides first */
  live.sort((a, b) => {
    const ca = a.catIdx === -1 ? 99 : a.catIdx, cb = b.catIdx === -1 ? 99 : b.catIdx;
    if (ca !== cb) return ca - cb;
    return a.ms - b.ms;
  });
  return [...new Set([].concat(preferUrl || [], live.map(x => x.url)))];
}
function siteNameByUrl(url){
  const s = registry.find(x => x.url === url);
  return s ? s.name : null;
}

/* ── full probe sweep (boot / 6h / !sitehealth check) ───────────────── */
async function probeAll(opts = {}){
  if (probing) return { skipped: true };
  probing = true;
  const t0 = Date.now();
  let alive = 0, dead = 0;
  try {
    const list = registry.slice();
    let i = 0;
    async function worker(){
      while (i < list.length){
        const idx = i++;
        const s = list[idx];
        if (!opts.force && !opts.all && health[s.url]){
          const h = health[s.url];
          /* skip sites checked recently (unless force) */
          if (Date.now() - (h.lastCheck || 0) < PROBE_INTERVAL_MS && h.ok !== false) { alive++; continue; }
        }
        const r = await probeSite(s.url, opts.timeout || 14000);
        if (r.ok){ markOk(s.url, r.ms); alive++; }
        else { markFail(s.url, r.why); dead++; }
        await new Promise(res => setTimeout(res, 250));   /* gentle pacing */
      }
    }
    await Promise.all(Array.from({ length: PROBE_CONC }, worker));
    log('info', 'sitehealth', `probe sweep done in ${Math.round((Date.now()-t0)/1000)}s — ${alive} alive, ${dead} down`);
  } finally { probing = false; }
  return { alive, dead, ms: Date.now() - t0 };
}
function summary(){
  const now = Date.now();
  let alive = 0, dead = 0, never = 0;
  const deadList = [];
  for (const s of registry){
    const h = health[s.url];
    if (!h) { never++; continue; }
    if (h.ok === false && (now - (h.lastCheck || 0)) < DEAD_COOLDOWN_MS){ dead++; deadList.push(s.name + ' (' + (h.lastError || 'fail') + ')'); }
    else alive++;
  }
  return { total: registry.length, alive, dead, never, deadList };
}
/* v88: alive/down breakdown per category (persian, arab, southafrica…) */
function perCategory(){
  const now = Date.now(), out = {};
  for (const s of registry){
    const cat = s.category || 'misc';
    if (!out[cat]) out[cat] = { total: 0, alive: 0, down: 0, never: 0 };
    out[cat].total++;
    const h = health[s.url];
    if (!h) out[cat].never++;
    else if (h.ok === false && (now - (h.lastCheck || 0)) < DEAD_COOLDOWN_MS) out[cat].down++;
    else out[cat].alive++;
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => a[0].localeCompare(b[0])));
}
let timer = null;
function init(logFn, opts = {}){
  log = logFn || function(){};
  loadRegistry(); loadHealth();
  const s = summary();
  log('info', 'sitehealth', `registry: ${s.total} sites — ${s.alive} known alive, ${s.dead} down, ${s.never} unprobed`);
  /* first sweep in the background — never delays boot */
  if (opts.probeOnBoot !== false) setTimeout(() => probeAll({ all: true }).catch(e => log('warn', 'sitehealth', 'boot probe: ' + e.message)), 15000);
  timer = setInterval(() => probeAll().catch(function(){}), PROBE_INTERVAL_MS);
  if (timer.unref) timer.unref();
  return s;
}
function stop(){ if (timer) clearInterval(timer); timer = null; }

module.exports = {
  init, stop, probeAll, probeSite, markOk, markFail,
  healthyLinks, siteNameByUrl, summary, perCategory,
  categoryByPhone, categoryByLang, categoriesFor,
  loadRegistry, loadHealth, saveHealth,
  REGISTRY_FILE, HEALTH_FILE, registry: () => registry
};
