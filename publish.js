/**
 * publish.js
 * Pubblica post o storie su Instagram usando l'API ufficiale Meta
 * "Instagram API with Instagram Login" (Content Publishing API).
 * Nessuno scraping, nessuna simulazione di login: solo chiamate REST
 * autenticate con access token — zero rischio di ban.
 *
 * Requisiti:
 * - Account Instagram Business o Creator
 * - App Meta creata su developers.facebook.com con prodotto "Instagram" collegato
 * - Access token con i permessi instagram_business_basic + instagram_business_content_publish
 * - Instagram User ID (mostrato nel dashboard dopo aver collegato l'account)
 * - Il media (immagine/video) deve trovarsi su un URL pubblico HTTPS
 *
 * Uso:
 *   node publish.js post  <image_url> "<caption>"
 *   node publish.js story <image_url>
 *
 * Variabili d'ambiente richieste:
 *   IG_ACCESS_TOKEN
 *   IG_ACCOUNT_ID   (Instagram User ID)
 */

const GRAPH_API_VERSION = 'v21.0';
const BASE_URL = `https://graph.instagram.com/${GRAPH_API_VERSION}`;

const ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN;
const ACCOUNT_ID = process.env.IG_ACCOUNT_ID;

if (!ACCESS_TOKEN || !ACCOUNT_ID) {
  console.error('Errore: imposta IG_ACCESS_TOKEN e IG_ACCOUNT_ID come variabili d\'ambiente (o secrets).');
  process.exit(1);
}

/**
 * Step 1: crea un media container.
 * mediaType: 'IMAGE' (post) oppure 'STORIES' (storia)
 */
async function createMediaContainer({ imageUrl, caption, mediaType }) {
  const params = new URLSearchParams({
    image_url: imageUrl,
    access_token: ACCESS_TOKEN,
  });

  if (mediaType === 'STORIES') {
    params.set('media_type', 'STORIES');
  } else if (caption) {
    params.set('caption', caption);
  }

  const res = await fetch(`${BASE_URL}/${ACCOUNT_ID}/media?${params.toString()}`, {
    method: 'POST',
  });
  const data = await res.json();

  if (!res.ok) {
    throw new Error(`Errore creazione container: ${JSON.stringify(data)}`);
  }

  console.log('Container creato:', data.id);
  return data.id;
}

/**
 * Step 2: verifica lo stato di elaborazione del container.
 * Instagram deve processare il media prima di poterlo pubblicare.
 */
async function waitUntilContainerReady(containerId, { timeoutMs = 60000, intervalMs = 3000 } = {}) {
  const params = new URLSearchParams({
    fields: 'status_code',
    access_token: ACCESS_TOKEN,
  });

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${BASE_URL}/${containerId}?${params.toString()}`);
    const data = await res.json();

    if (data.status_code === 'FINISHED') {
      return true;
    }
    if (data.status_code === 'ERROR') {
      throw new Error(`Elaborazione del media fallita: ${JSON.stringify(data)}`);
    }

    console.log(`Stato container: ${data.status_code || 'IN_PROGRESS'}, attendo...`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new Error('Timeout in attesa dell\'elaborazione del media.');
}

/**
 * Step 3: pubblica il container.
 */
async function publishContainer(containerId) {
  const params = new URLSearchParams({
    creation_id: containerId,
    access_token: ACCESS_TOKEN,
  });

  const res = await fetch(`${BASE_URL}/${ACCOUNT_ID}/media_publish?${params.toString()}`, {
    method: 'POST',
  });
  const data = await res.json();

  if (!res.ok) {
    throw new Error(`Errore pubblicazione: ${JSON.stringify(data)}`);
  }

  console.log('Pubblicato con successo. Media ID:', data.id);
  return data.id;
}

async function publish({ imageUrl, caption, mediaType }) {
  const containerId = await createMediaContainer({ imageUrl, caption, mediaType });
  await waitUntilContainerReady(containerId);
  return publishContainer(containerId);
}

async function main() {
  const [, , mode, imageUrl, caption] = process.argv;

  if (!mode || !imageUrl || !['post', 'story'].includes(mode)) {
    console.error('Uso: node publish.js post|story <image_url> ["caption"]');
    process.exit(1);
  }

  try {
    if (mode === 'post') {
      await publish({ imageUrl, caption, mediaType: 'IMAGE' });
    } else {
      await publish({ imageUrl, mediaType: 'STORIES' });
    }
  } catch (err) {
    console.error('Fallito:', err.message);
    process.exit(1);
  }
}

main();
