#!/usr/bin/env node
'use strict';
/* boot_test.js — v68.3 boot check.
 * Starts the REAL server with LOADTEST=1 (stub sockets, no WhatsApp),
 * then verifies: /health, /admin panel HTML (split streams, v68.3,
 * logged-out CSS), /admin/stats JSON, /loadtest/stats. */
const { spawn } = require('child_process');
const path = require('path');

const PORT = 19911;
const BASE = 'http://127.0.0.1:' + PORT;
let pass = 0, fail = 0;
function ok(name, cond, extra){
  if (cond){ pass++; console.log('  ✅ ' + name + (extra ? '  → ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

(async function main(){
  console.log('\n=== v68.3 BOOT TEST (LOADTEST=1) ===\n');
  const child = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, LOADTEST: '1', PORT: String(PORT), ADMIN_LOG_DIGEST_MIN: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = '';
  child.stdout.on('data', d => logs += d.toString());
  child.stderr.on('data', d => logs += d.toString());
  let exited = null;
  child.on('exit', (c) => { exited = c; });

  let up = false;
  for (let i = 0; i < 60; i++){
    if (exited !== null) break;
    await sleep(500);
    try { const h = await (await fetch(BASE + '/health')).json(); if (h && h.ok){ up = true; break; } } catch(e){}
  }
  ok('server boots and /health responds', up && exited === null);
  if (!up){ console.log(logs.slice(-3000)); child.kill('SIGKILL'); process.exit(1); }

  const health = await (await fetch(BASE + '/health')).json();
  ok('health: ok=true', health.ok === true);
  ok('health: school stub present', !!health.school);

  const stats = await (await fetch(BASE + '/admin/stats')).json();
  ok('stats: status field present', typeof stats.status === 'string', stats.status);
  ok('stats: mode is MANAGER (loadtest stub)', (stats.mode || '').toUpperCase() === 'MANAGER');
  ok('stats: dailyStats present', !!stats.dailyStats);
  ok('stats: policy block present', !!stats.policy);

  const html = await (await fetch(BASE + '/admin')).text();
  ok('panel: title BreadBot v68.6', html.includes('<title>BreadBot v68.6</title>'));
  ok('panel: four split streams present',
     ['msgsG','msgsS','logsG','logsS'].every(id => html.includes('id="' + id + '"')));
  ok('panel: old single streams gone', !html.includes('id="msgs"') && !html.includes('id="logs"'));
  ok('panel: school log router present', html.includes('function isSchoolLog'));
  ok('panel: logged-out CSS present', html.includes('.s-logged-out'));
  ok('panel: main-group alert banner present', html.includes('noMain'));

  const qr = await (await fetch(BASE + '/admin/qr-data')).json();
  ok('qr-data endpoint responds (status field)', typeof qr.status === 'string', qr.status);

  /* LOADTEST smoke: inject 10 msg/s for 2s and watch counters move */
  const inj = await (await fetch(BASE + '/loadtest/inject', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ratePerSec: 10, seconds: 2, dmRatio: 0.5 })
  })).json();
  ok('loadtest inject accepted', inj.ok === true && inj.total === 20, JSON.stringify(inj));
  await sleep(14000);
  const lt = await (await fetch(BASE + '/loadtest/stats')).json();
  ok('loadtest: messages flowed through the pipeline', lt.handled > 0, 'handled=' + lt.handled);
  ok('loadtest: inject done', lt.injected === 20, 'injected=' + lt.injected);

  child.kill('SIGKILL');
  console.log('\n' + '═'.repeat(50));
  console.log(`  BOOT TEST: ${pass} passed, ${fail} failed`);
  console.log('═'.repeat(50));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('BOOT TEST CRASH:', e.message); process.exit(1); });
