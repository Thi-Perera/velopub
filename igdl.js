/**
 * igdl.js — repost da Instagram alla coda storie.
 *
 * Flusso: link IG in chat → il bot chiede con 4 bottoni cosa salvare →
 * al tocco (callback_query, run successiva) igdl-fetch.py risolve il post →
 * le foto si scaricano dal CDN a risoluzione massima e si convertono in JPEG
 * → queue/ (storie). Il feedback avviene modificando il messaggio-domanda:
 * ✅ con conteggio o ❌ con il motivo.
 *
 * La risoluzione passa dalla via PUBBLICA (`media_info_gql`, nessuna
 * autenticazione): la sessione instagrapi serve solo come riserva e per la
 * bio. Prima era obbligatoria, e quando è scaduta la feature si è fermata
 * del tutto — vedi l'intestazione di igdl-fetch.py.
 *
 * Nessuno stato su file: il callback_data porta shortcode e scelta
 * (max 64 byte, "ig:<code>:<scelta>" ci sta sempre).
 */

const fs = require('fs');
const { execFileSync } = require('child_process');

// python3 sui runner CI; in locale (Windows) si può forzare con IGDL_PYTHON=python
const PYTHON = process.env.IGDL_PYTHON || 'python3';

const IG_URL_RE = /instagram\.com\/(?:[A-Za-z0-9_.]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]{5,})/;

const CHOICES = {
  a:  { label: 'Tutte',             desc: 'tutte le foto' },
  sf: { label: 'Tranne la 1ª',      desc: 'tutte tranne la prima' },
  sl: { label: "Tranne l'ultima",   desc: "tutte tranne l'ultima" },
  sb: { label: 'Senza 1ª e ultima', desc: 'senza la prima e l’ultima' },
};

/** Estrae lo shortcode dal primo link Instagram nel testo, o null. */
function parseIgLink(text) {
  const m = String(text || '').match(IG_URL_RE);
  return m ? m[1] : null;
}

/** Tastiera inline con le 4 scelte per uno shortcode. */
function keyboardFor(code) {
  return {
    inline_keyboard: [
      [{ text: CHOICES.a.label,  callback_data: `ig:${code}:a` },
       { text: CHOICES.sf.label, callback_data: `ig:${code}:sf` }],
      [{ text: CHOICES.sl.label, callback_data: `ig:${code}:sl` },
       { text: CHOICES.sb.label, callback_data: `ig:${code}:sb` }],
    ],
  };
}

/**
 * Risolve il post via igdl-fetch.py. Lo script esce sempre 0 e stampa una
 * riga JSON ({ok:true,…} o {ok:false,error}). instagrapi viene installato
 * da uno step dedicato del workflow, pinnato e SENZA secret in ambiente
 * (supply-chain: pip esegue codice di build di terze parti); qui nessun
 * pip install, mai.
 */
function fetchMediaInfo(code, wantBio = false) {
  const args = ['igdl-fetch.py', code];
  if (wantBio) args.push('--bio');   // costa una chiamata IG in più: solo per le bozze
  return JSON.parse(
    execFileSync(PYTHON, args, { encoding: 'utf8', timeout: 120000 })
      .trim().split('\n').pop()
  );
}

/**
 * Flag inline accanto al link.
 *   -f        toglie la prima foto
 *   -b        toglie l'ultima
 *   -f -b     (anche -fb / -bf) entrambe
 *   -repost   destinazione ARCHIVIO: zip in repost-material/ con caption+bio,
 *             invece delle foto sciolte nella coda storie
 * Solo link = tutte le foto in coda storie. Qualunque altro token → null:
 * il bot chiede coi bottoni invece di tirare a indovinare.
 * Ritorna { choice, repost } oppure null.
 */
function parseIgFlags(text) {
  const toks = String(text || '').trim().split(/\s+/).filter(Boolean)
    .filter((t) => !/instagram\.com\//.test(t));
  let f = false;
  let b = false;
  let repost = false;
  for (const t of toks) {
    if (t === '-f') f = true;
    else if (t === '-b') b = true;
    else if (t === '-fb' || t === '-bf') { f = true; b = true; }
    else if (t === '-repost') repost = true;
    else return null;
  }
  return { choice: f && b ? 'sb' : f ? 'sf' : b ? 'sl' : 'a', repost };
}

/**
 * Applica la scelta alle slide del post.
 * L'esclusione ragiona per POSIZIONE nel post (come le vede l'utente),
 * poi i video vengono comunque scartati: le storie prendono solo foto.
 */
function applyChoice(slides, choice) {
  const last = slides.length;
  let keep = slides;
  if (choice === 'sf' || choice === 'sb') keep = keep.filter((s) => s.pos !== 1);
  if (choice === 'sl' || choice === 'sb') keep = keep.filter((s) => s.pos !== last);
  const photos = keep.filter((s) => !s.is_video && s.url);
  return { photos, videosSkipped: keep.filter((s) => s.is_video).length };
}

/** Scarica una foto dal CDN (nessuna autenticazione) e la salva su disco. */
/**
 * Il CDN di Instagram serve WEBP tanto quanto JPEG, e la via pubblica lo fa
 * quasi sempre. Prima si scrivevano i byte cosi' com'erano dentro un file
 * chiamato `.jpg`: nel repo ci sono finiti 9 file WEBP travestiti. L'API di
 * Instagram vuole JPEG per le immagini, quindi qui si converte davvero invece
 * di fidarsi dell'estensione.
 *
 * La conversione passa da Pillow, non da ImageMagick: Pillow arriva come
 * dipendenza di instagrapi (quindi sul runner c'e' sempre) e gestisce il WEBP
 * senza dipendere da un delegato esterno. In locale su Windows, per giunta,
 * `convert` e' il convertitore FAT->NTFS di sistema e non ImageMagick.
 *
 * Se la conversione fallisce si tengono i byte originali: un'immagine nel
 * formato sbagliato e' comunque meglio di nessuna immagine.
 */
const PY_TO_JPEG = [
  'import sys',
  'from PIL import Image',
  'im = Image.open(sys.argv[1])',
  'im = im if im.mode in ("RGB", "L") else im.convert("RGB")',
  'im.save(sys.argv[2], "JPEG", quality=92, optimize=True)',
].join('\n');

function eJpeg(buf) {
  return buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
}

async function downloadPhoto(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download CDN fallito (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1024) throw new Error('download CDN sospetto: file quasi vuoto');

  if (eJpeg(buf)) {
    fs.writeFileSync(dest, buf);
    return buf.length;
  }

  const tmp = `${dest}.orig`;
  fs.writeFileSync(tmp, buf);
  try {
    execFileSync(PYTHON, ['-c', PY_TO_JPEG, tmp, dest], { timeout: 60000 });
    return fs.statSync(dest).size;
  } catch (err) {
    console.error(`[igdl] conversione in JPEG fallita (${String(err.message).slice(0, 90)}): tengo l'originale`);
    fs.writeFileSync(dest, buf);
    return buf.length;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

module.exports = { parseIgLink, parseIgFlags, keyboardFor, fetchMediaInfo, applyChoice, downloadPhoto, CHOICES, IG_URL_RE };
