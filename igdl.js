/**
 * igdl.js — repost da Instagram alla coda storie.
 *
 * Flusso: link IG in chat → il bot chiede con 4 bottoni cosa salvare →
 * al tocco (callback_query, run successiva) igdl-fetch.py risolve il post
 * via instagrapi (secret IG_SESSION_B64) → le foto si scaricano dal CDN a
 * risoluzione massima → queue/ (storie). Il feedback avviene modificando
 * il messaggio-domanda: ✅ con conteggio o ❌ con il motivo.
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
async function downloadPhoto(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download CDN fallito (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1024) throw new Error('download CDN sospetto: file quasi vuoto');
  fs.writeFileSync(dest, buf);
  return buf.length;
}

module.exports = { parseIgLink, parseIgFlags, keyboardFor, fetchMediaInfo, applyChoice, downloadPhoto, CHOICES, IG_URL_RE };
