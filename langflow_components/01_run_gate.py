"""Component 1 of 6: EXPA Run Gate.

Receives the payload from Langflow's Webhook component (fed by a Composio
Google Calendar trigger) and decides whether a run may start.

Fails CLOSED: any doubt means no run. The payload is only used to decide
*whether* to run. It is never used as sign-up data.
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


def _dig(obj, path):
    for part in path.split("."):
        if not isinstance(obj, dict):
            return None
        obj = obj.get(part)
    return obj


class ExpaRunGate(Component):
    display_name = "EXPA Run Gate"
    description = "Decides if a run may start: kill switch, trigger check, replay and overlap protection."
    icon = "shield-check"
    name = "ExpaRunGate"

    inputs = [
        DataInput(
            name="payload",
            display_name="Webhook payload",
            info="Connect the Webhook component here. Leave empty for a manual test run.",
            input_types=["Data"],
            required=False,
        ),
        MessageTextInput(
            name="run_enabled",
            display_name="Runs enabled (kill switch)",
            info="Bind to a global variable EXPA_RUN_ENABLED. Set to 'false' to stop all runs instantly.",
            value="true",
        ),
        MessageTextInput(
            name="expected_trigger_slug",
            display_name="Expected Composio trigger",
            value="GOOGLECALENDAR_EVENT_STARTING_SOON_TRIGGER",
            advanced=True,
        ),
        MessageTextInput(
            name="title_prefix",
            display_name="Calendar event title prefix",
            info="Only calendar events whose title starts with this may start a run.",
            value="EXPA-WELCOME-RUN",
        ),
        IntInput(
            name="min_minutes_between_runs",
            display_name="Min minutes between runs",
            info="Protects against duplicate or bursty deliveries.",
            value=10,
            advanced=True,
        ),
        BoolInput(
            name="allow_manual_run",
            display_name="Allow manual run (no payload)",
            info="Handy for testing in the Playground. Turn OFF in production.",
            value=True,
        ),
        MessageTextInput(name="db_path", display_name="Database path", value="./data/expa_welcome.db", advanced=True),
        SecretStrInput(
            name="webhook_secret_token",
            display_name="Webhook secret token (optional)",
            info="If configured, webhook requests must include this token to start a run, preventing unauthorized triggers.",
            value="",
            advanced=True,
            required=False,
        ),
    ]

    outputs = [
        Output(display_name="Run", name="run", method="open_gate"),
        Output(display_name="Skipped", name="skipped", method="closed_info"),
    ]

    # ---- decision (computed once per component instance) -----------------
    def _decide(self):
        if getattr(self, "_decision", None) is not None:
            return self._decision
        decision = {"open": False, "reason": "", "run_id": None}
        try:
            decision = self._evaluate(decision)
        except Exception as exc:  # fail closed
            decision["open"] = False
            decision["reason"] = f"gate_error:{type(exc).__name__}"
        self._decision = decision
        return decision

    def _evaluate(self, d):
        if str(self.run_enabled).strip().lower() in {"false", "0", "no", "off", "disabled"}:
            d["reason"] = "kill_switch_off"
            return self._log_closed(d)

        raw = _unwrap(self.payload)
        if isinstance(raw.get("payload"), str):
            try:
                raw = json.loads(raw["payload"])
            except ValueError:
                pass
        manual = not raw

        secret_expected = str(getattr(self, "webhook_secret_token", "") or os.environ.get("EXPA_WEBHOOK_SECRET", "")).strip()
        if not manual and secret_expected:
            incoming_secret = (
                _dig(raw, "metadata.secret")
                or _dig(raw, "metadata.token")
                or raw.get("secret")
                or raw.get("token")
                or raw.get("auth_token")
                or _dig(raw, "data.secret")
            )
            if not incoming_secret or str(incoming_secret).strip() != secret_expected:
                d["reason"] = "unauthorized_webhook_token"
                return self._log_closed(d)

        if manual:
            if not self.allow_manual_run:
                d["reason"] = "no_payload"
                return self._log_closed(d)
            trigger_key = f"manual-{_now()}-{uuid.uuid4().hex[:6]}"
        else:
            slug = _dig(raw, "metadata.trigger_slug") or raw.get("trigger_slug") or raw.get("triggerName")
            if slug != self.expected_trigger_slug:
                d["reason"] = "wrong_trigger"
                return self._log_closed(d)
            title = _dig(raw, "data.summary") or _dig(raw, "data.title") or ""
            if not str(title).startswith(self.title_prefix):
                d["reason"] = "title_mismatch"
                return self._log_closed(d)
            event_id = _dig(raw, "data.id") or raw.get("id")
            if not event_id:
                d["reason"] = "no_event_id"
                return self._log_closed(d)
            start = _dig(raw, "data.start.dateTime") or _dig(raw, "data.start") or ""
            trigger_key = f"{event_id}@{start}"

        conn = _connect(self.db_path)
        try:
            if conn.execute("SELECT 1 FROM runs WHERE trigger_key=?", (trigger_key,)).fetchone():
                d["reason"] = "replay"
                _event(conn, "gate", "gate", "info", "skipped", d["reason"])
                return d
            if not manual and int(self.min_minutes_between_runs) > 0:
                cutoff = (
                    datetime.now(timezone.utc) - timedelta(minutes=int(self.min_minutes_between_runs))
                ).strftime("%Y-%m-%dT%H:%M:%SZ")
                if conn.execute("SELECT 1 FROM runs WHERE started_at>=?", (cutoff,)).fetchone():
                    d["reason"] = "too_soon_after_previous_run"
                    _event(conn, "gate", "gate", "info", "skipped", d["reason"])
                    return d
            run_id = f"run-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:4]}"
            conn.execute(
                "INSERT INTO runs (run_id, trigger_key, started_at, status) VALUES (?,?,?,?)",
                (run_id, trigger_key, _now(), "running"),
            )
            conn.commit()
            _event(conn, run_id, "gate", "info", "opened", "manual" if manual else "calendar_trigger")
            d.update({"open": True, "reason": "ok", "run_id": run_id})
            return d
        finally:
            conn.close()

    def _log_closed(self, d):
        conn = _connect(self.db_path)
        try:
            _event(conn, "gate", "gate", "info", "skipped", d["reason"])
        finally:
            conn.close()
        return d

    # ---- outputs ----------------------------------------------------------
    def open_gate(self) -> Data:
        d = self._decide()
        if not d["open"]:
            self.stop("run")
            self.status = f"Closed: {d['reason']}"
            return Data(data={"run_id": None, "halt": True, "halt_reason": d["reason"], "records": [], "counts": {}})
        self.status = f"Open: {d['run_id']}"
        return Data(data={"run_id": d["run_id"], "halt": False, "halt_reason": None, "records": [], "counts": {}})

    def closed_info(self) -> Data:
        d = self._decide()
        if d["open"]:
            self.stop("skipped")
        return Data(data={"skipped": not d["open"], "reason": d["reason"]})
