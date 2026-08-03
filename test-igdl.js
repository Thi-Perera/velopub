/**
 * test-igdl.js — collaudo OFFLINE della logica repost (niente rete, niente bot).
 *     node test-igdl.js
 * Esce 0 se tutti i casi passano, 1 altrimenti.
 */
const { parseIgLink, parseIgFlags, keyboardFor, applyChoice, CHOICES } = require('./igdl');

let failed = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { console.log(`  ok   ${label}`); return; }
  failed++;
  console.log(`  FAIL ${label}\n       atteso ${e}\n       avuto  ${a}`);
}

console.log('parseIgLink');
eq(parseIgLink('https://www.instagram.com/p/DWsLwXujDj-/'), 'DWsLwXujDj-', 'link post');
eq(parseIgLink('https://www.instagram.com/p/DWsLwXujDj-/?igsh=abc'), 'DWsLwXujDj-', 'link con query');
eq(parseIgLink('guarda https://instagram.com/reel/Cxyz12345ab/ bello'), 'Cxyz12345ab', 'reel dentro frase');
eq(parseIgLink('https://www.instagram.com/velo.rar/p/DWsLwXujDj-/'), 'DWsLwXujDj-', 'link con username');
eq(parseIgLink('https://www.instagram.com/velo.rar/'), null, 'link profilo → null');
eq(parseIgLink('ciao come va'), null, 'testo qualsiasi → null');
eq(parseIgLink(''), null, 'stringa vuota → null');

console.log('keyboardFor');
const kb = keyboardFor('DWsLwXujDj-');
eq(kb.inline_keyboard.length, 2, 'due righe di bottoni');
eq(kb.inline_keyboard.flat().length, 4, 'quattro bottoni');
for (const b of kb.inline_keyboard.flat()) {
  if (Buffer.byteLength(b.callback_data, 'utf8') > 64) {
    failed++; console.log(`  FAIL callback_data oltre 64 byte: ${b.callback_data}`);
  }
}
eq(kb.inline_keyboard[0][0].callback_data, 'ig:DWsLwXujDj-:a', 'formato callback_data');

console.log('applyChoice');
const mk = (n, videoAt = []) => Array.from({ length: n }, (_, i) => ({
  pos: i + 1, is_video: videoAt.includes(i + 1), url: `u${i + 1}`,
}));
const posDi = (r) => r.photos.map((p) => p.pos);

eq(posDi(applyChoice(mk(5), 'a')), [1, 2, 3, 4, 5], '5 slide, tutte');
eq(posDi(applyChoice(mk(5), 'sf')), [2, 3, 4, 5], '5 slide, senza la prima');
eq(posDi(applyChoice(mk(5), 'sl')), [1, 2, 3, 4], "5 slide, senza l'ultima");
eq(posDi(applyChoice(mk(5), 'sb')), [2, 3, 4], '5 slide, senza prima e ultima');
eq(posDi(applyChoice(mk(1), 'a')), [1], '1 slide, tutte');
eq(posDi(applyChoice(mk(1), 'sf')), [], '1 slide, senza la prima → vuoto');
eq(posDi(applyChoice(mk(1), 'sb')), [], '1 slide, senza prima e ultima → vuoto');
eq(posDi(applyChoice(mk(2), 'sb')), [], '2 slide, senza prima e ultima → vuoto');
// i video si contano DOPO l'esclusione posizionale
eq(applyChoice(mk(5, [3]), 'a').videosSkipped, 1, 'video in mezzo: contato');
eq(posDi(applyChoice(mk(5, [3]), 'a')), [1, 2, 4, 5], 'video in mezzo: escluso dalle foto');
eq(applyChoice(mk(5, [1]), 'sf').videosSkipped, 0, 'video in slide 1 + "tranne la 1ª": non contato due volte');
eq(posDi(applyChoice(mk(3, [1, 2, 3]), 'a')), [], 'post di soli video → nessuna foto');

console.log('parseIgFlags');
const L = 'https://www.instagram.com/p/DWsLwXujDj-/';
eq(parseIgFlags(L), { choice: 'a', repost: false }, 'solo link → tutte, coda storie');
eq(parseIgFlags(`${L} -f`), { choice: 'sf', repost: false }, 'link -f → senza la prima');
eq(parseIgFlags(`-b ${L}`), { choice: 'sl', repost: false }, "-b prima del link → senza l'ultima");
eq(parseIgFlags(`${L} -f -b`), { choice: 'sb', repost: false }, 'link -f -b → senza entrambe');
eq(parseIgFlags(`${L} -b -f`), { choice: 'sb', repost: false }, 'ordine inverso → senza entrambe');
eq(parseIgFlags(`${L} -fb`), { choice: 'sb', repost: false }, '-fb combinato → senza entrambe');
eq(parseIgFlags(`${L} -bf`), { choice: 'sb', repost: false }, '-bf combinato → senza entrambe');
eq(parseIgFlags(`${L} -f -f`), { choice: 'sf', repost: false }, 'flag ripetuto → ok');
eq(parseIgFlags(`${L} -repost`), { choice: 'a', repost: true }, '-repost → bozza, tutte le foto');
eq(parseIgFlags(`${L} -repost -f`), { choice: 'sf', repost: true }, '-repost -f → bozza senza la prima');
eq(parseIgFlags(`${L} -fb -repost`), { choice: 'sb', repost: true }, '-repost -fb → bozza senza prima e ultima');
eq(parseIgFlags(`${L} -repost -repost`), { choice: 'a', repost: true }, '-repost ripetuto → ok');
eq(parseIgFlags(`${L} ciao`), null, 'parola sconosciuta → null (chiedi)');
eq(parseIgFlags(`${L} -x`), null, 'flag sconosciuto → null (chiedi)');
eq(parseIgFlags(`${L} -f ciao`), null, 'flag valido + parola → null (chiedi)');
eq(parseIgFlags(`guarda ${L}`), null, 'testo attorno al link → null (chiedi)');

console.log('CHOICES');
eq(Object.keys(CHOICES).sort(), ['a', 'sb', 'sf', 'sl'], 'quattro scelte');

if (failed) { console.log(`\n${failed} casi FALLITI`); process.exit(1); }
console.log('\nTutti i casi passano.');
