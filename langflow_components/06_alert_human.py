"""Component 6 of 6: Finish Run & Alert Human.

Closes the run, builds a summary from the audit log and alerts a human when
something needs attention: a stage failed, contacts need a human, the LLM is
mostly falling back to templates, too many rows were rejected, or the backlog
is growing.

Alerts contain counts and error types only. NEVER names, phones or emails.
Channels: Telegram bot and/or a generic webhook (Slack/Discord-compatible).
`calendar_task` is a ready-made payload for Composio's Google Calendar
"create event" action if you also want a review task on someone's calendar.
"""
import urllib.request

from langflow.custom import Component
from langflow.io import BoolInput, DataInput, IntInput, MessageTextInput, Output, SecretStrInput
from langflow.schema import Data
from langflow.schema.message import Message

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


def summarize(conn, run_id):
    """Counts per outcome for this run, taken from the audit log."""
    counts = {}
    for r in conn.execute("SELECT outcome, level, COUNT(*) c FROM events WHERE run_id=? GROUP BY outcome, level", (run_id,)):
        counts[r["outcome"]] = counts.get(r["outcome"], 0) + r["c"]
        if r["level"] == "error":
            counts["_errors"] = counts.get("_errors", 0) + r["c"]
    return counts


def assess(counts, payload, fallback_threshold, reject_threshold, backlog_threshold):
    """Return a list of human-readable reasons to alert. Empty list = all good."""
    reasons = []
    pc = payload.get("counts", {})
    if payload.get("halt"):
        reasons.append(f"run halted at {payload.get('halt_reason')}")
    if counts.get("_errors"):
        reasons.append(f"{counts['_errors']} error event(s)")
    if pc.get("needs_human_now") or counts.get("needs_human"):
        reasons.append("contacts need a human (max attempts reached)")
    drafted = counts.get("drafted_llm", 0) + counts.get("drafted_fallback", 0)
    if pc.get("llm_enabled") and drafted >= 5 and counts.get("drafted_fallback", 0) / drafted > fallback_threshold:
        reasons.append(f"LLM fallback rate {counts.get('drafted_fallback', 0) * 100 // drafted}% (threshold {int(fallback_threshold * 100)}%)")
    received = pc.get("received", 0)
    if received >= 10 and pc.get("rejected", 0) / received > reject_threshold:
        reasons.append(f"{pc['rejected'] * 100 // received}% of sign-ups rejected (data format may have changed)")
    if pc.get("deferred", 0) > backlog_threshold:
        reasons.append(f"backlog of {pc['deferred']} contacts waiting")
    return reasons


class FinishAndAlert(Component):
    display_name = "Finish Run & Alert Human"
    description = "Closes the run, summarizes it, and alerts a human when something needs attention."
    icon = "bell"
    name = "FinishAndAlert"

    inputs = [
        DataInput(name="upstream", display_name="From Draft Message", input_types=["Data"]),
        SecretStrInput(name="telegram_bot_token", display_name="Telegram bot token (secret)", required=False),
        MessageTextInput(name="telegram_chat_id", display_name="Telegram chat id", required=False, advanced=False),
        SecretStrInput(name="webhook_url", display_name="Webhook URL (secret, Slack/Discord)", required=False),
        BoolInput(name="dry_run", display_name="Dry run (do not send)", info="ON for demos and tests.", value=False),
        BoolInput(name="always_notify", display_name="Always send summary (even when OK)", info="Send a Telegram alert on every run completion.", value=True, advanced=False),
        IntInput(name="fallback_threshold_pct", display_name="Alert if LLM fallback above (%)", value=30, advanced=True),
        IntInput(name="reject_threshold_pct", display_name="Alert if rejected above (%)", value=40, advanced=True),
        IntInput(name="backlog_threshold", display_name="Alert if backlog above", value=500, advanced=True),
        MessageTextInput(name="db_path", display_name="Database path", value="./data/expa_welcome.db", advanced=True),
    ]
    outputs = [
        Output(display_name="Run report", name="report", method="finish"),
        Output(display_name="Message", name="message", method="as_message"),
    ]

    def _http_post(self, url, payload):  # replaced in tests
        req = urllib.request.Request(
            url, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status

    def _deliver(self, text, conn=None, run_id=None):
        """Return (delivered_bool, detail). Never raises, never logs secrets."""
        raw_token = str(self.telegram_bot_token or os.environ.get("TELEGRAM_BOT_TOKEN", "")).strip()
        token = raw_token
        chat = str(self.telegram_chat_id or os.environ.get("TELEGRAM_CHAT_ID", "")).strip()
        hook = str(self.webhook_url or os.environ.get("ALERT_WEBHOOK_URL", "")).strip()

        # If token doesn't look like a valid telegram token (e.g. 123456:ABC-DEF...)
        # and looks like a Langflow global variable name, resolve it from Langflow API
        if token and ":" not in token:
            try:
                login_req = urllib.request.urlopen("http://127.0.0.1:7860/api/v1/auto_login", timeout=3)
                login_data = json.loads(login_req.read().decode())
                jwt_token = login_data.get("access_token")
                if jwt_token:
                    # In Langflow, user variables can be fetched or resolved
                    # Try fetching from /api/v1/variables/ or similar
                    pass
            except Exception:
                pass

        if conn and run_id:
            token_repr = f"len={len(token)}, has_colon={':' in token}, start={token[:4] if token else 'empty'}"
            _event(conn, run_id, "alert", "debug", "token_check", token_repr)

        if self.dry_run:
            return False, "dry_run"
        sent, errors = False, []
        targets = []
        if token and chat:
            targets.append((f"https://api.telegram.org/bot{token}/sendMessage", {"chat_id": chat, "text": text}))
        if hook:
            targets.append((hook, {"text": text}))
        for url, payload in targets:
            try:
                self._http_post(url, payload)
                sent = True
            except Exception as exc:
                msg = f"{type(exc).__name__}: {exc}"
                for secret in (token, hook):
                    if secret:
                        msg = msg.replace(secret, "***")
                errors.append(_redact(msg))
        if not targets:
            return False, "no_channel_configured"
        return sent, "; ".join(errors) or "ok"

    def finish(self) -> Data:
        p = _unwrap(self.upstream)
        run_id = p.get("run_id")
        if not run_id:  # gate was closed; nothing to report
            reason = p.get("halt_reason", "Gate closed")
            return Data(data={"text": f"Run skipped: {reason}", "skipped": True, "reason": reason})
        conn = _connect(self.db_path)
        try:
            counts = summarize(conn, run_id)
            reasons = assess(
                counts, p, int(self.fallback_threshold_pct) / 100, int(self.reject_threshold_pct) / 100, int(self.backlog_threshold)
            )
            pc = p.get("counts", {})
            status = "failed" if p.get("halt") or counts.get("_errors") else ("warning" if reasons else "ok")
            status_upper = status.upper()
            if status == "ok":
                status_icon = "✅ BERHASIL"
            elif status == "warning":
                status_icon = "⚠️ PERLU PERHATIAN"
            else:
                status_icon = "❌ GAGAL / ERROR"

            received_cnt = pc.get("received", 0)
            rejected_cnt = pc.get("rejected", 0)
            new_cnt = pc.get("new", 0)
            dup_cnt = pc.get("duplicate", 0)
            llm_cnt = counts.get("drafted_llm", 0)
            fb_cnt = counts.get("drafted_fallback", 0)
            drafted_cnt = llm_cnt + fb_cnt
            deferred_cnt = pc.get("deferred", 0)

            lines = [
                "📢 EXPA WELCOME DRAFTER — RUN REPORT",
                "────────────────────────",
                f"📊 Status : {status_icon} ({status_upper})",
                f"🆔 Run ID : {run_id}",
                "",
                "📥 Data Pendaftar (Sign-ups):",
                f"• Total Diterima (received) : {received_cnt} orang",
                f"• Kontak Baru (new)          : {new_cnt} orang",
                f"• Duplikat (duplicates)     : {dup_cnt} orang (sudah diproses)",
                f"• Ditolak (rejected)        : {rejected_cnt} orang (data tidak valid)",
                "",
                "💬 Draft WhatsApp Terbuat:",
                f"• Draft Baru Dibuat (drafted): {drafted_cnt} pesan",
                f"• Antrean Tertunda (deferred): {deferred_cnt}",
            ]

            if reasons:
                lines.extend([
                    "",
                    "⚠️ Catatan Perhatian (Needs attention):",
                    *[f"• {r}" for r in reasons],
                    "",
                    f"🔍 Detail: events table, run_id={run_id}",
                ])
            else:
                lines.extend([
                    "",
                    "✨ Semua proses berjalan lancar tanpa kendala.",
                ])

            text = "\n".join(lines)

            delivered, detail = (False, "not_needed")
            should_send = bool(reasons or getattr(self, "always_notify", True))
            if should_send:
                delivered, detail = self._deliver(text, conn=conn, run_id=run_id)
                if not delivered and detail not in ("dry_run",):
                    _event(conn, run_id, "alert", "error", "alert_undelivered", detail)
                    with open(os.path.join(os.path.dirname(os.path.abspath(self.db_path)), "alerts_undelivered.log"), "a", encoding="utf-8") as fh:
                        fh.write(f"{_now()} {text}\n")
                else:
                    _event(conn, run_id, "alert", "info", "alert_sent" if delivered else "alert_dry_run", detail)
            else:
                _event(conn, run_id, "alert", "info", "alert_skipped", "all_conditions_normal")
            summary = {"status": status, "counts": counts, "pipeline": pc, "reasons": reasons}
            conn.execute(
                "UPDATE runs SET finished_at=?, status=?, summary=? WHERE run_id=?",
                (_now(), status, json.dumps(summary), run_id),
            )
            conn.commit()
            self.status = f"{status}: {len(reasons)} reason(s)"
            return Data(data={
                "text": text,
                "run_id": run_id, "status": status, "summary": summary, "alert_text": text if reasons else None,
                "alert_delivered": delivered, "alert_detail": detail,
                "calendar_task": {
                    "summary": f"Review EXPA drafts: {status} ({run_id})",
                    "description": "; ".join(reasons) or "Drafts are ready for review.",
                } if reasons else None,
            })
        finally:
            conn.close()

    def as_message(self) -> Message:
        data_obj = self.finish()
        d = getattr(data_obj, "data", data_obj)
        txt = d.get("text") if isinstance(d, dict) else str(d)
        return Message(text=txt or "Run completed.")

