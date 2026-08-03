/**
 * test-manuale.js — collaudo OFFLINE della consegna manuale.
 *   node test-manuale.js
 * Non tocca rete ne' Telegram: stubba i moduli e verifica la logica di
 * biforcazione, la validazione del campo e il non-doppio-invio.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { execSync } = require('child_process');

let failed = 0;
function eq(a, e, label) {
  const A = JSON.stringify(a);
  const E = JSON.stringify(e);
  if (A === E) { console.log(`  ok   ${label}`); return; }
  failed++;
  console.log(`  FAIL ${label}\n       atteso ${E}\n       avuto  ${A}`);
}

// ---- stub di ./telegram: registra le chiamate invece di mandarle ----
const inviati = { album: [], documenti: [], messaggi: [] };
const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === './telegram') {
    return {
      sendMessage: async (t) => { inviati.messaggi.push(t); },
      sendPhotoFile: async () => {},
      sendDocumentFile: async (f) => { inviati.documenti.push(f); return { ok: true }; },
      // Telegram rifiuta gli album fuori dal range 2-10: lo stub fa lo stesso,
      // altrimenti il test non vedrebbe mai il bug che sto verificando.
      sendMediaGroup: async (f) => {
        if (f.length < 2 || f.length > 10) return false;
        inviati.album.push(f.slice());
        return true;
      },
      answerCallback: async () => {},
      editMessage: async () => {},
    };
  }
  return orig.apply(this, arguments);
};

console.log('validatePost — campo manuale');
const { validatePost } = require('./post-utils');
const base = { caption: 'Una caption valida per il test.' };
eq(validatePost({ ...base }, 3), [], 'senza campo manuale → nessun errore');
eq(validatePost({ ...base, manuale: true }, 3), [], 'manuale: true → valido');
eq(validatePost({ ...base, manuale: false }, 3), [], 'manuale: false → valido');
eq(validatePost({ ...base, manuale: 'si' }, 3),
   ['"manuale" deve essere true o false'], 'manuale: "si" → errore');
eq(validatePost({ ...base, manuale: 1 }, 3),
   ['"manuale" deve essere true o false'], 'manuale: 1 → errore');

console.log('\nhandoffPost — consegna e archiviazione');
// finto post in una temp, con la struttura che si aspetta publish-post.js
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'man-'));
process.chdir(tmp);

function fintoPost(dirName, images, extraMeta = {}) {
  const postDir = path.join(tmp, 'queue-posts', dirName);
  fs.mkdirSync(postDir, { recursive: true });
  images.forEach((f) => fs.writeFileSync(path.join(postDir, f), Buffer.alloc(2048, 1)));
  const meta = {
    caption: 'Caption di prova', manuale: true,
    publish_at: '2026-08-05T17:30:00Z', ...extraMeta,
  };
  fs.writeFileSync(path.join(postDir, 'meta.json'), JSON.stringify(meta));
  return { dir: postDir, dirName, images, meta };
}

const images = ['01.jpg', '02.jpg', '03.jpg'];
const post = fintoPost('2026-08-05-1730-prova', images);

process.env.IG_ACCESS_TOKEN = 'x';
process.env.IG_ACCOUNT_ID = 'y';
const pp = require('./publish-post.js');

(async () => {
  const dest = await pp.__test.handoffPost(post, 'Caption di prova');

  eq(inviati.album.length, 1, 'un solo album inviato');
  eq(inviati.album[0].length, 3, 'album con tutte e 3 le slide');
  eq(inviati.album[0].map((f) => path.basename(f)), images, 'slide in ordine 01,02,03');
  eq(inviati.messaggi[0], 'Caption di prova', 'la caption e in un messaggio SEPARATO e pulito');
  eq(fs.existsSync(post.dir), false, 'il post esce dalla coda');
  eq(fs.existsSync(dest), true, 'il post finisce nei consegnati');
  eq(path.basename(path.dirname(dest)), 'consegnati-posts', 'cartella consegnati-posts');
  const m = JSON.parse(fs.readFileSync(path.join(dest, 'meta.json'), 'utf8'));
  eq(Boolean(m.handoff_at), true, 'meta.json annota handoff_at');
  eq(Boolean(m.published_at), false, 'NON risulta pubblicato');

  // ---- REGRESSIONE: post da 1 slide sola ----
  // sendMediaGroup accetta 2-10 elementi. Con una slide sola l'invio falliva,
  // handoffPost lanciava, il post restava in coda e — visto che i post si
  // processano in ordine cronologico e il loop usciva al primo errore —
  // bloccava per sempre anche tutti i post successivi.
  console.log('\nhandoffPost — post da 1 sola slide (regressione)');
  inviati.album.length = 0; inviati.documenti.length = 0; inviati.messaggi.length = 0;
  const solo = fintoPost('2026-08-06-1730-singolo', ['01.jpg']);
  const destSolo = await pp.__test.handoffPost(solo, 'Caption singola');
  eq(inviati.album.length, 0, 'nessun album (fuori range 2-10)');
  eq(inviati.documenti.length, 1, 'la slide parte come documento singolo');
  eq(path.basename(inviati.documenti[0]), '01.jpg', 'e la slide giusta');
  eq(inviati.messaggi[0], 'Caption singola', 'caption comunque in messaggio separato');
  eq(fs.existsSync(destSolo), true, 'anche il post da 1 slide viene consegnato');

  // ---- REGRESSIONE: git add su cartelle mancanti ----
  // `git add -A -- a b c` esce 128 se una delle tre non esiste. Dentro
  // commitAndPush quell'eccezione arrivava DOPO la pubblicazione su Instagram:
  // niente push, coda invariata, post ripubblicato alla run dopo.
  console.log('\nensureWorkDirs — git add non deve fallire (regressione)');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'git-'));
  process.chdir(repo);
  execSync('git init -q');
  eq(fs.existsSync(path.join(repo, 'consegnati-posts')), false, 'parto senza consegnati-posts');
  pp.__test.ensureWorkDirs();
  let addOk = true;
  try {
    execSync('git add -A -- queue-posts published-posts consegnati-posts', { stdio: 'pipe' });
  } catch (e) { addOk = false; }
  eq(addOk, true, 'git add passa anche se le cartelle non c\'erano');

  process.chdir(os.tmpdir());
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
  if (failed) { console.log(`\n${failed} casi FALLITI`); process.exit(1); }
  console.log('\nTutti i casi passano.');
})().catch((e) => { console.log('ERRORE:', e.message); process.exit(1); });
