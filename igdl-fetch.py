"""
igdl-fetch.py — risolve un post Instagram pubblico in JSON con le immagini a
risoluzione massima. Usato dal bot Telegram (import-from-telegram.js) per il
repost nella coda storie e per l'archivio -repost.

    python3 igdl-fetch.py <shortcode> [--bio]

DUE STRADE, e l'ordine conta (2026-08-05).

1. PUBBLICA (`media_info_gql`) — nessuna sessione, nessuna autenticazione.
   E' la strada principale: restituisce le stesse identiche immagini della via
   autenticata (verificato: stesso file, 1440x1920, stessi byte), piu' caption,
   autore, like, commenti e data. Non tocca l'account burner, quindi non ne
   consuma la reputazione e non rischia blocchi.

2. AUTENTICATA (`media_info_v1`) — solo come riserva, e solo se c'e' una
   sessione. Serve nei casi in cui la via pubblica venga limitata.

Prima di questa versione esisteva solo la (2), e quando la sessione e' scaduta
la feature ha smesso di funzionare del tutto (`LoginRequired: login_required`).
Ora la sessione e' OPZIONALE: senza, il post si scarica lo stesso.

LA BIO E' L'ECCEZIONE. Richiede per forza una sessione: entrambe le vie
pubbliche la negano (`user_info_gql` -> "Session is required for web profile
GraphQL", `web_profile_info` -> rate limit). Senza sessione valida il campo
"bio" resta nullo e "bio_error" dice perche': il resto della bozza vale
comunque.

Stampa SEMPRE una riga JSON su stdout ed esce 0: gli errori stanno nel campo
"error", mai come traceback (il chiamante fa il parse e riferisce in chat).

Sessione: IG_SESSION_B64 (base64 del file di sessione instagrapi, secret di
GitHub) oppure IG_SESSION_FILE (path locale, per i test). Il contenuto della
sessione non viene MAI loggato.
"""
import base64
import io
import json
import os
import sys
import tempfile

# Console Windows in cp1252: una caption con "→" farebbe UnicodeEncodeError.
# ensure_ascii=True basterebbe, ma forzare UTF-8 rende leggibile anche il log.
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")


def out(obj):
    # ensure_ascii=True: l'output attraversa una pipe verso Node, deve
    # sopravvivere a qualunque codepage. JSON.parse decodifica \\uXXXX.
    print(json.dumps(obj, ensure_ascii=True))
    sys.exit(0)


def leggibile(e):
    """Messaggi che dicono cosa fare, non cosa e' esploso."""
    msg = f"{type(e).__name__}: {e}"
    low = msg.lower()
    if any(k in low for k in ("login_required", "logged_out", "challenge", "checkpoint")):
        return "sessione Instagram scaduta o bloccata: rigenera il secret IG_SESSION_B64"
    # La via pubblica, per un post inesistente o privato, non risponde 404: torna
    # un "Query Error" generico con dentro il doc_id. Va tradotto, o l'utente
    # legge un errore GraphQL al posto di "controlla il link".
    if any(k in low for k in ("media_not_found", "not found", "invalid_parameters",
                              "query error", "missing 'data'")):
        return "post non accessibile (privato, rimosso o link errato)"
    if any(k in low for k in ("429", "rate limit", "too many", "max retries")):
        return "Instagram sta limitando le richieste: riprova fra qualche minuto"
    return msg[:200]


def estrai_slide(m):
    """Stessa forma per entrambe le vie: gql e v1 hanno lo stesso schema."""
    slides = []
    resources = m.get("resources") or []
    if resources:                              # carosello
        for i, r in enumerate(resources, 1):
            slides.append({
                "pos": i,
                "is_video": r.get("media_type") == 2,
                "url": str(r.get("thumbnail_url") or ""),
            })
    else:                                      # foto singola o video singolo
        slides.append({
            "pos": 1,
            "is_video": m.get("media_type") == 2,
            "url": str(m.get("thumbnail_url") or ""),
        })
    return slides


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    want_bio = "--bio" in sys.argv[1:]
    if not args:
        out({"ok": False, "error": "uso: igdl-fetch.py <shortcode> [--bio]"})
    code = args[0]

    # Sulle macchine locali con proxy TLS serve il cert store di sistema;
    # sui runner CI truststore non è installato e non serve: silenzio.
    try:
        import truststore
        truststore.inject_into_ssl()
    except ImportError:
        pass

    try:
        from instagrapi import Client
    except ImportError:
        out({"ok": False, "error": "instagrapi non installato"})

    sess_file = os.environ.get("IG_SESSION_FILE")
    b64 = os.environ.get("IG_SESSION_B64")
    tmp_sess = None
    ha_sessione = bool(sess_file or b64)

    def sessione_pronta():
        """Materializza la sessione una volta sola e la carica nel client."""
        nonlocal tmp_sess, sess_file
        if not sess_file:
            tmp = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
            tmp.write(base64.b64decode(b64).decode("utf-8"))
            tmp.close()
            tmp_sess = tmp.name
            sess_file = tmp_sess
        cl.load_settings(sess_file)

    m = None
    via = None
    err_pub = None

    try:
        cl = Client()
        cl.delay_range = [1, 3]
        pk = cl.media_pk_from_code(code)   # conversione offline, zero API

        # --- 1. via pubblica: nessuna sessione, nessun costo per il burner ---
        try:
            m = cl.media_info_gql(pk).model_dump()
            via = "pubblico"
        except Exception as e:  # noqa: BLE001
            err_pub = leggibile(e)

        # --- 2. riserva autenticata, solo se serve E se c'e' una sessione ---
        if m is None:
            if not ha_sessione:
                # err_pub e' gia' passato da leggibile(): non lo incarto in un
                # secondo messaggio, l'utente deve leggere una frase sola.
                out({"ok": False, "error": err_pub})
            try:
                sessione_pronta()
                m = cl.media_info_v1(pk).model_dump()
                via = "sessione"
            except Exception as e:  # noqa: BLE001
                out({"ok": False,
                     "error": f"pubblico: {err_pub} | sessione: {leggibile(e)}"})

        user = m.get("user") or {}
        author = user.get("username") or "?"

        # --- bio: solo autenticata. Se non si puo', si dice perche' ---
        bio = None
        bio_error = None
        if want_bio:
            if not ha_sessione:
                bio_error = ("bio non disponibile senza sessione Instagram "
                             "(IG_SESSION_B64 non configurato). Le foto e la caption ci sono.")
            elif not user.get("pk"):
                bio_error = "bio non disponibile: id autore assente nel payload"
            else:
                try:
                    sessione_pronta()
                    bio = (cl.user_info_v1(str(user["pk"])).model_dump()
                           .get("biography") or "").strip() or None
                except Exception as e:  # noqa: BLE001
                    # Non fatale (la bozza vale comunque) ma NON silenzioso:
                    # un except muto qui aveva già nascosto un bug per un giro.
                    bio_error = leggibile(e)

        taken = m.get("taken_at")
        out({
            "ok": True,
            "via": via,                      # "pubblico" | "sessione"
            "author": author,
            "code": code,
            "caption": (m.get("caption_text") or "").strip(),
            "bio": bio,
            "bio_error": bio_error,
            "taken_at": str(taken) if taken else None,
            "like_count": m.get("like_count"),
            "comment_count": m.get("comment_count"),
            "slides": estrai_slide(m),
        })
    except Exception as e:  # noqa: BLE001 — tutto diventa JSON, mai traceback
        out({"ok": False, "error": leggibile(e)})
    finally:
        if tmp_sess:
            try:
                os.unlink(tmp_sess)
            except OSError:
                pass


if __name__ == "__main__":
    main()
