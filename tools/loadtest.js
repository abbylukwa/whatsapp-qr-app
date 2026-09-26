#!/usr/bin/env node
'use strict';
/* loadtest.js — drives BreadBot v67 through the 500 msg/s pipeline test.
 * Starts the real server with LOADTEST=1 (stub socket, real handler
 * pipeline), injects messages, samples /loadtest/stats, prints a report.
 *
 * Usage: node loadtest.js [ratePerSec] [seconds] [floodThreshold]
 */

const { spawn } = require('child_process');
const path = require('path');

const RATE = parseInt(process.argv[2] || '500', 10);
const SECS = parseInt(process.argv[3] || '30', 10);
const FLOOD = parseInt(process.argv[4] || '300', 10); // 300 = default gate; 2000 = full processing
const PORT = 19910;
const BASE = 'http://127.0.0.1:' + PORT;

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
async function jget(p){ const r = await fetch(BASE + p); return r.json(); }
async function jpost(p, body){
  const r = await fetch(BASE + p, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body||{}) });
  return { status: r.status, data: await r.json().catch(()=>({})) };
}

async function main(){
  console.log(`\n=== BreadBot v68.3 load test: ${RATE} msg/s x ${SECS}s, FLOOD_THRESHOLD=${FLOOD} ===\n`);
  const child = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, LOADTEST:'1', PORT:String(PORT), FLOOD_THRESHOLD:String(FLOOD),
           JOIN_QUEUE_MAX:'60', ADMIN_LOG_DIGEST_MIN:'1' },
    stdio: ['ignore','pipe','pipe']
  });
  let serverLog = [];
  child.stdout.on('data', d => serverLog.push(d.toString()));
  child.stderr.on('data', d => serverLog.push(d.toString()));
  child.on('exit', (c,s) => { if (c !== null) console.log('[server exited early code=' + c + ']'); });

  // wait for boot
  let up = false;
  for (let i=0;i<60;i++){
    await sleep(500);
    try { const h = await jget('/health'); if (h && h.ok){ up = true; break; } } catch(e){}
  }
  if (!up){ console.log('SERVER FAILED TO BOOT'); console.log(serverLog.join('')); child.kill('SIGKILL'); process.exit(1); }
  const health = await jget('/health');
  console.log('boot ok — status:', health.status, '| school:', JSON.stringify(health.school));

  const samples = [];
  const sampler = setInterval(async function(){
    try { const s = await jget('/loadtest/stats'); samples.push(s); } catch(e){}
  }, 2000);

  const t0 = Date.now();
  const inj = await jpost('/loadtest/inject', { ratePerSec: RATE, seconds: SECS, dmRatio: 0.3 });
  console.log('inject:', JSON.stringify(inj.data));

  // wait for injection window + drain
  await sleep((SECS + 12) * 1000);
  clearInterval(sampler);

  const final = await jget('/loadtest/stats').catch(()=>null);
  const peak = {
    queueFast: Math.max(...samples.map(s => (s.queue && s.queue.fast ? s.queue.fast.queued : 0) || 0), 0),
    queueSlow: Math.max(...samples.map(s => (s.queue && s.queue.slow ? s.queue.slow.queued : 0) || 0), 0),
    lagP95: Math.max(...samples.map(s => (s.eventLoop ? s.eventLoop.p95Ms : 0) || 0), 0),
    lagMax: Math.max(...samples.map(s => (s.eventLoop ? s.eventLoop.maxMs : 0) || 0), 0),
    rssMax: Math.max(...samples.map(s => (s.memory ? s.memory.rssMB : 0) || 0), 0)
  };
  const wall = ((Date.now() - t0) / 1000).toFixed(1);
  const alive = await jget('/health').then(()=>true).catch(()=>false);

  console.log('\n──── RESULTS ────');
  console.log('injected        :', final && final.injected);
  console.log('handled         :', final && final.handled);
  console.log('dropped flood   :', final && final.droppedFlood, '(flood gate', (final&&final.floodThreshold) + '/s)');
  console.log('dropped dup     :', final && final.droppedDup);
  console.log('dropped other   :', final && final.droppedOther);
  console.log('sends queued    :', final && final.sendsQueued);
  console.log('sends done      :', final && final.sendsDone, '| failed:', final && final.sendsFailed);
  console.log('queue peak fast :', peak.queueFast, '| slow:', peak.queueSlow);
  console.log('event-loop p95  :', peak.lagP95.toFixed(1) + 'ms | max:', peak.lagMax.toFixed(1) + 'ms');
  console.log('RSS peak        :', peak.rssMax + 'MB');
  console.log('server alive    :', alive ? 'YES — no crash' : 'NO — CRASHED');
  console.log('wall time       :', wall + 's');
  const throughput = final && final.injected ? ((final.handled / (final.injected || 1)) * 100).toFixed(1) : '0';
  console.log('processing rate : ' + throughput + '% of injected messages passed the pipeline');

  console.log('\n──── SERVER LOG TAIL ────');
  console.log(serverLog.join('').split('\n').slice(-15).join('\n'));

  child.kill('SIGKILL');
  const fs = require('fs');
  const out = { rate: RATE, seconds: SECS, floodThreshold: FLOOD,
    final, peak, alive, wallSec: wall, ts: new Date().toISOString() };
  const name = `/home/z/my-project/scripts/loadtest_${RATE}x${SECS}_flood${FLOOD}.json`;
  fs.writeFileSync(name, JSON.stringify(out, null, 2));
  console.log('saved:', name);
  process.exit(alive ? 0 : 2);
}

main().catch(e => { console.error('loadtest failed:', e); process.exit(1); });
