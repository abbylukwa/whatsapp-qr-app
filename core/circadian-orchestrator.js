'use strict';
/* ══════════════════════════════════════════════════════════════
 *  core/circadian-orchestrator.js — Human Circadian Rhythm Engine
 *
 *  PHILOSOPHY: "Automate 3× faster than me, but REST like me"
 *    - 5 hours inactive with only ~4% activity
 *    - Activity peaks match human circadian patterns
 *    - Micro-rests every 90-120 minutes (ultradian rhythm)
 *    - Random "life events" (distractions, delays, skip actions)
 *    - Weekend vs weekday behavioral differences
 *
 *  CIRCADIAN MODEL (based on human alertness research):
 *    Morning rise:    6 AM  → activity ramps from 0% to 40%
 *    Morning peak:    9-12  → 60% of daily actions (highest alertness)
 *    Post-lunch dip:  12-2  → 15% activity (the "5hr rest" starts here)
 *    Afternoon rest:  2-5   → 4% activity (micro-checks only, 1 action/hr)
 *    Evening peak:    5-9   → 35% of daily actions (second wind)
 *    Wind down:       9-11  → ramps from 35% down to 5%
 *    Sleep:           11-6  → 0% activity (hard block)
 *
 *  WEEKDAY vs WEEKEND:
 *    Weekdays: Full circadian pattern as above
 *    Saturday: 60% of weekday activity, shifted 2 hours later
 *    Sunday:   30% of weekday activity (rest day), browse-only mode
 *
 *  ULTRADIAN RHYTHM (90-minute cycles):
 *    Every 90-120 min, a 15-30 min micro-rest
 *    During micro-rest: passive actions only (scroll, read, like)
 *    No posting, commenting, or uploading during micro-rest
 *
 *  RANDOM LIFE EVENTS:
 *    20% chance: skip the next scheduled action entirely
 *    15% chance: delay next action by 30-120 min
 *    10% chance: extended micro-rest (60-90 min instead of 15-30)
 *    5% chance:  "distraction" — browse randomly for 5-15 min
 *
 *  ANTI-DETECTION IMPLICATIONS:
 *    - No action ever happens at the same time twice days in a row
 *    - Long inactive periods match real human behavior
 *    - Action density varies hour by hour (not constant rate)
 *    - Weekend drops are expected for real accounts
 *    - "Missing" a scheduled action looks MORE human, not less
 * ══════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');

class CircadianOrchestrator {
  constructor(options = {}) {
    this.log = options.log || (() => {});
    this.dataDir = options.dataDir || './data';
    this.timezone = options.timezone || 'America/Los_Angeles';

    // Configurable thresholds
    this.config = {
      // Time windows (hours in local time)
      sleepStart: options.sleepStart || 23,     // 11 PM — hard stop
      sleepEnd: options.sleepEnd || 6,          // 6 AM — wake up
      morningPeakStart: options.morningPeakStart || 9,
      morningPeakEnd: options.morningPeakEnd || 12,
      lunchDipStart: options.lunchDipStart || 12,
      lunchDipEnd: options.lunchDipEnd || 14,
      afternoonRestStart: options.afternoonRestStart || 14,
      afternoonRestEnd: options.afternoonRestEnd || 17,  // THE 5-HOUR REST
      eveningPeakStart: options.eveningPeakStart || 17,
      eveningPeakEnd: options.eveningPeakEnd || 21,
      windDownEnd: options.windDownEnd || 23,

      // Activity levels (0-1)
      morningPeakLevel: options.morningPeakLevel || 0.6,
      lunchDipLevel: options.lunchDipLevel || 0.15,
      afternoonRestLevel: options.afternoonRestLevel || 0.04,  // 4% — THE KEY
      eveningPeakLevel: options.eveningPeakLevel || 0.35,
      windDownLevel: options.windDownLevel || 0.05,
      sleepLevel: options.sleepLevel || 0,       // HARD ZERO

      // Weekend multipliers
      saturdayMultiplier: options.saturdayMultiplier || 0.6,
      sundayMultiplier: options.sundayMultiplier || 0.3,

      // Ultradian (90-min cycles)
      ultradianCycleMin: options.ultradianCycleMin || 90,  // minutes
      ultradianCycleMax: options.ultradianCycleMax || 120,
      microRestMin: options.microRestMin || 15,            // minutes
      microRestMax: options.microRestMax || 30,
      extendedMicroRestChance: options.extendedMicroRestChance || 0.10,
      extendedMicroRestMin: options.extendedMicroRestMin || 60,
      extendedMicroRestMax: options.extendedMicroRestMax || 90,

      // Random life events
      skipActionChance: options.skipActionChance || 0.20,           // 20%
      delayActionChance: options.delayActionChance || 0.15,         // 15%
      delayActionMinMin: options.delayActionMinMin || 30,           // minutes
      delayActionMaxMin: options.delayActionMaxMin || 120,
      distractionChance: options.distractionChance || 0.05,         // 5%
      distractionMinMin: options.distractionMinMin || 5,
      distractionMaxMin: options.distractionMaxMin || 15,

      // Rest days (no posting, browse-only)
      restDays: options.restDays || [0, 3],  // Sunday=0, Wednesday=3
    };

    // State tracking
    this.state = {
      lastUltradianCycleStart: Date.now(),
      inMicroRest: false,
      microRestEnd: 0,
      lastActionTime: 0,
      consecutiveActions: 0,
      skippedActions: 0,
      delayedActions: 0,
      microRests: 0,
      extendedRests: 0,
      distractions: 0,
      totalActionsToday: 0,
      currentDay: -1,
    };

    // Load persisted state
    this.stateFile = path.join(this.dataDir, 'circadian-state.json');
    this._loadState();

    // Start ultradian cycle monitor
    this._ultradianTimer = null;
    this._startUltradianMonitor();
  }

  /* ── Get current hour in local timezone ───────────────────── */
  _getCurrentHour() {
    const now = new Date();
    const local = new Date(now.toLocaleString('en-US', { timeZone: this.timezone }));
    return local.getHours();
  }

  /* ── Get current day of week (0=Sun, 6=Sat) ──────────────── */
  _getCurrentDayOfWeek() {
    const now = new Date();
    const local = new Date(now.toLocaleString('en-US', { timeZone: this.timezone }));
    return local.getDay();
  }

  /* ── Get current date string (YYYY-MM-DD) ────────────────── */
  _getCurrentDate() {
    const now = new Date();
    const local = new Date(now.toLocaleString('en-US', { timeZone: this.timezone }));
    return local.toISOString().split('T')[0];
  }

  /* ════════════════════════════════════════════════════════════
   *  GET CURRENT ACTIVITY LEVEL
   *  Returns 0-1 representing how active the bot should be right now
   *  This is the CORE of the circadian model
   * ════════════════════════════════════════════════════════════ */
  getActivityLevel() {
    const hour = this._getCurrentHour();
    const dayOfWeek = this._getCurrentDayOfWeek();
    const cfg = this.config;

    // ── Base activity by time of day ────────────────────────
    let level;

    if (hour >= cfg.sleepStart || hour < cfg.sleepEnd) {
      // SLEEP — hard zero
      level = cfg.sleepLevel;
    } else if (hour >= cfg.morningPeakStart && hour < cfg.morningPeakEnd) {
      // MORNING PEAK — highest activity
      level = cfg.morningPeakLevel;
    } else if (hour >= cfg.lunchDipStart && hour < cfg.lunchDipEnd) {
      // LUNCH DIP — reduced activity
      level = cfg.lunchDipLevel;
    } else if (hour >= cfg.afternoonRestStart && hour < cfg.afternoonRestEnd) {
      // AFTERNOON REST — 4% activity (THE KEY)
      level = cfg.afternoonRestLevel;
    } else if (hour >= cfg.eveningPeakStart && hour < cfg.eveningPeakEnd) {
      // EVENING PEAK — second wind
      level = cfg.eveningPeakLevel;
    } else if (hour >= cfg.sleepEnd && hour < cfg.morningPeakStart) {
      // MORNING RAMP-UP (6-9 AM) — linear increase
      const progress = (hour - cfg.sleepEnd) / (cfg.morningPeakStart - cfg.sleepEnd);
      level = cfg.morningPeakLevel * progress;
    } else if (hour >= cfg.eveningPeakEnd && hour < cfg.windDownEnd) {
      // WIND DOWN (9-11 PM) — linear decrease
      const progress = 1 - (hour - cfg.eveningPeakEnd) / (cfg.windDownEnd - cfg.eveningPeakEnd);
      level = cfg.eveningPeakLevel * progress;
    } else {
      level = 0.05; // fallback
    }

    // ── Weekend multiplier ──────────────────────────────────
    if (dayOfWeek === 6) { // Saturday
      level *= cfg.saturdayMultiplier;
    } else if (dayOfWeek === 0) { // Sunday
      level *= cfg.sundayMultiplier;
    }

    // ── Rest day (Sunday + Wednesday by default) ────────────
    if (cfg.restDays.includes(dayOfWeek)) {
      // On rest days: only passive engagement, no posting
      level = Math.min(level, 0.08); // cap at 8% on rest days
    }

    // ── Micro-rest (ultradian) ──────────────────────────────
    if (this.state.inMicroRest) {
      if (Date.now() < this.state.microRestEnd) {
        // During micro-rest: only passive actions (4% max)
        level = Math.min(level, 0.04);
      } else {
        // Micro-rest over
        this.state.inMicroRest = false;
        this.log('info', 'circadian', 'Micro-rest ended — activity resuming');
      }
    }

    // Add ±15% random jitter to make every day slightly different
    level *= (0.85 + Math.random() * 0.30);

    return Math.max(0, Math.min(1, level));
  }

  /* ════════════════════════════════════════════════════════════
   *  SHOULD I ACT RIGHT NOW?
   *  The main decision function. Call before EVERY action.
   *  Returns: { shouldAct, reason, delay, actionType }
   *
   *  actionType: 'full' (posting/uploading), 'passive' (like/scroll), 'none'
   * ════════════════════════════════════════════════════════════ */
  shouldAct(actionCategory = 'full') {
    const level = this.getActivityLevel();
    const hour = this._getCurrentHour();
    const dayOfWeek = this._getCurrentDayOfWeek();

    // ── Hard blocks ─────────────────────────────────────────
    // Sleep time — NEVER act
    if (hour >= this.config.sleepStart || hour < this.config.sleepEnd) {
      return { shouldAct: false, reason: 'sleep_time', delay: 0, actionType: 'none' };
    }

    // Micro-rest — only passive actions allowed
    if (this.state.inMicroRest && Date.now() < this.state.microRestEnd) {
      if (actionCategory === 'passive') {
        return { shouldAct: true, reason: 'micro_rest_passive', delay: 0, actionType: 'passive' };
      }
      const remaining = Math.round((this.state.microRestEnd - Date.now()) / 60000);
      return { shouldAct: false, reason: 'micro_rest', delay: remaining * 60000, actionType: 'none' };
    }

    // Rest day — only passive actions
    if (this.config.restDays.includes(dayOfWeek) && actionCategory === 'full') {
      return { shouldAct: false, reason: 'rest_day', delay: 0, actionType: 'passive' };
    }

    // ── Activity level gate ─────────────────────────────────
    // If activity level is below threshold for this action type, block
    const fullThreshold = 0.15;  // Need 15%+ activity for full actions
    const passiveThreshold = 0.02; // Need 2%+ for even passive actions

    if (actionCategory === 'full' && level < fullThreshold) {
      return { shouldAct: false, reason: 'low_activity', delay: 300000, actionType: 'none' };
    }

    if (actionCategory === 'passive' && level < passiveThreshold) {
      return { shouldAct: false, reason: 'sleep_activity', delay: 600000, actionType: 'none' };
    }

    // ── Random life events ──────────────────────────────────

    // 20% chance: skip this action entirely
    if (Math.random() < this.config.skipActionChance) {
      this.state.skippedActions++;
      this.log('info', 'circadian', 'Life event: skipping action (simulates distraction)');
      return { shouldAct: false, reason: 'life_skip', delay: 0, actionType: 'none' };
    }

    // 15% chance: delay this action by 30-120 min
    if (Math.random() < this.config.delayActionChance) {
      const delayMin = this.config.delayActionMinMin +
        Math.random() * (this.config.delayActionMaxMin - this.config.delayActionMinMin);
      const delayMs = Math.round(delayMin * 60000);
      this.state.delayedActions++;
      this.log('info', 'circadian', 'Life event: delaying action by ' + Math.round(delayMin) + 'min');
      return { shouldAct: false, reason: 'life_delay', delay: delayMs, actionType: actionCategory === 'full' ? 'full' : 'passive' };
    }

    // 5% chance: distraction — browse randomly for 5-15 min
    if (Math.random() < this.config.distractionChance) {
      const distMin = this.config.distractionMinMin +
        Math.random() * (this.config.distractionMaxMin - this.config.distractionMinMin);
      this.state.distractions++;
      this.log('info', 'circadian', 'Life event: distraction for ' + Math.round(distMin) + 'min');
      return { shouldAct: false, reason: 'distraction', delay: Math.round(distMin * 60000), actionType: 'passive' };
    }

    // ── Track state ─────────────────────────────────────────
    this.state.lastActionTime = Date.now();
    this.state.consecutiveActions++;
    this.state.totalActionsToday++;

    // Determine action type based on activity level
    let resolvedType = actionCategory;
    if (level < 0.08) {
      resolvedType = 'passive'; // At very low activity, downgrade to passive
    }

    return { shouldAct: true, reason: 'ok', delay: 0, actionType: resolvedType, activityLevel: level };
  }

  /* ════════════════════════════════════════════════════════════
   *  GET NEXT ACTION TIME
   *  When should the next action be scheduled?
   *  Accounts for circadian pattern + ultradian cycles + jitter
   * ════════════════════════════════════════════════════════════ */
  getNextActionTime(actionCategory = 'full') {
    const now = new Date();
    const level = this.getActivityLevel();

    // Base interval depends on activity level
    // At 60% activity → ~10 min between actions
    // At 4% activity  → ~2.5 hours between actions
    // At 0% activity  → sleep until wake
    let baseIntervalMs;

    if (level <= 0) {
      // Sleep — return time until wake
      const currentHour = this._getCurrentHour();
      let msUntilWake;
      if (currentHour >= this.config.sleepStart) {
        // After sleep start — wake tomorrow
        msUntilWake = ((24 - currentHour) + this.config.sleepEnd) * 3600000;
      } else {
        // Before sleep end — wake today
        msUntilWake = (this.config.sleepEnd - currentHour) * 3600000;
      }
      return Date.now() + msUntilWake;
    }

    // Higher activity → shorter intervals
    // Formula: interval = 600000 / level (at 0.6 → 10min, at 0.04 → 250min)
    baseIntervalMs = 600000 / level;

    // Full actions have longer intervals than passive
    if (actionCategory === 'full') {
      baseIntervalMs *= 2; // Full actions 2× the interval
    }

    // ±30% jitter
    const jitter = baseIntervalMs * (Math.random() * 0.6 - 0.3);
    baseIntervalMs += jitter;

    // If we're in a micro-rest, delay until rest ends
    if (this.state.inMicroRest && Date.now() < this.state.microRestEnd) {
      baseIntervalMs = Math.max(baseIntervalMs, this.state.microRestEnd - Date.now());
    }

    return Date.now() + Math.max(60000, Math.round(baseIntervalMs)); // Min 1 minute
  }

  /* ════════════════════════════════════════════════════════════
   *  GET SAFE POSTING TIMES
   *  Returns an array of { hour, activityLevel } for today
   *  Useful for planning content calendars
   * ════════════════════════════════════════════════════════════ */
  getTodaySchedule() {
    const schedule = [];
    const dayOfWeek = this._getCurrentDayOfWeek();

    for (let hour = 0; hour < 24; hour++) {
      // Temporarily set hour for calculation
      const origGetHour = this._getCurrentHour;
      this._getCurrentHour = () => hour;
      const level = this.getActivityLevel();
      this._getCurrentHour = origGetHour;

      let category;
      if (level <= 0) category = 'sleep';
      else if (level < 0.08) category = 'micro_check';
      else if (level < 0.20) category = 'passive_only';
      else category = 'full_activity';

      schedule.push({
        hour,
        activityLevel: Math.round(level * 100) / 100,
        category,
        canPost: category === 'full_activity',
        canEngage: category !== 'sleep'
      });
    }

    return {
      dayOfWeek,
      dayName: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dayOfWeek],
      isRestDay: this.config.restDays.includes(dayOfWeek),
      schedule
    };
  }

  /* ════════════════════════════════════════════════════════════
   *  ULTRADIAN CYCLE MONITOR
   *  Every 90-120 minutes, enters a micro-rest (15-30 min)
   *  During micro-rest: only passive actions (scroll, read, like)
   * ════════════════════════════════════════════════════════════ */
  _startUltradianMonitor() {
    const scheduleNextCycle = () => {
      // Random cycle length: 90-120 minutes
      const cycleMin = this.config.ultradianCycleMin +
        Math.random() * (this.config.ultradianCycleMax - this.config.ultradianCycleMin);
      const cycleMs = cycleMin * 60000;

      this._ultradianTimer = setTimeout(() => {
        this._enterMicroRest();
        // Schedule next cycle after micro-rest
        scheduleNextCycle();
      }, cycleMs);
    };

    // First cycle starts after a random portion of the interval
    const initialDelay = (this.config.ultradianCycleMin * 60000) * (0.3 + Math.random() * 0.7);
    this._ultradianTimer = setTimeout(() => {
      this._enterMicroRest();
      scheduleNextCycle();
    }, initialDelay);
  }

  _enterMicroRest() {
    // Don't enter micro-rest during sleep
    const hour = this._getCurrentHour();
    if (hour >= this.config.sleepStart || hour < this.config.sleepEnd) {
      return;
    }

    // Determine rest duration
    let restMin;
    if (Math.random() < this.config.extendedMicroRestChance) {
      // Extended micro-rest (60-90 min)
      restMin = this.config.extendedMicroRestMin +
        Math.random() * (this.config.extendedMicroRestMax - this.config.extendedMicroRestMin);
      this.state.extendedRests++;
      this.log('info', 'circadian', 'Extended micro-rest: ' + Math.round(restMin) + 'min (ultradian deep cycle)');
    } else {
      // Normal micro-rest (15-30 min)
      restMin = this.config.microRestMin +
        Math.random() * (this.config.microRestMax - this.config.microRestMin);
      this.state.microRests++;
      this.log('info', 'circadian', 'Micro-rest: ' + Math.round(restMin) + 'min (ultradian cycle)');
    }

    this.state.inMicroRest = true;
    this.state.microRestEnd = Date.now() + Math.round(restMin * 60000);
    this.state.consecutiveActions = 0; // Reset counter

    this._saveState();
  }

  /* ── Force exit micro-rest (for manual override) ─────────── */
  exitMicroRest() {
    this.state.inMicroRest = false;
    this.state.microRestEnd = 0;
    this.log('info', 'circadian', 'Micro-rest manually ended');
  }

  /* ── Check if currently in micro-rest ─────────────────────── */
  isInMicroRest() {
    if (this.state.inMicroRest && Date.now() >= this.state.microRestEnd) {
      this.state.inMicroRest = false;
    }
    return this.state.inMicroRest;
  }

  /* ── Reset daily counters at midnight ─────────────────────── */
  _checkDayReset() {
    const today = this._getCurrentDate();
    if (today !== this.state.currentDay) {
      this.state.currentDay = today;
      this.state.totalActionsToday = 0;
      this.state.skippedActions = 0;
      this.state.delayedActions = 0;
      this.log('info', 'circadian', 'New day — counters reset');
    }
  }

  /* ── Get full status ──────────────────────────────────────── */
  getStatus() {
    const level = this.getActivityLevel();
    const hour = this._getCurrentHour();
    const dayOfWeek = this._getCurrentDayOfWeek();

    let phase;
    if (hour >= this.config.sleepStart || hour < this.config.sleepEnd) phase = 'sleep';
    else if (hour >= this.config.morningPeakStart && hour < this.config.morningPeakEnd) phase = 'morning_peak';
    else if (hour >= this.config.lunchDipStart && hour < this.config.lunchDipEnd) phase = 'lunch_dip';
    else if (hour >= this.config.afternoonRestStart && hour < this.config.afternoonRestEnd) phase = 'afternoon_rest';
    else if (hour >= this.config.eveningPeakStart && hour < this.config.eveningPeakEnd) phase = 'evening_peak';
    else phase = 'transition';

    return {
      currentHour: hour,
      dayOfWeek,
      dayName: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dayOfWeek],
      isRestDay: this.config.restDays.includes(dayOfWeek),
      phase,
      activityLevel: Math.round(level * 1000) / 10, // 0-100 with 1 decimal
      inMicroRest: this.isInMicroRest(),
      microRestRemaining: this.state.inMicroRest ? Math.max(0, Math.round((this.state.microRestEnd - Date.now()) / 60000)) : 0,
      totalActionsToday: this.state.totalActionsToday,
      skippedActions: this.state.skippedActions,
      delayedActions: this.state.delayedActions,
      microRestsToday: this.state.microRests,
      config: this.config
    };
  }

  /* ── Format status for WhatsApp display ───────────────────── */
  formatStatus() {
    const s = this.getStatus();
    const lines = [];

    lines.push('CIRCADIAN RHYTHM ENGINE');
    lines.push('Time: ' + s.currentHour + ':00 ' + s.dayName + (s.isRestDay ? ' (REST DAY)' : ''));
    lines.push('Phase: ' + s.phase.replace(/_/g, ' ').toUpperCase());
    lines.push('Activity: ' + s.activityLevel + '%');

    if (s.inMicroRest) {
      lines.push('Micro-rest: YES (' + s.microRestRemaining + ' min remaining)');
    } else {
      lines.push('Micro-rest: No');
    }

    lines.push('Actions today: ' + s.totalActionsToday);
    if (s.skippedActions > 0) lines.push('Skipped (life): ' + s.skippedActions);
    if (s.delayedActions > 0) lines.push('Delayed (life): ' + s.delayedActions);

    return lines.join('\n');
  }

  /* ── Persistence ──────────────────────────────────────────── */
  _loadState() {
    try {
      if (fs.existsSync(this.stateFile)) {
        const saved = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
        Object.assign(this.state, saved);
      }
    } catch (e) {}
  }

  _saveState() {
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2));
    } catch (e) {}
  }

  /* ── Cleanup ──────────────────────────────────────────────── */
  close() {
    if (this._ultradianTimer) {
      clearTimeout(this._ultradianTimer);
      this._ultradianTimer = null;
    }
    this._saveState();
    this.log('info', 'circadian', 'Circadian orchestrator stopped');
  }
}

module.exports = CircadianOrchestrator;
