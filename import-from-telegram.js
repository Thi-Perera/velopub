/**
 * import-from-telegram.js
 * Legge i messaggi ricevuti dal bot Telegram (solo dalla chat autorizzata)
 * e riempie la coda di pubblicazione. Supporta:
 *   - foto normali (prende la risoluzione più alta)
 *   - immagini inviate come FILE/documento (qualità piena, senza compressione)
 *   - archivi .zip contenenti immagini (estratti in queue/)
 *   - comandi: /status (stato coda), /help
 * Tiene traccia dell'ultimo update processato in .telegram-offset.
 *
 * Variabili d'ambiente richieste: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { sendMessage } = require('./telegram');

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

/** Estrae le immagini da uno zip dentro queue/. Ritorna quante ne ha estratte. */
function extractZipToQueue(zipPath, updateId) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-zip-'));
  // -j: ignora le sottocartelle, -o: sovrascrivi, -qq: silenzioso
  execSync(`unzip -j -o -qq "${zipPath}" -d "${tmpDir}"`);
  let extracted = 0;
  for (const f of fs.readdirSync(tmpDir)) {
    const ext = path.extname(f).toLowerCase();
    if (!IMAGE_EXTENSIONS.includes(ext)) continue;
    extracted++;
    const dest = queueDest(`telegram-${updateId}-${extracted}${ext}`);
    fs.copyFileSync(path.join(tmpDir, f), dest);
    console.log(`Estratta da zip: ${path.basename(dest)}`);
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return extracted;
}

async function handleCommand(text) {
  const cmd = text.trim().toLowerCase();
  if (cmd.startsWith('/status') || cmd === 'status') {
    const inQueue = countImages(QUEUE_DIR);
    const published = countImages(PUBLISHED_DIR);
    await sendMessage(
      `📊 velo.rar — stato\n` +
      `🗂 In coda: ${inQueue}\n` +
      `✅ Pubblicate: ${published}\n` +
      `⏰ Storie: ogni 4 ore (00·04·08·12·16·20 UTC)\n` +
      (inQueue === 0 ? `♻️ Coda vuota: si ricicla dalle già pubblicate.` : `📅 Autonomia coda: ~${Math.floor(inQueue / 6)}g ${(inQueue % 6) * 4}h`)
    );
    return true;
  }
  if (cmd.startsWith('/help') || cmd.startsWith('/start')) {
    await sendMessage(
      `🤖 Bot velo.rar — cosa posso fare:\n` +
      `📷 Mandami foto → vanno in coda\n` +
      `📎 Mandami immagini come FILE → qualità piena, in coda\n` +
      `🗜 Mandami uno .zip di immagini → estraggo tutto in coda\n` +
      `📊 /status → stato coda e pubblicazioni\n` +
      `Pubblico una storia ogni 4 ore, poi ti mando la conferma qui.`
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

  // Documento: zip di immagini, oppure immagine inviata come file
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
      const n = extractZipToQueue(tmpZip, update.update_id);
      fs.rmSync(tmpZip, { force: true });
      if (n === 0) await sendMessage(`⚠️ Lo zip "${name}" non conteneva immagini jpg/png.`);
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
  execSync(`git add ${QUEUE_DIR} ${OFFSET_FILE}`);
  execSync('git commit -m "Import da Telegram" || echo "Nulla da committare"');
  execSync('git pull --rebase');
  execSync('git push');
}

async function main() {
  if (!fs.existsSync(QUEUE_DIR)) fs.mkdirSync(QUEUE_DIR, { recursive: true });

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
    await sendMessage(`📥 Ricevute! ${downloaded} immagini aggiunte alla coda.\n🗂 In coda ora: ${inQueue} (autonomia ~${Math.floor(inQueue / 6)}g ${(inQueue % 6) * 4}h)`);
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
