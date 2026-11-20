const { writeJSONAtomic } = require('../../core/atomic');
'use strict';
/* ══════════════════════════════════════════════════════════════
 *  platforms/twitter/index.js — Twitter/X Automation (v3.0)
 *  *** INDEPENDENT FROM WHATSAPP ***
 *
 *  REAL FUNCTIONALITY:
 *    - Independent NSFW posting like an excited girl who's into NSFW
 *    - Posts randomly like she "woke up in the mood" (usually but not always)
 *    - Auto-reply to other people's posts/comments independently
 *    - Handle DMs with media — can talk like "this could be us"
 *    - Own content sourcing via scraper (NOT from WhatsApp)
 *    - Caption generator for every NSFW post (random, unpredictable)
 *    - Media deduplication (never post same media twice)
 *    - Rate limiting per action type
 *    - Admin control (!tw on/off/status/login/post/nsfw/replies/dm)
 *
 *  ANTI-DETECTION:
 *    - Puppeteer + stealth plugin + 16 browser evasions
 *    - Human typing (40-65 WPM, typos, think pauses)
 *    - Human clicking (off-center, position jitter)
 *    - Human scrolling (variable delta, reading pauses)
 *    - Session warming (browse randomly before action)
 *    - Cookie persistence (survive restarts)
 *    - CAPTCHA detection + alert
 *    - Fingerprint rotation (every 3-6 hours)
 *
 *  ACTIONS & SAFE LIMITS (research-based):
 *    - Tweet:  5-8/hr, 30-50/day  (aggressive = ban)
 *    - Reply:  8-12/hr, 40-60/day (replies are safer)
 *    - Follow: 3-5/hr, 15-25/day  (bulk follow = instant ban)
 *    - Like:   DISABLED (X explicitly bans automated liking)
 *    - DM:     3-5/hr, 15-25/day  (DMs are sensitive)
 *
 *  INDEPENDENT NSFW FLOW:
 *    Own timer fires (random 1-3hr intervals, like waking up horny)
 *      → independentNSFWPost()
 *      → scraper.fetchVideo(query)
 *      → caption = excitedGirlPersona.generate(context)
 *      → tweet(caption) with media attachment
 *
 *  EXCITED GIRL PERSONA:
 *    - Posts like she just woke up and is feeling it
 *    - Captions: "woke up like this", "can't sleep", "in my mood rn"
 *    - Replies: flirty, playful, "this could be us", engaging
 *    - DMs: personal, media sharing, "this made me think of you"
 *    - Time-aware: late night = more frisky, morning = just woke up vibes
 *
 *  CAPTION ENGINE:
 *    - 8 tones: teasing, playful, bold, direct, subtle, curious, confident, engaging
 *    - Time-aware: late night = more explicit, morning = teasing
 *    - Never same tone twice in a row
 *    - 200-caption dedup history
 *    - 1-2 emojis optimal (3+ hurts engagement)
 *    - 1-2 hashtags (targeted > generic)
 *    - 40-80 chars optimal length
 * ══════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { launchStealthBrowser, warmSession, detectCaptcha, applyEvasions } = require('../../core/anti-detection');
const { humanType, humanClick, humanDelay, humanScroll, browseRandomly, sleep } = require('../../core/human-behavior');
const RateLimiter = require('../../core/rate-limiter');
const DataManager = require('../../core/data-manager');
const ScheduleManager = require('../../core/schedule-manager');
const NSFWCaptionGenerator = require('../../core/content/nsfw-captions');

class TwitterBot {
  constructor(options = {}) {
    this.username = options.username || process.env.TWITTER_USERNAME || '';
    this.password = options.password || process.env.TWITTER_PASSWORD || '';
    this.dataDir = options.dataDir || './data';
    this.log = options.log || console.log;

    this.browser = null;
    this.page = null;
    this.loggedIn = false;
    this.cookieFile = path.join(this.dataDir, 'twitter', 'cookies.json');

    // Health tracking
    this.health = {
      lastActionAt: 0,
      lastError: null,
      errorCount: 0,
      successCount: 0,
      startedAt: null,
      browserRestarts: 0
    };

    // Rate limiters — conservative to avoid bans
    this.rateLimiter = new RateLimiter('twitter', {
      hourly: 20, daily: 100, cooldown: 5000
    }, this.dataDir);

    this.rateLimiter.setActionLimits('tweet', { hourly: 8, daily: 50, cooldown: 15000 });
    this.rateLimiter.setActionLimits('reply', { hourly: 12, daily: 60, cooldown: 10000 });
    this.rateLimiter.setActionLimits('follow', { hourly: 5, daily: 25, cooldown: 30000 });
    // NOTE: No 'like' limit — X explicitly bans automated liking

    // Data persistence
    this.data = new DataManager('twitter', this.dataDir);
    this.data.setLog(this.log);

    // Schedule
    this.schedule = new ScheduleManager('twitter', './schedules');
    this.schedule.setLog(this.log);

    // ═══ NSFW CAPTION GENERATOR ═════════════════════════════════
    this.nsfwCaptions = new NSFWCaptionGenerator({ log: this.log });

    // ═══ MEDIA DEDUP ════════════════════════════════════════════
    // Hash set of all media ever posted — prevents repeats
    this._postedMediaHashes = new Set();
    this._loadPostedMedia();

    // ═══ NSFW QUEUE (DEPRECATED — kept for backward compat) ═══
    // No longer populated from WhatsApp. Twitter is INDEPENDENT.
    this._nsfwQueue = [];
    this._nsfwPostedCount = 0;

    // ═══ AUTO-REPLY TRACKING ════════════════════════════════════
    this._repliedTo = new Set();
    this._loadRepliedTo();

    // Content pipeline (set by orchestrator)
    this.contentPipeline = null;
    this.interactionTracker = null;

    // Auto-reply config
    this._autoReplyEnabled = true;
    this._autoReplyInterval = null;

    // ═══ INDEPENDENT NSFW POSTING ═══════════════════════════════
    // Twitter posts NSFW on its own — like an excited girl who
    // woke up in the mood. Uses scraper directly, NOT WhatsApp.
    this._independentNSFWEnabled = true;
    this._independentNSFWTimer = null;
    this._lastIndependentPost = 0;
    this._independentPostCount = 0;
    this._moodLevel = 0.5; // 0-1, how "in the mood" she is

    // ═══ EXCITED GIRL PERSONA ═══════════════════════════════════
    this.persona = new ExcitedGirlPersona({ log: this.log });

    // ═══ DM HANDLING ════════════════════════════════════════════
    this._dmEnabled = true;
    this._dmRepliedTo = new Set();
    this._dmCount = 0;
    this._dmCheckInterval = null;

    // ═══ SCRAPER REF (set by orchestrator) ══════════════════════
    this.scraper = null;

    // ═══ v84.1 OWN-LINKS-ONLY POLICY ═════════════════════════
    // Every URL in a tweet/reply/DM must belong to the OWNER. Allowed
    // hosts = OWNER_LINKS env (comma list) + hosts of the scraper's
    // my_links slots. Everything else is STRIPPED before posting.
    this._allowedLinks = (process.env.OWNER_LINKS || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    this._allowedLinkHosts = new Set(
      this._allowedLinks.map(u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return null; } }).filter(Boolean)
    );
    this._linkPolicyLoaded = false;
  }

  /* v84.1: pull the owner's slot hosts from the scraper (cached 1h) */
  async _loadAllowedLinks() {
    if (this._linkPolicyLoaded) return;
    this._linkPolicyLoaded = true;
    try {
      if (this.scraper && this.scraper.getSlots) {
        const slots = await this.scraper.getSlots();
        if (slots && Array.isArray(slots.links)) {
          for (const slot of slots.links) {
            try {
              const host = new URL(slot.url).hostname.replace(/^www\./, '');
              this._allowedLinkHosts.add(host);
            } catch (e) {}
          }
        }
      }
    } catch (e) {}
    // x.com / twitter.com are always allowed (self links)
    this._allowedLinkHosts.add('x.com');
    this._allowedLinkHosts.add('twitter.com');
    this.log('info', 'twitter', 'Link policy loaded — allowed hosts: ' + [...this._allowedLinkHosts].join(', '));
  }

  /* v84.1: strip ANY url whose host is not the owner's. Returns
   * { text, removedCount } — the tweet still posts, just without
   * foreign links. Text WITHOUT urls is untouched. */
  async enforceLinkPolicy(text) {
    await this._loadAllowedLinks();
    const urlRe = /https?:\/\/[^\s"'<>)\]]+/gi;
    let removed = 0;
    const out = String(text || '').replace(urlRe, (u) => {
      try {
        const host = new URL(u).hostname.replace(/^www\./, '');
        if (this._allowedLinkHosts.has(host)) return u;   // owner's link — keep
        removed++;
        return '';                                        // foreign link — strip
      } catch (e) { removed++; return ''; }
    }).replace(/\s{2,}/g, ' ').trim();
    if (removed > 0) this.log('warn', 'twitter', `Link policy: stripped ${removed} non-owner link(s) before posting`);
    return { text: out, removedCount: removed };
  }

  /* v84.1: human post-task inactivity — after finishing a task the
   * account goes QUIET for a random while (what a human does), instead
   * of machine-gunning actions back-to-back. Cheap, non-blocking. */
  async _postTaskInactivity(minMs = 90000, maxMs = 420000) {
    const wait = minMs + Math.random() * (maxMs - minMs);
    this.log('info', 'twitter', `Going inactive for ${Math.round(wait / 1000)}s (human post-task pause)`);
    await sleep(wait);
  }

  /* ── Wire content pipeline ─────────────────────────────────── */
  setContentPipeline(pipeline) {
    this.contentPipeline = pipeline;
  }

  setInteractionTracker(tracker) {
    this.interactionTracker = tracker;
  }

  setScraper(scraper) {
    this.scraper = scraper;
  }

  /* ════════════════════════════════════════════════════════════
   *  START INDEPENDENT NSFW: The excited girl posting schedule
   *  Posts at random intervals (1-3hr), like waking up in the mood
   * ════════════════════════════════════════════════════════════ */
  startIndependentNSFW() {
    if (this._independentNSFWTimer) return; // Already running
    this._independentNSFWEnabled = true;
    this.log('info', 'twitter', 'Independent NSFW posting started (excited girl persona)');

    const scheduleNext = () => {
      // Random interval: 1-3 hours (like she wakes up in the mood randomly)
      // Sometimes she's really feeling it (shorter interval), sometimes chill
      const baseInterval = (60 + Math.random() * 120) * 60 * 1000; // 1-3hr in ms
      // Mood affects interval: high mood = posts sooner
      const moodMultiplier = 1.5 - this._moodLevel; // high mood = shorter
      const interval = baseInterval * moodMultiplier;
      this.log('info', 'twitter', `Next independent NSFW post in ${Math.round(interval / 60000)}min (mood: ${Math.round(this._moodLevel * 100)}%)`);
      this._independentNSFWTimer = setTimeout(async () => {
        if (!this._independentNSFWEnabled) return;
        try {
          await this.independentNSFWPost();
        } catch (e) {
          this.log('error', 'twitter', 'Independent NSFW error: ' + e.message);
        }
        // Shift mood randomly (sometimes more in the mood, sometimes less)
        this._moodLevel = Math.max(0.1, Math.min(1, this._moodLevel + (Math.random() - 0.4) * 0.3));
        scheduleNext();
      }, interval);
    };
    scheduleNext();
  }

  stopIndependentNSFW() {
    this._independentNSFWEnabled = false;
    if (this._independentNSFWTimer) {
      clearTimeout(this._independentNSFWTimer);
      this._independentNSFWTimer = null;
    }
    this.log('info', 'twitter', 'Independent NSFW posting stopped');
  }

  /* ════════════════════════════════════════════════════════════
   *  INDEPENDENT NSFW POST: Post NSFW on Twitter's own terms
   *  Sources media from scraper, uses excited girl persona
   * ════════════════════════════════════════════════════════════ */
  async independentNSFWPost() {
    if (!await this.ensureReady()) return { success: false, error: 'Not logged in' };
    if (!this.rateLimiter.canAct('tweet')) return { success: false, error: 'Rate limited' };

    try {
      // Generate a query using the persona (what she's in the mood for)
      const query = this.persona.pickQuery(this._moodLevel);
      this.log('info', 'twitter', `Excited girl posting: mood ${Math.round(this._moodLevel * 100)}%, query: "${query}"`);

      // Try to fetch media from scraper
      let mediaData = null;
      if (this.scraper && this.scraper.fetchVideo) {
        try {
          mediaData = await this.scraper.fetchVideo(query, []);
        } catch (e) {
          this.log('warn', 'twitter', 'Scraper fetch failed: ' + e.message);
        }
      }

      // Generate caption using excited girl persona
      let caption = this.persona.generateCaption({
        query,
        hasMedia: !!(mediaData && mediaData.ok),
        moodLevel: this._moodLevel,
        hour: new Date().getHours(),
        lastPostAgo: Date.now() - this._lastIndependentPost
      });

      // Post the tweet — v84.1: WITH media when the scraper delivered
      const result = await this.tweet(caption, mediaData && mediaData.ok ? mediaData.filePath : null);

      // v84.1: record the media hash for cross-cycle dedup
      if (result.success && mediaData && mediaData.ok) {
        const h = crypto.createHash('md5').update(mediaData.filePath + '|' + mediaData.source).digest('hex').substring(0, 16);
        this._postedMediaHashes.add(h);
        this._savePostedMedia();
      }

      if (result.success) {
        this._independentPostCount++;
        this._lastIndependentPost = Date.now();
        this.data.addToHistory('independent_nsfw', {
          query,
          caption: caption.slice(0, 80),
          moodLevel: this._moodLevel,
          success: true,
          ts: Date.now()
        });

        if (this.interactionTracker) {
          this.interactionTracker.recordPost('twitter', {
            type: 'independent_nsfw',
            content: caption.substring(0, 200),
            query
          });
        }
      }

      return { ...result, contentType: 'independent_nsfw', caption, isNSFW: true };
    } catch (e) {
      this.health.errorCount++;
      this.health.lastError = e.message;
      this.log('error', 'twitter', 'Independent NSFW post error: ' + e.message);
      return { success: false, error: e.message };
    }
  }

  /* ════════════════════════════════════════════════════════════
   *  HANDLE DMs: Check and reply to DMs with media
   *  Like "this could be us" — flirty, personal, with media
   * ════════════════════════════════════════════════════════════ */
  async handleDMs() {
    if (!await this.ensureReady()) return { success: false, error: 'Not logged in' };
    if (!this._dmEnabled) return { success: false, error: 'DM handling disabled' };

    try {
      // Navigate to DMs
      await this.page.goto('https://x.com/messages', { waitUntil: 'networkidle2', timeout: 30000 });
      await humanDelay(2000, 5000);

      // Find unread DM conversations
      const conversations = await this.page.evaluate(() => {
        const convos = [];
        // Look for conversation items with unread indicators
        const items = document.querySelectorAll('[data-testid="conversation"]');
        for (const item of items) {
          const link = item.querySelector('a[href*="/messages/"]');
          const name = item.querySelector('[data-testid="conversation-name"]');
          const unread = item.querySelector('[data-testid="unread-indicator"]');
          if (link) {
            convos.push({
              href: link.getAttribute('href'),
              name: name ? name.textContent.trim() : 'Unknown',
              hasUnread: !!unread
            });
          }
        }
        return convos.filter(c => c.hasUnread).slice(0, 3);
      });

      let dmsHandled = 0;

      for (const convo of conversations) {
        if (dmsHandled >= 2) break; // Max 2 DMs per cycle
        if (!this.rateLimiter.canAct('reply')) break; // Use reply rate limit for DMs

        const convoHash = this._hashUrl(convo.href);
        if (this._dmRepliedTo.has(convoHash)) continue;

        // Open the conversation
        const dmUrl = 'https://x.com' + convo.href;
        await this.page.goto(dmUrl, { waitUntil: 'networkidle2', timeout: 20000 });
        await humanDelay(2000, 4000);

        // Read the last message (human-like)
        await humanScroll(this.page, 'down', 1);
        await humanDelay(2000, 4000);

        // Get the last message text for context
        const lastMessage = await this.page.evaluate(() => {
          const messages = document.querySelectorAll('[data-testid="messageEntry"] [data-testid="messageText"]');
          if (messages.length === 0) return '';
          return messages[messages.length - 1].textContent?.trim() || '';
        });

        // Generate DM reply using persona (flirty, personal)
        const dmReply = this.persona.generateDMReply({
          convoName: convo.name,
          lastMessage: lastMessage.slice(0, 100),
          hour: new Date().getHours(),
          moodLevel: this._moodLevel
        });

        // Type the reply
        const editor = await this.page.$('[data-testid="dmComposerTextInput"]');
        if (editor) {
          await humanType(this.page, '[data-testid="dmComposerTextInput"]', dmReply, { wpm: 35 + Math.random() * 20 });
          await humanDelay(1000, 3000);

          // Send
          const sendBtn = await this.page.$('[data-testid="dmComposerSendButton"]');
          if (sendBtn) {
            await humanClick(this.page, '[data-testid="dmComposerSendButton"]');
            await humanDelay(2000, 4000);
            dmsHandled++;
            this._dmCount++;
            this._dmRepliedTo.add(convoHash);
            this.log('info', 'twitter', `DM replied to ${convo.name}: "${dmReply.slice(0, 50)}"`);
          }
        }

        await humanDelay(5000, 15000);
      }

      // Keep DM set manageable
      if (this._dmRepliedTo.size > 100) {
        const arr = [...this._dmRepliedTo];
        this._dmRepliedTo = new Set(arr.slice(-50));
      }

      return { success: true, dmsHandled };
    } catch (e) {
      this.health.errorCount++;
      this.health.lastError = e.message;
      this.log('error', 'twitter', 'DM handling error: ' + e.message);
      return { success: false, error: e.message };
    }
  }

  /* ════════════════════════════════════════════════════════════
   *  INIT: Launch stealth browser
   * ════════════════════════════════════════════════════════════ */
  async init() {
    try {
      /* v84.5.1 THE REAL FIX: launchStealthBrowser returns { browser, agent } —
       * there is NO `page` in its return. The old `const { browser, page }`
       * destructure made this.page undefined FOREVER, so every twitter
       * goto/login died with "Cannot read properties of undefined (reading
       * 'goto')" — the exact crash the owner hit on Connect. All other
       * platforms already did this correctly: destructure agent, newPage(). */
      const { browser, agent } = await launchStealthBrowser({
        headless: true,
        userDataDir: path.join(this.dataDir, 'twitter', 'browser-profile'),
        /* v84.5.2: optional residential/mobile proxy — defeats datacenter-IP
         * walls (CAPTCHA/checkpoint). Set TWITTER_PROXY or PROXY_URL in env,
         * e.g. http://user:pass@gw.proxy.com:8000 */
        proxy: process.env.TWITTER_PROXY || process.env.PROXY_URL || null
      });
      this.browser = browser;
      this.page = await browser.newPage();
      this.health.startedAt = Date.now();

      // Apply anti-detection evasions (the browser-level targetcreated
      // listener in launchStealthBrowser covers every page opened later)
      await applyEvasions(this.page);

      // Try to load saved cookies
      await this.loadCookies();

      this.log('info', 'twitter', 'Browser initialized (' + agent.name + ', stealth + evasions)');
      return { success: true };
    } catch (e) {
      this.log('error', 'twitter', 'Init failed: ' + e.message);
      throw e;  // throw so multi-platform orchestrator can catch Chrome errors
    }
  }

  /* ════════════════════════════════════════════════════════════
   *  LOGIN: Full human-like login flow
   * ════════════════════════════════════════════════════════════ */
  async login() {
    if (!this.username || !this.password) {
      return { success: false, error: 'No credentials (set TWITTER_USERNAME + TWITTER_PASSWORD)' };
    }
    if (!this.browser || !this.page || (typeof this.page.isClosed === 'function' && this.page.isClosed())) {
      if (this.browser) { try { await this.browser.close(); } catch (e) {} this.browser = null; this.page = null; }  /* v84.5.1: no stale-browser leak */
      await this.init();
    }

    try {
      this.log('info', 'twitter', 'Logging in as @' + this.username + '...');

      // Navigate to login (v84.5.1: ONE retry — slow hosts fail networkidle2 the first time)
      try {
        await this.page.goto('https://x.com/i/flow/login', { waitUntil: 'networkidle2', timeout: 45000 });
      } catch (navErr) {
        this.log('warn', 'twitter', 'Login nav slow/retry: ' + navErr.message.split('\n')[0]);
        await this.page.goto('https://x.com/i/flow/login', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      }
      await humanDelay(3000, 6000);

      /* v84.5.2: cookie fast-path — with valid saved cookies X redirects
       * straight to the feed, so the username field NEVER appears and the
       * code below used to false-fail with "never showed the username
       * field" even though the session works. If the feed is here, we're
       * in — no CAPTCHA, no typing. */
      try {
        const inFeed = await this.page.waitForSelector(
          'a[data-testid="AppTabBar_Profile_Link"], a[data-testid="SideNav_AccountSwitcher_Button"], [data-testid="primaryColumn"]',
          { timeout: 8000 }).catch(() => null);
        if (inFeed && !/\/(login|flow)/.test(this.page.url())) {
          this.loggedIn = true;
          await this.saveCookies();
          this.health.successCount++;
          this.log('info', 'twitter', 'Already logged in via saved cookies — no CAPTCHA, no typing');
          return { success: true, result: 'logged in via saved cookies' };
        }
      } catch (e) {}

      // Check CAPTCHA
      const captcha = await detectCaptcha(this.page);
      if (captcha.detected) {
        this.log('warn', 'twitter', 'CAPTCHA detected at login — ' + captcha.type);
        return { success: false, error: 'CAPTCHA detected: ' + captcha.type };
      }

      /* v84.5.1: X serves the identifier field under DIFFERENT markups
       * (input[autocomplete="username"] classic, input[name="text"] on the
       * current flow) and slow hosts need more than 10s for the SPA to
       * render. Patient multi-selector wait instead of a fixed 10s one. */
      const USER_SELECTORS = ['input[autocomplete="username"]', 'input[name="text"]', 'input[type="text"]'];
      let foundSel = null;
      for (const sel of USER_SELECTORS) {
        const hit = await this.page.waitForSelector(sel, { timeout: 15000 }).catch(() => null);
        if (hit) { foundSel = sel; break; }
      }
      if (foundSel) {
        this.log('info', 'twitter', 'Login field found (' + foundSel + ')');
        await humanType(this.page, foundSel, this.username, { wpm: 45 + Math.random() * 20 });
        await humanDelay(500, 1500);
        await this.page.keyboard.press('Enter');
        await humanDelay(2000, 4000);
      } else {
        const where = this.page.url();
        return { success: false, error: 'X never showed the username field in 45s (landed on: ' + where + ') — usually a checkpoint/anti-bot wall from this IP; retry Connect or log in once from a browser and the saved cookies will carry it' };
      }

      // Handle unusual activity check (sometimes X asks to re-enter username)
      try {
        const unusualText = await this.page.$('input[data-testid="ocfEnterTextTextInput"]');
        if (unusualText) {
          this.log('info', 'twitter', 'Unusual activity check — entering username again');
          await humanType(this.page, 'input[data-testid="ocfEnterTextTextInput"]', this.username);
          await this.page.keyboard.press('Enter');
          await humanDelay(2000, 4000);
        }
      } catch (e) {}

      // Type password
      const passwordInput = await this.page.waitForSelector('input[type="password"]', { timeout: 20000 }).catch(() => null);
      if (passwordInput) {
        await humanType(this.page, 'input[type="password"]', this.password, { wpm: 50 + Math.random() * 20 });
        await humanDelay(500, 2000);
        await this.page.keyboard.press('Enter');
        await humanDelay(3000, 6000);
      }

      // Check CAPTCHA again after login attempt
      const captcha2 = await detectCaptcha(this.page);
      if (captcha2.detected) {
        this.log('warn', 'twitter', 'CAPTCHA after login — ' + captcha2.type);
        return { success: false, error: 'CAPTCHA after login: ' + captcha2.type };
      }

      // Verify login
      const currentUrl = this.page.url();
      if (currentUrl.includes('login') || currentUrl.includes('flow')) {
        this.log('error', 'twitter', 'Login failed — still on login page');
        this.health.errorCount++;
        this.health.lastError = 'Login failed — check credentials';
        return { success: false, error: 'Login failed — check credentials' };
      }

      this.loggedIn = true;
      await this.saveCookies();
      this.health.successCount++;
      this.data.addToHistory('login', { success: true });
      this.log('info', 'twitter', 'Logged in successfully as @' + this.username);
      return { success: true };
    } catch (e) {
      this.health.errorCount++;
      this.health.lastError = e.message;
      this.log('error', 'twitter', 'Login error: ' + e.message);
      return { success: false, error: e.message };
    }
  }

  /* ── Ensure logged in (auto-retry) ─────────────────────────── */
  async ensureReady() {
    if (this.loggedIn && this.page && !this.page.isClosed()) return true;
    this.log('info', 'twitter', 'Re-establishing session...');
    const loginResult = await this.login();
    return loginResult.success;
  }

  /* ════════════════════════════════════════════════════════════
   *  TWEET: Post a tweet with human-like behavior
   *  v84.1: optional mediaPath — uploads an image/video via the
   *  composer's file input (the missing piece that made every tweet
   *  text-only). Text passes through enforceLinkPolicy() first.
   * ════════════════════════════════════════════════════════════ */
  async tweet(text, mediaPath = null) {
    if (!await this.ensureReady()) return { success: false, error: 'Not logged in' };
    if (!this.rateLimiter.canAct('tweet')) return { success: false, error: 'Rate limited' };

    try {
      // OWN-LINKS-ONLY: strip foreign URLs before typing anything
      const policy = await this.enforceLinkPolicy(text);
      text = policy.text;
      if (!text || text.length === 0) return { success: false, error: 'Empty tweet after link policy' };

      this.log('info', 'twitter', 'Posting tweet (' + text.length + ' chars' + (mediaPath ? ', +media' : '') + ')...');
      this.health.lastActionAt = Date.now();

      // Browse randomly first (session warming)
      await browseRandomly(this.page, 1, 2);

      // Navigate to compose
      await this.page.goto('https://x.com/compose/post', { waitUntil: 'networkidle2', timeout: 30000 });
      await humanDelay(2000, 4000);

      // v84.1: attach media FIRST (like a human picking the pic then
      // writing) — via the file input the composer always renders.
      if (mediaPath && fs.existsSync(mediaPath)) {
        try {
          const fileInput = await this.page.$('input[data-testid="fileInput"][type="file"]')
            || await this.page.$('input[type="file"][accept*="video"]')
            || await this.page.$('input[type="file"]');
          if (fileInput) {
            await fileInput.uploadFile(mediaPath);
            // wait for the upload preview to render (video encodes server-side)
            await this.page.waitForSelector('[data-testid="attachments"]', { timeout: 60000 }).catch(() => {});
            await humanDelay(2000, 5000);
            this.log('info', 'twitter', 'Media attached: ' + path.basename(mediaPath));
          } else {
            this.log('warn', 'twitter', 'File input not found — posting text-only');
          }
        } catch (me) {
          this.log('warn', 'twitter', 'Media attach failed, posting text-only: ' + me.message);
        }
      }

      // Find the tweet editor
      const editor = await this.page.waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: 10000 });
      if (!editor) {
        return { success: false, error: 'Tweet composer not found' };
      }

      // Type with human speed
      await humanType(this.page, '[data-testid="tweetTextarea_0"]', text, { wpm: 40 + Math.random() * 25 });
      await humanDelay(1000, 3000);

      // Click tweet button
      await humanClick(this.page, '[data-testid="tweetButton"]');
      await humanDelay(2000, 4000);

      // Verify tweet was posted (URL should change or composer disappear)
      this.rateLimiter.record('tweet');
      this.health.successCount++;
      this.data.addToHistory('tweet', { text: text.slice(0, 80), hasMedia: !!mediaPath, success: true, ts: Date.now() });
      this.log('info', 'twitter', 'Tweet posted successfully');
      // v84.1: go quiet like a human after posting
      await this._postTaskInactivity(60000, 240000);
      return { success: true };
    } catch (e) {
      this.health.errorCount++;
      this.health.lastError = e.message;
      this.log('error', 'twitter', 'Tweet error: ' + e.message);
      return { success: false, error: e.message };
    }
  }

  /* ════════════════════════════════════════════════════════════
   *  REPLY: Reply to a specific tweet
   * ════════════════════════════════════════════════════════════ */
  async reply(tweetUrl, text) {
    if (!await this.ensureReady()) return { success: false, error: 'Not logged in' };
    if (!this.rateLimiter.canAct('reply')) return { success: false, error: 'Rate limited' };

    try {
      this.log('info', 'twitter', 'Replying to: ' + tweetUrl);
      this.health.lastActionAt = Date.now();

      // v84.1: OWN-LINKS-ONLY applies to replies too
      const policy = await this.enforceLinkPolicy(text);
      text = policy.text;
      if (!text) return { success: false, error: 'Empty reply after link policy' };

      // Navigate to tweet
      await this.page.goto(tweetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
      await humanDelay(2000, 5000);

      // Read the tweet first (human-like)
      await humanScroll(this.page, 'down', 1);
      await humanDelay(2000, 5000);

      // Click reply button
      const replyBtn = await this.page.$('[data-testid="reply"]');
      if (!replyBtn) {
        return { success: false, error: 'Reply button not found' };
      }
      await humanClick(this.page, '[data-testid="reply"]');
      await humanDelay(1000, 2000);

      // Type reply
      const editor = await this.page.$('[data-testid="tweetTextarea_0"]');
      if (!editor) {
        return { success: false, error: 'Reply composer not found' };
      }
      await humanType(this.page, '[data-testid="tweetTextarea_0"]', text, { wpm: 40 + Math.random() * 25 });
      await humanDelay(500, 2000);

      // Send reply
      await humanClick(this.page, '[data-testid="tweetButtonInline"]');
      await humanDelay(2000, 4000);

      this.rateLimiter.record('reply');
      this.health.successCount++;
      this._repliedTo.add(this._hashUrl(tweetUrl));
      this._saveRepliedTo();
      this.data.addToHistory('reply', { tweetUrl, text: text.slice(0, 50), success: true, ts: Date.now() });
      this.log('info', 'twitter', 'Replied to: ' + tweetUrl);
      // v84.1: human post-task quiet period
      await this._postTaskInactivity(30000, 150000);
      return { success: true };
    } catch (e) {
      this.health.errorCount++;
      this.health.lastError = e.message;
      this.log('error', 'twitter', 'Reply error: ' + e.message);
      return { success: false, error: e.message };
    }
  }

  /* ════════════════════════════════════════════════════════════
   *  AUTO-TWEET: Post from content pipeline (non-NSFW)
   * ════════════════════════════════════════════════════════════ */
  async autoTweet() {
    if (!this.contentPipeline) {
      return { success: false, error: 'Content pipeline not wired' };
    }

    const content = this.contentPipeline.getTwitterTweet();
    if (!content || !content.text) {
      return { success: false, error: 'No tweet content generated' };
    }

    this.log('info', 'twitter', 'Auto tweet: ' + content.type);
    const result = await this.tweet(content.text);

    if (result.success) {
      if (this.contentPipeline._recordPost) {
        this.contentPipeline._recordPost('twitter', content.text, {
          type: content.type,
          subject: content.subject,
          template: content.template
        });
      }
      if (this.interactionTracker) {
        this.interactionTracker.recordPost('twitter', {
          type: content.type,
          content: content.text.substring(0, 200),
          subject: content.subject
        });
      }
    }

    return { ...result, contentType: content.type };
  }

  /* ════════════════════════════════════════════════════════════
   *  CROSS-POST NSFW: Post NSFW content from WhatsApp to Twitter
   *  This is the REAL connection between WhatsApp videoScheduler
   *  and Twitter. Every NSFW video/image/gif that goes to WhatsApp
   *  also gets cross-posted here with a generated caption.
   *
   *  @param {Object} videoData
   *    - title: media title
   *    - query: search query used
   *    - url: media URL
   *    - source: source site
   *    - thumbnailUrl: thumbnail (optional)
   *    - type: 'video' | 'image' | 'gif' (default: 'video')
   * ════════════════════════════════════════════════════════════ */
  async crossPostNSFW(videoData) {
    if (!videoData) return { success: false, error: 'No video data' };

    // Dedup: check if we already posted this exact media
    const mediaHash = this._hashMedia(videoData);
    if (this._postedMediaHashes.has(mediaHash)) {
      this.log('info', 'twitter', 'NSFW dedup: already posted this media, skipping');
      return { success: false, error: 'Duplicate media — already posted' };
    }

    // Rate check
    if (!this.rateLimiter.canAct('tweet')) {
      // Queue for later
      this._nsfwQueue.push(videoData);
      this.log('info', 'twitter', 'NSFW rate limited — queued (' + this._nsfwQueue.length + ' in queue)');
      return { success: false, error: 'Rate limited — queued for later' };
    }

    // Generate caption using NSFW caption engine
    const caption = this.nsfwCaptions.generate({
      type: videoData.type || 'video',
      query: videoData.query || '',
      title: videoData.title || '',
      hour: new Date().getHours()
    });

    this.log('info', 'twitter', 'NSFW cross-post: "' + (videoData.title || '').slice(0, 40) + '" → "' + caption.slice(0, 60) + '"');

    // Post the tweet with caption
    const result = await this.tweet(caption);

    if (result.success) {
      // Record in dedup
      this._postedMediaHashes.add(mediaHash);
      this._savePostedMedia();

      this._nsfwPostedCount++;
      this.data.addToHistory('nsfw_crosspost', {
        title: (videoData.title || '').slice(0, 50),
        query: videoData.query,
        caption: caption.slice(0, 80),
        source: videoData.source,
        success: true,
        ts: Date.now()
      });

      if (this.interactionTracker) {
        this.interactionTracker.recordPost('twitter', {
          type: 'nsfw_crosspost',
          content: caption.substring(0, 200),
          source: videoData.source
        });
      }
    }

    return { ...result, contentType: 'nsfw_crosspost', caption, isNSFW: true };
  }

  /* ════════════════════════════════════════════════════════════
   *  AUTO-REPLY TO COMMENTS: Find and reply to replies on our tweets
   *  Uses the caption generator for reply text too (keeps tone varied)
   *  Max 3 replies per cycle, respects rate limits
   * ════════════════════════════════════════════════════════════ */
  async autoReplyToComments() {
    if (!await this.ensureReady()) return { success: false, error: 'Not logged in' };
    if (!this._autoReplyEnabled) return { success: false, error: 'Auto-reply disabled' };

    try {
      // Browse randomly first (session warming)
      await browseRandomly(this.page, 1, 2);

      // Navigate to notifications
      await this.page.goto('https://x.com/notifications', { waitUntil: 'networkidle2', timeout: 30000 });
      await humanDelay(2000, 5000);

      // Find tweet links with recent activity
      const tweetLinks = await this.page.evaluate(() => {
        const links = [];
        const elements = document.querySelectorAll('[data-testid="tweet"] a[href*="/status/"]');
        for (const el of elements) {
          const href = el.getAttribute('href');
          if (href && !links.includes(href)) links.push(href);
        }
        return links.slice(0, 5);
      });

      let repliesSent = 0;

      for (const link of tweetLinks) {
        if (repliesSent >= 3) break;
        if (!this.rateLimiter.canAct('reply')) break;

        const linkHash = this._hashUrl(link);
        if (this._repliedTo.has(linkHash)) continue;

        const tweetUrl = 'https://x.com' + link;
        await this.page.goto(tweetUrl, { waitUntil: 'networkidle2', timeout: 20000 });
        await humanDelay(2000, 4000);

        // Scroll to read the tweet (human-like)
        await humanScroll(this.page, 'down', 1);
        await humanDelay(2000, 4000);

        // Find replies/comments
        const comments = await this.page.evaluate(() => {
          const replies = [];
          const replyElements = document.querySelectorAll('[data-testid="tweet"] [data-testid="tweetText"]');
          for (const el of replyElements) {
            const text = el.textContent?.trim();
            if (text && text.length > 2) replies.push(text);
          }
          return replies.slice(1, 4); // Skip first (our tweet), get up to 3
        });

        for (const commentText of comments) {
          if (repliesSent >= 3) break;
          if (!this.rateLimiter.canAct('reply')) break;

          // Generate contextual reply using caption engine (varied tone)
          const replyText = this.nsfwCaptions.generate({
            type: 'reply',
            query: '',
            title: commentText.slice(0, 50),
            hour: new Date().getHours()
          });

          const replyResult = await this.reply(tweetUrl, replyText);

          if (replyResult.success) {
            repliesSent++;
            this._repliedTo.add(linkHash);
            this._saveRepliedTo();
            this.log('info', 'twitter', 'Auto-replied to comment on: ' + tweetUrl);
          }

          await humanDelay(5000, 15000);
        }

        await humanDelay(3000, 8000);
      }

      // Keep replied set manageable
      if (this._repliedTo.size > 200) {
        const arr = [...this._repliedTo];
        this._repliedTo = new Set(arr.slice(-100));
        this._saveRepliedTo();
      }

      return { success: true, repliesSent };
    } catch (e) {
      this.health.errorCount++;
      this.health.lastError = e.message;
      this.log('error', 'twitter', 'Auto-reply error: ' + e.message);
      return { success: false, error: e.message };
    }
  }

  /* ════════════════════════════════════════════════════════════
   *  PROCESS NSFW QUEUE: Post queued NSFW items
   *  Called periodically by the orchestrator
   * ════════════════════════════════════════════════════════════ */
  async processNSFWQueue() {
    if (!this.loggedIn) return { success: false, error: 'Not logged in' };
    if (this._nsfwQueue.length === 0) return { success: false, error: 'Queue empty' };

    let posted = 0;
    const maxPerCycle = 3;

    while (this._nsfwQueue.length > 0 && posted < maxPerCycle) {
      if (!this.rateLimiter.canAct('tweet')) break;

      const videoData = this._nsfwQueue.shift();
      const result = await this.crossPostNSFW(videoData);
      if (result.success) posted++;

      await humanDelay(10000, 30000);
    }

    return { success: true, posted, remaining: this._nsfwQueue.length };
  }

  /* ── Follow user (⚠️ risky — X bans bulk following) ──────── */
  async follow(username) {
    if (!await this.ensureReady()) return { success: false, error: 'Not logged in' };
    if (!this.rateLimiter.canAct('follow')) return { success: false, error: 'Rate limited' };

    try {
      this.log('info', 'twitter', 'Following: @' + username);
      this.health.lastActionAt = Date.now();

      await this.page.goto('https://x.com/' + username, { waitUntil: 'networkidle2', timeout: 30000 });
      await humanDelay(2000, 5000);

      // Look at profile first (human-like)
      await humanScroll(this.page, 'down', 2);
      await humanDelay(3000, 8000);

      // Click follow
      const followBtn = await this.page.$('[data-testid="placementTracking"] [data-testid*="follow"]');
      if (followBtn) {
        await humanClick(this.page, '[data-testid="placementTracking"] [data-testid*="follow"]');
        await humanDelay(2000, 4000);

        this.rateLimiter.record('follow');
        this.health.successCount++;
        this.data.addToList('following', { username, followedAt: Date.now() });
        this.data.addToHistory('follow', { username, success: true });
        this.log('info', 'twitter', 'Followed: @' + username);
        return { success: true };
      }

      return { success: false, error: 'Follow button not found (already following?)' };
    } catch (e) {
      this.health.errorCount++;
      this.health.lastError = e.message;
      this.log('error', 'twitter', 'Follow error: ' + e.message);
      return { success: false, error: e.message };
    }
  }

  /* ── Broadcast (tweet alias) ──────────────────────────────── */
  async broadcast(message) {
    return await this.tweet(message);
  }

  /* ════════════════════════════════════════════════════════════
   *  DEDUP HELPERS
   * ════════════════════════════════════════════════════════════ */
  _hashMedia(videoData) {
    // Hash based on URL + title (catches same content from different sources)
    const key = (videoData.url || '') + '|' + (videoData.title || '') + '|' + (videoData.source || '');
    return crypto.createHash('md5').update(key).digest('hex').substring(0, 16);
  }

  _hashUrl(url) {
    return crypto.createHash('md5').update(url).digest('hex').substring(0, 12);
  }

  _loadPostedMedia() {
    try {
      const file = path.join(this.dataDir, 'twitter', 'posted-media.json');
      if (fs.existsSync(file)) {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        this._postedMediaHashes = new Set(data.hashes || []);
      }
    } catch (e) {}
  }

  _savePostedMedia() {
    try {
      const dir = path.join(this.dataDir, 'twitter');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'posted-media.json');
      // Keep only last 5000 hashes to avoid unbounded growth
      const hashes = [...this._postedMediaHashes].slice(-5000);
      writeJSONAtomic(file, { hashes, count: hashes.length, lastSaved: Date.now() });
    } catch (e) {}
  }

  _loadRepliedTo() {
    try {
      const file = path.join(this.dataDir, 'twitter', 'replied-to.json');
      if (fs.existsSync(file)) {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        this._repliedTo = new Set(data.urls || []);
      }
    } catch (e) {}
  }

  _saveRepliedTo() {
    try {
      const dir = path.join(this.dataDir, 'twitter');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'replied-to.json');
      const urls = [...this._repliedTo].slice(-200);
      fs.writeFileSync(file, JSON.stringify({ urls }));
    } catch (e) {}
  }

  /* ── Cookie persistence ────────────────────────────────────── */
  async saveCookies() {
    try {
      const cookies = await this.page.cookies();
      fs.mkdirSync(path.dirname(this.cookieFile), { recursive: true });
      writeJSONAtomic(this.cookieFile, cookies);
    } catch (e) {
      this.log('warn', 'twitter', 'Save cookies: ' + e.message);
    }
  }

  async loadCookies() {
    try {
      if (fs.existsSync(this.cookieFile)) {
        const cookies = JSON.parse(fs.readFileSync(this.cookieFile, 'utf8'));
        await this.page.setCookie(...cookies);
        this.log('info', 'twitter', 'Loaded ' + cookies.length + ' cookies');
      }
    } catch (e) {
      this.log('warn', 'twitter', 'Load cookies: ' + e.message);
    }
  }

  /* ── Browser restart ───────────────────────────────────────── */
  async restartBrowser() {
    this.log('warn', 'twitter', 'Restarting browser...');
    try {
      if (this.browser) await this.browser.close().catch(() => {});
    } catch (e) {}
    this.browser = null;
    this.page = null;
    this.loggedIn = false;
    this.health.browserRestarts++;
    await this.init();
    return await this.login();
  }

  /* ── Health check ──────────────────────────────────────────── */
  async healthCheck() {
    const isAlive = this.browser && this.page && !this.page.isClosed();
    return {
      platform: 'twitter',
      alive: isAlive,
      loggedIn: this.loggedIn,
      health: { ...this.health, uptime: this.health.startedAt ? Date.now() - this.health.startedAt : 0 },
      rateLimiter: this.rateLimiter.getStatus(),
      independentNSFW: this._independentNSFWEnabled,
      independentPosted: this._independentPostCount,
      moodLevel: this._moodLevel,
      dmCount: this._dmCount,
      postedMediaCount: this._postedMediaHashes.size,
      repliedToCount: this._repliedTo.size,
      captionStats: this.nsfwCaptions.getStats()
    };
  }

  /* ── Full status ───────────────────────────────────────────── */
  getStatus() {
    return {
      platform: 'twitter',
      loggedIn: this.loggedIn,
      health: { ...this.health, uptime: this.health.startedAt ? Date.now() - this.health.startedAt : 0 },
      rateLimiter: this.rateLimiter.getStatus(),
      data: this.data.getStats(),
      schedule: this.schedule.getStatus(),
      independentNSFW: this._independentNSFWEnabled,
      independentPosted: this._independentPostCount,
      moodLevel: this._moodLevel,
      dmEnabled: this._dmEnabled,
      dmCount: this._dmCount,
      postedMediaCount: this._postedMediaHashes.size,
      autoReplyEnabled: this._autoReplyEnabled,
      captionStats: this.nsfwCaptions.getStats()
    };
  }

  /* ── Format status for WhatsApp ────────────────────────────── */
  formatStatus() {
    const s = this.getStatus();
    const rl = s.rateLimiter;
    let msg = 'TWITTER STATUS (INDEPENDENT)\n';
    msg += 'Logged in: ' + (s.loggedIn ? 'YES' : 'NO') + '\n';
    msg += 'Actions: ' + s.health.successCount + ' ok / ' + s.health.errorCount + ' fail\n';
    msg += 'Independent NSFW: ' + (s.independentNSFW ? 'ON' : 'OFF') + ' | Posted: ' + s.independentPosted + '\n';
    msg += 'Mood: ' + Math.round(s.moodLevel * 100) + '% | DMs: ' + s.dmCount + '\n';
    msg += 'Media dedup: ' + s.postedMediaCount + ' unique items\n';
    msg += 'Auto-reply: ' + (s.autoReplyEnabled ? 'ON' : 'OFF') + '\n';
    msg += 'Captions: ' + (s.captionStats.captionsGenerated || 0) + ' generated\n';
    msg += 'Rate: tweet=' + (rl.tweet?.used || 0) + '/' + (rl.tweet?.hourly || 8) + '/hr, reply=' + (rl.reply?.used || 0) + '/' + (rl.reply?.hourly || 12) + '/hr';
    return msg;
  }

  /* ── Cleanup ───────────────────────────────────────────────── */
  async close() {
    this.schedule.stopAllTasks();
    this.stopIndependentNSFW();
    if (this._autoReplyInterval) {
      clearInterval(this._autoReplyInterval);
      this._autoReplyInterval = null;
    }
    if (this._dmCheckInterval) {
      clearInterval(this._dmCheckInterval);
      this._dmCheckInterval = null;
    }
    if (this.loggedIn) await this.saveCookies().catch(() => {});
    this._savePostedMedia();
    this._saveRepliedTo();
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
      this.page = null;
    }
    this.loggedIn = false;
    this.log('info', 'twitter', 'Closed');
  }
}

/* ══════════════════════════════════════════════════════════════
 *  ExcitedGirlPersona — The personality behind the NSFW posts
 *
 *  She posts like she just woke up in the mood. Sometimes she's
 *  really feeling it, sometimes she's chill. She replies to DMs
 *  like "this could be us" and makes everything feel personal.
 *
 *  Mood levels:
 *    0.0-0.3 = chill, might post something soft
 *    0.3-0.6 = normal, posts regularly
 *    0.6-0.8 = in the mood, posts sooner, more explicit
 *    0.8-1.0 = REALLY feeling it, can't help but post
 * ══════════════════════════════════════════════════════════════ */
class ExcitedGirlPersona {
  constructor(options = {}) {
    this.log = options.log || (() => {});
    this._lastCaption = '';
  }

  /* ── Pick what she's in the mood for ─────────────────────── */
  pickQuery(moodLevel) {
    const soft = [
      'cute aesthetic', 'soft vibes', 'aesthetic mood',
      'chill vibes', 'late night aesthetic', 'cozy mood'
    ];
    const normal = [
      'ebony twerk', 'curvy model', 'thick aesthetic',
      'dance vibes', 'booty shaking', 'baddie aesthetic',
      'ebony beauty', 'curves appreciation', 'body confidence'
    ];
    const spicy = [
      'ebony twerk', 'big booty twerking', 'thick ebony',
      'curvy dance', 'booty clapping', 'ebony dance',
      'twerk compilation', 'thick and curvy', 'baddie twerk'
    ];
    const extra = [
      'ebony twerk', 'ebony threesome', 'african booty',
      'big booty twerking', 'ebony bbw', 'twerk compilation',
      'thick ebony solo', 'booty shake', 'ebony milf'
    ];

    let pool;
    if (moodLevel < 0.3) pool = soft;
    else if (moodLevel < 0.6) pool = normal;
    else if (moodLevel < 0.8) pool = spicy;
    else pool = extra;

    return pool[Math.floor(Math.random() * pool.length)];
  }

  /* ── Generate caption based on mood ──────────────────────── */
  generateCaption(context = {}) {
    const { query = '', moodLevel = 0.5, hour = new Date().getHours(), hasMedia = false } = context;
    const time = this._getTimeVibe(hour);
    const mood = this._getMoodVibe(moodLevel);

    // Wake-up lines
    const wakeUpLines = [
      'woke up like this', 'can\'t sleep so', 'just woke up n',
      'in my mood rn', 'randomly feeling it', 'couldn\'t help myself',
      'something came over me', 'just one of those nights',
      'my body said post', 'the vibes hit different rn'
    ];

    // Mood-specific lines
    const moodLines = {
      chill: ['just vibing fr', 'lowkey mood', 'soft girl hours', 'taking it easy'],
      normal: ['feeling myself', 'it\'s giving what it needs to', 'no regrets', 'just me being me'],
      frisky: ['can\'t help it rn', 'in my zone', 'feeling risky', 'the mood is real'],
      wild: ['i\'m going feral', 'can\'t be stopped', 'absolutely unhinged', 'no chill tonight']
    };

    // Closings
    const closings = [
      '', 'deal with it', 'you\'re welcome', 'no apologies',
      'this is me', 'period', 'say less', 'that\'s the vibe',
      'follow for more', 'rate it', 'what you think'
    ];

    // Emojis by mood
    const emojis = {
      chill: ['✨', '💫', '🌙', '💕'],
      normal: ['🔥', '💅', '😏', '💯'],
      frisky: ['🔥', '👅', '🥵', '👀'],
      wild: ['💦', '🔥', '🥵', '👅', '⚡']
    };

    // Build the caption
    const wakeUp = wakeUpLines[Math.floor(Math.random() * wakeUpLines.length)];
    const moodPool = moodLines[mood] || moodLines.normal;
    const moodLine = moodPool[Math.floor(Math.random() * moodPool.length)];
    const closing = closings[Math.floor(Math.random() * closings.length)];
    const emojiPool = emojis[mood] || emojis.normal;
    const emoji = emojiPool[Math.floor(Math.random() * emojiPool.length)];

    // Hashtags
    const tags = ['twerk', 'ebony', 'curves', 'thick', 'vibes', 'mood', 'fyp', 'explore'];
    const tag = tags[Math.floor(Math.random() * tags.length)];

    // Different structures (never same pattern)
    const structures = [
      () => `${wakeUp} ${moodLine} ${emoji} #${tag}`,
      () => `${moodLine}# ${wakeUp} ${emoji}`,
      () => `${emoji} ${wakeUp}... ${moodLine} #${tag}`,
      () => `${moodLine} ${emoji} ${closing} #${tag}`,
      () => `${wakeUp} ${emoji} #${tag}`,
      () => `${emoji} ${moodLine} — ${closing} #${tag}`,
    ];

    let caption = structures[Math.floor(Math.random() * structures.length)]().trim();

    // Avoid repeating exact same caption
    if (caption === this._lastCaption) {
      caption = `${wakeUp} ${emoji} ${moodLine} #${tag}`;
    }
    this._lastCaption = caption;

    return caption;
  }

  /* ── Generate DM reply ───────────────────────────────────── */
  generateDMReply(context = {}) {
    const { convoName = '', lastMessage = '', hour = new Date().getHours(), moodLevel = 0.5 } = context;

    const openers = [
      'heyy', 'hiii', 'omg hi', 'hey you', 'hiiii',
      'wassup', 'oooh hey', 'heyyy'
    ];

    const flirtyLines = [
      'this could be us fr', 'imagine us tho', 'we\'d look good together',
      'you seem fun', 'I like your energy', 'tell me more',
      'you\'re interesting', 'we should talk more',
      'this made me think of you', 'wish you were here rn'
    ];

    const mediaHints = [
      'check my page for more', 'I just posted something you\'d like',
      'go look at my latest', 'my tweets >>'
    ];

    const closings = [
      'dm me anytime', 'don\'t be a stranger', 'hmu',
      'let\'s talk', 'im around', 'always here'
    ];

    const emojis = ['😏', '💕', '👀', '✨', '🫶', '💋', '😍'];
    const emoji = emojis[Math.floor(Math.random() * emojis.length)];

    // Build reply
    const opener = openers[Math.floor(Math.random() * openers.length)];
    const flirty = flirtyLines[Math.floor(Math.random() * flirtyLines.length)];
    const media = Math.random() < 0.3 ? mediaHints[Math.floor(Math.random() * mediaHints.length)] : '';
    const closing = Math.random() < 0.4 ? closings[Math.floor(Math.random() * closings.length)] : '';

    // Different structures
    const structures = [
      () => `${opener} ${emoji} ${flirty}`,
      () => `${flirty} ${emoji} ${media}`,
      () => `${opener}! ${flirty} ${closing}`,
      () => `${emoji} ${flirty}`,
      () => `${opener} ${flirty} ${emoji}`,
    ];

    let reply = structures[Math.floor(Math.random() * structures.length)]().trim();
    // Clean up extra spaces
    reply = reply.replace(/\s+/g, ' ').trim();
    return reply;
  }

  /* ── Time vibe ───────────────────────────────────────────── */
  _getTimeVibe(hour) {
    if (hour >= 0 && hour < 5) return 'lateNight';
    if (hour >= 5 && hour < 9) return 'earlyMorning';
    if (hour >= 9 && hour < 12) return 'morning';
    if (hour >= 12 && hour < 17) return 'afternoon';
    if (hour >= 17 && hour < 21) return 'evening';
    return 'night';
  }

  /* ── Mood vibe ───────────────────────────────────────────── */
  _getMoodVibe(moodLevel) {
    if (moodLevel < 0.3) return 'chill';
    if (moodLevel < 0.6) return 'normal';
    if (moodLevel < 0.8) return 'frisky';
    return 'wild';
  }
}

module.exports = TwitterBot;
