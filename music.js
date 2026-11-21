/* ═══════════════════════════════════════════════════════════════════════
 *  v88 MUSIC ENGINE — MP3 + MP4 via ONLINE DOWNLOADER SITES (y2mate style)
 *
 *  The boss: "use online downloader site it y2mate do not use ytp". So the
 *  chain here is online converters + stream-mirror APIs, NOT yt-dlp:
 *
 *   search  → Invidious API → Piped API → YouTube HTML scrape (fallback)
 *   audio   → Piped streams → Invidious streams → y2mate ajax → cobalt
 *             instances → vevioz simple API
 *   video   → Invidious progressive mp4 (720→360 quality fallback) →
 *             Piped combined streams → cobalt → y2mate mp4
 *
 *  Every provider is HEALTH-MARKED (data/music-health.json): a provider
 *  that throws is skipped for 10 minutes (self-healing failover), tried
 *  again on the next request, and revived silently when it recovers.
 *  The 32MB pre-send cap keeps every file inside WhatsApp's 34MB rule —
 *  video falls back 720→480→360 before giving up with a clear error.
 *  Caller downloads the returned URL and sends bytes (no temp-link death).
 * ═══════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const HEALTH_FILE = path.join(__dirname, 'data', 'music-health.json');
const MAX_BYTES   = 32 * 1024 * 1024;            /* pre-send cap (< WhatsApp 34MB) */
const PROVIDER_COOLDOWN = 10 * 60 * 1000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const SEARCH_INSTANCES = {
  invidious: ['https://inv.nadeko.net', 'https://invidious.nerdvpn.de', 'https://yewtu.be',
              'https://invidious.f5.si', 'https://iv.melmac.space'],
  piped:     ['https://pipedapi.kavin.rocks', 'https://pipedapi.adminforge.de',
              'https://api.piped.private.coffee', 'https://pipedapi.drgns.space']
};
/* v92.9.6: cobalt v10, minimal body (probe-proven the only shape every
 * instance accepts) — instances get YouTube-login-walled intermittently,
 * the health tracker skips a walled one for 10 min and tries the next. */
const COBALT_INSTANCES = ['https://co.otomir23.me', 'https://api.cobalt.tools',
                          'https://cobalt-backend.canine.tools', 'https://kityune.imput.net'];

let health = {};                                  /* provider -> {fails,lastError,lastCheck} */
let chainDownUntil = 0;                           /* whole-chain cooldown (v90.1 self-healing) */
let log = function(){};

const CHAIN_DOWN_MS = 5 * 60 * 1000;              /* all providers failed → skip chain 5min */

function loadHealth(){ try { health = JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf8')) || {}; } catch (e) { health = {}; } }
function saveHealth(){ try { fs.mkdirSync(path.dirname(HEALTH_FILE), { recursive: true }); fs.writeFileSync(HEALTH_FILE, JSON.stringify(health, null, 1)); } catch (e) {} }
function markFail(p, why){ health[p] = { fails: (health[p] && health[p].fails || 0) + 1, lastError: String(why).slice(0, 100), lastCheck: Date.now() }; saveHealth(); }
function markOk(p){ health[p] = { fails: 0, lastError: null, lastCheck: Date.now() }; saveHealth(); }
function providerDead(p){ const h = health[p]; return !!(h && h.fails >= 2 && Date.now() - h.lastCheck < PROVIDER_COOLDOWN); }
function providerStats(){ return health; }

/* ── one HTTP helper for the whole module ───────────────────────────── */
async function http(opts){
  const r = await axios({ timeout: 20000, maxRedirects: 5, validateStatus: s => s >= 200 && s < 400,
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' }, ...opts });
  return r;
}

/* ═══ 1. SEARCH — video id + title for a query ════════════════════════ */
async function searchInvidious(base, query){
  const r = await http({ url: base + '/api/v1/search', params: { q: query, type: 'video' }, maxContentLength: 4 * 1024 * 1024 });
  const arr = r.data || [];
  for (const v of arr){
    if (v && v.videoId) return { videoId: v.videoId, title: v.title || query, provider: 'invidious:' + new URL(base).host };
  }
  throw new Error('no results');
}
async function searchPiped(base, query){
  const r = await http({ url: base + '/search', params: { q: query, filter: 'videos' }, maxContentLength: 4 * 1024 * 1024 });
  const items = (r.data && r.data.items) || [];
  for (const v of items){
    if (v && v.url && /watch\?v=([\w-]{11})/.test(v.url)) return { videoId: RegExp.$1, title: v.title || query, provider: 'piped:' + new URL(base).host };
  }
  throw new Error('no results');
}
async function searchHtml(query){
  const r = await http({ url: 'https://www.youtube.com/results',
    params: { search_query: query, sp: 'EgIQAQ%3D%3D' },
    maxContentLength: 3 * 1024 * 1024,
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' } });
  const html = String(r.data || '');
  const m = /"videoRenderer":\{"videoId":"([\w-]{11})"[\s\S]{0,600}?"title":\{"runs":\[\{"text":"(.*?)"\}/.exec(html);
  if (!m) throw new Error('html scrape: no result');
  return { videoId: m[1], title: m[2].replace(/\\u([\dA-Fa-f]{4})/g, (x, h) => String.fromCharCode(parseInt(h, 16))).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'"), provider: 'youtube-html' };
}
async function search(query){
  const attempts = [];
  for (const base of SEARCH_INSTANCES.invidious){
    if (providerDead('search:' + base)) continue;
    try { const r = await searchInvidious(base, query); markOk('search:' + base); return r; }
    catch (e) { attempts.push(base); markFail('search:' + base, e.message); }
  }
  for (const base of SEARCH_INSTANCES.piped){
    if (providerDead('search:' + base)) continue;
    try { const r = await searchPiped(base, query); markOk('search:' + base); return r; }
    catch (e) { attempts.push(base); markFail('search:' + base, e.message); }
  }
  try { const r = await searchHtml(query); return r; }
  catch (e) { throw new Error('search failed everywhere (' + attempts.length + ' mirrors + html: ' + e.message + ')'); }
}

/* ═══ 2. STREAMS API PROVIDERS (direct file URLs + sizes) ═════════════ */
async function audioPiped(base, videoId){
  const r = await http({ url: base + '/streams/' + videoId, maxContentLength: 2 * 1024 * 1024 });
  const streams = (r.data && r.data.audioStreams) || [];
  const usable = streams.filter(s => s && s.url && s.bitrate)
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))
    .filter(s => !s.contentLength || s.contentLength <= MAX_BYTES);
  if (!usable.length) throw new Error('no audio stream fits');
  const pick = usable[0];
  return { mediaUrl: pick.url, title: (r.data.title || ''), sizeBytes: pick.contentLength || 0,
           mimetype: (pick.mimetype || 'audio/mpeg').split(';')[0], provider: 'piped:' + new URL(base).host };
}
async function streamsInvidious(base, videoId, mode){
  const r = await http({ url: base + '/api/v1/videos/' + videoId, maxContentLength: 4 * 1024 * 1024 });
  const d = r.data || {};
  const title = d.title || '';
  if (mode === 'audio'){
    const fmts = (d.adaptiveFormats || []).filter(f => f.type && /^audio/i.test(f.type) && f.url);
    fmts.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    const fit = fmts.find(f => !f.contentLength || parseInt(f.contentLength, 10) <= MAX_BYTES) || fmts[0];
    if (!fit) throw new Error('no audio format');
    if (fit.contentLength && parseInt(fit.contentLength, 10) > MAX_BYTES) throw new Error('audio too big');
    return { mediaUrl: fit.url, title, sizeBytes: parseInt(fit.contentLength || 0, 10),
             mimetype: (fit.type || 'audio/mp4').split(';')[0], provider: 'invidious:' + new URL(base).host };
  }
  /* progressive mp4 (video+audio in ONE file — what WhatsApp wants) */
  const fmts = (d.formatStreams || []).filter(f => f.url && /itag=18|itag=22/.test(f.url));
  for (const itag of ['22', '18']){                      /* 720p, then 360p */
    const f = fmts.find(x => x.url.includes('itag=' + itag));
    if (f) return { mediaUrl: f.url, title, sizeBytes: parseInt(f.contentLength || 0, 10),
                    mimetype: 'video/mp4', quality: itag === '22' ? '720p' : '360p',
                    provider: 'invidious:' + new URL(base).host };
  }
  throw new Error('no progressive mp4');
}

/* ═══ 3. CONVERTER-SITE PROVIDERS (cobalt v10) ════════════════════════ */
/* v92.9.6: y2mate + vevioz REMOVED — y2mate.com no longer resolves (its
 * domain is gone, confirmed from both the sandbox and Render's network),
 * vevioz answers 403. They were only slowing every request down. */
async function cobalt(base, videoId, mode, quality){
  const r = await http({ url: base + '/', method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'User-Agent': UA },
    data: { url: 'https://www.youtube.com/watch?v=' + videoId,
            downloadMode: mode === 'audio' ? 'audio' : 'auto',
            ...(mode === 'video' && quality ? { videoQuality: String(quality) } : {}),
            filenameStyle: 'basic' },
    maxContentLength: 2 * 1024 * 1024 });
  const d = r.data || {};
  if ((d.status === 'tunnel' || d.status === 'redirect') && d.url) {
    return { mediaUrl: d.url, title: '', sizeBytes: 0, mimetype: mode === 'audio' ? 'audio/mpeg' : 'video/mp4',
             provider: 'cobalt:' + new URL(base).host };
  }
  throw new Error('cobalt: ' + (d.error && d.error.code || d.status || 'refused'));
}

/* ═══ v92.9.6 AUDIUS — keyless music API, no YouTube anywhere ═════════
 * The boss: "do real life queries make sure they work." The YouTube
 * converter chain is hostage to Google's login walls, but Audius is a
 * public, keyless, artist-backed API with a deep amapiano / DJ / gospel
 * catalog and DIRECT mp3 streams — probe-proven: Master KG Jerusalema,
 * Kabza De Small, Amapiano 2024 all resolve with real audio bytes. */
let audiusHost = null;
async function audiusHostGet(){
  if (audiusHost) return audiusHost;
  const r = await http({ url: 'https://api.audius.co', maxContentLength: 1024 * 1024 });
  const list = (r.data && r.data.data) || [];
  audiusHost = list[0] || 'https://api.audius.co';
  return audiusHost;
}
async function audius(query){
  const H = await audiusHostGet();
  const s = await http({ url: H + '/v1/tracks/search',
    params: { query: query, app_name: 'breadbot' }, maxContentLength: 6 * 1024 * 1024 });
  const tracks = (s.data && s.data.data) || [];
  if (!tracks.length) throw new Error('audius: no tracks for "' + query + '"');
  const t = tracks[0];
  const artist = (t.user && t.user.name) ? t.user.name + ' - ' : '';
  return { mediaUrl: H + '/v1/tracks/' + t.id + '/stream?app_name=breadbot',
           title: artist + (t.title || ''), sizeBytes: 0,
           mimetype: 'audio/mpeg', provider: 'audius' };
}

/* ═══ 4. CONVERT — the full self-healing chain ════════════════════════ */
async function convert(videoId, mode, opts = {}){
  const tries = [];
  const attempt = async (name, fn) => {
    if (providerDead(name)) { tries.push(name + ': skipped (cooldown)'); return null; }
    try {
      const r = await fn();
      markOk(name);
      log('info', 'music', mode + ' via ' + name + ' — ' + (r.title || videoId).slice(0, 60) + (r.sizeBytes ? ' (' + (r.sizeBytes / 1048576).toFixed(1) + 'MB)' : ''));
      return r;
    } catch (e) { markFail(name, e.message); tries.push(name + ': ' + e.message); return null; }
  };
  let r;
  /* v92.9.6: cobalt FIRST — a working instance tunnels the file directly
   * (no stream-matrix puzzles); when YouTube login-walls an instance the
   * health mark skips it for 10 min and the next one gets its chance. */
  for (const base of COBALT_INSTANCES){
    r = await attempt('cobalt:' + new URL(base).host, () => cobalt(base, videoId, mode, opts.quality || (mode === 'video' ? '360' : undefined)));
    if (r) return r;
  }
  for (const base of SEARCH_INSTANCES.piped){
    r = await attempt('audio:piped:' + new URL(base).host, () => audioPiped(base, videoId));
    if (r) return r;
  }
  for (const base of SEARCH_INSTANCES.invidious){
    r = await attempt((mode === 'audio' ? 'audio' : 'video') + ':invidious:' + new URL(base).host, () => streamsInvidious(base, videoId, mode));
    if (r) return r;
  }
  /* v92.9.6: the whole chain failed — converters/stream mirrors are often
   * IP-blocked on datacenter hosts. Skip the chain for 5 min so requests
   * fall to the fallbacks FAST (no ~90s of dead timeouts per ask); the
   * chain retries itself after the cooldown (self-healing). */
  chainDownUntil = Date.now() + CHAIN_DOWN_MS;
  throw new Error('all download providers failed — ' + tries.slice(0, 4).join(' | '));
}

/* ═══ 5. PUBLIC API — getMusic(query, mode) ═══════════════════════════ */
async function getMusic(query, mode){
  /* v92.9.6: the whole-chain cooldown gates the CONVERTER chain only —
   * the Audius fallback is not YouTube-dependent and must NEVER be
   * blocked by it (a cooling chain still serves songs through Audius). */
  const cooling = Date.now() < chainDownUntil;
  let videoId = null, title = '';
  let result = null, lastErr = null;
  if (!cooling){
    const urlMatch = /(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{11})/.exec(query);
    if (urlMatch){ videoId = urlMatch[1]; }
    else {
      const s = await search(query);
      videoId = s.videoId; title = s.title;
    }
    /* quality ladder for video: 720 → 480 → 360 (keeps files under the cap) */
    const ladder = mode === 'video' ? ['720', '480', '360'] : [undefined];
    for (const q of ladder){
      try { result = await convert(videoId, mode, { quality: q }); break; }
      catch (e) { lastErr = e.message; }
    }
    if (result){
      if (!result.title) result.title = title || query;
      return { ok: true, videoId, mode, ...result };
    }
  } else if (mode !== 'audio'){
    throw new Error('converter chain cooling down (providers IP-blocked or down) — fallback takes over, retry in ' + Math.ceil((chainDownUntil - Date.now()) / 60000) + 'min');
  }
  /* v92.9.6: AUDIUS FALLBACK — the converter chain is hostage to Google's
   * login walls; Audius is keyless with direct mp3 streams and a deep
   * amapiano / gospel / DJ catalog (probe-proven real bytes). */
  if (!result && mode === 'audio'){
    try {
      const a = await audius(query);
      log('info', 'music', 'audio via audius — ' + (a.title || '').slice(0, 60));
      result = a;
    } catch (e) { lastErr = (lastErr ? lastErr + ' | ' : '') + 'audius: ' + e.message; }
  }
  if (!result) throw new Error(lastErr || 'no provider succeeded');
  if (!result.title) result.title = title || query;
  return { ok: true, videoId, mode, ...result };
}

function init(logFn){
  log = logFn || function(){};
  loadHealth();
  const dead = Object.keys(health).filter(providerDead).length;
  log('info', 'music', `engine ready — ${Object.keys(health).length} providers tracked${dead ? ', ' + dead + ' in cooldown' : ''}`);
  return { providers: Object.keys(SEARCH_INSTANCES).length + COBALT_INSTANCES.length + 1 };
}

module.exports = { init, search, convert, getMusic, providerStats, MAX_BYTES };
