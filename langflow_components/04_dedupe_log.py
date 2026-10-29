"""Component 4 of 6: Dedupe & Log.

* Skips anyone already known: same EXPA id OR same phone (even re-registered
  under a new id or typed in a different format).
* Writes the contact row BEFORE any message is drafted (safe to re-run).
* Picks the work for THIS run: up to `batch_size` contacts from the backlog,
  so thousands of sign-ups are spread over several scheduled runs.
* Clears personal data from old rows after `retention_days` (keeps only the
  salted phone hash, so duplicates are still caught).
"""
from langflow.custom import Component
from langflow.io import BoolInput, DataInput, IntInput, MessageTextInput, Output, SecretStrInput
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


def phone_hash(salt, phone):
    return hmac.new(salt.encode(), phone.encode(), hashlib.sha256).hexdigest()[:32]


class DedupeAndLog(Component):
    display_name = "Dedupe & Log"
    description = "Skips known contacts, logs every contact, selects this run's batch."
    icon = "database"
    name = "DedupeAndLog"

    inputs = [
        DataInput(name="upstream", display_name="From Validate", input_types=["Data"]),
        SecretStrInput(
            name="dedupe_salt",
            display_name="Dedupe salt (secret)",
            info="Bind to a global variable DEDUPE_SALT. Falls back to the DEDUPE_SALT environment variable.",
            required=False,
        ),
        IntInput(name="batch_size", display_name="Batch size per run", value=50),
        IntInput(name="max_attempts", display_name="Max draft attempts per contact", value=3, advanced=True),
        IntInput(name="retention_days", display_name="Keep personal data (days)", value=30, advanced=True),
        BoolInput(name="allow_dev_salt", display_name="Allow dev salt (testing only)", value=False, advanced=True),
        MessageTextInput(name="db_path", display_name="Database path", value="./data/expa_welcome.db", advanced=True),
    ]
    outputs = [Output(display_name="To draft", name="to_draft", method="process")]

    def _scrub(self, conn, days):
        cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")
        cur = conn.execute(
            "UPDATE contacts SET phone_e164=NULL, first_name=NULL, full_name=NULL, draft_text=NULL, lc=NULL, updated_at=?"
            " WHERE created_at<? AND status NOT IN ('pending','draft_failed')"
            " AND (phone_e164 IS NOT NULL OR first_name IS NOT NULL OR draft_text IS NOT NULL)",
            (_now(), cutoff),
        )
        conn.commit()
        return cur.rowcount

    def process(self) -> Data:
        p = _unwrap(self.upstream)
        if p.get("halt"):
            return Data(data=p)
        conn = _connect(self.db_path)
        try:
            salt = str(self.dedupe_salt or os.environ.get("DEDUPE_SALT", "")).strip()
            if not salt:
                if not self.allow_dev_salt:
                    raise RuntimeError("DEDUPE_SALT is not set")
                salt = "dev-only-salt"
                _event(conn, p["run_id"], "dedupe", "warn", "insecure_dev_salt", "SECURITY WARNING: using default dev salt. Configure DEDUPE_SALT to secure personal data.")
            run_id, now = p["run_id"], _now()
            scrubbed = self._scrub(conn, int(self.retention_days))
            stats = {"new": 0, "duplicate": 0, "already_queued": 0, "revalidated": 0}

            for rec in p.get("records", []):
                key = f"e:{rec['expa_id']}"
                ph = phone_hash(salt, rec["phone_e164"])
                phone_dup = conn.execute(
                    "SELECT contact_key FROM contacts WHERE (phone_hash=? OR phone_e164=?) AND contact_key!=? AND status!='rejected' LIMIT 1",
                    (ph, rec["phone_e164"], key),
                ).fetchone()
                if phone_dup is not None:
                    why = f"same_phone_as:{phone_dup['contact_key']}"
                    conn.execute(
                        "UPDATE contacts SET status='rejected', reason=?, draft_text='', updated_at=? WHERE contact_key=? AND status!='contacted'",
                        (why, now, key),
                    )
                    stats["duplicate"] += 1
                    _event(conn, run_id, "dedupe", "info", "skipped_duplicate", why, key)
                    conn.commit()
                    continue
                row = conn.execute(
                    "SELECT contact_key, status, first_seen_run FROM contacts WHERE contact_key=? OR phone_hash=?"
                    " ORDER BY (contact_key=?) DESC LIMIT 1",
                    (key, ph, key),
                ).fetchone()
                values = (
                    rec["expa_id"], ph, rec["phone_e164"], _mask_phone(rec["phone_e164"]), rec["first_name"], rec.get("full_name") or rec["first_name"],
                    rec["programme"], rec["lc"], rec["language"],
                )
                if row is None:
                    conn.execute(
                        "INSERT INTO contacts (expa_id, phone_hash, phone_e164, phone_masked, first_name, full_name, programme, lc,"
                        " language, contact_key, status, attempts, first_seen_run, last_run, created_at, updated_at)"
                        " VALUES (?,?,?,?,?,?,?,?,?,?,'pending',0,?,?,?,?)",
                        values + (key, run_id, run_id, now, now),
                    )
                    stats["new"] += 1
                    _event(conn, run_id, "dedupe", "info", "new", "", key)
                elif row["status"] == "rejected":
                    conn.execute(
                        "UPDATE contacts SET expa_id=?, phone_hash=?, phone_e164=?, phone_masked=?, first_name=?, full_name=?, programme=?,"
                        " lc=?, language=?, status='pending', reason=NULL, last_run=?, updated_at=? WHERE contact_key=?",
                        values + (run_id, now, row["contact_key"]),
                    )
                    stats["revalidated"] += 1
                    _event(conn, run_id, "dedupe", "info", "revalidated", "", key)
                elif (
                    row["contact_key"] == key
                    and row["status"] in ("pending", "draft_failed")
                    and row["first_seen_run"] != run_id
                ):
                    # same sign-up seen again while still waiting for its draft (e.g. deferred by the batch cap)
                    stats["already_queued"] += 1
                    _event(conn, run_id, "dedupe", "info", "already_queued", "", key)
                else:
                    # repeat inside this batch, already handled, or same phone under a different id
                    why = "same_expa_id" if row["contact_key"] == key else f"same_phone_as:{row['contact_key']}"
                    stats["duplicate"] += 1
                    _event(conn, run_id, "dedupe", "info", "skipped_duplicate", why, key)
                    if row["contact_key"] == key and rec.get("full_name"):
                        conn.execute("UPDATE contacts SET full_name=COALESCE(NULLIF(full_name, ''), ?) WHERE contact_key=?", (rec["full_name"], key))
                conn.commit()

            # contacts that already used all attempts need a human
            max_attempts = int(self.max_attempts)
            stuck = conn.execute(
                "SELECT contact_key FROM contacts WHERE status IN ('pending','draft_failed') AND attempts>=?",
                (max_attempts,),
            ).fetchall()
            for r in stuck:
                conn.execute("UPDATE contacts SET status='needs_human', updated_at=? WHERE contact_key=?", (now, r["contact_key"]))
                _event(conn, run_id, "dedupe", "warn", "needs_human", "max attempts reached", r["contact_key"])
            conn.commit()

            backlog = conn.execute(
                "SELECT contact_key, first_name, full_name, programme, lc, language, attempts FROM contacts"
                " WHERE status IN ('pending','draft_failed') ORDER BY created_at, contact_key"
            ).fetchall()
            batch = [dict(r) for r in backlog[: int(self.batch_size)]]
            deferred = len(backlog) - len(batch)

            p["records"] = batch
            p["counts"] = {
                **p.get("counts", {}), **stats, "needs_human_now": len(stuck),
                "to_draft": len(batch), "deferred": deferred, "scrubbed": scrubbed,
            }
            self.status = f"{stats['new']} new, {stats['duplicate']} dup, batch {len(batch)}, deferred {deferred}"
        except Exception as exc:
            p = _fail(conn, p, "dedupe", exc)
        finally:
            conn.close()
        return Data(data=p)
