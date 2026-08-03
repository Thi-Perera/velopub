"""
igdl-fetch.py — risolve un post Instagram pubblico in JSON con le immagini a
risoluzione massima. Usato dal bot Telegram (import-from-telegram.js) per il
repost nella coda storie.

    python3 igdl-fetch.py <shortcode>

Stampa SEMPRE una riga JSON su stdout ed esce 0: gli errori stanno nel campo
"error", mai come traceback (il chiamante fa il parse e riferisce in chat).

Sessione: IG_SESSION_B64 (base64 del file di sessione instagrapi, secret di
GitHub) oppure IG_SESSION_FILE (path locale, per i test). Il contenuto della
sessione non viene MAI loggato.
"""
import base64
import json
import os
import sys
import tempfile


def out(obj):
    print(json.dumps(obj, ensure_ascii=False))
    sys.exit(0)


def main():
    if len(sys.argv) < 2:
        out({"ok": False, "error": "uso: igdl-fetch.py <shortcode>"})
    code = sys.argv[1]

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

        out({
            "ok": True,
            "author": (m.get("user") or {}).get("username") or "?",
            "code": code,
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
