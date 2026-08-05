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
const { execSync, execFileSync } = require('child_process');
const { sendMessage, sendPhotoFile, sendDocumentFile, answerCallback, editMessage } = require('./telegram');
const { parseIgLink, parseIgFlags, keyboardFor, fetchMediaInfo, applyChoice, downloadPhoto, CHOICES } = require('./igdl');
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
// Bozze: materiale grezzo da riformulare in chiave velo.rar. Il repo e' PUBBLICO,
// quindi qui dentro NON finisce mai chi ha scritto il post originale: ne' username,
// ne' link, ne' menzioni, ne' hashtag. L'attribuzione resta solo nella chat privata.
const REPOST_DIR = 'bozze';                       // temporanea: gli zip NON si committano
const REPOST_INDEX = 'bozze/indice.jsonl';        // solo file_id + numeri: nulla di identificante
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
    manuale: meta.manuale === true,   // true = allo slot te lo consegno, non lo pubblico
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
    (finalMeta.manuale ? `\u{1F4F2} MANUALE: allo slot te lo mando qui, lo pubblichi tu (musica!)\n` : '') +
    `👀 /anteprima ${slug} · 📋 /coda`
  );
  console.log(`Post in coda: ${dirName} (${result.count} slide)`);
  return result.count;
}

// Telegram rifiuta i documenti oltre i 50 MB: meglio dirlo prima di provarci.
const TG_MAX_DOC_MB = 50;
// Sotto il tetto vero, perche' lo zip comprime poco le JPEG e il margine serve.
const CHUNK_MB = 42;

/** Le sorgenti che `/archivio` sa impacchettare. */
const ARCHIVI = {
  storie:    { dir: QUEUE_DIR,       desc: 'immagini in coda storie' },
  pubblicate:{ dir: PUBLISHED_DIR,   desc: 'storie gia uscite' },
  post:      { dir: POST_QUEUE_DIR,  desc: 'post carosello in coda' },
};

function elencaFile(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...elencaFile(p));
    else if (!e.name.startsWith('.')) out.push(p);
  }
  return out;
}

/**
 * Impacchetta una cartella e la manda in chat, spezzando in piu' zip quando
 * serve: i bot Telegram non accettano documenti oltre i 50 MB, e `queue/` da
 * sola supera quella soglia. La divisione e' per DIMENSIONE, non per numero di
 * file, cosi' un pacchetto pesante non fa saltare la parte.
 */
async function mandaArchivio(chiave, feedback) {
  const conf = ARCHIVI[chiave];
  const files = elencaFile(conf.dir);
  if (files.length === 0) {
    await feedback(`\u{1F4ED} "${chiave}": non c'e' niente da mandare.`);
    return true;
  }

  // Raggruppo per dimensione. Un singolo file oltre il limite va da solo:
  // meglio un tentativo fallito e dichiarato che escluderlo in silenzio.
  const limite = CHUNK_MB * 1024 * 1024;
  const parti = [];
  let corrente = [];
  let peso = 0;
  for (const f of files) {
    const s = fs.statSync(f).size;
    if (corrente.length && peso + s > limite) { parti.push(corrente); corrente = []; peso = 0; }
    corrente.push(f);
    peso += s;
  }
  if (corrente.length) parti.push(corrente);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-'));
  const oggi = new Date().toISOString().slice(0, 10);
  let inviate = 0;
  try {
    await feedback(`\u{1F4E6} "${chiave}": ${files.length} file, ${parti.length} pacchetto/i. Li mando...`);
    for (let i = 0; i < parti.length; i++) {
      const nome = parti.length === 1
        ? `velopub-${chiave}-${oggi}.zip`
        : `velopub-${chiave}-${oggi}-parte${i + 1}di${parti.length}.zip`;
      const zipPath = path.join(tmpDir, nome);
      const lista = path.join(tmpDir, `lista-${i}.txt`);
      // -@ legge i path da stdin: una riga di comando con 160 file la supera.
      fs.writeFileSync(lista, parti[i].join('\n'));
      execSync(`zip -q -X "${zipPath}" -@ < "${lista}"`, { shell: '/bin/bash' });
      const mb = (fs.statSync(zipPath).size / 1048576).toFixed(1);
      if (fs.statSync(zipPath).size > TG_MAX_DOC_MB * 1048576) {
        await feedback(`⚠️ Parte ${i + 1} pesa ${mb} MB, oltre il limite di Telegram: saltata.`);
        continue;
      }
      const ok = await sendDocumentFile(zipPath,
        `${nome} — ${parti[i].length} file, ${mb} MB`);
      if (ok) inviate++;
      else await feedback(`⚠️ Parte ${i + 1} rifiutata da Telegram.`);
    }
    await feedback(`✅ "${chiave}": ${inviate}/${parti.length} pacchetti inviati (${files.length} file).`);
    return true;
  } catch (err) {
    await feedback(`❌ Archivio "${chiave}" fallito: ${String(err.message).slice(0, 160)}`);
    return false;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Impacchetta un post della coda e lo manda in chat, SU RICHIESTA.
 * Lo zip prende il nome dallo slot (cioe' la data di pubblicazione), dentro ci
 * sono la caption pronta da incollare e le slide rinominate in ordine:
 * copertina, poi le pagine. L'ordine alfabetico dei file E' l'ordine del
 * carosello, cosi' su Instagram basta selezionarle tutte.
 *
 * Non tocca la coda: si puo' richiedere tutte le volte che serve, e il post
 * resta programmato esattamente com'era.
 */
async function inviaZipPost(post) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pacco-'));
  const dentro = path.join(tmpDir, 'dentro');
  fs.mkdirSync(dentro);
  const zipPath = path.join(tmpDir, `${post.dirName}.zip`);
  try {
    const caption = buildCaption(post.meta);
    fs.writeFileSync(path.join(dentro, 'caption.txt'), caption, 'utf8');
    post.images.forEach((f, i) => {
      const ext = path.extname(f).toLowerCase();
      const nome = i === 0
        ? `01-copertina${ext}`
        : `${String(i + 1).padStart(2, '0')}-pag${i}${ext}`;
      fs.copyFileSync(path.join(post.dir, f), path.join(dentro, nome));
    });
    // -j: niente struttura di cartelle dentro lo zip, -q: silenzioso
    execSync(`zip -j -q "${zipPath}" "${dentro}"/*`);

    const bytes = fs.statSync(zipPath).size;
    if (bytes > TG_MAX_DOC_MB * 1024 * 1024) {
      await sendMessage(
        `⚠️ Il pacchetto di "${post.dirName}" pesa ${Math.round(bytes / 1048576)} MB: ` +
        `Telegram si ferma a ${TG_MAX_DOC_MB} MB. Usa /anteprima, oppure togli qualche slide.`);
      return false;
    }

    const modo = post.meta.manuale === true
      ? `📲 È già manuale: allo slot te lo rimando comunque, non lo pubblico io.`
      : `🤖 Attenzione: è ancora AUTOMATICO — allo slot lo pubblico io. Per fermarlo: /manuale ${post.dirName}`;
    const ok = await sendDocumentFile(zipPath,
      `📦 ${post.dirName}.zip (${Math.round(bytes / 1024)} KB)\n` +
      `🖼 ${post.images.length} slide + caption.txt · ⏰ slot ${formatWhen(post.meta.publish_at)}\n` +
      `${modo}\n` +
      `La caption è anche nel messaggio qui sotto, per copiarla al volo.`);
    if (!ok) {
      await sendMessage(`⚠️ Pacchetto di "${post.dirName}" non inviato: Telegram ha rifiutato il file. Riprova con /zip.`);
      return false;
    }
    // Messaggio separato e pulito: un tocco lungo copia la caption per intero.
    await sendMessage(caption);
    console.log(`Pacchetto inviato: ${post.dirName}.zip`);
    return true;
  } catch (err) {
    console.error(`Pacchetto di ${post.dirName} fallito:`, err.message);
    await sendMessage(`⚠️ Non sono riuscito a impacchettare "${post.dirName}": ${err.message.slice(0, 200)}`);
    return false;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
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
      const modo = p.meta.manuale === true ? ' \u{1F4F2} manuale' : '';
      return `${i + 1}. ${formatWhen(p.meta.publish_at)} — ${p.images.length} slide${modo}\n   ${p.dirName}\n   "${cap}…"`;
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

  if (lower.startsWith('/manuale')) {
    const [, ref, off] = cmd.split(/\s+/);
    if (!ref) { await sendMessage('Uso: /manuale <numero o nome> [off]  (vedi /coda)'); return true; }
    const { post, error } = findPost(ref, listQueuedPosts());
    if (error) { await sendMessage(`\u26A0\uFE0F ${error}`); return true; }
    const attiva = String(off || '').toLowerCase() !== 'off';
    const meta = { ...post.meta, manuale: attiva };
    fs.writeFileSync(path.join(post.dir, 'meta.json'), JSON.stringify(meta, null, 2));
    await sendMessage(attiva
      ? `\u{1F4F2} "${post.dirName}" passa a MANUALE.\nAllo slot (${formatWhen(post.meta.publish_at)}) ti mando slide e caption: lo pubblichi tu dall'app, con la musica.`
      : `\u{1F916} "${post.dirName}" torna AUTOMATICO: lo pubblico io allo slot (${formatWhen(post.meta.publish_at)}).`);
    return true;
  }

  if (lower.startsWith('/archivio')) {
    const arg = (cmd.split(/\s+/)[1] || '').toLowerCase();
    const chiavi = Object.keys(ARCHIVI);
    if (!arg) {
      const righe = chiavi.map((k) => {
        const n = elencaFile(ARCHIVI[k].dir).length;
        return `  /archivio ${k} — ${ARCHIVI[k].desc} (${n} file)`;
      });
      await sendMessage(
        `\u{1F4E6} Ti mando qui una cartella intera, in zip. Se supera i 50 MB la spezzo.\n` +
        `${righe.join('\n')}\n  /archivio tutto — tutte e tre, una dopo l'altra`);
      return true;
    }
    if (arg === 'tutto') {
      for (const k of chiavi) await mandaArchivio(k, sendMessage);
      return true;
    }
    if (!ARCHIVI[arg]) {
      await sendMessage(`⚠️ "${arg}" non esiste. Scegli fra: ${chiavi.join(', ')}, tutto.`);
      return true;
    }
    await mandaArchivio(arg, sendMessage);
    return true;
  }

  if (lower.startsWith('/zip') || lower.startsWith('/pacco')) {
    const posts = listQueuedPosts();
    if (posts.length === 0) { await sendMessage('📮 Nessun post in coda da impacchettare.'); return true; }
    const ref = cmd.split(/\s+/)[1];
    // Senza numero prendo il primo della coda: nove volte su dieci e' quello.
    const { post, error } = ref ? findPost(ref, posts) : { post: posts[0] };
    if (error) { await sendMessage(`⚠️ ${error}`); return true; }
    await inviaZipPost(post);
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
      `🔗 Link post IG pubblico → foto in coda storie a risoluzione massima\n` +
      `   Flag: -f senza la 1ª · -b senza l'ultima · -f -b entrambe · solo link = tutte\n` +
      `   -repost → BOZZA: zip mandato qui in chat con foto + testo (studio, NON storie)\n` +
      `   (testo non riconosciuto accanto al link → ti chiedo io coi bottoni)\n` +
      `📮 .zip con meta.json + immagini → POST carosello programmato\n` +
      `   meta.json: {"caption":"…","alt_text":["…"],"tags":["…"],"publish_at":"2026-07-20T17:30:00Z","manuale":false}\n` +
      `   (publish_at opzionale: senza, prendo il primo slot libero lun/mer/sab 17:30 UTC)\n` +
      `   (in alternativa basta un caption.txt con il solo testo)\n` +
      `📋 /coda → post programmati\n` +
      `👀 /anteprima N · 🔀 /sposta N <data|prossimo> · 🗑 /annulla N\n` +
      `📲 /manuale N → allo slot te lo mando invece di pubblicarlo (per la musica); /manuale N off per annullare\n` +
      `📦 /zip [N] → te lo impacchetto SUBITO: zip con caption.txt + slide numerate, nome = data di uscita\n` +
      `   (senza N prende il primo in coda; non tocca la coda, chiedilo quante volte vuoi)\n` +
      `🗄 /archivio [storie|pubblicate|post|tutto] → ti mando qui la cartella intera in zip\n` +
      `   (oltre i 50 MB la spezzo in parti numerate; senza argomento ti dico cosa c'è)\n` +
      `📊 /status → stato code\n` +
      `Storie ogni 4 ore; post negli slot del calendario. Conferme sempre qui.`
    );
    return true;
  }
  return false;
}

/* ---------------------------------------------------------------------------
 * Repost da Instagram → coda storie (vedi igdl.js per il flusso completo).
 * ------------------------------------------------------------------------- */

/** Messaggi-domanda già lavorati in QUESTA run (doppi tocchi nello stesso batch). */
const igHandled = new Set();

async function askIgChoice(code) {
  await sendMessage(
    `🔗 Post Instagram rilevato (${code}).
Cosa salvo nella coda storie?`,
    { reply_markup: keyboardFor(code) }
  );
  console.log(`Repost IG ${code}: domanda inviata.`);
}

/**
 * Cuore del repost: risolve, filtra, scarica in queue/, manda l'esito via
 * `feedback(testo)` (editMessage per i bottoni, sendMessage per i flag).
 * Ritorna sempre 0: il feedback è già completo, niente doppio messaggio.
 */
async function runIgImport(code, choice, feedback, repost = false) {
  const fail = (why) =>
    feedback(`❌ Repost ${code} fallito: ${why}
🔁 Rimanda il link per riprovare.`);

  if (!process.env.IG_SESSION_B64) {
    await fail('manca il secret IG_SESSION_B64 (vedi README, sezione Repost).');
    return 0;
  }

  let info;
  try {
    info = fetchMediaInfo(code, repost);   // la bio costa una chiamata: solo per l'archivio
  } catch (err) {
    await fail(`igdl-fetch non risponde (${String(err.message || err).slice(0, 120)})`);
    return 0;
  }
  if (!info.ok) { await fail(info.error); return 0; }

  const { photos, videosSkipped } = applyChoice(info.slides, choice);
  if (photos.length === 0) {
    await fail(
      `con la scelta "${CHOICES[choice].desc}" non resta nessuna foto ` +
      `(il post ha ${info.slides.length} slide${videosSkipped ? `, di cui ${videosSkipped} video` : ''}).`
    );
    return 0;
  }

  // -repost -> zip d'archivio in repost-material/; altrimenti foto sciolte in coda storie.
  if (repost) return archiveRepost(code, choice, info, photos, videosSkipped, feedback, fail);

  const saved = [];
  try {
    for (const p of photos) {
      const dest = queueDest(`ig-${code}-${p.pos}.jpg`);
      await downloadPhoto(p.url, dest);
      saved.push(dest);
    }
  } catch (err) {
    // Cleanup: senza, i file già scaricati verrebbero committati in coda
    // nonostante il "fallito" — e al retry ci finirebbero DUE volte.
    for (const f of saved) fs.rmSync(f, { force: true });
    await fail(`scaricate ${saved.length}/${photos.length} foto, poi: ${String(err.message || err).slice(0, 120)}. Nessun file in coda.`);
    return 0;
  }

  const inQueue = countImages(QUEUE_DIR);
  await feedback(
    `✅ Repost da @${info.author}: ${saved.length} foto in coda storie (${CHOICES[choice].desc}` +
    `${videosSkipped ? `; ${videosSkipped} video ignorat${videosSkipped === 1 ? 'o' : 'i'}` : ''}).
` +
    `🗂 Storie in coda: ${inQueue} (autonomia ~${Math.floor(inQueue / 6)}g ${(inQueue % 6) * 4}h)`);
  console.log(`Repost IG ${code}: ${saved.length} foto in coda (scelta: ${choice}).`);
  return 0;
}

/**
 * Scheda che accompagna le foto dentro la bozza. Il file NON entra nel repo
 * (bozze/*.zip e' in .gitignore): viaggia solo verso la chat privata, quindi
 * puo' contenere tutto quello che serve per riformulare il post, autore incluso.
 *
 * Nota storica: una prima versione anonimizzava il testo per poterlo committare.
 * Non regge: nessuna regex riconosce che una frase in italiano identifica
 * qualcuno, e bio e caption verbatim sono ricercabili parola per parola.
 * Meglio tenere il file fuori dal repo e completo.
 */
function buildInfoText(info, choice, nFoto, videosSkipped) {
  const righe = [
    'BOZZA - materiale grezzo da riformulare in chiave velo.rar',
    `Origine: @${info.author} - https://www.instagram.com/p/${info.code}/`,
    `Salvato: ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    `Foto: ${nFoto} (${CHOICES[choice].desc})${videosSkipped ? ` - video ignorati: ${videosSkipped}` : ''}`,
  ];
  if (info.taken_at) righe.push(`Pubblicato: ${String(info.taken_at).slice(0, 16)}`);
  if (info.like_count != null) {
    righe.push(`Like: ${info.like_count} - Commenti: ${info.comment_count == null ? '?' : info.comment_count}`);
  }
  if (info.via) righe.push(`Risolto via: ${info.via}`);
  if (info.bio) righe.push('', '--- BIO ACCOUNT ---', info.bio);
  else if (info.bio_error) righe.push('', `(bio non recuperata: ${info.bio_error})`);
  righe.push('', '--- TESTO ORIGINALE ---', info.caption || '(nessun testo)');
  return righe.join('\n');
}

/** Misura tutte le immagini in una sola chiamata a Python (Pillow c'e' sempre). */
function misura(files) {
  const py = [
    'import sys, json',
    'from PIL import Image',
    'out = []',
    'for p in sys.argv[1:]:',
    '    try:',
    '        with Image.open(p) as im: out.append([im.width, im.height, im.format])',
    '    except Exception as e: out.append([0, 0, "?"])',
    'print(json.dumps(out))',
  ].join('\n');
  try {
    return JSON.parse(execFileSync(process.env.IGDL_PYTHON || 'python3',
      ['-c', py, ...files], { encoding: 'utf8', timeout: 60000 }).trim());
  } catch (err) {
    console.error('[bozza] misura immagini fallita:', err.message.slice(0, 90));
    return files.map(() => [0, 0, '?']);
  }
}

/**
 * La mini-guida che viaggia dentro ogni bozza. Serve a rispondere, senza
 * riaprire nulla, alle due domande che ci si fa davanti a uno zip di
 * materiale: **cosa c'e' dentro** (e quanto vale, misurato) e **cosa ci si fa**.
 * I numeri sono misurati sui file veri, non stimati.
 */
function buildGuidaText(info, files, choice, videosSkipped) {
  const dim = misura(files);
  const piena = [];
  const dentro = [];
  const scarto = [];
  dim.forEach(([w, h], i) => {
    const nome = path.basename(files[i]);
    const riga = `${nome}  ${w}x${h}`;
    if (w >= 1080 && h >= 1080) piena.push(riga);
    else if (Math.min(w, h) >= 800) dentro.push(riga);
    else scarto.push(riga);
  });
  const [w0, h0] = dim[0] || [0, 0];
  const ratio = h0 ? (w0 / h0).toFixed(2) : '?';

  const L = [];
  L.push('MINI-GUIDA — cosa c\'e\' in questa bozza e cosa farci');
  L.push('='.repeat(52));
  L.push('');
  L.push(`Origine: @${info.author} · ${files.length} immagini (${CHOICES[choice].desc})` +
         `${videosSkipped ? ` · ${videosSkipped} video scartati` : ''}`);
  L.push('');
  L.push('--- QUALITA\' MISURATA ---');
  L.push(`Copertina possibile (>=1080 su entrambi i lati): ${piena.length}`);
  piena.forEach((r) => L.push(`   ${r}`));
  if (dentro.length) {
    L.push(`Solo come slide interne (lato corto >=800): ${dentro.length}`);
    dentro.forEach((r) => L.push(`   ${r}`));
  }
  if (scarto.length) {
    L.push(`Da scartare (lato corto <800): ${scarto.length}`);
    scarto.forEach((r) => L.push(`   ${r}`));
  }
  L.push('');
  L.push(`La prima immagine ha ratio ${ratio}. Conta: il carosello eredita il ratio`);
  L.push('della PRIMA slide, quindi la copertina decide il taglio di tutte le altre.');
  L.push('La copertina va a 4:5 (1080x1350).');
  L.push('');
  L.push('--- SE DIVENTA UN POST velo.rar ---');
  L.push('Massimo 10 slide via API. Niente slide CTA "FOLLOW US".');
  L.push('Niente testo critico nella fascia bassa: i crop 1:1 e 3:4 della griglia lo tagliano.');
  L.push('');
  L.push('Caption: ZERO hashtag su Instagram (misurato: 26,5 like con contro 22,6 senza,');
  L.push('e 7 competitor su 8 da 29K a 3,1M follower non ne usano). Almeno 500 caratteri');
  L.push('(42 like medi contro 23,1 sotto i 300).');
  L.push('');
  L.push('La VOCE si prende dalle 13 caption vere in ig-analisi/baseline-velo.json, mai');
  L.push('da un prompt che la descrive. Elementi: riga di premessa "Titolo (Anno): premessa');
  L.push('secca" · blocco a frammenti senza verbo · "X as Y" invece di "like" · mossa');
  L.push('concessiva · eredita\' con eredi nominati · chiusura con attitudine · riga-firma.');
  L.push('Densita\': 10-12 nomi propri e almeno un anno ogni ~1.200 caratteri.');
  L.push('');
  L.push('Titolo di COPERTINA (formula diversa dalla caption):');
  L.push('   [Etichetta estetica] in [Opera]   es. "Fog and Psyche in Silent Hill 2"');
  L.push('2-4 parole in Title Case che nominano un LOOK, mai un\'osservazione.');
  L.push('');
  L.push('--- ATTENZIONE ---');
  L.push('Queste immagini vengono dal post di un altro account. Per le storie e\' prassi,');
  L.push('per un post carosello no: decidi se accreditare la fonte.');
  L.push('La musica non passa dall\'API: il post va marcato "manuale": true, oppure');
  L.push('ritirato col comando /zip.');
  L.push('');
  L.push('Guida completa: ig-analisi/DOCS/GUIDA.md · specifica: DOCS/BIBBIA.md');
  return L.join('\n');
}

/**
 * Bozza: scarica le foto in una temp, ci mette caption.txt, zippa e MANDA lo
 * zip in chat come documento. Lo zip non resta nel repo; nell'indice finiscono
 * solo il file_id di Telegram e due numeri, cosi' `ig-analisi/fetch-bozze.py`
 * puo' scaricarle in locale senza consumare la coda degli update (che ha un
 * solo consumatore: questo bot).
 */
async function archiveRepost(code, choice, info, photos, videosSkipped, feedback, fail) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `igrep-${code}-`));
  const zipPath = path.join(tmpDir, `bozza-${new Date().toISOString().slice(0, 10)}-${code}.zip`);
  try {
    const foto = path.join(tmpDir, 'foto');
    fs.mkdirSync(foto);
    for (const p of photos) {
      await downloadPhoto(p.url, path.join(foto, `${String(p.pos).padStart(2, '0')}.jpg`));
    }
    fs.writeFileSync(path.join(foto, 'caption.txt'),
      buildInfoText(info, choice, photos.length, videosSkipped));
    // La guida si chiama 00- per stare in cima quando si apre lo zip.
    const scaricate = photos.map((p) => path.join(foto, `${String(p.pos).padStart(2, '0')}.jpg`))
      .filter((f) => fs.existsSync(f));
    fs.writeFileSync(path.join(foto, '00-GUIDA.txt'),
      buildGuidaText(info, scaricate, choice, videosSkipped));
    // -j: niente struttura di cartelle dentro lo zip, -q: silenzioso
    execSync(`zip -j -q "${zipPath}" "${foto}"/*`);

    const kb = Math.round(fs.statSync(zipPath).size / 1024);
    const fileId = await sendDocumentFile(zipPath,
      `Bozza da @${info.author} - ${photos.length} foto` +
      `${videosSkipped ? ` (${videosSkipped} video ignorati)` : ''}`);

    if (fileId) {
      // Indice non identificante: nessun autore, nessuno shortcode. Il file_id
      // e' opaco e senza il token del bot non apre niente.
      if (!fs.existsSync(REPOST_DIR)) fs.mkdirSync(REPOST_DIR, { recursive: true });
      fs.appendFileSync(REPOST_INDEX, JSON.stringify({
        ts: new Date().toISOString(), file_id: fileId, foto: photos.length, kb,
      }) + '\n');
    }

    await feedback(
      `\u{1F4E6} Bozza pronta: ${photos.length} foto + testo` +
      `${info.bio ? ' + bio' : ''} (${CHOICES[choice].desc}` +
      `${videosSkipped ? `; ${videosSkipped} video ignorati` : ''}).\n` +
      `\u{1F4CE} Te l'ho mandata qui sopra come file - ${kb} KB.\n` +
      (fileId
        ? `\u{1F4BE} In locale: python fetch-bozze.py (la scarica in ig-analisi/bozze/)`
        : `\u26A0\uFE0F Non sono riuscito a registrarla nell'indice: salvala a mano dalla chat.`));
    console.log(`Bozza inviata: ${photos.length} foto, ${kb} KB.`);
  } catch (err) {
    await fail(`bozza non creata: ${String(err.message || err).slice(0, 140)}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  return 0;
}

/** Gestisce il tocco su un bottone (fallback quando il link arriva senza flag validi). */
async function handleIgCallback(cb) {
  const chatId = cb.message && cb.message.chat && cb.message.chat.id;
  if (String(chatId) !== String(CHAT_ID)) { await answerCallback(cb.id); return 0; }

  const m = /^ig:([A-Za-z0-9_-]{5,}):(a|sf|sl|sb)$/.exec(cb.data || '');
  if (!m) { await answerCallback(cb.id); return 0; }
  const [, code, choice] = m;
  const msgId = cb.message.message_id;

  if (igHandled.has(msgId)) { await answerCallback(cb.id, 'Già in lavorazione.'); return 0; }
  igHandled.add(msgId);
  // Nota: col polling orario il callback ha spesso più di qualche secondo:
  // l'ack può rispondere "query too old" e il toast non arrivare. Non-fatale,
  // il feedback vero è l'edit del messaggio-domanda.
  await answerCallback(cb.id, '⏳ Scarico…');

  return runIgImport(code, choice, (text) => editMessage(msgId, text), false);
}

/** Processa un singolo update. Ritorna quante immagini ha aggiunto in coda. */
async function processUpdate(update) {
  if (update.callback_query) return handleIgCallback(update.callback_query);

  const message = update.message;
  if (!message) return 0;

  if (String(message.chat.id) !== String(CHAT_ID)) {
    console.log(`Ignorato: messaggio da chat non autorizzata (${message.chat.id}).`);
    return 0;
  }

  // Testo: link Instagram (con eventuali flag -f/-b) → repost; altrimenti comandi
  if (message.text) {
    const igCode = parseIgLink(message.text);
    if (igCode) {
      const flags = parseIgFlags(message.text);
      if (flags) return runIgImport(igCode, flags.choice, (text) => sendMessage(text), flags.repost);
      await askIgChoice(igCode);   // token non riconosciuti → chiedo coi bottoni
      return 0;
    }
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
  // bozze/: si committa solo indice.jsonl, gli zip li esclude .gitignore
  execSync(`git add -A -- ${QUEUE_DIR} ${POST_QUEUE_DIR} ${REPOST_DIR} ${OFFSET_FILE}`);
  execSync('git commit -m "Import da Telegram" || echo "Nulla da committare"');
  execSync('git pull --rebase');
  execSync('git push');
}

async function main() {
  if (!fs.existsSync(QUEUE_DIR)) fs.mkdirSync(QUEUE_DIR, { recursive: true });
  if (!fs.existsSync(POST_QUEUE_DIR)) fs.mkdirSync(POST_QUEUE_DIR, { recursive: true });
  if (!fs.existsSync(REPOST_DIR)) fs.mkdirSync(REPOST_DIR, { recursive: true });

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

// Parte solo se lanciato direttamente: cosi' il modulo si puo' importare nei
// test senza far partire un giro vero di import.
if (require.main === module) {
  main().catch(async (err) => {
    console.error('Fallito:', err.message);
    await sendMessage(`❌ Import da Telegram fallito: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { __test: { inviaZipPost, findPost, buildGuidaText, elencaFile, ARCHIVI } };
