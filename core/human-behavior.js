'use strict';
/* ══════════════════════════════════════════════════════════════
 *  core/human-behavior.js — Human Behavior Simulation Module
 *  Makes automation undetectable by mimicking real human patterns:
 *    - Variable typing speed with typos and corrections
 *    - Bezier-curve mouse movement
 *    - Natural click patterns with micro-movements
 *    - Realistic scroll behavior
 *    - Session warming (browse before acting)
 *    - Random action ordering
 *    - Per-action rate limiting
 * ══════════════════════════════════════════════════════════════ */

const { v4: uuid } = require('uuid');

/* ── Random delay with jitter ──────────────────────────────── */
function randomDelay(minMs = 1000, maxMs = 5000) {
  const base = minMs + Math.random() * (maxMs - minMs);
  const jitter = base * (Math.random() * 0.2 - 0.1); // ±10% jitter
  return Math.max(minMs, base + jitter);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function humanDelay(minMs = 2000, maxMs = 6000) {
  const delay = randomDelay(minMs, maxMs);
  await sleep(delay);
  return delay;
}

/* ── Human-like typing ─────────────────────────────────────── */
async function humanType(page, selector, text, options = {}) {
  const wpm = options.wpm || (40 + Math.random() * 60); // 40-100 WPM
  const charDelay = 60000 / (wpm * 5); // avg chars per word ~5
  const typoRate = options.typoRate || 0.02; // 2% typo chance
  const thinkPauseRate = options.thinkPauseRate || 0.05; // 5% think pause

  await page.click(selector);
  await humanDelay(300, 800); // slight pause before typing

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    // Thinking pause
    if (Math.random() < thinkPauseRate) {
      await sleep(1500 + Math.random() * 3000);
    }

    // Typo simulation
    if (Math.random() < typoRate && i < text.length - 1) {
      const wrongChar = String.fromCharCode(char.charCodeAt(0) + (Math.random() > 0.5 ? 1 : -1));
      await page.keyboard.type(wrongChar, { delay: charDelay * (0.5 + Math.random()) });
      await sleep(200 + Math.random() * 500); // notice typo
      await page.keyboard.press('Backspace');
      await sleep(100 + Math.random() * 300); // retype delay
    }

    await page.keyboard.type(char, { delay: charDelay * (0.5 + Math.random() * 1.5) });
  }
}

/* ── Bezier curve mouse movement ───────────────────────────── */
function bezierPoint(t, p0, p1, p2, p3) {
  const mt = 1 - t;
  return {
    x: mt*mt*mt*p0.x + 3*mt*mt*t*p1.x + 3*mt*t*t*p2.x + t*t*t*p3.x,
    y: mt*mt*mt*p0.y + 3*mt*mt*t*p1.y + 3*mt*t*t*p2.y + t*t*t*p3.y
  };
}

async function humanMouseMove(page, targetX, targetY, options = {}) {
  const steps = options.steps || (20 + Math.floor(Math.random() * 30));
  const viewport = page.viewport();

  // Start from a random position near current or random spot
  const startX = options.startX || (Math.random() * (viewport?.width || 1280));
  const startY = options.startY || (Math.random() * (viewport?.height || 800));

  // Two control points for the Bezier curve (makes movement curved, not straight)
  const cp1 = {
    x: startX + (targetX - startX) * 0.3 + (Math.random() - 0.5) * 200,
    y: startY + (targetY - startY) * 0.3 + (Math.random() - 0.5) * 200
  };
  const cp2 = {
    x: startX + (targetX - startX) * 0.7 + (Math.random() - 0.5) * 200,
    y: startY + (targetY - startY) * 0.7 + (Math.random() - 0.5) * 200
  };

  const start = { x: startX, y: startY };
  const end = { x: targetX, y: targetY };

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    // Add slight acceleration/deceleration
    const adjustedT = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const point = bezierPoint(adjustedT, start, cp1, cp2, end);
    await page.mouse.move(Math.round(point.x), Math.round(point.y));
    await sleep(5 + Math.random() * 15); // micro delay between moves
  }
}

/* ── Human click ───────────────────────────────────────────── */
async function humanClick(page, selector, options = {}) {
  const element = await page.$(selector);
  if (!element) throw new Error(`Element not found: ${selector}`);

  const box = await element.boundingBox();
  if (!box) throw new Error(`Element not visible: ${selector}`);

  // Move to element with Bezier curve
  const targetX = box.x + box.width * (0.2 + Math.random() * 0.6);
  const targetY = box.y + box.height * (0.2 + Math.random() * 0.6);

  await humanMouseMove(page, targetX, targetY, options);

  // Small pause before clicking (like a real person)
  await sleep(50 + Math.random() * 200);

  // Click with slight position variation
  await page.mouse.click(
    targetX + (Math.random() - 0.5) * 4,
    targetY + (Math.random() - 0.5) * 4
  );

  await humanDelay(200, 600);
}

/* ── Human scroll ──────────────────────────────────────────── */
async function humanScroll(page, direction = 'down', amount = 3) {
  const scrollDelta = direction === 'down' ? 150 : -150;

  for (let i = 0; i < amount; i++) {
    const delta = scrollDelta * (0.5 + Math.random());
    await page.mouse.wheel(0, delta);
    await sleep(300 + Math.random() * 800);

    // Occasionally pause longer (reading)
    if (Math.random() < 0.2) {
      await sleep(1000 + Math.random() * 3000);
    }
  }
}

/* ── Browse pattern (session warming) ──────────────────────── */
async function browseRandomly(page, options = {}) {
  const actions = options.actions || (3 + Math.floor(Math.random() * 5));
  const log = options.log || (() => {});

  for (let i = 0; i < actions; i++) {
    const action = Math.random();

    if (action < 0.4) {
      // Scroll
      await humanScroll(page, Math.random() > 0.3 ? 'down' : 'up', 1 + Math.floor(Math.random() * 3));
      log('info', 'behavior', 'warming: scroll');
    } else if (action < 0.7) {
      // Move mouse randomly
      const viewport = page.viewport();
      await humanMouseMove(page,
        Math.random() * (viewport?.width || 1280),
        Math.random() * (viewport?.height || 800)
      );
      log('info', 'behavior', 'warming: mouse move');
    } else {
      // Just pause (reading)
      await humanDelay(1000, 4000);
      log('info', 'behavior', 'warming: reading pause');
    }
  }
}

/* ── Action randomizer ─────────────────────────────────────── */
function randomizeActionOrder(actions) {
  const shuffled = [...actions];
  // Fisher-Yates shuffle
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

/* ── Per-action rate limiter ───────────────────────────────── */
function createRateLimiter(limits = {}) {
  const defaultLimits = {
    hourly: limits.hourly || 20,
    daily: limits.daily || 100,
    cooldown: limits.cooldown || 5000 // 5s between same action
  };

  const state = {
    hourlyCount: 0,
    dailyCount: 0,
    lastAction: 0,
    hourlyReset: Date.now() + 3600000,
    dailyReset: Date.now() + 86400000
  };

  return {
    canAct() {
      const now = Date.now();
      if (now >= state.hourlyReset) { state.hourlyCount = 0; state.hourlyReset = now + 3600000; }
      if (now >= state.dailyReset) { state.dailyCount = 0; state.dailyReset = now + 86400000; }
      return state.hourlyCount < defaultLimits.hourly
          && state.dailyCount < defaultLimits.daily
          && (now - state.lastAction) >= defaultLimits.cooldown;
    },
    record() {
      state.hourlyCount++;
      state.dailyCount++;
      state.lastAction = Date.now();
    },
    getRemaining() {
      return {
        hourly: Math.max(0, defaultLimits.hourly - state.hourlyCount),
        daily: Math.max(0, defaultLimits.daily - state.dailyCount),
        cooldownMs: Math.max(0, defaultLimits.cooldown - (Date.now() - state.lastAction))
      };
    },
    getLimits() { return { ...defaultLimits }; },
    getState() { return { ...state }; }
  };
}

module.exports = {
  randomDelay, sleep, humanDelay, humanType,
  humanMouseMove, humanClick, humanScroll,
  browseRandomly, randomizeActionOrder, createRateLimiter
};
