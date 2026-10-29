"""End-to-end simulation of the Langflow flow, using the REAL component files.

    Webhook payload -> Run Gate -> Sign-ups -> Validate -> Dedupe & Log -> Draft -> Finish & Alert

Not covered here (needs real Langflow): canvas wiring, the Webhook component, the Composio
trigger itself, and a real model component. The LLM below is a stub with scripted misbehaviour.
Run:  python3 tests/run_simulation.py   (writes logs/run_log.txt)
"""
import json, os, re, shutil, sqlite3, subprocess, sys, tempfile
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE); os.chdir(ROOT)
from langflow_shim import Data, load_component  # noqa: E402

C = "langflow_components"
Gate = load_component(f"{C}/01_run_gate.py", "g").ExpaRunGate
Src = load_component(f"{C}/02_expa_source.py", "s").ExpaSignupsMock
Val = load_component(f"{C}/03_validate_normalize.py", "v").ValidateNormalize
Ded = load_component(f"{C}/04_dedupe_log.py", "d").DedupeAndLog
Dra = load_component(f"{C}/05_draft_message.py", "r").DraftMessage
Ale = load_component(f"{C}/06_alert_human.py", "a").FinishAndAlert

WORK = tempfile.mkdtemp(prefix="expa_sim_")
DB = os.path.join(WORK, "expa_welcome.db")
CTA = "https://example.org/aiesec-welcome"
LOG = []


def say(line=""):
    print(line); LOG.append(line)


class StubLLM:
    """Scripted stand-in for a chat model. mode: ok | flaky | down"""
    def __init__(self, mode): self.mode, self.calls, self.prompts = mode, 0, []
    def invoke(self, messages):
        self.calls += 1; self.prompts.append(messages)
        if self.mode == "down":
            raise ConnectionError("connection refused")
        if self.mode == "flaky" and self.calls % 7 == 0:
            raise Exception("429 Too Many Requests")
        system, human = messages[0][1], messages[1][1]
        f = dict(line.split(": ", 1) for line in human.splitlines())
        en = "English" in system
        name = "" if f["first_name"] == "(none)" else f["first_name"]
        text = (f"Hi{' ' + name if name else ''}! Welcome to {f['programme']} with AIESEC in {f['local_committee']}. "
                f"Your next step is here: {CTA}") if en else (
                f"Halo{' ' + name if name else ''}! Selamat bergabung di {f['programme']} bersama AIESEC in {f['local_committee']}. "
                f"Yuk lanjut ke langkah berikutnya di sini: {CTA}")
        if self.mode == "flaky" and self.calls % 11 == 0:
            text += " Bonus info: https://promo.example.net/win"   # a link the model should not add
        return type("R", (), {"content": text})()


def composio_payload(event_id, start, title="EXPA-WELCOME-RUN"):
    """Shape modelled on Composio's documented trigger payload (metadata.trigger_slug). Verify against a real delivery."""
    return {"id": f"msg_{event_id}", "type": "composio.trigger.message",
            "metadata": {"trigger_slug": "GOOGLECALENDAR_EVENT_STARTING_SOON_TRIGGER", "trigger_id": "ti_demo"},
            "data": {"id": event_id, "summary": title, "start": {"dateTime": start}}}


SLEEPS, ALL_ALERTS, ALL_LLMS = [], [], []


def run_flow(title, payload, source, llm=None, batch_size=15, min_minutes=0, run_enabled="true", note=""):
    say(); say("=" * 100); say(f"RUN: {title}"); 
    if note: say(f"     {note}")
    say("=" * 100)
    gate = Gate(payload=Data(data=payload) if payload else None, run_enabled=run_enabled,
                min_minutes_between_runs=min_minutes, allow_manual_run=False, db_path=DB)
    out = gate.open_gate()
    if "run" in gate._stopped:
        say(f"[Run Gate]   CLOSED -> reason: {out.data['halt_reason']}   (downstream components do not run)")
        return None
    say(f"[Run Gate]   OPEN   -> {gate.status}")
    comps = [("Sign-ups", Src(upstream=out, file_path=source, db_path=DB), "fetch")]
    for label, make, method in [
        ("Validate", lambda o: Val(upstream=o, db_path=DB), "validate"),
        ("Dedupe", lambda o: Ded(upstream=o, db_path=DB, dedupe_salt="sim-secret-salt", batch_size=batch_size), "process"),
        ("Draft", lambda o: Dra(upstream=o, llm=llm, db_path=DB, cta_link=CTA, include_wa_link=False), "draft_all"),
        ("Alert", lambda o: Ale(upstream=o, db_path=DB, dry_run=True), "finish"),
    ]:
        comps.append((label, make, method))
    comp, o = comps[0][1], out
    o = comp.fetch(); say(f"[Sign-ups]   {comp.status}  (halt={o.data.get('halt')})")
    for label, make, method in comps[1:]:
        comp = make(o)
        if label == "Draft":
            comp._sleep = lambda s: SLEEPS.append(s)
        o = getattr(comp, method)()
        d = o.data
        if label == "Alert":
            say(f"[Alert]      {comp.status}")
            if d.get("alert_text"):
                ALL_ALERTS.append(d["alert_text"])
                say("             ALERT (dry run, not sent) ->"); [say("               | " + l) for l in d["alert_text"].splitlines()]
                say(f"             calendar_task -> {d['calendar_task']}")
            else:
                say("             no alert needed")
            return d
        say(f"[{label:<9}] {comp.status}" + (f"   HALT: {d['halt_reason']}" if d.get("halt") else ""))
    return None


say("EXPA WELCOME DRAFTER: SIMULATED RUN LOG")
say("Real component code, stand-in Langflow API, stub LLM, mock data. Nothing was sent to anyone.")

llm1 = StubLLM("flaky");  ALL_LLMS.append(llm1)
run_flow("1/8  First calendar trigger: 31 mock sign-ups, batch cap 15, flaky LLM",
         composio_payload("evt-001", "2026-10-27T09:00:00+07:00"), "data/mock_expa_signups.json", llm1,
         note="Dirty data: bad phones, injection attempt in a name, duplicates. LLM: every 7th call 429, every 11th adds a forbidden link.")

say(); say(">>> Same Composio delivery arrives again (retry / duplicate delivery)")
run_flow("2/8  Replay of trigger evt-001", composio_payload("evt-001", "2026-10-27T09:00:00+07:00"),
         "data/mock_expa_signups.json", StubLLM("ok"))

llm3 = StubLLM("ok"); ALL_LLMS.append(llm3)
run_flow("3/8  Next calendar instance: batch 2 (overlaps batch 1) + backlog from run 1",
         composio_payload("evt-001", "2026-10-27T09:30:00+07:00"), "data/mock_expa_signups_batch2.json", llm3,
         note="Overlapping sign-ups must be skipped; fixed rows from batch 1 are re-validated; deferred backlog is picked up.")

llm4 = StubLLM("down"); ALL_LLMS.append(llm4)
run_flow("4/8  LLM provider outage: batch 3 (12 new sign-ups)",
         composio_payload("evt-001", "2026-10-27T10:00:00+07:00"), "data/mock_expa_signups_batch3.json", llm4,
         note="Circuit breaker should stop hammering the LLM; templates take over; a human is alerted.")

run_flow("5/8  Source file missing (a stage fails)", composio_payload("evt-001", "2026-10-27T10:30:00+07:00"),
         "data/does_not_exist.json", StubLLM("ok"), note="Failure in the middle of the flow still produces an alert.")

run_flow("6/8  Someone's lunch event hits the trigger", composio_payload("evt-lunch", "2026-10-27T12:00:00+07:00", title="Team lunch"),
         "data/mock_expa_signups.json", StubLLM("ok"))

run_flow("7/8  Kill switch OFF (EXPA_RUN_ENABLED=false)", composio_payload("evt-001", "2026-10-27T11:00:00+07:00"),
         "data/mock_expa_signups.json", StubLLM("ok"), run_enabled="false")

run_flow("8/8  Burst: second trigger 1 minute after a run (min 10 min between runs)",
         composio_payload("evt-001", "2026-10-27T11:01:00+07:00"), "data/mock_expa_signups.json", StubLLM("ok"), min_minutes=10)

# ---- audit ---------------------------------------------------------------------------------
conn = sqlite3.connect(DB); conn.row_factory = sqlite3.Row
say(); say("=" * 100); say("AUDIT (from the database after all runs)"); say("=" * 100)
say("contacts by status: " + ", ".join(f"{r['status']}={r['c']}" for r in conn.execute("SELECT status, COUNT(*) c FROM contacts GROUP BY status")))
say("draft source:       " + ", ".join(f"{r['draft_source']}={r['c']}" for r in conn.execute("SELECT draft_source, COUNT(*) c FROM contacts WHERE status='draft_ready' GROUP BY draft_source")))
say("rejection reasons:  " + ", ".join(f"{r['reason']}={r['c']}" for r in conn.execute("SELECT reason, COUNT(*) c FROM contacts WHERE status='rejected' GROUP BY reason")))
say("runs:")
for r in conn.execute("SELECT run_id, status FROM runs ORDER BY started_at, run_id"): say(f"   {r['run_id']}  {r['status']}")
say("LLM warnings across all runs: " + ", ".join(f"{r['outcome']}={r['c']}" for r in conn.execute("SELECT outcome, COUNT(*) c FROM events WHERE level='warn' GROUP BY outcome")))
say(f"backoff sleeps requested (patched out in simulation): {len(SLEEPS)}  e.g. {SLEEPS[:4]}")
say("sample drafts (names are mock; phone masked):")
for r in conn.execute("SELECT phone_masked, draft_source, draft_text FROM contacts WHERE status='draft_ready' AND contact_key IN ('e:1001','e:1005','e:1014','e:1017','e:3001') ORDER BY contact_key"):
    say(f"   {r['phone_masked']:<16} [{r['draft_source']}]  {r['draft_text']}")

# ---- privacy checks ---------------------------------------------------------------------------
say(); say("PRIVACY CHECKS")
raw_phone = re.compile(r"\+?62?\s?0?8\d{2}[\s-]?\d{4}[\s-]?\d{3,4}|08\d{9,}")
prompts = " ".join(str(p) for l in ALL_LLMS for p in l.prompts)
n_prompts = sum(len(l.prompts) for l in ALL_LLMS)
say(f"  LLM inputs: {n_prompts} prompts, phone/email present: {bool(raw_phone.search(prompts) or '@' in prompts)}   -> {'PASS' if not (raw_phone.search(prompts) or '@' in prompts) else 'FAIL'}")
events_dump = " ".join(" ".join(str(x) for x in r) for r in conn.execute("SELECT * FROM events"))
bad = raw_phone.search(events_dump) or "@example.com" in events_dump
say(f"  Audit log (events table): raw phone/email present: {bool(bad)}   -> {'PASS' if not bad else 'FAIL'}")
alerts = "\n".join(ALL_ALERTS)
bad = raw_phone.search(alerts) or "@" in alerts or re.search(r"Budi|Siti|Andi|Zahra", alerts)
say(f"  Alert texts ({len(ALL_ALERTS)}): names/phones/emails present: {bool(bad)}   -> {'PASS' if not bad else 'FAIL'}")
rej = conn.execute("SELECT COUNT(*) FROM contacts WHERE status='rejected' AND (first_name IS NOT NULL OR phone_e164 IS NOT NULL OR draft_text IS NOT NULL)").fetchone()[0]
say(f"  Rejected rows holding a name/phone/draft: {rej}   -> {'PASS' if rej == 0 else 'FAIL'}")
mode = oct(os.stat(DB).st_mode & 0o777)
perm_ok = mode == '0o600' or (os.name == 'nt' and mode == '0o666')
say(f"  Database file permissions: {mode}   -> {'PASS' if perm_ok else 'CHECK'}")
conn.close()

os.makedirs("logs", exist_ok=True)
open("logs/run_log.txt", "w", encoding="utf-8").write("\n".join(LOG) + "\n")
subprocess.run([sys.executable, "tools/export_review_queue.py", "--db", DB, "--out", "logs/review_queue_sample.csv"], check=True, capture_output=True)
shutil.rmtree(WORK, ignore_errors=True)
say(); say("Wrote logs/run_log.txt and logs/review_queue_sample.csv")
