'use strict';
/* Unit-test parseCasualAdmin by extracting it + CASUAL_ALIASES from server.js */
const fs = require('fs');
const src = fs.readFileSync('/home/z/my-project/repo-whatsapp-qr-app/server.js', 'utf8');
const start = src.indexOf('const CASUAL_ALIASES');
const end = src.indexOf('async function handleAdminCommand');
if (start < 0 || end < 0 || end <= start){ console.log('EXTRACT FAIL'); process.exit(1); }
const chunk = src.slice(start, end);
eval(chunk + '\n;global.__f = parseCasualAdmin;');
var parseCasualAdmin = global.__f;

const cases = [
  ['status', '!status'],
  ['how are you', '!status'],
  ['help', '!help'],
  ['weather bindura', '!weather bindura'],
  ['weather', '!weather'],
  ['broadcast big sale tomorrow', '!broadcast big sale tomorrow'],
  ['ad AirPods | brand new, $40', '!ad AirPods | brand new, $40'],
  ['adsend', '!bcad'],
  ['pause', '!pause'],
  ['resume', '!resume'],
  ['groups', '!groups'],
  ['force FINAL call now', '!force FINAL call now'],
  ['you there', '!ping'],
  ['who are you', '!whoami'],
  ['!status', '!status'],                     // explicit passthrough
  ['hey did you see the game last night it was crazy long message that keeps going and going beyond the normal command length so it should be chat', null],
  ['multi\nline text', null]
];
let pass = 0, fail = 0;
for (const [input, expected] of cases){
  const got = parseCasualAdmin(input);
  const ok = got === expected;
  if (ok) pass++; else fail++;
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + JSON.stringify(input.slice(0,50)) + ' → ' + JSON.stringify(got) + (ok ? '' : ' (expected ' + JSON.stringify(expected) + ')'));
}
console.log(`\n${pass}/${cases.length} passed`);
process.exit(fail ? 1 : 0);
