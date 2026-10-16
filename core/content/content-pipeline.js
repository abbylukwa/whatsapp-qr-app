'use strict';
/* ══════════════════════════════════════════════════════════════
 *  core/content/content-pipeline.js — Content Pipeline
 *  The MAIN system that sources, generates, and distributes
 *  content across YouTube, Facebook, Twitter, and TikTok.
 *
 *  Content sources:
 *    1. WhatsApp NSFW → cross-post to Twitter (same content)
 *    2. Educational shorts → YouTube Shorts + Facebook
 *    3. YouTube community posts → engagement content
 *    4. Trending topics → all platforms
 *    5. Life/fun facts → YouTube Shorts + Facebook + Twitter
 *
 *  Research-based posting schedule:
 *    YouTube:  3 uploads/day, 1-2 community/day, 2 shorts/day
 *    Facebook: 2 timeline/day (HALF YouTube), 3 group posts/day
 *    Twitter:  5-10 tweets/day (NSFW cross-post + facts + engagement)
 *    TikTok:   engagement only (follow, comment, watch)
 *
 *  Anti-detection:
 *    - Content similarity <30% between any two posts
 *    - 24-48h stagger between same content on different platforms
 *    - Spintax variation on all text
 *    - Never post identical content to 5+ destinations
 * ══════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const { EducationalShortsGenerator, CURRICULUM, TEMPLATES } = require('./educational-shorts');
const DataManager = require('../data-manager');

class ContentPipeline {
  constructor(options = {}) {
    this.log = options.log || console.log;
    this.dataDir = options.dataDir || './data/content';
    this.interactionTracker = options.interactionTracker || null;
    this.scraper = options.scraper || null;
    
    // Content history for dedup and similarity
    this.data = new DataManager('content-pipeline', this.dataDir);
    this.data.setLog(this.log);
    
    // Educational shorts generator
    this.shortsGenerator = new EducationalShortsGenerator({
      log: this.log,
      dataDir: this.dataDir + '/shorts',
      ttsEngine: options.ttsEngine || 'edge-tts',
      videoEngine: options.videoEngine || 'static-image'
    });
    
    // Track what's been posted where (avoid cross-platform repetition)
    this.postedContent = {
      youtube: [],
      facebook: [],
      twitter: [],
      tiktok: []
    };
    
    // Load history
    this._loadHistory();
    
    // NSFW cross-post queue (WhatsApp → Twitter)
    this.nsfwQueue = [];
    
    // Content type rotation for YouTube (not just educational!)
    // Research: successful channels mix content types
    this.youtubeContentMix = {
      educational: 0.25,    // 25% educational shorts
      trending: 0.20,       // 20% trending/topic commentary
      community: 0.20,      // 20% community engagement posts
      funFacts: 0.20,       // 20% fun facts / trivia
      motivational: 0.15    // 15% motivational/inspirational
    };
    
    // Twitter content mix (includes NSFW cross-post)
    this.twitterContentMix = {
      nsfwCrossPost: 0.30,  // 30% NSFW from WhatsApp
      educational: 0.20,    // 20% educational facts
      engagement: 0.20,     // 20% engagement/reply content
      funFacts: 0.15,       // 15% fun facts
      motivational: 0.15    // 15% motivational
    };
  }
  
  /* ── Load history from disk ───────────────────────────────── */
  _loadHistory() {
    try {
      const histFile = path.join(this.dataDir, 'pipeline-history.json');
      if (fs.existsSync(histFile)) {
        const saved = JSON.parse(fs.readFileSync(histFile, 'utf8'));
        this.postedContent = saved.postedContent || this.postedContent;
        this.nsfwQueue = saved.nsfwQueue || [];
      }
    } catch (e) {
      this.log('warn', 'content', 'History load failed: ' + e.message);
    }
  }
  
  /* ── Save history to disk ─────────────────────────────────── */
  _saveHistory() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      // Keep last 200 per platform
      for (const platform of Object.keys(this.postedContent)) {
        if (this.postedContent[platform].length > 200) {
          this.postedContent[platform] = this.postedContent[platform].slice(-200);
        }
      }
      fs.writeFileSync(
        path.join(this.dataDir, 'pipeline-history.json'),
        JSON.stringify({ postedContent: this.postedContent, nsfwQueue: this.nsfwQueue.slice(-50) }, null, 2)
      );
    } catch (e) {
      this.log('warn', 'content', 'History save failed: ' + e.message);
    }
  }
  
  /* ── Spintax resolver ─────────────────────────────────────── */
  resolveSpintax(text) {
    let resolved = text;
    let safety = 0;
    while (resolved.includes('{') && safety < 20) {
      resolved = resolved.replace(/\{([^{}]+)\}/g, (match, options) => {
        const parts = options.split('|');
        return parts[Math.floor(Math.random() * parts.length)];
      });
      safety++;
    }
    return resolved;
  }
  
  /* ── Check content similarity (Jaccard) ──────────────────── */
  _similarity(a, b) {
    if (!a || !b) return 0;
    const setA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 3));
    const setB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 3));
    if (setA.size === 0 && setB.size === 0) return 0;
    const intersection = [...setA].filter(w => setB.has(w));
    const union = new Set([...setA, ...setB]);
    return union.size > 0 ? intersection.length / union.size : 0;
  }
  
  /* ── Check if content is too similar to recent posts ──────── */
  _isTooSimilar(content, platform, threshold = 0.3) {
    const recent = this.postedContent[platform] || [];
    for (const item of recent.slice(-20)) {
      if (this._similarity(content, item.text) > threshold) {
        return true;
      }
    }
    return false;
  }
  
  /* ── Record posted content ────────────────────────────────── */
  _recordPost(platform, content, metadata = {}) {
    this.postedContent[platform].push({
      text: content.substring(0, 500),
      type: metadata.type || 'unknown',
      timestamp: Date.now(),
      ...metadata
    });
    this._saveHistory();
    
    // Track in interaction tracker
    if (this.interactionTracker) {
      this.interactionTracker.recordPost(platform, {
        type: metadata.type,
        content: content.substring(0, 200),
        subject: metadata.subject,
        template: metadata.template
      });
    }
  }
  
  /* ── Get a unique content piece (retry if too similar) ──── */
  _getUniqueContent(generatorFn, platform, maxRetries = 5) {
    for (let i = 0; i < maxRetries; i++) {
      const content = generatorFn();
      if (!this._isTooSimilar(content.text, platform)) {
        return content;
      }
    }
    // All retries exhausted — add variation and return anyway
    const content = generatorFn();
    content.text = content.text + ' [' + new Date().toLocaleTimeString() + ']';
    return content;
  }
  
  /* ════════════════════════════════════════════════════════════
   *  NSFW CROSS-POST: WhatsApp → Twitter
   *  When NSFW video is sent to WhatsApp group, also tweet it.
   * ════════════════════════════════════════════════════════════ */
  queueNSFWForTwitter(videoData) {
    // videoData = { title, query, url, type, thumbnailUrl }
    this.nsfwQueue.push({
      ...videoData,
      queuedAt: Date.now(),
      posted: false
    });
    
    // Keep queue manageable
    if (this.nsfwQueue.length > 100) {
      this.nsfwQueue = this.nsfwQueue.filter(q => !q.posted).slice(-50);
    }
    
    this._saveHistory();
    this.log('info', 'content', 'NSFW queued for Twitter cross-post: ' + (videoData.title || videoData.query));
  }
  
  getTwitterNSFWPost() {
    // Get the next unposted NSFW item from queue
    const next = this.nsfwQueue.find(q => !q.posted);
    if (!next) return null;
    
    // Create tweet text (280 char limit)
    const templates = [
      '{🔥|🔥🔥|🔥🔥🔥} {New|Fresh|Just dropped} {vid|video|content} {incoming|dropped|alert}! {Check|Peep|Watch} it out 👀',
      '{Hot|🔥|Spicy} {content|video|drop} {alert|incoming}! {You|Ya} {know|kno} what to do 🫣',
      '{Late night|Midnight|Evening} {vibes|content|drop} {🔥|💦|👀} {Who|Y\'all} {awake|up|watching}?',
      '{New|Fresh} {upload|post|drop} {just|just} {dropped|landed}! {Dont|Don\'t} {miss|sleep on} this {🔥|💯}',
      '{Weekend|Tonight|Right now} {special|vibes|mood} {🔥|👀|💯} {Tap|Click|Link} in bio'
    ];
    
    const template = templates[Math.floor(Math.random() * templates.length)];
    let tweetText = this.resolveSpintax(template);
    
    // Add title if fits (280 char limit)
    if (next.title && (tweetText + ' ' + next.title).length <= 270) {
      tweetText += ' ' + next.title;
    }
    
    // Mark as posted
    next.posted = true;
    this._saveHistory();
    
    return {
      text: tweetText.substring(0, 280),
      type: 'nsfw_crosspost',
      source: 'whatsapp',
      originalData: next,
      mediaUrl: next.thumbnailUrl || next.url
    };
  }
  
  /* ════════════════════════════════════════════════════════════
   *  YOUTUBE CONTENT GENERATION
   *  Mix of: educational, trending, community, fun facts, motivational
   * ════════════════════════════════════════════════════════════ */
  
  getYouTubeCommunityPost() {
    // Rotate through content types based on mix weights
    const roll = Math.random();
    let cumulative = 0;
    
    for (const [type, weight] of Object.entries(this.youtubeContentMix)) {
      cumulative += weight;
      if (roll < cumulative) {
        return this._getUniqueContent(
          () => this._generateYouTubeContent(type),
          'youtube'
        );
      }
    }
    
    // Default: fun fact
    return this._getUniqueContent(
      () => this._generateYouTubeContent('funFacts'),
      'youtube'
    );
  }
  
  _generateYouTubeContent(type) {
    switch (type) {
      case 'educational':
        return this._generateEducationalPost();
      case 'trending':
        return this._generateTrendingPost();
      case 'community':
        return this._generateCommunityEngagementPost();
      case 'funFacts':
        return this._generateFunFactPost();
      case 'motivational':
        return this._generateMotivationalPost();
      default:
        return this._generateFunFactPost();
    }
  }
  
  _generateEducationalPost() {
    const script = this.shortsGenerator.generateScript();
    const templates = [
      '📚 Did you know? ' + script.script.hook + '\n\n' + script.script.main + '\n\n' + script.script.twist + '\n\n👇 Follow for more ' + script.subject + ' facts!',
      '🧠 ' + script.script.hook + '\n\n' + script.script.main + '\n\nSource: ' + script.source + '\n\n🔔 Turn on notifications for daily facts!',
      '📖 FACT: ' + script.topic + '\n\n' + script.script.main + '\n\n' + script.script.cta + '\n\n#' + script.subject + ' #Education #Facts'
    ];
    const text = templates[Math.floor(Math.random() * templates.length)];
    return {
      text: this.resolveSpintax(text),
      type: 'educational',
      subject: script.subject,
      level: script.level,
      template: script.template
    };
  }
  
  _generateTrendingPost() {
    const topics = [
      { topic: 'AI revolution', text: '{AI is|Artificial Intelligence is} {transforming|changing|reshaping} {everything|every industry|the world}. {What|How} do you think {it|AI} will {impact|affect|change} {education|jobs|creativity} in the next {5|10} years?' },
      { topic: 'Space exploration', text: '{Space|The cosmos} is {getting|becoming} more {accessible|exciting}! {With|Between} {SpaceX|NASA|ESA} {launches|missions} {happening|going} {regularly|every month}, {we|humanity} might {see|witness} a {Mars|lunar} colony {within|in} our {lifetime|lifetime!}. {Thoughts?|What do you think?}' },
      { topic: 'Climate action', text: '{Climate|Environmental} {change|action} is the {biggest|most important} {challenge|issue} of our {generation|time}. {Small|Every} {action|step} {counts|matters}. What are YOU doing to {help|make a difference}?' },
      { topic: 'Tech innovation', text: '{Tech|Technology} {moves|is moving} {fast|faster than ever}! {From|Between} {quantum computing|new chips|AI breakthroughs}, {VR|metaverse}, and {robotics|automation}, the {future|next decade} will be {unlike|different from} anything {we|humanity has} {seen|experienced}. {Which|What} {excites|interests} you most?' },
      { topic: 'Mental health', text: '{Mental health|Mental wellness} {matters|is important}! {Remember|Don\'t forget}: {taking breaks|resting} isn\'t {lazy|being lazy} — it\'s {necessary|essential}. {What|How} do you {unwind|decompress|relax} after a {long|stressful} day?' },
      { topic: 'Education reform', text: '{Education|Learning} is {evolving|changing}! {Online|Digital} learning, {AI tutors|personalized education}, and {project-based|hands-on} learning are {transforming|reshaping} {classrooms|schools}. {Is|Does} traditional {schooling|education} still {work|make sense}?' },
      { topic: 'Crypto & Web3', text: '{Crypto|Web3|Blockchain} keeps {evolving|developing}! {Beyond|Past} the {hype|speculation}, {decentralization|trustless systems} could {transform|revolutionize} {finance|governance|the internet}. {Are|Do} you {bullish|optimistic} or {bearish|skeptical}?' },
      { topic: 'Fitness trends', text: '{Fitness|Working out} {trends|is trending}! {From|Whether it\'s} {HIIT|yoga|calisthenics|functional training}, {finding|discovering} what {works|clicks} for YOU is {key|everything}. {What|How} do you {stay active|work out}?' }
    ];
    
    const topic = topics[Math.floor(Math.random() * topics.length)];
    const text = this.resolveSpintax(topic.text);
    
    return {
      text,
      type: 'trending',
      subject: topic.topic,
      template: 'trending'
    };
  }
  
  _generateCommunityEngagementPost() {
    const templates = [
      '{Question|Quick question} for the {community|fam|family}: {What|How} {do you|would you} {deal with|handle} {procrastination|stress|burnout}? {Share|Drop} your {tips|advice} {below|in comments}! 👇',
      '{Let\'s|Time to} {talk|discuss}! {What|Which} {skill|thing} do you {wish|want to} you {learned|knew} {earlier|sooner}? {I\'ll|Let me} {go|start} first... 🤔',
      '{Poll|Vote} time! {What|Which} {do you|would you} {prefer|choose}: {working early morning|being a morning person} OR {late night grinding|staying up late}? {Comment|Type} 1 or 2! 📊',
      '{Shoutout|Props} to {everyone|anyone} {learning|studying} {something new|a new skill}! {It|That} takes {real courage|guts} to {start|begin}. {Keep|Continue} {going|pushing}! 💪',
      '{Real talk|Honest question}: {What|How} has {social media|the internet} {changed|impacted} your {life|daily routine}? {Good|Positive} or {bad|negative}? {Discuss|Let me know}!',
      '{Challenge|Task} of the {day|week}: {Learn|Try} something {new|you\'ve never done} {today|this week} and {share|tell us} about it! {Even|Even if} it\'s {small|tiny}. 🌱',
      '{What|Tell me what} {motivates|drives} you to {keep going|not give up}? {Sometimes|Occasionally} we all {need|could use} a {reminder|push}. {Share|Drop} your {inspiration|motivation}! ✨',
      '{Hot take|Controversial opinion}: {Traditional|Regular} {school|education} {doesn\'t|doesn\'t always} {teach|cover} the {most important|critical} {life skills|things}. {Agree|Thoughts} or {disagree|differ}? 🎓'
    ];
    
    const template = templates[Math.floor(Math.random() * templates.length)];
    return {
      text: this.resolveSpintax(template),
      type: 'community',
      subject: 'engagement',
      template: 'community'
    };
  }
  
  _generateFunFactPost() {
    const facts = [
      { fact: 'A group of flamingos is called a "flamboyance" 🦩', category: 'animals' },
      { fact: 'Honey never spoils. 3,000-year-old honey found in Egyptian tombs is still edible! 🍯', category: 'food' },
      { fact: 'Octopuses have three hearts and blue blood 🐙', category: 'animals' },
      { fact: 'The shortest commercial flight in the world is 57 seconds (Scotland) ✈️', category: 'travel' },
      { fact: 'A jiffy is an actual unit of time: 1/100th of a second ⏱️', category: 'science' },
      { fact: 'Bananas are berries, but strawberries aren\'t 🍌', category: 'food' },
      { fact: 'The human brain uses 20% of the body\'s total energy 🧠', category: 'science' },
      { fact: 'There are more possible chess games than atoms in the universe ♟️', category: 'math' },
      { fact: 'Cows have best friends and get stressed when separated 🐄', category: 'animals' },
      { fact: 'The world\'s oldest known living tree is 4,855 years old 🌲', category: 'nature' },
      { fact: 'Lightning strikes Earth about 8 million times per day ⚡', category: 'science' },
      { fact: 'A shrimp\'s heart is in its head 🦐', category: 'animals' },
      { fact: 'Venus is the only planet that rotates clockwise 🪐', category: 'space' },
      { fact: 'The average person walks 100,000 miles in a lifetime 🚶', category: 'health' },
      { fact: 'Wombat poop is cube-shaped 🔲', category: 'animals' },
      { fact: 'A day on Venus is longer than a year on Venus 🌅', category: 'space' },
      { fact: 'The unicorn is Scotland\'s national animal 🦄', category: 'fun' },
      { fact: 'An ostrich\'s eye is bigger than its brain 🐦', category: 'animals' },
      { fact: 'It rains diamonds on Jupiter and Saturn 💎', category: 'space' },
      { fact: 'A bolt of lightning is 5x hotter than the sun\'s surface ☀️', category: 'science' },
      { fact: 'Sloths can hold their breath for 40 minutes underwater 🦥', category: 'animals' },
      { fact: 'A blue whale\'s heart is the size of a small car 🐋', category: 'animals' },
      { fact: 'There are 1,500 active volcanoes on Earth 🌋', category: 'nature' },
      { fact: 'Your fingernails grow 3x faster than toenails 💅', category: 'body' },
      { fact: 'The Great Wall of China is NOT visible from space 🧱', category: 'myths' }
    ];
    
    const fact = facts[Math.floor(Math.random() * facts.length)];
    const templates = [
      '🤯 Fun Fact: ' + fact.fact + '\n\n{Did|Have} you {know|known} this? {Comment|Let me know} below! 👇',
      '💡 {Random|Cool|Wild} Fact: ' + fact.fact + '\n\n{Learn|Know} something new {every|each} day! 🔔',
      '🎯 Fact of the {day|moment}: ' + fact.fact + '\n\n{Share|Drop} this with {someone|a friend} who {needs|would love} to {know|hear} this!'
    ];
    
    const template = templates[Math.floor(Math.random() * templates.length)];
    return {
      text: this.resolveSpintax(template),
      type: 'funFact',
      subject: fact.category,
      template: 'funFact'
    };
  }
  
  _generateMotivationalPost() {
    const quotes = [
      { quote: 'The only way to do great work is to love what you do.', author: 'Steve Jobs' },
      { quote: 'Success is not final, failure is not fatal: it is the courage to continue that counts.', author: 'Winston Churchill' },
      { quote: 'Believe you can and you\'re halfway there.', author: 'Theodore Roosevelt' },
      { quote: 'The future belongs to those who believe in the beauty of their dreams.', author: 'Eleanor Roosevelt' },
      { quote: 'It is during our darkest moments that we must focus to see the light.', author: 'Aristotle' },
      { quote: 'The best time to plant a tree was 20 years ago. The second best time is now.', author: 'Chinese Proverb' },
      { quote: 'Your limitation—it\'s only your imagination.', author: 'Unknown' },
      { quote: 'Push yourself, because no one else is going to do it for you.', author: 'Unknown' },
      { quote: 'Great things never come from comfort zones.', author: 'Unknown' },
      { quote: 'Dream it. Wish it. Do it.', author: 'Unknown' },
      { quote: 'Don\'t stop when you\'re tired. Stop when you\'re done.', author: 'Unknown' },
      { quote: 'Wake up with determination. Go to bed with satisfaction.', author: 'Unknown' },
      { quote: 'Do something today that your future self will thank you for.', author: 'Sean Patrick Flanery' },
      { quote: 'Little things make big days.', author: 'Unknown' },
      { quote: 'It\'s going to be hard, but hard does not mean impossible.', author: 'Unknown' },
      { quote: 'The harder you work for something, the greater you\'ll feel when you achieve it.', author: 'Unknown' },
      { quote: 'Don\'t wait for opportunity. Create it.', author: 'Unknown' },
      { quote: 'Discipline is choosing between what you want now and what you want most.', author: 'Abraham Lincoln' }
    ];
    
    const quote = quotes[Math.floor(Math.random() * quotes.length)];
    const templates = [
      '💪 "' + quote.quote + '"\n— ' + quote.author + '\n\n{Stay|Keep} {motivated|pushing}! {Share|Drop} this with {someone|anyone} who {needs|could use} it! 🔥',
      '✨ {Daily|Monday|Weekend} {Motivation|Inspiration}:\n\n"' + quote.quote + '"\n— ' + quote.author + '\n\n{You|We} {got|have got} this! 💯',
      '🔥 "' + quote.quote + '"\n— ' + quote.author + '\n\n{Let this|May this} {sink in|resonate} today. {Keep|Continue} {going|pushing}! 🚀'
    ];
    
    const template = templates[Math.floor(Math.random() * templates.length)];
    return {
      text: this.resolveSpintax(template),
      type: 'motivational',
      subject: 'motivation',
      template: 'motivational'
    };
  }
  
  /* ── YouTube Shorts content ───────────────────────────────── */
  getYouTubeShortContent() {
    // Mix educational with entertainment/trending shorts
    const roll = Math.random();
    
    if (roll < 0.5) {
      // 50% educational
      const script = this.shortsGenerator.generateScript();
      const fullText = script.script.hook + ' ' + script.script.main + ' ' + script.script.twist + ' ' + script.script.cta;
      return {
        text: fullText,
        title: script.script.hook.substring(0, 100),
        description: script.script.main.substring(0, 5000),
        type: 'educational_short',
        subject: script.subject,
        level: script.level,
        template: script.template,
        videoSpec: script.videoSpec,
        audioSpec: script.audioSpec,
        script: script
      };
    } else {
      // 50% fun/fact shorts
      const funFact = this._generateFunFactPost();
      return {
        text: funFact.text,
        title: funFact.text.substring(0, 100),
        description: funFact.text.substring(0, 5000),
        type: 'fun_fact_short',
        subject: funFact.subject,
        template: 'funFact',
        videoSpec: { format: 'vertical', resolution: '1080x1920', duration: 30, maxDuration: 60, fps: 24 },
        audioSpec: { ttsEngine: 'edge-tts', voice: 'en-US-GuyNeural', backgroundMusic: true, musicVolume: 0.15 }
      };
    }
  }
  
  /* ════════════════════════════════════════════════════════════
   *  TWITTER CONTENT GENERATION
   *  NSFW cross-post from WhatsApp + educational + fun + engagement
   * ════════════════════════════════════════════════════════════ */
  getTwitterTweet() {
    const roll = Math.random();
    let cumulative = 0;
    
    for (const [type, weight] of Object.entries(this.twitterContentMix)) {
      cumulative += weight;
      if (roll < cumulative) {
        // First check NSFW queue
        if (type === 'nsfwCrossPost') {
          const nsfw = this.getTwitterNSFWPost();
          if (nsfw) return nsfw;
          // No NSFW available — fall through to next type
          continue;
        }
        
        return this._getUniqueContent(
          () => this._generateTwitterContent(type),
          'twitter'
        );
      }
    }
    
    // Default
    return this._getUniqueContent(
      () => this._generateTwitterContent('funFacts'),
      'twitter'
    );
  }
  
  _generateTwitterContent(type) {
    switch (type) {
      case 'educational': {
        const script = this.shortsGenerator.generateScript();
        const text = '🧠 ' + script.script.hook + ' ' + script.script.main;
        return { text: text.substring(0, 280), type: 'educational', subject: script.subject, template: 'tweet_educational' };
      }
      case 'engagement': {
        const templates = [
          '{What|How}\'s {everyone|everybody} doing {tonight|today}? {Drop|Leave} a {reply|comment}! 👋',
          '{Random|Quick} question: {What|Which} {skill|thing} are you {learning|working on} {right now|these days}? 💡',
          '{Good|Great} {morning|evening}! {What|How} are you {starting|beginning} your {day|week}? ☀️',
          '{Anyone|Somebody} else {working|grinding} {late|right now}? {You\'re|We\'re} not {alone|the only one}! 💪',
          '{Hot take|Unpopular opinion}: {Monday|Monday morning} is the {best|most productive} day of the week. {Fight me|Change my mind}. 😤'
        ];
        return { text: this.resolveSpintax(templates[Math.floor(Math.random() * templates.length)]), type: 'engagement', template: 'tweet_engagement' };
      }
      case 'funFacts': {
        const fact = this._generateFunFactPost();
        return { text: fact.text.substring(0, 280), type: 'funFact', subject: fact.subject, template: 'tweet_funfact' };
      }
      case 'motivational': {
        const motiv = this._generateMotivationalPost();
        return { text: motiv.text.substring(0, 280), type: 'motivational', template: 'tweet_motivational' };
      }
      default: {
        const fact = this._generateFunFactPost();
        return { text: fact.text.substring(0, 280), type: 'funFact', subject: fact.subject, template: 'tweet_funfact' };
      }
    }
  }
  
  /* ── Twitter reply content (for auto-replying to comments) ── */
  getTwitterReply(commentText) {
    const positive = ['great', 'awesome', 'love', 'amazing', 'cool', 'nice', 'good', 'best', 'fire', '🔥', '💯', '👏'];
    const negative = ['bad', 'hate', 'terrible', 'worst', 'wack', 'trash', 'boring'];
    const question = ['?', 'how', 'what', 'why', 'when', 'where', 'who'];
    
    const lower = (commentText || '').toLowerCase();
    
    if (question.some(q => lower.includes(q))) {
      const replies = [
        'Great question! 🤔 Let me think about that...',
        'That\'s what I want to know too! 💯',
        'Good question! Drop a follow for more content like this 🔥',
        'Hmm, interesting question! What do YOU think? 🧠'
      ];
      return replies[Math.floor(Math.random() * replies.length)];
    }
    
    if (positive.some(p => lower.includes(p))) {
      const replies = [
        'Appreciate that! 🔥💪',
        'Thanks! More content coming! 🚀',
        'Glad you enjoyed it! Follow for more 💯',
        'That means a lot! Stay tuned 👀'
      ];
      return replies[Math.floor(Math.random() * replies.length)];
    }
    
    if (negative.some(n => lower.includes(n))) {
      // Don't engage with negativity — neutral reply
      const replies = [
        'Everyone\'s entitled to their opinion 🤷',
        'Fair point! Different strokes for different folks 💯',
        'Noted! Always looking to improve 📈'
      ];
      return replies[Math.floor(Math.random() * replies.length)];
    }
    
    // Default
    const replies = [
      'Thanks for engaging! 💯',
      'Appreciate the interaction! 🔥',
      '👀 Stay tuned for more!',
      'Real talk! Keep it coming 💪',
      'Noted! Follow for more content 🚀'
    ];
    return replies[Math.floor(Math.random() * replies.length)];
  }
  
  /* ════════════════════════════════════════════════════════════
   *  FACEBOOK CONTENT GENERATION
   *  Adapted from YouTube at HALF frequency
   *  Never post YouTube links — post natively
   * ════════════════════════════════════════════════════════════ */
  getFacebookPost() {
    return this._getUniqueContent(
      () => this._generateFacebookContent(),
      'facebook'
    );
  }
  
  _generateFacebookContent() {
    const types = ['educational', 'funFacts', 'community', 'motivational'];
    const type = types[Math.floor(Math.random() * types.length)];
    
    let content;
    switch (type) {
      case 'educational': {
        const edu = this._generateEducationalPost();
        // Adapt for Facebook: add FB-style formatting
        content = {
          text: '📘 ' + edu.text + '\n\n💬 What do you think? Drop a comment!',
          type: 'educational',
          subject: edu.subject,
          template: 'fb_educational'
        };
        break;
      }
      case 'funFacts': {
        const fact = this._generateFunFactPost();
        content = {
          text: fact.text + '\n\n💬 Share this with someone who needs to know!',
          type: 'funFact',
          subject: fact.subject,
          template: 'fb_funfact'
        };
        break;
      }
      case 'community': {
        const comm = this._generateCommunityEngagementPost();
        content = {
          text: comm.text,
          type: 'community',
          subject: 'engagement',
          template: 'fb_community'
        };
        break;
      }
      case 'motivational': {
        const motiv = this._generateMotivationalPost();
        content = {
          text: motiv.text,
          type: 'motivational',
          subject: 'motivation',
          template: 'fb_motivational'
        };
        break;
      }
    }
    
    return content;
  }
  
  /* ── Adapt YouTube content for Facebook (cross-post) ─────── */
  adaptYouTubeForFacebook(ytContent) {
    // NEVER include YouTube links — Facebook penalizes external reach
    const fbTones = [
      'Check this out! 👀',
      'Thoughts on this? 💭',
      'You need to see this! 🔥',
      'What do you guys think? 🤔',
      'Drop your thoughts below! 👇',
      'Who can relate? 😅',
      'Real talk though... 💯'
    ];
    const tone = fbTones[Math.floor(Math.random() * fbTones.length)];
    
    let fbText = tone + '\n\n';
    fbText += ytContent.text.substring(0, 300); // FB = shorter attention
    fbText += '\n\n💬 Comment your thoughts!';
    
    return {
      text: fbText,
      type: 'yt_crosspost',
      source: 'youtube',
      template: 'fb_yt_crosspost'
    };
  }
  
  /* ════════════════════════════════════════════════════════════
   *  CONTENT CALENDAR — Year-round schedule
   * ════════════════════════════════════════════════════════════ */
  generateCalendar(days = 365) {
    const calendar = {
      youtube: [],
      facebook: [],
      twitter: []
    };
    
    const startDate = new Date();
    
    for (let d = 0; d < days; d++) {
      const date = new Date(startDate);
      date.setDate(date.getDate() + d);
      const dayOfWeek = date.getDay();
      
      // Skip rest days for Facebook (Sun + Wed)
      const fbRestDay = dayOfWeek === 0 || dayOfWeek === 3;
      
      // ── YouTube: 3 uploads, 1-2 community, 2 shorts per day ──
      // Community post (morning)
      calendar.youtube.push({
        date: date.toISOString().split('T')[0],
        time: '09:00',
        type: 'community',
        content: this.getYouTubeCommunityPost(),
        platform: 'youtube'
      });
      
      // Community post (evening — 50% chance)
      if (Math.random() > 0.5) {
        calendar.youtube.push({
          date: date.toISOString().split('T')[0],
          time: '19:00',
          type: 'community',
          content: this.getYouTubeCommunityPost(),
          platform: 'youtube'
        });
      }
      
      // Short (afternoon)
      calendar.youtube.push({
        date: date.toISOString().split('T')[0],
        time: '14:00',
        type: 'short',
        content: this.getYouTubeShortContent(),
        platform: 'youtube'
      });
      
      // Short (evening)
      calendar.youtube.push({
        date: date.toISOString().split('T')[0],
        time: '21:00',
        type: 'short',
        content: this.getYouTubeShortContent(),
        platform: 'youtube'
      });
      
      // ── Facebook: HALF of YouTube (2 timeline, 1 group per day) ──
      if (!fbRestDay) {
        // Morning post
        calendar.facebook.push({
          date: date.toISOString().split('T')[0],
          time: '10:00',
          type: 'timeline',
          content: this.getFacebookPost(),
          platform: 'facebook'
        });
        
        // Afternoon post (50% chance — half of YouTube)
        if (Math.random() > 0.5) {
          calendar.facebook.push({
            date: date.toISOString().split('T')[0],
            time: '16:00',
            type: 'timeline',
            content: this.getFacebookPost(),
            platform: 'facebook'
          });
        }
      }
      
      // ── Twitter: 5-10 tweets per day ──
      const tweetsPerDay = 5 + Math.floor(Math.random() * 6);
      for (let t = 0; t < tweetsPerDay; t++) {
        const hour = 7 + Math.floor((t / tweetsPerDay) * 16); // 7 AM - 11 PM spread
        calendar.twitter.push({
          date: date.toISOString().split('T')[0],
          time: hour.toString().padStart(2, '0') + ':' + (Math.floor(Math.random() * 60)).toString().padStart(2, '0'),
          type: 'tweet',
          content: this.getTwitterTweet(),
          platform: 'twitter'
        });
      }
    }
    
    return calendar;
  }
  
  /* ── Save calendar to disk ────────────────────────────────── */
  saveCalendar(filePath, days = 365) {
    const calendar = this.generateCalendar(days);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(calendar, null, 2));
    this.log('info', 'content', 'Calendar saved: ' + filePath + ' (' + calendar.youtube.length + ' YT, ' + calendar.facebook.length + ' FB, ' + calendar.twitter.length + ' TW)');
    return calendar;
  }
  
  /* ── Get next content for a platform (on-demand) ──────────── */
  getNextContent(platform, type = null) {
    switch (platform) {
      case 'youtube':
        if (type === 'short') return this.getYouTubeShortContent();
        if (type === 'community') return this.getYouTubeCommunityPost();
        return this.getYouTubeCommunityPost();
      
      case 'facebook':
        return this.getFacebookPost();
      
      case 'twitter':
        if (type === 'nsfw') return this.getTwitterNSFWPost();
        return this.getTwitterTweet();
      
      default:
        return { text: '', type: 'unknown' };
    }
  }
  
  /* ── Stats ────────────────────────────────────────────────── */
  getStats() {
    const shortsStats = this.shortsGenerator.getStats();
    return {
      shorts: shortsStats,
      postedContent: {
        youtube: this.postedContent.youtube.length,
        facebook: this.postedContent.facebook.length,
        twitter: this.postedContent.twitter.length,
        tiktok: this.postedContent.tiktok.length
      },
      nsfwQueue: this.nsfwQueue.length,
      nsfwPending: this.nsfwQueue.filter(q => !q.posted).length,
      youtubeMix: this.youtubeContentMix,
      twitterMix: this.twitterContentMix
    };
  }
}

module.exports = ContentPipeline;
