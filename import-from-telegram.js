/**
 * import-from-telegram.js
 * Legge i messaggi ricevuti dal bot Telegram (solo dalla chat autorizzata)
 * e riempie le code di pubblicazione. Supporta:
 *   - foto normali (prende la risoluzione più alta)
 *   - immagini inviate come FILE/documento (qualità piena, senza compressione)
 *   - archivi .zip di sole immagini → coda STORIE (queue/)
 *   - archivi .zip con meta.json (o caption.txt) → coda POST carosello
 *     (queue-posts/), normalizzati e programmati su uno slot
 *   - comandi: /status /coda /anteprima /sposta /annulla /help
 * Tiene traccia dell'ultimo update processato in .telegram-offset.
 *
 * Variabili d'ambiente richieste: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { sendMessage, sendPhotoFile } = require('./telegram');
const {
  POST_QUEUE_DIR,
  listQueuedPosts,
  assignSlot,
  buildCaption,
  validatePost,
  normalizeImages,
  slugify,
  folderName,
  formatWhen,
} = require('./post-utils');

// Gli export/editor Windows a volte antepongono un BOM: via prima del parse
function stripBom(s) {
  return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
}
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const QUEUE_DIR = 'queue';
const PUBLISHED_DIR = 'published';
const OFFSET_FILE = '.telegram-offset';
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png'];
const IMAGE_MIMES = ['image/jpeg', 'image/png'];

if (!BOT_TOKEN || !CHAT_ID) {
  console.error('Errore: imposta TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID come secrets.');
  process.exit(1);
}

const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;
const FILE_BASE = `https://api.telegram.org/file/bot${BOT_TOKEN}`;

function getLastOffset() {
  if (fs.existsSync(OFFSET_FILE)) {
    return parseInt(fs.readFileSync(OFFSET_FILE, 'utf8').trim(), 10) || 0;
  }
  return 0;
}

function saveOffset(offset) {
  fs.writeFileSync(OFFSET_FILE, String(offset));
}

function countImages(dir) {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((f) => IMAGE_EXTENSIONS.includes(path.extname(f).toLowerCase())).length;
}

async function getUpdates(offset) {
  const res = await fetch(`${API_BASE}/getUpdates?offset=${offset + 1}&timeout=0`);
  const data = await res.json();
  if (!data.ok) throw new Error(`Errore getUpdates: ${JSON.stringify(data)}`);
  return data.result;
}

async function getFilePath(fileId) {
  const res = await fetch(`${API_BASE}/getFile?file_id=${fileId}`);
  const data = await res.json();
  // I bot non possono scaricare file oltre ~20 MB: qui getFile risponde con errore
  if (!data.ok) throw new Error(`Errore getFile (file troppo grande? max 20MB): ${JSON.stringify(data)}`);
  return data.result.file_path;
}

async function downloadFile(filePath, destPath) {
  const res = await fetch(`${FILE_BASE}/${filePath}`);
  if (!res.ok) throw new Error(`Download fallito (HTTP ${res.status})`);
  fs.writeFileSync(destPath, Buffer.from(await res.arrayBuffer()));
}

/** Nome sicuro e unico dentro queue/. */
function queueDest(baseName) {
  let dest = path.join(QUEUE_DIR, baseName);
  let i = 1;
  const ext = path.extname(baseName);
  const stem = path.basename(baseName, ext);
  while (fs.existsSync(dest)) {
    dest = path.join(QUEUE_DIR, `${stem}-${i}${ext}`);
    i++;
  }
  return dest;
}

/** Copia le immagini estratte nella coda STORIE. Ritorna quante ne ha copiate. */
function moveImagesToStoryQueue(tmpDir, updateId) {
  let extracted = 0;
  for (const f of fs.readdirSync(tmpDir)) {
    const ext = path.extname(f).toLowerCase();
    if (!IMAGE_EXTENSIONS.includes(ext)) continue;
    extracted++;
    const dest = queueDest(`telegram-${updateId}-${extracted}${ext}`);
    fs.copyFileSync(path.join(tmpDir, f), dest);
    console.log(`Estratta da zip: ${path.basename(dest)}`);
  }
  return extracted;
}

/**
 * Zip con meta.json (o caption.txt): pacchetto POST carosello.
 * Valida, normalizza le immagini (ratio uniforme, JPEG 1440px) e mette in
 * coda su uno slot del calendario. Errori → messaggio, niente in coda.
 */
async function handlePostZip(tmpDir, zipName, metaFile) {
  let meta;
  if (metaFile === 'meta.json') {
    try {
      meta = JSON.parse(stripBom(fs.readFileSync(path.join(tmpDir, 'meta.json'), 'utf8')));
    } catch (err) {
      await sendMessage(`❌ Zip "${zipName}": meta.json non è JSON valido (${err.message.slice(0, 120)}). Correggi e rimanda.`);
      return 0;
    }
  } else {
    meta = { caption: stripBom(fs.readFileSync(path.join(tmpDir, 'caption.txt'), 'utf8')).trim() };
  }

  const images = fs.readdirSync(tmpDir)
    .filter((f) => IMAGE_EXTENSIONS.includes(path.extname(f).toLowerCase()))
    .sort();

  const errors = validatePost(meta, images.length);
  if (errors.length > 0) {
    await sendMessage(`❌ Zip "${zipName}" NON in coda:\n• ${errors.join('\n• ')}\nCorreggi e rimanda.`);
    return 0;
  }

  const queued = listQueuedPosts();
  const slot = assignSlot(meta.publish_at, queued);
  if (slot.error) {
    await sendMessage(`❌ Zip "${zipName}": ${slot.error}`);
    return 0;
  }

  const slug = slugify(zipName);
  const dirName = folderName(slot.when, slug);
  const destDir = path.join(POST_QUEUE_DIR, dirName);
  const result = normalizeImages(images.map((f) => path.join(tmpDir, f)), destDir);

  const finalMeta = {
    caption: String(meta.caption || '').trim(),
    alt_text: Array.isArray(meta.alt_text) ? meta.alt_text.map((a) => String(a).slice(0, 1000)) : [],
    tags: Array.isArray(meta.tags) ? meta.tags : [],
    publish_at: slot.when.toISOString(),
    requested_at: meta.publish_at || null,
    source_zip: zipName,
    imported_at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(destDir, 'meta.json'), JSON.stringify(finalMeta, null, 2));

  const slotNote = slot.exact
    ? ''
    : slot.asap
      ? `\nℹ️ L'orario chiesto è già passato: esce alla prossima run (entro un'ora).`
      : `\n⚠️ L'orario chiesto (${meta.publish_at}) era occupato: ho preso lo slot libero più vicino.`;
  await sendMessage(
    `🗓 Post in coda!\n` +
    `📁 ${dirName}\n` +
    `🖼 ${result.count} slide, ratio ${result.ratio}\n` +
    `⏰ Esce: ${formatWhen(slot.when)}${slotNote}\n` +
    `👀 /anteprima ${slug} · 📋 /coda`
  );
  console.log(`Post in coda: ${dirName} (${result.count} slide)`);
  return result.count;
}

/** Estrae uno zip e lo smista: meta.json/caption.txt → coda POST, altrimenti coda STORIE. */
async function handleZip(zipPath, zipName, updateId) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-zip-'));
  // -j: ignora le sottocartelle, -o: sovrascrivi, -qq: silenzioso
  execSync(`unzip -j -o -qq "${zipPath}" -d "${tmpDir}"`);
  try {
    const metaFile = fs.existsSync(path.join(tmpDir, 'meta.json')) ? 'meta.json'
      : fs.existsSync(path.join(tmpDir, 'caption.txt')) ? 'caption.txt' : null;

    if (metaFile) return await handlePostZip(tmpDir, zipName, metaFile);

    const n = moveImagesToStoryQueue(tmpDir, updateId);
    if (n === 0) await sendMessage(`⚠️ Lo zip "${zipName}" non conteneva immagini jpg/png.`);
    else await sendMessage(`📥 Zip "${zipName}" → coda STORIE (${n} immagini).\nℹ️ Per un post carosello includi meta.json o caption.txt nello zip (/help).`);
    return n;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Trova un post in coda per indice (come in /coda) o per pezzo di nome. */
function findPost(ref, queued) {
  if (/^\d+$/.test(ref)) {
    const p = queued[parseInt(ref, 10) - 1];
    return p ? { post: p } : { error: `Non c'è un post n. ${ref} in coda (/coda per la lista).` };
  }
  const matches = queued.filter((p) => p.dirName.includes(ref));
  if (matches.length === 1) return { post: matches[0] };
  if (matches.length === 0) return { error: `Nessun post in coda contiene "${ref}" (/coda per la lista).` };
  return { error: `"${ref}" è ambiguo: ${matches.map((m) => m.dirName).join(', ')}` };
}

async function handleCommand(text) {
  const cmd = text.trim();
  const lower = cmd.toLowerCase();

  if (lower.startsWith('/status') || lower === 'status') {
    const inQueue = countImages(QUEUE_DIR);
    const published = countImages(PUBLISHED_DIR);
    const posts = listQueuedPosts();
    const next = posts[0];
    await sendMessage(
      `📊 velo.rar — stato\n` +
      `🗂 Storie in coda: ${inQueue}\n` +
      `✅ Storie pubblicate: ${published}\n` +
      `⏰ Storie: ogni 4 ore (00·04·08·12·16·20 UTC)\n` +
      `📮 Post in coda: ${posts.length}` +
      (next ? ` — prossimo: ${formatWhen(next.meta.publish_at)}` : '') + `\n` +
      (inQueue === 0 ? `♻️ Coda storie vuota: si ricicla dalle già pubblicate.` : `📅 Autonomia storie: ~${Math.floor(inQueue / 6)}g ${(inQueue % 6) * 4}h`)
    );
    return true;
  }

  if (lower.startsWith('/coda')) {
    const posts = listQueuedPosts();
    if (posts.length === 0) {
      await sendMessage('📮 Nessun post in coda. Mandami uno zip con meta.json (o caption.txt) + immagini.');
      return true;
    }
    const lines = posts.map((p, i) => {
      const cap = buildCaption(p.meta).replace(/\s+/g, ' ').slice(0, 60);
      return `${i + 1}. ${formatWhen(p.meta.publish_at)} — ${p.images.length} slide\n   ${p.dirName}\n   "${cap}…"`;
    });
    await sendMessage(`📮 Post in coda (${posts.length}):\n${lines.join('\n')}\n\n👀 /anteprima N · 🔀 /sposta N <ISO|prossimo> · 🗑 /annulla N`);
    return true;
  }

  if (lower.startsWith('/anteprima')) {
    const ref = cmd.split(/\s+/)[1];
    if (!ref) { await sendMessage('Uso: /anteprima <numero o nome> (vedi /coda)'); return true; }
    const { post, error } = findPost(ref, listQueuedPosts());
    if (error) { await sendMessage(`⚠️ ${error}`); return true; }
    const caption = buildCaption(post.meta);
    await sendPhotoFile(
      path.join(post.dir, post.images[0]),
      `👀 ${post.dirName}\n🖼 ${post.images.length} slide · ⏰ ${formatWhen(post.meta.publish_at)}\n\n${caption.slice(0, 850)}${caption.length > 850 ? '…' : ''}`
    );
    return true;
  }

  if (lower.startsWith('/sposta')) {
    const [, ref, when] = cmd.split(/\s+/);
    if (!ref || !when) { await sendMessage('Uso: /sposta <numero o nome> <2026-07-20T17:30:00Z | prossimo>'); return true; }
    const queued = listQueuedPosts();
    const { post, error } = findPost(ref, queued);
    if (error) { await sendMessage(`⚠️ ${error}`); return true; }
    const others = queued.filter((p) => p.dirName !== post.dirName);
    const slot = assignSlot(when.toLowerCase() === 'prossimo' ? null : when, others);
    if (slot.error) { await sendMessage(`⚠️ ${slot.error}`); return true; }

    const meta = { ...post.meta, publish_at: slot.when.toISOString() };
    fs.writeFileSync(path.join(post.dir, 'meta.json'), JSON.stringify(meta, null, 2));
    // Rinomina la cartella così il nome resta coerente con lo slot
    const slug = post.dirName.replace(/^\d{4}-\d{2}-\d{2}-\d{4}-/, '');
    const newDirName = folderName(slot.when, slug);
    if (newDirName !== post.dirName) fs.renameSync(post.dir, path.join(POST_QUEUE_DIR, newDirName));
    const note = slot.exact ? '' : `\n⚠️ Orario occupato o passato: preso lo slot libero più vicino.`;
    await sendMessage(`🔀 Spostato!\n📁 ${newDirName}\n⏰ Esce: ${formatWhen(slot.when)}${note}`);
    return true;
  }

  if (lower.startsWith('/annulla')) {
    const ref = cmd.split(/\s+/)[1];
    if (!ref) { await sendMessage('Uso: /annulla <numero o nome> (vedi /coda)'); return true; }
    const { post, error } = findPost(ref, listQueuedPosts());
    if (error) { await sendMessage(`⚠️ ${error}`); return true; }
    fs.rmSync(post.dir, { recursive: true, force: true });
    await sendMessage(`🗑 Annullato: ${post.dirName}\nSe ti serve di nuovo, rimanda lo zip.`);
    return true;
  }

  if (lower.startsWith('/help') || lower.startsWith('/start')) {
    await sendMessage(
      `🤖 Bot velo.rar — cosa posso fare:\n` +
      `📷 Foto o immagini-FILE → coda storie\n` +
      `🗜 .zip di sole immagini → coda storie\n` +
      `📮 .zip con meta.json + immagini → POST carosello programmato\n` +
      `   meta.json: {"caption":"…","alt_text":["…"],"tags":["…"],"publish_at":"2026-07-20T17:30:00Z"}\n` +
      `   (publish_at opzionale: senza, prendo il primo slot libero lun/mer/sab 17:30 UTC)\n` +
      `   (in alternativa basta un caption.txt con il solo testo)\n` +
      `📋 /coda → post programmati\n` +
      `👀 /anteprima N · 🔀 /sposta N <data|prossimo> · 🗑 /annulla N\n` +
      `📊 /status → stato code\n` +
      `Storie ogni 4 ore; post negli slot del calendario. Conferme sempre qui.`
    );
    return true;
  }
  return false;
}

/** Processa un singolo update. Ritorna quante immagini ha aggiunto in coda. */
async function processUpdate(update) {
  const message = update.message;
  if (!message) return 0;

  if (String(message.chat.id) !== String(CHAT_ID)) {
    console.log(`Ignorato: messaggio da chat non autorizzata (${message.chat.id}).`);
    return 0;
  }

  // Comandi testuali
  if (message.text) {
    await handleCommand(message.text);
    return 0;
  }

  // Foto normale: l'ultima dell'array è la risoluzione più alta
  if (message.photo) {
    const best = message.photo[message.photo.length - 1];
    const filePath = await getFilePath(best.file_id);
    const ext = path.extname(filePath) || '.jpg';
    const dest = queueDest(`telegram-${update.update_id}${ext}`);
    await downloadFile(filePath, dest);
    console.log(`Scaricata foto: ${path.basename(dest)}`);
    return 1;
  }

  // Documento: zip (storie o post), oppure immagine inviata come file
  if (message.document) {
    const doc = message.document;
    const name = doc.file_name || '';
    const mime = doc.mime_type || '';
    const isZip = mime === 'application/zip' || name.toLowerCase().endsWith('.zip');
    const isImage = IMAGE_MIMES.includes(mime) || IMAGE_EXTENSIONS.includes(path.extname(name).toLowerCase());

    if (isZip) {
      const filePath = await getFilePath(doc.file_id);
      const tmpZip = path.join(os.tmpdir(), `tg-${update.update_id}.zip`);
      await downloadFile(filePath, tmpZip);
      const n = await handleZip(tmpZip, name || `zip-${update.update_id}`, update.update_id);
      fs.rmSync(tmpZip, { force: true });
      return n;
    }

    if (isImage) {
      const filePath = await getFilePath(doc.file_id);
      const ext = path.extname(name).toLowerCase() || path.extname(filePath) || '.jpg';
      const dest = queueDest(`telegram-${update.update_id}${ext}`);
      await downloadFile(filePath, dest);
      console.log(`Scaricato file immagine (qualità piena): ${path.basename(dest)}`);
      return 1;
    }

    await sendMessage(`⚠️ File "${name}" ignorato: accetto solo immagini jpg/png o zip.`);
    return 0;
  }

  return 0;
}

function commitAndPush() {
  execSync('git config user.name "ig-publisher-bot"');
  execSync('git config user.email "actions@github.com"');
  // -A anche su queue-posts: /sposta e /annulla producono rinomini e rimozioni
  execSync(`git add -A -- ${QUEUE_DIR} ${POST_QUEUE_DIR} ${OFFSET_FILE}`);
  execSync('git commit -m "Import da Telegram" || echo "Nulla da committare"');
  execSync('git pull --rebase');
  execSync('git push');
}

async function main() {
  if (!fs.existsSync(QUEUE_DIR)) fs.mkdirSync(QUEUE_DIR, { recursive: true });
  if (!fs.existsSync(POST_QUEUE_DIR)) fs.mkdirSync(POST_QUEUE_DIR, { recursive: true });

  const lastOffset = getLastOffset();
  const updates = await getUpdates(lastOffset);

  if (updates.length === 0) {
    console.log('Nessun messaggio nuovo.');
    return;
  }

  let maxUpdateId = lastOffset;
  let downloaded = 0;
  let errors = 0;

  for (const update of updates) {
    maxUpdateId = Math.max(maxUpdateId, update.update_id);
    try {
      downloaded += await processUpdate(update);
    } catch (err) {
      errors++;
      console.error(`Update ${update.update_id} fallito:`, err.message);
      await sendMessage(`⚠️ Non sono riuscito a importare un file: ${err.message}`);
    }
  }

  saveOffset(maxUpdateId);
  commitAndPush();

  if (downloaded > 0) {
    const inQueue = countImages(QUEUE_DIR);
    await sendMessage(`📥 Ricevute! ${downloaded} immagini aggiunte alle code.\n🗂 Storie in coda: ${inQueue} (autonomia ~${Math.floor(inQueue / 6)}g ${(inQueue % 6) * 4}h)`);
    console.log(`Importate ${downloaded} nuove immagini (${errors} errori).`);
  } else {
    console.log(`Nessuna immagine nuova (${errors} errori), offset aggiornato.`);
  }
}

main().catch(async (err) => {
  console.error('Fallito:', err.message);
  await sendMessage(`❌ Import da Telegram fallito: ${err.message}`);
  process.exit(1);
});
