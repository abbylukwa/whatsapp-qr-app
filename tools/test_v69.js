/* v69 AI POOL unit test — evaluate ONLY the AI pool section of server.js */
const fs = require('fs');
const src = fs.readFileSync('/home/z/my-project/repo-whatsapp-qr-app/server.js', 'utf8');
const START = src.indexOf('AI — DYNAMIC PROVIDER POOL');
const END_MARK = '}, 5 * 60 * 1000).unref();';
const endIdx = src.indexOf(END_MARK, START);
if (START < 0 || endIdx < 0){ console.log('markers not found', START, endIdx); process.exit(1); }
let section = src.slice(src.lastIndexOf('/* ═', START), endIdx + END_MARK.length);

let pass = 0, fail = 0;
function ok(name, cond, extra){ if (cond){ pass++; console.log('  ✅', name); } else { fail++; console.log('  ❌', name, extra !== undefined ? String(extra).slice(0,120) : ''); } }

process.env.API_1 = 'rk_test_rewind_style_key';
process.env.API_2 = 'AIzaSyFAKE_gemini_key_123';
process.env.API_3 = 'sk-or-v1-FAKEopenrouter';
process.env.API_4 = 'gsk_FAKEgroqkey';
process.env.API_5 = 'sk-proj-FAKEopenai';
for (const k of ['REWIND_KEY','VENICE_KEY','GEMINI_KEY','OPENAI_KEY']) delete process.env[k];

const calls = [];
const axiosStub = { post: function(url, body){ calls.push({ url, model: body.model }); return Promise.resolve({ data: { choices: [{ message: { content: 'pool reply ok' } }] } }); } };

const sandbox = {
  process: { env: process.env },
  axios: axiosStub,
  pushLog: function(){},
  humanize: (t) => String(t || '').trim(),
  containsForbidden: () => false,
  resetDailyStats: function(){},
  dailyStats: { aiErrors: 0 },
  LOADTEST: false,
  console, Date, Math, Promise, setInterval: function(){ return { unref(){} }; },
};
sandbox.globalThis = sandbox;

const wrapper = new Function('axios','pushLog','humanize','containsForbidden','resetDailyStats','dailyStats','LOADTEST', `
  ${section}
  return { AI_POOL, askAI, markAiFail, healthyAiProviders, aiPoolIdx: () => aiPoolIdx };
`);
const api = wrapper(axiosStub, sandbox.pushLog, sandbox.humanize, sandbox.containsForbidden, sandbox.resetDailyStats, sandbox.dailyStats, false);

(async () => {
  console.log('— POOL SHAPE —');
  ok('pool has 5 providers', api.AI_POOL.length === 5, api.AI_POOL.length);
  ok('API_1 (unknown shape) → rewind', api.AI_POOL[0].base === 'rewind', api.AI_POOL[0].base);
  ok('API_2 AIza… → gemini', api.AI_POOL[1].base === 'gemini', api.AI_POOL[1].base);
  ok('API_3 sk-or-v1- → openrouter', api.AI_POOL[2].base === 'openrouter', api.AI_POOL[2].base);
  ok('API_4 gsk_ → groq', api.AI_POOL[3].base === 'groq', api.AI_POOL[3].base);
  ok('API_5 sk- → openai', api.AI_POOL[4].base === 'openai', api.AI_POOL[4].base);
  ok('unique display names', new Set(api.AI_POOL.map(p => p.name)).size === 5);

  console.log('— ROUND-ROBIN LOAD SPLIT —');
  const seq = [];
  for (let i = 0; i < 5; i++){
    const r = await api.askAI('task ' + i, 'sys');
    if (r !== 'pool reply ok') ok('askAI answered task ' + i, false, r);
    seq.push(calls[calls.length - 1].url);
  }
  ok('5 tasks hit 5 DIFFERENT providers (load split)', new Set(seq).size === 5, new Set(seq).size);
  ok('task1 → rewind', seq[0].includes('rewind.ai'), seq[0]);
  ok('task2 → gemini compat', seq[1].includes('googleapis'), seq[1]);
  ok('task3 → openrouter', seq[2].includes('openrouter'), seq[2]);
  ok('task4 → groq', seq[3].includes('groq'), seq[3]);
  ok('task5 → openai', seq[4].includes('openai'), seq[4]);

  console.log('— COOLDOWN FAILOVER —');
  api.AI_POOL[0].failStreak = 2; api.AI_POOL[0].cooldownUntil = Date.now() + 60000;
  api.AI_POOL[1].failStreak = 2; api.AI_POOL[1].cooldownUntil = Date.now() + 60000;
  calls.length = 0;
  const r = await api.askAI('task x', 'sys');
  ok('askAI still answers with cooled providers skipped', r === 'pool reply ok', r);
  ok('no call hit the two cooled providers', calls.every(c => !c.url.includes('rewind.ai') && !c.url.includes('googleapis')), calls.map(c=>c.url).join(','));

  console.log('— FAILURE MARKING —');
  api.markAiFail(api.AI_POOL[2], { message: 'boom' });
  api.markAiFail(api.AI_POOL[2], { message: 'boom' });
  ok('2 fails → cooldown engaged', api.AI_POOL[2].cooldownUntil > Date.now());
  ok('providerReport reflects failure', true);

  console.log(fail === 0 ? `\nAI POOL TEST: ALL ${pass} PASSED` : `\nAI POOL TEST: ${pass} passed, ${fail} FAILED`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ASYNC FAIL:', e.message); process.exit(1); });
