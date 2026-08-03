/**
 * publish-post.js
 * Pubblica su Instagram i post carosello in coda (queue-posts/) il cui
 * publish_at è scaduto. CATCH-UP IDEMPOTENTE: i cron di GitHub vengono
 * spesso droppati, quindi ogni run guarda lo stato della coda (i pubblicati
 * vengono SPOSTATI in published-posts/, quindi non si ripubblicano) e
 * recupera tutti gli slot arretrati in ordine cronologico.
 *
 * Meccanica API (carosello): container figli con is_carousel_item=true
 * → container CAROUSEL con children + caption → media_publish.
 * 1 sola immagine → post singolo (IMAGE).
 *
 * Uso: node publish-post.js
 * Env richieste: IG_ACCESS_TOKEN, IG_ACCOUNT_ID, GITHUB_REPOSITORY
 *                TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (opzionali)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { sendMessage, sendPhotoFile, sendDocumentFile, sendMediaGroup } = require('./telegram');
const {
  POST_QUEUE_DIR,
  POST_PUBLISHED_DIR,
  listQueuedPosts,
  buildCaption,
  formatWhen,
} = require('./post-utils');

// Post consegnati a mano: escono dalla coda ma non sono pubblicati dall'API.
const HANDOFF_DIR = 'consegnati-posts';

const GRAPH_API_VERSION = 'v21.0';
const BASE_URL = `https://graph.instagram.com/${GRAPH_API_VERSION}`;

const ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN;
const ACCOUNT_ID = process.env.IG_ACCOUNT_ID;
const REPO = process.env.GITHUB_REPOSITORY;

if (!ACCESS_TOKEN || !ACCOUNT_ID) {
  console.error('Errore: imposta IG_ACCESS_TOKEN e IG_ACCOUNT_ID come secrets.');
  process.exit(1);
}

function buildRawUrl(dir, fileName) {
  const branch = process.env.GITHUB_REF_NAME || 'main';
  const parts = `${dir}/${fileName}`.split('/').map(encodeURIComponent).join('/');
  return `https://raw.githubusercontent.com/${REPO}/${branch}/${parts}`;
}

async function apiPost(endpoint, params) {
  params.set('access_token', ACCESS_TOKEN);
  const res = await fetch(`${BASE_URL}/${endpoint}?${params.toString()}`, { method: 'POST' });
  const data = await res.json();
  if (!res.ok) throw new Error(`Errore API ${endpoint}: ${JSON.stringify(data)}`);
  return data;
}

async function waitUntilContainerReady(containerId, { timeoutMs = 120000, intervalMs = 3000 } = {}) {
  const params = new URLSearchParams({ fields: 'status_code', access_token: ACCESS_TOKEN });
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${BASE_URL}/${containerId}?${params.toString()}`);
    const data = await res.json();
    if (data.status_code === 'FINISHED') return;
    if (data.status_code === 'ERROR') throw new Error(`Elaborazione fallita: ${JSON.stringify(data)}`);
    console.log(`Container ${containerId}: ${data.status_code || 'IN_PROGRESS'}, attendo...`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('Timeout in attesa dell\'elaborazione del media.');
}

/** Pubblica un post (carosello o singolo). Ritorna il media ID. */
async function publishPost(post) {
  const caption = buildCaption(post.meta);
  const altTexts = Array.isArray(post.meta.alt_text) ? post.meta.alt_text : [];

  if (post.images.length === 1) {
    const params = new URLSearchParams({ image_url: buildRawUrl(post.dir, post.images[0]), caption });
    if (altTexts[0]) params.set('alt_text', String(altTexts[0]).slice(0, 1000));
    const container = await apiPost(`${ACCOUNT_ID}/media`, params);
    await waitUntilContainerReady(container.id);
    const pub = await apiPost(`${ACCOUNT_ID}/media_publish`, new URLSearchParams({ creation_id: container.id }));
    return pub.id;
  }

  // Figli del carosello (con alt_text: supportato anche per i figli)
  const children = [];
  for (let i = 0; i < post.images.length; i++) {
    const params = new URLSearchParams({
      image_url: buildRawUrl(post.dir, post.images[i]),
      is_carousel_item: 'true',
    });
    if (altTexts[i]) params.set('alt_text', String(altTexts[i]).slice(0, 1000));
    const child = await apiPost(`${ACCOUNT_ID}/media`, params);
    console.log(`Slide ${i + 1}/${post.images.length}: container ${child.id}`);
    children.push(child.id);
  }
  for (const id of children) await waitUntilContainerReady(id);

  const parent = await apiPost(`${ACCOUNT_ID}/media`, new URLSearchParams({
    media_type: 'CAROUSEL',
    children: children.join(','),
    caption,
  }));
  await waitUntilContainerReady(parent.id);
  const pub = await apiPost(`${ACCOUNT_ID}/media_publish`, new URLSearchParams({ creation_id: parent.id }));
  return pub.id;
}

/**
 * Consegna a mano: invece di pubblicare, manda il pacchetto pronto in chat.
 * Serve quando il post deve avere la MUSICA: l'API di Instagram non espone
 * nessun parametro audio per i caroselli (verificato sui doc Meta) e non
 * permette di creare bozze, quindi l'ultimo passo lo fa l'utente dall'app.
 *
 * Le slide partono come DOCUMENTI: sono gia' normalizzate a 1440px e una
 * ricompressione di Telegram vanificherebbe la normalizzazione.
 * La caption viaggia in un messaggio SEPARATO e senza altro testo attorno,
 * cosi' un tocco lungo la copia per intero.
 */
async function handoffPost(post, caption) {
  const files = post.images.map((f) => path.join(post.dir, f));
  const intestazione =
    `\u23F0 E' l'ora: ${post.dirName}\n` +
    `${post.images.length} slide, in ordine. Caption nel messaggio dopo.`;

  // Telegram accetta album da 2 a 10 elementi: con una slide sola serve
  // sendDocumentFile, altrimenti l'invio fallisce e il post resta incastrato.
  const inviato = files.length === 1
    ? Boolean(await sendDocumentFile(files[0], intestazione))
    : await sendMediaGroup(files, intestazione);
  if (!inviato) throw new Error('invio a Telegram fallito');

  // Messaggio separato: solo la caption, niente intestazioni da ripulire.
  await sendMessage(caption);

  fs.mkdirSync(HANDOFF_DIR, { recursive: true });
  const meta = { ...post.meta, handoff_at: new Date().toISOString() };
  fs.writeFileSync(path.join(post.dir, 'meta.json'), JSON.stringify(meta, null, 2));
  const dest = path.join(HANDOFF_DIR, post.dirName);
  fs.renameSync(post.dir, dest);

  await sendMessage(
    `\u{1F4F2} Pacchetto consegnato: ${post.dirName}\n` +
    `Salva le ${post.images.length} slide, aprile su Instagram nell'ordine, ` +
    `incolla la caption qui sopra e scegli la musica.\n` +
    `\u2139\uFE0F Non lo pubblico io: era marcato "manuale".`
  );
  return dest;
}

/** Sposta la cartella del post in published-posts/ e annota l'esito nel meta. */
function archivePost(post, mediaId) {
  fs.mkdirSync(POST_PUBLISHED_DIR, { recursive: true });
  const meta = { ...post.meta, published_at: new Date().toISOString(), media_id: mediaId };
  fs.writeFileSync(path.join(post.dir, 'meta.json'), JSON.stringify(meta, null, 2));
  const dest = path.join(POST_PUBLISHED_DIR, post.dirName);
  fs.renameSync(post.dir, dest);
  return dest;
}

/**
 * `git add -A -- <dir>` esce con "fatal: pathspec ... did not match any files"
 * se la cartella non esiste, e l'eccezione fermerebbe commitAndPush DOPO che il
 * post e' gia' uscito su Instagram: niente push, la coda resta invariata e alla
 * run successiva il post viene ripubblicato. Le creo tutte prima (git ignora le
 * cartelle vuote, quindi non sporca il repo).
 */
function ensureWorkDirs() {
  for (const d of [POST_QUEUE_DIR, POST_PUBLISHED_DIR, HANDOFF_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

function commitAndPush(msg) {
  execSync('git config user.name "ig-publisher-bot"');
  execSync('git config user.email "actions@github.com"');
  ensureWorkDirs();
  execSync(`git add -A -- ${POST_QUEUE_DIR} ${POST_PUBLISHED_DIR} ${HANDOFF_DIR}`);
  execSync(`git commit -m "${msg}" || echo "Nulla da committare"`);
  execSync('git pull --rebase');
  execSync('git push');
}

async function main() {
  const now = new Date();
  const queued = listQueuedPosts();
  const due = queued.filter((p) => {
    const t = new Date(p.meta.publish_at || 0).getTime();
    return !isNaN(t) && t > 0 && t <= now.getTime();
  });

  if (due.length === 0) {
    console.log(`Nessun post dovuto (in coda: ${queued.length}).`);
    return;
  }
  console.log(`Post dovuti: ${due.length} (catch-up incluso).`);

  for (const post of due) {
    const caption = buildCaption(post.meta);
    try {
      if (post.meta.manuale === true) {
        try {
          await handoffPost(post, caption);
          commitAndPush(`Post consegnato a mano: ${post.dirName}`);
          console.log(`Consegnato (manuale) ${post.dirName}`);
        } catch (errH) {
          // Non blocca la coda: un problema di consegna e' locale a questo post,
          // gli automatici successivi devono comunque uscire.
          console.error(`Consegna di ${post.dirName} fallita:`, errH.message);
          await sendMessage(
            `\u26A0\uFE0F Post manuale "${post.dirName}" non consegnato: ${String(errH.message).slice(0, 300)}\n` +
            `Resta in coda e riprovo alla prossima run. Per fermarlo: /annulla, ` +
            `oppure /manuale <n> off per pubblicarlo in automatico.`);
        }
        continue;
      }
      const mediaId = await publishPost(post);
      const dest = archivePost(post, mediaId);
      // Commit SUBITO dopo ogni post: se la run muore, il pubblicato è già archiviato
      commitAndPush(`Post pubblicato: ${post.dirName}`);
      const remaining = listQueuedPosts();
      const next = remaining[0];
      await sendPhotoFile(
        path.join(dest, post.images[0]),
        `✅ Post pubblicato! (${post.images.length} slide)\n` +
        `🗓 Slot: ${formatWhen(post.meta.publish_at)}\n` +
        `📝 ${caption.slice(0, 400)}${caption.length > 400 ? '…' : ''}\n` +
        `🗂 Post in coda: ${remaining.length}` +
        (next ? `\n⏭ Prossimo: ${formatWhen(next.meta.publish_at)}` : '')
      );
      console.log(`Pubblicato ${post.dirName} → media ${mediaId}`);
    } catch (err) {
      console.error(`Pubblicazione di ${post.dirName} fallita:`, err.message);
      await sendMessage(`❌ Post "${post.dirName}" ${post.meta.manuale === true ? 'non consegnato' : 'non pubblicato'}: ${err.message.slice(0, 400)}\nResta in coda, riprovo alla prossima run. /coda per lo stato.`);
      // Non si blocca la coda: si prova comunque coi successivi? NO: in ordine
      // cronologico, se fallisce il primo è quasi sempre un problema globale
      // (token, rete) — meglio fermarsi e riprovare alla prossima run.
      process.exit(1);
    }
  }
  console.log('Fatto.');
}

// Esegue solo se lanciato direttamente: cosi' il modulo si puo' importare nei
// test senza far partire una pubblicazione vera.
if (require.main === module) {
  main().catch(async (err) => {
    console.error('Fallito:', err.message);
    await sendMessage(`❌ Pubblicazione post fallita: ${err.message.slice(0, 400)}`);
    process.exit(1);
  });
}

module.exports = { __test: { handoffPost, archivePost, ensureWorkDirs, HANDOFF_DIR } };
