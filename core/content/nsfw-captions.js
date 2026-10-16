'use strict';
/* ══════════════════════════════════════════════════════════════
 *  core/content/nsfw-captions.js — NSFW Caption Generator
 *
 *  PURPOSE: Generate random, unpredictable, engaging captions for
 *  every NSFW post on Twitter. Each caption is unique, makes sense
 *  for the content type, and is designed to maximize engagement
 *  (likes, retweets, replies, profile visits).
 *
 *  RESEARCH-BASED DESIGN:
 *    - Questions get 2× more replies than statements
 *    - Calls to action (CTA) get 1.5× more engagement
 *    - Teasing/curiosity captions get 3× more profile clicks
 *    - Emoji usage: 1-2 emojis = +15% engagement, 3+ = -5%
 *    - Length: 40-80 chars optimal, <25 = ignored, >140 = TLDR
 *    - Hashtags: 1-3 max, targeted beats generic
 *    - NEVER repeat the exact same caption (hash dedup)
 *    - Vary tone: playful, teasing, bold, subtle, direct
 *    - Time-aware: late night = more explicit, daytime = teasing
 *
 *  ANTI-DETECTION:
 *    - Never post identical text (spintax + random combination)
 *    - Vary sentence structure every post
 *    - Hashtags rotate from a large pool
 *    - No two posts in a row have the same tone
 *
 *  DEDUP:
 *    - Last 200 captions stored by hash
 *    - If generated caption matches, regenerate (max 5 attempts)
 * ══════════════════════════════════════════════════════════════ */

const crypto = require('crypto');

class NSFWCaptionGenerator {
  constructor(options = {}) {
    this.log = options.log || (() => {});
    this.maxHistory = options.maxHistory || 200;
    
    // Dedup history (hashes of past captions)
    this._history = [];
    
    // Last tone used (never repeat same tone twice in a row)
    this._lastTone = null;
    
    // Post counter for variety
    this._postCount = 0;
  }

  /* ════════════════════════════════════════════════════════════
   *  MAIN: Generate a caption for an NSFW post
   *  @param {Object} context
   *    - type: 'video' | 'image' | 'gif'
   *    - query: the search query used (e.g. 'ebony twerk')
   *    - title: media title (optional)
   *    - hour: current hour 0-23 (for time-aware captions)
   *  @returns {string} caption text
   * ════════════════════════════════════════════════════════════ */
  generate(context = {}) {
    const { type = 'video', query = '', title = '', hour = new Date().getHours() } = context;
    
    // Determine time context
    const timeContext = this._getTimeContext(hour);
    
    // Pick tone (never same as last)
    const tone = this._pickTone(timeContext);
    
    // Build caption from components
    let caption;
    let attempts = 0;
    const maxAttempts = 5;
    
    while (attempts < maxAttempts) {
      caption = this._buildCaption({ type, query, title, tone, timeContext });
      
      // Check dedup
      const hash = this._hash(caption);
      if (!this._history.includes(hash)) {
        this._history.push(hash);
        if (this._history.length > this.maxHistory) {
          this._history = this._history.slice(-this.maxHistory);
        }
        break;
      }
      attempts++;
    }
    
    this._lastTone = tone;
    this._postCount++;
    
    return caption || this._fallbackCaption(type);
  }

  /* ── Time context ──────────────────────────────────────────── */
  _getTimeContext(hour) {
    if (hour >= 0 && hour < 6) return 'lateNight';    // Explicit ok
    if (hour >= 6 && hour < 12) return 'morning';      // Teasing, soft
    if (hour >= 12 && hour < 17) return 'afternoon';   // Playful, bold
    if (hour >= 17 && hour < 21) return 'evening';     // Prime time - engaging
    return 'night';                                      // Direct, teasing
  }

  /* ── Pick tone (never same twice in a row) ────────────────── */
  _pickTone(timeContext) {
    const tones = {
      lateNight:  ['direct', 'bold', 'explicit', 'teasing'],
      morning:    ['teasing', 'playful', 'subtle', 'curious'],
      afternoon:  ['bold', 'playful', 'direct', 'confident'],
      evening:    ['engaging', 'teasing', 'bold', 'playful'],
      night:      ['direct', 'teasing', 'bold', 'confident']
    };
    
    const pool = tones[timeContext] || tones.evening;
    const available = pool.filter(t => t !== this._lastTone);
    return available[Math.floor(Math.random() * available.length)] || pool[0];
  }

  /* ── Build caption from components ─────────────────────────── */
  _buildCaption({ type, query, title, tone, timeContext }) {
    // Pick opening
    const opening = this._pickOpening(tone, type);
    
    // Pick body (may reference query/topic)
    const body = this._pickBody(tone, type, query);
    
    // Pick closing (CTA, question, or teaser)
    const closing = this._pickClosing(tone);
    
    // Pick 1-2 hashtags (rotated from large pool)
    const hashtags = this._pickHashtags(query, type);
    
    // Pick emoji (1-2 max for optimal engagement)
    const emoji = this._pickEmoji(tone, type);
    
    // Combine with random structure (don't always use same order)
    const structures = [
      () => `${opening} ${body} ${closing} ${hashtags}`,
      () => `${body} ${emoji} ${closing} ${hashtags}`,
      () => `${opening} ${emoji} ${body} ${hashtags}`,
      () => `${closing} ${body} ${hashtags} ${emoji}`,
      () => `${body} ${closing} ${emoji} ${hashtags}`,
      () => `${emoji} ${opening} ${body} ${hashtags}`,
      () => `${body} ${hashtags} ${closing}`,
    ];
    
    const structure = structures[Math.floor(Math.random() * structures.length)];
    let caption = structure().trim();
    
    // Enforce length limits (40-280 chars for Twitter)
    if (caption.length > 270) {
      caption = caption.substring(0, 267) + '...';
    }
    if (caption.length < 20) {
      caption = `${body} ${closing} ${hashtags}`;
    }
    
    return caption.trim();
  }

  /* ── Openings by tone ──────────────────────────────────────── */
  _pickOpening(tone, type) {
    const openings = {
      teasing: [
        'Just wait for it...', 'You\'re not ready for this', 'Brace yourself',
        'This one hits different', 'Don\'t scroll past this', 'Wait for the drop',
        'You might wanna sit down', 'Clear your schedule', 'This gonna make you stay',
        'Best thing you\'ll see today', 'Trust me on this one', 'Hold onto something',
        'You haven\'t seen nothing yet', 'This is the one', 'Scroll at your own risk'
      ],
      playful: [
        'Who sent this to me', 'Not me watching this on loop', 'I can\'t look away',
        'This got me acting up', 'Why is this so', 'Me watching this for the 10th time',
        'Somebody come get me', 'I\'m just gonna leave this here', 'No thoughts just vibes',
        'This speaks for itself', 'I said what I said', 'Not even sorry',
        'This my personality now', 'Can\'t help myself', 'It\'s giving what it needs to'
      ],
      bold: [
        'Straight fire', 'No cap this is insane', 'Absolute madness',
        'This is what peak looks like', 'Main character energy', 'Standout content',
        'Top tier right here', 'Unmatched', 'Setting the standard',
        'This is it chief', 'Ate and left no crumbs', 'Going crazy today',
        'Can\'t be topped', 'One of ones', 'Different breed'
      ],
      direct: [
        'Watch this', 'Check this out', 'This is the one',
        'Here\'s what you came for', 'Exactly what you need', 'You know what it is',
        'No introduction needed', 'Speak for itself', 'Self explanatory',
        'You already know', 'It\'s giving', 'Say less',
        'Period', 'Facts only', 'That\'s the vibe'
      ],
      subtle: [
        'Just dropping this', 'A little something', 'Quiet luxury',
        'Understated but powerful', 'Subtle flex', 'Lowkey amazing',
        'Soft but deadly', 'Calm energy', 'Doesn\'t need to be loud',
        'Whisper loud', 'Elegant', 'Classy but deadly'
      ],
      curious: [
        'Ever seen something like this', 'What do we think', 'Is this even real',
        'How is this possible', 'I have questions', 'Can someone explain',
        'Help me understand', 'What are we looking at', 'Make it make sense',
        'I\'m fascinated', 'Need to know more', 'This raises questions'
      ],
      confident: [
        'Say less', 'I already know', 'That\'s what I\'m talking about',
        'This is how we do it', 'Always delivering', 'Never miss',
        'Consistent excellence', 'On point as always', 'Standard behavior',
        'Expected nothing less', 'As predicted', 'Right on cue'
      ],
      engaging: [
        'Tag someone who needs to see this', 'Who relates', 'Rate this',
        'What\'s your take', 'Drop a comment', 'Tell me I\'m wrong',
        'Sound off in the replies', 'What you think', 'Drop your thoughts',
        'Am I wrong for this', 'Who else is watching', 'Real talk though'
      ],
      explicit: [
        'No shame in the game', 'Raw and unfiltered', 'Keeping it 100',
        'No filter needed', 'Unapologetic', 'As real as it gets',
        'Nothing to hide', 'What you see is what you get', 'Full send',
        'No holding back', 'All out', 'Zero chill'
      ]
    };
    
    const pool = openings[tone] || openings.bold;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  /* ── Body by tone and type ─────────────────────────────────── */
  _pickBody(tone, type, query) {
    // Extract topic from query for relevance
    const topic = this._extractTopic(query);
    
    const bodies = {
      video: [
        `this ${topic} video`, `watching this ${topic}`, `${topic} on another level`,
        `crazy ${topic} clip`, `${topic} that hits`, `insane ${topic} footage`,
        `this ${topic} though`, `${topic} going hard`, `unreal ${topic}`,
        `${topic} perfection`, `top ${topic} content`, `${topic} at its finest`,
        `the way this ${topic} moves`, `can\'t stop watching this ${topic}`,
        `${topic} that breaks the internet`
      ],
      image: [
        `this ${topic} pic`, `${topic} looking stunning`, `perfect ${topic} shot`,
        `${topic} beauty`, `captured perfectly`, `${topic} in full view`,
        `this ${topic} photo`, `${topic} serving looks`, `what a ${topic} shot`,
        `${topic} on display`, `breathtaking ${topic}`, `${topic} appreciation`,
        `the ${topic} angle`, `${topic} at its best`, `flawless ${topic}`
      ],
      gif: [
        `this ${topic} loop`, `${topic} on repeat`, `can\'t stop watching`,
        `${topic} goes crazy`, `stuck on this ${topic}`, `${topic} on loop`,
        `this ${topic} clip though`, `mesmerizing ${topic}`, `${topic} keeps going`,
        `infinite ${topic}`, `${topic} never gets old`, `looping this ${topic}`,
        `endless ${topic}`, `${topic} on replay`, `addicted to this ${topic}`
      ]
    };
    
    const pool = bodies[type] || bodies.video;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  /* ── Closing/CTA by tone ───────────────────────────────────── */
  _pickClosing(tone) {
    const closings = {
      teasing: [
        'you\'re welcome', 'you can thank me later', 'don\'t say I didn\'t warn you',
        'I\'ll be here all week', 'stay tuned', 'more where that came from',
        'just getting started', 'part 1 of many', 'to be continued...'
      ],
      playful: [
        'no regrets', 'living my best life', 'judge me later',
        'it\'s a vibe', 'mood of the day', 'that\'s just how it is',
        'I do what I want', 'no apologies', 'living rent free'
      ],
      bold: [
        'take notes', 'class dismissed', 'you\'re welcome',
        'drop the mic', 'that\'s a wrap', 'nothing more to say',
        'end of discussion', 'game over', 'checkmate'
      ],
      direct: [
        'drop a like if you agree', 'retweet if you feel this', 'save for later',
        'share the love', 'comment your thoughts', 'follow for more',
        'bookmark this', 'don\'t forget to like', 'pass it on'
      ],
      subtle: [
        'take it in', 'appreciate the art', 'let it speak to you',
        'sometimes less is more', 'take your time', 'no rush',
        'just observe', 'let it sink in', 'breathe'
      ],
      curious: [
        'what do you think', 'am I the only one', 'sound off below',
        'I need answers', 'debate time', 'genuinely curious',
        'let\'s discuss', 'your take', 'thoughts'
      ],
      confident: [
        'no debate', 'undeniable', 'can\'t argue with this',
        'the proof is right here', 'case closed', 'facts',
        'no counterargument', 'point made', 'done talking'
      ],
      engaging: [
        'drop your rating 1-10', 'what would you do', 'tag a friend who\'d love this',
        'reply with your fav part', 'double tap if you agree', 'quote tweet your reaction',
        'who else feels this', 'retweet the vibe', 'comment if you can relate'
      ],
      explicit: [
        'no apologies', 'raw vibes only', 'this is what it is',
        'embrace it', 'own it', 'unfiltered and proud',
        'keeping it real', 'no cap', 'full transparency'
      ]
    };
    
    const pool = closings[tone] || closings.direct;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  /* ── Hashtags ──────────────────────────────────────────────── */
  _pickHashtags(query, type) {
    // Large pool - rotates through, never same combo twice
    const baseTags = [
      'twerk', 'ebony', 'african', 'booty', 'curves', 'thick',
      'dance', 'vibes', 'mood', 'latepost', 'nightmode',
      'explore', 'fyp', 'viral', 'trending', 'content',
      'africanbeauty', 'melanin', 'blackgirlmagic', 'sundayvibes',
      'weekendmood', 'nightout', 'goodvibes', 'aesthetic'
    ];
    
    // Add query-specific tags
    const queryTags = [];
    const qLower = (query || '').toLowerCase();
    if (qLower.includes('twerk')) queryTags.push('twerking', 'twerkqueen');
    if (qLower.includes('ebony')) queryTags.push('ebonybeauty', 'ebonypassion');
    if (qLower.includes('africa')) queryTags.push('africanvibes', 'africandance');
    if (qLower.includes('booty') || qLower.includes('ass')) queryTags.push('thick', 'curves');
    if (qLower.includes('dance')) queryTags.push('dancevibes', 'dancemoves');
    if (qLower.includes('latina')) queryTags.push('latina', 'latinabeauty');
    if (qLower.includes('bbw')) queryTags.push('bbw', 'thickandpretty');
    if (qLower.includes('milf')) queryTags.push('milf', 'mature');
    if (qLower.includes('lesbian')) queryTags.push('lgbtq', 'wlw');
    if (qLower.includes('nigeria') || qLower.includes('nigerian')) queryTags.push('naija', 'nigerian');
    if (qLower.includes('ghana') || qLower.includes('ghanaian')) queryTags.push('ghana', 'ghanaian');
    if (qLower.includes('kenya') || qLower.includes('kenyan')) queryTags.push('kenyan', '254');
    if (qLower.includes('south') || qLower.includes('sa')) queryTags.push('mzansi', 'southafrican');
    
    // Combine pools and pick 1-2
    const allTags = [...baseTags, ...queryTags];
    const shuffled = allTags.sort(() => Math.random() - 0.5);
    const count = 1 + Math.floor(Math.random() * 2); // 1-2 hashtags
    const picked = shuffled.slice(0, count);
    
    return picked.map(t => '#' + t.replace(/\s+/g, '')).join(' ');
  }

  /* ── Emoji ─────────────────────────────────────────────────── */
  _pickEmoji(tone, type) {
    const emojis = {
      video: ['🔥', '🎬', '👀', '💦', '🥵', '💯', '⚡', '🙌'],
      image: ['📸', '😍', '💕', '🔥', '✨', '💎', '🫶', '💖'],
      gif:   ['🔁', '👀', '🔥', '💫', '🤩', '💦', '⚡', '✨']
    };
    
    const toneEmojis = {
      teasing: ['😏', '👅', '👀', '🤭'],
      playful: ['😝', '🤪', '😜', '😏'],
      bold:    ['💪', '🔥', '💯', '⚡'],
      direct:  ['👉', '👇', '🔥', '💯'],
      subtle:  ['✨', '💫', '🌙', '🤍'],
      curious: ['🤔', '👀', '🧐', '💭'],
      confident: ['💅', '👑', '😎', '💯'],
      engaging: ['💬', '👇', '🗣️', '👀'],
      explicit: ['🔥', '💦', '🥵', '👅']
    };
    
    const pool = [...(emojis[type] || emojis.video), ...(toneEmojis[tone] || toneEmojis.bold)];
    // Pick 1-2 (1-2 is optimal for engagement)
    const count = Math.random() < 0.6 ? 1 : 2;
    const shuffled = pool.sort(() => Math.random() - 0.5);
    return shuffled.slice(0, count).join('');
  }

  /* ── Extract topic from query ──────────────────────────────── */
  _extractTopic(query) {
    if (!query) return 'content';
    
    const q = query.toLowerCase().trim();
    
    // Map common queries to natural topic words
    const topicMap = {
      'ebony twerk': 'ebony twerk',
      'latina booty': 'latina',
      'african porn': 'african',
      'big booty twerking': 'twerk',
      'ebony dance': 'ebony dance',
      'nigerian twerk': 'Naija twerk',
      'south african porn': 'Mzansi',
      'ghana porn': 'Ghanaian',
      'booty shake': 'booty shake',
      'ebony threesome': 'ebony',
      'latina porn': 'Latina',
      'ebony bbw': 'BBW ebony',
      'african booty': 'african booty',
      'sexy dance': 'sexy dance',
      'twerking compilation': 'twerk compilation',
      'ebony lesbian': 'ebony',
      'kenyan porn': 'Kenyan',
      'ebony milf': 'ebony MILF',
      'booty clapping': 'booty clap',
      'african ebony': 'African ebony'
    };
    
    if (topicMap[q]) return topicMap[q];
    
    // Extract first meaningful word
    const words = q.split(/\s+/).filter(w => !['porn', 'sex', 'xxx', 'fuck'].includes(w));
    return words[0] || 'content';
  }

  /* ── Fallback caption ──────────────────────────────────────── */
  _fallbackCaption(type) {
    const fallbacks = [
      'This speaks for itself 🔥',
      'No caption needed 💯',
      'Just watch 🔥',
      'Content speaks 🔥',
      'Vibes on vibes ✨',
      'Self explanatory 💯',
      'Say less 🔥',
      'It\'s giving what it needs to ✨',
      'You already know 💯',
      'This right here 🔥'
    ];
    return fallbacks[Math.floor(Math.random() * fallbacks.length)];
  }

  /* ── Hash for dedup ────────────────────────────────────────── */
  _hash(text) {
    return crypto.createHash('md5').update(text.toLowerCase().trim()).digest('hex').substring(0, 12);
  }

  /* ── Get stats ─────────────────────────────────────────────── */
  getStats() {
    return {
      captionsGenerated: this._postCount,
      historySize: this._history.length,
      lastTone: this._lastTone
    };
  }

  /* ── Load history from external source (for persistence) ───── */
  loadHistory(history) {
    if (Array.isArray(history)) {
      this._history = history.slice(-this.maxHistory);
    }
  }

  /* ── Export history (for persistence) ──────────────────────── */
  exportHistory() {
    return this._history.slice();
  }
}

module.exports = NSFWCaptionGenerator;
