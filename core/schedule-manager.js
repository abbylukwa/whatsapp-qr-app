'use strict';
/* ══════════════════════════════════════════════════════════════
 *  core/schedule-manager.js — Per-Platform Scheduling
 *  Each platform has its own schedule file that can be edited
 *  independently without affecting other platforms.
 *  Supports:
 *    - Enable/disable platform entirely
 *    - Add/remove scheduled tasks
 *    - Jittered intervals (human-like)
 *    - Task start/stop
 * ══════════════════════════════════════════════════════════════ */

const fs = require('fs');
const { writeJSONAtomic } = require('./atomic');
const path = require('path');

class ScheduleManager {
  constructor(platform, schedulesDir = './schedules') {
    this.platform = platform;
    this.schedulesDir = schedulesDir;
    this.scheduleFile = path.join(schedulesDir, `${platform}.json`);
    this.log = () => {};
    this.timers = new Map();
    this.callbacks = new Map();   // v84.1: for enable() re-arming
    this.schedule = this.load();
  }

  setLog(fn) { this.log = fn; }

  /* ── Load schedule from file ───────────────────────────────── */
  load() {
    const defaultSchedule = {
      platform: this.platform,
      enabled: false,
      tasks: []
    };

    try {
      fs.mkdirSync(this.schedulesDir, { recursive: true });
      if (fs.existsSync(this.scheduleFile)) {
        const data = JSON.parse(fs.readFileSync(this.scheduleFile, 'utf8'));
        return { ...defaultSchedule, ...data };
      }
    } catch (e) {
      this.log('error', 'schedule', `Load failed: ${e.message}`);
    }
    return defaultSchedule;
  }

  /* ── Save schedule to file ─────────────────────────────────── */
  save() {
    try {
      fs.mkdirSync(this.schedulesDir, { recursive: true });
      writeJSONAtomic(this.scheduleFile, this.schedule);
    } catch (e) {
      this.log('error', 'schedule', `Save failed: ${e.message}`);
    }
  }

  /* ── Platform enable/disable ───────────────────────────────── */
  enable() {
    this.schedule.enabled = true;
    this.save();
    // v84.1: belt & braces — if timers were stopped by external code
    // (stopAllTasks / process restart), re-arm every enabled task from
    // the stored callback registry so enable() ALWAYS means running.
    let rearmed = 0;
    for (const task of this.schedule.tasks) {
      if (task.enabled && this.callbacks.has(task.id) && !this.timers.has(task.id)) {
        this.startTask(task.id, this.callbacks.get(task.id));
        rearmed++;
      }
    }
    this.log('info', 'schedule', `${this.platform} enabled` + (rearmed ? ` (${rearmed} task chains re-armed)` : ''));
  }

  disable() {
    this.schedule.enabled = false;
    // v84.1 FIX: this used to call stopAllTasks() — which KILLED every
    // timer chain. enable() only flipped the flag back, so after an
    // off→on cycle the platform looked "on" but never ran again.
    // Now the chain stays alive and the disabled flag simply gates the
    // action inside runWithJitter (see startTask).
    this.save();
    this.log('info', 'schedule', `${this.platform} disabled (task chains kept alive, actions gated)`);
  }

  isEnabled() {
    return this.schedule.enabled;
  }

  /* ── Task management ───────────────────────────────────────── */
  addTask(task) {
    const id = task.id || `${this.platform}-${Date.now()}`;
    const newTask = {
      id,
      name: task.name || id,
      action: task.action,
      interval: task.interval || 3600000, // default 1 hour
      jitter: task.jitter || 0.1, // ±10% jitter
      enabled: task.enabled !== false,
      lastRun: 0,
      nextRun: 0,
      runCount: 0,
      ...task
    };
    // Remove id from spread to avoid overwrite
    newTask.id = id;

    this.schedule.tasks.push(newTask);
    this.save();
    this.log('info', 'schedule', `Task added: ${id}`);
    return id;
  }

  removeTask(taskId) {
    this.schedule.tasks = this.schedule.tasks.filter(t => t.id !== taskId);
    this.stopTask(taskId);
    this.save();
    this.log('info', 'schedule', `Task removed: ${taskId}`);
  }

  updateTask(taskId, updates) {
    const task = this.schedule.tasks.find(t => t.id === taskId);
    if (!task) return false;
    Object.assign(task, updates);
    this.save();
    this.log('info', 'schedule', `Task updated: ${taskId}`);
    return true;
  }

  getTask(taskId) {
    return this.schedule.tasks.find(t => t.id === taskId);
  }

  getTasks() {
    return this.schedule.tasks;
  }

  /* ── Task execution with jitter ────────────────────────────── */
  startTask(taskId, callback) {
    const task = this.getTask(taskId);
    if (!task || !task.enabled) return false;

    this.stopTask(taskId); // Clear any existing timer
    // v84.1: remember the callback so enable() can re-arm dead chains
    if (!this.callbacks) this.callbacks = new Map();
    this.callbacks.set(taskId, callback);

    const runWithJitter = async () => {
      /* v84.1 FIX: this used to `return` (killing the reschedule chain)
       * whenever the schedule/task was disabled at fire time. After
       * `!platform off` → `!platform on` the flag flipped back but the
       * timer chain was already dead — the platform looked "on" yet
       * never ran another scheduled task until a process restart.
       * Now the chain ALWAYS re-arms; disabled states just skip the
       * action this tick. */
      const jitteredInterval = task.interval * (1 + (Math.random() * 2 - 1) * (task.jitter || 0));

      if (this.schedule.enabled && task.enabled) {
        try {
          this.log('info', 'schedule', `Running task: ${taskId}`);
          await callback(task);
          task.lastRun = Date.now();
          task.runCount++;
          task.nextRun = Date.now() + jitteredInterval;
          this.save();
        } catch (e) {
          this.log('error', 'schedule', `Task ${taskId} failed: ${e.message}`);
        }
      } else {
        this.log('info', 'schedule', `Task ${taskId} skipped (schedule/task disabled) — chain kept alive`);
      }

      // Schedule next run with jitter (ALWAYS — keep the chain alive)
      const timer = setTimeout(runWithJitter, jitteredInterval);
      this.timers.set(taskId, timer);
    };

    // Initial run after a small random delay
    const initialDelay = 1000 + Math.random() * 5000;
    const timer = setTimeout(runWithJitter, initialDelay);
    this.timers.set(taskId, timer);
    this.log('info', 'schedule', `Task started: ${taskId}`);
    return true;
  }

  stopTask(taskId) {
    const timer = this.timers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(taskId);
      this.log('info', 'schedule', `Task stopped: ${taskId}`);
    }
  }

  stopAllTasks() {
    for (const [taskId] of this.timers) {
      this.stopTask(taskId);
    }
  }

  /* ── Start all enabled tasks ───────────────────────────────── */
  startAll(callbacks = {}) {
    if (!this.schedule.enabled) return;

    for (const task of this.schedule.tasks) {
      if (task.enabled && callbacks[task.action]) {
        this.startTask(task.id, callbacks[task.action]);
      }
    }
    this.log('info', 'schedule', `${this.platform}: all enabled tasks started`);
  }

  /* ── Status ────────────────────────────────────────────────── */
  getStatus() {
    return {
      platform: this.platform,
      enabled: this.schedule.enabled,
      tasks: this.schedule.tasks.map(t => ({
        id: t.id,
        name: t.name,
        action: t.action,
        enabled: t.enabled,
        lastRun: t.lastRun ? new Date(t.lastRun).toISOString() : 'never',
        nextRun: t.nextRun ? new Date(t.nextRun).toISOString() : 'pending',
        runCount: t.runCount,
        interval: t.interval
      })),
      activeTimers: this.timers.size
    };
  }
}

module.exports = ScheduleManager;
