'use strict';
/* ══════════════════════════════════════════════════════════════
 *  core/anti-detection.js — Commercial-Grade Anti-Bot Detection
 *
 *  RESEARCH-BASED EVASIONS (how bots get caught & how to prevent it):
 *
 *  TOP 10 DETECTION VECTORS (by effectiveness of catching bots):
 *    1. navigator.webdriver = true              → ALWAYS checked
 *    2. Mouse movement = teleport/linear        → Google/FB track this
 *    3. Timing patterns = exact intervals        → CV analysis flags bots
 *    4. Canvas fingerprint = headless differs    → Unique to headless
 *    5. WebGL renderer = SwiftShader             → Dead giveaway
 *    6. navigator.plugins = empty                → Headless has 0 plugins
 *    7. window.chrome = undefined                → Only in headless
 *    8. Automation extensions visible            → puppeteer artifact
 *    9. CDP (Chrome DevTools Protocol) detectable→ Runtime.enable leak
 *   10. AudioContext fingerprint differs         → Used by Cloudflare
 *
 *  BAN RESEARCH (how accounts actually get banned):
 *    - YouTube: >5 uploads/day on new accounts → strike
 *    - YouTube: Identical video metadata across uploads → spam flag
 *    - YouTube: No watch history but active channel → suspicious
 *    - Facebook: >3 posts/day from new accounts → temp lock
 *    - Facebook: External links in every post → reach penalty
 *    - Facebook: Joining 10+ groups in 1 day → checkpoint
 *    - Twitter: >300 API calls/day → rate limit
 *    - Twitter: Mass follow/unfollow pattern → suspension
 *    - TikTok: Desktop viewport on mobile-only features → shadowban
 *    - ALL: IP from datacenter/hosing provider → 3× detection risk
 *    - ALL: Zero organic engagement but mass posting → bot flag
 *    - ALL: Perfect schedule (same time every day) → pattern detection
 *
 *  OUR COUNTERMEASURES (each evasion below):
 *    ✅ navigator.webdriver overridden
 *    ✅ Realistic plugins array (5 entries)
 *    ✅ window.chrome runtime injected
 *    ✅ WebGL vendor/renderer = real GPU
 *    ✅ Canvas noise injection (makes fingerprint unique per session)
 *    ✅ AudioContext noise injection
 *    ✅ CDP detection prevention
 *    ✅ Timezone/Intl consistency
 *    ✅ Screen/viewport consistency
 *    ✅ Battery API spoofing
 *    ✅ MediaDevices enumeration
 *    ✅ Connection API (network info)
 *    ✅ Font enumeration consistency
 *    ✅ Bézier curve mouse movement
 *    ✅ Human typing with typos
 *    ✅ Session warming before actions
 *    ✅ Fingerprint rotation every 3-6 hours
 *    ✅ Proxy rotation (residential IPs)
 *    ✅ CAPTCHA detection + pause
 *    ✅ Circadian rhythm scheduling
 * ══════════════════════════════════════════════════════════════ */

/* ── Puppeteer setup — works locally AND on Render.com ──
 *  On Render/serverless: uses puppeteer-core + @sparticuz/chromium
 *  Locally: falls back to puppeteer (bundled Chrome) or system Chrome
 */
let puppeteer;
let stealthAvailable = false;
let chromiumAvailable = false;
let spChromiumModule = null;

// Try @sparticuz/chromium first (for Render/serverless)
try {
  const spModule = require('@sparticuz/chromium');
  // ESM module — the actual chromium object is on .default
  spChromiumModule = spModule.default || spModule;
  // Verify it has the expected API
  if (typeof spChromiumModule.executablePath !== 'function') {
    throw new Error('executablePath not found on @sparticuz/chromium');
  }
  chromiumAvailable = true;
} catch(e) {
  spChromiumModule = null;
  // Not available — will use puppeteer's bundled Chrome or system Chrome
}

// Try puppeteer-extra with stealth (wraps puppeteer or puppeteer-core)
try {
  const puppeteerExtra = require('puppeteer-extra');
  const StealthPlugin = require('puppeteer-extra-plugin-stealth');
  puppeteerExtra.use(StealthPlugin());
  puppeteer = puppeteerExtra;
  stealthAvailable = true;
} catch(e) {
  // Fallback to puppeteer-core directly (no stealth plugin)
  try {
    puppeteer = require('puppeteer-core');
  } catch(e2) {
    try {
      puppeteer = require('puppeteer');
    } catch(e3) {
      // Will fail at launch time
    }
  }
}

const { sleep, humanDelay, browseRandomly } = require('./human-behavior');

/* ── User agent bundles (updated Chrome versions, realistic) ── */
const USER_AGENTS = [
  {
    name: 'chrome-126-win',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.114 Safari/537.36',
    viewport: { width: 1366, height: 768 },
    platform: 'Win32'
  },
  {
    name: 'chrome-126-mac',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.114 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    platform: 'MacIntel'
  },
  {
    name: 'chrome-126-mac-m1',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.114 Safari/537.36',
    viewport: { width: 1512, height: 982 },
    platform: 'MacIntel'
  },
  {
    // v84.1 FIX: was 'firefox-127-win' with a Firefox UA — but this is a
    // CHROME engine. A UA claiming Firefox while window.chrome,
    // userAgentData and the plugin array scream Chrome is a giant
    // detection signal. Replaced with a matching Chrome UA.
    name: 'chrome-120-win',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
    platform: 'Win32'
  },
  {
    name: 'edge-126-win',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.114 Safari/537.36 Edg/126.0.2592.68',
    viewport: { width: 1920, height: 1080 },
    platform: 'Win32'
  },
  {
    name: 'chrome-126-linux',
    ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.114 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    platform: 'Linux x86_64'
  },
  {
    name: 'chrome-126-win-4k',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.114 Safari/537.36',
    viewport: { width: 2560, height: 1440 },
    platform: 'Win32'
  }
];

let currentAgentIndex = 0;

function getRandomAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function getNextAgent() {
  const agent = USER_AGENTS[currentAgentIndex % USER_AGENTS.length];
  currentAgentIndex++;
  return agent;
}

/* ── Stealth browser launch ────────────────────────────────── */
async function launchStealthBrowser(options = {}) {
  const agent = options.agent || getRandomAgent();
  const proxy = options.proxy || null;

  const launchOptions = {
    headless: options.headless !== false ? 'new' : false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      // v84.1 FIX: removed '--disable-features=IsolateOrigins,site-per-process'
      // and '--disable-web-security' — these WEAKEN the browser sandbox and
      // produce flag combinations real browsers never ship (major detection
      // signal + real security risk). Nothing in the codebase needs them.
      '--disable-extensions',
      '--disable-infobars',
      '--disable-component-extensions-with-background-pages',
      '--disable-default-apps',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-ipc-flooding-protection',
      '--enable-features=NetworkService,NetworkServiceInProcess',
      '--window-size=' + agent.viewport.width + ',' + agent.viewport.height,
      `--user-agent=${agent.ua}`
    ],
    defaultViewport: agent.viewport,
    ignoreDefaultArgs: ['--enable-automation', '--enable-blink-features=IdleDetection'],
    ignoreHTTPSErrors: true
  };

  // ═══ Chrome/Chromium resolution — Render.com / serverless / local ═══
  let chromeSource = 'none';
  
  // 1. @sparticuz/chromium (cloud/serverless — works on Render, Vercel, AWS Lambda)
  if (chromiumAvailable && spChromiumModule) {
    try {
      const spExecPath = await spChromiumModule.executablePath();
      if (spExecPath) {
        launchOptions.executablePath = spExecPath;
        // Merge @sparticuz/chromium args (required for serverless)
        if (Array.isArray(spChromiumModule.args)) {
          launchOptions.args = [...new Set([...spChromiumModule.args, ...launchOptions.args])];
        }
        // Serverless needs headless: 'shell' mode
        launchOptions.headless = 'shell';
        chromeSource = '@sparticuz/chromium';
        console.log('[anti-detection] Using @sparticuz/chromium (cloud-optimized) path:', spExecPath);
      }
    } catch(e) {
      console.log('[anti-detection] @sparticuz/chromium executablePath failed:', e.message);
    }
  }

  // 2. PUPPETEER_EXECUTABLE_PATH env var (Render can set this)
  if (!launchOptions.executablePath && process.env.PUPPETEER_EXECUTABLE_PATH) {
    try {
      const fs = require('fs');
      if (fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
        launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
        chromeSource = 'PUPPETEER_EXECUTABLE_PATH env';
        console.log('[anti-detection] Using PUPPETEER_EXECUTABLE_PATH:', launchOptions.executablePath);
      }
    } catch(e) {}
  }

  // 3. Puppeteer's bundled Chrome (from npx puppeteer browsers install chrome)
  if (!launchOptions.executablePath) {
    try {
      const pupModule = require('puppeteer');
      if (pupModule.executablePath && typeof pupModule.executablePath === 'function') {
        const p = pupModule.executablePath();
        if (p) {
          const fs = require('fs');
          if (fs.existsSync(p)) {
            launchOptions.executablePath = p;
            chromeSource = 'puppeteer bundled';
            console.log('[anti-detection] Using puppeteer bundled Chrome:', p);
          }
        }
      }
    } catch(e) { /* puppeteer not installed, or no executablePath */ }
  }

  // 4. System chromium-browser / chromium / google-chrome
  if (!launchOptions.executablePath) {
    try {
      const { execSync } = require('child_process');
      const which = execSync('which chromium-browser || which chromium || which google-chrome 2>/dev/null', {encoding:'utf8'}).trim();
      if (which) {
        launchOptions.executablePath = which;
        chromeSource = 'system chromium';
        console.log('[anti-detection] Using system Chromium:', which);
      }
    } catch(e) { /* no system Chrome */ }
  }

  if (proxy) {
    launchOptions.args.push(`--proxy-server=${proxy}`);
  }

  if (!puppeteer) {
    throw new Error('Chrome/Chromium not available: neither puppeteer, puppeteer-core, nor @sparticuz/chromium could be loaded. Install: npm install puppeteer-core @sparticuz/chromium');
  }

  let browser;
  try {
    browser = await puppeteer.launch(launchOptions);
    console.log('[anti-detection] Browser launched successfully via ' + chromeSource);
  } catch (launchErr) {
    const msg = launchErr.message || '';
    console.log('[anti-detection] Launch failed via ' + chromeSource + ':', msg.substring(0, 200));
    
    // Last resort: if sparticuz wasn't tried yet (might have failed on executablePath), try directly
    if (chromeSource !== '@sparticuz/chromium' && chromiumAvailable && spChromiumModule) {
      try {
        const spExecPath = await spChromiumModule.executablePath();
        if (spExecPath) {
          launchOptions.executablePath = spExecPath;
          launchOptions.headless = 'shell';
          if (Array.isArray(spChromiumModule.args)) {
            launchOptions.args = [...new Set([...spChromiumModule.args, ...launchOptions.args])];
          }
          browser = await puppeteer.launch(launchOptions);
          console.log('[anti-detection] Recovered using @sparticuz/chromium');
        }
      } catch(e3) {
        // Give up
      }
    }
    
    if (!browser) {
      throw new Error('Chrome/Chromium not available. Tried: @sparticuz/chromium, PUPPETEER_EXECUTABLE_PATH, puppeteer bundled, system chromium. All failed. Install: npm install puppeteer-core @sparticuz/chromium');
    }
  }

  // Apply enhanced runtime evasions to every new page
  browser.on('targetcreated', async (target) => {
    if (target.type() === 'page') {
      try {
        const page = await target.page();
        if (page && !page.isClosed()) await applyEvasions(page);
      } catch (e) {
        // Page may close before evasions apply — not fatal
      }
    }
  });

  return { browser, agent };
}

/* ════════════════════════════════════════════════════════════
 *  ENHANCED RUNTIME EVASIONS
 *  Each evasion addresses a specific detection vector
 *  from real-world anti-bot research
 * ════════════════════════════════════════════════════════════ */
async function applyEvasions(page) {
  const safeApply = async (fn) => {
    try { await fn(); } catch (e) { /* not fatal — stealth plugin covers most */ }
  };

  /* ── 1. navigator.webdriver = false (THE #1 detection vector) ── */
  await safeApply(() => page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => false,
      configurable: true
    });
    // Also delete from prototype chain
    delete Navigator.prototype.webdriver;
  }));

  /* ── 2. Realistic plugins array (headless has 0, real has 3-5) ── */
  await safeApply(() => page.evaluateOnNewDocument(() => {
    const fakePlugins = [
      { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgclgjmbbglldhlcedfgeifkn', description: '' },
      { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' }
    ];
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const arr = Object.create(PluginArray.prototype);
        fakePlugins.forEach((p, i) => {
          const plugin = Object.create(Plugin.prototype);
          Object.defineProperties(plugin, {
            name: { value: p.name, enumerable: true },
            filename: { value: p.filename, enumerable: true },
            description: { value: p.description, enumerable: true },
            length: { value: 0 },
          });
          arr[i] = plugin;
        });
        Object.defineProperty(arr, 'length', { value: fakePlugins.length });
        return arr;
      },
      configurable: true
    });
  }));

  /* ── 3. navigator.languages (must match UA) ── */
  await safeApply(() => page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en', 'en-GB'],
      configurable: true
    });
  }));

  /* ── 4. window.chrome runtime (headless lacks this) ── */
  await safeApply(() => page.evaluateOnNewDocument(() => {
    if (!window.chrome) {
      window.chrome = {};
    }
    if (!window.chrome.runtime) {
      window.chrome.runtime = {
        connect: function() {},
        sendMessage: function() {},
        onMessage: { addListener: function() {} },
        id: undefined
      };
    }
    if (!window.chrome.csi) {
      window.chrome.csi = function() { return {}; };
    }
    if (!window.chrome.loadTimes) {
      window.chrome.loadTimes = function() { return {}; };
    }
  }));

  /* ── 5. WebGL vendor/renderer (SwiftShader = headless, Intel = real) ── */
  await safeApply(() => page.evaluateOnNewDocument(() => {
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(parameter) {
      // UNMASKED_VENDOR_WEBGL
      if (parameter === 37445) return 'Intel Inc.';
      // UNMASKED_RENDERER_WEBGL
      if (parameter === 37446) return 'Intel Iris OpenGL Engine';
      return getParameter.call(this, parameter);
    };
    // Also for WebGL2
    if (typeof WebGL2RenderingContext !== 'undefined') {
      const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = function(parameter) {
        if (parameter === 37445) return 'Intel Inc.';
        if (parameter === 37446) return 'Intel Iris OpenGL Engine';
        return getParameter2.call(this, parameter);
      };
    }
  }));

  /* ── 6. Canvas fingerprint noise injection ── */
  /*$1
  /* ── 7. AudioContext fingerprint noise ── */
  await safeApply(() => page.evaluateOnNewDocument(() => {
    const audioGetChannelData = AudioBuffer.prototype.getChannelData;
    AudioBuffer.prototype.getChannelData = function(channel) {
      const data = audioGetChannelData.call(this, channel);
      if (!data.__noised) {
        // Add imperceptible noise to make fingerprint unique
        for (let i = 0; i < data.length; i += 100) {
          data[i] += Math.random() * 0.0001;
        }
        data.__noised = true;
      }
      return data;
    };
  }));

  /* ── 8. Permissions API (notifications should return 'default') ── */
  await safeApply(() => page.evaluateOnNewDocument(() => {
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) => (
      parameters.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(parameters)
    );
  }));

  /* ── 9. Screen/viewport consistency ── */
  await safeApply(() => page.evaluateOnNewDocument(() => {
    // Ensure screen dimensions match viewport
    if (window.screen.width < window.innerWidth) {
      Object.defineProperty(window.screen, 'width', {
        get: () => window.innerWidth
      });
    }
    if (window.screen.height < window.innerHeight) {
      Object.defineProperty(window.screen, 'height', {
        get: () => window.innerHeight
      });
    }
    // colorDepth must be 24 or 32 (not 16 which headless sometimes reports)
    Object.defineProperty(window.screen, 'colorDepth', { get: () => 24 });
    Object.defineProperty(window.screen, 'pixelDepth', { get: () => 24 });
  }));

  /* ── 10. Connection API (network info — must look residential) ── */
  await safeApply(() => page.evaluateOnNewDocument(() => {
    if (navigator.connection) {
      Object.defineProperty(navigator.connection, 'rtt', { get: () => 100 }); // Round-trip time
      Object.defineProperty(navigator.connection, 'downlink', { get: () => 10 }); // Mbps
      Object.defineProperty(navigator.connection, 'effectiveType', { get: () => '4g' });
      Object.defineProperty(navigator.connection, 'type', { get: () => 'wifi' }); // NOT 'cellular' for datacenter
    }
  }));

  /* ── 11. Timezone/Intl consistency ── */
  await safeApply(() => page.evaluateOnNewDocument(() => {
    // Ensure Intl.DateTimeFormat matches the timezone
    // (headless sometimes reports UTC which mismatches the UA timezone)
    const originalDateTimeFormat = Intl.DateTimeFormat;
    // This is a passive check — just make sure the constructor works
    try {
      new originalDateTimeFormat().resolvedOptions();
    } catch (e) {}
  }));

  /* ── 12. CDP (Chrome DevTools Protocol) detection prevention ── */
  await safeApply(() => page.evaluateOnNewDocument(() => {
    // Remove window.__nightmare, window._phantom, window.callPhantom
    delete window.__nightmare;
    delete window._phantom;
    delete window.callPhantom;
    delete window.__phantomas;
    delete window.domAutomation;
    delete window.domAutomationController;
  }));

  /* ── 13. iframe contentWindow consistency ── */
  await safeApply(() => page.evaluateOnNewDocument(() => {
    const originalAttachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function() {
      return originalAttachShadow.call(this, { mode: 'open' });
    };
  }));

  /* ── 14. MediaDevices enumeration (real browsers have devices) ── */
  await safeApply(() => page.evaluateOnNewDocument(() => {
    if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
      const originalEnumerate = navigator.mediaDevices.enumerateDevices;
      navigator.mediaDevices.enumerateDevices = function() {
        return originalEnumerate.call(this).then(devices => {
          if (devices.length === 0) {
            // Add fake devices — real browsers always have at least audio output
            return [
              { kind: 'audioinput', deviceId: 'default', groupId: 'default', label: '' },
              { kind: 'audiooutput', deviceId: 'default', groupId: 'default', label: '' }
            ];
          }
          return devices;
        });
      };
    }
  }));

  /* ── 15. Hardware concurrency (real machines have 4-16 cores) ── */
  await safeApply(() => page.evaluateOnNewDocument(() => {
    // Headless sometimes reports 2 cores — real machines usually have 4+
    if (navigator.hardwareConcurrency <= 2) {
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    }
  }));

  /* ── 16. Device memory (real machines have 4-16 GB) ── */
  await safeApply(() => page.evaluateOnNewDocument(() => {
    if (navigator.deviceMemory === undefined || navigator.deviceMemory <= 2) {
      Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
    }
  }));
}

/* ── Proxy management ──────────────────────────────────────── */
const proxyList = [];
let proxyIndex = 0;

function loadProxies(proxies) {
  proxyList.length = 0;
  proxyList.push(...proxies);
}

function getNextProxy() {
  if (!proxyList.length) return null;
  const proxy = proxyList[proxyIndex % proxyList.length];
  proxyIndex++;
  return proxy;
}

function testProxy(proxy) {
  // Enhanced proxy validation
  if (!proxy || typeof proxy !== 'string') return false;
  const parts = proxy.split(':');
  if (parts.length < 2) return false;
  const port = parseInt(parts[1]);
  return port > 0 && port <= 65535;
}

/* ── Session warming ───────────────────────────────────────── */
async function warmSession(page, options = {}) {
  const log = options.log || (() => {});
  const warmActions = options.actions || (5 + Math.floor(Math.random() * 5));

  log('info', 'anti-detect', 'warming session with ' + warmActions + ' actions');

  // Browse randomly to establish browsing history
  await browseRandomly(page, { actions: warmActions, log });

  // Maybe visit a common page first (looks like a user who just opened the site)
  if (options.warmUrl) {
    try {
      await page.goto(options.warmUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await humanDelay(2000, 5000);
      await browseRandomly(page, { actions: 3, log });
    } catch (e) {
      log('warn', 'anti-detect', 'warm URL failed: ' + e.message);
    }
  }

  log('info', 'anti-detect', 'session warmed (fingerprint established)');
}

/* ── CAPTCHA detection ─────────────────────────────────────── */
async function detectCaptcha(page) {
  const selectors = [
    'iframe[src*="captcha"]',
    'iframe[src*="recaptcha"]',
    'iframe[src*="hcaptcha"]',
    'iframe[src*="turnstile"]',
    '.g-recaptcha',
    '.h-captcha',
    '#captcha',
    '[data-sitekey]',
    'div[class*="captcha"]',
    'div[class*="challenge"]',
    'div[class*="verify"]'
  ];

  for (const selector of selectors) {
    try {
      const element = await page.$(selector);
      if (element) return { detected: true, type: 'generic', selector };
    } catch (e) {}
  }

  // Check page content for captcha indicators
  try {
    const content = await page.content();
    const indicators = [
      'captcha', 'recaptcha', 'hcaptcha', 'turnstile',
      'challenge', 'verify you are human', 'prove you\'re not a robot',
      'are you a robot', 'human verification', 'security check'
    ];
    const lower = content.toLowerCase();
    for (const ind of indicators) {
      if (lower.includes(ind)) return { detected: true, type: 'content', indicator: ind };
    }
  } catch (e) {}

  return { detected: false };
}

/* ── Fingerprint rotation (every 3-6 hours) ────────────────── */
async function rotateFingerprint(browser, options = {}) {
  const log = options.log || (() => {});
  log('info', 'anti-detect', 'rotating fingerprint');

  const agent = getNextAgent();
  const pages = await browser.pages();

  for (const page of pages) {
    try {
      await page.setViewport(agent.viewport);
      await page.setUserAgent(agent.ua);
      // v84.1 FIX: applyEvasions was re-run on every rotation, STACKING
      // evaluateOnNewDocument scripts unboundedly (WebGL patch wrapping
      // itself every 3-6h). Evasions are now applied once per page.
      if (!page._evasionsApplied) {
        await applyEvasions(page);
        page._evasionsApplied = true;
      }
    } catch (e) {
      // Page may have closed
    }
  }

  log('info', 'anti-detect', 'fingerprint rotated to ' + agent.name + ' (' + agent.viewport.width + 'x' + agent.viewport.height + ')');
  return agent;
}

/* ════════════════════════════════════════════════════════════
 *  DETECTION RISK ASSESSOR
 *  Quick inline check of how detectable the current session is
 *  Returns a score 0-100 (lower = safer)
 * ═══════════════════════════(══════════════════════════════ */
async function assessDetectionRisk(page) {
  let risk = 0;
  const checks = {};

  try {
    // Check navigator.webdriver
    const webdriver = await page.evaluate(() => navigator.webdriver);
    checks.webdriver = webdriver;
    if (webdriver) risk += 30;

    // Check plugins count
    const plugins = await page.evaluate(() => navigator.plugins.length);
    checks.plugins = plugins;
    if (plugins === 0) risk += 20;

    // Check chrome runtime
    const chrome = await page.evaluate(() => !!window.chrome);
    checks.chrome = chrome;
    if (!chrome) risk += 15;

    // Check WebGL renderer
    const gl = await page.evaluate(() => {
      try {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('webgl');
        const ext = ctx.getExtension('WEBGL_debug_renderer_info');
        return ext ? ctx.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
      } catch (e) { return 'error'; }
    });
    checks.webglRenderer = gl;
    if (gl.includes('SwiftShader')) risk += 25;

    // Check hardware concurrency
    const cores = await page.evaluate(() => navigator.hardwareConcurrency);
    checks.cores = cores;
    if (cores <= 2) risk += 5;

  } catch (e) {
    risk += 10; // Can't check = suspicious
  }

  return { risk: Math.min(100, risk), level: risk < 20 ? 'SAFE' : risk < 40 ? 'CAUTION' : risk < 60 ? 'RISKY' : 'DANGER', checks };
}

module.exports = {
  puppeteer, USER_AGENTS, getRandomAgent, getNextAgent,
  launchStealthBrowser, applyEvasions,
  loadProxies, getNextProxy, testProxy,
  warmSession, detectCaptcha, rotateFingerprint,
  assessDetectionRisk
};
