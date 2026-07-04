/**
 * publish-queue.js
 * Prende un'immagine CASUALE dalla cartella queue/, la pubblica su Instagram
 * (senza caption), poi la rinomina con data + numero progressivo del giorno
 * e la sposta in published/. Se la coda è vuota, ripesca a caso da published/
 * (riciclo) senza spostarla di nuovo.
 *
 * Uso: node publish-queue.js post
 *      node publish-queue.js story
 *
 * Variabili d'ambiente richieste:
 *   IG_ACCESS_TOKEN
 *   IG_ACCOUNT_ID
 *   GITHUB_REPOSITORY   (fornita automaticamente da GitHub Actions)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const GRAPH_API_VERSION = 'v21.0';
const BASE_URL = `https://graph.instagram.com/${GRAPH_API_VERSION}`;

const ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN;
const ACCOUNT_ID = process.env.IG_ACCOUNT_ID;
const REPO = process.env.GITHUB_REPOSITORY;

const QUEUE_DIR = 'queue';
const PUBLISHED_DIR = 'published';
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
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function nextDailyIndex(date) {
  const existing = listImages(PUBLISHED_DIR).filter((f) => f.startsWith(`${date}-`));
  return existing.length + 1;
}

/**
 * Sceglie l'immagine da pubblicare.
 * Ritorna { fileName, dir, isFromQueue }
 */
function selectImage() {
  const queueImages = listImages(QUEUE_DIR);
  if (queueImages.length > 0) {
    return { fileName: pickRandom(queueImages), dir: QUEUE_DIR, isFromQueue: true };
  }

  console.log('Coda vuota: ripesco a caso dalle immagini già pubblicate.');
  const publishedImages = listImages(PUBLISHED_DIR);
  if (publishedImages.length > 0) {
    return { fileName: pickRandom(publishedImages), dir: PUBLISHED_DIR, isFromQueue: false };
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

function archiveFromQueue(fileName) {
  if (!fs.existsSync(PUBLISHED_DIR)) fs.mkdirSync(PUBLISHED_DIR, { recursive: true });

  const date = todayString();
  const index = nextDailyIndex(date);
  const ext = path.extname(fileName);
  const newName = `${date}-${index}${ext}`;

  fs.renameSync(path.join(QUEUE_DIR, fileName), path.join(PUBLISHED_DIR, newName));
  console.log(`Rinominata e archiviata come: ${newName}`);
}

function commitAndPush() {
  execSync('git config user.name "ig-publisher-bot"');
  execSync('git config user.email "actions@github.com"');
  execSync('git add queue published');
  execSync('git commit -m "Pubblicazione automatica" || echo "Nulla da committare"');
  execSync('git push');
}

async function main() {
  const mode = process.argv[2] || 'post';
  if (!['post', 'story'].includes(mode)) {
    console.error('Uso: node publish-queue.js post|story');
    process.exit(1);
  }

  const selection = selectImage();
  if (!selection) {
    console.log('Nessuna immagine disponibile né in queue né in published. Esco.');
    return;
  }

  const { fileName, dir, isFromQueue } = selection;
  const imageUrl = buildRawUrl(dir, fileName);

  console.log(`Pubblico "${fileName}" come ${mode} da URL: ${imageUrl}`);

  const containerId = await createMediaContainer({
    imageUrl,
    mediaType: mode === 'story' ? 'STORIES' : 'IMAGE',
  });
  await waitUntilContainerReady(containerId);
  await publishContainer(containerId);

  if (isFromQueue) {
    archiveFromQueue(fileName);
    commitAndPush();
  } else {
    console.log('Immagine riciclata da published/, nessuno spostamento necessario.');
  }

  console.log('Fatto.');
}

main().catch((err) => {
  console.error('Fallito:', err.message);
  process.exit(1);
});
