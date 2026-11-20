/* ══════════════════════════════════════════════════════════════
 *  v85 FREE TRANSLATOR — no-signup machine translation
 * ══════════════════════════════════════════════════════════════
 *  Works with ZERO API keys and ZERO extra dependencies (native
 *  fetch, Node ≥ 18). Chain (first healthy provider wins):
 *
 *    1. DeepL          — only if DEEPL_API_KEY is set in env
 *                        (keys ending ":fx" → free endpoint)
 *    2. LibreTranslate — only if LIBRETRANSLATE_URL is set (and
 *                        LIBRETRANSLATE_API_KEY if your instance needs it)
 *    3. Lingva         — public Google-Translate proxy mirrors, no key
 *    4. MyMemory       — free tier, no key (texts ≤ 500 chars only;
 *                        set MYMEMORY_EMAIL in env to raise the daily cap)
 *    5. Google (gtx)   — public endpoint, no key, longest texts
 *
 *  Responses are cached (1 hour) so repeated phrases never re-hit
 *  the network. "Empty slot = skipped" — same rule as the rest of
 *  the app: the bot works with whatever is configured.
 * ══════════════════════════════════════════════════════════════ */

/* node-cache is already in package.json; fall back to a plain Map so the
 * module still works if it is ever removed from the dependency tree. */
let cacheGet, cacheSet;
try {
  const NodeCache = require('node-cache');
  const store = new NodeCache({ stdTTL: 3600, checkperiod: 600 });
  cacheGet = (k) => store.get(k);
  cacheSet = (k, v) => store.set(k, v);
} catch (e) {
  const map = new Map();
  cacheGet = (k) => {
    const hit = map.get(k);
    if (hit && hit.exp > Date.now()) return hit.val;
    if (hit) map.delete(k);
    return undefined;
  };
  cacheSet = (k, v) => { map.set(k, { val: v, exp: Date.now() + 3600000 }); };
}

const TIMEOUT_MS   = parseInt(process.env.TRANSLATE_TIMEOUT_MS || '10000', 10);
const MAX_TEXT_LEN = 5000;   /* guardrail — Google gtx handles this fine */
const RETRIES      = parseInt(process.env.TRANSLATE_RETRIES || '2', 10);

/* ── shared HTTP: fetch + retry with backoff on 429 / 5xx / timeouts ──
 * A plain-browser UA keeps the free endpoints from throttling us. */
const HTTP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const RETRY_STATUSES = [429, 502, 503, 504];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function httpCall(cfg, tries){
  const attempts = (tries === undefined ? RETRIES : tries);
  let lastErr;
  for (let i = 0; i <= attempts; i++){
    try {
      const isPost = (cfg.method || 'GET').toUpperCase() === 'POST';
      const res = await fetch(cfg.url, {
        method: isPost ? 'POST' : 'GET',
        headers: Object.assign(
          { 'User-Agent': HTTP_UA, 'Accept': '*/*' },
          isPost ? { 'Content-Type': 'application/json' } : {},
          cfg.headers || {}
        ),
        body: isPost ? JSON.stringify(cfg.data || {}) : undefined,
        signal: AbortSignal.timeout(cfg.timeout || TIMEOUT_MS)
      });
      if (!res.ok){
        const err = new Error('HTTP ' + res.status);
        err.status = res.status;
        throw err;
      }
      const ct = String(res.headers.get('content-type') || '');
      const data = ct.includes('json') ? await res.json() : await res.text();
      return { status: res.status, data };
    } catch (e) {
      lastErr = e;
      const retry = (e.status && RETRY_STATUSES.includes(e.status))
                 || /timeout|abort|ECONNRESET|ECONNREFUSED|fetch failed/i.test(e.message || '');
      if (i < attempts && retry){ await sleep(1200 * (i + 1)); continue; }
      break;
    }
  }
  throw lastErr;
}

/* Lingva mirrors — public instances come and go, so the list is
 * env-overridable and the chain tries them in order. */
const LINGVA_HOSTS = (process.env.LINGVA_INSTANCES || '')
  .split(',').map(s => s.trim()).filter(Boolean);

/* ── language catalogue (code → human name) ─────────────────── */
const LANGUAGES = {
  auto: 'Auto-detect', af: 'Afrikaans', sq: 'Albanian', am: 'Amharic', ar: 'Arabic',
  hy: 'Armenian', az: 'Azerbaijani', eu: 'Basque', be: 'Belarusian', bn: 'Bengali',
  bs: 'Bosnian', bg: 'Bulgarian', ca: 'Catalan', ceb: 'Cebuano', 'zh-CN': 'Chinese (Simplified)',
  'zh-TW': 'Chinese (Traditional)', co: 'Corsican', hr: 'Croatian', cs: 'Czech', da: 'Danish',
  nl: 'Dutch', en: 'English', eo: 'Esperanto', et: 'Estonian', fi: 'Finnish',
  fr: 'French', fy: 'Frisian', gl: 'Galician', ka: 'Georgian', de: 'German',
  el: 'Greek', gu: 'Gujarati', ht: 'Haitian Creole', ha: 'Hausa', haw: 'Hawaiian',
  he: 'Hebrew', hi: 'Hindi', hmn: 'Hmong', hu: 'Hungarian', is: 'Icelandic',
  ig: 'Igbo', id: 'Indonesian', ga: 'Irish', it: 'Italian', ja: 'Japanese',
  jv: 'Javanese', kn: 'Kannada', kk: 'Kazakh', km: 'Khmer', rw: 'Kinyarwanda',
  ko: 'Korean', ku: 'Kurdish', ky: 'Kyrgyz', lo: 'Lao', la: 'Latin',
  lv: 'Latvian', lt: 'Lithuanian', lb: 'Luxembourgish', mk: 'Macedonian', mg: 'Malagasy',
  ms: 'Malay', ml: 'Malayalam', mt: 'Maltese', mi: 'Maori', mr: 'Marathi',
  mn: 'Mongolian', my: 'Burmese', ne: 'Nepali', no: 'Norwegian', ny: 'Nyanja',
  or: 'Odia', ps: 'Pashto', fa: 'Persian', pl: 'Polish', pt: 'Portuguese',
  pa: 'Punjabi', ro: 'Romanian', ru: 'Russian', sm: 'Samoan', gd: 'Scots Gaelic',
  sr: 'Serbian', st: 'Sesotho', sn: 'Shona', sd: 'Sindhi', si: 'Sinhala',
  sk: 'Slovak', sl: 'Slovenian', so: 'Somali', es: 'Spanish', su: 'Sundanese',
  sw: 'Swahili', sv: 'Swedish', tl: 'Tagalog', tg: 'Tajik', ta: 'Tamil',
  tt: 'Tatar', te: 'Telugu', th: 'Thai', tr: 'Turkish', tk: 'Turkmen',
  uk: 'Ukrainian', ur: 'Urdu', ug: 'Uyghur', uz: 'Uzbek', vi: 'Vietnamese',
  cy: 'Welsh', xh: 'Xhosa', yi: 'Yiddish', yo: 'Yoruba', zu: 'Zulu'
};

/* Google's legacy Hebrew code still floats around in some responses. */
function normalizeLang(code){
  let c = String(code || '').trim();
  if (!c) return 'auto';
  if (c.toLowerCase() === 'auto') return 'auto';
  if (c === 'iw') c = 'he';
  if (/^zh$/i.test(c)) c = 'zh-CN';
  return c;
}
function langName(code){
  const c = normalizeLang(code);
  return LANGUAGES[c] || LANGUAGES[c.split('-')[0]] || c;
}

/* ── provider 1: DeepL (keyed, best quality — used only when key present) ── */
function deeplHost(key){
  return key.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
}
async function viaDeepl(text, source, target){
  const key = process.env.DEEPL_API_KEY;
  if (!key) throw new Error('no DEEPL_API_KEY');
  const body = { text: [text], target_lang: target.toUpperCase() };
  if (source && source !== 'auto') body.source_lang = source.toUpperCase();
  const r = await httpCall({
    url: deeplHost(key) + '/v2/translate', method: 'post', data: body,
    headers: { 'Authorization': 'DeepL-Auth-Key ' + key },
    timeout: TIMEOUT_MS
  });
  const out = r.data && r.data.translations && r.data.translations[0];
  if (!out || !out.text) throw new Error('deepl: empty response');
  return { text: out.text, provider: 'deepl', detected: out.detected_source_language };
}

/* ── provider 2: LibreTranslate (keyed or open instance) ── */
async function viaLibreTranslate(text, source, target){
  const base = process.env.LIBRETRANSLATE_URL;
  if (!base) throw new Error('no LIBRETRANSLATE_URL');
  const body = { q: text, source: source || 'auto', target, format: 'text' };
  const key = process.env.LIBRETRANSLATE_API_KEY;
  if (key) body.api_key = key;
  const r = await httpCall({
    url: base.replace(/\/+$/, '') + '/translate', method: 'post', data: body,
    timeout: TIMEOUT_MS
  });
  if (!r.data || !r.data.translatedText) throw new Error('libretranslate: empty response');
  return { text: r.data.translatedText, provider: 'libretranslate', detected: r.data.detectedLanguage };
}

/* ── provider 3: Lingva mirrors (no key) ── */
async function viaLingva(text, source, target){
  const hosts = LINGVA_HOSTS.length ? LINGVA_HOSTS
    : ['https://lingva.ml', 'https://lingva.lunar.icu', 'https://lingva.garudalinux.org'];
  let lastErr;
  for (const host of hosts){
    try {
      const url = host.replace(/\/+$/, '') + '/api/v1/' + (source || 'auto') + '/' + target
                + '/' + encodeURIComponent(text);
      const r = await httpCall({ url, timeout: TIMEOUT_MS });
      if (!r.data || !r.data.translation) throw new Error('empty response');
      let hostname = host;
      try { hostname = new URL(host).hostname; } catch (e) {}
      return { text: r.data.translation, provider: 'lingva (' + hostname + ')',
               detected: r.data.info && r.data.info.detectedSource };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('lingva: all mirrors failed');
}

/* ── provider 4: MyMemory (no key; needs an explicit source lang, ≤500 chars) ── */
async function viaMyMemory(text, source, target){
  if (text.length > 500) throw new Error('mymemory: text > 500 chars (use another provider)');
  if (!source || source === 'auto'){
    source = await detectLanguage(text);   /* free detection via the gtx endpoint below */
  }
  const qs = new URLSearchParams({ q: text, langpair: source + '|' + target });
  if (process.env.MYMEMORY_EMAIL) qs.set('de', process.env.MYMEMORY_EMAIL);
  const r = await httpCall({
    url: 'https://api.mymemory.translated.net/get?' + qs.toString(),
    timeout: TIMEOUT_MS
  });
  const out = r.data && r.data.responseData && r.data.responseData.translatedText;
  if (!out || /INVALID|QUERY LENGTH LIMIT/i.test(out)) throw new Error('mymemory: ' + (out || 'empty response'));
  return { text: out, provider: 'mymemory', detected: source };
}

/* ── provider 5: Google public endpoint (no key, longest texts) ── */
async function viaGoogleGtx(text, source, target){
  const qs = new URLSearchParams({ client: 'gtx', sl: source || 'auto', tl: target, dt: 't', q: text });
  const r = await httpCall({
    url: 'https://translate.googleapis.com/translate_a/single?' + qs.toString(),
    timeout: TIMEOUT_MS
  });
  const chunks = r.data && r.data[0];
  if (!Array.isArray(chunks)) throw new Error('gtx: unexpected response shape');
  const out = chunks.map(c => (c && c[0]) || '').join('');
  if (!out) throw new Error('gtx: empty translation');
  return { text: out, provider: 'google', detected: r.data[2] };
}

/* ── language detection (free, no key) ── */
/* ── v87 NON-QWERTY SCRIPT DETECTION — instant, offline, no network ──
 * Persian / Arabic / Urdu / Hebrew / Russian / Hindi / Thai / Chinese /
 * Japanese / Korean / Greek / Bengali never touch a QWERTY layout, and
 * their scripts identify the language with near-certainty. This runs
 * BEFORE the network detection in detectLanguage(), so it works even
 * when every provider is down, and it feeds the group language gate
 * (Shona/English stay silent, Persian & co. get replies) with zero
 * latency. Latin-script text returns null → the caller falls back to
 * the network detector. */
const SCRIPT_TESTS = [
  [/[\u0679\u0688\u0691\u06BA\u06D2\u06C1\u06C3]/, 'ur'],   /* ٹ ڈ ڑ ں ے ہ — Urdu-only letters */
  [/[\u067E\u0686\u0698\u06AF\u06CC]/, 'fa'],               /* پ چ ژ گ ی — Persian-only letters */
  [/[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/, 'ar'],
  [/[\u0590-\u05FF]/, 'he'],
  [/[\u0400-\u04FF]/, 'ru'],
  [/[\u0370-\u03FF]/, 'el'],
  [/[\u0900-\u097F]/, 'hi'],
  [/[\u0980-\u09FF]/, 'bn'],
  [/[\u0E00-\u0E7F]/, 'th'],
  [/[\uAC00-\uD7AF\u1100-\u11FF]/, 'ko'],
  [/[\u3040-\u30FF]/, 'ja'],
  [/[\u4E00-\u9FFF]/, 'zh']
];
function detectScriptLang(text){
  if (!text) return null;
  const s = String(text).replace(/https?:\/\/\S+|@\w+|[0-9\u00B9-\u00BF]/g, ' ');
  for (const [re, lang] of SCRIPT_TESTS){
    if (re.test(s)) return lang;
  }
  return null;
}

async function detectLanguage(text){
  /* v87: non-QWERTY scripts answer instantly, offline — no provider call */
  const script = detectScriptLang(text);
  if (script) return script;
  const qs = new URLSearchParams({ client: 'gtx', sl: 'auto', tl: 'en', dt: 't', q: String(text || '').slice(0, 1000) });
  const r = await httpCall({
    url: 'https://translate.googleapis.com/translate_a/single?' + qs.toString(),
    timeout: TIMEOUT_MS
  });
  const det = r.data && r.data[2];
  if (!det) throw new Error('detect: no language in response');
  return normalizeLang(det);
}

/* ── the chain ── */
async function translate(text, opts){
  const o = opts || {};
  if (process.env.TRANSLATE_ENABLED === 'false') throw new Error('translator disabled (TRANSLATE_ENABLED=false)');
  const rawText = String(text || '').trim();
  if (!rawText) throw new Error('nothing to translate');
  const clipped = rawText.slice(0, MAX_TEXT_LEN);
  const source = normalizeLang(o.source || 'auto');
  const target = normalizeLang(o.target || 'en');
  if (source === target && source !== 'auto'){
    return { ok: true, translated: clipped, provider: 'none (source = target)',
             source, target, cached: false, original: rawText };
  }
  const cacheKey = source + '|' + target + '|' + clipped;
  const cached = cacheGet(cacheKey);
  if (cached){
    return Object.assign({}, cached, { cached: true, original: rawText });
  }

  const chain = [viaDeepl, viaLibreTranslate, viaLingva, viaMyMemory, viaGoogleGtx];
  const attempts = [];
  for (const step of chain){
    try {
      const res = await step(clipped, source, target);
      const result = {
        ok: true, translated: res.text, provider: res.provider,
        source: normalizeLang(res.detected || source), target,
        cached: false, original: rawText
      };
      cacheSet(cacheKey, result);
      return result;
    } catch (e) {
      attempts.push(step.name.replace(/^via/, '') + ': ' + (e.message || String(e)));
    }
  }
  const err = new Error('all translation providers failed');
  err.attempts = attempts;
  throw err;
}

/* ── usage text for the WhatsApp !translate command ── */
function usageText(){
  return [
    '🌍 *Translator* — free, no signup needed',
    '',
    '*!translate* <language> <text>',
    '  e.g. !translate fr Good morning',
    '',
    '*!translate* <from>|<to> <text>',
    '  e.g. !translate en|fr Good morning',
    '',
    '*!translate langs* — list languages',
    '',
    'Auto-detects the source language when you only give the target.'
  ].join('\n');
}
function langsText(){
  const lines = Object.entries(LANGUAGES)
    .filter(([c]) => c !== 'auto')
    .map(([c, n]) => c + ' — ' + n);
  return '🌍 *Language codes*\n\n' + lines.join('\n');
}

module.exports = { translate, detectLanguage, detectScriptLang, LANGUAGES, langName, normalizeLang, usageText, langsText };
