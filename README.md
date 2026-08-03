# velopub — Instagram Auto-Publisher per velo.rar

Pubblica automaticamente **una storia ogni 4 ore** e i **post carosello programmati** su Instagram, alimentato via Telegram, orchestrato con GitHub Actions. Solo API ufficiali Meta e Telegram: nessun rischio ban.

## Come funziona — STORIE

1. Mandi immagini al bot Telegram (foto, file ad alta qualità, o **zip** di immagini)
2. Ogni ora un workflow le importa in `queue/` e il bot ti conferma la ricezione
3. Ogni 4 ore (00·04·08·12·16·20 UTC) un workflow:
   - importa le eventuali foto nuove
   - pesca **a caso** dalla coda e pubblica una **storia**
   - archivia l'immagine in `published/` come `AAAA-MM-GG-N.jpg`
   - **ti manda su Telegram la foto pubblicata** + stato coda
4. Coda vuota? Ricicla a caso da `published/` (mai due volte di fila la stessa)

## Come funziona — POST carosello

1. Mandi al bot uno **zip con `meta.json` + immagini** (`01.jpg`, `02.jpg`… l'ordine
   è quello alfabetico dei nomi). In alternativa a `meta.json` basta un `caption.txt`
   col solo testo della caption.

   ```json
   {
     "caption": "Air Gear (2006): anti-gravity street skating…",
     "alt_text": ["slide 1: copertina del manga", "slide 2: …"],
     "tags": ["airgear", "y2kanime"],
     "publish_at": "2026-07-20T17:30:00Z"
   }
   ```
   Solo `caption` è obbligatoria. `tags` diventano hashtag in coda alla caption.
   `publish_at` (ISO, UTC) è opzionale: senza, il post prende il **primo slot
   libero** del calendario (`post-schedule.json`, default lun/mer/sab 17:30 UTC);
   se l'orario chiesto è occupato o passato, il bot propone il più vicino.

2. L'import **valida e normalizza**: max 10 slide, JPEG sRGB max 1440px <8MB,
   ratio uniforme = prima slide (verticale → 4:5), caption ≤2200 caratteri e
   ≤30 hashtag, blocco anti-segnaposto (TODO/placeholder → rifiutato).
   Tutto ok → cartella in `queue-posts/` e conferma con data di uscita.

3. Ogni ora (al minuto 23) un workflow pubblica i post **il cui orario è scaduto**
   — con **catch-up**: se GitHub salta una run (succede), la successiva recupera
   tutti gli arretrati in ordine. Pubblicato = spostato in `published-posts/`
   + conferma Telegram con anteprima.

⚠️ **La repo è pubblica** (deve esserlo: Instagram scarica le immagini da
`raw.githubusercontent.com`) → **la coda post, caption comprese, è visibile
a chiunque prima dell'uscita**. Scelta accettata: niente segreti nelle caption.

## Comandi del bot

| Comando | Effetto |
|---|---|
| *(foto o file immagine)* | Aggiunta in coda storie |
| *(file .zip di sole immagini)* | Tutte le immagini jpg/png in coda storie |
| *(file .zip con meta.json o caption.txt)* | Post carosello programmato |
| `/coda` | Lista post programmati (numero, slot, slide, caption) |
| `/anteprima N` | Prima slide + caption del post N |
| `/sposta N <ISO\|prossimo>` | Cambia lo slot del post N |
| `/annulla N` | Rimuove il post N dalla coda |
| `/status` | Stato code, pubblicate, autonomia |
| `/help` | Guida rapida |

Limite Telegram: i bot scaricano file fino a ~20 MB.

## Workflow

| File | Quando | Cosa fa |
|---|---|---|
| `scheduled-publish.yml` | ogni 4h + manuale | import + pubblica storia (o post singolo, da input manuale) |
| `import-telegram.yml` | ogni ora (:17) | solo import (così la conferma di ricezione arriva presto) |
| `publish-posts.yml` | ogni ora (:23) + manuale | pubblica i post carosello dovuti (con catch-up) |
| `refresh-token.yml` | il 1° del mese | rinnova il token IG (60gg di validità) |

## Secrets richiesti (Settings → Secrets → Actions)

| Secret | Cosa |
|---|---|
| `IG_ACCESS_TOKEN` | Token Instagram long-lived (60gg) |
| `IG_ACCOUNT_ID` | ID numerico account IG |
| `TELEGRAM_BOT_TOKEN` | Token bot da @BotFather |
| `TELEGRAM_CHAT_ID` | Chat autorizzata (e destinataria delle notifiche) |
| `GH_PAT` | PAT fine-grained con **Secrets: read/write** su questa repo — serve SOLO al rinnovo automatico del token IG |

⚠️ Mai committare o incollare questi valori. Se un token viene esposto: revocare e rigenerare subito.

## 🔗 Repost da Instagram (storie)

Manda al bot il **link di un post Instagram pubblico**, da solo o con i flag:

    <link>              → TUTTE le foto in coda storie
    <link> -f           → tutte tranne la PRIMA
    <link> -b           → tutte tranne l'ULTIMA
    <link> -f -b        → senza prima e ultima (anche -fb)
    <link> -repost      → BOZZA: zip in bozze/, NON entra nelle storie

Con un flag riconosciuto il bot procede alla run successiva senza domande.
Con testo che non riconosce non fa nulla e chiede coi bottoni — *Tutte ·
Tranne la 1ª · Tranne l'ultima · Senza 1ª e ultima*. Le foto vengono
scaricate **a risoluzione massima**; i video nel post vengono ignorati.
L'esito arriva in chat: `✅ N foto in coda (…)` oppure `❌` con il motivo.

**Un link per messaggio.** Se ne metti due nello stesso messaggio il bot
prende solo il primo. Più messaggi vengono processati tutti nella stessa run;
regolati sui 5-6 link per giro, così le chiamate a Instagram restano diluite.

### Bozze (`-repost`)

`-repost` non riempie le storie: prepara uno **zip** con le foto e un
`caption.txt` (testo del post, bio dell'account, data, like) e **te lo manda
in chat come file**. Serve come materiale grezzo da riformulare in chiave
velo.rar. Si combina con gli altri flag (`-repost -f`, `-repost -fb`…).

**Lo zip non entra nel repo**, ed è una scelta, non una dimenticanza: qui
dentro è tutto pubblico, e un archivio con testo e biografia di post altrui
riportati parola per parola non ci va. Una prima versione li anonimizzava per
poterli committare: non regge, perché nessuna regex riconosce che una frase in
italiano corrente identifica qualcuno — bio e caption sono ricercabili così
come sono. Meglio tenere il file fuori dal repo e completo.

Nel repo resta solo `bozze/indice.jsonl`: per ogni bozza il `file_id` di
Telegram, la data e due numeri. Niente autore, niente link, niente testo — e
il `file_id` senza il token del bot non apre nulla.

La bio costa **una chiamata Instagram in più**, per questo la fa solo
`-repost` e mai il flusso storie.

**Per averle in locale**, dal PC:

    cd C:\thi-workspace\ig-analisi
    python fetch-bozze.py            # scarica le nuove in ig-analisi/bozze/
    python fetch-bozze.py --estrai   # e le scompatta

Lo script legge l'indice dal repo e scarica gli zip con `getFile`, che **non
consuma la coda dei messaggi**: quella ha un solo consumatore, il bot in CI, e
se gliela rubassimo si perderebbe i tuoi messaggi. Serve `TELEGRAM_BOT_TOKEN`
in `ig-analisi/.env` o nell'ambiente.

Nota bene i tempi: il bot gira **ogni ora al minuto :17** — la domanda arriva
alla prima run dopo il link, il download alla prima run dopo il tocco. Per
l'esecuzione immediata: Actions → *Importa foto da Telegram* → Run workflow.

Richiede il secret **`IG_SESSION_B64`**: base64 del file di sessione instagrapi
di un account che può vedere il post (consigliato un account secondario, NON il
principale). Da locale:

    base64 -w0 percorso/sessione.json | gh secret set IG_SESSION_B64 -R <owner>/velopub

⚠️ La chiamata a Instagram parte dai runner GitHub (IP datacenter): usa la
sessione di un account che puoi permetterti di dover rigenerare.

## 📲 Post con la musica: modalità manuale

L'API di Instagram **non permette di allegare musica** a un post carosello: il
container accetta solo `media_type`, `children`, `caption`, `alt_text` — nessun
parametro audio esiste. E **non permette di creare bozze**: il container non è
visibile nell'app e scade dopo 24 ore. *(Verificato sui doc Meta il 2026-08-03;
la controprova è che su Facebook Pages `published=false` e
`scheduled_publish_time` sono documentati, su Instagram no.)*

Quindi per i post che devono avere la musica l'ultimo passo lo fai tu, e la
pipeline te lo prepara: **allo slot, invece di pubblicare, il bot ti consegna
il pacchetto in chat**.

Si attiva in due modi:

    // nel meta.json dello zip
    { "caption": "…", "publish_at": "…", "manuale": true }

    /manuale 3          // su un post già in coda (vedi /coda)
    /manuale 3 off      // torna automatico

All'ora dello slot ricevi **le slide come file** — non come foto: sono già
normalizzate a 1440px e la ricompressione di Telegram le rovinerebbe — in
ordine, e **la caption in un messaggio separato**, senza altro testo attorno,
così un tocco lungo la copia per intero.

Il post esce dalla coda e finisce in `consegnati-posts/`, con `handoff_at` nel
`meta.json` e senza `published_at`: non risulta pubblicato e non viene ripreso
dal catch-up.

In `/coda` i post manuali sono marcati con 📲.

**Limiti API da tenere presenti** (documentati Meta): 100 post pubblicati via
API per account ogni 24 ore (un carosello conta 1); un container va pubblicato
entro 24 ore o scade.

## Note

- La repo deve restare **pubblica**: Instagram scarica le immagini da `raw.githubusercontent.com`
- Le storie via API non supportano sticker, link, sondaggi né caption
- I caroselli via API: max 10 slide (i dump da 15-20 si pubblicano solo dall'app);
  niente musica/audio trending (quello esiste solo per i reel pubblicati in-app)
- Cron in UTC: in Italia +1 (inverno) / +2 (estate)
