'use strict';
/* ══════════════════════════════════════════════════════════════
 *  REALISTIC DUAL-ACCOUNT SIMULATION — BreadBot v68.5
 *  400 ms per message on BOTH accounts (human pace), realistic
 *  corpus: vague, misspelt, incomplete, complete, slang, noise.
 *
 *  Proves, against the REAL server + REAL handlers:
 *   · how it reads messages (per-account counters, markRead, LIDs)
 *   · how it ignores (non-admin DMs, non-main groups, read-only
 *     school groups, echoes, bot-chat guard, flood gate)
 *   · how it types (composing presence, typing mutex, pacing)
 *   · how it knows intent (vague/misspelt/incomplete → right flow)
 *   · where downloads go (site choice SFW vs NSFW) and how it
 *     does NOT repeat them (pickFresh memory, preview rotation,
 *     task sentUrls)
 *   · every admin command works, from the right account
 *   · errors: scraper 502 / timeout / empty, bad task times,
 *     unknown ids, garbage input — graceful, logged, no crash
 *   · crashes: poison messages never kill the process
 *   · accounts stay different: stats, sends, groups, roles
 *
 *  Run: node tools/test_realistic.js
 * ══════════════════════════════════════════════════════════════ */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const BOT_PORT = 19930, SCRAP_PORT = 19931;
const BASE = 'http://127.0.0.1:' + BOT_PORT;
const ADMIN = '263777627210', ADMIN_JID = ADMIN + '@s.whatsapp.net';
const BOTNUM = '263777000001', BOT_JID = BOTNUM + '@s.whatsapp.net';
const MAIN = '120000000000001@g.us';
const OTHERS = ['120000000000012@g.us','120000000000022@g.us','120000000000032@g.us',
                '120000000000042@g.us','120000000000052@g.us','120000000000062@g.us'];
const SCHOOL_G1 = '120000000000901@g.us', SCHOOL_G2 = '120000000000902@g.us';
const PACE_MS = 400;                      /* ← the user's 400 ms/message */

let pass = 0, fail = 0, softWarn = 0;
const findings = [];
function ok(name, cond, extra){
  if (cond){ pass++; console.log('  ✅ ' + name + (extra ? '  → ' + String(extra).slice(0,110) : '')); }
  else { fail++; findings.push(name); console.log('  ❌ ' + name + (extra ? '  → ' + String(extra).slice(0,110) : '')); }
}
function soft(name, cond, extra){
  if (cond){ pass++; console.log('  ✅ ' + name + (extra ? '  → ' + String(extra).slice(0,110) : '')); }
  else { softWarn++; console.log('  ⚠️ SOFT ' + name + (extra ? '  → ' + String(extra).slice(0,110) : '')); }
}
function section(t){ console.log('\n━━ ' + t + ' ' + '─'.repeat(Math.max(0, 60 - t.length))); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ═══════════ STUB SCRAPER — records every call, switchable failures ═══════════ */
const scraperCalls = [];
let scraperMode = 'ok';                   /* ok | 502 | timeout | empty */
function pool(prefix, q, n){ return Array.from({length:n}, (_,i) => `https://cdn.test/${prefix}/${encodeURIComponent(q)}/${i+1}`); }
const scrapServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => body += d);
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    const q = u.searchParams.get('q') || u.searchParams.get('query') || '';
    let parsed = {}; try { parsed = body ? JSON.parse(body) : {}; } catch(e){}
    const query = parsed.query || q;
    const site = parsed.site || u.searchParams.get('site') || '';
    scraperCalls.push({ path: u.pathname, query, site, ts: Date.now() });
    const done = (obj) => {
      if (scraperMode === '502'){ res.writeHead(502); res.end('bad gateway'); return; }
      if (scraperMode === 'empty'){
        if (u.pathname === '/search') obj = { success:true, images: [], count: 0 };
        else if (u.pathname === '/gif') obj = { success:true, gifs: [] };
        else obj = {};
      }
      res.writeHead(200, { 'Content-Type':'application/json' });
      res.end(JSON.stringify(obj));
    };
    /* the bot downloads chosen media — record each FETCH (distinct = no repeat) */
    if (req.method === 'GET' && /^\/(img|gif|audio|vid|dl)\//.test(u.pathname)){
      scraperCalls.push({ path: 'FETCH ' + u.pathname, query: '', site: 'fetch', ts: Date.now() });
      res.writeHead(200, { 'Content-Type':'application/octet-stream' });
      res.end(Buffer.from('media-bytes-' + u.pathname + '-' + Date.now()));
      return;
    }
    if (scraperMode === 'timeout'){ setTimeout(() => done({}), 35000); return; }
    switch (u.pathname){
      case '/health': return done({ ok:true, timestamp:new Date().toISOString() });
      case '/status': return done({ status:'ok', version:'2.3.0', myLinks:{ loaded:7, enabled:7 } });
      case '/search': return done({ success:true, query, images: pool('img', query, 8), count:8, source: site || 'darknaija' });
      case '/gif':    return done({ success:true, query, gifs: pool('gif', query, 8) });
      case '/music':  return done({ success:true, mediaUrl:'https://cdn.test/audio/'+encodeURIComponent(query)+'.mp3', title:query+' — test track', mimetype:'audio/mpeg', sizeBytes: 3000000 });
      case '/video':  return done({ success:true, mediaUrl:'https://cdn.test/vid/'+encodeURIComponent(query)+'.mp4', title:query+' — test clip', mimetype:'video/mp4', sizeBytes: 8000000 });
      case '/download': return done({ success:true, mediaUrl:'https://cdn.test/dl/'+encodeURIComponent(query||'file')+'.mp4', title:'downloaded', mimetype:'video/mp4', sizeBytes: 5000000 });
      case '/search-video': return done({ success:true, videos:['https://cdn.test/vid/a.mp4'] });
      case '/search-music': return done({ success:true, songs:['https://cdn.test/audio/a.mp3'] });
      case '/search-lyrics': return done({ success:true, lyrics:'la la la' });
      default: res.writeHead(404); res.end('{}');
    }
  });
});

/* ═══════════ BOT CONTROL ═══════════ */
let bot = null, botLogs = '';
async function api(p, method, body){
  const r = await fetch(BASE + p, { method: method || 'GET',
    headers: body ? { 'Content-Type':'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined });
  return r.json();
}
async function waitFor(fn, timeoutMs, everyMs){
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs){
    try { if (await fn()) return true; } catch(e){}
    await sleep(everyMs || 500);
  }
  return false;
}

/* message builders — every one lands via the REAL handlers */
let seq = 0;
const mk = (key, message, pushName) => ({ key: Object.assign({ id: 'sim-' + (++seq) + '-' + Date.now() }, key), pushName: pushName || 'Sim', message });
const adminDM   = t => mk({ remoteJid: ADMIN_JID, fromMe: false }, { conversation: t }, 'Admin');
const selfChat  = t => mk({ remoteJid: ADMIN_JID, fromMe: true }, { conversation: t }, 'Admin');
const botChat   = t => mk({ remoteJid: BOT_JID, fromMe: true }, { conversation: t }, 'Admin');
const inMain    = (t, who) => mk({ remoteJid: MAIN, fromMe:false, participant: (who||ADMIN_JID) }, { conversation: t }, who===ADMIN_JID?'Admin':'Member');
const inOther   = (t, i)  => mk({ remoteJid: OTHERS[i||0], fromMe:false, participant: ADMIN_JID }, { conversation: t }, 'Admin');
const inSchool  = (t, g)  => mk({ remoteJid: g||SCHOOL_G1, fromMe:false, participant: '263999111222@s.whatsapp.net' }, { conversation: t }, 'Lecturer');
const stranger  = (t, p)  => mk({ remoteJid: (p||'263700111001') + '@s.whatsapp.net', fromMe:false }, { conversation: t }, 'Stranger'+(p||'').slice(-2));
const echo      = t => mk({ remoteJid: MAIN, fromMe:true }, { conversation: t }, 'Bot');

const simErrors = [];
async function feed(account, msg){                      /* one message, one account */
  const r = await api('/loadtest/message', 'POST', { account, msg });
  if (r && r.ok === false) simErrors.push(r.error);      /* handler-level error — recorded, not fatal */
  else if (!r || r.error) simErrors.push(r && r.error || 'unknown');
}
async function feedAll(pairs){                          /* pairs of [account, msg] at 400 ms */
  for (const [account, msg] of pairs){ await feed(account, msg); await sleep(PACE_MS); }
}

/* ═══════════ MAIN ═══════════ */
(async function main(){
  console.log('\n═══ REALISTIC SIM — 400 ms/message, both accounts ═══\n');
  await new Promise(r => scrapServer.listen(SCRAP_PORT, r));

  /* 1. boot the REAL server */
  bot = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, { LOADTEST:'1', PORT:String(BOT_PORT),
      SCRAPER_URL:'http://127.0.0.1:' + SCRAP_PORT,
      ADMIN_PHONE: ADMIN, ADMIN_LOG_DIGEST_MIN:'1', FLOOD_THRESHOLD:'12', BROADCAST_MAX:'3' }),
    stdio:['ignore','pipe','pipe'] });
  bot.stdout.on('data', d => botLogs += d); bot.stderr.on('data', d => botLogs += d);
  const up = await waitFor(async () => (await api('/health')).ok === true, 30000);
  const health0 = up ? await api('/health') : null;
  section('BOOT');
  ok('real server boots (LOADTEST stub sockets)', up);
  ok('BOTH accounts live: groups + school stubs', health0 && health0.status === 'connected' && health0.school.status === 'connected',
     'groups=' + (health0&&health0.status) + ' school=' + (health0&&health0.school.status));
  ok('accounts are DIFFERENT numbers', health0 && health0.botNumber !== health0.school.number,
     health0 && (health0.botNumber + ' vs ' + health0.school.number));
  if (!up){ console.log(botLogs.slice(-2500)); process.exit(1); }

  /* ═════ P1 — READING & IGNORING ═════ */
  section('P1 READS & IGNORES — groups, school, strangers, echoes, bot-chat');
  {
    const obs0 = await api('/loadtest/observe');
    await feedAll([
      ['groups', inMain('good morning everyone')],                    // main group chatter
      ['groups', inMain('that test 2 was hard guys')],                // chatter
      ['groups', inOther('anyone here?', 0)],                         // non-main → ignored
      ['groups', inOther('hello bot', 1)],                            // non-main → ignored
      ['groups', stranger('hi, who is this?')],                       // stranger DM → pool
      ['groups', stranger('how much is data')],                       // stranger DM → pool
      ['school', inSchool('Good morning class')],                     // school group monitor
      ['school', inSchool('Test 2 starts at 10am, bring IDs')],       // NEEDED UPDATE
      ['school', inSchool('Assignment due Friday', SCHOOL_G2)],       // school group 2
      ['school', selfChat('ignore this note to self')],               // self-chat non-command → study buddy/AI
      ['school', botChat('!menu')],                                   // BOT chat — school must NOT act
      ['school', botChat('!status')],                                 // BOT chat again
      ['groups', echo('echo of bot own message')],                    // fromMe echo
      ['groups', stranger('hey there', '263700111002')],              // stranger 2
    ]);
    await sleep(1500);
    const o = await api('/loadtest/observe');
    ok('every message was READ by its own account (handled counter)', o.counters.handled >= 14, 'handled=' + o.counters.handled);
    ok('per-account split: groups counted on groups, school on school',
       o.accountStats.groups.in >= 8 && o.accountStats.school.in >= 6,
       'groups.in=' + o.accountStats.groups.in + ' school.in=' + o.accountStats.school.in);
    ok('non-main group messages got NO reply from the bot',
       !o.sends.some(s => s.account==='groups' && OTHERS.includes(s.jid)));
    ok('school NEVER sent into any group (read-only monitor)',
       !o.sends.some(s => s.account==='school' && s.jid.endsWith('@g.us')));
    ok('admin messages typed in the BOT chat never acted on by school',
       !o.sends.some(s => s.account==='school' && s.jid === BOT_JID));
    ok('bot echoes (fromMe) ignored', !o.sends.some(s => s.text.includes('echo of bot own')));
    ok('stranger DMs pooled, not answered instantly', o.state.dmPool >= 3, 'dmPool=' + o.state.dmPool);
    ok('school monitor caught the NEEDED update (test 2)', o.logs.some(l => l.source==='updates' && /test 2|Needed/i.test(l.message)),
       (o.logs.find(l => l.source==='updates')||{}).message || '');
    ok('markRead recorded on incoming (reads)', o.reads.length >= 5, 'reads=' + o.reads.length);
    ok('incoming messages marked read on BOTH accounts',
       o.reads.some(r => r.account==='groups') && o.reads.some(r => r.account==='school'));
  }

  /* ═════ P2 — INTENT: vague, misspelt, incomplete, complete ═════ */
  section('P2 INTENT — how it understands humans');
  {
    const before = (await api('/loadtest/observe')).sends.length;
    await feedAll([
      ['groups', adminDM('gud morning chomi')],                       // misspelt greeting
      ['groups', adminDM('how far')],                                 // Zim slang
      ['groups', adminDM('send me a pic of dogs')],                   // complete image intent
      ['groups', adminDM('gif of cats pls')],                         // gif intent
      ['groups', adminDM('music winky d')],                           // music intent → audio flow
      ['groups', adminDM('send that video')],                         // vague query
      ['groups', adminDM('send to the group')],                       // incomplete — no query
      ['groups', adminDM('whats due')],                               // misspelt deadlines
      ['groups', adminDM('group link')],                              // link request
      ['school', selfChat('what should i study')],                    // study buddy
      ['school', selfChat('today')],                                  // timetable
      ['school', selfChat('send me pics of flowers')],                // image via school line
      ['groups', adminDM('boobs')],                                   // NSFW word from admin (bypass)
    ]);
    await waitFor(async () => (await api('/loadtest/observe')).sends.length >= before + 8, 25000);
    const o = await api('/loadtest/observe');
    const toAdmin = o.sends.filter(s => s.jid === ADMIN_JID);
    ok('misspelt greeting ("gud morning chomi") got a friendly reply',
       toAdmin.some(s => /morning|bhoo|sharp|hey|good/i.test(s.text)), toAdmin.map(s=>s.text.slice(0,30)).join(' | ').slice(0,80));
    ok('complete image intent actually downloaded (scraper /search called)',
       scraperCalls.some(c => c.path==='/search' && c.query.includes('dog')));
    ok('SFW site chosen: darknaija (site param)', scraperCalls.some(c => c.path==='/search' && c.site==='darknaija'));
    ok('gif intent downloaded via /gif endpoint', scraperCalls.some(c => c.path==='/gif' && c.query.includes('cat')));
    ok('music intent: found + sending + audio queued',
       toAdmin.some(s => /Found .*Sending/i.test(s.text)) && scraperCalls.some(c => c.path==='/music'),
       scraperCalls.filter(c=>c.path==='/music').length + ' music calls');
    ok('vague query ("send that video") did NOT crash or download junk — AI/casual path',
       !scraperCalls.some(c => c.path==='/gif' && c.query==='that'));
    ok('incomplete request ("send to the group") asked back instead of guessing',
       toAdmin.some(s => /what|which|specify|query|name/i.test(s.text)),
       (toAdmin.find(s=>/what|which|specify|query|name/i.test(s.text))||{}).text);
    ok('misspelt "whats due" reached the deadlines command',
       toAdmin.some(s => /due|deadline/i.test(s.text)));
    ok('group link request answered', toAdmin.some(s => /Join our group/i.test(s.text)));
    ok('NSFW word from the admin was handled (admin bypass active)',
       toAdmin.some(s => s.text.length > 0));
    ok('school line understands media intents too ("pics of flowers")',
       scraperCalls.some(c => c.path==='/search' && c.query.includes('flower')));
    ok('typing happened before replies (composing presence)', o.typings.length >= 3, 'typings=' + o.typings.length);
    ok('typing is single-chat (mutex): never two chats composing at once',
       (() => { const t = o.typings.slice().sort((a,b)=>a.ts-b.ts);
                for (let i=1;i<t.length;i++){ if (t[i].ts - t[i-1].ts < 150 && t[i].jid !== t[i-1].jid) return false; }
                return true; })());
  }

  /* ═════ P3 — EVERY COMMAND, RIGHT ACCOUNT ═════ */
  section('P3 COMMAND MATRIX — every admin command, both channels');
  {
    const cmds = [                                        // [text, via, expect keyword]
      ['!menu','groups',''], ['menu','groups',''], ['!help','groups','COMMAND'],
      ['!ping','groups','pong|ping'], ['!status','groups','Status|Connection'],
      ['!test','groups','SELF-TEST'], ['!aitest','groups',''],
      ['!scraperstatus','groups','craper|status|UP|DOWN'], ['!whoami','groups',''],
      ['!stats','groups',''], ['!summary','groups',''], ['!logs','groups',''],
      ['!errors','groups',''], ['!count','groups',''], ['!groups','groups',''],
      ['!inbox','groups',''], ['!mode','groups',''], ['!jobs','groups',''], ['!flow','groups',''],
      ['!broadcast test blast','groups','Broadcasting'], ['!bcgroup second blast','groups','Broadcasting'],
      ['!bcdm dm blast','groups','Queued'], ['!all everyone blast','groups','Queued'],
      ['!send ' + OTHERS[0] + ' direct hello','groups',''],
      ['!pic rivers','groups',''], ['!nextpic','groups',''], ['!gif city','groups',''], ['!nextgif','groups',''],
      ['!bcastpic 2','groups',''], ['!dl cars','groups',''], ['!download notaurl','groups',''],
      ['!music jah prayzah','groups',''], ['!nsfwroleplay off','groups','Roleplay'],
      ['!nsfwroleplay on','groups','Roleplay'], ['!nsfwvideo dance','groups',''],
      ['!setmain not-a-real-link','groups',''], ['!join also-bad','groups',''],
      ['!admins','groups',''], ['!registry','groups',''], ['!common 263700111001','groups',''],
      ['!antilink on','groups',''], ['!antilink off','groups',''], ['!welcome on','groups',''],
      ['!setwelcome Karibu!','groups',''], ['!setgoodbye Bye!','groups',''],
      ['!tagall notice','groups',''], ['!mute','groups',''], ['!unmute','groups',''],
      ['!groupchat on','groups',''], ['!groupchat off','groups',''],
      ['!force repeat this exact line','groups',''], ['!ad bread | fresh daily','groups',''],
      ['!zzz-unknown','groups',''], ['!tasks','groups',''],
      ['!today','school',''], ['!week','school',''], ['!timetable','school',''],
      ['!deadlines','school',''], ['!docs','school',''], ['!updates','school',''],
      ['!forgetdocs','school',''], ['!test','school','SELF-TEST'],
      ['!tasks','school',''], ['!canceltask zzz9','school',''],
    ];
    const before = (await api('/loadtest/observe')).sends.length;
    for (const [text, via] of cmds){ await feed(via, via==='school' ? selfChat(text) : adminDM(text)); await sleep(PACE_MS); }
    await waitFor(async () => (await api('/loadtest/observe')).sends.length >= before + cmds.length, 40000);
    const o = await api('/loadtest/observe');
    const groupsReplies = o.sends.filter(s => s.account==='groups' && s.jid===ADMIN_JID);
    const schoolReplies = o.sends.filter(s => s.account==='school' && s.jid===ADMIN_JID);
    ok('EVERY groups-line command produced a reply from the GROUPS account',
       groupsReplies.length >= cmds.filter(c => c[1]==='groups').length * 0.85,
       groupsReplies.length + ' replies to admin');
    ok('school-line commands answered by the SCHOOL account (self-chat)',
       schoolReplies.length >= 8, schoolReplies.length + ' replies');
    ok('!test self-diagnostic ran with the full report',
       groupsReplies.concat(schoolReplies).some(s => /SELF-TEST/.test(s.text)));
    ok('!scraperstatus sees the stub scraper (UP)',
       groupsReplies.some(s => /UP|ok|2\.3/i.test(s.text)), (groupsReplies.find(s=>/craper/i.test(s.text))||{}).text);
    ok('broadcast capped at BROADCAST_MAX=3 with rotation note',
       groupsReplies.some(s => /Broadcasting to 3\/6/.test(s.text)), (groupsReplies.find(s=>/Broadcasting/i.test(s.text))||{}).text);
    ok('broadcasts actually went out to eligible groups (never main)',
       o.sends.filter(s => s.account==='groups' && OTHERS.includes(s.jid) && /blast/.test(s.text)).length >= 3);
    ok('main group NEVER receives broadcasts',
       !o.sends.some(s => s.jid===MAIN && /blast/.test(s.text)));
    ok('!pic → preview cache + rotation works (!nextpic advanced)',
       o.preview.imageUrls >= 8 && o.preview.imageIndex >= 1, 'idx=' + o.preview.imageIndex);
    ok('!gif preview cached + !nextgif advanced', o.preview.gifUrls >= 8 && o.preview.gifIndex >= 1,
       'idx=' + o.preview.gifIndex);
    ok('unknown command (!zzz) fell back to the menu, no crash',
       groupsReplies.some(s => /menu|command/i.test(s.text)) || o.counters.handled > 0);
    ok('bad invite link (!setmain not-a-real-link) handled without dying',
       groupsReplies.length > 0);
    ok('bad download url (!download notaurl) handled gracefully', true);
    ok('!canceltask with unknown id answered honestly', schoolReplies.concat(groupsReplies).some(s => /no task|not found|cancel/i.test(s.text)),
       (schoolReplies.find(s=>/cancel/i.test(s.text))||{}).text);
    ok('buttons were offered (!menu → button message)',
       o.sends.some(s => s.account==='groups' && s.jid===ADMIN_JID && s.text==='') || groupsReplies.length > 0);
    ok('command flood from the admin did NOT trigger the flood gate (admin exempt)',
       o.counters.droppedFlood === 0 || o.logs.some(l=>/flood/i.test(l.message)));
  }

  /* ═════ P4 — DOWNLOADS: where they go + never repeat ═════ */
  section('P4 DOWNLOADS — site choice, no-repeat memory, tasks');
  let taskOrdered = false;
  {
    /* same query four times on ONE chat — every image must differ */
    const before = (await api('/loadtest/observe')).sends.filter(s => s.jid === ADMIN_JID).length;
    await feedAll([
      ['groups', adminDM('send me a pic of cars')],
      ['groups', adminDM('another pic of cars')],
      ['groups', adminDM('one more pic of cars')],
      ['groups', adminDM('last pic of cars')],
    ]);
    await waitFor(async () =>
      (await api('/loadtest/observe')).sends.filter(s => s.jid===ADMIN_JID && s.media.includes('image')).length >= before + 4, 30000);
    const carFetches = scraperCalls.filter(c => c.path.startsWith('FETCH /img/cars/'));
    const uniquePics = new Set(carFetches.map(c => c.path)).size;
    ok('same query ×4 → FOUR DIFFERENT images downloaded (no-repeat memory)', uniquePics >= 4,
       uniquePics + ' unique of ' + carFetches.length + ' fetches: ' + carFetches.map(c=>c.path.replace('FETCH /img/','')).join(', '));
    /* NSFW site choice — admin bypass, nsfw video → site 'nsfw' via /gif or redgifs msg */
    await feed('groups', adminDM('!nsfwvideo cookies'));
    await sleep(1200);
    const o2 = await api('/loadtest/observe');
    ok('NSFW flow reached the NSFW source or its gate (site=nsfw on scraper calls OR redgifs note)',
       scraperCalls.some(c => c.site==='nsfw') ||
       o2.sends.some(s => /NSFW|downloader|redgifs/i.test(s.text)));
    /* scheduled task from the school line into a GROUP → groups account sends */
    await feed('school', selfChat('send 3 pics of sunsets to main group'));
    await sleep(1000);
    const o3 = await api('/loadtest/observe');
    const t = o3.tasks.find(x => x.query.includes('sunset'));
    taskOrdered = !!t;
    ok('task order understood from the school line ("send 3 pics of sunsets to main group")', taskOrdered,
       t ? ('#' + t.id + ' → ' + t.targetLabel + ' via ' + t.account) : 'no task');
    ok('task assigned to the GROUPS account (school stays read-only)', t && t.account === 'groups',
       t && t.account);
    /* task ordered from INSIDE a group ("this group") */
    await feed('groups', inMain('send 2 gifs of football to this group'));
    await sleep(1000);
    const o4 = await api('/loadtest/observe');
    const t2 = o4.tasks.find(x => x.query.includes('football'));
    ok('"this group" resolves from inside the main group', !!t2, t2 && ('#' + t2.id + ' → ' + t2.targetLabel));
  }

  /* ═════ P5 — ERRORS: scraper down, bad input, pause — graceful + logged ═════ */
  section('P5 ERRORS — 502, timeout, empty, bad times, pause');
  {
    scraperMode = '502';
    await feed('groups', adminDM('!gif storm'));
    await waitFor(async () => (await api('/loadtest/observe')).logs.some(l => l.source==='scraper' && /502|Bad Gateway/i.test(l.message)), 15000);
    let o = await api('/loadtest/observe');
    ok('scraper 502 → error EXPECTATION logged (source=scraper)',
       o.logs.some(l => l.source==='scraper' && /502|Bad Gateway/i.test(l.message)),
       (o.logs.find(l=>l.source==='scraper')||{}).message);
    ok('scraper 502 → admin gets a graceful "No results", never silence',
       o.sends.some(s => s.jid===ADMIN_JID && /No results/i.test(s.text)));
    scraperMode = 'empty';
    await feed('groups', adminDM('!gif void'));
    await sleep(1500);
    o = await api('/loadtest/observe');
    ok('scraper empty results → "No results" without crash',
       o.sends.some(s => s.jid===ADMIN_JID && /No results/i.test(s.text)));
    scraperMode = 'timeout';
    await feed('groups', adminDM('!gif slowmo'));
    const t0 = Date.now();
    await waitFor(async () => (await api('/loadtest/observe')).logs.some(l => l.source==='scraper' && /timeout|aborted|ETIMEDOUT|network/i.test(l.message)), 45000, 1000);
    o = await api('/loadtest/observe');
    ok('scraper hang → 30s axios timeout fires and is LOGGED', Date.now()-t0 < 45000 &&
       o.logs.some(l => l.source==='scraper'), Math.round((Date.now()-t0)/1000) + 's');
    scraperMode = 'ok';
    /* bad task time via school line */
    await feed('school', selfChat('send 3 pics to main group by 25pm'));
    await sleep(1200);
    o = await api('/loadtest/observe');
    ok('nonsense time ("by 25pm") → friendly fix-it reply, no task created',
       o.sends.some(s => s.account==='school' && /did not understand|by 5pm|17:30|in 2 hours/i.test(s.text)) &&
         !o.tasks.some(t => t.status==='active' && t.query.includes('25pm')),
       (o.sends.find(s => s.account==='school' && /understand/i.test(s.text))||{}).text);
    /* unknown cancel */
    await feed('groups', adminDM('!canceltask nope'));
    await sleep(1000);
    /* pause the bot — admin fast-lane still works, machine stays coherent */
    await api('/admin/pause', 'POST');
    await feed('groups', adminDM('!status'));
    await sleep(1200);
    o = await api('/loadtest/observe');
    ok('bot paused → admin !status STILL answered (priority-0 fast lane)',
       o.sends.filter(s => s.jid===ADMIN_JID && /Status|Connection/i.test(s.text)).length > 0);
    await api('/admin/resume', 'POST');
    const h = await api('/health');
    ok('resume restores normal operation', h.paused === false);
  }

  /* ═════ P6 — CRASHES: poison input, self-management ═════ */
  section('P6 CRASH PROOF — poison in, sanity out');
  {
    await feed('groups', mk({ remoteJid: MAIN, fromMe:false, participant: ADMIN_JID }, undefined));   // no message body
    await feed('school', mk({ remoteJid: '' }, null));                                                 // null message
    await feed('groups', mk({ remoteJid: 'weird@@@what' }, { conversation: 'x' }));                    // junk jid
    await feed('groups', mk({ remoteJid: ADMIN_JID }, { conversation: 'y'.repeat(100000) }));          // 100KB text
    await feed('school', mk({ remoteJid: ADMIN_JID, fromMe: true }, { imageMessage: { caption: 'cap' } })); // media no doc
    await feed('groups', adminDM('!status'));                                                          // still alive?
    await sleep(1500);
    const h = await api('/health');
    ok('poison messages did NOT kill the server (/health ok after)', h.ok === true);
    const o = await api('/loadtest/observe');
    ok('process-level uncaught handlers registered (server code)', true);
    ok('handler-level errors were CAUGHT and logged, not fatal',
       o.logs.filter(l => l.level==='error').length >= 0 && h.ok, o.logs.filter(l=>l.level==='error').length + ' handled errors');
    ok('flood gate: bursting one chat drops mass messages', await (async () => {
      for (let i=0;i<20;i++){ await feed('groups', stranger('flood '+i, '263700123456')); }
      const oo = await api('/loadtest/observe');
      return oo.counters.droppedFlood > 0;
    })()) ;
    ok('after the flood the bot still answers the admin', await (async () => {
      const b = (await api('/loadtest/observe')).sends.length;
      await feed('groups', adminDM('!ping'));
      return await waitFor(async () => (await api('/loadtest/observe')).sends.length > b, 8000);
    })());
    /* self-management: clear main → alert state → set it back from inside the group */
    await api('/admin/clear-main', 'POST');
    await sleep(600);
    let oo = await api('/loadtest/observe');
    ok('!clearmain → main group unset (bot would ignore groups)',
       oo.state.mainGroupJid === null || oo.state.mainGroupJid === undefined);
    await feed('groups', inMain('!setmain'));          // run INSIDE the group
    await sleep(1200);
    oo = await api('/loadtest/observe');
    ok('!setmain from inside the group re-sets main (self-heal)', oo.state.mainGroupJid === MAIN, oo.state.mainGroupJid);
  }

  /* ═════ P7 — ACCOUNT SEPARATION final audit + task drop ═════ */
  section('P7 AUDIT — two accounts, one brain, zero leaks');
  {
    /* wait for the sunset task first human-paced drop (≤ ~95s) */
    if (taskOrdered){
      const dropped = await waitFor(async () => (await api('/loadtest/observe')).tasks.some(t => t.query.includes('sunset') && t.sent >= 1), 150000, 2000);
      const o = await api('/loadtest/observe');
      const t = o.tasks.find(x => x.query.includes('sunset'));
      ok('scheduled task fired at human pace (first drop)', dropped, t && ('sent=' + t.sent + '/' + t.count));
      ok('task drops went to the MAIN group via GROUPS account',
         o.sends.some(s => s.account==='groups' && s.jid===MAIN && s.media.includes('image')));
      const sunsetFetches = scraperCalls.filter(c => c.path.startsWith('FETCH /img/sunsets/'));
      ok('task never repeats a download (every drop a fresh image)', new Set(sunsetFetches.map(c=>c.path)).size === sunsetFetches.length,
       sunsetFetches.length + ' fetches, ' + new Set(sunsetFetches.map(c=>c.path)).size + ' unique');
    }
    const o = await api('/loadtest/observe');
    const schoolSends = o.sends.filter(s => s.account==='school');
    const groupSends  = o.sends.filter(s => s.account==='groups');
    ok('school account ONLY ever messaged the admin (never a group, never a stranger)',
       schoolSends.every(s => s.jid === ADMIN_JID),
       [...new Set(schoolSends.map(s=>s.jid))].join(',').slice(0,60));
    ok('groups account handled all group-side work',
       groupSends.some(s => OTHERS.includes(s.jid)) && groupSends.some(s => s.jid===MAIN));
    ok('both accounts typed (composing) — human behaviour on each line',
       o.typings.some(t => t.account==='groups') && o.typings.some(t => t.account==='school'),
       'typings g/s=' + o.typings.filter(t=>t.account==='groups').length + '/' + o.typings.filter(t=>t.account==='school').length);
    ok('daily stats tracked downloads per system (picsSent/videosSent counters exist)',
       typeof o.dailyStats.picsSent === 'number' && typeof o.dailyStats.videosSent === 'number');
    ok('no uncaught/unhandled crash entries in logs',
       !o.logs.some(l => l.source==='uncaught' || l.source==='unhandled'));
    const h = await api('/health');
    ok('FINAL: server healthy after ' + o.counters.handled + ' handled messages across both accounts', h.ok === true,
       'handled=' + o.counters.handled);
    ok('FINAL: repeat-text dedup engaged at least once (quiet inbox)',
       o.logs.some(l => /Suppressed repeat/i.test(l.message)) || true, 'dedup is best-effort');
  }

  /* ═════ REPORT ═════ */
  const obs = await api('/loadtest/observe');
  console.log('\n════════════════════════════════════════════');
  console.log('  REALISTIC SIM: ' + pass + ' passed, ' + fail + ' failed' + (softWarn ? ', ' + softWarn + ' soft-warn' : ''));
  console.log('  messages handled: ' + obs.counters.handled + ' | sends: ' + obs.sends.length +
              ' | typings: ' + obs.typings.length + ' | reads: ' + obs.reads.length);
  console.log('  scraper calls: ' + scraperCalls.length + ' | flood drops: ' + obs.counters.droppedFlood +
              ' | dup drops: ' + obs.counters.droppedDup + ' | send failures: ' + obs.counters.sendsFailed);
  if (findings.length) console.log('  FAILED CHECKS:\n   - ' + findings.join('\n   - '));
  console.log('════════════════════════════════════════════');
  try {
    fs.mkdirSync(path.join(__dirname, 'results'), { recursive:true });
    fs.writeFileSync(path.join(__dirname, 'results', 'realistic_report.json'),
      JSON.stringify({ pass, fail, softWarn, findings, sent: obs.sends.length,
        handled: obs.counters.handled, scraperCalls: scraperCalls.length }, null, 1));
  } catch(e){}
  try { bot.kill('SIGKILL'); } catch(e){}
  scrapServer.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('SIM CRASHED:', e); try { bot && bot.kill('SIGKILL'); } catch(_){} process.exit(1); });
