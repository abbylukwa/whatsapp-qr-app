# BreadBot v68 — whatsapp-qr-app

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
