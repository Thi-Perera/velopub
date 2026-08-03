"""
igdl-fetch.py — risolve un post Instagram pubblico in JSON con le immagini a
risoluzione massima. Usato dal bot Telegram (import-from-telegram.js) per il
repost nella coda storie e per l'archivio -repost.

    python3 igdl-fetch.py <shortcode> [--bio]

Con --bio aggiunge la biografia dell'account: costa UNA chiamata Instagram in
piu', quindi la usa solo il flusso -repost (archivio di studio), mai quello
delle storie.

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

    sess_file = os.environ.get("IG_SESSION_FILE")
    b64 = os.environ.get("IG_SESSION_B64")
    if not sess_file and not b64:
        out({"ok": False, "error": "secret IG_SESSION_B64 mancante"})

    try:
        from instagrapi import Client
    except ImportError:
        out({"ok": False, "error": "instagrapi non installato"})

    tmp = None
    try:
        if not sess_file:
            tmp = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
            tmp.write(base64.b64decode(b64).decode("utf-8"))
            tmp.close()
            sess_file = tmp.name

        cl = Client()
        cl.load_settings(sess_file)
        cl.delay_range = [1, 3]

        pk = cl.media_pk_from_code(code)          # conversione offline, zero API
        m = cl.media_info_v1(pk).model_dump()     # UNICA chiamata a Instagram

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

        user = m.get("user") or {}
        author = user.get("username") or "?"

        # La bio NON arriva con media_info: serve una chiamata in piu'.
        # Se fallisce non e' fatale: l'archivio vale comunque.
        bio = None
        bio_error = None
        if want_bio and user.get("pk"):
            try:
                bio = (cl.user_info_v1(str(user["pk"])).model_dump()
                       .get("biography") or "").strip() or None
            except Exception as e:  # noqa: BLE001
                # Non fatale (la bozza vale comunque) ma NON silenzioso:
                # un except muto qui aveva già nascosto un bug per un giro.
                bio_error = f"{type(e).__name__}: {e}"[:120]

        taken = m.get("taken_at")
        out({
            "ok": True,
            "author": author,
            "code": code,
            "caption": (m.get("caption_text") or "").strip(),
            "bio": bio,
            "bio_error": bio_error,
            "taken_at": str(taken) if taken else None,
            "like_count": m.get("like_count"),
            "comment_count": m.get("comment_count"),
            "slides": slides,
        })
    except Exception as e:  # noqa: BLE001 — tutto diventa JSON, mai traceback
        msg = f"{type(e).__name__}: {e}"
        low = msg.lower()
        if any(k in low for k in ("login_required", "logged_out", "challenge", "checkpoint")):
            msg = "sessione Instagram scaduta o bloccata: rigenera il secret IG_SESSION_B64"
        elif any(k in low for k in ("not found", "media_not_found", "invalid_parameters", "400")):
            msg = "post non accessibile (privato, rimosso o link errato)"
        out({"ok": False, "error": msg[:200]})
    finally:
        if tmp:
            os.unlink(tmp.name)


if __name__ == "__main__":
    main()
