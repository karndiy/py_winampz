"""
SQLite data layer for WinampZ.

Provides schema initialization and every query the Flask layer needs,
so app.py never touches raw SQL directly.
"""

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "winampz.db"

DEFAULT_EQ_BANDS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]

DEFAULT_SETTINGS = {
    "volume": "80",
    "balance": "0",
    "muted": "0",
    "shuffle": "0",
    "repeat": "none",
    "eq_enabled": "0",
    "eq_preamp": "0",
    "eq_preset": "Flat",
    "eq_bands": json.dumps(DEFAULT_EQ_BANDS),
    "last_media_id": "",
    "active_playlist_id": "",
    "visualizer_mode": "bars",
}


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def get_connection():
    conn = sqlite3.connect(str(DB_PATH), timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def init_db():
    conn = get_connection()
    try:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS media_items (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                title         TEXT NOT NULL,
                artist        TEXT NOT NULL DEFAULT 'Unknown Artist',
                album         TEXT NOT NULL DEFAULT 'Unknown Album',
                genre         TEXT NOT NULL DEFAULT '',
                track_number  INTEGER NOT NULL DEFAULT 0,
                duration      REAL NOT NULL DEFAULT 0,
                file_path     TEXT NOT NULL UNIQUE,
                media_type    TEXT NOT NULL CHECK (media_type IN ('audio', 'video')),
                bitrate       INTEGER NOT NULL DEFAULT 0,
                sample_rate   INTEGER NOT NULL DEFAULT 0,
                filesize      INTEGER NOT NULL DEFAULT 0,
                play_count    INTEGER NOT NULL DEFAULT 0,
                added_at      TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS playlists (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                name        TEXT NOT NULL,
                created_at  TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS playlist_items (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                playlist_id  INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
                media_id     INTEGER NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
                position     INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS settings (
                key    TEXT PRIMARY KEY,
                value  TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_playlist_items_playlist
                ON playlist_items (playlist_id, position);
            """
        )
        conn.commit()

        existing = {row["key"] for row in conn.execute("SELECT key FROM settings")}
        missing = [(k, v) for k, v in DEFAULT_SETTINGS.items() if k not in existing]
        if missing:
            conn.executemany(
                "INSERT INTO settings (key, value) VALUES (?, ?)", missing
            )
            conn.commit()

        default_playlist = conn.execute(
            "SELECT id FROM playlists ORDER BY id LIMIT 1"
        ).fetchone()
        if default_playlist is None:
            conn.execute(
                "INSERT INTO playlists (name, created_at) VALUES (?, ?)",
                ("Default Playlist", now_iso()),
            )
            conn.commit()
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# media_items
# ---------------------------------------------------------------------------

def insert_media_item(data):
    """Insert a media item. If file_path already exists, return the existing id."""
    conn = get_connection()
    try:
        existing = conn.execute(
            "SELECT id FROM media_items WHERE file_path = ?", (data["file_path"],)
        ).fetchone()
        if existing:
            return existing["id"], False

        cur = conn.execute(
            """
            INSERT INTO media_items
                (title, artist, album, genre, track_number, duration, file_path,
                 media_type, bitrate, sample_rate, filesize, play_count, added_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
            """,
            (
                data.get("title", "Unknown Title"),
                data.get("artist", "Unknown Artist"),
                data.get("album", "Unknown Album"),
                data.get("genre", ""),
                data.get("track_number", 0),
                data.get("duration", 0),
                data["file_path"],
                data["media_type"],
                data.get("bitrate", 0),
                data.get("sample_rate", 0),
                data.get("filesize", 0),
                now_iso(),
            ),
        )
        conn.commit()
        return cur.lastrowid, True
    finally:
        conn.close()


def get_media_item(media_id):
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT * FROM media_items WHERE id = ?", (media_id,)
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def list_media_items(search=None, media_type=None):
    conn = get_connection()
    try:
        query = "SELECT * FROM media_items"
        clauses = []
        params = []
        if search:
            clauses.append("(title LIKE ? OR artist LIKE ? OR album LIKE ?)")
            like = f"%{search}%"
            params.extend([like, like, like])
        if media_type:
            clauses.append("media_type = ?")
            params.append(media_type)
        if clauses:
            query += " WHERE " + " AND ".join(clauses)
        query += " ORDER BY artist COLLATE NOCASE, album COLLATE NOCASE, track_number, title COLLATE NOCASE"
        rows = conn.execute(query, params).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def delete_media_item(media_id):
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT file_path FROM media_items WHERE id = ?", (media_id,)
        ).fetchone()
        conn.execute("DELETE FROM media_items WHERE id = ?", (media_id,))
        conn.commit()
        return dict(row) if row else None
    finally:
        conn.close()


def increment_play_count(media_id):
    conn = get_connection()
    try:
        conn.execute(
            "UPDATE media_items SET play_count = play_count + 1 WHERE id = ?",
            (media_id,),
        )
        conn.commit()
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# playlists
# ---------------------------------------------------------------------------

def create_playlist(name):
    conn = get_connection()
    try:
        cur = conn.execute(
            "INSERT INTO playlists (name, created_at) VALUES (?, ?)",
            (name, now_iso()),
        )
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def list_playlists():
    conn = get_connection()
    try:
        rows = conn.execute(
            """
            SELECT p.*, COUNT(pi.id) AS item_count
            FROM playlists p
            LEFT JOIN playlist_items pi ON pi.playlist_id = p.id
            GROUP BY p.id
            ORDER BY p.id
            """
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def delete_playlist(playlist_id):
    conn = get_connection()
    try:
        conn.execute("DELETE FROM playlists WHERE id = ?", (playlist_id,))
        conn.commit()
    finally:
        conn.close()


def get_playlist_items(playlist_id):
    conn = get_connection()
    try:
        rows = conn.execute(
            """
            SELECT pi.id AS playlist_item_id, pi.position, m.*
            FROM playlist_items pi
            JOIN media_items m ON m.id = pi.media_id
            WHERE pi.playlist_id = ?
            ORDER BY pi.position
            """,
            (playlist_id,),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def add_playlist_item(playlist_id, media_id):
    conn = get_connection()
    try:
        max_pos = conn.execute(
            "SELECT MAX(position) AS mx FROM playlist_items WHERE playlist_id = ?",
            (playlist_id,),
        ).fetchone()["mx"]
        next_pos = (max_pos + 1) if max_pos is not None else 0
        cur = conn.execute(
            "INSERT INTO playlist_items (playlist_id, media_id, position) VALUES (?, ?, ?)",
            (playlist_id, media_id, next_pos),
        )
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def remove_playlist_item(playlist_item_id):
    conn = get_connection()
    try:
        conn.execute("DELETE FROM playlist_items WHERE id = ?", (playlist_item_id,))
        conn.commit()
    finally:
        conn.close()


def clear_playlist(playlist_id):
    conn = get_connection()
    try:
        conn.execute("DELETE FROM playlist_items WHERE playlist_id = ?", (playlist_id,))
        conn.commit()
    finally:
        conn.close()


def reorder_playlist_items(playlist_id, ordered_item_ids):
    conn = get_connection()
    try:
        for position, item_id in enumerate(ordered_item_ids):
            conn.execute(
                "UPDATE playlist_items SET position = ? WHERE id = ? AND playlist_id = ?",
                (position, item_id, playlist_id),
            )
        conn.commit()
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# settings
# ---------------------------------------------------------------------------

def get_setting(key, default=None):
    conn = get_connection()
    try:
        row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else default
    finally:
        conn.close()


def set_setting(key, value):
    conn = get_connection()
    try:
        conn.execute(
            """
            INSERT INTO settings (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
            """,
            (key, str(value)),
        )
        conn.commit()
    finally:
        conn.close()


def get_all_settings():
    conn = get_connection()
    try:
        rows = conn.execute("SELECT key, value FROM settings").fetchall()
        return {r["key"]: r["value"] for r in rows}
    finally:
        conn.close()


def set_settings_bulk(mapping):
    conn = get_connection()
    try:
        conn.executemany(
            """
            INSERT INTO settings (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
            """,
            [(k, str(v)) for k, v in mapping.items()],
        )
        conn.commit()
    finally:
        conn.close()
