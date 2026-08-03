/**
 * test-zip.js — collaudo OFFLINE del pacchetto su richiesta (/zip).
 *   node test-zip.js
 * Non tocca rete ne' Telegram: stubba i moduli e verifica cosa finisce
 * davvero dentro lo zip, come si chiama e che la coda resti intatta.
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

// Serve zip/unzip: in CI (ubuntu) ci sono sempre, in locale non e' detto.
try {
  execSync('zip -h', { stdio: 'ignore' });
  execSync('unzip -h', { stdio: 'ignore' });
} catch (e) {
  console.log('SALTATO: zip/unzip non disponibili qui (in CI ubuntu ci sono).');
  process.exit(0);
}

// ---- stub di ./telegram e ./igdl: registrano invece di mandare ----
const inviati = { documenti: [], messaggi: [] };
const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === './telegram') {
    return {
      sendMessage: async (t) => { inviati.messaggi.push(t); },
      sendPhotoFile: async () => {},
      // Copio il file: la temp viene cancellata nel finally, e voglio
      // ispezionare lo zip DAVVERO inviato, non una temp gia' sparita.
      sendDocumentFile: async (f, cap) => {
        const copia = path.join(bagaglio, path.basename(f));
        fs.copyFileSync(f, copia);
        inviati.documenti.push({ nome: path.basename(f), path: copia, caption: cap });
        return 'file_id_finto';
      },
      answerCallback: async () => {},
      editMessage: async () => {},
    };
  }
  return orig.apply(this, arguments);
};

process.env.TELEGRAM_BOT_TOKEN = 'x';
process.env.TELEGRAM_CHAT_ID = 'y';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-'));
const bagaglio = fs.mkdtempSync(path.join(os.tmpdir(), 'out-'));
process.chdir(tmp);

const dirName = '2026-08-08-1730-persona-3';
const postDir = path.join(tmp, 'queue-posts', dirName);
fs.mkdirSync(postDir, { recursive: true });
const images = ['01.jpg', '02.jpg', '03.jpg', '04.jpg'];
images.forEach((f) => fs.writeFileSync(path.join(postDir, f), Buffer.alloc(4096, 7)));
const meta = {
  caption: 'Persona 3 non era un gioco sul combattere.',
  tags: ['y2k', 'persona3'],
  publish_at: '2026-08-08T17:30:00Z',
  manuale: true,
};
fs.writeFileSync(path.join(postDir, 'meta.json'), JSON.stringify(meta));

const imp = require('./import-from-telegram.js');
const { buildCaption } = require('./post-utils');

(async () => {
  console.log('inviaZipPost — contenuto e nome del pacchetto');
  const post = { dir: postDir, dirName, images, meta };
  const ok = await imp.__test.inviaZipPost(post);
  eq(ok, true, 'la consegna va a buon fine');
  eq(inviati.documenti.length, 1, 'un solo documento inviato');

  const doc = inviati.documenti[0];
  eq(doc.nome, `${dirName}.zip`, 'lo zip si chiama come lo slot (data di uscita nel nome)');

  const estratto = path.join(bagaglio, 'estratto');
  fs.mkdirSync(estratto, { recursive: true });
  execSync(`unzip -j -o -qq "${doc.path}" -d "${estratto}"`);
  const dentro = fs.readdirSync(estratto).sort();
  eq(dentro, ['01-copertina.jpg', '02-pag1.jpg', '03-pag2.jpg', '04-pag3.jpg', 'caption.txt'],
     'dentro: caption.txt + copertina e pagine numerate');

  // L'ordine alfabetico dei file DEVE essere l'ordine del carosello: e' cosi'
  // che l'app di Instagram le prende quando le selezioni tutte insieme.
  const soloImg = dentro.filter((f) => f.endsWith('.jpg'));
  eq(soloImg, soloImg.slice().sort(), 'ordine alfabetico = ordine del carosello');

  const txt = fs.readFileSync(path.join(estratto, 'caption.txt'), 'utf8');
  eq(txt, buildCaption(meta), 'caption.txt contiene la caption completa (tag inclusi)');
  eq(inviati.messaggi[inviati.messaggi.length - 1], buildCaption(meta),
     'la caption arriva anche in un messaggio separato e pulito');

  console.log('\nla coda non viene toccata');
  eq(fs.existsSync(postDir), true, 'il post resta in coda');
  eq(fs.readdirSync(postDir).sort(), ['01.jpg', '02.jpg', '03.jpg', '04.jpg', 'meta.json'],
     'file originali intatti, niente rinomine sul posto');
  const m = JSON.parse(fs.readFileSync(path.join(postDir, 'meta.json'), 'utf8'));
  eq(m.publish_at, meta.publish_at, 'lo slot non cambia');

  console.log('\nripetibile');
  const ok2 = await imp.__test.inviaZipPost(post);
  eq(ok2, true, 'si puo' + "' " + 'richiedere di nuovo');
  eq(inviati.documenti.length, 2, 'secondo pacchetto inviato');
  eq(fs.existsSync(postDir), true, 'e il post e ancora in coda');

  console.log('\nfindPost — riferimento per numero o nome');
  const coda = [{ dirName, dir: postDir, images, meta }];
  eq(imp.__test.findPost('1', coda).post.dirName, dirName, 'per numero');
  eq(imp.__test.findPost('persona-3', coda).post.dirName, dirName, 'per pezzo di nome');
  eq(Boolean(imp.__test.findPost('99', coda).error), true, 'numero fuori range → errore');

  process.chdir(os.tmpdir());
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(bagaglio, { recursive: true, force: true });
  if (failed) { console.log(`\n${failed} casi FALLITI`); process.exit(1); }
  console.log('\nTutti i casi passano.');
})().catch((e) => { console.log('ERRORE:', e.stack); process.exit(1); });
