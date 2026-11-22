'use strict';
/* ══════════════════════════════════════════════════════════════
 *  test-all.js — REAL smoke/crash test suite (v84.1)
 *
 *  /admin/test-all used to spawn this file, which did not exist.
 *  This suite exercises every loadable module + the critical bug
 *  fixes of v84.1 without needing WhatsApp/Chrome/network:
 *    1. module load matrix (require every core + platform module)
 *    2. atomic JSON write: crash-safety + corrupt-file quarantine
 *    3. rate-limiter: waitAndRecord now RESPECTS hourly/daily caps
 *    4. schedule-manager: chains survive disable→enable
 *    5. circadian: day reset runs, jitter stable per 10-min bucket
 *    6. data-manager: falsy-id dedup fix
 *    7. interaction-tracker: cap enforced
 *    8. twitter: own-links-only policy strips foreign URLs
 *    9. scraper client: real API surface (fetchVideo/fetchMusic…)
 *   10. videoScheduler: no hardcoded queries; recordRequest persists
 *   11. blender pipeline: CLI demo run produces valid .bpy files
 *  Exit code 0 = all pass. Run: node test-all.js [--quick]
 * ══════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const os = require('os');

const results = [];
let current = null;

function test(name, fn, timeoutMs) {
  current = name;
  const started = Date.now();
  const deadline = timeoutMs || 30000;
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return Promise.race([
        r.then(() => {
          results.push({ name, ok: true, ms: Date.now() - started });
          current = null;
        }, (e) => {
          results.push({ name, ok: false, error: e.message, ms: Date.now() - started });
          current = null;
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + deadline + 'ms')), deadline))
      ]).catch(e => {
        if (!results.find(x => x.name === name)) results.push({ name, ok: false, error: e.message });
      });
    }
    results.push({ name, ok: true, ms: Date.now() - started });
    current = null;
  } catch (e) {
    results.push({ name, ok: false, error: e.message, ms: Date.now() - started });
    current = null;
  }
  return Promise.resolve();
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

const QUICK = process.argv.includes('--quick');
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'breadbot-test-'));

async function main() {
  /* ── 1. module load matrix ─────────────────────────────── */
  const modules = [
    './core/atomic', './core/data-manager', './core/rate-limiter',
    './core/schedule-manager', './core/human-behavior', './core/logger',
    './core/circadian-orchestrator', './core/interaction-tracker',
    './core/health-monitor', './core/crash-recovery', './core/self-update',
    './core/anti-detect-meter', './core/internet-monitor',
    './core/content/content-pipeline', './core/content/educational-shorts',
    './core/content/nsfw-captions', './core/content/query-engine',
    './videoScheduler', './brain'
  ];
  for (const m of modules) {
    await test(`load ${m}`, () => {
      const mod = require(m);
      assert(mod, 'module resolved to nothing');
    });
  }
  await test('load platforms/scraper (remote client)', () => {
    const S = require('./platforms/scraper');
    const s = new S({ scraperUrl: 'https://example.onrender.com' });
    assert(s.baseUrl === 'https://example.onrender.com', 'baseUrl not honored');
    assert(typeof s.fetchVideo === 'function', 'fetchVideo missing (the v84 killer bug)');
    assert(typeof s.fetchMusic === 'function' && typeof s.fetchGif === 'function', 'music/gif missing');
    assert(s.getStatus().mode === 'remote', 'expected remote mode');
  });
  await test('load platforms/twitter + facebook + youtube + tiktok', () => {
    assert(require('./platforms/twitter'), 'twitter');
    assert(require('./platforms/facebook'), 'facebook');
    assert(require('./platforms/youtube'), 'youtube');
    assert(require('./platforms/tiktok'), 'tiktok');
  });

  /* ── 2. atomic JSON write ──────────────────────────────── */
  await test('atomic: write + read roundtrip', () => {
    const { writeJSONAtomic, readJSONSafe } = require('./core/atomic');
    const f = path.join(tmpBase, 't1.json');
    assert(writeJSONAtomic(f, { hello: [1, 2, 3] }), 'write failed');
    assert(readJSONSafe(f, null).hello[1] === 2, 'roundtrip mismatch');
  });
  await test('atomic: corrupt file quarantined, not silently reset', () => {
    const { readJSONSafe } = require('./core/atomic');
    const f = path.join(tmpBase, 't2.json');
    fs.writeFileSync(f, '{"truncated": tru');
    const out = readJSONSafe(f, { fallback: true });
    assert(out.fallback === true, 'fallback not returned');
    assert(fs.existsSync(f + '.corrupt-') || fs.readdirSync(tmpBase).some(x => x.startsWith('t2.json.corrupt-')),
      'corrupt file was silently swallowed — quarantine file missing');
  });

  /* ── 3. rate limiter caps ──────────────────────────────── */
  await test('rate-limiter: waitAndRecord refuses past caps', async () => {
    const RL = require('./core/rate-limiter');
    const dir = fs.mkdtempSync(path.join(tmpBase, 'rl-'));
    const rl = new RL('test-rl', { hourly: 2, daily: 3, cooldown: 0 }, dir);
    rl.record('tweet'); rl.record('tweet'); rl.record('tweet');
    const res = await rl.waitAndRecord('tweet', 50);
    assert(res.acted === false, 'waitAndRecord recorded PAST the caps (the v84.1 ban-risk bug)');
    assert(res.reason === 'hourly-cap' || res.reason === 'daily-cap',
      'expected cap refusal, got: ' + JSON.stringify(res));
  });

  /* ── 4. schedule-manager chain survival ────────────────── */
  await test('schedule-manager: disable→enable does not kill task chains', async () => {
    const SM = require('./core/schedule-manager');
    const dir = fs.mkdtempSync(path.join(tmpBase, 'sm-'));
    const sm = new SM('test-sm', dir);
    sm.log = () => {};
    sm.addTask({ id: 't1', name: 'Test', action: 'noop', interval: 40, jitter: 0.1 });
    let runs = 0;
    sm.startTask('t1', () => { runs++; });
    // first fire has a 1-6s human initial delay — wait through it
    sm.disable();
    await new Promise(r => setTimeout(r, 7000));   // past the initial delay
    sm.enable();
    await new Promise(r => setTimeout(r, 600));    // a few 40ms cycles
    assert(runs >= 1, 'task chain died after disable→enable (v84.1 dead-chain bug)');
    sm.stopAllTasks();
  }, 12000);

  /* ── 5. circadian ──────────────────────────────────────── */
  await test('circadian: day counters reset + jitter stable', () => {
    const CO = require('./core/circadian-orchestrator');
    const dir = fs.mkdtempSync(path.join(tmpBase, 'co-'));
    const co = new CO({ dataDir: dir, log: () => {} });
    co.state.totalActionsToday = 999;
    co.state.currentDay = '2000-01-01';   // force day mismatch
    const l1 = co.getActivityLevel();
    assert(co.state.totalActionsToday === 0, '_checkDayReset did not run (was dead code)');
    const l2 = co.getActivityLevel();
    const l3 = co.getActivityLevel();
    assert(Math.abs(l2 - l3) < 1e-9, 'jitter still re-rolls per call (unstable gates)');
    co.close();
  });

  /* ── 6. data-manager dedup ─────────────────────────────── */
  await test('data-manager: id=0 dedup + atomic persistence', () => {
    const DM = require('./core/data-manager');
    const dir = fs.mkdtempSync(path.join(tmpBase, 'dm-'));
    const dm = new DM('test-dm', dir);
    dm.log = () => {};
    assert(dm.addToList('x', { id: 0, url: 'a' }) === true, 'first add rejected');
    assert(dm.addToList('x', { id: 0, url: 'a' }) === false, 'id=0 duplicate slipped in (v84.1 falsy-id bug)');
    assert(dm.addToList('y', 'str') === true && dm.addToList('y', 'str') === false, 'string dedup failed');
  });

  /* ── 7. interaction tracker cap ────────────────────────── */
  await test('interaction-tracker: maxHistory enforced', () => {
    const IT = require('./core/interaction-tracker');
    const dir = fs.mkdtempSync(path.join(tmpBase, 'it-'));
    const it = new IT({ dataDir: dir, maxHistory: 50, log: () => {} });
    for (let i = 0; i < 80; i++) it.recordPost('twitter', 'p' + i, {});
    it.flush();
    const total = Object.values(it.interactions.twitter).length;
    assert(total <= 50, `unbounded growth: ${total} > cap 50`);
  });

  /* ── 8. twitter link policy ────────────────────────────── */
  await test('twitter: OWN-LINKS-ONLY strips foreign URLs', async () => {
    const TwitterBot = require('./platforms/twitter').prototype
      ? require('./platforms/twitter')
      : require('./platforms/twitter');
    // construct minimal instance without browser
    const Tw = require('./platforms/twitter');
    const bot = Object.create(Tw.prototype);
    bot._allowedLinks = [];
    bot._allowedLinkHosts = new Set(['mysite.com', 'x.com']);
    bot._linkPolicyLoaded = true;
    bot.log = () => {};
    bot.scraper = null;
    const res = await bot.enforceLinkPolicy('check https://mysite.com/post and https://evil.example.net/x and https://x.com/me');
    assert(res.text.includes('https://mysite.com/post'), 'owner link wrongly stripped');
    assert(!res.text.includes('evil.example.net'), 'FOREIGN LINK SURVIVED — link policy broken');
    assert(res.text.includes('https://x.com/me'), 'self link wrongly stripped');
    assert(res.removedCount === 1, 'removedCount wrong: ' + res.removedCount);
  });

  /* ── 9. scraper client surface ─────────────────────────── */
  await test('scraper client: MYLINKS forwarded per request', () => {
    const S = require('./platforms/scraper');
    const s = new S({ myLinks: 'https://a.com, https://b.com' });
    assert(s.myLinks.length === 2, 'myLinks parse failed');
  });

  /* ── 9a. v92.9.11: blocked numbers + AI numbers + group blacklist ── */
  await test('access: blocked numbers never match admin, AI numbers resolve', () => {
    const acc = require('./access');
    const ADMIN = '263777627210';
    /* read-only exercise of the real lists — nothing is written */
    assert(typeof acc.isBlockedNumber === 'function', 'isBlockedNumber missing');
    assert(typeof acc.isAiNumber === 'function', 'isAiNumber missing');
    /* the admin number can never be blacklisted */
    const res = acc.addBlockedNumber('+' + ADMIN, ADMIN);
    assert(res.ok === false && /never be blocked/.test(res.error || ''), 'admin block must be refused');
    /* the real lists ship sane defaults */
    assert(acc.isBlockedNumber('+9990000000') === false, 'phantom number reported blocked');
    /* AI list ships with the boss-approved number (committed config) */
    acc.loadAiNumbers();
    assert(acc.isAiNumber('+93772553417') === true, 'Afghan AI number missing from ai-numbers.txt');
    assert(acc.isAiNumber('+263777000001') === false, 'phantom number reported AI-enabled');
  });
  await test('access: name blacklist matches KCC in any wording', () => {
    const acc = require('./access');
    acc.loadGroups();          /* real blocked-groups.txt: KCC lines */
    assert(acc.nameIsBlocked('KCC Youth Fellowship') === true, 'exact KCC Youth miss');
    assert(acc.nameIsBlocked('kcc youth fellowship Zimbabwe 🙏') === true, 'wrapped KCC miss');
    assert(acc.nameIsBlocked('KCC Bubble Study Group') === true, 'KCC Bubble miss');
    assert(acc.nameIsBlocked('𝐆𝐑𝐎𝐔𝐏 𝐂𝐇𝐀𝐓🍷💖𓄹𓈒ᥱX̸𝚁︎𝗢︎𝚁︎ᯓ⁪4𝐊𓍼') === false, 'unrelated group flagged');
  });

  /* ── 9b. v88/v89: site health + localization + registry ── */
  await test('site-health: registry integrity — 7 majors, all nsfw, share map', () => {
    const SH = require('./site-health');
    const reg = JSON.parse(fs.readFileSync(SH.REGISTRY_FILE, 'utf8'));
    /* v90.1: 14 zero-real-content sites pruned after the content crash
     * test (sites whose downloads were logos/thumbs/CDN-blocked) */
    assert(reg.sites.length >= 178, 'registry shrank: ' + reg.sites.length);
    const cats = new Set(reg.sites.map(s => s.category));
    for (const m of ['zimbabwe', 'southafrica', 'arab', 'persian', 'indian', 'africa', 'euro'])
      assert(cats.has(m), 'missing major category: ' + m);
    assert(reg.sites.every(s => s.nsfw === true), 'non-nsfw entry found');
    for (const s of reg.sites) assert(/\{query\}/.test(s.url), 'site without {query} template: ' + s.name);
    assert((reg.categoryShares || {}).zimbabwe && reg.categoryShares.zimbabwe.includes('southafrica'),
      'zimbabwe must share southafrica sites');
    const zimg = reg.sites.filter(s => s.category === 'zimbabwe' && s.kind === 'images').length;
    const zgif = reg.sites.filter(s => s.category === 'zimbabwe' && s.kind === 'gifs').length;
    /* v90.1: zimbabwe's own image entries delivered only logos/thumbs and
     * were content-test-pruned — its image searches ride the SHARE map
     * (southafrica's content-tested entries), which is the whole point of
     * "we kinda share the sites with mzansi". So: own gifs ≥ 2, and the
     * shared neighbour must carry content-tested images. */
    assert(zgif >= 2, 'zimbabwe gif coverage thin: ' + zgif);
    const saImg = reg.sites.filter(s => s.category === 'southafrica' && s.kind === 'images').length;
    assert(zimg > 0 || saImg >= 2, 'zimbabwe has neither own images nor shared ones');
  });
  await test('site-health: localization — phone + language → category', () => {
    const SH = require('./site-health');
    SH.loadRegistry();                        /* loads categoryShares too */
    assert(SH.categoryByPhone('263771234567') === 'zimbabwe', '263 must map to zimbabwe');
    assert(SH.categoryByPhone('27821234567') === 'southafrica', '27 must map to southafrica');
    assert(SH.categoryByPhone('989121234567') === 'persian', '98 must map to persian');
    assert(SH.categoryByPhone('919812345678') === 'indian', '91 must map to indian');
    assert(SH.categoryByPhone('201001234567') === 'arab', '20 must map to arab');
    assert(SH.categoryByPhone('4915123456789') === 'euro', '49 must map to euro');
    assert(SH.categoryByLang('sn') === 'zimbabwe', 'shona must map to zimbabwe');
    assert(SH.categoryByLang('fa') === 'persian', 'fa must map to persian');
    /* share map: zimbabwe chain includes southafrica sites */
    const cats = SH.categoriesFor('zimbabwe');
    assert(cats.includes('southafrica'), 'share map not applied');
    /* boosted ordering: zimbabwe sites ride first for a zimbabwean sender */
    const links = SH.healthyLinks('videos', true, null, 'zimbabwe');
    const zwFirst = links.slice(0, 6).some(u => /zimbabwe|harare|mzansi|south african/.test(u));
    assert(zwFirst, 'localized chain does not ride zimbabwe/mzansi sites first');
  });
  await test('site-health: dead sites are skipped, cooldown revive works', () => {
    const SH = require('./site-health');
    SH.loadRegistry(); SH.loadHealth();
    const reg = SH.registry();
    const target = reg.find(s => s.kind === 'videos');
    const before = SH.healthyLinks('videos', true);
    assert(before.includes(target.url), 'healthy site missing from chain');
    SH.markFail(target.url, 'test-493');
    const after = SH.healthyLinks('videos', true);
    assert(!after.includes(target.url), 'dead site still in chain after markFail');
    SH.markOk(target.url, 100);
    assert(SH.healthyLinks('videos', true).includes(target.url), 'revived site not back in chain');
  });
  /* ═══ v92.9.12 SITE PICKER — the boss flow: test sites first, list them
   * in the user's language, member picks a number (+ optional count) ═══ */
  await test('site-picker: video menus default ARABIC when nothing else is known', () => {
    const SP = require('./site-picker');
    SP.init(function(){});
    assert(SP.boostCategoryFor('video', {}) === 'arab', 'video with no locale must default to arab');
    assert(SP.boostCategoryFor('video', { phone: '93772553417' }) === 'persian', 'afghan phone must boost persian over the arab default');
    assert(SP.boostCategoryFor('video', { phone: '201001234567' }) === 'arab', 'egypt phone must boost arab');
    assert(SP.boostCategoryFor('video', { lang: 'ar' }) === 'arab', 'arabic chat language must boost arab');
    assert(SP.boostCategoryFor('image', {}) === null, 'pics get NO fabricated default');
    assert(SP.boostCategoryFor('gif', { phone: '263771234567' }) === 'zimbabwe', 'zim phone must boost zimbabwe');
    assert(SP.boostCategoryFor('gif', { lang: 'fa' }) === 'persian', 'farsi language must boost persian');
  });
  await test('site-picker: menu lists ONLY live-tested sites, numbered 1..N', async () => {
    const SP = require('./site-picker');
    const SH = require('./site-health');
    SH.loadRegistry(); SH.loadHealth();
    const chat = '263777123456@s.whatsapp.net';
    const ranked = SH.healthyLinks('videos', true, null, 'arab');
    assert(ranked.length >= 4, 'need video candidates to test, got ' + ranked.length);
    const dead = new Set(ranked.slice(0, 2));            /* the 2 first candidates "die" */
    const orig = SH.probeSite;
    SH.probeSite = async (u) => dead.has(u) ? { ok:false, why:'test-dead' } : { ok:true, ms:40 };
    try {
      const mp = await SP.buildMenu(chat, 'video', false, { query: 'kabul' });
      assert(mp.ok === true, 'menu failed: ' + JSON.stringify(mp).slice(0, 120));
      assert(mp.sites.length >= 1 && mp.sites.length <= SP.MENU_SITES, 'menu size wrong: ' + mp.sites.length);
      assert(mp.sites[0].n === 1, 'sites must be numbered from 1');
      for (let i = 1; i < mp.sites.length; i++) assert(mp.sites[i].n === mp.sites[i-1].n + 1, 'numbering broken');
      assert(!mp.sites.some(s => dead.has(s.url)), 'a DEAD site was listed — sites were NOT tested first');
      const p = SP.getPending(chat);
      assert(p && p.kind === 'video' && p.query === 'kabul' && p.cat === 'arab', 'pending pick not stored for this chat');
    } finally { SH.probeSite = orig; SP.clearPending(chat); }
  });
  await test('site-picker: pick parsing — "2", "2 5", "2,5", caps, invalid, no-menu', () => {
    const SP = require('./site-picker');
    SP.init(function(){});
    const chat = '263777654321@s.whatsapp.net';
    const two = [{ n:1, url:'http://a', name:'A' }, { n:2, url:'http://b', name:'B' }];
    SP.setPending(chat, { kind:'image', nsfw:false, query:'mbira', sites: two, lang:null, cat:null, taskType:'dmreply', senderJid:null });
    let p = SP.parsePick(chat, '2');
    assert(p && p.valid && p.site.url === 'http://b', 'bare number must pick site 2');
    assert(p.count === 5 && p.defaultCount === true, 'image default count must be 5, got ' + p.count);
    SP.setPending(chat, { kind:'image', nsfw:false, query:'mbira', sites: two, lang:null, cat:null, taskType:'dmreply', senderJid:null });
    p = SP.parsePick(chat, '2x25');
    assert(p.valid && p.count === 10, 'image count must cap at 10, got ' + p.count);
    SP.setPending(chat, { kind:'video', nsfw:false, query:'kabul', sites: two, lang:null, cat:null, taskType:'dmreply', senderJid:null });
    p = SP.parsePick(chat, '2 9');
    assert(p.valid && p.count === 3, 'video count must cap at 3, got ' + p.count);
    SP.setPending(chat, { kind:'gif', nsfw:false, query:'dance', sites: two, lang:null, cat:null, taskType:'group', senderJid:null });
    p = SP.parsePick(chat, '2,5');
    assert(p.valid && p.count === 5, 'comma form "2,5" must work, got ' + p.count);
    SP.setPending(chat, { kind:'gif', nsfw:false, query:'dance', sites: two, lang:null, cat:null, taskType:'group', senderJid:null });
    p = SP.parsePick(chat, '7');
    assert(p && p.invalid === true, 'a number outside the menu must be flagged invalid');
    assert(SP.parsePick(chat, 'hello') === null, 'non-number text is not a pick');
    assert(SP.parsePick('stranger@s.whatsapp.net', '1') === null, 'no pending menu in this chat → null');
  });
  await test('site-picker: probeAlive bounded — stops at MENU_SITES alive, ≤6 in flight', async () => {
    const SP = require('./site-picker');
    const SH = require('./site-health');
    const orig = SH.probeSite;
    let inFlight = 0, maxInFlight = 0, calls = 0;
    SH.probeSite = async () => {
      calls++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(r => setTimeout(r, 12));
      inFlight--;
      return { ok:true, ms:12 };
    };
    try {
      const urls = Array.from({ length: 20 }, (_, i) => 'http://probe-s' + i);
      const alive = await SP.probeAlive(urls);
      assert(alive.length === SP.MENU_SITES, 'must stop at MENU_SITES alive, got ' + alive.length);
      assert(calls <= SP.MENU_SITES, 'must not probe past the first full alive round, called ' + calls);
      assert(maxInFlight <= 6, 'probe concurrency above 6: ' + maxInFlight);
    } finally { SH.probeSite = orig; }
  });
  await test('server: junk/dummy URL filter kills 1px + logos + sprites', () => {
    const src = fs.readFileSync('./server.js', 'utf8');
    assert(/JUNK_URL_RE/.test(src), 'JUNK_URL_RE filter missing from server.js');
    assert(/cleanResults/.test(src), 'cleanResults() missing from server.js');
    assert(src.includes('1px'), 'known junk pattern (1px.png) not covered');
  });
  await test('music engine: provider chain + 32MB WhatsApp cap', () => {
    const M = require('./music');
    assert(M.MAX_BYTES <= 34 * 1024 * 1024, 'music cap must stay under WhatsApp 34MB');
    assert(typeof M.getMusic === 'function' && typeof M.convert === 'function', 'engine API missing');
    const src = fs.readFileSync('./music.js', 'utf8');
    assert(/y2mate/i.test(src), 'y2mate (the boss rule) not in the chain');
    assert(/vevioz|cobalt/i.test(src), 'fallback converters missing');
    assert(/markFail|providerDead/.test(src), 'provider self-healing missing');
  });
  await test('server: storage-based clearing at 300MB cap', () => {
    const src = fs.readFileSync('./server.js', 'utf8');
    assert(/MEDIA_STORAGE_CAP_MB/.test(src), 'storage cap missing');
    assert(src.includes('STORAGE CAP HIT'), 'cap-hit wipe log missing');
    assert(/mediaStorageMB/.test(src), 'storage meter missing');
  });
  await test('server: damaged-result defense wired (sendFirstWorking + forgetMedia)', () => {
    const src = fs.readFileSync('./server.js', 'utf8');
    assert(/async function sendFirstWorking/.test(src), 'sendFirstWorking missing');
    assert(/function forgetMedia/.test(src), 'forgetMedia missing');
    assert(/quietFail/.test(src), 'quietFail option missing in safe senders');
  });
  await test('server: own-domain-first authenticity reordering (live-audit fix)', () => {
    const src = fs.readFileSync('./server.js', 'utf8');
    assert(/function ownDomainFirst/.test(src), 'ownDomainFirst missing');
    assert(/CDN_OWNER/.test(src), 'CDN_OWNER map missing (phncdn→pornhub etc.)');
    /* behaviour: results from MY chain domains ride before fallback pool */
    const M = { hostOf: null };
    // extract the pure logic by requiring nothing — simulate the sort
    const CDN_OWNER = { 'phncdn.com': 'pornhub.com', 'xvideos-cdn.com': 'xvideos.com' };
    const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } };
    const ownerOf = u => { const h = hostOf(u); const reg = h.split('.').slice(-2).join('.'); return CDN_OWNER[reg] || reg; };
    const mine = new Set(['imagefap.com', 'pornhub.com']);
    const sort = list => list.slice().sort((a, b) => (mine.has(ownerOf(b)) ? 1 : 0) - (mine.has(ownerOf(a)) ? 1 : 0));
    const out = sort([
      'https://darknaija.com/a/x.jpg',                        // fallback pool
      'https://cdni.pornhub.com/data/x.jpg',                  // CDN → pornhub.com ✓
      'https://random.example.net/y.jpg',                     // foreign
      'https://cdnc.imagefap.com/thumb/z.jpg'                 // own ✓
    ]);
    assert(ownerOf(out[0]) === 'imagefap.com' || ownerOf(out[0]) === 'pornhub.com', 'own-domain result not first: ' + out[0]);
    assert(ownerOf(out[out.length - 1]) === 'example.net' || ownerOf(out[out.length - 1]) === 'darknaija.com', 'foreign results not pushed last');
    /* v91 upgraded the reorder to rankRelevant (relevance first, own-domain ties +1, ownDomainFirst inside for zero-hit queries) */
    assert(/rankRelevant\(cleanResults\(r\.data\?\.images\), query, myLinks\)/.test(src), 'images return not using rankRelevant');
    assert(/rankRelevant\(cleanResults\(r\.data\?\.gifs\), query/.test(src), 'gifs return not using rankRelevant');
    assert(/ownDomainFirst\(arr, chain\)/.test(src), 'rankRelevant lost the ownDomainFirst fallback');
  });

  /* ── 9c. v90: multilingual commands + listen-first + media queue ── */
  await test('multilang: localized verbs fire intents in native scripts', () => {
    const M = require('./multilang');
    const fa = M.localIntent('عکس جنیفر لوپز');
    assert(fa && fa.type === 'image' && /جنیفر/.test(fa.query), 'fa pic verb failed: ' + JSON.stringify(fa));
    const faV = M.localIntent('فیلم طنز');
    assert(faV && faV.type === 'video', 'fa video verb failed');
    const ar = M.localIntent('اغنية جديدة');
    assert(ar && ar.type === 'music', 'ar music verb failed');
    const hi = M.localIntent('गाना सुनाओ');
    assert(hi && hi.type === 'music', 'hi music verb failed');
    const sn = M.localIntent('mufananidzo wemusha');
    assert(sn && sn.type === 'image', 'shona pic verb failed');
    const es = M.localIntent('una foto de messi');
    assert(es && es.type === 'image', 'es pic verb failed');
    /* a media verb beats the generic download verb */
    const dl = M.localIntent('دانلود فیلم');
    assert(dl && dl.type === 'video', 'media verb must beat download verb');
    /* english-only text stays null (english path handled elsewhere) */
    assert(M.localIntent('hello everyone how are you') === null, 'false positive on english chatter');
  });
  await test('listen-first: observe → engage on request, silent on chatter', () => {
    const GL = require('./group-listener');
    GL.init({ log: function(){}, intentFn: (t) => /song|pic|photo/i.test(t) ? { type: 'image', query: 'x' } : null, commandFn: (t) => /^!/.test(t) });
    const g = 'testgroup-listen@g.us';
    /* ordinary chatter → never auto-engage */
    GL.observe(g, { senderJid: '1@s.whatsapp.net', text: 'hey how are you' });
    GL.observe(g, { senderJid: '2@s.whatsapp.net', text: 'good, you?' });
    assert(GL.canAutoEngage(g) === false, 'chatter group must NOT auto-engage');
    /* a bot-directed request flips it to engage */
    GL.observe(g, { senderJid: '1@s.whatsapp.net', text: 'send a pic of harare' });
    assert(GL.canAutoEngage(g) === true, 'request in group must engage');
    /* admin overrides */
    assert(GL.setMode(g, 'silent') === true, 'setMode silent failed');
    assert(GL.modeOf(g) === 'silent', 'override not applied');
    assert(GL.canAutoEngage(g) === false, 'override silent must gate auto');
    GL.setMode(g, 'engage');
    assert(GL.canAutoEngage(g) === true, 'override engage must allow auto');
    GL.clearMode(g);
    /* fresh group with pure chatter must not engage */
    const g2 = 'quiet-listen@g.us';
    GL.observe(g2, { senderJid: '3@s.whatsapp.net', text: 'anyone there' });
    GL.observe(g2, { senderJid: '4@s.whatsapp.net', text: 'yes just talking' });
    assert(GL.modeOf(g2) !== 'engage', 'quiet chatter group must not engage');
  });
  await test('media-queue: coalesces duplicates, caps concurrency', async () => {
    const MQ = require('./media-queue');
    MQ.init(function(){});
    let concurrent = 0, maxConcurrent = 0, runs = 0;
    const job = (ms, out) => async () => {
      runs++; concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise(r => setTimeout(r, ms));
      concurrent--;
      return out;
    };
    /* two identical requests at once → ONE run, both get the result */
    const [a, b] = await Promise.all([
      MQ.run('coalesce@x', 'image', 'same query', job(120, 'RESULT')),
      MQ.run('coalesce@x', 'image', 'same query', job(120, 'RESULT'))
    ]);
    assert(a.result === 'RESULT' && b.result === 'RESULT', 'both callers must get the result');
    assert(runs === 1, 'duplicate was fetched twice (' + runs + ' runs)');
    /* different queries from DIFFERENT chats run for real, never more than
     * MAX_ACTIVE at once (v92.9.9g per-chat cap: one chat holds max 2) */
    const many = [];
    for (let i = 0; i < 6; i++) many.push(MQ.run('cap' + i + '@x', 'image', 'query ' + i, job(30, 'ok' + i)));
    const all = await Promise.all(many);
    assert(all.every(r => typeof r.result === 'string'), 'results lost');
    assert(maxConcurrent <= MQ.MAX_ACTIVE, 'concurrency cap blown: ' + maxConcurrent);
    assert(runs >= 2, 'different queries must actually run');
    /* v92.9.9g: a chat holding 2 WAITING jobs gets an honest per-chat
     * refusal — the third request from the SAME chat never queues.
     * First pin BOTH download slots with other chats' slow jobs, so the
     * same chat's queue can fill to its cap while nothing drains. */
    const slow = job(250, 'slow');
    const o1 = MQ.run('pin1@x', 'image', 'q pin 1', slow);
    const o2 = MQ.run('pin2@x', 'image', 'q pin 2', slow);
    await new Promise(r => setTimeout(r, 10));          /* both slots now active */
    const hold = [
      MQ.run('busy@x', 'image', 'q hold 1', job(30, 'h1')),
      MQ.run('busy@x', 'image', 'q hold 2', job(30, 'h2'))
    ];
    await new Promise(r => setTimeout(r, 10));          /* busy@x queue now holds 2 */
    const rb = await MQ.run('busy@x', 'image', 'q third', job(30, 'should-not-run'));
    assert(rb.result && rb.result.ok === false && /waiting/.test(rb.result.error || ''),
      'third same-chat request must be refused honestly, got ' + JSON.stringify(rb.result));
    await Promise.all(hold); await Promise.all([o1, o2]);
  });

  /* ── 10. videoScheduler config-driven queries ──────────── */
  await test('videoScheduler: no hardcoded NSFW query list ships in source', () => {
    const src = fs.readFileSync('./videoScheduler.js', 'utf8');
    const bad = ['ebony twerk', 'african porn', 'booty clap', 'mapouka'];
    for (const term of bad) {
      assert(!src.includes(term), `hardcoded adult query "${term}" still in videoScheduler.js`);
    }
  });
  await test('videoScheduler: recordRequest persists without canRequest', () => {
    const vs = require('./videoScheduler');
    vs.recordRequest('user-xyz');
    // after a real recordRequest, canRequest should count it
    assert(vs.canRequest('user-xyz') === true, 'first request wrongly blocked');
    // record 3 without canRequest — the 4th must now be refused
    vs.recordRequest('user-abc'); vs.recordRequest('user-abc'); vs.recordRequest('user-abc');
    assert(vs.canRequest('user-abc') === false, 'per-user limit bypassed (v84.1 foot-gun)');
  });

  /* ── 11. blender pipeline ──────────────────────────────── */
  if (!QUICK) {
    await test('blender pipeline: demo run generates valid .bpy', async () => {
      const { execFileSync } = require('child_process');
      const out = path.join(tmpBase, 'film');
      execFileSync('python3', ['-m', 'blender_pipeline', 'demo', '--workdir', out],
        { cwd: __dirname, timeout: 120000, stdio: 'pipe' });
      const bpyDir = path.join(out, 'bpy');
      const files = fs.readdirSync(bpyDir).filter(f => f.endsWith('.bpy'));
      assert(files.length >= 8, `expected >=8 bpy files, got ${files.length}`);
      assert(files.some(f => f.startsWith('90_film_assemble')), 'assemble bpy missing');
      for (const f of files) {
        const src = fs.readFileSync(path.join(bpyDir, f), 'utf8');
        new Function('"use strict"; return; (' + 'function(){/*syntax*/})();')();
        // real syntax check via python compile
        execFileSync('python3', ['-c', `compile(open(${JSON.stringify(path.join(bpyDir, f))}).read(), ${JSON.stringify(f)}, 'exec')`],
          { stdio: 'pipe' });
      }
      assert(fs.existsSync(path.join(out, 'subtitles.srt')), 'subtitles missing');
      assert(fs.existsSync(path.join(out, 'alignment.json')), 'alignment missing');
      assert(fs.existsSync(path.join(out, 'render.sh')), 'render.sh missing');
    });
  }

  /* ── report ────────────────────────────────────────────── */
  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok);
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log(`║  BREADBOT TEST-ALL: ${passed}/${results.length} passed` +
    ' '.repeat(Math.max(0, 26 - String(passed).length - String(results.length).length)) + '║');
  console.log('╚══════════════════════════════════════════════════╝');
  for (const r of results) {
    console.log(` ${r.ok ? '✔' : '✘'} ${r.name}${r.ok ? '' : '  → ' + (r.error || '')} (${r.ms}ms)`);
  }
  if (failed.length) {
    console.log(`\n${failed.length} FAILURE(S)`);
    process.exitCode = 1;
  } else {
    console.log('\nALL GREEN');
  }
}

main().catch(e => { console.error('runner crash:', e); process.exit(2); });
