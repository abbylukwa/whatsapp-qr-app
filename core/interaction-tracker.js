'use strict';
/* ══════════════════════════════════════════════════════════════
 *  core/interaction-tracker.js — Cross-Platform Interaction Tracker
 *  Tracks ALL post interactions for decision-making across all
 *  platforms (except WhatsApp which is thought-through separately).
 *
 *  The bot knows:
 *    - How every post performed (views, likes, comments, shares)
 *    - Which content types perform best per platform
 *    - Optimal posting times based on engagement data
 *    - Which audiences engage most
 *    - Content that flopped (don't repeat similar)
 *    - Growth trends over time
 *
 *  This data drives:
 *    - Content selection (what to post next)
 *    - Posting time optimization
 *    - Platform-specific content adaptation
 *    - A/B testing of templates
 *    - Channel growth strategy
 * ══════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');

class InteractionTracker {
  constructor(options = {}) {
    this.dataDir = options.dataDir || './data/interactions';
    this.log = options.log || console.log;
    this.maxHistory = options.maxHistory || 10000;
    this.interactions = {};
    this.summary = {};
    this._load();
  }

  /* ── Record a post creation ──────────────────────────────── */
  recordPost(platform, postId, metadata = {}) {
    if (!this.interactions[platform]) this.interactions[platform] = {};
    this.interactions[platform][postId] = {
      id: postId,
      platform,
      createdAt: Date.now(),
      type: metadata.type || 'post',          // post, short, community, comment
      subject: metadata.subject || null,       // English, Math, Science, etc.
      template: metadata.template || null,     // didYouKnow, riddle, etc.
      content: metadata.content?.substring(0, 200) || '', // first 200 chars
      metrics: {
        views: 0, likes: 0, comments: 0, shares: 0,
        saves: 0, clicks: 0, impressions: 0,
        watchTime: 0,                        // average watch time (video)
        engagementRate: 0,                   // calculated
        clickThroughRate: 0
      },
      interactions: [],    // individual interaction events
      lastUpdated: Date.now()
    };
    this._save();
    this.log('info', 'interactions', `Post recorded: ${platform}/${postId}`);
  }

  /* ── Update metrics for a post ───────────────────────────── */
  updateMetrics(platform, postId, metrics) {
    const post = this.interactions[platform]?.[postId];
    if (!post) return;

    Object.assign(post.metrics, metrics);

    // Calculate engagement rate
    const total = post.metrics.likes + post.metrics.comments + post.metrics.shares + post.metrics.saves;
    post.metrics.engagementRate = post.metrics.impressions > 0
      ? (total / post.metrics.impressions) * 100
      : 0;

    // Calculate CTR
    post.metrics.clickThroughRate = post.metrics.impressions > 0
      ? (post.metrics.clicks / post.metrics.impressions) * 100
      : 0;

    post.lastUpdated = Date.now();
    this._save();
  }

  /* ── Record a specific interaction event ─────────────────── */
  recordInteraction(platform, postId, interaction) {
    const post = this.interactions[platform]?.[postId];
    if (!post) return;

    post.interactions.push({
      type: interaction.type,  // like, comment, share, view, save, follow_from_post
      from: interaction.from || 'unknown',
      at: Date.now(),
      data: interaction.data || {}
    });

    // Keep only last 100 interactions per post
    if (post.interactions.length > 100) {
      post.interactions = post.interactions.slice(-100);
    }

    this._save();
  }

  /* ── Get best performing content ─────────────────────────── */
  getBestContent(platform, limit = 10) {
    const posts = Object.values(this.interactions[platform] || {});
    return posts
      .sort((a, b) => b.metrics.engagementRate - a.metrics.engagementRate)
      .slice(0, limit);
  }

  /* ── Get worst performing content (avoid similar) ────────── */
  getWorstContent(platform, limit = 10) {
    const posts = Object.values(this.interactions[platform] || {});
    return posts
      .sort((a, b) => a.metrics.engagementRate - b.metrics.engagementRate)
      .slice(0, limit);
  }

  /* ── Get optimal posting times ───────────────────────────── */
  getOptimalTimes(platform) {
    const posts = Object.values(this.interactions[platform] || {});
    const hourBuckets = {};

    for (const post of posts) {
      const hour = new Date(post.createdAt).getHours();
      if (!hourBuckets[hour]) hourBuckets[hour] = { count: 0, totalEngagement: 0 };
      hourBuckets[hour].count++;
      hourBuckets[hour].totalEngagement += post.metrics.engagementRate;
    }

    return Object.entries(hourBuckets)
      .map(([hour, data]) => ({
        hour: parseInt(hour),
        avgEngagement: data.totalEngagement / data.count,
        postCount: data.count
      }))
      .sort((a, b) => b.avgEngagement - a.avgEngagement);
  }

  /* ── Get performance by subject ──────────────────────────── */
  getPerformanceBySubject(platform) {
    const posts = Object.values(this.interactions[platform] || {});
    const subjectBuckets = {};

    for (const post of posts) {
      const subject = post.subject || 'unknown';
      if (!subjectBuckets[subject]) subjectBuckets[subject] = { count: 0, totalEngagement: 0, totalViews: 0 };
      subjectBuckets[subject].count++;
      subjectBuckets[subject].totalEngagement += post.metrics.engagementRate;
      subjectBuckets[subject].totalViews += post.metrics.views;
    }

    return Object.entries(subjectBuckets)
      .map(([subject, data]) => ({
        subject,
        avgEngagement: data.totalEngagement / data.count,
        avgViews: data.totalViews / data.count,
        postCount: data.count
      }))
      .sort((a, b) => b.avgEngagement - a.avgEngagement);
  }

  /* ── Get performance by template ─────────────────────────── */
  getPerformanceByTemplate(platform) {
    const posts = Object.values(this.interactions[platform] || {});
    const templateBuckets = {};

    for (const post of posts) {
      const template = post.template || 'unknown';
      if (!templateBuckets[template]) templateBuckets[template] = { count: 0, totalEngagement: 0 };
      templateBuckets[template].count++;
      templateBuckets[template].totalEngagement += post.metrics.engagementRate;
    }

    return Object.entries(templateBuckets)
      .map(([template, data]) => ({
        template,
        avgEngagement: data.totalEngagement / data.count,
        postCount: data.count
      }))
      .sort((a, b) => b.avgEngagement - a.avgEngagement);
  }

  /* ── Get growth trend (daily/weekly/monthly) ─────────────── */
  getGrowthTrend(platform, period = 'daily') {
    const posts = Object.values(this.interactions[platform] || {});
    const buckets = {};

    for (const post of posts) {
      const date = new Date(post.createdAt);
      let key;
      if (period === 'daily') key = date.toISOString().split('T')[0];
      else if (period === 'weekly') {
        const weekStart = new Date(date);
        weekStart.setDate(date.getDate() - date.getDay());
        key = weekStart.toISOString().split('T')[0];
      } else {
        key = date.toISOString().substring(0, 7); // YYYY-MM
      }

      if (!buckets[key]) buckets[key] = { posts: 0, views: 0, engagement: 0, followers: 0 };
      buckets[key].posts++;
      buckets[key].views += post.metrics.views;
      buckets[key].engagement += post.metrics.engagementRate;
    }

    return Object.entries(buckets)
      .map(([period, data]) => ({
        period,
        posts: data.posts,
        views: data.views,
        avgEngagement: data.engagement / data.posts
      }))
      .sort((a, b) => a.period.localeCompare(b.period));
  }

  /* ── Get decision recommendation for next post ───────────── */
  getNextPostRecommendation(platform) {
    const bestSubject = this.getPerformanceBySubject(platform);
    const bestTemplate = this.getPerformanceByTemplate(platform);
    const optimalTimes = this.getOptimalTimes(platform);

    return {
      recommendedSubject: bestSubject[0]?.subject || 'Science',
      recommendedTemplate: bestTemplate[0]?.template || 'didYouKnow',
      recommendedHour: optimalTimes[0]?.hour || 10,
      reason: `Based on ${Object.keys(this.interactions[platform] || {}).length} posts on ${platform}`,
      topSubjects: bestSubject.slice(0, 3),
      topTemplates: bestTemplate.slice(0, 3),
      topHours: optimalTimes.slice(0, 5)
    };
  }

  /* ── Get full status ─────────────────────────────────────── */
  getStatus() {
    const status = {};
    for (const [platform, posts] of Object.entries(this.interactions)) {
      const postList = Object.values(posts);
      status[platform] = {
        totalPosts: postList.length,
        totalViews: postList.reduce((s, p) => s + p.metrics.views, 0),
        totalLikes: postList.reduce((s, p) => s + p.metrics.likes, 0),
        totalComments: postList.reduce((s, p) => s + p.metrics.comments, 0),
        avgEngagement: postList.length > 0
          ? postList.reduce((s, p) => s + p.metrics.engagementRate, 0) / postList.length
          : 0
      };
    }
    return status;
  }

  /* ── Persistence ─────────────────────────────────────────── */
  _load() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const file = path.join(this.dataDir, 'interactions.json');
      if (fs.existsSync(file)) {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        this.interactions = data.interactions || {};
        this.summary = data.summary || {};
      }
    } catch (e) {
      this.log('warn', 'interactions', `Load failed: ${e.message}`);
    }
  }

  _save() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const file = path.join(this.dataDir, 'interactions.json');
      fs.writeFileSync(file, JSON.stringify({ interactions: this.interactions, summary: this.summary }, null, 2));
    } catch (e) {
      this.log('warn', 'interactions', `Save failed: ${e.message}`);
    }
  }
}

module.exports = InteractionTracker;
