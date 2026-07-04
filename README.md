# velopub — Instagram Auto-Publisher per velo.rar

Pubblica automaticamente **una storia ogni 4 ore** su Instagram, alimentato via Telegram, orchestrato con GitHub Actions. Solo API ufficiali Meta e Telegram: nessun rischio ban.

## Come funziona

1. Mandi immagini al bot Telegram (foto, file ad alta qualità, o **zip** di immagini)
2. Ogni ora un workflow le importa in `queue/` e il bot ti conferma la ricezione
3. Ogni 4 ore (00·04·08·12·16·20 UTC) un workflow:
   - importa le eventuali foto nuove
   - pesca **a caso** dalla coda e pubblica una **storia**
   - archivia l'immagine in `published/` come `AAAA-MM-GG-N.jpg`
   - **ti manda su Telegram la foto pubblicata** + stato coda
4. Coda vuota? Ricicla a caso da `published/` (mai due volte di fila la stessa)

## Comandi del bot

| Comando | Effetto |
|---|---|
| *(foto o file immagine)* | Aggiunta in coda |
| *(file .zip)* | Tutte le immagini jpg/png dentro vengono estratte in coda |
| `/status` | Stato coda, pubblicate, autonomia |
| `/help` | Guida rapida |

Limite Telegram: i bot scaricano file fino a ~20 MB.

## Workflow

| File | Quando | Cosa fa |
|---|---|---|
| `scheduled-publish.yml` | ogni 4h + manuale | import + pubblica storia (o post, da input manuale) |
| `import-telegram.yml` | ogni ora | solo import (così la conferma di ricezione arriva presto) |
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
- Cron in UTC: in Italia +1 (inverno) / +2 (estate)
