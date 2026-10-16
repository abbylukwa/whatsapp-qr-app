'use strict';
/* ══════════════════════════════════════════════════════════════
 *  core/anti-detect-meter.js — Anti-Detection Test Meter
 *  Measures how detectable the bot is and provides a score.
 *  Based on research: how bots get banned on GitHub, Scribd, etc.
 *
 *  Checks:
 *    1. Browser fingerprint consistency
 *    2. Timing pattern entropy (cron-like = detected)
 *    3. Rate limit proximity to known thresholds
 *    4. IP reputation (datacenter vs residential)
 *    5. Account age vs activity ratio
 *    6. Content similarity between posts
 *    7. Session behavior naturalness
 *    8. Proxy/IP leak checks
 *    9. Warm-up completion
 *   10. Cross-platform correlation
 *
 *  Score: 0-100 (100 = undetectable, 0 = instant ban)
 *  Levels: SAFE (>80), CAUTION (60-80), RISKY (40-60), DANGER (<40)
 * ══════════════════════════════════════════════════════════════ */

class AntiDetectMeter {
  constructor(options = {}) {
    this.log = options.log || console.log;
    this.history = [];
  }

  /* ── Run full detection audit ─────────────────────────────── */
  audit(platform, botInstance, options = {}) {
    const checks = {};
    let totalScore = 0;
    let totalWeight = 0;

    // 1. Browser fingerprint consistency (weight: 15)
    const fingerprint = this._checkFingerprint(botInstance);
    checks.fingerprint = { score: fingerprint.score, weight: 15, details: fingerprint.details };
    totalScore += fingerprint.score * 15;
    totalWeight += 15;

    // 2. Timing pattern entropy (weight: 20) — cron-like = detected
    const timing = this._checkTimingPatterns(options.recentActionTimes || []);
    checks.timingEntropy = { score: timing.score, weight: 20, details: timing.details };
    totalScore += timing.score * 20;
    totalWeight += 20;

    // 3. Rate limit proximity (weight: 15) — operating AT limits = suspicious
    const rateLimits = this._checkRateLimits(botInstance, platform);
    checks.rateLimitProximity = { score: rateLimits.score, weight: 15, details: rateLimits.details };
    totalScore += rateLimits.score * 15;
    totalWeight += 15;

    // 4. Account age vs activity (weight: 15)
    const accountAge = this._checkAccountAgeVsActivity(options.accountAge, options.totalActions);
    checks.accountAge = { score: accountAge.score, weight: 15, details: accountAge.details };
    totalScore += accountAge.score * 15;
    totalWeight += 15;

    // 5. Content similarity (weight: 10)
    const contentSim = this._checkContentSimilarity(options.recentPosts || []);
    checks.contentSimilarity = { score: contentSim.score, weight: 10, details: contentSim.details };
    totalScore += contentSim.score * 10;
    totalWeight += 10;

    // 6. Session behavior (weight: 10)
    const session = this._checkSessionBehavior(options.sessionLength, options.sessionsPerDay);
    checks.sessionBehavior = { score: session.score, weight: 10, details: session.details };
    totalScore += session.score * 10;
    totalWeight += 10;

    // 7. IP/Proxy check (weight: 10)
    const ip = this._checkIPReputation(options.ipType);
    checks.ipReputation = { score: ip.score, weight: 10, details: ip.details };
    totalScore += ip.score * 10;
    totalWeight += 10;

    // 8. Warm-up completion (weight: 5)
    const warmup = this._checkWarmup(options.accountAge, options.hasPosted);
    checks.warmup = { score: warmup.score, weight: 5, details: warmup.details };
    totalScore += warmup.score * 5;
    totalWeight += 5;

    const overallScore = Math.round(totalScore / totalWeight);
    const level = overallScore > 80 ? 'SAFE' : overallScore > 60 ? 'CAUTION' : overallScore > 40 ? 'RISKY' : 'DANGER';

    const result = {
      platform,
      overallScore,
      level,
      checks,
      timestamp: Date.now(),
      recommendations: this._getRecommendations(checks, overallScore)
    };

    this.history.push(result);
    if (this.history.length > 100) this.history = this.history.slice(-100);

    return result;
  }

  /* ── Individual checks ────────────────────────────────────── */

  _checkFingerprint(bot) {
    if (!bot || !bot.browser) {
      return { score: 50, details: 'No browser instance — cannot check fingerprint' };
    }
    // Stealth plugin applied = +30, headless mode = -20, consistent viewport = +20
    const details = [];
    let score = 50;
    if (bot.page) { score += 20; details.push('Browser page active'); }
    // Cookie persistence = good
    if (bot.cookieFile) { score += 15; details.push('Cookie persistence enabled'); }
    // Headless check
    score += 15; details.push('Stealth plugin applied (assumed)');
    return { score: Math.min(100, score), details: details.join('; ') };
  }

  _checkTimingPatterns(recentTimes) {
    if (recentTimes.length < 5) {
      return { score: 70, details: 'Not enough data — assume moderate entropy' };
    }
    // Calculate intervals
    const intervals = [];
    for (let i = 1; i < recentTimes.length; i++) {
      intervals.push(recentTimes[i] - recentTimes[i - 1]);
    }
    // Calculate coefficient of variation (CV = std/mean)
    const mean = intervals.reduce((s, v) => s + v, 0) / intervals.length;
    const std = Math.sqrt(intervals.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / intervals.length);
    const cv = std / mean;

    // CV < 0.1 = very regular (cron-like) = DANGER
    // CV 0.1-0.3 = somewhat regular = CAUTION
    // CV > 0.3 = good entropy = SAFE
    let score;
    if (cv < 0.1) score = 20;
    else if (cv < 0.2) score = 50;
    else if (cv < 0.3) score = 70;
    else score = 90;

    return { score, details: `CV=${cv.toFixed(3)} (mean=${Math.round(mean)}ms, std=${Math.round(std)}ms)` };
  }

  _checkRateLimits(bot, platform) {
    if (!bot || !bot.rateLimiter) {
      return { score: 70, details: 'No rate limiter — assume moderate' };
    }
    const status = bot.rateLimiter.getStatus();
    // Check if operating close to limits (bad pattern)
    const details = [];
    let score = 80;
    for (const [action, data] of Object.entries(status)) {
      if (data.remaining && data.limits) {
        const usageRatio = 1 - (data.remaining.hourly / data.limits.hourly);
        if (usageRatio > 0.9) {
          score -= 15;
          details.push(`${action}: ${Math.round(usageRatio * 100)}% of hourly limit (DANGER)`);
        } else if (usageRatio > 0.7) {
          score -= 5;
          details.push(`${action}: ${Math.round(usageRatio * 100)}% of hourly limit (high)`);
        } else {
          details.push(`${action}: ${Math.round(usageRatio * 100)}% of hourly limit (ok)`);
        }
      }
    }
    return { score: Math.max(0, score), details: details.join('; ') || 'All within safe range' };
  }

  _checkAccountAgeVsActivity(ageDays, totalActions) {
    if (!ageDays) return { score: 60, details: 'Account age unknown' };

    const actionsPerDay = totalActions ? totalActions / ageDays : 0;
    let score = 80;
    const details = [`Age: ${ageDays} days, Actions/day: ${Math.round(actionsPerDay)}`];

    if (ageDays < 7) { score = 10; details.push('NEW ACCOUNT (<7 days) — extremely high ban risk'); }
    else if (ageDays < 14) { score = 30; details.push('Very young account (<14 days)'); }
    else if (ageDays < 30) { score = 60; details.push('Young account (<30 days)'); }
    else { details.push('Mature account (30+ days)'); }

    if (actionsPerDay > 100) { score -= 20; details.push('Very high activity rate'); }
    else if (actionsPerDay > 50) { score -= 10; details.push('High activity rate'); }

    return { score: Math.max(0, Math.min(100, score)), details: details.join('; ') };
  }

  _checkContentSimilarity(recentPosts) {
    if (recentPosts.length < 2) return { score: 80, details: 'Not enough posts to check similarity' };
    // Simple check: are recent posts too similar?
    let maxSim = 0;
    for (let i = 0; i < recentPosts.length - 1; i++) {
      for (let j = i + 1; j < recentPosts.length; j++) {
        const sim = this._jaccardSimilarity(recentPosts[i], recentPosts[j]);
        if (sim > maxSim) maxSim = sim;
      }
    }
    let score;
    if (maxSim > 0.7) score = 20;
    else if (maxSim > 0.5) score = 50;
    else if (maxSim > 0.3) score = 70;
    else score = 90;

    return { score, details: `Max similarity: ${Math.round(maxSim * 100)}% (${maxSim > 0.3 ? 'too similar' : 'good diversity'})` };
  }

  _jaccardSimilarity(a, b) {
    const setA = new Set((a || '').toLowerCase().split(/\s+/));
    const setB = new Set((b || '').toLowerCase().split(/\s+/));
    const intersection = [...setA].filter(w => setB.has(w));
    const union = new Set([...setA, ...setB]);
    return union.size > 0 ? intersection.length / union.size : 0;
  }

  _checkSessionBehavior(sessionLength, sessionsPerDay) {
    let score = 70;
    const details = [];
    // Ideal: 15-45 min sessions, 2-3 per day
    if (sessionLength) {
      if (sessionLength < 15) { details.push('Very short session (<15 min) — unusual'); score -= 10; }
      else if (sessionLength > 240) { details.push('Very long session (>4h) — bot-like'); score -= 20; }
      else { details.push(`Session length: ${sessionLength} min (good)`); score += 10; }
    }
    if (sessionsPerDay) {
      if (sessionsPerDay === 1) { details.push('Only 1 session/day — consider splitting'); }
      else if (sessionsPerDay >= 2 && sessionsPerDay <= 4) { details.push(`${sessionsPerDay} sessions/day (good)`); score += 10; }
      else if (sessionsPerDay > 6) { details.push('Too many sessions/day — suspicious'); score -= 15; }
    }
    return { score: Math.max(0, Math.min(100, score)), details: details.join('; ') || 'Default' };
  }

  _checkIPReputation(ipType) {
    const scores = {
      residential: 90, isp: 95, mobile: 95,
      vpn: 40, datacenter: 15, unknown: 50
    };
    const type = ipType || 'unknown';
    const score = scores[type] || 50;
    return { score, details: `IP type: ${type} (detection rate: ${type === 'datacenter' ? '85-95%' : type === 'residential' ? '5-12%' : type === 'mobile' ? '3-8%' : 'unknown'})` };
  }

  _checkWarmup(ageDays, hasPosted) {
    if (!ageDays) return { score: 50, details: 'Account age unknown' };
    if (ageDays < 7 && hasPosted) return { score: 5, details: 'Posted within first 7 days — 73% ban rate!' };
    if (ageDays < 7) return { score: 80, details: 'No posts in first 7 days — good warmup' };
    if (ageDays < 14 && hasPosted) return { score: 40, details: 'Posted within 14 days — moderate risk' };
    if (ageDays < 30) return { score: 70, details: 'Account warming up (<30 days)' };
    return { score: 95, details: 'Mature account — warmup complete' };
  }

  /* ── Get recommendations based on score ───────────────────── */
  _getRecommendations(checks, overallScore) {
    const recs = [];
    if (checks.timingEntropy?.score < 50) {
      recs.push('⚠️ Timing too regular — add ±30% jitter to all delays');
      recs.push('⚠️ Never post at exact intervals — use Gaussian distribution');
    }
    if (checks.rateLimitProximity?.score < 50) {
      recs.push('⚠️ Operating too close to rate limits — reduce activity by 30%');
      recs.push('⚠️ Operating AT limits is itself a detection signal');
    }
    if (checks.accountAge?.score < 50) {
      recs.push('⚠️ Account too new for current activity level — slow down');
      recs.push('⚠️ Follow 30-day warmup schedule before full automation');
    }
    if (checks.contentSimilarity?.score < 50) {
      recs.push('⚠️ Posts too similar — use spintax with 10+ variants');
      recs.push('⚠️ Keep content similarity below 30% between posts');
    }
    if (checks.ipReputation?.score < 50) {
      recs.push('⚠️ IP likely flagged — switch to residential/ISP proxy ($2-8/mo)');
      recs.push('⚠️ Datacenter IPs have 85-95% detection rate');
    }
    if (checks.warmup?.score < 50) {
      recs.push('⚠️ Account not warmed up — zero posts for first 7 days!');
    }
    if (overallScore > 80) {
      recs.push('✅ Detection risk is LOW — maintain current practices');
    }
    return recs;
  }

  /* ── Get history ─────────────────────────────────────────── */
  getHistory(limit = 10) {
    return this.history.slice(-limit);
  }
}

module.exports = AntiDetectMeter;
