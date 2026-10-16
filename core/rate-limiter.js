'use strict';
/* ══════════════════════════════════════════════════════════════
 *  core/rate-limiter.js — Per-Action Rate Limiting
 *  Prevents any single action from exceeding platform limits.
 *  Each action has its own hourly + daily caps and cooldown.
 * ══════════════════════════════════════════════════════════════ */

const fs = require('fs');
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

  /* Wait for cooldown if needed, then record */
  async waitAndRecord(action = 'default') {
    const limits = this.getLimits(action);
    const state = this.getState(action);
    const waitMs = Math.max(0, limits.cooldown - (Date.now() - state.lastAction));

    if (waitMs > 0) {
      await new Promise(r => setTimeout(r, waitMs));
    }

    this.record(action);
  }

  /* Get remaining capacity */
  getRemaining(action = 'default') {
    const limits = this.getLimits(action);
    const state = this.getState(action);
    return {
      hourly: Math.max(0, limits.hourly - state.hourlyCount),
      daily: Math.max(0, limits.daily - state.dailyCount),
      cooldownMs: Math.max(0, limits.cooldown - (Date.now() - state.lastAction))
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
        if (data.limits) {
          for (const [action, limits] of Object.entries(data.limits)) {
            this.limits[action] = limits;
          }
        }
      }
    } catch (e) {}
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify({ state: this.state, limits: this.limits }, null, 2));
    } catch (e) {}
  }
}

module.exports = RateLimiter;
