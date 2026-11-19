"""
WinampZ - a web-based, Winamp-inspired media player.

Flask routes:
  - Static page + library/playlist/settings REST API
  - Metadata extraction (mutagen for audio, ffprobe for video)
  - Directory scanning + drag-and-drop upload
  - HTTP Range ("206 Partial Content") streaming, with an on-demand
    ffmpeg transcode fallback for browser-unfriendly video containers.
"""

import json
import mimetypes
import os
import re
import subprocess
import threading
import uuid
from pathlib import Path

from flask import Flask, Response, jsonify, render_template, request, send_file
from werkzeug.utils import secure_filename

import database as db

BASE_DIR = Path(__file__).resolve().parent
UPLOAD_DIR = BASE_DIR / "static" / "uploads"
TRANSCODE_DIR = BASE_DIR / "static" / "transcoded"
YOUTUBE_DIR = BASE_DIR / "static" / "uploads" / "youtube"
YOUTUBE_COOKIES_FILE = BASE_DIR / "youtube_cookies.txt"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
TRANSCODE_DIR.mkdir(parents=True, exist_ok=True)
YOUTUBE_DIR.mkdir(parents=True, exist_ok=True)

# Must run at import time (not just under `python app.py`) so the schema
# exists when a WSGI server (gunicorn/uWSGI/PythonAnywhere, etc.) imports
# this module directly without ever executing the __main__ block below.
db.init_db()

# Some videos (age-restricted, or ones YouTube has flagged for bot-detection)
# fail with a "Please sign in" error unless yt-dlp is given credentials.
# Opt in via one of:
#   - YOUTUBE_COOKIES_FROM_BROWSER=chrome (or edge/firefox/brave/opera/vivaldi/safari[:profile])
#   - a Netscape-format cookies.txt exported from a logged-in browser, saved as
#     youtube_cookies.txt in the project root.
# Neither is required for public, non-restricted content.
YOUTUBE_COOKIES_FROM_BROWSER = os.environ.get("YOUTUBE_COOKIES_FROM_BROWSER", "").strip()


def youtube_auth_opts():
    if YOUTUBE_COOKIES_FROM_BROWSER:
        browser, _, profile = YOUTUBE_COOKIES_FROM_BROWSER.partition(":")
        return {"cookiesfrombrowser": (browser, profile or None, None, None)}
    if YOUTUBE_COOKIES_FILE.exists():
        return {"cookiefile": str(YOUTUBE_COOKIES_FILE)}
    return {}

AUDIO_EXTENSIONS = {".mp3", ".wav", ".ogg", ".flac", ".m4a", ".aac"}
VIDEO_EXTENSIONS = {".mp4", ".webm", ".mkv", ".avi"}
ALL_EXTENSIONS = AUDIO_EXTENSIONS | VIDEO_EXTENSIONS

# Containers/codecs that browsers can usually play natively via <video>/<audio>.
# Anything else is transcoded on first request to an MP4 (H.264/AAC) and cached.
DIRECT_SERVE_EXTENSIONS = AUDIO_EXTENSIONS | {".mp4", ".webm"}

MIME_OVERRIDES = {
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
    ".avi": "video/x-msvideo",
}

CHUNK_SIZE = 1024 * 1024  # 1 MiB streaming chunks

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 4 * 1024 * 1024 * 1024  # 4 GiB uploads

# Guards concurrent/duplicate transcode jobs for the same media id.
_transcode_status = {}
_transcode_lock = threading.Lock()


# ---------------------------------------------------------------------------
# Metadata extraction
# ---------------------------------------------------------------------------

def guess_media_type(extension):
    ext = extension.lower()
    if ext in AUDIO_EXTENSIONS:
        return "audio"
    if ext in VIDEO_EXTENSIONS:
        return "video"
    return None


def extract_audio_metadata(path, default_title=None):
    """Use mutagen to pull tags + stream info out of an audio file."""
    result = {
        "title": default_title or Path(path).stem,
        "artist": "Unknown Artist",
        "album": "Unknown Album",
        "genre": "",
        "track_number": 0,
        "duration": 0,
        "bitrate": 0,
        "sample_rate": 0,
    }
    try:
        from mutagen import File as MutagenFile

        audio = MutagenFile(path, easy=True)
        if audio is not None:
            tags = audio.tags or {}

            def first(key):
                values = tags.get(key)
                return values[0] if values else None

            result["title"] = first("title") or result["title"]
            result["artist"] = first("artist") or result["artist"]
            result["album"] = first("album") or result["album"]
            result["genre"] = first("genre") or result["genre"]
            track = first("tracknumber")
            if track:
                match = re.match(r"\d+", str(track))
                if match:
                    result["track_number"] = int(match.group())

            info = getattr(audio, "info", None)
            if info is not None:
                result["duration"] = round(getattr(info, "length", 0) or 0, 2)
                result["bitrate"] = int(getattr(info, "bitrate", 0) or 0) // 1000
                result["sample_rate"] = int(getattr(info, "sample_rate", 0) or 0)
    except Exception as exc:  # noqa: BLE001 - metadata must never crash ingestion
        app.logger.warning("Audio metadata extraction failed for %s: %s", path, exc)

    if not result["bitrate"] and result["duration"]:
        try:
            filesize_bits = os.path.getsize(path) * 8
            result["bitrate"] = int(filesize_bits / result["duration"] / 1000)
        except OSError:
            pass

    return result


def extract_video_metadata(path, default_title=None):
    """Use ffprobe (ffmpeg suite) to pull duration/bitrate/resolution, if available."""
    result = {
        "title": default_title or Path(path).stem,
        "artist": "Unknown Artist",
        "album": "Unknown Album",
        "genre": "",
        "track_number": 0,
        "duration": 0,
        "bitrate": 0,
        "sample_rate": 0,
    }
    try:
        proc = subprocess.run(
            [
                "ffprobe",
                "-v", "quiet",
                "-print_format", "json",
                "-show_format",
                "-show_streams",
                str(path),
            ],
            capture_output=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
        )
        if proc.returncode == 0 and proc.stdout:
            data = json.loads(proc.stdout)
            fmt = data.get("format", {})
            result["duration"] = round(float(fmt.get("duration", 0) or 0), 2)
            result["bitrate"] = int(float(fmt.get("bit_rate", 0) or 0)) // 1000

            tags = {k.lower(): v for k, v in (fmt.get("tags") or {}).items()}
            result["title"] = tags.get("title") or result["title"]
            result["artist"] = tags.get("artist") or tags.get("artist_name") or result["artist"]
            result["album"] = tags.get("album") or result["album"]

            for stream in data.get("streams", []):
                if stream.get("codec_type") == "audio":
                    result["sample_rate"] = int(stream.get("sample_rate", 0) or 0)
                    break
    except FileNotFoundError:
        app.logger.info("ffprobe not found; video metadata will be limited for %s", path)
    except Exception as exc:  # noqa: BLE001
        app.logger.warning("Video metadata extraction failed for %s: %s", path, exc)

    return result


def ingest_file(path, overrides=None, default_title=None):
    """Extract metadata for a file on disk and insert it into media_items.

    `default_title` is used as the fallback title when no tag is found
    (e.g. the original upload filename, instead of the on-disk unique name).
    `overrides` (optional dict) wins over extracted tags - used when the
    caller already has authoritative metadata (e.g. from a YouTube import).

    Returns (media_dict, created_bool) or None if the extension is unsupported.
    """
    path = Path(path)
    ext = path.suffix.lower()
    media_type = guess_media_type(ext)
    if media_type is None:
        return None

    if media_type == "audio":
        meta = extract_audio_metadata(path, default_title=default_title)
    else:
        meta = extract_video_metadata(path, default_title=default_title)

    for key, value in (overrides or {}).items():
        if value:
            meta[key] = value

    try:
        filesize = os.path.getsize(path)
    except OSError:
        filesize = 0

    payload = {
        **meta,
        "file_path": str(path.resolve()),
        "media_type": media_type,
        "filesize": filesize,
    }
    media_id, created = db.insert_media_item(payload)
    return db.get_media_item(media_id), created


# ---------------------------------------------------------------------------
# YouTube playlist / video import (via yt-dlp)
# ---------------------------------------------------------------------------

_youtube_jobs = {}
_youtube_jobs_lock = threading.Lock()


def _set_job(job_id, **fields):
    with _youtube_jobs_lock:
        _youtube_jobs[job_id].update(fields)


def run_youtube_import(job_id, url, media_kind):
    try:
        import yt_dlp
    except ImportError:
        _set_job(job_id, status="error", error="yt-dlp is not installed. Run: pip install yt-dlp")
        return

    auth_opts = youtube_auth_opts()

    try:
        probe_opts = {"quiet": True, "no_warnings": True, "extract_flat": "in_playlist", "skip_download": True, **auth_opts}
        with yt_dlp.YoutubeDL(probe_opts) as probe:
            info = probe.extract_info(url, download=False)
    except Exception as exc:  # noqa: BLE001
        _set_job(job_id, status="error", error=f"Could not read URL: {exc}")
        return

    is_playlist = isinstance(info, dict) and info.get("_type") == "playlist" and info.get("entries") is not None
    entries = [e for e in info.get("entries", [])] if is_playlist else [info]
    entries = [e for e in entries if e]

    if not entries:
        _set_job(job_id, status="error", error="No playable videos found at that URL.")
        return

    playlist_id = None
    playlist_name = None
    if is_playlist:
        playlist_name = info.get("title") or "YouTube Import"
        playlist_id = db.create_playlist(playlist_name)

    _set_job(job_id, status="downloading", total=len(entries), completed=0,
             playlist_id=playlist_id, playlist_name=playlist_name, added=0, errors=[])

    if media_kind == "video":
        ydl_opts = {
            "quiet": True,
            "no_warnings": True,
            "format": "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
            "merge_output_format": "mp4",
            "outtmpl": str(YOUTUBE_DIR / "%(id)s.%(ext)s"),
            "postprocessors": [{"key": "FFmpegMetadata"}],
            **auth_opts,
        }
    else:
        ydl_opts = {
            "quiet": True,
            "no_warnings": True,
            "format": "bestaudio/best",
            "outtmpl": str(YOUTUBE_DIR / "%(id)s.%(ext)s"),
            "postprocessors": [
                {"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "192"},
                {"key": "FFmpegMetadata"},
            ],
            **auth_opts,
        }

    added = 0
    errors = []
    for index, entry in enumerate(entries):
        video_url = entry.get("url") or entry.get("webpage_url")
        video_id = entry.get("id")
        if not video_url and video_id:
            video_url = f"https://www.youtube.com/watch?v={video_id}"
        if not video_url:
            errors.append("Skipped an entry with no resolvable URL")
            _set_job(job_id, completed=index + 1, errors=errors)
            continue

        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                result = ydl.extract_info(video_url, download=True)

            downloads = result.get("requested_downloads") or []
            file_path = downloads[0]["filepath"] if downloads else ydl.prepare_filename(result)

            overrides = {
                "title": result.get("title"),
                "artist": result.get("uploader") or result.get("channel"),
                "album": playlist_name or "",
                "duration": round(result.get("duration") or 0, 2),
            }
            ingested = ingest_file(file_path, overrides=overrides)
            if ingested:
                media_item, _created = ingested
                if playlist_id is not None:
                    db.add_playlist_item(playlist_id, media_item["id"])
                added += 1
        except Exception as exc:  # noqa: BLE001
            app.logger.warning("YouTube import failed for %s: %s", video_url, exc)
            message = str(exc)
            if "sign in" in message.lower() or "cookies" in message.lower():
                message = (
                    "This video needs an authenticated session (age-restricted or "
                    "bot-check). Set YOUTUBE_COOKIES_FROM_BROWSER or add "
                    "youtube_cookies.txt - see README."
                )
            errors.append(f"{entry.get('title', video_url)}: {message}")

        _set_job(job_id, completed=index + 1, added=added, errors=errors)

    _set_job(job_id, status="done")


# ---------------------------------------------------------------------------
# Byte-range streaming
# ---------------------------------------------------------------------------

RANGE_PATTERN = re.compile(r"bytes=(\d*)-(\d*)")


def build_range_response(file_path, mimetype):
    file_path = Path(file_path)
    file_size = file_path.stat().st_size
    range_header = request.headers.get("Range")

    if range_header is None:
        response = send_file(file_path, mimetype=mimetype, conditional=True)
        response.headers["Accept-Ranges"] = "bytes"
        return response

    match = RANGE_PATTERN.match(range_header)
    if not match:
        return Response(status=416)

    start_str, end_str = match.groups()
    if start_str == "" and end_str == "":
        return Response(status=416)

    if start_str == "":
        # Suffix range: last N bytes.
        suffix_length = int(end_str)
        start = max(file_size - suffix_length, 0)
        end = file_size - 1
    else:
        start = int(start_str)
        end = int(end_str) if end_str else file_size - 1

    end = min(end, file_size - 1)
    if start > end or start >= file_size:
        return Response(
            status=416,
            headers={"Content-Range": f"bytes */{file_size}"},
        )

    length = end - start + 1

    def generate():
        with open(file_path, "rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(CHUNK_SIZE, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    response = Response(generate(), status=206, mimetype=mimetype, direct_passthrough=True)
    response.headers["Content-Range"] = f"bytes {start}-{end}/{file_size}"
    response.headers["Accept-Ranges"] = "bytes"
    response.headers["Content-Length"] = str(length)
    return response


def transcode_to_mp4(source_path, dest_path, media_id):
    try:
        subprocess.run(
            [
                "ffmpeg", "-y",
                "-i", str(source_path),
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
                "-c:a", "aac", "-b:a", "160k",
                "-movflags", "+faststart",
                str(dest_path),
            ],
            capture_output=True,
            check=True,
            timeout=60 * 30,
        )
        with _transcode_lock:
            _transcode_status[media_id] = "done"
    except FileNotFoundError:
        with _transcode_lock:
            _transcode_status[media_id] = "error:ffmpeg-not-installed"
    except subprocess.CalledProcessError as exc:
        app.logger.error("ffmpeg transcode failed for %s: %s", source_path, exc.stderr)
        with _transcode_lock:
            _transcode_status[media_id] = "error:ffmpeg-failed"
    except Exception as exc:  # noqa: BLE001
        app.logger.error("Unexpected transcode error for %s: %s", source_path, exc)
        with _transcode_lock:
            _transcode_status[media_id] = "error:unexpected"


# ---------------------------------------------------------------------------
# Routes - pages
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")


# ---------------------------------------------------------------------------
# Routes - library
# ---------------------------------------------------------------------------

@app.route("/api/library")
def api_library():
    search = request.args.get("search", "").strip() or None
    media_type = request.args.get("type", "").strip() or None
    items = db.list_media_items(search=search, media_type=media_type)
    return jsonify(items)


@app.route("/api/media/<int:media_id>")
def api_media_detail(media_id):
    item = db.get_media_item(media_id)
    if item is None:
        return jsonify({"error": "not found"}), 404
    return jsonify(item)


@app.route("/api/media/<int:media_id>", methods=["DELETE"])
def api_media_delete(media_id):
    removed = db.delete_media_item(media_id)
    if removed is None:
        return jsonify({"error": "not found"}), 404
    file_path = Path(removed["file_path"])
    if UPLOAD_DIR in file_path.parents and file_path.exists():
        try:
            file_path.unlink()
        except OSError:
            pass
    return jsonify({"status": "deleted"})


@app.route("/api/media/<int:media_id>/played", methods=["POST"])
def api_media_played(media_id):
    db.increment_play_count(media_id)
    db.set_setting("last_media_id", media_id)
    return jsonify({"status": "ok"})


@app.route("/api/scan", methods=["POST"])
def api_scan():
    payload = request.get_json(force=True, silent=True) or {}
    directory = payload.get("directory", "").strip()
    if not directory:
        return jsonify({"error": "directory is required"}), 400

    root = Path(directory)
    if not root.exists() or not root.is_dir():
        return jsonify({"error": f"directory not found: {directory}"}), 400

    added, skipped, failed = 0, 0, 0
    for file_path in root.rglob("*"):
        if not file_path.is_file():
            continue
        if file_path.suffix.lower() not in ALL_EXTENSIONS:
            continue
        try:
            result = ingest_file(file_path)
            if result is None:
                continue
            _, created = result
            added += 1 if created else 0
            skipped += 0 if created else 1
        except Exception as exc:  # noqa: BLE001
            app.logger.warning("Failed to ingest %s: %s", file_path, exc)
            failed += 1

    return jsonify({"added": added, "skipped": skipped, "failed": failed})


@app.route("/api/upload", methods=["POST"])
def api_upload():
    files = request.files.getlist("files")
    if not files:
        return jsonify({"error": "no files provided"}), 400

    created_items = []
    errors = []
    for file_storage in files:
        original_name = secure_filename(file_storage.filename or "")
        ext = Path(original_name).suffix.lower()
        if ext not in ALL_EXTENSIONS:
            errors.append(f"{file_storage.filename}: unsupported format")
            continue

        unique_name = f"{uuid.uuid4().hex}_{original_name}"
        dest_path = UPLOAD_DIR / unique_name
        file_storage.save(dest_path)

        try:
            result = ingest_file(dest_path, default_title=Path(original_name).stem)
            if result:
                item, _ = result
                created_items.append(item)
        except Exception as exc:  # noqa: BLE001
            app.logger.warning("Failed to ingest upload %s: %s", dest_path, exc)
            errors.append(f"{file_storage.filename}: {exc}")

    return jsonify({"items": created_items, "errors": errors})


# ---------------------------------------------------------------------------
# Routes - YouTube import
# ---------------------------------------------------------------------------

@app.route("/api/youtube/import", methods=["POST"])
def api_youtube_import():
    payload = request.get_json(force=True, silent=True) or {}
    url = (payload.get("url") or "").strip()
    media_kind = payload.get("format", "audio")
    if media_kind not in ("audio", "video"):
        media_kind = "audio"
    if not url:
        return jsonify({"error": "url is required"}), 400

    job_id = uuid.uuid4().hex
    with _youtube_jobs_lock:
        _youtube_jobs[job_id] = {"status": "pending", "total": 0, "completed": 0, "added": 0, "errors": []}

    thread = threading.Thread(target=run_youtube_import, args=(job_id, url, media_kind), daemon=True)
    thread.start()
    return jsonify({"job_id": job_id}), 202


@app.route("/api/youtube/import/<job_id>")
def api_youtube_import_status(job_id):
    with _youtube_jobs_lock:
        job = _youtube_jobs.get(job_id)
    if job is None:
        return jsonify({"error": "unknown job"}), 404
    return jsonify(job)


# ---------------------------------------------------------------------------
# Routes - streaming
# ---------------------------------------------------------------------------

@app.route("/api/stream/<int:media_id>")
def api_stream(media_id):
    item = db.get_media_item(media_id)
    if item is None:
        return jsonify({"error": "not found"}), 404

    source_path = Path(item["file_path"])
    if not source_path.exists():
        return jsonify({"error": "file missing on disk"}), 410

    ext = source_path.suffix.lower()

    if ext in DIRECT_SERVE_EXTENSIONS:
        mimetype = MIME_OVERRIDES.get(ext) or mimetypes.guess_type(str(source_path))[0] or "application/octet-stream"
        return build_range_response(source_path, mimetype)

    # Unsupported container (e.g. .mkv / .avi) - transcode to MP4 on demand, then cache.
    cached_path = TRANSCODE_DIR / f"{media_id}.mp4"
    if cached_path.exists():
        return build_range_response(cached_path, "video/mp4")

    with _transcode_lock:
        status = _transcode_status.get(media_id)
        if status is None:
            _transcode_status[media_id] = "pending"
            thread = threading.Thread(
                target=transcode_to_mp4,
                args=(source_path, cached_path, media_id),
                daemon=True,
            )
            thread.start()
            status = "pending"

    if status == "pending":
        return jsonify({"status": "transcoding"}), 202
    if status.startswith("error"):
        reason = status.split(":", 1)[1] if ":" in status else "unknown"
        return jsonify({"status": "error", "reason": reason}), 503

    # status == "done" but file somehow missing - shouldn't normally happen.
    if cached_path.exists():
        return build_range_response(cached_path, "video/mp4")
    return jsonify({"status": "error", "reason": "transcode-missing"}), 500


# ---------------------------------------------------------------------------
# Routes - playlists
# ---------------------------------------------------------------------------

@app.route("/api/playlists")
def api_playlists_list():
    return jsonify(db.list_playlists())


@app.route("/api/playlists", methods=["POST"])
def api_playlists_create():
    payload = request.get_json(force=True, silent=True) or {}
    name = (payload.get("name") or "").strip() or "New Playlist"
    playlist_id = db.create_playlist(name)
    return jsonify({"id": playlist_id, "name": name})


@app.route("/api/playlists/<int:playlist_id>", methods=["DELETE"])
def api_playlists_delete(playlist_id):
    db.delete_playlist(playlist_id)
    return jsonify({"status": "deleted"})


@app.route("/api/playlists/<int:playlist_id>/items")
def api_playlist_items(playlist_id):
    return jsonify(db.get_playlist_items(playlist_id))


@app.route("/api/playlists/<int:playlist_id>/items", methods=["POST"])
def api_playlist_items_add(playlist_id):
    payload = request.get_json(force=True, silent=True) or {}
    media_id = payload.get("media_id")
    if media_id is None:
        return jsonify({"error": "media_id is required"}), 400
    item_id = db.add_playlist_item(playlist_id, media_id)
    return jsonify({"id": item_id})


@app.route("/api/playlists/<int:playlist_id>/items/<int:item_id>", methods=["DELETE"])
def api_playlist_items_remove(playlist_id, item_id):
    db.remove_playlist_item(item_id)
    return jsonify({"status": "deleted"})


@app.route("/api/playlists/<int:playlist_id>/clear", methods=["POST"])
def api_playlist_clear(playlist_id):
    db.clear_playlist(playlist_id)
    return jsonify({"status": "cleared"})


@app.route("/api/playlists/<int:playlist_id>/reorder", methods=["PUT"])
def api_playlist_reorder(playlist_id):
    payload = request.get_json(force=True, silent=True) or {}
    order = payload.get("order")
    if not isinstance(order, list):
        return jsonify({"error": "order must be a list of playlist_item ids"}), 400
    db.reorder_playlist_items(playlist_id, order)
    return jsonify({"status": "ok"})


# ---------------------------------------------------------------------------
# Routes - settings
# ---------------------------------------------------------------------------

@app.route("/api/settings")
def api_settings_get():
    return jsonify(db.get_all_settings())


@app.route("/api/settings", methods=["POST"])
def api_settings_set():
    payload = request.get_json(force=True, silent=True) or {}
    if "settings" in payload and isinstance(payload["settings"], dict):
        db.set_settings_bulk(payload["settings"])
    elif "key" in payload:
        db.set_setting(payload["key"], payload.get("value", ""))
    else:
        return jsonify({"error": "expected {key, value} or {settings: {...}}"}), 400
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True, threaded=True)
