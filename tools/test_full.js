'use strict';
/* ══════════════════════════════════════════════════════════════
 *  FULL COMPONENT TEST — runs the REAL shipped server.js code.
 *  Covers exactly what was asked:
 *    1. DM commands (no "!" — natural language)
 *    2. Admin commands (! — full menu vs real switch cases)
 *    3. Scrapper trigger words (what words fire a download)
 *    4. Duplicate-message suppression (outgoing + AI reply)
 *    5. 5-last-message reply context (pool + history + prompt)
 *    6. School account = admin-DM-only strict gate
 *    7. Needed-updates filter (study-buddy side channel)
 *  Run: node tools/test_full.js
 * ══════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

let pass = 0, fail = 0;
global.__g = {};
function ok(name, cond, extra){
  if (cond){ pass++; console.log('  ✅ ' + name + (extra ? '  → ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}
function section(t){ console.log('\n━━ ' + t + ' ' + '─'.repeat(Math.max(0, 56 - t.length))); }
function grab(startMarker, endMarker){
  const s = src.indexOf(startMarker);
  const e = endMarker ? src.indexOf(endMarker, s) : -1;
  if (s < 0 || (endMarker && e < 0)) throw new Error('grab failed: ' + startMarker);
  return endMarker ? src.slice(s, e) : src.slice(s);
}

/* ═══ 1. DM COMMANDS — natural language, no "!" ═══ */
section('1. DM COMMANDS (no ! prefix — natural language)');
{
  const chunk = grab('const CASUAL_ALIASES', 'async function handleAdminCommand');
  eval(chunk + '\n;__g.parseCasualAdmin = parseCasualAdmin; __g.CASUAL_ALIASES = CASUAL_ALIASES;');
  const P = global.__g.parseCasualAdmin;
  const cases = [
    /* basics */
    ['menu',                 '!menu'],
    ['buttons',              '!menu'],
    ['help',                 '!help'],
    ['status',               '!status'],
    ['how are you',          '!status'],
    ['you there',            '!ping'],
    ['ping',                 '!ping'],
    /* study buddy */
    ['study',                '!study'],
    ['study plan',           '!study'],
    ['what should i study',  '!study'],
    ['study osmosis',        '!study osmosis'],
    ['study plan data structures', '!study data structures'],
    /* pdf + docs */
    ['pdf',                  '!pdf'],
    ['make me a pdf about osmosis', '!pdf about osmosis'],
    ['create a pdf photosynthesis', '!pdf photosynthesis'],
    ['docs',                 '!docs'],
    ['my documents',         '!docs'],
    /* deadlines + updates */
    ['deadlines',            '!deadlines'],
    ["what's due",           '!deadlines'],
    ['whats due',            '!deadlines'],
    ['updates',              '!updates'],
    ['any updates',          '!updates'],
    /* school */
    ['today',                '!today'],
    ['timetable',            '!today'],
    ['week',                 '!week'],
    ['weather',              '!weather'],
    ['weather bindura',      '!weather bindura'],
    /* control */
    ['pause',                '!pause'],
    ['stop the bot',         '!pause'],
    ['resume',               '!resume'],
    ['wake up',              '!resume'],
    ['groups',               '!groups'],
    ['group list',           '!groups'],
    ['registry',             '!registry'],
    /* explicit ! passthrough */
    ['!stats',               '!stats'],
    ['!music Winky D',       '!music Winky D'],
    /* chat (NOT commands) — must return null */
    ['hey did you see the game last night it was absolutely crazy and this message keeps going on and on and on past the normal command length limit for sure yes', null],
    ['multi\nline\nchat',    null],
    ['',                     null]
  ];
  for (const [inp, want] of cases){
    let got = null; try { got = P(inp); } catch(e){ got = 'THREW:' + e.message; }
    ok(JSON.stringify(inp.length > 36 ? inp.slice(0,33)+'…' : inp), got === want, '→ ' + JSON.stringify(got));
  }
  ok('long casual chat is NOT a command (returns null)',
     P('hey did you see the game last night it was absolutely crazy and this message keeps going on and on and on past the normal command length limit for sure yes') === null);
}

/* ═══ 2. ADMIN COMMANDS — every menu item has a real case ═══ */
section('2. ADMIN COMMANDS (!) — menu ↔ real switch cases');
{
  const fnSrc  = grab('async function handleAdminCommand', 'function checkFlood');
  const menu   = grab('const COMMAND_LIST', 'function logRepeatedCmd');
  const cases  = new Set();
  const re = /case '([a-z0-9]+)'/g; let m;
  while ((m = re.exec(fnSrc))) cases.add(m[1]);
  const tokens = new Set();
  const re2 = /!([a-z0-9]+)/g;
  while ((m = re2.exec(menu))) tokens.add(m[1]);
  /* tokens that are aliases handled by other cases on the same line */
  const aliasMap = { commands:'help', timetable:'today', bc:'broadcast' };
  const missing = [];
  for (const t of tokens){
    const c = aliasMap[t] || t;
    if (!cases.has(c)) missing.push(t + '(no case ' + c + ')');
  }
  console.log('  menu promises ' + tokens.size + ' commands; switch has ' + cases.size + ' cases');
  ok('every !command in the menu has a real case in handleAdminCommand', missing.length === 0,
     missing.length ? 'MISSING: ' + missing.join(', ') : 'all resolve');
  /* key cases the user asked about, explicitly */
  for (const c of ['menu','study','pdf','docs','deadlines','updates','dl','download','music',
                   'stats','ping','pause','resume','weather','today','week','broadcast',
                   'force','logs','errors','help','ad','groupchat','mode','registry','groups']){
    ok('case \'' + c + '\' exists', cases.has(c));
  }
  /* school blocklist — downloads disabled on school account */
  ok('school account blocks downloads/broadcast (SCHOOL_BLOCKED)',
     /SCHOOL_BLOCKED = \['broadcast','bcgroup','bcdm','all','bcastpic'.*'dl','music','download'/.test(fnSrc));
}

/* ═══ 3. SCRAPER TRIGGER WORDS ═══ */
section('3. SCRAPER TRIGGER WORDS (what fires a download)');
{
  eval(grab('function detectMediaIntent', 'function detectNsfw') + '\n;__g.detectMediaIntent = detectMediaIntent;');
  const D = global.__g.detectMediaIntent;
  const music = [
    ['send me a song by Winky D',        'winky d'],
    ['music Jah Prayzah',                'jah prayzah'],
    ['can you send me the song nsana',   'nsana'],              // v68.1: was "the nsana"
    ['drop that mixtape',                'top hits'],           // v68.1: was "that"
    ['album of Jah Prayzah',             'jah prayzah'],
    ['please download track 5 mhs',      '5 mhs'],
    ['ndipe music',                      'top hits'],           // v68.1: was "ndipe"
    ['send me the song the box',         'box']                 // article stripped, title kept
  ];
  for (const [t, q] of music){
    const r = D(t);
    ok('music trigger: "' + t + '"', r && r.type === 'music' && r.query === q,
       '→ {type:' + (r && r.type) + ', query:' + JSON.stringify(r && r.query) + '}');
  }
  const video = [
    ['send a video of cats',   'video', 'cats'],
    ['any vid of Ronaldo',     'video', 'ronaldo'],
    ['mavhidhiyo ekufara',     'video', 'ekufara'],
    ['gif of laughing baby',   'gif',   'laughing baby'],
    ['gif of the laughing baby', 'gif', 'laughing baby'],   // v68.1: article stripped
    ['gifs please',            'gif',   'funny']            // v68.1: was "please"
  ];
  for (const [t, ty, q] of video){
    const r = D(t);
    ok(ty + ' trigger: "' + t + '"', r && r.type === ty && r.query === q,
       '→ {type:' + (r && r.type) + ', query:' + JSON.stringify(r && r.query) + '}');
  }
  const pics = [
    ['send pics of Harare',        'image', 'harare'],
    ['photo of Victoria Falls',    'image', 'victoria falls'],
    ['ndipe mapic eaMAI',          'image', 'eamai'],
    ['mufananidzo weshumba',       'image', 'weshumba']
  ];
  for (const [t, ty, q] of pics){
    const r = D(t);
    ok('pic trigger: "' + t + '"', r && r.type === ty && r.query === q,
       '→ {type:' + (r && r.type) + ', query:' + JSON.stringify(r && r.query) + '}');
  }
  const no = ['how are you', 'good morning everyone', 'what is the assignment',
              'I will download the app later', 'ok cool'];
  for (const t of no){
    const r = D(t);
    ok('non-trigger: "' + t + '"', r === null, '→ ' + JSON.stringify(r));
  }
  /* admin download commands exist and call the scrapper */
  const fnSrc = grab('async function handleAdminCommand', 'function checkFlood');
  ok("!dl  → scraperMusic → fallback scraperVideo", /case 'dl': \{[\s\S]*?await scraperMusic\(q\);[\s\S]*?if \(!r\.ok\) r = await scraperVideo\(q\);/.test(fnSrc));
  ok('!download <url> → scraperDownloadMedia(url, \'auto\')', /case 'download': \{[\s\S]*?await scraperDownloadMedia\(url, 'auto'\)/.test(fnSrc));
  ok("!music <q> → scraperMusic(q)", /case 'music': \{[\s\S]*?const r = await scraperMusic\(q\);/.test(fnSrc));
  ok('DM "song…" intent → scraperMusic (processDM)', /if \(intent && intent\.type === 'music'\)\{[\s\S]{0,200}?await scraperMusic\(intent\.query\)/.test(src));
  ok('group "song…" intent → scraperMusic (group path)', /gIntent\.type === 'music'\)\{[\s\S]{0,160}?await scraperMusic\(gIntent\.query\)/.test(src));
  ok('34MB cap enforced on scraper downloads', /MEDIA_MAX_BYTES\)\s*\n?\s*throw new Error\('Media too big/.test(src));
}

/* ═══ 4. DUPLICATE MESSAGES — suppression ═══ */
section('4. DUPLICATE MESSAGES (quiet inbox)');
{
  const hours = (src.match(/const OUT_DEDUP_HOURS\s*=\s*[^;]+;/) || ['const OUT_DEDUP_HOURS = 6;'])[0];
  eval(hours + '\nconst OUT_DEDUP_MS = OUT_DEDUP_HOURS * 3600000;\nconst recentOutTexts = new Map();\n' +
       grab('function outTextSeen', '/* v67: MAIN-GROUP FOCUS') +
       '\n;__g.outTextSeen = outTextSeen; __g.OUT_DEDUP_MS = OUT_DEDUP_MS; __g.recentOutTexts = recentOutTexts;');
  const S = global.__g.outTextSeen;
  const JID = '263777000001@s.whatsapp.net';
  ok('first send passes (not seen)', S(JID, 'Good morning team') === false);
  ok('identical resend SUPPRESSED within window', S(JID, 'Good morning team') === true);
  ok('case/spacing variants also suppressed', S(JID, '  good  MORNING team ') === true);
  ok('different text passes', S(JID, 'Practice is at 2pm') === false);
  ok('same text to a DIFFERENT chat passes', S('263777000002@s.whatsapp.net', 'Good morning team') === false);
  ok('dedup window is 6 hours (OUT_DEDUP_MS)', global.__g.OUT_DEDUP_MS === 6 * 3600000);
  ok('window expiry — text older than 6h may repeat', (function(){
    const jid = '263777000003@s.whatsapp.net';
    /* seed the REAL map with an entry older than the window */
    global.__g.recentOutTexts.set(jid, [{ h: 'expired text test', ts: Date.now() - global.__g.OUT_DEDUP_MS - 1000 }]);
    const canRepeat = S(jid, 'expired text test') === false;   // old entry filtered out
    const suppressedAgain = S(jid, 'expired text test') === true; // fresh send remembered
    return canRepeat && suppressedAgain;
  })());
  /* admin urgency bypass + repeat-suppress inside sendBuffer (source level) */
  const sb = grab('function sendBuffer(jid, content', 'return new Promise((resolve, reject)=>{');
  ok('dedup skip when opts.force (admin urgency)', /!\(opts && opts\.force\)/.test(sb));
  ok('dedup returns {dedup:true, suppressed:true} (no send)', /return Promise\.resolve\(\{ dedup:true, suppressed:true \}\)/.test(sb));
  ok('dedup only for priority >= 2 (urgent admin sends never suppressed)', /if \(priority >= 2\)\{[\s\S]*?outTextSeen\(jid, txt\)/.test(sb));
  /* AI never repeats itself (processDM last-3 check) */
  const line = grab('const lastBotTexts = hist.filter', '\n');
  const dupBotCheck = eval('(function(hist, aiReply){ ' + line.trim() + ' return lastBotTexts.includes(aiReply.toLowerCase().trim()); })');
  const hist = [
    { role:'user', text:'hi' }, { role:'bot', text:'hey, wassup?' },
    { role:'user', text:'cool' }, { role:'bot', text:'nhaimi' }
  ];
  ok('AI reply identical to a recent reply is caught', dupBotCheck(hist, 'Hey, wassup?') === true);
  ok('fresh AI reply passes', dupBotCheck(hist, 'ndipei mweya') === false);
  ok('only last 3 bot replies checked (old replies forgotten)', dupBotCheck([
    { role:'bot', text:'very old line' }, { role:'bot', text:'a' }, { role:'bot', text:'b' }, { role:'bot', text:'c' }
  ], 'very old line') === false);
}

/* ═══ 5. 5-LAST-MESSAGE REPLIES ═══ */
section('5. 5-LAST-MESSAGE REPLY CONTEXT');
{
  const size = (src.match(/const USER_HISTORY_SIZE\s*=\s*(\d+)/) || [])[1];
  ok('USER_HISTORY_SIZE = 5 (per spec)', size === '5', 'got ' + size);
  /* poolDm — pools every text the user sends while waiting for the AI cycle */
  eval('const dmPool = new Map();\n' + grab('function poolDm', 'function pruneDmPool') +
       '\n;__g.poolDm = poolDm; __g.dmPool = dmPool;');
  const JID = '263772000009@s.whatsapp.net';
  __g.poolDm(JID, { key:{id:'m1'} }, 'hey', 'Tino', '263772000009');
  __g.poolDm(JID, { key:{id:'m2'} }, 'are you there', 'Tino', '263772000009');
  __g.poolDm(JID, { key:{id:'m3'} }, 'i need help with maths', 'Tino', '263772000009');
  __g.poolDm(JID, { key:{id:'m4'} }, 'its urgent', 'Tino', '263772000009');
  const e = __g.dmPool.get(JID);
  ok('all 4 rapid DMs pooled into ONE context entry', e && e.messages.length === 4, 'pool=' + e.messages.length);
  ok('pool keeps the latest text as the reply target', e.text === 'its urgent');
  ok('pool cap 10 (older dropped, never unbounded)', (function(){
    for (let i = 0; i < 9; i++) __g.poolDm(JID, { key:{id:'x'+i} }, 'msg ' + i, 'Tino');
    return __g.dmPool.get(JID).messages.length === 10;
  })(), 'len=' + __g.dmPool.get(JID).messages.length);
  /* the prompt builder — REAL sliced code from processDM */
  const chunk = grab('const hist = userHistories.get(senderJid)', "This is a NEW reply.';");
  const buildCtx = eval(
    '(function(userHistories, senderJid, USER_HISTORY_SIZE, item, text){\n' +
    chunk + "This is a NEW reply.';\nreturn { fullPrompt, transcript, pooled };\n})"
  );
  const userHistories = new Map();
  const hist = [];
  for (let i = 1; i <= 7; i++){
    hist.push({ role:'user', text:'u' + i, ts:0 });
    hist.push({ role:'bot',  text:'b' + i, ts:0 });
  }   // 14 turns stored, only last 5+5 may be used
  userHistories.set('sender1', hist);
  const item = { messages: [
    { text:'first msg' }, { text:'second msg' }, { text:'third msg' },
    { text:'fourth msg' }, { text:'fifth msg' }, { text:'sixth msg' },
    { text:'seventh msg' }, { text:'eighth msg' }
  ]};
  const r = buildCtx(userHistories, 'sender1', 5, item, 'eighth msg');
  const tl = r.transcript ? r.transcript.split('\n') : [];
  ok('history trimmed to last 5 turns per side (10 lines)', tl.length === 10, 'lines=' + tl.length);
  ok('oldest turns dropped (starts at turn 3, not turn 1)', tl[0] === 'Them: u3', 'starts: ' + JSON.stringify(tl[0]));
  ok('newest turn is the last line', tl[9] === 'Abby: b7');
  const pl = r.pooled ? r.pooled.split('\n') : [];
  ok('rapid-fire pool: last 6 messages included, latest last', pl.length === 6 && /eighth msg/.test(pl[5]),
     'lines=' + pl.length);
  ok('prompt ends with explicit NEW-reply instruction', /Reply to the LATEST message as Abby\. This is a NEW reply\.$/.test(r.fullPrompt));
  ok('no history → plain text prompt (no crash)', (function(){
    const x = buildCtx(new Map(), 'unknown', 5, { messages: [] }, 'just text');
    return x.fullPrompt === 'just text' && !x.transcript && !x.pooled;
  })());
  /* history cap after reply */
  const trimLine = (src.match(/while \(hist\.length > USER_HISTORY_SIZE \* 2\) hist\.shift\(\);/) || [])[0];
  const trim = eval('(function(hist, USER_HISTORY_SIZE){ ' + trimLine + ' return hist.length; })');
  ok('stored history capped at 10 entries (5 user + 5 bot)', trim(new Array(14).fill({ role:'x' }), 5) === 10);
  /* pending request only carries the last 5 */
  ok('pending request carries history.slice(-5)', /userHistory: history\.slice\(-USER_HISTORY_SIZE\)/.test(src));
}

/* ═══ 6. SCHOOL ACCOUNT — admin-DM-ONLY strict gate ═══ */
section('6. SCHOOL ACCOUNT = ADMIN DM ONLY');
{
  const hsm = grab('async function handleSchoolMessage', 'async function connectSchoolBot');
  const gateLine = (hsm.match(/if \(SCHOOL_STRICT_ADMIN[^\n]*/) || [])[0];
  /* real line ends with "return;" = message ignored. Translate to a sentinel. */
  const gate = eval('(function(SCHOOL_STRICT_ADMIN, isGroup, isAdmin){ ' +
    (gateLine||'').trim().replace(/return\s*;\s*$/, "return 'IGNORED';") + " return 'HANDLED'; })");
  ok('strict gate is the real shipped line', !!gateLine, (gateLine||'').trim());
  ok('school GROUP message → ignored (read-only monitor)', gate(true, true, false) === 'IGNORED');
  ok('school DM from NON-admin → ignored completely', gate(true, false, false) === 'IGNORED');
  ok('school DM from ADMIN → handled', gate(true, false, true) !== 'IGNORED');
  ok('gate can be disabled by env (SCHOOL_STRICT_ADMIN=false)', gate(false, false, false) !== 'IGNORED');
  /* order of the pipeline — docs → groups read-only → admin DM → ignore */
  const iBtn   = hsm.indexOf('extractButtonCommand(m)');
  const iDoc   = hsm.indexOf('handleIncomingDocument(msg, m, chatJid, senderJid, isGroup, isAdmin, \'school\')');
  const iGroup = hsm.indexOf('strictly read-only in groups');
  const iAdmin = hsm.indexOf('handleSchoolAdminCommand(text, chatJid, msg)');
  const iNope  = hsm.indexOf('Non-admin DM ignored (school answers admin only)');
  ok('pipeline order: buttons → documents → groups(read-only) → admin DM → ignore others',
     iBtn > 0 && iBtn < iDoc && iDoc < iGroup && iGroup < iAdmin && iAdmin < iNope,
     [iBtn,iDoc,iGroup,iAdmin,iNope].join(' < '));
  ok('group texts never replied to (silent return)', /return;[\s\S]{0,120}?\/\/ strictly read-only in groups/.test(hsm));
  ok('non-admin DM: log-only, no reply path', /Non-admin DM ignored \(school answers admin only\)/.test(hsm));
  ok('SCHOOL_STRICT_ADMIN defaults ON', /const SCHOOL_STRICT_ADMIN = \(process\.env\.SCHOOL_STRICT_ADMIN \|\| 'true'\) === 'true';/.test(src));
  ok('school account answers via handleSchoolAdminCommand (own socket replyFn)',
     /async function handleSchoolAdminCommand\(text, chatJid, msg\)/.test(src));
}

/* ═══ 7. NEEDED-UPDATES FILTER (study buddy side-channel) ═══ */
section('7. GROUP UPDATES — only what admin needs');
{
  const kw = grab('const UPDATE_KEYWORDS = [', '];');
  eval(kw + '];\n' + grab('function isNeededUpdate', 'function queueNeededUpdate') +
       '\nconst schoolUpdatesBus = [];\nconst UPDATES_MAX = 40;\n' +
       grab('function queueNeededUpdate', '/* On-demand flush') +
       '\nfunction resetDailyStats(){}\nconst dailyStats = {};\n' +
       ';__g.isNeededUpdate = isNeededUpdate; __g.queueNeededUpdate = queueNeededUpdate; __g.bus = schoolUpdatesBus;');
  const N = global.__g.isNeededUpdate;
  ok('"test 2 moved to monday" is a needed update', N('Test 2 moved to monday') === true);
  ok('"lecture cancelled today" is a needed update', N('Lecture cancelled today') === true);
  ok('"assignment due friday" is a needed update', N('Assignment due friday') === true);
  ok('"exam timetable is out" is a needed update', N('Exam timetable is out') === true);
  ok('casual group chatter is NOT queued', N('lol that was funny') === false);
  ok('too-short texts skipped', N('due') === false);
  global.__g.queueNeededUpdate('BSC 2.1 Botany', 'Test 2 moved to monday');
  global.__g.queueNeededUpdate('BSC 2.1 Zoology', 'Lecture cancelled today');
  ok('queued updates land in the admin bus (never posted to groups)',
     global.__g.bus.length === 2 && global.__g.bus[0].group === 'BSC 2.1 Botany');
  ok('flush target is ADMIN_JID only', /await sendBuffer\(ADMIN_JID, \{ text: text\.slice\(0, 3000\) \}/.test(src));
}

/* ═══ 8. ADMIN TASK SCHEDULER (v68.2) ═══ */
section('8. TASK SCHEDULER — "send 5 chess videos to this group by 5"');
{
  const T = grab('const TASKS_FILE', 'const TASK_NOUNS');           // consts + load/save + parseDeadline
  const P = grab('const TASK_NOUNS', '/* "this group" / "main group"'); // TASK_NOUNS + parseTaskRequest
  eval(T + '\n' + P + '\n;__g.parseTaskRequest = parseTaskRequest; __g.parseDeadline = parseDeadline;');
  const PT = global.__g.parseTaskRequest;
  const PD = global.__g.parseDeadline;

  const r1 = PT('send 5 chess videos to this group by 5');
  ok('"send 5 chess videos to this group by 5" parsed', r1 && r1.count === 5 && r1.kind === 'video' && r1.query === 'chess' && r1.targetSpec === 'this group',
     JSON.stringify(r1));
  const d1 = new Date(r1.deadline);
  ok('"by 5" means 5pm (Zim speak)', d1.getHours() === 17 && d1.getMinutes() === 0,
     '→ ' + d1.getHours() + ':' + String(d1.getMinutes()).padStart(2,'0'));

  const r2 = PT('send winky d songs to main group');
  ok('"send winky d songs to main group" → default 3 songs', r2 && r2.count === 3 && r2.kind === 'music' && r2.query === 'winky d' && r2.deadline === 0,
     JSON.stringify(r2));

  const r3 = PT('send videos of chess into the chess club by 5pm');
  ok('"send videos of chess into the chess club by 5pm" (of-form)', r3 && r3.kind === 'video' && r3.query === 'chess' && r3.targetSpec === 'the chess club',
     JSON.stringify(r3));

  const r4 = PT('send 20 memes pics to zim memes tonight');
  ok('count capped at 20', r4 && r4.count === 20 && r4.kind === 'image', 'count=' + (r4 && r4.count));
  const r5 = PT('send 30 memes pics to zim memes');
  ok('count 30 → capped 20', r5 && r5.count === 20);
  const r6 = PT('send 2 gifs of cats to funny group in 2 hours');
  ok('"in 2 hours" deadline parsed', r6 && r6.kind === 'gif' && r6.deadline > Date.now() + 110 * 60000);

  ok('bad time returns badTime (admin gets help)', (function(){
    const b = PT('send 2 videos to X by banana');
    return b && b.badTime === 'banana';
  })());
  ok('"send me a song by Winky D" is NOT a task (DM music intent owns it)', PT('send me a song by winky d') === null);
  ok('chat text is NOT a task', PT('hey did you see the match last night it was crazy') === null);

  ok('parseDeadline "17:30" → 17:30', (function(){ const d = new Date(PD('17:30')); return d.getHours() === 17 && d.getMinutes() === 30; })());
  ok('parseDeadline "in 30 min" → +30min±', (function(){ const t = PD('in 30 min'); return Math.abs(t - (Date.now() + 30*60000)) < 5000; })());
  ok('parseDeadline "tonight" → 21:00', (function(){ const d = new Date(PD('tonight')); return d.getHours() === 21; })());
  ok('parseDeadline "now" → ≥3 min from now', PD('now') >= Date.now() + 3*60000 - 1000);
  ok('parseDeadline "banana" → 0 (unparsed)', PD('banana') === 0);
}

/* ═══ 9. FOCUSED DM — interactivity gate (v68.2) ═══ */
section('9. FOCUSED DM — only interactive people');
{
  const fresh = (src.match(/const DM_FRESH_MS\s*=\s*([^;]+);/) || [])[1];
  eval('const userHistories = new Map();\nconst DM_FRESH_MS = ' + fresh + ';\n' +
       grab('function dmIsInteractive', 'async function runDmAiBatch') +
       '\n;__g.dmIsInteractive = dmIsInteractive; __g.userHistories = userHistories;');
  const I = global.__g.dmIsInteractive;
  const UH = global.__g.userHistories;
  ok('config: batch 1-4 per cycle, 20-45s human gaps',
     /const DM_BATCH_MIN\s*=\s*1;/.test(src) && /const DM_BATCH_MAX\s*=\s*4;/.test(src) &&
     /const DM_GAP_MIN_MS\s*=\s*20_000;/.test(src) && /const DM_GAP_MAX_MS\s*=\s*45_000;/.test(src));
  ok('2+ queued texts = interactive', I('a', { text:'x', ts: Date.now() - 40*60000, messages:[{},{ }] }) === true);
  ok('single text, 3 min old (online now) = interactive', I('b', { text:'x', ts: Date.now() - 3*60000, messages:[{}] }) === true);
  ok('single text, 2 h old, no history = QUIET (waits)', I('c', { text:'x', ts: Date.now() - 2*3600000, messages:[{}] }) === false);
  ok('quick reply after bot\'s message (20 min ago) = interactive', (function(){
    UH.set('d', [{ role:'bot', text:'hey', ts: Date.now() - 40*60000 }, { role:'user', text:'yo', ts: Date.now() - 20*60000 }]);
    return I('d', { text:'again', ts: Date.now() - 19*60000, messages:[{}] }) === true;
  })());
  ok('old user message in history (2 h) does NOT count', (function(){
    UH.set('e', [{ role:'bot', text:'hey', ts: Date.now() - 3*3600000 }, { role:'user', text:'yo', ts: Date.now() - 2*3600000 }]);
    return I('e', { text:'x', ts: Date.now() - 2*3600000, messages:[{}] }) === false;
  })());
  ok('sends between chats are human-paced (20-45s sleep)', /DM_GAP_MIN_MS \+ Math\.random\(\) \* \(DM_GAP_MAX_MS - DM_GAP_MIN_MS\)/.test(src));
  ok('quiet messages are logged, not replied', /quiet \(waiting for engagement\)/.test(src));
}

/* ═══ SUMMARY ═══ */
console.log('\n' + '═'.repeat(62));
console.log('  FULL COMPONENT TEST: ' + pass + ' passed, ' + fail + ' failed  (' + (pass + fail) + ' total)');
console.log('═'.repeat(62));
process.exit(fail ? 1 : 0);
