/* ═══════════════════════════════════════════════════════════════════════
 *  v90 MULTILINGUAL COMMANDS — the boss: "if every command is in English
 *  how will users who don't use a QWERTY keyboard download or communicate?"
 *
 *  · LOCAL VERBS — members command the bot in their OWN language:
 *    fa عکس/فیلم/آهنگ · ar صورة/فيلم/اغنية · hi तस्वीर/गाना ·
 *    sn mufananidzo · nd isithombe · zu isithombe · sw picha/wimbo ·
 *    es foto/música · fr photo/musique · pt foto/música · ru фото/музыка ·
 *    tr fotoğraf/şarkı
 *  · NO '!' NEEDED — a bare "عکس جنیفر" downloads a picture
 *  · NON-QWERTY RECOVERY — a Persian/Arabic/Russian keyboard left ON
 *    turns Latin keystrokes into garble ("sd;vhj"). The layout tables
 *    below re-map the garble to native letters, and the verb still fires.
 *  · English still wins when both match (existing behavior untouched).
 * ═══════════════════════════════════════════════════════════════════════ */
'use strict';

/* verb → intent type. Order matters: check media words before generic. */
const VERBS = {
  /* picture */
  'عکس': 'image', 'عكس': 'image', 'صورة': 'image', 'صور': 'image', 'تصویر': 'image',
  'तस्वीर': 'image', 'फोटो': 'image', 'चित्र': 'image',
  'mufananidzo': 'image', 'mifananidzo': 'image',          /* shona */
  'isithombe': 'image', 'izithombe': 'image',              /* ndebele/zulu */
  'picha': 'image',                                        /* swahili */
  'foto': 'image', 'fotos': 'image', 'fotografía': 'image', 'photo': 'image',
  'фото': 'image', 'fotograf': 'image', 'fotoğraf': 'image',
  /* music */
  'آهنگ': 'music', 'موزیک': 'music', 'موسيقى': 'music', 'اغنية': 'music', 'أغنية': 'music', 'موسيقى': 'music',
  'गाना': 'music', 'संगीत': 'music', 'गीत': 'music',
  'rwiyo': 'music',                                        /* shona: song */
  'ingoma': 'music',                                       /* ndebele/zulu */
  'wimbo': 'music',                                        /* swahili */
  'música': 'music', 'musica': 'music', 'canción': 'music', 'chanson': 'music',
  'музыка': 'music', 'песня': 'music', 'şarkı': 'music', 'müzik': 'music',
  /* video */
  'فیلم': 'video', 'ویدیو': 'video', 'vidéo': 'video', 'видео': 'video',
  'فيلم': 'video', 'افلام': 'video', 'فيديو': 'video',
  'वीडियो': 'video', 'filamu': 'video',                    /* swahili */
  'ividiyo': 'video',                                      /* ndebele/zulu */
  'videó': 'video', 'video': 'video', 'vidéo': 'video',
  /* gif */
  'گیف': 'gif', 'جيف': 'gif', 'متحرك': 'gif',
  'गिफ': 'gif', 'gif': 'gif', 'гиф': 'gif',
  /* explicit download request → treat as pic (media default) */
  'دانلود': 'download', 'دونلود': 'download', 'تحميل': 'download', 'حمّل': 'download',
  'डाउनलोड': 'download', 'descargar': 'download', 'télécharger': 'download',
  'скачать': 'download', 'indir': 'download', 'pakua': 'download',       /* swahili */
};

/* keyboard layouts: what each Latin key types when the native layout is ON
 * (lowercase letter/number rows). Used to recover garbled commands. */
const LAYOUTS = {
  fa: { q:'ض', w:'ص', e:'ث', r:'ق', t:'ف', y:'غ', u:'ع', i:'ه', o:'خ', p:'ح',
        a:'ش', s:'س', d:'ی', f:'ب', g:'ل', h:'ا', j:'ت', k:'ن', l:'م',
        z:'ظ', x:'ط', c:'ز', v:'ر', b:'ذ', n:'د', m:'پ' },
  ar: { q:'ض', w:'ص', e:'ث', r:'ق', t:'ف', y:'غ', u:'ع', i:'ه', o:'خ', p:'ح',
        a:'ش', s:'س', d:'ي', f:'ب', g:'ل', h:'ا', j:'ت', k:'ن', l:'م',
        z:'ئ', x:'ء', c:'ز', v:'ر', b:'لا', n:'ى', m:'ة' },
  ru: { q:'й', w:'ц', e:'у', r:'к', t:'е', y:'н', u:'г', i:'ш', o:'щ', p:'з',
        a:'ф', s:'ы', d:'в', f:'а', g:'п', h:'р', j:'о', k:'л', l:'д',
        z:'я', x:'ч', c:'с', v:'м', b:'и', n:'т', m:'ь' }
};

function normalizeLayout(text, lang){
  const t = LAYOUTS[lang];
  if (!t) return null;
  let out = '';
  let hits = 0;
  for (const ch of text.toLowerCase()){
    if (t[ch]){ out += t[ch]; hits++; }
    else out += ch;
  }
  /* at least 3 mapped keys → this really was garble from that layout */
  return hits >= 3 ? { text: out, hits } : null;
}

/* find the FIRST verb occurrence in text order — but a media verb always
 * beats the generic 'download' verb ('دانلود فیلم' = video, not download) */
function match(text){
  const raw = String(text || '').trim();
  if (!raw) return null;
  const low = raw.toLowerCase().replace(/[!؟?.,،]+/g, ' ').replace(/\s+/g, ' ').trim();
  const isLetter = c => /[\p{L}]/u.test(c);
  const words = Object.keys(VERBS).sort((a, b) => b.length - a.length);
  let downloadHit = null;
  for (const w of words){
    const i = low.indexOf(w);
    if (i < 0) continue;
    const before = i === 0 ? ' ' : low[i - 1];
    const after = i + w.length >= low.length ? ' ' : low[i + w.length];
    if (isLetter(before) || isLetter(after)) continue;
    const rest = (low.slice(0, i) + ' ' + low.slice(i + w.length)).replace(/\s+/g, ' ').trim();
    /* \b is ASCII-only — non-Latin verbs strip without it */
    const q = rest.replace(/^(please|pls|plz|send|share|give|show|drop|me|a|some|any|of|by|for|and|mi|me\s)+\b/gi, '').trim()
      .replace(/(دانلود|دونلود|تحميل|حمّل|डाउनलोड|تélécharger|télécharger|скачать)/g, '')
      .replace(/\b(descargar|indir|pakua)\b/g, '')
      .replace(/\s+/g, ' ').trim();
    const hit = { type: VERBS[w], word: w, query: q };
    if (hit.type === 'download'){ if (!downloadHit) downloadHit = hit; continue; }
    return hit;                                     /* a real media verb wins */
  }
  return downloadHit;                               /* only the generic verb */
}

/* public: intent from a message, English verbs NOT included here.
 * tries fa → ar → ru layout recovery when nothing matches directly. */
function localIntent(text){
  const hit = match(text);
  if (hit) return hit;
  for (const lang of ['fa', 'ar', 'ru']){
    const n = normalizeLayout(text, lang);
    if (!n) continue;
    const hit2 = match(n.text);
    if (hit2){
      hit2.layout = lang;          /* recovered from garble */
      return hit2;
    }
  }
  return null;
}

/* map intent type → the defaults detectMediaIntent uses when no query */
const DEFAULTS = { image: 'naija', music: 'top hits', video: 'funny', gif: 'funny', download: null };

module.exports = { localIntent, match, normalizeLayout, VERBS, DEFAULTS };
