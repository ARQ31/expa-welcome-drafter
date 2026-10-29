"""Component 3 of 6: Validate & Normalize.

Cleans each sign-up (phone to +62 format, name, programme, language) and
rejects anything unsafe or unusable. Every rejection is logged with a reason
so a human can fix it. Rejected rows never get a message.
"""
import unicodedata

from langflow.custom import Component
from langflow.io import DataInput, MessageTextInput, Output
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

PROGRAMMES = {"gv": "GV", "gta": "GTa", "gte": "GTe"}
NAME_RE = re.compile(r"[^\W\d_]+(?:[ .'\-][^\W\d_]+)*\.?")


def normalize_phone(raw):
    """Return (e164, flag, error). Accepts 08.., 8.., 62.., +62.., 0062.. formats."""
    text = str(raw or "").strip()
    if not text:
        return None, None, "missing_phone"
    if re.search(r"[A-Za-z]", text):
        return None, None, "phone_has_letters"
    digits = re.sub(r"\D", "", text)
    international = text.startswith("+")
    if digits.startswith("00"):
        digits, international = digits[2:], True
    if international and not digits.startswith("62"):
        if 8 <= len(digits) <= 15:
            return "+" + digits, "intl", None
        return None, None, "phone_bad_length"
    if digits.startswith("62"):
        rest = digits[2:]
    elif digits.startswith("0"):
        rest = digits[1:]
    elif digits.startswith("8"):
        rest = digits
    else:
        return None, None, "phone_unrecognized_format"
    if not rest.startswith("8"):
        return None, None, "phone_not_mobile"
    if not 9 <= len(rest) <= 12:
        return None, None, "phone_bad_length"
    return "+62" + rest, None, None


def normalize_name(raw):
    """Return (clean_full_name, clean_first_name, error)."""
    text = "".join(ch for ch in str(raw or "") if not unicodedata.category(ch).startswith(("S", "C")))
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return None, None, "missing_name"
    if len(text) > 50 or len(text.split()) > 5:
        return None, None, "suspicious_name"  # also blocks pasted instructions
    if not NAME_RE.fullmatch(text):
        return None, None, "suspicious_name"
    words = []
    for w in text.split(" "):
        if len(w) > 1 and (w == w.upper() or w == w.lower() or w[0].islower()):
            w = w[0].upper() + w[1:].lower()
        words.append(w)
    clean_full = " ".join(words).strip()
    clean_first = words[0].strip(".")
    if len(clean_first) < 2:
        return None, None, "name_too_short"
    return clean_full, clean_first, None


def validate_record(rec):
    """Return (clean_record, None) or (None, reason)."""
    expa_id = str(rec.get("id") or "").strip()
    if not expa_id:
        return None, "missing_expa_id"
    phone, flag, err = normalize_phone(rec.get("phone"))
    if err:
        return None, err
    full, first, err = normalize_name(rec.get("full_name"))
    if err:
        return None, err
    prog = PROGRAMMES.get(str(rec.get("programme") or "").strip().lower())
    if not prog:
        return None, "unknown_programme"
    lang = str(rec.get("language") or "id").strip().lower()
    lc_raw = str(rec.get("lc") or "").strip()
    lc_clean = re.sub(r"[^\w\s.\-]", "", lc_raw)
    lc = re.sub(r"\s+", " ", lc_clean).strip()[:40] or None
    flags = [f for f in (flag,) if f]
    return {
        "expa_id": expa_id,
        "first_name": first or full,
        "full_name": full or first,
        "phone_e164": phone,
        "programme": prog,
        "lc": lc,
        "language": lang if lang in {"id", "en"} else "id",
        "flags": flags,
    }, None


class ValidateNormalize(Component):
    display_name = "Validate & Normalize"
    description = "Cleans sign-ups, rejects unusable or suspicious rows and logs why."
    icon = "list-checks"
    name = "ValidateNormalize"

    inputs = [
        DataInput(name="upstream", display_name="From Sign-ups", input_types=["Data"]),
        MessageTextInput(name="db_path", display_name="Database path", value="./data/expa_welcome.db", advanced=True),
    ]
    outputs = [Output(display_name="Valid sign-ups", name="valid", method="validate")]

    def validate(self) -> Data:
        p = _unwrap(self.upstream)
        if p.get("halt"):
            return Data(data=p)
        conn = _connect(self.db_path)
        try:
            valid, rejected = [], 0
            for rec in p.get("records", []):
                clean, reason = validate_record(rec)
                if clean:
                    valid.append(clean)
                    continue
                rejected += 1
                eid = str(rec.get("id") or "").strip()
                key = f"e:{eid}" if eid else "x:" + hashlib.sha1(json.dumps(rec, sort_keys=True, default=str).encode()).hexdigest()[:12]
                now = _now()
                # Rejected rows keep NO name and only a masked phone.
                conn.execute(
                    "INSERT INTO contacts (contact_key, expa_id, phone_masked, programme, status, reason, attempts,"
                    " first_seen_run, last_run, created_at, updated_at) VALUES (?,?,?,?,?,?,0,?,?,?,?)"
                    " ON CONFLICT(contact_key) DO UPDATE SET reason=excluded.reason, last_run=excluded.last_run,"
                    " updated_at=excluded.updated_at WHERE contacts.status='rejected'",
                    (key, eid or None, _mask_phone(rec.get("phone")), None, "rejected", reason, p["run_id"], p["run_id"], now, now),
                )
                _event(conn, p["run_id"], "validate", "info", "rejected", reason, key)
            conn.commit()
            for rec in valid:
                _event(conn, p["run_id"], "validate", "info", "valid", ",".join(rec["flags"]), f"e:{rec['expa_id']}")
            p["records"] = valid
            p["counts"] = {**p.get("counts", {}), "valid": len(valid), "rejected": rejected}
            self.status = f"{len(valid)} valid, {rejected} rejected"
        except Exception as exc:
            p = _fail(conn, p, "validate", exc)
        finally:
            conn.close()
        return Data(data=p)
