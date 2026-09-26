#!/usr/bin/env node
/* Extracts PANEL_HTML <script> content from server.js and parses it
 * as real JS — catches client-side syntax errors that node --check
 * cannot see (panel code lives inside a template literal). */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

const m = SRC.match(/PANEL_HTML\s*=\s*`([\s\S]*?)`;/);
if (!m){ console.error('❌ PANEL_HTML template literal not found'); process.exit(1); }
const html = m[1];

const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptMatch){ console.error('❌ <script> block not found in PANEL_HTML'); process.exit(1); }
const js = scriptMatch[1];

/* Parse-only: new Script() compiles without running (no DOM needed). */
try {
  new vm.Script(js, { filename: 'panel-inline.js' });
  console.log('✅ PANEL_HTML inline JS parses cleanly (' + js.split('\n').length + ' lines)');
} catch (e) {
  console.error('❌ PANEL_HTML inline JS SYNTAX ERROR: ' + e.message);
  /* show the offending line */
  const lines = js.split('\n');
  const ln = (e.stack.match(/panel-inline\.js:(\d+)/) || [])[1];
  if (ln) console.error('   line ' + ln + ': ' + (lines[ln-1] || '').slice(0, 160));
  process.exit(1);
}

/* sanity: key panel ids referenced by runScraperTest exist in the HTML */
for (const id of ['scQuery', 'scBtn', 'scResult', 'aiList', 'dot', 'st']) {
  if (!html.includes('id="' + id + '"')) { console.error('❌ panel missing #' + id); process.exit(1); }
}
console.log('✅ panel ids present (scQuery, scBtn, scResult, aiList, dot, st)');

/* sanity: endpoint handlers wired in server */
for (const needle of ["app.post('/admin/scraper-test'", "scraperSearch(query, false)", "scraperDownloadMedia(s.images[0], 'image')"]) {
  if (!SRC.includes(needle)) { console.error('❌ server missing: ' + needle); process.exit(1); }
}
console.log('✅ /admin/scraper-test endpoint wired (search → download → JSON verdict)');
