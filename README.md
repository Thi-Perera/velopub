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

## Note

- La repo deve restare **pubblica**: Instagram scarica le immagini da `raw.githubusercontent.com`
- Le storie via API non supportano sticker, link, sondaggi né caption
- I caroselli via API: max 10 slide (i dump da 15-20 si pubblicano solo dall'app);
  niente musica/audio trending (quello esiste solo per i reel pubblicati in-app)
- Cron in UTC: in Italia +1 (inverno) / +2 (estate)
