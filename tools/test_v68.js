'use strict';
/* ══════════════════════════════════════════════════════════════
 *  v68 UNIT TESTS — every new component, against the REAL shipped
 *  code (functions are sliced out of server.js and eval'd).
 *  Run: node tools/test_v68.js
 * ══════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

let pass = 0, fail = 0;
global.__g = {};   // eval sink — must exist before the first eval
function ok(name, cond, extra){
  if (cond){ pass++; console.log('  ✅ ' + name + (extra ? '  → ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}
function section(t){ console.log('\n── ' + t + ' ' + '─'.repeat(Math.max(0, 58 - t.length))); }

/* helper: slice a function/const block out of server.js source */
function grab(startMarker, endMarker){
  const s = src.indexOf(startMarker);
  const e = src.indexOf(endMarker, s);
  if (s < 0 || e < 0) throw new Error('grab failed: ' + startMarker);
  return src.slice(s, e);
}

/* ═══ 1. casual command parser (no-"!" natural language) ═══ */
section('1. CASUAL COMMAND PARSER (no ! prefix)');
{
  const chunk = grab('const CASUAL_ALIASES', 'async function handleAdminCommand');
  eval(chunk + '\n;__g.parseCasualAdmin = parseCasualAdmin;');
  const P = global.__g.parseCasualAdmin;
  const cases = [
    ['menu',                    '!menu'],
    ['buttons',                 '!menu'],
    ['what should i study',     '!study'],
    ['study plan osmosis',      '!study osmosis'],
    ['study data structures',   '!study data structures'],
    ['make me a pdf about osmosis', '!pdf about osmosis'],
    ['pdf',                     '!pdf'],
    ['deadlines',               '!deadlines'],
    ['my deadlines',            '!deadlines'],
    ['docs',                    '!docs'],
    ['updates',                 '!updates'],
    ['weather bindura',         '!weather bindura'],
    ['status',                  '!status'],
    ['!study hashing',          '!study hashing'],          // explicit passthrough
    ['hey did you see the game last night it was crazy long message that keeps going and going beyond the normal command length so it should be chat', null],
    ['multi\nline text',        null]
  ];
  for (const [inp, want] of cases){
    let got = null; try { got = P(inp); } catch(e){ got = 'THREW:' + e.message; }
    ok(JSON.stringify(inp.slice(0,32)), got === want, 'got ' + JSON.stringify(got));
  }
}

/* ═══ 2. button tap extraction (both WhatsApp formats) ═══ */
section('2. BUTTON TAP EXTRACTION');
{
  const chunk = grab('function extractButtonCommand', 'async function routeButton');
  eval(chunk + '\n;__g.extractButtonCommand = extractButtonCommand;');
  const E = global.__g.extractButtonCommand;
  const legacy = { buttonsResponseMessage: { selectedButtonId: 'cmd:today', selectedDisplayText: '📅 Today' } };
  const native = { interactiveResponseMessage: { nativeFlowResponseMessage: { paramsJson: '{"display_text":"Study","id":"menu:study","index":0}' } } };
  const none   = { conversation: 'hello' };
  ok('legacy buttonsResponseMessage', E(legacy).id === 'cmd:today', JSON.stringify(E(legacy)));
  ok('native interactiveResponseMessage', E(native).id === 'menu:study', JSON.stringify(E(native)));
  ok('non-button message → null', E(none) === null);
  ok('empty → null', E(null) === null, 'null-safe');
}

/* ═══ 3. needed-updates relevance filter ═══ */
section('3. NEEDED-UPDATES FILTER (only the ones you need)');
{
  const chunk = grab('const UPDATE_KEYWORDS', 'let MESSAGE_FLOOD_THRESHOLD') + '\n' +
                grab('function isNeededUpdate', 'function queueNeededUpdate');
  eval(chunk + '\n;__g.isNeededUpdate = isNeededUpdate;');
  const F = global.__g.isNeededUpdate;
  const yes = [
    'Assignment 2 is due Friday 5pm',
    'MID-SEMESTER TEST next week, bring IDs',
    'Lecture moved to Block C today',
    'The exam timetable is out',
    'Submission deadline extended by 2 days',
    'Class cancelled for today, sorry guys'
  ];
  const no = ['hey guys good morning', 'lol', 'someone selling textbooks?', 'anyone here'];
  for (const t of yes) ok('YES: ' + t.slice(0,38), F(t) === true);
  for (const t of no)  ok('NO:  ' + t.slice(0,38), F(t) === false);
  ok('empty string → false', F('') === false);
  ok('>1500 chars → false', F('a'.repeat(1600)) === false);
}

/* ═══ 4. assignment extraction from document text (heuristic) ═══ */
section('4. ASSIGNMENT EXTRACTION (doc text → deadline list)');
{
  const chunk = grab('function extractAssignmentsHeuristic', 'async function deliverDocDigestToAdmin');
  eval(chunk + '\n;__g.H = extractAssignmentsHeuristic;');
  const H = global.__g.H;
  const docText = [
    'CS201 DATA STRUCTURES - COURSE OUTLINE',
    'Assignment 1 is due 15/10/2026. Submit via Moodle.',
    'Group presentation: 22/10/2026 in Block A.',
    'Weekly quizzes every Thursday.',
    'Reading: Chapters 4 to 7.'
  ].join('\n');
  const found = H(docText);
  ok('found >= 2 items', found.length >= 2, JSON.stringify(found.map(f => f.title.slice(0, 40))));
  ok('item has due date', found.some(f => /^\d{4}-\d{2}-\d{2}$/.test(f.due)), found.map(f => f.due).join('|'));
  ok('no crash on empty', H('').length === 0);
}

/* ═══ 5. PDF CREATION → PDF READING roundtrip (the real functions) ═══ */
section('5. PDF ROUNDTRIP — makePdf() → readDocumentBuffer()');
(async () => {
  {
    /* makePdf is now ZERO-dependency (hand-rolled PDF writer) — no module
     * injection needed; readDocumentBuffer still needs pdf-parse/mammoth */
    global.pdfParse  = require('pdf-parse');
    global.mammoth   = require('mammoth');
    eval(grab('/* ── PDF CREATION — zero-dependency', '/* ── BUTTONS') + '\n;__g.makePdf = makePdf;');
    const makePdf = global.__g.makePdf;
    const body = '1. Arrays and linked lists.\n2. Stacks: LIFO behaviour.\n3. Queues: FIFO behaviour.\n4. Trees: binary search.\n5. Big-O: O(n log n) for mergesort.';
    const buf = await makePdf('Study Notes — Data Structures', body);
    ok('makePdf returns Buffer', Buffer.isBuffer(buf), Math.round(buf.length/1024) + 'KB');
    ok('PDF magic header', buf.slice(0,5).toString() === '%PDF-', buf.slice(0,8).toString());
    ok('no pdfkit anywhere in shipped code', !/require\('pdfkit'\)/.test(src));
    fs.writeFileSync('/tmp/v68_roundtrip.pdf', buf);

    // now READ it back through the shipped reader
    eval(grab('const DOC_OK_EXTS', 'async function handleIncomingDocument') + '\n;__g.readDocumentBuffer = readDocumentBuffer;');
    const readDocumentBuffer = global.__g.readDocumentBuffer;
    const r = await readDocumentBuffer(fs.readFileSync('/tmp/v68_roundtrip.pdf'), 'v68_roundtrip.pdf');
    ok('readDocumentBuffer ok', r.ok === true, r.error || '');
    ok('PDF text contains title', /Data Structures/.test(r.text), JSON.stringify(r.text.slice(0,60)));
    ok('PDF text contains body', /Stacks: LIFO/.test(r.text));
    ok('pages reported', r.pages >= 1, 'pages=' + r.pages);
  }

  /* ═══ 6. DOCX reading (mammoth, real fixture) ═══ */
  section('6. DOCX READING (mammoth → real .docx fixture)');
  {
    const readDocumentBuffer = global.__g.readDocumentBuffer;
    const fx = path.join(ROOT, 'tools/fixtures/sample_assignment.docx');
    const r = await readDocumentBuffer(fs.readFileSync(fx), 'sample_assignment.docx');
    ok('docx read ok', r.ok === true, r.error || '');
    ok('docx text has assignment line', /Assignment 1 is due/.test(r.text), JSON.stringify(r.text.slice(0,60)));
    ok('docx text has presentation line', /Group presentation/.test(r.text));
    const hh = global.__g.H || null;
    if (hh){
      const found = hh(r.text);
      ok('heuristic finds items in real docx text', found.length >= 2, found.length + ' items');
    }
  }

  /* ═══ 7. unsupported / hostile inputs ═══ */
  section('7. DOC EDGE CASES');
  {
    const readDocumentBuffer = global.__g.readDocumentBuffer;
    const old = await readDocumentBuffer(Buffer.from('OLEII'), 'notes.doc');
    ok('old .doc refused with guidance', !old.ok && /docx/.test(old.error), old.error);
    const txt = await readDocumentBuffer(Buffer.from('plain text notes'), 'notes.txt');
    ok('.txt read works', txt.ok && /plain text/.test(txt.text));
    const empty = await readDocumentBuffer(Buffer.from(''), 'empty.md');
    ok('empty file → empty text (caller rejects)', empty.ok && empty.text.trim() === '');
  }

  /* ═══ 8. MENUS integrity — every button id routes somewhere real ═══ */
  section('8. BUTTON MENUS INTEGRITY');
  {
    eval(grab('const MENUS', 'async function sendButtons') + '\n;__g.MENUS = MENUS;');
    const MENUS = global.__g.MENUS;
    const keys = Object.keys(MENUS);
    ok('5 menus defined', keys.length === 5, keys.join(','));
    for (const k of keys){
      const m = MENUS[k];
      ok('menu "' + k + '" 3-5 buttons', m.buttons.length >= 3 && m.buttons.length <= 5, m.buttons.length + ' buttons');
      ok('menu "' + k + '" ids valid format', m.buttons.every(b => /^(cmd|menu):[a-z]+$/.test(b.id)), m.buttons.map(b=>b.id).join(' '));
      ok('menu "' + k + '" labels non-empty', m.buttons.every(b => b.label && b.label.length >= 2));
    }
    // every cmd: target must exist in handleAdminCommand switch
    const cmdTargets = [...new Set(keys.flatMap(k => MENUS[k].buttons.map(b => b.id)).filter(id => id.startsWith('cmd:')).map(id => id.slice(4)))];
    const srcAll = src;
    const missing = cmdTargets.filter(c => !new RegExp("case '" + c + "'").test(srcAll));
    ok('all cmd: ids exist as commands', missing.length === 0, missing.length ? 'MISSING: ' + missing.join(',') : cmdTargets.join(','));
  }

  console.log('\n════════════════════════════════════');
  console.log('UNIT RESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST RUNNER ERROR:', e); process.exit(1); });

/* global eval sink */
global.__g = {};
