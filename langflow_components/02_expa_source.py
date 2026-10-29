"""Component 2 of 6: EXPA Sign-ups (mock).

Reads sign-ups from a JSON file so the prototype needs no EXPA access.
To go live, replace ONLY this component with one that calls EXPA. The contract
is simple: output `records` = list of dicts with the keys

    id, full_name, email, phone, programme, lc, language, signed_up_at

Everything downstream stays the same.
"""
from langflow.custom import Component
from langflow.io import DataInput, IntInput, MessageTextInput, Output
from langflow.schema import Data

# --- SHARED:BEGIN (identical in every component file; Langflow components must be standalone) ---
import hashlib
import hmac
import json
import os
import re
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY, trigger_key TEXT UNIQUE, started_at TEXT, finished_at TEXT,
  status TEXT, summary TEXT);
CREATE TABLE IF NOT EXISTS contacts (
  contact_key TEXT PRIMARY KEY, expa_id TEXT, phone_hash TEXT, phone_e164 TEXT, phone_masked TEXT,
  first_name TEXT, full_name TEXT, programme TEXT, lc TEXT, language TEXT, status TEXT, reason TEXT,
  attempts INTEGER DEFAULT 0, draft_text TEXT, draft_source TEXT,
  first_seen_run TEXT, last_run TEXT, created_at TEXT, updated_at TEXT);
CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone_hash);
CREATE INDEX IF NOT EXISTS idx_contacts_status ON contacts(status);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, ts TEXT, stage TEXT, level TEXT,
  contact_key TEXT, outcome TEXT, message TEXT);
"""


def _now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _connect(db_path):
    folder = os.path.dirname(os.path.abspath(db_path))
    os.makedirs(folder, exist_ok=True)
    conn = sqlite3.connect(db_path, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript(SCHEMA)
    try:
        conn.execute("ALTER TABLE contacts ADD COLUMN full_name TEXT")
        conn.commit()
    except Exception:
        pass
    try:
        os.chmod(db_path, 0o600)  # owner-only: the DB holds personal data
    except OSError:
        pass
    return conn


def _event(conn, run_id, stage, level, outcome, message="", contact_key=None):
    conn.execute(
        "INSERT INTO events (run_id, ts, stage, level, contact_key, outcome, message) VALUES (?,?,?,?,?,?,?)",
        (run_id, _now(), stage, level, contact_key, outcome, message),
    )
    conn.commit()


def _mask_phone(p):
    raw = str(p or "")
    digits = re.sub(r"\D", "", raw)
    if len(digits) < 6:
        return "***"
    return ("+" if raw.strip().startswith("+") else "") + digits[:4] + "****" + digits[-3:]


def _redact(text):
    text = re.sub(r"[\w.+-]+@[\w-]+\.[\w.-]+", "<email>", str(text))
    text = re.sub(r"\+?\d[\d\s().-]{5,}\d", "<num>", text)
    return text[:200]


def _unwrap(x):
    if isinstance(x, list):
        x = x[0] if x else {}
    d = getattr(x, "data", x)
    return dict(d) if isinstance(d, dict) else {}


def _fail(conn, p, stage, exc):
    """Record a stage failure without raising, so the final alert step still runs."""
    _event(conn, p.get("run_id"), stage, "error", "stage_failed", f"{type(exc).__name__}: {_redact(exc)}")
    p["halt"] = True
    p["halt_reason"] = f"{stage}: {type(exc).__name__}"
    return p
# --- SHARED:END ---


class ExpaSignupsMock(Component):
    display_name = "EXPA Sign-ups (Mock)"
    description = "Loads mock EXPA sign-ups from a JSON file. Swap for the real EXPA call later."
    icon = "download"
    name = "ExpaSignupsMock"

    inputs = [
        DataInput(name="upstream", display_name="From Run Gate", input_types=["Data"]),
        MessageTextInput(name="file_path", display_name="Mock sign-ups file", value="./data/mock_expa_signups.json"),
        IntInput(name="max_rows", display_name="Max rows per run", value=5000, advanced=True),
        MessageTextInput(name="db_path", display_name="Database path", value="./data/expa_welcome.db", advanced=True),
    ]
    outputs = [Output(display_name="Sign-ups", name="signups", method="fetch")]

    def fetch(self) -> Data:
        p = _unwrap(self.upstream)
        if p.get("halt"):
            return Data(data=p)
        file_path = self.file_path
        if not os.path.exists(file_path):
            base = os.environ.get("EXPA_WORKSPACE_DIR") or os.path.dirname(os.path.dirname(os.path.abspath(self.db_path)))
            candidates = [
                os.path.join(base, file_path.lstrip("./\\")),
                os.path.join(r"C:\Users\ariqm\Downloads\Application IID\expa-welcome-drafter", file_path.lstrip("./\\")),
                os.path.join(r"C:\Users\ariqm\Downloads\Application IID\expa-welcome-drafter", "data", os.path.basename(file_path)),
            ]
            for cand in candidates:
                if os.path.exists(cand):
                    file_path = cand
                    break
        conn = _connect(self.db_path)
        try:
            with open(file_path, encoding="utf-8") as fh:
                rows = json.load(fh)
            if not isinstance(rows, list):
                raise ValueError("sign-ups file must contain a JSON list")
            rows = rows[: int(self.max_rows)]
            p["records"] = rows
            p["counts"] = {"received": len(rows)}
            _event(conn, p["run_id"], "source", "info", "fetched", f"{len(rows)} sign-ups")
            self.status = f"{len(rows)} sign-ups"
        except Exception as exc:
            p = _fail(conn, p, "source", exc)
        finally:
            conn.close()
        return Data(data=p)
