# BreadBot v68 — whatsapp-qr-app

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
