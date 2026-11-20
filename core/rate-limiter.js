'use strict';
/* ══════════════════════════════════════════════════════════════
 *  core/rate-limiter.js — Per-Action Rate Limiting
 *  Prevents any single action from exceeding platform limits.
 *  Each action has its own hourly + daily caps and cooldown.
 * ══════════════════════════════════════════════════════════════ */

const fs = require('fs');
const { writeJSONAtomic } = require('./atomic');
const path = require('path');

class RateLimiter {
  constructor(platform, limits = {}, dataDir = './data') {
    this.platform = platform;
    this.dataDir = dataDir;
    this.limits = {
      default: {
        hourly: limits.hourly || 20,
        daily: limits.daily || 100,
        cooldown: limits.cooldown || 5000
      }
    };
    this.state = {};
    this.stateFile = path.join(dataDir, `rate-limit-${platform}.json`);
    this.load();
  }

  /* Set custom limits for a specific action */
  setActionLimits(action, limits) {
    this.limits[action] = { ...this.limits.default, ...limits };
  }

  /* Get limits for an action */
  getLimits(action) {
    return this.limits[action] || this.limits.default;
  }

  /* Get or create state for an action */
  getState(action) {
    if (!this.state[action]) {
      this.state[action] = {
        hourlyCount: 0,
        dailyCount: 0,
        lastAction: 0,
        hourlyReset: Date.now() + 3600000,
        dailyReset: Date.now() + 86400000
      };
    }
    return this.state[action];
  }

  /* Check if an action can be performed */
  canAct(action = 'default') {
    const limits = this.getLimits(action);
    const state = this.getState(action);
    const now = Date.now();

    if (now >= state.hourlyReset) {
      state.hourlyCount = 0;
      state.hourlyReset = now + 3600000;
    }
    if (now >= state.dailyReset) {
      state.dailyCount = 0;
      state.dailyReset = now + 86400000;
    }

    return state.hourlyCount < limits.hourly
        && state.dailyCount < limits.daily
        && (now - state.lastAction) >= limits.cooldown;
  }

  /* Record that an action was performed */
  record(action = 'default') {
    const state = this.getState(action);
    state.hourlyCount++;
    state.dailyCount++;
    state.lastAction = Date.now();
    this.save();
  }

  /* Wait for cooldown if needed, then record.
   * v84.1 FIX: used to ignore hourly/daily caps entirely — it waited
   * out the cooldown and recorded EVEN WHEN OVER LIMIT. That is the
   * exact behavior that gets accounts flagged. Now it enforces caps:
   * waits for cooldown, and if hourly/daily caps are exhausted it
   * WAITS until the next window reset (bounded by maxWaitMs), then
   * records. Returns { acted: bool, waitMs } so callers can skip. */
  async waitAndRecord(action = 'default', maxWaitMs = 15 * 60 * 1000) {
    const limits = this.getLimits(action);
    const state = this.getState(action);
    const now = Date.now();

    // window expiry first (same as canAct)
    if (now >= state.hourlyReset) { state.hourlyCount = 0; state.hourlyReset = now + 3600000; }
    if (now >= state.dailyReset) { state.dailyCount = 0; state.dailyReset = now + 86400000; }

    const cooldownWait = Math.max(0, limits.cooldown - (now - state.lastAction));
    let capWait = 0;
    if (state.hourlyCount >= limits.hourly) capWait = Math.max(capWait, state.hourlyReset - now);
    if (state.dailyCount >= limits.daily) capWait = Math.max(capWait, state.dailyReset - now);

    const totalWait = Math.min(cooldownWait + (capWait > 0 ? Math.min(capWait, maxWaitMs) : 0), maxWaitMs);
    if (totalWait > 0) {
      await new Promise(r => setTimeout(r, totalWait));
      // re-check after waiting — if STILL over cap (daily), refuse politely
      if (Date.now() < state.hourlyReset && state.hourlyCount >= limits.hourly) return { acted: false, waitMs: totalWait, reason: 'hourly-cap' };
      if (Date.now() < state.dailyReset && state.dailyCount >= limits.daily) return { acted: false, waitMs: totalWait, reason: 'daily-cap' };
    }

    this.record(action);
    return { acted: true, waitMs: totalWait };
  }

  /* Get remaining capacity (v84.1: expires windows first — was stale) */
  getRemaining(action = 'default') {
    const limits = this.getLimits(action);
    const state = this.getState(action);
    const now = Date.now();
    if (now >= state.hourlyReset) { state.hourlyCount = 0; state.hourlyReset = now + 3600000; }
    if (now >= state.dailyReset) { state.dailyCount = 0; state.dailyReset = now + 86400000; }
    return {
      hourly: Math.max(0, limits.hourly - state.hourlyCount),
      daily: Math.max(0, limits.daily - state.dailyCount),
      cooldownMs: Math.max(0, limits.cooldown - (now - state.lastAction))
    };
  }

  /* Get full status */
  getStatus() {
    const status = {};
    for (const action of Object.keys(this.state)) {
      status[action] = {
        remaining: this.getRemaining(action),
        limits: this.getLimits(action),
        state: { ...this.state[action] }
      };
    }
    return status;
  }

  /* Persistence */
  load() {
    try {
      if (fs.existsSync(this.stateFile)) {
        const data = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
        this.state = data.state || {};
        // v84.1: do NOT let stale persisted limits override the limits
        // the code just deployed — old deployments used to silently win.
        // Persisted limits are merged ONLY for actions the code does not
        // define itself (i.e. tuned at runtime via setActionLimits).
        if (data.limits) {
          for (const [action, limits] of Object.entries(data.limits)) {
            if (!this.limits[action]) this.limits[action] = limits;
          }
        }
      }
    } catch (e) {}
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      writeJSONAtomic(this.stateFile, { state: this.state, limits: this.limits });
    } catch (e) {}
  }
}

module.exports = RateLimiter;
