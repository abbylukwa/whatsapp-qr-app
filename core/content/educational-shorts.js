'use strict';
/* ══════════════════════════════════════════════════════════════
 *  core/content/educational-shorts.js — Educational Shorts Generator
 *  Generates educational content for YouTube Shorts & Facebook:
 *    - School subjects: English, Math, Science, History, Geography
 *    - Productivity tips, fun facts
 *    - Every level: Elementary, Middle, High School
 *    - NOT: "doing useless other subjects" (user specified)
 *
 *  Content structure (viral format):
 *    [0-2s]  HOOK — "Did you know..." / "You won't believe..."
 *    [2-8s]  SETUP — Brief context
 *    [8-20s] MAIN — Core fact with animation cue
 *    [20-28s] TWIST — Unexpected detail
 *    [28-35s] CALLBACK — Key takeaway
 *    [35-40s] CTA — "Follow for more!"
 *
 *  AI-powered: Can use LLM for script generation
 *  Audio: Edge TTS (free, unlimited) or configured TTS
 *  Video: Blender templates or static image + text animation
 * ══════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');

// ── Curriculum Database ──────────────────────────────────────
const CURRICULUM = {
  English: {
    Elementary: [
      { topic: 'Shakespeare invented 1,700 words', fact: 'Words like "lonely", "generous", and "suspicious" were invented by Shakespeare!', source: 'Oxford English Dictionary' },
      { topic: 'The longest English word', fact: '"Pneumonoultramicroscopicsilicovolcanoconiosis" has 45 letters. It\'s a lung disease caused by volcanic dust.', source: 'Guinness World Records' },
      { topic: 'Why English spelling is weird', fact: 'English spelling was standardized BEFORE pronunciation changed. That\'s why "knight" has a silent k — it used to be pronounced!', source: 'Linguistics History' },
      { topic: '"E" is the most common letter', fact: 'The letter "E" appears in 11% of all English words. "Z" appears in only 0.07%!', source: 'Letter Frequency Analysis' },
      { topic: 'A sentence with every letter', fact: '"The quick brown fox jumps over the lazy dog" contains every letter of the alphabet. It\'s called a pangram!', source: 'Typography' }
    ],
    Middle: [
      { topic: 'Words that don\'t exist in English', fact: 'Schadenfreude (German): pleasure from someone else\'s misfortune. English has no single word for this!', source: 'Linguistic Relativity' },
      { topic: 'The weird origin of "muscle"', fact: '"Muscle" comes from Latin "musculus" meaning "little mouse" — Romans thought biceps looked like mice under skin!', source: 'Etymology' },
      { topic: 'Grammar myths that aren\'t real', fact: 'You CAN end a sentence with a preposition. Churchill said: "This is the sort of nonsense up with which I will not put" — mocking the rule!', source: 'Descriptive Grammar' },
      { topic: 'The simplest sentence in English', fact: '"Go." is a complete sentence. Subject: (you) implied. Verb: go. That\'s all you need!', source: 'Grammar Theory' }
    ],
    High: [
      { topic: 'Shakespeare invented "swagger"', fact: 'Yes, "swagger" first appeared in "A Midsummer Night\'s Dream" (1596). Shakespeare also gave us "eyeball", "bloodstained", and "gloomy".', source: 'OED Etymology' },
      { topic: 'Why "colonel" is pronounced "kernel"', fact: 'English borrowed "colonel" from French (which spelled it "coronel") then re-spelled it from Italian "colonnello" but kept the French pronunciation!', source: 'Language History' },
      { topic: 'Ambiguity in English', fact: '"Time flies like an arrow" has 4 valid grammatical interpretations. English is one of the most ambiguous natural languages.', source: 'Computational Linguistics' }
    ]
  },
  Math: {
    Elementary: [
      { topic: 'Why 0.999... = 1', fact: '0.999 repeating is EXACTLY equal to 1. Not approximately — exactly! 1/3 = 0.333..., so 3 × 1/3 = 0.999... = 1', source: 'Real Analysis' },
      { topic: '111,111,111 × 111,111,111', fact: 'The answer is 12,345,678,987,654,321 — a perfect palindrome! Try it yourself!', source: 'Number Theory' },
      { topic: 'The sum of all numbers 1-100', fact: 'Gauss figured this out at age 7: 5,050. The trick? Pair 1+100, 2+99, 3+98... each pair = 101, and there are 50 pairs!', source: 'Gauss Biography' }
    ],
    Middle: [
      { topic: 'The golden ratio in nature', fact: '1.6180339887... appears EVERYWHERE: sunflower spirals, nautilus shells, galaxy arms, hurricanes, and even your finger bones!', source: 'Fibonacci Sequence' },
      { topic: 'Why you can\'t divide by zero', fact: 'Dividing by zero isn\'t "infinity" — it\'s UNDEFINED. If 1/0 = x, then 0 × x = 1. But 0 × anything = 0, never 1. Contradiction!', source: 'Field Axioms' },
      { topic: 'Pi has no pattern', fact: 'Pi\'s digits never repeat and never follow a pattern. It\'s been calculated to 100 TRILLION digits and still no pattern found.', source: 'Computational Mathematics' }
    ],
    High: [
      { topic: 'Euler\'s identity is the "most beautiful"', fact: 'e^(iπ) + 1 = 0 connects five fundamental constants: e, i, π, 1, and 0. Mathematicians call it the most beautiful equation.', source: 'Complex Analysis' },
      { topic: 'The Collatz Conjecture', fact: 'Pick any number. If even, divide by 2. If odd, multiply by 3 and add 1. Repeat. It ALWAYS reaches 1... but nobody can prove why!', source: 'Unsolved Problems' },
      { topic: 'Infinity has different sizes', fact: 'There are MORE real numbers between 0 and 1 than there are positive integers — both are infinite, but one is "bigger"!', source: 'Cantor\'s Diagonal Argument' }
    ]
  },
  Science: {
    Elementary: [
      { topic: 'Why ice floats', fact: 'Most substances are denser when solid. But water EXPANDS when freezing, making ice 9% less dense than liquid water. Without this, lakes would freeze from the bottom up!', source: 'Hydrogen Bonding' },
      { topic: 'Your body has 37.2 trillion cells', fact: 'And 30 trillion of them are bacteria! You\'re more bacteria than human by cell count. (But by weight, you\'re mostly human!)', source: 'Microbiome Research' },
      { topic: 'Sound travels 4.3x faster in water', fact: 'Sound moves at 343 m/s in air but 1,480 m/s in water. That\'s why whales can communicate across entire oceans!', source: 'Acoustics' }
    ],
    Middle: [
      { topic: 'How photosynthesis works', fact: 'Plants split water molecules using sunlight, releasing oxygen as a "waste" product. Every oxygen atom you breathe came from a plant splitting H₂O!', source: 'Biochemistry' },
      { topic: 'Why honey never spoils', fact: 'Honey\'s low water content (17%) and acidic pH (3.9) make bacteria unable to survive. 3,000-year-old honey found in Egyptian tombs is still edible!', source: 'Food Science' },
      { topic: 'Tardigrades are indestructible', fact: 'These microscopic animals survive: -272°C, +150°C, 6× ocean pressure, radiation 1000× lethal human dose, and the vacuum of space!', source: 'Extremophile Biology' }
    ],
    High: [
      { topic: 'Schrödinger\'s cat explained', fact: 'A cat in a box is simultaneously alive AND dead until observed. This isn\'t a paradox — it demonstrates that quantum objects exist in superposition of states.', source: 'Quantum Mechanics' },
      { topic: 'Your DNA stretched out', fact: 'If you uncoiled all DNA in one cell, it would be ~2 meters long. All DNA in your body stretched out would reach the sun and back 600 times!', source: 'Genomics' },
      { topic: 'Neutron stars are absurd', fact: 'A sugar-cube-sized piece of neutron star weighs 6 BILLION tons. They spin up to 716 times per second and have magnetic fields 10¹⁵× Earth\'s.', source: 'Astrophysics' }
    ]
  },
  History: {
    Elementary: [
      { topic: 'The shortest war ever', fact: 'The Anglo-Zanzibar War of 1896 lasted just 38 MINUTES. The British Empire vs a small island nation. It\'s in the Guinness Book of Records!', source: 'Military History' },
      { topic: 'Cleopatra lived closer to iPhone', fact: 'Cleopatra lived 69-30 BC. The Great Pyramid was built ~2560 BC. The iPhone was released 2007 AD. Cleopatra is closer to the iPhone by 500 years!', source: 'Timeline Analysis' },
      { topic: 'Oxford is older than the Aztecs', fact: 'Oxford University started teaching in 1096. The Aztec Empire was founded in 1325. Oxford is 229 years older!', source: 'Historical Chronology' }
    ],
    Middle: [
      { topic: 'The Great Emu War', fact: 'In 1932, Australia sent soldiers with machine guns to fight 20,000 emus destroying crops. The emus won. The military retreated after 1,000 rounds killed only ~50 emus.', source: 'Australian History' },
      { topic: 'A Roman emperor was a camel', fact: 'Roman Emperor Caligula allegedly planned to make his horse Incitatus a consul. He also declared war on Neptune (the sea god) and made his soldiers collect seashells as "spoils".', source: 'Suetonius' },
      { topic: 'The first programmer was a woman', fact: 'Ada Lovelace (1815-1852) wrote the first computer algorithm for Charles Babbage\'s Analytical Engine — a machine that wasn\'t even built yet!', source: 'Computer History' }
    ],
    High: [
      { topic: 'The Cold War almost ended everything', fact: 'In 1983, Soviet officer Stanislav Petrov detected 5 incoming US nukes. He decided it was a false alarm and didn\'t retaliate. He saved the world. The system was indeed malfunctioning.', source: 'Nuclear History' },
      { topic: 'Ancient Egyptians had pregnancy tests', fact: 'A woman\'s urine on barley and emmer wheat: if both sprout, she\'s pregnant. Modern science confirmed this works ~70% accuracy due to pregnancy hormones promoting seed growth.', source: 'Egyptian Medical Papyri' }
    ]
  },
  Productivity: {
    General: [
      { topic: 'The Pomodoro Technique', fact: 'Work 25 minutes, rest 5. After 4 cycles, take a 15-30 min break. Created by Francesco Cirillo in 1987 using a tomato-shaped timer (pomodoro = tomato in Italian)!', source: 'Time Management' },
      { topic: 'The 2-minute rule', fact: 'If something takes less than 2 minutes, do it NOW. This simple rule from David Allen\'s "Getting Things Done" prevents small tasks from piling up into mental clutter.', source: 'GTD Methodology' },
      { topic: 'Sleep > studying', fact: 'Sleeping after learning consolidates memories 40% better than staying awake. Your brain replays and strengthens neural connections during deep sleep.', source: 'Neuroscience' },
      { topic: 'The Zeigarnik Effect', fact: 'Your brain remembers unfinished tasks better than completed ones. That\'s why "to-do" lists work — writing a task down gives your brain "closure" so it stops obsessing!', source: 'Cognitive Psychology' },
      { topic: 'Why breaks boost creativity', fact: 'Stepping away from a problem activates your brain\'s "Default Mode Network" — this background processing often produces "aha!" moments. Archimedes had his in the bathtub!', source: 'Creativity Research' }
    ]
  }
};

// ── Content Templates ────────────────────────────────────────
const TEMPLATES = {
  didYouKnow: {
    name: 'Did You Know',
    generate: (item) => ({
      hook: `Did you know that ${item.topic.toLowerCase()}?`,
      setup: 'Here\'s something that will blow your mind...',
      main: item.fact,
      twist: `And the craziest part? This is verified by ${item.source}.`,
      cta: 'Follow for more amazing facts!',
      totalWords: item.fact.split(' ').length + 15,
      estimatedDuration: Math.ceil((item.fact.split(' ').length + 15) / 2.5)
    })
  },
  mythVsReality: {
    name: 'Myth vs Reality',
    generate: (item) => ({
      hook: `Most people get this wrong about ${item.topic.toLowerCase()}...`,
      setup: 'Let me set the record straight.',
      main: item.fact,
      twist: `Source: ${item.source}. Yet textbooks still get this wrong!`,
      cta: 'Share if you learned something new!',
      totalWords: item.fact.split(' ').length + 18,
      estimatedDuration: Math.ceil((item.fact.split(' ').length + 18) / 2.5)
    })
  },
  in60Seconds: {
    name: 'X in 60 Seconds',
    generate: (item) => ({
      hook: `${item.topic} in 60 seconds. Go!`,
      setup: 'Timer starts now...',
      main: item.fact,
      twist: `Verified by ${item.source}.`,
      cta: 'Follow for more!',
      totalWords: item.fact.split(' ').length + 10,
      estimatedDuration: Math.ceil((item.fact.split(' ').length + 10) / 2.5)
    })
  },
  riddle: {
    name: 'Riddle Format',
    generate: (item) => ({
      hook: `Can you guess? What about ${item.topic.toLowerCase()}?`,
      setup: 'Think about it for a second...',
      main: `The answer might surprise you: ${item.fact}`,
      twist: `Source: ${item.source}.`,
      cta: 'Comment your guess before watching again!',
      totalWords: item.fact.split(' ').length + 20,
      estimatedDuration: Math.ceil((item.fact.split(' ').length + 20) / 2.5)
    })
  }
};

// ── Content Calendar Generator ───────────────────────────────
class EducationalShortsGenerator {
  constructor(options = {}) {
    this.log = options.log || console.log;
    this.dataDir = options.dataDir || './data/content';
    this.ttsEngine = options.ttsEngine || 'edge-tts'; // edge-tts (free), elevenlabs, azure, google
    this.videoEngine = options.videoEngine || 'blender-eevee'; // blender-eevee, blender-cycles, static-image
    this.usedTopics = new Set();
    this.calendar = [];
  }

  /* ── Get all available topics ─────────────────────────────── */
  getAllTopics(subject = null, level = null) {
    const topics = [];
    const subjects = subject ? { [subject]: CURRICULUM[subject] } : CURRICULUM;

    for (const [subj, levels] of Object.entries(subjects)) {
      for (const [lvl, items] of Object.entries(levels)) {
        if (level && lvl !== level) continue;
        for (const item of items) {
          topics.push({ subject: subj, level: lvl, ...item });
        }
      }
    }
    return topics;
  }

  /* ── Get random topic (not recently used) ─────────────────── */
  getRandomTopic(subject = null, level = null) {
    const allTopics = this.getAllTopics(subject, level);
    const unused = allTopics.filter(t => !this.usedTopics.has(t.topic));

    if (unused.length === 0) {
      // All used — reset
      this.usedTopics.clear();
      return this.getRandomTopic(subject, level);
    }

    const chosen = unused[Math.floor(Math.random() * unused.length)];
    this.usedTopics.add(chosen.topic);
    return chosen;
  }

  /* ── Generate a single short script ───────────────────────── */
  generateScript(options = {}) {
    const {
      subject = null,
      level = null,
      template = null
    } = options;

    const topic = this.getRandomTopic(subject, level);
    const templateNames = Object.keys(TEMPLATES);
    const chosenTemplate = template && TEMPLATES[template]
      ? TEMPLATES[template]
      : TEMPLATES[templateNames[Math.floor(Math.random() * templateNames.length)]];

    const script = chosenTemplate.generate(topic);

    return {
      id: `short-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      topic: topic.topic,
      subject: topic.subject,
      level: topic.level,
      source: topic.source,
      template: chosenTemplate.name,
      script,
      videoSpec: {
        format: 'vertical', // 9:16 for Shorts
        resolution: '1080x1920',
        duration: Math.max(script.estimatedDuration, 15),
        maxDuration: 60,
        fps: 24
      },
      audioSpec: {
        ttsEngine: this.ttsEngine,
        voice: 'en-US-GuyNeural',
        backgroundMusic: true,
        musicVolume: 0.15
      },
      createdAt: Date.now(),
      status: 'scripted' // scripted → rendered → audio_added → verified → published
    };
  }

  /* ── Generate a content calendar (year-round) ─────────────── */
  generateCalendar(options = {}) {
    const {
      days = 365,
      shortsPerDay = 2,
      subjects = ['English', 'Math', 'Science', 'History', 'Productivity'],
      levels = ['Elementary', 'Middle', 'High'],
      startDate = new Date()
    } = options;

    const calendar = [];
    let dayCount = 0;

    for (let d = 0; d < days; d++) {
      const date = new Date(startDate);
      date.setDate(date.getDate() + d);
      const dayOfWeek = date.getDay();

      // Skip rest days (Sunday=0, Wednesday=3) for Facebook
      const isRestDay = dayOfWeek === 0 || dayOfWeek === 3;
      // No midnight-6AM posts (schedule during day only)
      const postingHour = 8 + Math.floor(Math.random() * 12); // 8 AM - 8 PM

      for (let s = 0; s < shortsPerDay; s++) {
        const subject = subjects[d % subjects.length];
        const level = levels[(d + s) % levels.length];

        // Productivity has no levels
        const actualLevel = subject === 'Productivity' ? 'General' : level;
        const script = this.generateScript({ subject, level: actualLevel });

        // Schedule with jitter (±30 min)
        const jitter = Math.floor((Math.random() - 0.5) * 60);
        const scheduledTime = new Date(date);
        scheduledTime.setHours(postingHour + s * 4, jitter, 0, 0); // 4h apart

        calendar.push({
          day: d + 1,
          date: date.toISOString().split('T')[0],
          shortIndex: s + 1,
          scheduledTime: scheduledTime.toISOString(),
          isRestDay,
          content: script
        });
      }

      dayCount++;
    }

    this.calendar = calendar;
    return calendar;
  }

  /* ── Get stats about available content ────────────────────── */
  getStats() {
    const topics = this.getAllTopics();
    const bySubject = {};
    for (const t of topics) {
      bySubject[t.subject] = (bySubject[t.subject] || 0) + 1;
    }
    return {
      totalTopics: topics.length,
      bySubject,
      usedTopics: this.usedTopics.size,
      calendarSize: this.calendar.length,
      templates: Object.keys(TEMPLATES)
    };
  }

  /* ── Save calendar to file ────────────────────────────────── */
  saveCalendar(filePath) {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(this.calendar, null, 2));
      this.log('info', 'content', `Calendar saved: ${this.calendar.length} shorts to ${filePath}`);
    } catch (e) {
      this.log('error', 'content', `Calendar save failed: ${e.message}`);
    }
  }

  /* ── Load calendar from file ──────────────────────────────── */
  loadCalendar(filePath) {
    try {
      if (fs.existsSync(filePath)) {
        this.calendar = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        this.log('info', 'content', `Calendar loaded: ${this.calendar.length} shorts`);
        return this.calendar;
      }
    } catch (e) {
      this.log('error', 'content', `Calendar load failed: ${e.message}`);
    }
    return [];
  }
}

module.exports = { EducationalShortsGenerator, CURRICULUM, TEMPLATES };
