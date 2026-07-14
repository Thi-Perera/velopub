/**
 * post-utils.js
 * Logica condivisa della coda POST carosello: calendario slot, assegnazione,
 * validazione meta.json, normalizzazione immagini.
 *
 * Vincoli API Instagram (verificati sui doc Meta, vedi GUIDA in README):
 *   - carosello min 2 max 10 slide (1 sola immagine → post singolo)
 *   - solo JPEG sRGB, max 8 MB, larghezza utile max 1440px
 *   - tutte le slide vengono croppate sull'aspect ratio della PRIMA
 *     → normalizziamo noi: ratio uniforme = prima slide (verticale → 4:5)
 *   - caption max 2200 caratteri, max 30 hashtag
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SCHEDULE_FILE = 'post-schedule.json';
const POST_QUEUE_DIR = 'queue-posts';
const POST_PUBLISHED_DIR = 'published-posts';
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png'];

const MAX_SLIDES = 10;
const MAX_CAPTION = 2200;
const MAX_HASHTAGS = 30;
const MAX_ALT_TEXT = 1000;
const MAX_WIDTH = 1440;
const MAX_BYTES = 8 * 1024 * 1024;
// Due post a meno di 45 minuti l'uno dall'altro = stesso slot (vietato)
const SLOT_PROXIMITY_MS = 45 * 60 * 1000;

// Gli export/editor Windows a volte antepongono un BOM: via prima del parse
function stripBom(s) {
  return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
}
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function loadSchedule() {
  const fallback = { slots: [{ day: 'Mon', time: '17:30' }, { day: 'Wed', time: '17:30' }, { day: 'Sat', time: '17:30' }] };
  try {
    const s = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
    return Array.isArray(s.slots) && s.slots.length > 0 ? s : fallback;
  } catch {
    return fallback;
  }
}

function listImagesIn(dir) {
  return fs.readdirSync(dir)
    .filter((f) => IMAGE_EXTENSIONS.includes(path.extname(f).toLowerCase()))
    .sort();
}

/** Tutti i post in coda, ordinati per data di pubblicazione. */
function listQueuedPosts() {
  if (!fs.existsSync(POST_QUEUE_DIR)) return [];
  return fs.readdirSync(POST_QUEUE_DIR)
    .filter((d) => fs.existsSync(path.join(POST_QUEUE_DIR, d, 'meta.json')))
    .map((d) => {
      const dir = path.join(POST_QUEUE_DIR, d);
      let meta;
      try { meta = JSON.parse(stripBom(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'))); }
      catch { meta = {}; }
      return { dirName: d, dir, meta, images: listImagesIn(dir) };
    })
    .sort((a, b) => new Date(a.meta.publish_at || 0) - new Date(b.meta.publish_at || 0));
}

/** Genera i prossimi slot del calendario (UTC) per `weeks` settimane. */
function upcomingSlots(schedule, now = new Date(), weeks = 8) {
  const out = [];
  const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  for (let d = 0; d < weeks * 7; d++) {
    const day = new Date(base.getTime() + d * 86400000);
    const dayName = DAY_NAMES[day.getUTCDay()];
    for (const slot of schedule.slots) {
      if (slot.day !== dayName) continue;
      const [hh, mm] = String(slot.time).split(':').map(Number);
      out.push(new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hh || 0, mm || 0)));
    }
  }
  return out.sort((a, b) => a - b);
}

/**
 * Assegna lo slot di pubblicazione.
 * - senza `requestedIso`: primo slot libero del calendario;
 * - con `requestedIso` futuro e libero: esattamente quello (anche fuori calendario);
 * - occupato o nel passato: primo slot libero del calendario dopo quella data.
 * `queued` = post già in coda (per il vincolo "mai due post per slot").
 */
function assignSlot(requestedIso, queued, now = new Date()) {
  const occupied = queued
    .map((p) => new Date(p.meta.publish_at || 0).getTime())
    .filter((n) => !isNaN(n) && n > 0);
  const isFree = (t) => occupied.every((o) => Math.abs(o - t) >= SLOT_PROXIMITY_MS);
  const schedule = loadSchedule();

  if (requestedIso) {
    const t = new Date(requestedIso).getTime();
    if (isNaN(t)) return { error: `publish_at non valido: "${requestedIso}" (usa ISO, es. 2026-07-20T17:30:00Z)` };
    if (t > now.getTime() && isFree(t)) return { when: new Date(t), exact: true };
    // Orario già passato = "prima possibile": esce alla prossima run oraria
    if (t <= now.getTime() && isFree(now.getTime())) {
      return { when: new Date(now.getTime() + 60000), exact: false, asap: true };
    }
    const from = Math.max(t, now.getTime());
    for (const s of upcomingSlots(schedule, now)) {
      if (s.getTime() > from && isFree(s.getTime())) return { when: s, exact: false };
    }
    return { error: 'Nessuno slot libero nelle prossime 8 settimane.' };
  }

  for (const s of upcomingSlots(schedule, now)) {
    if (s.getTime() > now.getTime() + 30 * 60000 && isFree(s.getTime())) return { when: s, exact: true };
  }
  return { error: 'Nessuno slot libero nelle prossime 8 settimane.' };
}

function countHashtags(text) {
  return (String(text).match(/#[\p{L}\p{N}_]+/gu) || []).length;
}

// Gate anti-placeholder: caption con segnaposto dimenticati non vanno in coda
const PLACEHOLDER_RE = /(\bTODO\b|\bFIXME\b|\bXXX\b|PLACEHOLDER|LOREM\s+IPSUM|\{\{|\[INSERT|<INSERT|INSERISCI\s+QUI|\[\.\.\.\]|\bCAPTION\s+HERE\b)/i;

/** Caption finale = caption + hashtag da tags[] (quelli non già presenti). */
function buildCaption(meta) {
  let caption = String(meta.caption || '').trim();
  const tags = Array.isArray(meta.tags) ? meta.tags : [];
  const extra = tags
    .map((t) => (String(t).startsWith('#') ? String(t) : `#${t}`))
    .filter((t) => !caption.includes(t));
  if (extra.length > 0) caption += `\n\n${extra.join(' ')}`;
  return caption;
}

/** Ritorna la lista di errori (vuota = valido). */
function validatePost(meta, imageCount) {
  const errors = [];
  const caption = buildCaption(meta);

  if (!caption) errors.push('manca la caption (meta.json → "caption", o caption.txt)');
  if (caption.length > MAX_CAPTION) errors.push(`caption troppo lunga: ${caption.length}/${MAX_CAPTION} caratteri`);
  if (countHashtags(caption) > MAX_HASHTAGS) errors.push(`troppi hashtag: ${countHashtags(caption)}/${MAX_HASHTAGS}`);
  if (PLACEHOLDER_RE.test(caption)) errors.push(`la caption contiene un segnaposto (${caption.match(PLACEHOLDER_RE)[0]}): completala e rimanda`);

  if (imageCount < 1) errors.push('nessuna immagine jpg/png nello zip');
  if (imageCount > MAX_SLIDES) errors.push(`troppe slide: ${imageCount}/${MAX_SLIDES} (i dump più lunghi si pubblicano solo dall'app)`);

  if (meta.alt_text !== undefined) {
    if (!Array.isArray(meta.alt_text)) errors.push('"alt_text" deve essere un array di stringhe (una per slide)');
    else if (meta.alt_text.some((a) => String(a).length > MAX_ALT_TEXT)) errors.push(`alt_text oltre i ${MAX_ALT_TEXT} caratteri`);
  }
  return errors;
}

function dims(imgPath) {
  const out = execSync(`convert "${imgPath}" -auto-orient -format "%w %h" info:`).toString().trim().split(' ').map(Number);
  return { w: out[0], h: out[1] };
}

function ratioLabel(r) {
  if (Math.abs(r - 0.8) < 0.02) return '4:5';
  if (Math.abs(r - 1) < 0.02) return '1:1';
  if (Math.abs(r - 1.91) < 0.03) return '1.91:1';
  return r.toFixed(2);
}

/**
 * Normalizza le immagini in `destDir` come 01.jpg…NN.jpg:
 * ratio uniforme = prima slide (verticale → 4:5, orizzontale max 1.91:1),
 * crop centrale, JPEG sRGB, larghezza max 1440, <8MB.
 */
function normalizeImages(srcPaths, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const first = dims(srcPaths[0]);
  const r1 = first.w / first.h;
  const target = r1 < 1 ? 4 / 5 : Math.min(r1, 1.91);

  srcPaths.forEach((src, i) => {
    const { w, h } = dims(src);
    let cw = w;
    let ch = Math.round(w / target);
    if (ch > h) { ch = h; cw = Math.round(h * target); }
    const out = path.join(destDir, `${String(i + 1).padStart(2, '0')}.jpg`);
    let quality = 90;
    do {
      execSync(
        `convert "${src}" -auto-orient -gravity center -crop ${cw}x${ch}+0+0 +repage ` +
        `-resize "${MAX_WIDTH}x>" -colorspace sRGB -strip -quality ${quality} "${out}"`
      );
      quality -= 12;
    } while (fs.statSync(out).size > MAX_BYTES && quality > 50);
  });

  return { count: srcPaths.length, ratio: ratioLabel(target) };
}

function slugify(name) {
  const s = String(name).toLowerCase().replace(/\.[a-z0-9]+$/, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
  return s || 'post';
}

/** Nome cartella coda: 2026-07-16-1730-slug (data slot + slug). */
function folderName(when, slug) {
  const iso = when.toISOString(); // 2026-07-16T17:30:00.000Z
  return `${iso.slice(0, 10)}-${iso.slice(11, 16).replace(':', '')}-${slug}`;
}

function formatWhen(when) {
  const iso = new Date(when).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

module.exports = {
  SCHEDULE_FILE,
  POST_QUEUE_DIR,
  POST_PUBLISHED_DIR,
  IMAGE_EXTENSIONS,
  MAX_SLIDES,
  loadSchedule,
  listQueuedPosts,
  upcomingSlots,
  assignSlot,
  buildCaption,
  validatePost,
  normalizeImages,
  slugify,
  folderName,
  formatWhen,
  listImagesIn,
};
