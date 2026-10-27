#!/usr/bin/env node
'use strict';
/* ═══════════════════════════════════════════════════════════════════
 *  BreadBot v84.5.3 — POP-OUT LOGIN WINDOW  (one-time CAPTCHA killer)
 *
 *  Opens a REAL visible Chrome window per platform. YOU log in by
 *  hand — password, CAPTCHA, 2FA, whatever it asks (a human wins
 *  those every time). The moment the session cookie appears, ALL the
 *  window's cookies are saved to data/<platform>/cookies.json — the
 *  same file the bot auto-loads on every boot. From then on: logged
 *  in, no CAPTCHA, forever.
 *
 *  RUN THIS ON YOUR OWN PC (a cloud server has no screen):
 *      node login-window.js                  → all four, one by one
 *      node login-window.js twitter          → just X
 *      node login-window.js twitter youtube  → a list
 *
 *  Afterwards, if the bot runs on Render: copy the saved files into
 *  the same paths on the server (or paste them in the panel 🍪 card):
 *      data/<platform>/cookies.json
 * ═══════════════════════════════════════════════════════════════════ */

const path = require('path');
const fs = require('fs');

/* load env — same convention as server.js: .env first, else legacy `env` */
(function loadEnv(){
  try {
    const envPath = fs.existsSync(path.join(__dirname, '.env'))
      ? path.join(__dirname, '.env')
      : path.join(__dirname, 'env');
    if (fs.existsSync(envPath)) require('dotenv').config({ path: envPath });
  } catch (e) { /* optional */ }
})();

const { headfulLogin, HEADFUL_FLOWS } = require('./core/headful-login');

(async function main() {
  const args = process.argv.slice(2).map(s => String(s).toLowerCase().trim()).filter(Boolean);
  const bad = args.filter(a => !HEADFUL_FLOWS[a]);
  if (bad.length) {
    console.log('✗ unknown platform: ' + bad.join(', ') + '\n  use one of: ' + Object.keys(HEADFUL_FLOWS).join(', '));
    process.exit(1);
  }
  const queue = args.length ? args : Object.keys(HEADFUL_FLOWS);

  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  BreadBot POP-OUT LOGIN — ' + queue.join(' · '));
  console.log('║  A real Chrome window opens per platform.');
  console.log('║  Log in BY HAND in that window (CAPTCHA included).');
  console.log('║  The moment the session cookie appears → cookies are');
  console.log('║  saved → the bot is logged in from then on.');
  console.log('╚══════════════════════════════════════════════════════╝');

  const results = {};
  for (const p of queue) {
    const r = await headfulLogin(p, { timeoutMs: 8 * 60 * 1000, log: (lvl, tag, msg) => console.log('   [' + lvl + '] ' + msg) });
    results[p] = r;
  }

  console.log('\n════ SUMMARY ════');
  const saved = [];
  for (const p of queue) {
    const r = results[p] || {};
    if (r.ok) { saved.push(p); console.log('✅ ' + p + ' — logged in, cookies → ' + r.file); }
    else console.log('✗ ' + p + ' — ' + (r.error || 'not completed'));
  }
  if (saved.length) {
    console.log('\nNext step: press 🔌 Connect in the panel (or just let the bot boot) —');
    console.log('it loads these cookies and continues logged in. No CAPTCHA again.');
    if (!process.env.RENDER) {
      console.log('\nDeploying to Render? Copy these into the service (same paths), or paste via the 🍪 card:');
      for (const p of saved) console.log('  data/' + p + '/cookies.json');
    }
  }
  process.exit(saved.length ? 0 : 1);
})();
