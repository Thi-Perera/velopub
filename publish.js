/**
 * publish.js
 * Prende un'immagine CASUALE da queue/, la pubblica su Instagram
 * (post o storia), la rinomina con data + progressivo del giorno e la
 * sposta in published/. Se la coda è vuota ricicla da published/
 * (evitando di ripetere l'ultima pubblicata). Al termine manda una
 * notifica Telegram con la foto pubblicata e lo stato della coda.
 *
 * Uso: node publish.js story   (default)
 *      node publish.js post
 *
 * Variabili d'ambiente richieste:
 *   IG_ACCESS_TOKEN, IG_ACCOUNT_ID
 *   GITHUB_REPOSITORY (fornita da GitHub Actions)
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (opzionali, per le notifiche)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { sendMessage, sendPhotoFile } = require('./telegram');

const GRAPH_API_VERSION = 'v21.0';
const BASE_URL = `https://graph.instagram.com/${GRAPH_API_VERSION}`;

const ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN;
const ACCOUNT_ID = process.env.IG_ACCOUNT_ID;
const REPO = process.env.GITHUB_REPOSITORY;

const QUEUE_DIR = 'queue';
const PUBLISHED_DIR = 'published';
const LAST_FILE = '.last-published';
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png'];

if (!ACCESS_TOKEN || !ACCOUNT_ID) {
  console.error('Errore: imposta IG_ACCESS_TOKEN e IG_ACCOUNT_ID come secrets.');
  process.exit(1);
}

function listImages(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => IMAGE_EXTENSIONS.includes(path.extname(f).toLowerCase()));
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function todayString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function nextDailyIndex(date) {
  return listImages(PUBLISHED_DIR).filter((f) => f.startsWith(`${date}-`)).length + 1;
}

function getLastPublished() {
  return fs.existsSync(LAST_FILE) ? fs.readFileSync(LAST_FILE, 'utf8').trim() : '';
}

/**
 * Sceglie l'immagine da pubblicare.
 * Coda per prima; se vuota ricicla da published/ evitando, se possibile,
 * l'ultima immagine già mandata (niente doppioni consecutivi).
 */
function selectImage() {
  const queueImages = listImages(QUEUE_DIR);
  if (queueImages.length > 0) {
    return { fileName: pickRandom(queueImages), dir: QUEUE_DIR, isFromQueue: true };
  }

  console.log('Coda vuota: ripesco a caso dalle immagini già pubblicate.');
  let candidates = listImages(PUBLISHED_DIR);
  const last = getLastPublished();
  if (candidates.length > 1 && last) {
    candidates = candidates.filter((f) => f !== last);
  }
  if (candidates.length > 0) {
    return { fileName: pickRandom(candidates), dir: PUBLISHED_DIR, isFromQueue: false };
  }
  return null;
}

function buildRawUrl(dir, fileName) {
  const branch = process.env.GITHUB_REF_NAME || 'main';
  return `https://raw.githubusercontent.com/${REPO}/${branch}/${dir}/${encodeURIComponent(fileName)}`;
}

async function createMediaContainer({ imageUrl, mediaType }) {
  const params = new URLSearchParams({ image_url: imageUrl, access_token: ACCESS_TOKEN });
  if (mediaType === 'STORIES') params.set('media_type', 'STORIES');

  const res = await fetch(`${BASE_URL}/${ACCOUNT_ID}/media?${params.toString()}`, { method: 'POST' });
  const data = await res.json();
  if (!res.ok) throw new Error(`Errore creazione container: ${JSON.stringify(data)}`);
  console.log('Container creato:', data.id);
  return data.id;
}

async function waitUntilContainerReady(containerId, { timeoutMs = 60000, intervalMs = 3000 } = {}) {
  const params = new URLSearchParams({ fields: 'status_code', access_token: ACCESS_TOKEN });
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${BASE_URL}/${containerId}?${params.toString()}`);
    const data = await res.json();

    if (data.status_code === 'FINISHED') return true;
    if (data.status_code === 'ERROR') throw new Error(`Elaborazione fallita: ${JSON.stringify(data)}`);

    console.log(`Stato: ${data.status_code || 'IN_PROGRESS'}, attendo...`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('Timeout in attesa dell\'elaborazione del media.');
}

async function publishContainer(containerId) {
  const params = new URLSearchParams({ creation_id: containerId, access_token: ACCESS_TOKEN });
  const res = await fetch(`${BASE_URL}/${ACCOUNT_ID}/media_publish?${params.toString()}`, { method: 'POST' });
  const data = await res.json();
  if (!res.ok) throw new Error(`Errore pubblicazione: ${JSON.stringify(data)}`);
  console.log('Pubblicato. Media ID:', data.id);
  return data.id;
}

/** Sposta il file da queue/ a published/ col nome data-progressivo. Ritorna il nuovo nome. */
function archiveFromQueue(fileName) {
  if (!fs.existsSync(PUBLISHED_DIR)) fs.mkdirSync(PUBLISHED_DIR, { recursive: true });

  const date = todayString();
  const newName = `${date}-${nextDailyIndex(date)}${path.extname(fileName)}`;
  fs.renameSync(path.join(QUEUE_DIR, fileName), path.join(PUBLISHED_DIR, newName));
  console.log(`Rinominata e archiviata come: ${newName}`);
  return newName;
}

function commitAndPush() {
  execSync('git config user.name "ig-publisher-bot"');
  execSync('git config user.email "actions@github.com"');
  execSync(`git add ${QUEUE_DIR} ${PUBLISHED_DIR} ${LAST_FILE}`);
  execSync('git commit -m "Pubblicazione automatica" || echo "Nulla da committare"');
  execSync('git pull --rebase');
  execSync('git push');
}

async function main() {
  const mode = process.argv[2] || 'story';
  if (!['post', 'story'].includes(mode)) {
    console.error('Uso: node publish.js post|story');
    process.exit(1);
  }

  const selection = selectImage();
  if (!selection) {
    console.log('Nessuna immagine disponibile né in queue né in published. Esco.');
    await sendMessage('⚠️ Nessuna immagine da pubblicare: coda e archivio vuoti. Mandami qualche foto!');
    return;
  }

  const { fileName, dir, isFromQueue } = selection;
  const imageUrl = buildRawUrl(dir, fileName);
  const label = mode === 'story' ? 'Storia' : 'Post';

  console.log(`Pubblico "${fileName}" come ${mode} da URL: ${imageUrl}`);

  const containerId = await createMediaContainer({
    imageUrl,
    mediaType: mode === 'story' ? 'STORIES' : 'IMAGE',
  });
  await waitUntilContainerReady(containerId);
  await publishContainer(containerId);

  let finalName = fileName;
  let finalPath = path.join(dir, fileName);
  if (isFromQueue) {
    finalName = archiveFromQueue(fileName);
    finalPath = path.join(PUBLISHED_DIR, finalName);
  }
  fs.writeFileSync(LAST_FILE, finalName);
  commitAndPush();

  const remaining = listImages(QUEUE_DIR).length;
  const source = isFromQueue ? '🆕 dalla coda' : '♻️ riciclata dall\'archivio';
  await sendPhotoFile(
    finalPath,
    `✅ ${label} pubblicata!\n📁 ${finalName}${isFromQueue && finalName !== fileName ? ` (era ${fileName})` : ''}\n${source}\n🗂 In coda: ${remaining}${remaining === 0 ? ' — mandami nuove foto!' : ''}`
  );

  console.log('Fatto.');
}

main().catch(async (err) => {
  console.error('Fallito:', err.message);
  await sendMessage(`❌ Pubblicazione fallita: ${err.message.slice(0, 400)}`);
  process.exit(1);
});
