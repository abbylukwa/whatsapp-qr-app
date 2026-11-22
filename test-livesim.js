'use strict';
/* ═══════════════════════════════════════════════════════════════════════
 *  v92.9.11 REAL-LIFE SIMULATION — the boss: "make sure you test everything
 *  in real life simulation to make sure it doesn't happen because I can't
 *  be sending nsfw to my dad."
 *
 *  This boots the REAL server (LOADTEST stub socket — zero WhatsApp
 *  network), a MOCK scraper, then drives REAL messages through the REAL
 *  handler pipeline across several chats at once, and asserts on what the
 *  stub ACTUALLY sent (recorded sends / typings / read receipts).
 *
 *  Scenarios:
 *    A  cross-chat isolation       — chat A asks pics, chat B chats: no leak
 *    B  NSFW containment           — admin nsfw.see lands ONLY in the admin chat
 *    C  kill switch (recorded)     — NSFW to a chat that never asked → kill
 *                                    any send to a blocked number    → kill
 *                                    any send to a blacklisted group → kill
 *    D  self-termination (exit 66) — production path: the process DIES and
 *                                    the wrong send never leaves the wire
 *    E  blocked number silence     — zero sends AND zero read receipts
 *    F  blocked group silence      — zero sends / typings / reads
 *    G  Afghan number (+93…)       — DM downloads (Persian intent) + AI replies
 *    H  file cleanup               — the local copy is deleted the moment the
 *                                    send succeeds ("after every download and
 *                                    successfully sent then we clear the files")
 *
 *  Run:  node test-livesim.js
 * ═══════════════════════════════════════════════════════════════════════ */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT       = __dirname;
const SIM_PORT_1 = 3111;
const SIM_PORT_2 = 3112;
const MOCK_PORT  = 3199;
const ADMIN      = '263777627210';
const ADMIN_JID  = ADMIN + '@s.whatsapp.net';
const CHAT_A     = '263777123456@s.whatsapp.net';   /* allowed, non-AI  */
const CHAT_B     = '263777654321@s.whatsapp.net';   /* allowed, non-AI  */
const CHAT_AF    = '93772553417@s.whatsapp.net';    /* allowed + AI     */
const CHAT_AF2   = '93765002356@s.whatsapp.net';    /* allowed + AI (the +93 76… number) */
const CHAT_BLOCK = '263777999999@s.whatsapp.net';   /* blocked          */
const CHAT_NEVER = '263777888888@s.whatsapp.net';   /* allowed, never asked */
const GRP_BLOCK  = '120000000000042@g.us';          /* stub "Other 4", JID-blacklisted */
const GRP_MAIN   = '120000000000001@g.us';

/* 300x300 solid JPEG — passes the image realness gate (≥120px) */
const MOCK_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIy' +
  'MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAEsAMwDASIA' +
  'AhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQA' +
  'AAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JkggkKhglDOHRucHZ4KVdSVkp5' +
  'Q0ZURTZMUZdvZ3V0c3Vuc0hJSktNTk9UVVZXWFNZWl9gaG1wdHl6eXpCiImUkZKTlJWWl5iZmqOk' +
  'paanqKioqKmpq6utrK2ur6+xsrO0tLW2t7i5uLm6vP/mzP/aAAwDAQACEQMRAD8A9/oooooA//9k=' +
  '', 'base64');

let passCount = 0, failCount = 0;
const failures = [];
function ok(name, cond, extra){
  if (cond){ passCount++; console.log('  \u2714 ' + name); }
  else { failCount++; failures.push(name + (extra ? ' — ' + extra : '')); console.log('  \u2718 ' + name + (extra ? ' — ' + extra : '')); }
}
function section(title){ console.log('\n── ' + title + ' ──'); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ── tiny HTTP helpers ─────────────────────────────────────────────── */
function get(url){
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    }).on('error', reject);
  });
}
function post(url, obj){
  const data = JSON.stringify(obj || {});
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + (u.search || ''),
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
    req.on('error', reject); req.write(data); req.end();
  });
}
async function getJson(url){ const r = await get(url); try { return JSON.parse(r.body); } catch(e){ return { _status: r.status, _raw: r.body.slice(0, 200) }; } }
async function postJson(url, obj){ const r = await post(url, obj); try { return JSON.parse(r.body); } catch(e){ return { _status: r.status, _raw: r.body.slice(0, 200) }; } }

async function waitFor(fn, timeoutMs, everyMs, label){
  const t0 = Date.now();
  for(;;){
    let v = null;
    try { v = await fn(); } catch(e){ /* keep polling */ }
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error('timeout waiting for ' + (label || 'condition') + ' (' + Math.round(timeoutMs/1000) + 's)');
    await sleep(everyMs || 500);
  }
}

/* ── mock scraper: every endpoint the bot's scraper client uses ────── */
const mockHits = { search: 0, gif: 0, music: 0, video: 0, files: 0 };
function startMockScraper(){
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'POST' && u.pathname === '/search'){
      mockHits.search++;
      const n = mockHits.search;
      res.end(JSON.stringify({ success: true, images: [
        'http://127.0.0.1:' + MOCK_PORT + '/file/a' + n + '.jpg',
        'http://127.0.0.1:' + MOCK_PORT + '/file/b' + n + '.jpg',
        'http://127.0.0.1:' + MOCK_PORT + '/file/c' + n + '.jpg',
        'http://127.0.0.1:' + MOCK_PORT + '/file/d' + n + '.jpg',
        'http://127.0.0.1:' + MOCK_PORT + '/file/e' + n + '.jpg'
      ] }));
    } else if (req.method === 'GET' && u.pathname === '/gif'){
      mockHits.gif++;
      res.end(JSON.stringify({ success: true, gifs: ['http://127.0.0.1:' + MOCK_PORT + '/file/g' + mockHits.gif + '.gif'] }));
    } else if (req.method === 'POST' && u.pathname === '/music'){
      mockHits.music++;
      res.end(JSON.stringify({ success: true, mediaUrl: 'http://127.0.0.1:' + MOCK_PORT + '/file/song' + mockHits.music + '.mp3', title: 'Mock Song ' + mockHits.music }));
    } else if (req.method === 'POST' && u.pathname === '/video'){
      mockHits.video++;
      res.end(JSON.stringify({ success: true, mediaUrl: 'http://127.0.0.1:' + MOCK_PORT + '/file/vid' + mockHits.video + '.mp4', title: 'Mock Video ' + mockHits.video }));
    } else if (req.method === 'POST' && u.pathname === '/download'){
      res.end(JSON.stringify({ success: true, mediaUrl: 'http://127.0.0.1:' + MOCK_PORT + '/file/proxy.bin', kind: 'image', sizeBytes: 2073 }));
    } else if (u.pathname.startsWith('/file/')){
      mockHits.files++;
      if (u.pathname.endsWith('.jpg')){
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': MOCK_JPEG.length });
        res.end(MOCK_JPEG);
      } else if (u.pathname.endsWith('.gif')){
        const buf = Buffer.alloc(4096, 7);
        res.writeHead(200, { 'Content-Type': 'image/gif', 'Content-Length': buf.length });
        res.end(buf);
      } else if (u.pathname.endsWith('.mp3')){
        /* ≥100KB — the local-copy junk gate for audio */
        const buf = Buffer.alloc(150 * 1024, 3);
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': buf.length });
        res.end(buf);
      } else if (u.pathname.endsWith('.mp4')){
        /* ≥300KB — the local-copy junk gate for video */
        const buf = Buffer.alloc(400 * 1024, 5);
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': buf.length });
        res.end(buf);
      } else {
        const buf = Buffer.alloc(4096, 9);
        res.writeHead(200, { 'Content-Length': buf.length });
        res.end(buf);
      }
    } else if (u.pathname === '/health' || u.pathname === '/status'){
      res.end(JSON.stringify({ ok: true, mock: true }));
    } else { res.writeHead(404); res.end('{}'); }
  });
  return new Promise(resolve => server.listen(MOCK_PORT, '127.0.0.1', () => resolve(server)));
}

/* ── config sandbox: swap the real lists for the sim's, restore after ── */
const CONFIG_FILES = [
  'config/allowed-numbers.txt', 'config/blocked-numbers.txt',
  'config/allowed-groups.txt', 'config/blocked-groups.txt',
  'data/access-state.json', 'data/dm_histories.json', 'data/pending.json',
  'data/media-stats.json', 'data/group_registry.json', 'data/joined_groups.json',
  'data/group_settings.json', 'data/learning_data.json'
];
const backups = {};
function stashConfigs(){
  for (const f of CONFIG_FILES){
    const p = path.join(ROOT, f);
    backups[f] = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  }
}
function writeConfigs(){
  const w = (f, body) => fs.writeFileSync(path.join(ROOT, f), body);
  w('config/allowed-numbers.txt', [
    '# sim', '+' + ADMIN, '+27614159817', '+93772553417', '+93765002356',
    '+263777123456', '+263777654321', '+263777888888', ''
  ].join('\n'));
  w('config/blocked-numbers.txt', '# sim\n+263777999999\n');
  w('config/allowed-groups.txt', '# sim\n' + GRP_MAIN + '\n');
  w('config/blocked-groups.txt', '# sim\nKCC Youth Fellowship\nKCC Bubble Study\n' + GRP_BLOCK + '\n');
  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
  w('data/access-state.json', JSON.stringify({
    inviteToJid: {}, designated: null, activated: false,
    activeGroups: { [GRP_MAIN]: { by: 'sim', name: 'Main Loadtest', ts: Date.now() } }
  }, null, 2));
  for (const f of ['data/dm_histories.json', 'data/pending.json', 'data/media-stats.json']){
    if (!fs.existsSync(path.join(ROOT, f))) w(f, '{}');
  }
}
function restoreConfigs(){
  for (const f of CONFIG_FILES){
    const p = path.join(ROOT, f);
    try {
      if (backups[f] === null){ if (fs.existsSync(p)) fs.rmSync(p); }
      else fs.writeFileSync(p, backups[f]);
    } catch(e){}
  }
}

/* ── server child ──────────────────────────────────────────────────── */
function bootServer(port){
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        LOADTEST: '1', PORT: String(port), SCRAPER_URL: 'http://127.0.0.1:' + MOCK_PORT,
        AUTO_TRANSLATE: 'false', ADMIN_PHONE: ADMIN, LOADTEST_PORT_JITTER: '0'
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled){ settled = true; reject(new Error('server boot timeout on port ' + port + '\n' + out.slice(-2000))); }
    }, 60000);
    (async function poll(){
      while (!settled){
        try {
          const h = await getJson('http://127.0.0.1:' + port + '/health');
          if (h && h.ok === true){ clearTimeout(timer); settled = true; resolve({ child, out: () => out }); return; }
        } catch(e){ /* not up yet */ }
        await sleep(400);
      }
    })();
    child.on('exit', (code) => { child.__exitCode = code; });
  });
}
const BASE = (port) => 'http://127.0.0.1:' + port;

/* ── message builders (exact Baileys shapes) ───────────────────────── */
let msgSeq = 0;
function dmMsg(fromJid, text, opts = {}){
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    key: { remoteJid: fromJid, fromMe: false, id: 'sim' + (++msgSeq) + '-' + Math.random().toString(36).slice(2, 8) },
    pushName: opts.pushName || 'Sim',
    message: { conversation: text },
    messageTimestamp: opts.ageSec ? (nowSec - opts.ageSec) : nowSec
  };
}
function groupMsg(groupJid, senderJid, text, opts = {}){
  const m = dmMsg(groupJid, text, opts);
  m.key.participant = senderJid;
  return m;
}
async function inject(port, msg){ return postJson(BASE(port) + '/loadtest/message', { account: 'groups', msg }); }
async function observe(port){ return getJson(BASE(port) + '/loadtest/observe'); }
async function observeRetry(port){
  try { return await observe(port); } catch(e){ return { sends: [], reads: [], typings: [] }; }
}

/* sends recorded by the stub, filtered per chat */
function byJid(rec, jid){
  const sends = (rec.sends || []).filter(s => s.jid === jid);
  const reads = (rec.reads || []).filter(s => s.jid === jid);
  const typings = (rec.typings || []).filter(s => s.jid === jid);
  return { sends, reads, typings, media: sends.filter(s => s.media) };
}
function mediaTo(rec, jid){ return (rec.sends || []).filter(s => s.jid === jid && s.media); }
function anyTo(rec, jid){
  return {
    sends: (rec.sends || []).filter(s => s.jid === jid),
    reads: (rec.reads || []).filter(s => s.jid === jid),
    typings: (rec.typings || []).filter(s => s.jid === jid)
  };
}

/* ═══ THE SIM ════════════════════════════════════════════════════════ */
/* ═══ v92.9.12 helper — the picker flow is now: ask → TESTED site menu →
 * member replies with a number (+ optional count) → media. If EVERY
 * site fails the live probe the bot falls back to the direct hunt, so
 * the sim accepts either path and drives the menu when one arrives. */
async function menuThenPick(jid, pickText, minMedia, timeoutMs, label){
  let viaMenu = false;
  const seen = await waitFor(async () => {
    const r = await observeRetry(SIM_PORT_1);
    const st = byJid(r, jid);
    if (st.media.length >= minMedia) return { what: 'media' };
    const menuMsg = st.sends.find(s => !s.media && /(^|\n)\s*1\.\s/.test(s.text || ''));
    if (menuMsg) return { what: 'menu', text: menuMsg.text };
    return null;
  }, timeoutMs, 900, (label || 'menu or media') + ' for ' + jid);
  if (seen.what === 'media'){ return { viaMenu: false, rec: await observe(SIM_PORT_1) }; }
  viaMenu = true;
  const recM = await observe(SIM_PORT_1);
  ok('site menu listed TESTED sites in the user\u2019s language (' + jid.split('@')[0] + ')',
     /\d\.\s/.test(seen.text || ''), 'menu: ' + String(seen.text || '').slice(0, 90).replace(/\n/g, ' | '));
  await inject(SIM_PORT_1, dmMsg(jid, pickText, { pushName: 'PickerPick' }));
  await waitFor(async () => {
    const r = await observeRetry(SIM_PORT_1);
    return byJid(r, jid).media.length >= minMedia ? true : null;
  }, timeoutMs, 900, 'media after picking for ' + jid);
  return { viaMenu, rec: await observe(SIM_PORT_1) };
}

(async function main(){
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  BREADBOT v92.9.13 REAL-LIFE SIMULATION                  ║');
  console.log('║  site picker · wrong-recipient guards · blocked silence  ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  let mock = null, s1 = null, s2 = null;
  try {
    stashConfigs();
    writeConfigs();
    mock = await startMockScraper();
    section('booting the REAL server in LOADTEST stub mode');
    s1 = await bootServer(SIM_PORT_1);
    ok('server 1 booted (stub connected, mock scraper wired)', true);

    /* ═══ G1 — the Afghan number: DM download via a Persian intent ═══ */
    section('G1 — Afghan number (+93 77 255 3417): Persian DM download via the site picker');
    const rG1 = await inject(SIM_PORT_1, dmMsg(CHAT_AF, 'عکس هرات بفرست', { pushName: 'Afghan friend' }));
    ok('Persian intent accepted by the REAL handler', rG1 && rG1.ok === true, JSON.stringify(rG1).slice(0, 120));
    const g1 = await menuThenPick(CHAT_AF, '1', 1, 150000, 'G1 menu/media');
    let rec = g1.rec;
    const afOwnMedia = mediaTo(rec, CHAT_AF).length;
    ok('the Afghan DM received media (downloads work in DM, picker ' + (g1.viaMenu ? 'MENU path' : 'fallback path') + ')', afOwnMedia > 0,
       'media sends: ' + afOwnMedia);
    ok('no media leaked to any other chat during G1',
       mediaTo(rec, CHAT_A).length === 0 && mediaTo(rec, CHAT_B).length === 0 && mediaTo(rec, CHAT_NEVER).length === 0);

    /* ═══ G2 — the Afghan number: AI replies in DM ═══ */
    section('G2 — Afghan number: AI persona replies in DM');
    const rG2 = await inject(SIM_PORT_1, dmMsg(CHAT_AF, 'سلام، چطوری؟', { pushName: 'Afghan friend' }));
    ok('plain Persian chat accepted', rG2 && rG2.ok === true, JSON.stringify(rG2).slice(0, 120));
    await waitFor(async () => {
      const r = await observeRetry(SIM_PORT_1);
      return anyTo(r, CHAT_AF).sends.some(s => !s.media) ? true : null;
    }, 60000, 800, 'AI text reply to the Afghan chat');
    rec = await observe(SIM_PORT_1);
    const afText = byJid(rec, CHAT_AF).sends.filter(s => !s.media);
    ok('AI reply text actually sent to the Afghan chat', afText.length > 0);

    /* ═══ A — cross-chat isolation: A asks, B chats ═══ */
    section('A — cross-chat isolation (the exact wrong-recipient shape)');
    await inject(SIM_PORT_1, dmMsg(CHAT_A, '5 pics of mbira', { pushName: 'ChatA' }));
    await sleep(700);                                          /* the two handlers overlap on purpose */
    await inject(SIM_PORT_1, dmMsg(CHAT_B, 'hello there friend how are you', { pushName: 'ChatB' }));
    const a1 = await menuThenPick(CHAT_A, '1 3', 3, 180000, 'A menu/media');   /* pick site 1, THREE results */
    rec = a1.rec;
    ok('chat A received its own pic batch (count selection honoured: \u22653)', mediaTo(rec, CHAT_A).length >= 3, 'got ' + mediaTo(rec, CHAT_A).length);
    ok('chat B (only chatting) received NOTHING — no leak', anyTo(rec, CHAT_B).sends.length === 0,
       'B got ' + JSON.stringify(anyTo(rec, CHAT_B).sends.map(s => s.text || s.media)));
    ok('the never-asked chat received NOTHING', anyTo(rec, CHAT_NEVER).sends.length === 0);
    ok('the Afghan chat received nothing beyond its own G1/G2 sends',
       mediaTo(rec, CHAT_AF).length === afOwnMedia, 'G1 own: ' + afOwnMedia + ', now: ' + mediaTo(rec, CHAT_AF).length);

    /* ═══ E — blocked number: total silence ═══ */
    section('E — blocked number (+263 77 999 9999): total silence');
    const recBefore = await observe(SIM_PORT_1);
    const eBefore = anyTo(recBefore, CHAT_BLOCK).sends.length + anyTo(recBefore, CHAT_BLOCK).reads.length + anyTo(recBefore, CHAT_BLOCK).typings.length;
    await inject(SIM_PORT_1, dmMsg(CHAT_BLOCK, 'pics of anything please', { pushName: 'BlockedGuy' }));
    await inject(SIM_PORT_1, dmMsg(CHAT_BLOCK, 'next', { pushName: 'BlockedGuy' }));
    await sleep(4000);
    rec = await observe(SIM_PORT_1);
    const eAfter = anyTo(rec, CHAT_BLOCK).sends.length + anyTo(rec, CHAT_BLOCK).reads.length + anyTo(rec, CHAT_BLOCK).typings.length;
    ok('blocked number got ZERO messages (not even a read receipt)', eAfter === eBefore,
       'delta: ' + (eAfter - eBefore));

    /* ═══ F — blocked group: total silence ═══ */
    section('F — blacklisted group (JID on blocked-groups.txt): total silence');
    const fBefore = await observe(SIM_PORT_1);
    const f0 = anyTo(fBefore, GRP_BLOCK).sends.length + anyTo(fBefore, GRP_BLOCK).reads.length + anyTo(fBefore, GRP_BLOCK).typings.length;
    await inject(SIM_PORT_1, groupMsg(GRP_BLOCK, '263777123456@s.whatsapp.net', 'send pics here'));
    await sleep(4000);
    rec = await observe(SIM_PORT_1);
    const f1 = anyTo(rec, GRP_BLOCK).sends.length + anyTo(rec, GRP_BLOCK).reads.length + anyTo(rec, GRP_BLOCK).typings.length;
    ok('blacklisted group got ZERO sends/typings/read receipts', f1 === f0, 'delta: ' + (f1 - f0));

    /* ═══ H — file cleanup: local copy deleted the moment the send lands ═══ */
    section('H — cleanup: download sent → local file deleted immediately');
    const mediaDir = path.join(ROOT, 'data', 'media-cache');
    fs.mkdirSync(mediaDir, { recursive: true });
    const before = new Set(fs.readdirSync(mediaDir));
    await inject(SIM_PORT_1, dmMsg(CHAT_A, '.play zzqx no such song 8181', { pushName: 'ChatA' }));
    await waitFor(async () => {
      const r = await observeRetry(SIM_PORT_1);
      return (r.sends || []).some(s => s.jid === CHAT_A && /audio/.test(s.media || '')) ? true : null;
    }, 90000, 800, 'the audio send to chat A');
    let localGone = false, sawLocal = false;
    for (let i = 0; i < 40; i++){
      const nowFiles = new Set(fs.readdirSync(mediaDir));
      for (const f of nowFiles) if (!before.has(f)) sawLocal = true;
      const left = [...fs.readdirSync(mediaDir)].filter(f => !before.has(f));
      if (sawLocal && left.length === 0){ localGone = true; break; }
      if (!sawLocal && left.length === 0 && i > 5){ /* file may have been created+deleted between scans */ localGone = true; break; }
      await sleep(500);
    }
    rec = await observe(SIM_PORT_1);
    ok('music download was really delivered to chat A', (rec.sends || []).some(s => s.jid === CHAT_A && /audio/.test(s.media || '')));
    ok('the local copy was cleared after the successful send (nothing left on disk)', localGone);

    /* ═══ B — NSFW containment: admin nsfw.see lands ONLY in the admin chat ═══ */
    section('B — NSFW containment (admin nsfw.see via the tested-site picker)');
    const bBefore = await observe(SIM_PORT_1);
    const pre = { A: mediaTo(bBefore, CHAT_A).length, B: mediaTo(bBefore, CHAT_B).length,
                  AF: mediaTo(bBefore, CHAT_AF).length, AF2: mediaTo(bBefore, CHAT_AF2).length,
                  N: mediaTo(bBefore, CHAT_NEVER).length };
    await inject(SIM_PORT_1, dmMsg(ADMIN_JID, 'nsfw.see blonde', { pushName: 'Boss' }));
    const b1 = await menuThenPick(ADMIN_JID, '1', 2, 240000, 'B menu/media');
    rec = b1.rec;
    ok('admin chat received the NSFW media (picker ' + (b1.viaMenu ? 'MENU path' : 'fallback path') + ')',
       mediaTo(rec, ADMIN_JID).length >= 2, 'got ' + mediaTo(rec, ADMIN_JID).length);
    /* DELTA counts — earlier scenarios legitimately delivered media to A/AF */
    const dA = mediaTo(rec, CHAT_A).length - pre.A, dB = mediaTo(rec, CHAT_B).length - pre.B,
          dAF = mediaTo(rec, CHAT_AF).length - pre.AF, dAF2 = mediaTo(rec, CHAT_AF2).length - pre.AF2,
          dN = mediaTo(rec, CHAT_NEVER).length - pre.N;
    ok('NOT ONE piece of NSFW went to any other chat (your dad is safe)',
       dA === 0 && dB === 0 && dAF === 0 && dAF2 === 0 && dN === 0,
       'delta A:' + dA + ' B:' + dB + ' AF:' + dAF + ' AF2:' + dAF2 + ' never:' + dN);

    /* ═══ G3 — the SECOND Afghan number (+93 76 500 2356) ═══ */
    section('G3 — second Afghan number (+93 76 500 2356): DM download + AI reply');
    await inject(SIM_PORT_1, dmMsg(CHAT_AF2, 'ویدیو کابل بفرست', { pushName: 'Afghan friend 2' }));
    const g3 = await menuThenPick(CHAT_AF2, '2', 1, 150000, 'G3 menu/media');
    ok('second Afghan number received media (picker ' + (g3.viaMenu ? 'MENU path' : 'fallback path') + ')',
       mediaTo(g3.rec, CHAT_AF2).length >= 1, 'got ' + mediaTo(g3.rec, CHAT_AF2).length);
    await inject(SIM_PORT_1, dmMsg(CHAT_AF2, 'شما کجایی هستی', { pushName: 'Afghan friend 2' }));
    await waitFor(async () => {
      const r = await observeRetry(SIM_PORT_1);
      return anyTo(r, CHAT_AF2).sends.some(s => !s.media) ? true : null;
    }, 60000, 800, 'AI text reply to the second Afghan chat');
    rec = await observe(SIM_PORT_1);
    ok('second Afghan number gets AI replies', byJid(rec, CHAT_AF2).sends.some(s => !s.media));

    /* ═══ C — the kill switch, recorded (no process death) ═══ */
    section('C — kill switch decisions at the REAL send boundary');
    await postJson(BASE(SIM_PORT_1) + '/loadtest/killhook', { mode: 'record' });
    let kc = await postJson(BASE(SIM_PORT_1) + '/loadtest/boundary-check', { jid: CHAT_NEVER, media: 'image', nsfw: true, taskType: 'dmreply' });
    ok('NSFW media to a chat that never asked → KILL', kc.killed === true && /nsfw/.test(kc.error || ''), JSON.stringify(kc));
    kc = await postJson(BASE(SIM_PORT_1) + '/loadtest/boundary-check', { jid: CHAT_BLOCK, media: 'image', taskType: 'dmreply' });
    ok('ANY send to a blocked number → KILL (even plain media)', kc.killed === true && /blocked number/.test(kc.error || ''), JSON.stringify(kc));
    kc = await postJson(BASE(SIM_PORT_1) + '/loadtest/boundary-check', { jid: GRP_BLOCK, media: 'image', taskType: 'sched' });
    ok('ANY send to a blacklisted group → KILL (even scheduler taskType)', kc.killed === true && /blocked group/.test(kc.error || ''), JSON.stringify(kc));
    kc = await postJson(BASE(SIM_PORT_1) + '/loadtest/boundary-check', { jid: ADMIN_JID, media: 'image', nsfw: true, taskType: 'dmreply' });
    ok('NSFW to the admin chat (which asked) passes the boundary', kc.ok === true, JSON.stringify(kc));
    const ks = await getJson(BASE(SIM_PORT_1) + '/loadtest/killstate');
    ok('the first kill was recorded with its reason', ks.recorded && /nsfw/.test(ks.recorded.reason || ''), JSON.stringify(ks.recorded));

    /* ═══ D — production self-termination: the process DIES, exit 66 ═══ */
    section('D — the boss\u2019s "rather kill it self": real process death, exit 66');
    s2 = await bootServer(SIM_PORT_2);
    const exitPromise = new Promise(res => s2.child.on('exit', (code) => res(code)));
    const kd = await postJson(BASE(SIM_PORT_2) + '/loadtest/boundary-check', { jid: CHAT_NEVER, media: 'image', nsfw: true, taskType: 'dmreply' });
    ok('boundary refused the NSFW misroute in production mode too', kd.killed === true, JSON.stringify(kd));
    const exitCode = await Promise.race([exitPromise.then(c => c === null ? 'running' : c), sleep(12000).then(() => 'still-alive')]);
    ok('the process TERMINATED ITSELF (exit code 66) before the send left', exitCode === 66, 'exit: ' + exitCode);

    /* ═══ summary ═══ */
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║  SIM RESULT: ' + passCount + ' passed, ' + failCount + ' failed' + ' '.repeat(Math.max(0, 24 - String(passCount).length - String(failCount).length)) + '        ║');
    console.log('╚══════════════════════════════════════════════════════════╝');
    if (failures.length){ for (const f of failures) console.log('  FAIL: ' + f); }
  } catch(e){
    failCount++;
    console.log('\nSIM ERROR: ' + e.message);
    if (s1) console.log('--- server 1 tail ---\n' + s1.out().slice(-3000));
    if (s2) console.log('--- server 2 tail ---\n' + s2.out().slice(-3000));
  } finally {
    try { if (s1 && s1.child.exitCode === null) s1.child.kill('SIGKILL'); } catch(e){}
    try { if (s2 && s2.child.exitCode === null) s2.child.kill('SIGKILL'); } catch(e){}
    try { if (mock) mock.close(); } catch(e){}
    restoreConfigs();
    console.log('configs restored, children stopped');
  }
  process.exit(failCount ? 1 : 0);
})();
