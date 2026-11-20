# AUTOMATION GUIDE — BreadBot v84.1 + intelligent-scraper v4.1
### Everything automated, how it behaves, and how to run it safely on the Render free tier

---

## 1. WHAT IS AUTOMATED (the full map)

### intelligent-scraper (v4.1) — media pipeline, MYLINKS-ONLY
| Endpoint | What it does | When the bot calls it |
|---|---|---|
| `POST /search` | images from YOUR slots only | WhatsApp `!ad`/image intents |
| `GET /gif` | gif/mp4 loops from YOUR slots | group gif requests |
| `POST /video` | video search→page→player-extract→download | `!nsfwvideo`, scheduler drops |
| `POST /music` | audio from YOUR slots | `!music` |
| `POST /download` | direct URL → temp file → served | any media URL someone sends |
| `POST /album` + `GET /album/:id/next` | page album → sequential images | album flow |
| `GET /my-links` | per-slot diagnostics | panel + Twitter link policy |
| `POST /toggle-site` | enable/disable a slot | panel buttons |
| `POST /cleanup` | force temp wipe | `!cleantemp` |
| `GET /health` | keep-alive probe | bot pings every 5 min |

**Link policy (your Task-3 requirement):** every endpoint resolves media EXCLUSIVELY from (1) `my_links.json` hot-reloaded, (2) `MYLINKS` env, (3) per-request `myLinks`. There is no other source in the codebase — the dead `gif.js` that had hardcoded sites was deleted in v4.1. Twitter additionally strips any non-owner URL from captions.

### whatsapp-qr-app (v84.4) — the automation brain
- **WhatsApp core (Baileys):** QR login, session restore from `SESSION_B64_GROUPS`, reconnect matrix per disconnect code, flood gating, anti-pattern send delays (Fibonacci), send lanes with dedup.
- **AI brain:** every group message → `aiDecide()` (rate-limited, cached, confidence-gated) → executes scraper actions or chat. Admin commands (`!menu`, `!sched`, `!tw on`…, `!film [n]`).
- **Circadian orchestrator:** sleep 23-06, morning peak 9-12 (60%), lunch dip, 5-hour afternoon rest at 4%, evening peak, rest days, 90-min ultradian micro-rests, skip/delay/distraction life events. **All auto-posting is gated by this** — the bot behaves like a person with a schedule.
- **Auto-posters — `schedules/<platform>.json` is LIVE config (v84.4):**
  every ENABLED task whose action has a real handler IS the schedule
  (edit the interval, restart, done). Tasks with no automated handler
  are refused loudly at boot instead of being silently ignored.

  | Platform | Live tasks (from schedules/*.json) | Manual-only |
  |---|---|---|
  | YouTube | community text post 8h · REAL Short upload 4h (uploads a cached film .mp4 when one exists, else honest text post) · engage (watch+like+comment) 2h | full video upload without a cached film |
  | Facebook | timeline 8h · YT crosspost (rewritten, no links) 12h · join queued groups 4h | native video upload (no implementation — honest) |
  | Twitter | tweet 2h · reply 3h · DM check 45min + independent persona posting | auto-follow (X ban risk) |
  | TikTok | watch For You feed (warmFeed, passive) 1.5h | follow / comment (no target source — use `!tt follow <user>` / `!tt comment <url> <msg>`) |

  All auto-posters run ±jitter per fire, circadian-gated, per-platform mutexed.
- **videoScheduler:** drops n videos at Harare 00/04/08/12/16/20 with MD5 dedup + per-user 3/hour cap (OFF by default — `!sched on`).
- **Keep-alives:** bot self-pings `/health` every 4 min; pings the scraper every 5 min.
- **Blender film factory:** `POST /admin/blender/plan {topic, grade}` → full .bpy project; render anywhere with Blender (see §4).

---

## 2. RENDER FREE TIER — THE HOURS MATH (read this)

Render gives **750 instance-hours per month TOTAL across all services**. A month has up to 744 hours.

| Strategy | Hours used | Verdict |
|---|---|---|
| 2 services always-on | 2 × 744 = **1488** | ❌ blows the budget by day ~15 |
| **Bot always-on, scraper sleeps** | 744 | ✅ fits exactly (31-day month: 744 ≤ 750) |
| cron-job.org pinging BOTH to stay awake | 1488 | ❌ same trap — pings don't create hours |

**Correct setup:**
1. **whatsapp-qr-app** = always-on (it must keep the WhatsApp session; sleeping would force QR re-scan). This consumes your whole budget — that's the price of a persistent session.
2. **intelligent-scraper** = let it SPIN DOWN. It is stateless (temp files only). A request wakes it in 30-60 s. **Do NOT create a cron keep-alive for it** — the bot's own 5-min health ping is enough and even that just keeps it warm when it would already be awake.
3. cron-job.org: ONE free job → `GET https://<your-bot>.onrender.com/health` every **10 minutes** (Render sleeps after 15 idle; 10-min pings guarantee zero sleep for the one service that matters). Set to run 24/7.
4. If you later add a third always-on service, you need a paid plan or accept mid-month outages.

**512 MB RAM on the bot:** v84.1 fixed the memory alerts to read the cgroup, but physics still applies: every logged-in platform browser costs 150-300 MB. With Chrome running for Twitter + Facebook + YouTube simultaneously you WILL OOM. Advice: run at most TWO platforms with browsers (e.g. WhatsApp + Twitter), keep YouTube/Facebook disabled (`!yt off`, `!fb off`) until you upgrade to Starter (2 GB). TikTok has no posting anyway.

---

## 3. LOGINS THAT "WORK LIKE A HUMAN" (your Task 4)

Already built in — and hardened in v84.1:
- **Cookies-first:** every platform saves `data/<platform>/cookies.json`; login() restores the session before ever touching credentials.
- **Human typing:** 40-100 WPM with 2% typos + backspaces, thinking pauses.
- **Bezier mouse** paths, clicks inside the element, reading pauses while scrolling.
- **Session warming:** `browseRandomly` before every post; `warmSession` at browser start.
- **Circadian inactivity:** the account goes quiet at night, on rest days, during micro-rests — and v84.1 adds an explicit post-task quiet period on Twitter (1-4 min after tweets).
- **Per-fire jitter** (±20%) so intervals never look cron-shaped — our own anti-detect meter flagged the old constant intervals at 20/100.
- **Rate caps enforced in code** (8 tweets/h, 50/day; 5 follows/h, 25/day) — v84.1 closes the waitAndRecord bypass.
- **Evasions sane:** no Firefox-UA-on-Chrome mismatch, no `--disable-web-security`.

**To make it work for real:** set `TWITTER_USERNAME/TWITTER_PASSWORD` (+ FB/YT creds) in Render env or via panel → Account Setup. First login solves any CAPTCHA manually through the panel browser if needed; after that cookies carry it.

---

## 4. THE BLENDER FILM PIPELINE (your Task 2 — the star)

**Where it runs:** the server only PLANS (writes .bpy text — no Blender needed). You render on your PC or free GitHub Actions CI. v84.4 completed the **last mile**: the rendered .mp4 goes back INTO the bot and out to your channels.

```bash
# 1) plan (on the Render server or locally):
python -m blender_pipeline all --topic "The San people of the Kalahari" --grade 10 --workdir work/san

# 2) render (a machine with Blender + ffmpeg):
bash work/san/render.sh          # objects → assemble → frames → MUX → out/final.mp4

# 3) share: upload out/final.mp4 in the panel (🎥 Film Last Mile card)
#    then: 📲 WhatsApp (video bytes to main group) · ▶️ YouTube (Studio)
#          🐦 Twitter (tweet + media). Or from WhatsApp: !film list, !film 1
```

**v84.4 mux fix (this was broken):** the generated render.sh used to (a) have invalid
bash — `run_bpy () {{` doubled braces, the script could not even start, and (b) compute
an ffmpeg narration-mix graph and then throw it away, so final.mp4 was always SILENT.
Both fixed: render.sh is valid bash, and narration mp3s are mixed at their EXACT
narration-beat offsets (`start_f / fps * 1000` ms adelay graph, actually passed to
ffmpeg) with subtitles burned in. No audio → honest "silent" warning instead of a fake success.

**What it produces for that topic (verified in the demo run):**
- 12 `.bpy` files: dune terrain (displacement+ripples+grass+acacias+rigid rocks), hunting spear (bend modifier, knapped flint head via voronoi displacement, sinew bindings, leather grip), recurve bow + 3 fletched arrows, **3 humans** (anatomical proportions per sex/age, subsurface skin with pores, individual fingernails + toenails, 3 hair systems: 4500-strand coily scalp ×8 children ≈ 36k strands + brows + lashes, hide apron with cloth sim, 26-bead ostrich-shell necklace, idle breathing keyframes), campfire (flicker-animated emission + firelight + rigid stone ring), grass hut (sapling arcs + displaced thatch), eland (spiral-horn quadruped with fur system), rock-art panel (ochre wave-shader), ostrich-egg flasks + digging stick
- `90_film_assemble.bpy`: imports every GLB, builds 7 scenes with per-mood sun/fill rigs, animated cameras (aerial orbit / dolly-in / close-up / slow push) with DOF + track-to, Nishita dusty sky, frame ranges **exactly matching the narration beats**
- `narration_XX.mp3` (edge-tts if installed) + `subtitles.srt` + `alignment.json` (start-frame per scene → voice-over aligns by construction)
- `render.sh` (objects→assemble→frames→ffmpeg mux) + `gh-workflow/render-film.yml` (free CI render: plan job + Blender 4.1 render job, artifacts uploaded)

**How the "AI decides, not hardcoded" contract works:** your syllabus+topic seed a JSON plan; an LLM (any OpenAI-compatible key via `API_1..12` or `BLENDER_AI_KEY`) may rewrite scene descriptions, narration, object list and proportions; a curated knowledge brain (San/Zimbabwe dossiers + generic) grounds everything and fully replaces the AI when no key exists. Emitters are deterministic — same spec, same model.

**Automation:** trigger from WhatsApp `!deepresearch`-adjacent flow or the panel: `POST /admin/blender/plan {"topic": "...", "grade": "6"}` — then `GET /admin/blender/files?workdir=work/film` lists the .bpy kit; commit it and let the GitHub Action render.

---

## 5. CRON-JOB.ORG CONFIG (free keep-alive)

| Field | Value |
|---|---|
| URL | `https://<your-whatsapp-bot>.onrender.com/health` |
| Schedule | every 10 minutes |
| Method | GET |
| Fail notifications | on |

That is the ONLY job you need. (Scraper: no ping — let it sleep; cold starts are fine and save your hours budget.)

---

## 6. THINGS YOU SHOULD STILL DO (honest list)

1. **Rotate the 4 Rewind API keys** that were committed to git history — they are burned regardless of this cleanup (purge history with `git filter-repo` or BFG when you push fresh).
2. **X/Twitter automation risk:** browser automation violates X ToS. The rate limits + human behavior minimize risk but never remove it. The safe alternative is the official API v2 (500 posts/mo free tier) — the OWN-LINKS-ONLY policy would port over trivially.
3. **Render free disk is ephemeral:** every deploy wipes `data/`. Use panel → Session Backup → paste into `SESSION_B64_GROUPS` env, and export `SESSION_B64_*` after each QR scan.
4. **512 MB = max 2 browser platforms.** Disable the rest until you upgrade.
5. First Blender run takes minutes-to-hours depending on your GPU and `BLENDER_ENGINE` (EEVEE default is ~10× faster than Cycles).
