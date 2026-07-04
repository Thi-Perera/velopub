/**
 * import-from-telegram.js
 * Controlla i messaggi ricevuti dal bot Telegram, scarica le foto nuove
 * inviate dalla chat autorizzata e le salva in queue/. Tiene traccia
 * dell'ultimo messaggio processato in un file di offset per non riscaricare
 * le stesse foto due volte.
 *
 * Variabili d'ambiente richieste:
 *   TELEGRAM_BOT_TOKEN
 *   TELEGRAM_CHAT_ID
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const QUEUE_DIR = 'queue';
const OFFSET_FILE = '.telegram-offset';

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

async function getUpdates(offset) {
  const url = `${API_BASE}/getUpdates?offset=${offset + 1}&timeout=0`;
  const res = await fetch(url);
  const data = await res.json();
  if (!data.ok) throw new Error(`Errore getUpdates: ${JSON.stringify(data)}`);
  return data.result;
}

async function getFilePath(fileId) {
  const res = await fetch(`${API_BASE}/getFile?file_id=${fileId}`);
  const data = await res.json();
  if (!data.ok) throw new Error(`Errore getFile: ${JSON.stringify(data)}`);
  return data.result.file_path;
}

async function downloadFile(filePath, destPath) {
  const res = await fetch(`${FILE_BASE}/${filePath}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buffer);
}

function commitAndPush() {
  execSync('git config user.name "ig-publisher-bot"');
  execSync('git config user.email "actions@github.com"');
  execSync(`git add ${QUEUE_DIR} ${OFFSET_FILE}`);
  execSync('git commit -m "Import foto da Telegram" || echo "Nulla da committare"');
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

  for (const update of updates) {
    maxUpdateId = Math.max(maxUpdateId, update.update_id);

    const message = update.message;
    if (!message || !message.photo) continue;
    if (String(message.chat.id) !== String(CHAT_ID)) {
      console.log(`Ignorato: messaggio da chat non autorizzata (${message.chat.id}).`);
      continue;
    }

    // L'ultima foto nell'array è la risoluzione più alta
    const bestPhoto = message.photo[message.photo.length - 1];
    const filePath = await getFilePath(bestPhoto.file_id);
    const ext = path.extname(filePath) || '.jpg';
    const destName = `telegram-${update.update_id}${ext}`;
    const destPath = path.join(QUEUE_DIR, destName);

    await downloadFile(filePath, destPath);
    console.log(`Scaricata: ${destName}`);
    downloaded++;
  }

  saveOffset(maxUpdateId);

  if (downloaded > 0) {
    commitAndPush();
    console.log(`Importate ${downloaded} nuove immagini.`);
  } else {
    console.log('Nessuna foto nuova da importare, ma offset aggiornato.');
    commitAndPush(); // salva comunque il progresso dell'offset
  }
}

main().catch((err) => {
  console.error('Fallito:', err.message);
  process.exit(1);
});
