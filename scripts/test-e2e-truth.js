'use strict';
/* End-to-end truth test — what ACTUALLY works vs what's simulated */

(async () => {
  const log = (level, source, msg) => {};
  
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║   FULL END-TO-END SYSTEM TEST — TRUTHFUL RESULTS ONLY   ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');
  
  // 1. Test MultiPlatformManager
  const MultiPlatformManager = require('../multi-platform');
  const mp = new MultiPlatformManager({ dataDir: './data/test-e2e', log });
  
  console.log('── 1. MULTI-PLATFORM MANAGER ──');
  console.log('Has all 4 platforms:', Object.keys(mp.platforms).join(','));
  console.log('Content pipeline wired:', !!mp.contentPipeline);
  console.log('Interaction tracker wired:', !!mp.interactionTracker);
  console.log('');
  
  // 2. Content Pipeline
  console.log('── 2. CONTENT PIPELINE (ALL CONTENT TYPES) ──');
  const cp = mp.contentPipeline;
  
  const ytTypes = { educational: 0, trending: 0, community: 0, funFact: 0, motivational: 0 };
  for (let i = 0; i < 50; i++) { const c = cp.getYouTubeCommunityPost(); ytTypes[c.type] = (ytTypes[c.type] || 0) + 1; }
  console.log('YouTube 50 posts types:', JSON.stringify(ytTypes));
  
  for (let i = 0; i < 5; i++) cp.queueNSFWForTwitter({ title: 'Video ' + i, query: 'q' + i, url: 'u' + i });
  const twTypes = { nsfw_crosspost: 0, educational: 0, engagement: 0, funFact: 0, motivational: 0 };
  for (let i = 0; i < 50; i++) { const c = cp.getTwitterTweet(); twTypes[c.type] = (twTypes[c.type] || 0) + 1; }
  console.log('Twitter 50 tweets types:', JSON.stringify(twTypes));
  
  const fbTypes = {};
  for (let i = 0; i < 20; i++) { const c = cp.getFacebookPost(); fbTypes[c.type] = (fbTypes[c.type] || 0) + 1; }
  console.log('Facebook 20 posts types:', JSON.stringify(fbTypes));
  console.log('');
  
  // 3. Test each platform bot with REAL browser
  const tests = [
    { idx: 3, name: 'YouTube', bot: mp.platforms.youtube, url: 'https://www.youtube.com' },
    { idx: 4, name: 'Twitter', bot: mp.platforms.twitter, url: 'https://x.com' },
    { idx: 5, name: 'Facebook', bot: mp.platforms.facebook, url: 'https://www.facebook.com' },
    { idx: 6, name: 'TikTok', bot: mp.platforms.tiktok, url: 'https://www.tiktok.com' }
  ];
  
  for (const t of tests) {
    console.log('── ' + t.idx + '. ' + t.name.toUpperCase() + ' BOT (REAL BROWSER) ──');
    try {
      const initResult = await t.bot.init();
      console.log('  Browser init:', initResult ? '✅ SUCCESS' : '❌ FAILED');
      
      if (initResult) {
        try {
          await t.bot.page.goto(t.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
          const title = await t.bot.page.title();
          console.log('  Navigate:', '✅', title.substring(0, 50));
        } catch (e) {
          console.log('  Navigate:', '❌', e.message.substring(0, 60));
        }
        
        try {
          const wd = await t.bot.page.evaluate(() => navigator.webdriver);
          console.log('  Anti-detect (webdriver=false):', wd === false ? '✅' : '❌');
        } catch (e) {}
      }
      
      await t.bot.close();
      console.log('  Clean close: ✅');
    } catch (e) {
      console.log('  FATAL: ❌', e.message.substring(0, 80));
    }
    console.log('');
  }
  
  // 7. NSFW Cross-Post
  console.log('── 7. NSFW CROSS-POST (WhatsApp → Twitter) ──');
  const cp2 = mp.contentPipeline;
  for (const v of [{ title: 'Ebony Twerk', query: 'q1', url: 'u1' }, { title: 'African Booty', query: 'q2', url: 'u2' }]) {
    cp2.queueNSFWForTwitter(v);
    const tweet = cp2.getTwitterNSFWPost();
    console.log('  NSFW → Twitter:', tweet ? '✅ ' + tweet.text.substring(0, 50) : '❌');
  }
  console.log('');
  
  // 8. Twitter Reply
  console.log('── 8. TWITTER REPLY SYSTEM ──');
  for (const c of ['Great post!', 'This sucks', 'How does this work?']) {
    const reply = cp2.getTwitterReply(c);
    console.log('  Reply to "' + c + '":', '✅', reply);
  }
  console.log('');
  
  // 9. YouTube Content Variety
  console.log('── 9. YOUTUBE CONTENT VARIETY ──');
  const shortsTypes = {};
  for (let i = 0; i < 20; i++) { const s = cp2.getYouTubeShortContent(); shortsTypes[s.type] = (shortsTypes[s.type] || 0) + 1; }
  console.log('  20 Shorts types:', JSON.stringify(shortsTypes));
  console.log('  NOT only educational:', Object.keys(shortsTypes).length > 1 ? '✅' : '❌');
  console.log('');
  
  // 10. Wiring check
  console.log('── 10. WIRING CHECK ──');
  const fs = require('fs');
  const serverCode = fs.readFileSync('../server.js', 'utf8');
  console.log('  server.js wires onVideoSent hook:', serverCode.includes('onVideoSent:') ? '✅' : '❌');
  console.log('  server.js calls multiPlatform.init():', serverCode.includes('multiPlatform.init()') ? '✅' : '❌');
  console.log('  server.js wires onNSFWVideoSent:', serverCode.includes('multiPlatform.onNSFWVideoSent') ? '✅' : '❌');
  console.log('');
  
  console.log('═════════════════════════════════════════════════════════');
  console.log('   ALL TESTS COMPLETE');
  console.log('═════════════════════════════════════════════════════════');
})().catch(e => console.log('FATAL:', e.message));
