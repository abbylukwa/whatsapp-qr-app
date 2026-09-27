# BreadBot v71 — whatsapp-qr-app

## v71 — TEST-FREE COMPLETE BUILD

WHAT: the complete bot, exactly v70 inside — with ONE change: the
`tools/` test files are no longer part of the repository. The repo now
carries ONLY the files the app needs to run: server.js, package.json
(71.0.0), package-lock.json, render.yaml, build.sh, env, .env.example,
.gitignore, CHANGES.md, FILES.txt.

WHY: deploys pull from GitHub — tests are dev-time tooling, not runtime
files, and uploading 15 test files + a fixture on every change was noise
(the boss's live upload hit exactly this).

VERSION STRINGS: menu, self-test, boot banners and panel all say v71;
package.json is 71.0.0. No behaviour changed — every v70 fix is live
(session backup, MYLINKS-first on search AND gif, hotlink-safe
4-candidate downloads, boot watchdogs, AI off for the admin on BOTH
accounts, panel-only logs + 30-min janitor + Clear button, Abby persona
with never-meet/never-location rails).

TESTS: the full suite still exists in the dev workspace and stays the
release gate — 618 assertions ALL GREEN on this exact build (test_full
164, test_v70 99, test_v68 65, test_v687 55, test_v683 53, test_v685 43,
test_v686 43, test_v684 42, test_casual 17, test_v69 17, boot_test 20).
Version assertions were updated to v71.

---


## v70 — THE LIVE-AGAIN BUILD (your 5 reports → code locations → fixes)

### 1. "not requesting the files from my actual links — download 500"
WHERE: scraper `media.js → fetchWithUaFallback()` — it retried only
User-Agents and NEVER sent a Referer; pngtree's CloudFront CDN
(dygtyjqp7pi0m.cloudfront.net) hotlink-blocks every request without
`Referer: https://pngtree.com/`, so the scraper threw → HTTP 500.
Also WHERE (bot): `!st` + panel test downloaded ONLY `s.images[0]` —
one blocked CDN URL killed the whole delivery.
FIX: (a) media.js v2.5 attempt chain = honest bot UA → browser UA →
browser UA + mapped/derived Referer+Origin (+Accept), retries on
403/404/418/429, human error message instead of a bare 500.
(b) bot `scraperDownloadFirstWorking()` — tries up to 4 results and
delivers the first that works (used by !st and the panel test).

### 2. "school boot is stuck"
WHERE: `connectSchoolBot()` waited forever if the socket never fired
open/QR/close (a stale key file mixed with restored creds stalls Baileys
silently — no open, no QR, no close, no log).
FIX: (a) restoreSessionBlob() now WIPES the auth folder before writing
creds.json — no more stale-key mixes. (b) 90s BOOT WATCHDOGS on BOTH
accounts: no open/QR/close in 90s → clean auto-restart with a log line.
QR patience also raised 5 → 8 renewals.

### 3. "AI must not respond to the admin — it interferes with commands"
WHERE: `handleSchoolAdminCommand()` last line — EVERY non-command admin
DM went to `studyBuddyChat()` (AI auto-reply).
FIX: STUDY_BUDDY now defaults to FALSE. AI answers only on an explicit
`ask <question>` prefix (one-time hint tells you). Commands never
trigger AI. STUDY_BUDDY=true restores old always-on chat.

### 4. "no download logs on WhatsApp — panel only"
WHERE: `pushLog()` fed every error/warn — including scraper/download
errors — into the WhatsApp digest.
FIX: source 'scraper' is filtered from the WhatsApp digest (panel keeps
everything). Digest now rate-limits on failure too (a dead variable
`lastDigestAt` was silently wasted in the finally block).

### 5. "logs should be periodically cleared"
WHERE: buffers were size-capped but never time-cleared.
FIX: `startLogJanitor()` — every 30 min: panel logs trimmed to newest
200, live feed to newest 120, WhatsApp digest bus emptied, scraper /temp
self-cleanup. Logs live on the panel and clear themselves.

### Session backup — never re-scan after a deploy (v70 flagship)
Render's ephemeral disk wipes auth on every deploy (that is why the bot
kept ending at the QR card and "stopped receiving"). Panel card 💾
Session Backup exports each account's creds.json as a base64 blob →
paste once into env `SESSION_B64_GROUPS` / `SESSION_B64_SCHOOL` → every
future boot restores automatically. `POST /admin/session-restore` also
restores a pasted blob live (no redeploy).

### MY LINKS end-to-end (v70 + scraper v2.5)
`MYLINKS` env on the BOT is forwarded with every /search; scraper
merges file + env + per-request links, tries YOURS FIRST and puts their
results FIRST (bot downloads images[0] — previously your sites were
buried last). my_links.json is HOT-RELOADED (edit → next search, no
restart). `/my-links` shows per-slot diagnostics (count/error/ts).
Scraper /temp self-cleans every 30 min.

### Tests
tools/test_v70.js (64 assertions incl. a REAL session-blob round-trip:
dirty folder + stale keys → restore → stale keys wiped) + all 11 prior
suites green: boot 17 · full 164 · v68 65 · casual 17 · v683 53 ·
v684 42 · v685 43 · v686 43 · v687 55 · v69 17 · v70 64 = 536.

---

# BreadBot v69 — whatsapp-qr-app

## v69 — THE AUDIT BUILD (every logged failure traced to a line)

### Errors found in the live log (v68.7) and fixed
1. **Admin commands silently dropped in groups** — `handleMessage` gated admin
   commands to "DM + main group only"; during the NOT-SET window every
   `!menu / !test / !st` in Movies, Music died ("Cmd ignored in non-main
   group") and the bot sent nothing (panel proved it: DM 0, Typings 0,
   Recipients 0/20, Reads 8).
2. **School admin recognition broken in groups** — the school login IS the
   admin's number, so admin group messages arrive fromMe=true with
   participant = the school account's OWN LID, which was never in
   `adminLids`; the ADMIN tag vanished exactly there (log: same message
   showed `Howard ADMIN | 115110005706891` on groups, `Howard | 9325129007257`
   without the tag on school).
3. **Bot-territory guard missed the bot's @lid chat** — `chatBase ===
   groupsBase` compared only the phone; DM chats carried as
   `<botLid>@lid` slipped past the guard.
4. **Scraper downloaded the site logo** — `searchImages()` ignored the
   `site` argument, ran a fixed darknaija→pornpics chain for every query and
   grabbed the first `<img>` on the page (usually the logo — 5KB in 97ms).
   my_links bare domains got `?s=` appended, which turned category pages
   back into the homepage.
5. **Log digest flooded the admin** — success+info lines batched 25-per-send
   with 147+ queued ("Discovered group" ×12, "rewind OK"…).
6. **AI providers: 3 of 4 dead, no recovery** — venice 402 / gemini 401 /
   openai 401 stayed dead until restart; sticky failover wasted 25s on the
   dead "active" provider every call; no load sharing between healthy keys.
7. **School AI hallucinated** — "menu" produced an invented CS201 study plan
   (chapters, hours, self-checks) with no grounding.
8. **Dashboard lies** — "Connection: disconnected / Bot LID unknown" while
   connected (me.lid lands after `open`), "[object Object]" from
   `fetchStatus`'s nested status object, "Reply rate 100%" with zero sends.
9. **Main group auto-set reported "1 members"** — invite-info size read
   before WhatsApp synced the group after `groupAcceptInvite`.

### The fixes
| Error | Fix in v69 |
|---|---|
| 1 | Admin commands accepted in ANY chat on the groups account (LID-gated anyway); fromMe on the bot's own phone processed as the boss (`botSentIds` still filters its own sends) |
| 2 | `fromMe ⇒ admin` on the school account; school's own LID learned at connect and persisted into admin_lids.json |
| 3 | Guard matches the bot's phone OR the bot's LID |
| 4 | Scraper v2.4: multi-engine search (Bing Images HTML murl parse, Flickr public feed, Wikimedia Commons API, Wikipedia pageimages, Openclipart) merged, relevance-ranked, junk-filtered (logo/sprite/avatar/icon/banner/placeholder/extension-less rejected); my_links category URLs used as-is, bare domains boosted via Bing `site:domain`; UA fallback chain fixes Wikimedia 403s |
| 5 | Digest = errors only, max 10 lines (overflow suppressed), max 1 per 10 min, admin-only; group updates get their own 5-min flush |
| 6 | Dynamic AI POOL: `API_1..API_12` env slots with key-shape auto-detect (AIza→gemini, sk-or-v1→openrouter, gsk→groq, sk→openai, else rewind; per-slot NAME/URL/MODEL overrides; legacy keys still honoured). Round-robin load split across healthy providers, fail-streak ≥2 → cooldown 5→30 min, 5-min auto-revive re-check |
| 7 | School OBSERVE MODE: group texts buffered 2 min → ONE AI triage → only actionable items to admin (bundled); study prompts carry strict no-invention grounding |
| 8 | LID learned on `creds.update`; fetchStatus unwraps nested objects; reply-rate renders "—" until ≥5 tracked sends |
| 9 | auto-set re-fetches metadata up to 5× until members > 1 and caches LIDs |

### Test evidence (ALL GREEN)
- boot_test 17/17 · test_full 164/164 · test_v68 65/65 · test_casual 17/17
- test_v683 53/53 · test_v684 42/42 · test_v685 43/43 · test_v686 43/43
- test_v687 55/55 · **test_v69 (NEW) 17/17** — AI pool shape, auto-detect,
  5-task round-robin across 5 providers, cooldown failover
- check_panel_js clean · LOADTEST 300 msgs @100/s: 0 failures, p95 1.2ms
- Scraper live round-trip: search "peas" → 23 real images → download
  302KB JPEG (was: 1 result → 5KB logo)

## v68.7 — MESSAGE DELIVERY + SCRAPER TEST (panel + !st)

# BreadBot v68 — whatsapp-qr-app

## v68.7 — MESSAGE DELIVERY + SCRAPER TEST (panel + !st)

### The problems (user log evidence)
1. "its not recieving my messages ... any of them" — admin's own texts were
   being dropped: on the SCHOOL account the old blanket `if (fromMe) return;`
   threw the admin's messages away before any admin check could run, and on
   the GROUPS account plain-text admin DMs were read-and-ignored (blue tick,
   no reply).
2. "its blue ticking me not responding" — same root: admin DMs never reached
   a reply path.
3. "add the test of my web scrapper i give it a name and see if it downloads"
   — no end-to-end scraper proof existed (search AND download AND delivery).
4. AI showed "NONE" at boot until the groups account connected.

### The fixes
| Problem | Fix |
|---|---|
| Admin messages dropped (school) | fromMe traffic is now PROCESSED — the school login IS the admin's number (ADMIN_PHONE), so admin's own texts route as admin; bot's own sends filtered by botSentIds; self-echoes guarded; command channel = self-chat |
| Blue tick, no reply (groups) | NEW `adminDmChat()` — admin plain-text DMs get INSTANT AI replies 24/7 (bypasses quiet hours + DM pool): greeting restart, 5-message memory, history persisted, fast-lane priority 0; AI-down still acknowledges ("AI is down right now — but I got your message") |
| Groups bot offline while admin texts it | school account warns IN THE SELF-CHAT (never into the bot chat): "⚠️ GROUPS BOT IS OFFLINE — Your message to it was NOT received", rate-limited 5 min, quotes the lost text, groupsNumberBase() works even while the bot socket is down |
| Scraper proof | NEW `!st <name>` / `!scrapertest <name>` (both accounts): 1/3 search → 2/3 download → 3/3 deliver the image, with per-step timings and cold-start hints |
| Scraper proof ON THE INTERFACE | NEW panel card "🧪 Scraper Test" + `POST /admin/scraper-test` — type a query, press Run Test, watch search→download live with an open-media link (JSON verdict, never sends into WhatsApp) |
| AI: NONE at boot | `detectAIBackend()` runs at BOOT, independent of bot connect (still refreshed on connect too) |
| Panel confusion about QRs | QR 1 card says it is the BOT's own number (your phone cannot activate it); QR 2 card says it is YOUR phone; "Main NOT SET" alert now tells the truth (auto-sets after QR 1 scans, retries every 3 min) |

### Admin recognition (263777627210)
The number is ADMIN_PHONE by default in code + env; on the school account it
is the login itself (fromMe = admin), on the groups account it is matched by
phone AND LID (adminLids persisted). Both accounts now honour it everywhere.

### Test evidence
- NEW tools/test_v687.js — 55 tests: adminDmChat routing + memory + fallback,
  bot-offline warning (rate-limit, self-chat only, no loop), !st 3-step flow,
  PANEL scraper-test endpoint + card + verdicts, boot AI detection, panel QR
  honesty, versions, prior guarantees untouched — ALL PASSING
- NEW tools/check_panel_js.js — extracts the panel's inline <script> and
  compiles it as real JS (panel code lives in a template literal, invisible
  to node --check) — PARSING CLEAN
- LIVE SMOKE: POST /admin/scraper-test {"query":"test chess"} →
  search OK (15.3s cold start, 1 result) → download OK (206ms, 5.5KB PNG)
  → mediaUrl returned, total 15.5s — REAL scraper round-trip PROVEN
- Regression gate ALL GREEN: test_full 164/164 · test_v68 65/65 ·
  test_casual 17/17 · test_v683 53/53 · test_v684 42/42 · test_v685 43/43 ·
  test_v686 43/43 · test_v687 55/55 · boot_test 17/17

### What the user must do
1. DEPLOY this build (v68.7) — the logs showed an older build running
2. SCAN QR 1 with the BOT's phone (panel Connection showed "qr" the whole
   time — the groups account was never logged in, which is why Main was NOT
   SET and no messages flowed)
3. QR 2 with your own phone (263777627210) — that IS the admin everywhere
4. Then: panel → 🧪 Scraper Test → type a name → Run Test (or WhatsApp `!st chess`)
5. Main group auto-sets within ~3 min of QR 1 connecting


## v68.6 — HUMAN MODE: the four bot tells are gone

### The problem (behaviour audit)
The bot's *pacing* looked human (typing 1.5-6s, batched slow DM replies),
but four tells still screamed "bot":
1. blue ticks appeared INSTANTLY on every message, 24/7
2. DM replies fired on a fixed 75-second metronome
3. which DMs got answered was a pure lottery
4. the AI happily replied at 2am

### The fix
| Tell | Now |
|---|---|
| Instant reads | `scheduleHumanRead()` — 5-90s RANDOM delay before blue-ticking; admin chats read fast (2-8s, attentive to the boss); ~70% of messages arriving 23:00-07:00 stay UNREAD until morning + 0-90min random wake tail |
| Metronome | DM cycle is self-rescheduling at 75s ±35% (49-101s), first sweep lands mid-window |
| Lottery | oldest waiting DM is answered first (oldest-2n window, shuffled order) |
| 2am replies | AI QUIET HOURS 23:00-06:00 local (env: AI_QUIET_HOURS=0 off, AI_QUIET_START_HOUR / AI_QUIET_END_HOUR tunable) — messages stay pooled, morning cycles send them |

Flood safety: a cap of 1500 pending read timers falls back to instant
reads, so a 500 msg/s flood can never pile up memory (load-tested:
15,000 msgs @ 500/s, 0 failed sends, event-loop p95 1.18ms, 146MB RSS).

`!test` now prints a HUMAN MODE line (read delay, night hold, quiet hours).
`HUMAN_READ=0` env restores instant legacy reads.

### Test evidence
- NEW tools/test_v686.js — 43 tests: delay bounds (admin 50/50 in 2-8s,
  day 50/50 in 5-90s), night hold 205/300 held, flood valve, quiet-hours
  behavioural matrix (02:00/23:00 asleep · 06:00 resume · OFF = night OK ·
  admin-active pauses batch), oldest-first guarantee (new DM NEVER beats
  ancient ones), 200 sweep jitters all within 49-101s and unique — ALL PASSING
- Regression gate ALL GREEN: test_full 164/164 · test_v68 65/65 ·
  test_casual 17/17 · test_v683 53/53 · test_v684 42/42 · test_v685 43/43 ·
  boot_test 17/17 · loadtest 15000 msgs p95 1.18ms 0 failures


## v68.5 — AI replies ONLY in DMs (groups account) · 5-message memory · greeting = fresh start

### The rule, in one line
The AI (Abby) chats ONLY in DMs on the GROUPS account. Never in groups.
Never on the school account. No toggle.

### Why
In groups people greet each other and talk all day — the AI has no idea
what the conversation is about, so it kept jumping in confused. Your
instructions now make the surface deterministic:

| Where a message lands | AI answers? |
|---|---|
| DM to the GROUPS bot | ✅ YES — the only AI chat surface |
| Inside any group | ❌ never (explicit "send pics of X" media commands still served) |
| School account (anything) | ❌ never — read-only monitor + admin commands only |
| Admin self-chat / commands | ❌ no AI chat (school features + !test still work) |

### What changed
| File | Change |
|---|---|
| server.js | group conversational AI block REMOVED (askAI/informalize never called for group chat) |
| server.js | `!groupchat on/off` toggle removed → permanent stub reply ("AI chats in DMs only"); REPLY_IN_GROUPS retired to false (old .env files safe) |
| server.js | confusion guard retired — the bot can no longer catch itself chatting in random groups because group chat no longer exists |
| server.js | GREETING RESTART: "hey", "hi", "hie", "hello", "yo", "eo", "mhoro", "mhoroi", "mangwanani", "masikati", "madekwana", "howfar", "wassup", "good morning/afternoon/evening", "greetings"… (start-of-message, ≤40 chars) wipes that contact's remembered conversation → the AI greets back FRESH, never drags up old topics. Long messages that merely start with "hey" (real requests) are unaffected; media intents bypass the reset entirely |
| server.js | 5-MESSAGE MEMORY made explicit: the AI recalls the LAST 5 user+bot exchanges (USER_HISTORY_SIZE=5, hard-capped every reply, persisted to dm_histories.json across restarts) + every text the contact sent since the bot's last reply; system prompt now says "You remember the LAST 5 MESSAGES… a greeting is a NEW conversation" |
| server.js | REAL BUG FIX: with history present, a SINGLE new text was dropped from the prompt (pooled was only built for 2+ messages) — the AI got the transcript but never saw what the person just said. Now the latest text is ALWAYS in the prompt |
| server.js | menu, !mode, !test, status export updated ("AI surface: DMs only (groups account) · memory: last 5 msgs · greeting = restart") |
| package.json | 68.5.0 |
| tools/test_v685.js | NEW — 43 tests: DM-only code guarantees, school silence, the REAL processDM driven with stubs (greeting wipes memory, non-greeting keeps it, 5-exchange cap, fresh contacts, pooled multi-texts, media intents bypass chat), 25 greeting forms + 12 non-greetings against the real detector |
| tools/test_full.js | 5-msg context section updated to the pooled-fallback semantics (164/164) |

### Group media requests still work
"send pics of cars", "music jah prayzah", NSFW window rules, group link
requests — all explicit commands, all still served in groups. What is gone
is only the AI trying to CONVERSE there.

### Test evidence (all green)
test_full 164/164 · test_v68 65/65 · test_casual 17/17 · test_v683 53/53 ·
test_v684 42/42 · test_v685 43/43 (NEW) · boot_test 17/17 ·
loadtest 5000 msgs: event-loop p95 1.4ms, 0 failures.
tools/test_realistic.js remains an in-progress harness from the v68.5
recordings work — several expectations pre-date v68.4 ownership and are
not part of the release gate.

### Deploy note
No new env vars. Old `REPLY_IN_GROUPS=true` in .env is now ignored.
Rescan QRs only if Render wiped auth on redeploy.

---

## v68.4 — one admin, two bots, ZERO command conflicts

You (263777627210) are the admin of BOTH accounts. This version makes the
command routing deterministic so the same command can never be answered
twice, no matter where you type it.

### THE ROUTING TABLE (how it works now)

| Where you type it | Who answers |
|---|---|
| "Message Yourself" (self-chat) | SCHOOL bot |
| DM to the BOT's number | GROUPS bot (school stays silent) |
| Inside any group | GROUPS bot (school only monitors) |
| PDF you send to the bot | GROUPS bot reads it |
| PDF in a school-only group | SCHOOL bot digests it to you |
| PDF in a group both accounts are in | GROUPS bot digests it (school skips) |
| Scheduled media tasks | ONE scheduler, runs once, right account |

### Code changes

| File | Changes |
|------|---------|
| server.js | school handler: absolute "bot's chat is bot territory" guard — school can never react/reply/route taps in the admin↔bot chat |
| server.js | isSelfChat detection — admin's fromMe commands only acted on in the self-chat; outgoing DMs to the bot or other people are ignored |
| server.js | claimSchool() one-claim memory — a WhatsApp re-delivered message can no longer double-fire a command, tap or doc |
| server.js | DOC OWNERSHIP — school digests docs only in school-registry groups (not main) and admin self-chat/DMs; bot skips exactly those; main group + all other groups stay the bot's — exactly one digest per PDF |
| server.js | resolveTaskTarget: a group BOTH accounts are in is always served by the groups account (school sends only into school-only groups) |
| server.js | button taps on school line: admin-DM + self-chat gate + claim |
| server.js | version strings v68.3 → v68.4 (menu, self-test, boot banners, panel title/h1) |
| package.json | 68.4.0 |
| env | demo-ready layout — the 4 AI keys are kept for the demo, pasted via Render env vars |

### Conflicts that existed before v68.4 (all fixed)

1. A PDF posted in a group both accounts are in → BOTH read it → double
   digest to the admin. Now: exactly one owner per group.
2. A PDF sent to the BOT's number was ALSO read by school (no isAdmin
   gate on the school doc path) → duplicate work + duplicate reply.
3. A button tap in the bot chat could be routed by school when
   SCHOOL_STRICT_ADMIN=false → command injection into the bot chat.
4. WhatsApp re-delivering the same message on the school line could
   double-execute admin commands (school had no dedup memory).
5. Task orders naming a shared group resolved to the school account →
   the read-only monitor would post media into a group the bot also
   works.

## v68.3 — admin recognised, calm reconnects, split panel, !test

| File | Changes |
|------|---------|
| `server.js` | **ADMIN RECOGNITION FIXED (the big one)**: the school account is logged in as the admin's OWN number, so every message the admin types arrives with `fromMe=true` — and the school handler dropped ALL `fromMe` messages before any admin check could run. The bot looked completely deaf. Now: fromMe traffic is PROCESSED. The admin's command channel is the self-chat ("Message Yourself") — typing `menu`, `today`, `status`, "send 5 chess videos to this group by 5" there now works. Bot-echo loops are prevented by the `botSentIds` guard; the self-echo drop only applies to inbound messages; the admin's outgoing chats with OTHER people are silently skipped (never treated as commands, never replied into, no log spam). Self-chat PDFs now get read too ("send me PDFs/DOCX to read" finally works). |
| `server.js` | **RECONNECT HARDENING (WhatsApp hates spam)**: the old loop (fixed 3-15s retries, a fresh QR every 90 s forever, auth wiped after 3 conflicts) reads as an attack to WhatsApp servers and ends in 428 conflict storms and 401 logouts. New rules for BOTH accounts: exponential backoff with ±20 % jitter (5 s → 10 min cap, jitter applied BEFORE the cap); QR renewal capped at 5 per connect cycle → 5 min cooldown instead of endless 90 s QR spam; reconnect-storm detector (8 drops in 10 min → 10 min cooldown); **401 = hard stop** — status `logged-out`, blinking red dot on the panel, rescan required, no more auto-retry on dead credentials; auth wipe only as a LAST resort (5+ conflicts) followed by a 60 s wait. |
| `server.js` | **MAIN GROUP AUTO-RETRY**: `autoSetMainGroup()` ran ONCE on connect — one failed invite resolution during a 428 storm and the bot stayed "Main Group NOT SET" forever (ignoring every group message). It now retries every 3 minutes while unset and the groups account is connected. |
| `server.js` | **!test COMMAND** (menu promised it, switch never had it): one fast self-diagnostic on BOTH accounts — both account statuses + numbers + LID, main group state, groups seen, scraper `/health` ping with ms, AI provider chain (active + per-provider OK/FAIL), scheduled tasks with next drop times, NSFW/DM windows, paused state, flood gate, DM pool / join queue / recipients today, uptime + RAM. |
| `server.js` | **PANEL SPLIT — GROUPS vs SCHOOL**: the single Live Messages and Logs streams are now FOUR: `GROUPS ACCOUNT — Live Messages`, `SCHOOL ACCOUNT (QR2) — Live Messages`, `GROUPS ACCOUNT — Logs`, `SCHOOL ACCOUNT (QR2) — Logs`. Live entries route by account tag; logs route by source (`school` / `school-handler` / `[school]` prefix). GROUPS entries get a blue badge, SCHOOL keep purple. Header/title updated v67 → v68.3. |
| `tools/test_v683.js` | **NEW — 53 tests**: real behavioral test of the fromMe fix (self-chat command routes, friend-DM does NOT, self-echo dropped, botSentIds loop-proof, fromMe group posts monitored, stranger-DM still gated); !test wiring (switch case, school-allowed, scraper ping, scheduler, menu); reconnect state machine (backoff growth/cap/jitter bounds, storm window in/out, QR caps both accounts, 401 hard stops, last-resort wipe, refresh resets); main-group retry; panel split; **scraper direct-links guarantee baked in** (all 5 site URLs incl. every NSFW source asserted present). Caught a real bug pre-release: jitter pushed the backoff cap to 10.5 min — fixed. |
| `tools/boot_test.js` | **NEW — 17 boot checks**: real server boot (LOADTEST=1), /health, /admin/stats, panel HTML (v68.3 title, four streams, routers, CSS), QR endpoints, 20-message injection through the live pipeline. |
| `tools/loadtest.js` | Fixed stale `cwd` path; header text v68.3. |
| `package.json` | 68.0.0 → 68.3.0 |

Test evidence (this exact build): `test_full.js` 163/163 · `test_v68.js` 65/65 ·
`test_casual.js` 17/17 · `test_v683.js` 53/53 · `boot_test.js` 17/17 ·
load 5000 msgs @500/s: flood gate 300/s held, event-loop p95 **1.2 ms** (max 1.31), 136 MB RSS, 0 send failures.

**After deploying**: BOTH accounts need a QR re-scan (school was 401-logged-out; groups may also demand a fresh session). Press **Refresh QR** on each card and scan. If 428 "Conflict" repeats, another phone/PC/instance is still logged in with that number — log it out first, the bot now backs off politely instead of fighting.

## v68.2 — focused DM handling, Zim slang, admin task scheduler

| File | Changes |
|------|---------|
| `server.js` | **FOCUSED DMs (one chat at a time)**: the bot now works like a person with one phone — opens ONE chat, replies, closes it, moves to the next (20–45 s human pause between chats). Max 4 chats per 75 s cycle (was 3-4 with only 6 s gaps). **Interactivity gate**: only people who are actually interacting get replies — 2+ queued texts, a reply within 45 min of the bot's last message, or a brand-new DM while clearly online (≤15 min). Quiet one-off messages WAIT (a second text promotes them); they are logged, not processed. |
| `server.js` | **ZIM SLANG EVERYWHERE**: the DM persona, the group persona and all 4 greeting pools now blend Shona + English slang naturally (chomi, mdhara, bhoo, sharp, mukoma, sisi, hanti, aiwa, zveshuwa, wena) — 1-2 words per reply, never forced. |
| `server.js` | **ADMIN TASK SCHEDULER**: admin says e.g. **"send 5 chess videos to this group by 5"** — the bot parses it (what · how many · which group · when), plans the drops like a human (ONE item at a time, spread out, min 3 min gap, never a burst) and confirms with the plan. Times: "by 5" (=5pm, Zim speak), "by 5pm", "by 17:30", "in 2 hours", "tonight", "tomorrow", "now". Kinds: videos/clips, songs/music/tracks/mixtapes, pics/pictures/photos, gifs. Target: "this group"/"main group", any group NAME (fuzzy-matched), or a raw @g.us id. **Works on BOTH accounts** — the group name resolves across the groups registry AND the school registry, and the send goes out on the account that owns the group. No repeats within a task, deadline overflow + failure limits are reported to the admin. Commands: `!tasks`, `!canceltask <id>` (also on the school line), casual "tasks"/"cancel task x". Tasks persist to `tasks.json` across restarts. |
| `server.js` | `sendMediaUrl`/`sendImageSafe`/`sendGifSafe` now accept an `account` option so scheduled sends go out through the right socket. |
| `tools/test_full.js` | +23 tests (163 total, all passing): task parser (count cap, of-form, bad-time help, non-task chat), time parser ("by 5"→17:00, 17:30, in-30-min, tonight, now, banana→0), interactivity gate (multi-text, fresh DM, quick reply, quiet 2h-old single text waits, human gaps). |

Test evidence (this exact build): `test_full.js` 163/163 · `test_v68.js` 65/65 ·
live boot: scheduler started, DM cycle 1-4/75 s, 120/120 msgs @40/s, p95 1.4 ms, 116 MB.

## v68.1 — full component test pass + trigger-word fix

| File | Changes |
|------|---------|
| `server.js` | **TRIGGER-WORD QUERY CLEANING (real bug found by testing)**: `detectMediaIntent` now strips filler words — "can you send me the song nsana" used to search **"the nsana"**, "drop that mixtape" searched **"that"**, "ndipe music" searched **"ndipe"**, "gifs please" searched **"please"**. Leading/trailing junk (the, a, that, please, ndipe, ndipewo, ndoda, mungandipe, chief, mukoma…) is now stripped and Shona request verbs are recognised, so the scrapper receives the ACTUAL query ("nsana", "top hits", "funny"). |
| `tools/test_full.js` | NEW — 140 tests, all passing, covering exactly: DM commands without "!", admin `!` menu ↔ real switch cases (79 menu commands all resolve), scraper trigger words (music/video/gif/pic + Shona + non-triggers), duplicate-message suppression (6h quiet-inbox window, admin-force bypass, AI last-3-reply dedup), 5-last-message reply context (pool cap 10, last-5 turns per side, prompt build), school account = admin-DM-only strict gate, needed-updates filter. |
| (packaging) | Runtime state files (`dm_histories.json`, `learning_data.json`, `policy_state.json`, `group_settings.json`) are NO LONGER shipped in the zip — the app recreates them on first boot. Test suites under `tools/` now ship with the code. |

Test evidence (this exact build): `tools/test_full.js` 140/140 · `tools/test_v68.js` 65/65 ·
live boot LOADTEST=1: 200/200 msgs @50/s handled, 3000 msgs @500/s → 79% live + graceful flood sampling, event-loop p95 1.22ms, 139MB RSS, no crash.

## What changed (v67 → v68)

| File | Changes |
|------|---------|
| `server.js` | **SCHOOL LOCKED TO ADMIN**: the school account now replies ONLY to the admin's DM (commands, buttons, free-text study chat). Every group message and every other person's DM is silently ignored — no AI, no replies, nothing. |
| `server.js` | **DOCUMENT BRAIN**: PDFs (.pdf via pdf-parse), Word (.docx via mammoth) and plain .txt/.csv/.md received in ANY chat are downloaded, read and cached per chat (last 4 docs, 12h). Old binary .doc gets an honest "send as .docx/pdf" reply. Scanned-image PDFs are detected and reported (no OCR). |
| `server.js` | **ASSIGNMENTS → ADMIN ONLY**: documents read in school groups (or the main group) are scanned for assignments/tests/deadlines (AI extraction with keyword fallback). The extracted list is sent ONLY to the admin's DM — groups never receive anything. |
| `server.js` | **STUDY BUDDY**: `!study [topic]` / "what should I study" produces ordered, specific study guidance grounded in the timetable, deadlines and recently-read documents. Free-text messages to the school account get study-buddy AI answers. Morning report now starts with a "🧠 Study first" section. |
| `server.js` | **PDF CREATION**: `!pdf <topic>` / "make me a pdf about X" writes AI study notes and sends a REAL PDF. `!pdf from <doc>` converts a remembered document into notes. The PDF writer is hand-rolled zero-dependency code — pdfkit was removed because pdf-parse rejects pdfkit's xref ("bad XRef entry", proven by round-trip test). |
| `server.js` | **NEEDED-UPDATES FILTER**: group messages that matter (due, deadline, submit, test, exam, quiz, presentation, lecture, cancelled, postponed, rescheduled, moved, timetable, venue, marks, results, closing, registration, supplementary, CTA, semester) are queued from BOTH accounts and flushed to the admin with the log digest or on demand (`!updates`). Everything else stays noise. |
| `server.js` | **BUTTONS**: `menu` (or tapping) opens native WhatsApp interactive menus — Main / School / Study / Groups / Ads — on BOTH accounts. Three-layer fallback: native flow → legacy quick-reply buttons → plain text, so an answer ALWAYS arrives. Button taps (`buttonsResponseMessage` + `interactiveResponseMessage`) route into the same admin commands. |
| `server.js` | **TWO CONNECTIONS, HANDLED SEPARATELY**: per-account counters (`accounts.groups`, `accounts.school`) in /admin/stats; groups socket and school socket run different handlers, different reply rules, different menus — sharing only the AI chain, panel and log digest. |
| `server.js` | New commands: `!menu`, `!study`, `!deadlines`, `!pdf`, `!docs`, `!forgetdocs`, `!updates`, `!adstatus`. Casual aliases for all of them (no "!" needed). `COMMAND_LIST` updated. School hello + boot hello updated to v68. |
| `package.json` | 67.0.0 → 68.0.0. Added `pdf-parse`, `mammoth`. Removed `pdfkit` (see PDF note above). |
| `.env.example` | New vars documented: SCHOOL_STRICT_ADMIN, STUDY_BUDDY, DOC_ENABLED, DOC_MAX_MB, DOC_MAX_TEXT, LOG_TO_ADMIN, ADMIN_LOG_DIGEST_MIN, FLOOD_THRESHOLD, OUT_DEDUP_HOURS. |
| `tools/test_v68.js` | NEW — 65 unit tests covering the casual parser, button-tap extraction (both WhatsApp formats), needed-updates filter, assignment extraction, a full PDF write→read roundtrip, real DOCX reading, edge cases and menu integrity. All passing. |

## Unchanged by design
Anti-ban pacing/policy layer, join pacing, NSFW persona modules, broadcast caps,
dedup rules, flood gate, dual-QR boot flow, Open-Meteo weather (Harare/Bindura).

## Deployment notes
1. Deploy the intelligent-scraper first, then this bot with `SCRAPER_URL` pointing at it.
2. Scan BOTH QRs on the panel: card 1 = groups account, card 2 = school account.
3. Set `ADMIN_PHONE` (and AI keys) in `.env`. The school line answers ONLY that number.
4. Nothing here circumvents WhatsApp's terms — pacing exists to keep the account alive; spam still gets accounts banned.

## Security reminder
The public repo previously leaked live API keys (OpenAI/Gemini/Venice/Rewind) in the
`env` file. Those keys were REMOVED from this package — you must still ROTATE them
at the providers; nothing in this zip contains valid keys.
