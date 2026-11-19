# WinampZ

A web-based, Winamp-inspired media player built with Flask + SQLite on the
backend and vanilla JS + the Web Audio API on the frontend. Supports local
audio/video libraries, drag-and-drop uploads, folder scanning, YouTube
playlist/video import, a 10-band graphic equalizer, a real-time spectrum
visualizer, and a draggable multi-window Winamp-style UI (main player, EQ,
playlist editor, video viewport, media library).

## Directory layout

```
py-winampz/
├── app.py                  # Flask routes, metadata extraction, streaming, YouTube import
├── database.py              # SQLite schema + all data-access helpers
├── requirements.txt
├── templates/
│   └── index.html           # Winamp-style modular window layout
├── static/
│   ├── css/winamp.css       # Retro metallic / neon LCD theme
│   ├── js/player.js         # Playback engine, Web Audio EQ + visualizer, UI wiring
│   ├── uploads/             # Uploaded + scanned-in-place files land here (gitignored)
│   └── transcoded/          # Cached on-the-fly video transcodes (gitignored)
└── winampz.db                # SQLite database (created automatically on first run)
```

## 1. Prerequisites

- **Python 3.9+**
- **ffmpeg** (optional, but recommended) — provides:
  - `ffprobe` for extracting duration/bitrate/sample-rate from video files
  - on-the-fly transcoding of browser-unfriendly containers (`.mkv`, `.avi`) to MP4 so they can be streamed and played
  - the audio extraction / muxing used by YouTube import
  Without ffmpeg installed, everything else still works: audio metadata (via `mutagen`) is unaffected, `.mp4`/`.webm` stream natively, and `.mkv`/`.avi` playback will report a clear "ffmpeg not installed" error instead of crashing.
  - Windows: `winget install ffmpeg` or download from https://ffmpeg.org and add it to PATH
  - macOS: `brew install ffmpeg`
  - Linux: `sudo apt install ffmpeg` (Debian/Ubuntu) or your distro's equivalent

## 2. Setup

```bash
# from the project root
cd py-winampz

# (recommended) create a virtual environment
python -m venv .venv
.venv\Scripts\activate        # Windows
# source .venv/bin/activate   # macOS/Linux

# install dependencies
pip install -r requirements.txt
```

`requirements.txt` installs Flask, mutagen (audio tag/stream reading),
Werkzeug, and yt-dlp (YouTube import). ffmpeg itself is a system binary and
is installed separately (see above), not via pip.

## 3. Run

```bash
python app.py
```

The server starts on **http://127.0.0.1:5000** (listens on `0.0.0.0:5000`, so
it's reachable from other devices on your network at your machine's LAN IP
too). Open that URL in a modern browser (Chrome, Edge, or Firefox
recommended for the broadest native codec + Web Audio API support).

On first run, `database.py` automatically creates `winampz.db` with the full
schema and a seeded "Default Playlist" plus default settings — no manual
migration step needed.

## 4. Using the app

- **Add media**: open the **MEDIA LIBRARY** window (`LIB` button) and either
  - drag & drop files onto the dropzone, or click "browse…", or
  - type a local folder path (e.g. `C:\Music`) and click **SCAN** to recursively
    import every supported audio/video file in that folder, or
  - paste a YouTube video or playlist URL, choose Audio/Video, and click
    **IMPORT** — this downloads the content via `yt-dlp` into your library and
    (for playlists) creates a new playlist containing the imported tracks.
    *Only import content you have the rights to use/download — this feature
    is for personal media management, so please respect copyright and
    YouTube's Terms of Service.*
- **Build a playlist**: double-click a library item to add it to the active
  playlist and start playing it, or right-click for a context menu (Play /
  Add to Playlist / Remove / File Info).
- **Playlist editor** (`PL` button): drag rows to reorder, double-click to
  jump to a track, use the `+`/`-` buttons to create/delete playlists, and
  the dropdown to switch between playlists.
- **Equalizer** (`EQ` button): flip "ON" to enable the 10-band EQ, drag the
  vertical sliders or pick a preset (Rock / Pop / Jazz / Bass Boost / Flat),
  and adjust the preamp. Settings persist automatically.
- **Video**: playing a video file automatically opens the **VIDEO** window;
  use the `[ ]` button for fullscreen.
- **Transport**: prev/play/pause/stop/next, shuffle, repeat
  (none → all → one), and a spectrum/oscilloscope visualizer toggle (`BARS`/`SCOPE`)
  live in the main window, along with volume/balance sliders and a seek bar.
  Click the LCD time display to toggle elapsed/remaining time.
- Every window's titlebar can be **dragged** anywhere on screen, Winamp-style.

All player state — volume, balance, EQ settings, shuffle/repeat, the active
playlist, and the last-played track — is persisted to the `settings` table
and restored the next time you load the page.

## 5. Notes on streaming & transcoding

- `/api/stream/<id>` implements proper HTTP Range requests (`206 Partial
  Content`), so seeking/scrubbing in large audio/video files is smooth and
  doesn't require downloading the whole file first.
- `.mp3/.wav/.ogg/.flac/.m4a/.aac/.mp4/.webm` are streamed directly from disk.
- `.mkv/.avi` (and other containers browsers can't play natively) are
  transcoded to MP4 (H.264/AAC) on first request via ffmpeg, in a background
  thread, then cached under `static/transcoded/` for all future requests.
  While transcoding, the API returns `202 Accepted` and the UI shows a
  "TRANSCODING..." overlay until the cached file is ready (polled automatically).

## 6. Troubleshooting

- **"yt-dlp is not installed"** — run `pip install -r requirements.txt` again, or `pip install yt-dlp` directly.
- **YouTube import fails to read a URL** — YouTube periodically changes its site in ways that break extraction until yt-dlp is updated; run `pip install --upgrade yt-dlp` and try again.
- **"Please sign in" / "Sign in to confirm you're not a bot"** — some videos (age-restricted, or ones YouTube's anti-bot check has flagged) require an authenticated session. Enable one of:
  - **Browser cookies (easiest)**: close the browser first (it locks its cookie database), then set an environment variable before starting the app, with a browser you're already logged into YouTube on:
    ```bash
    # Windows PowerShell
    $env:YOUTUBE_COOKIES_FROM_BROWSER = "chrome"   # or edge / firefox / brave / opera / vivaldi / safari
    python app.py
    ```
    ```bash
    # macOS / Linux
    export YOUTUBE_COOKIES_FROM_BROWSER=chrome
    python app.py
    ```
    Use `browser:ProfileName` (e.g. `chrome:Profile 2`) to pick a specific profile.
  - **cookies.txt file**: export your YouTube cookies (e.g. with the "Get cookies.txt LOCALLY" browser extension) while logged in, and save the file as `youtube_cookies.txt` in the project root. It's gitignored automatically since it contains sensitive session data - never share it.
  - Neither is needed for ordinary public videos; this is only a fallback for restricted content.
- **Video with no duration/bitrate shown** — ffmpeg/ffprobe isn't on your PATH; install it (step 1) and re-scan/re-upload.
- **`.mkv`/`.avi` stuck on "TRANSCODING..."** — check the terminal running `app.py` for an ffmpeg error (e.g. an unsupported codec in the source file); verify `ffmpeg -version` works in your terminal.
- **No sound** — browsers block audio until a user gesture; click a transport button once to let the page's `AudioContext` resume.
