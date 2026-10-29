# EXPA Welcome Drafter (Langflow + Web Dispatcher)

Gets new EXPA sign-ups (mock data) → validates & normalizes → logs every contact and skips duplicates → drafts a WhatsApp message per person → alerts a human when something fails → exports spreadsheets & serves a **Web Lead Dispatcher Dashboard**. **Nothing is ever sent automatically**: drafts wait for a human.

Scheduler: a **recurring Google Calendar event** fires a **Composio trigger**, which calls Langflow's **Webhook** component. The calendar is the schedule *and* the off-switch (delete the event, or set `EXPA_RUN_ENABLED=false`).

```
Google Calendar (recurring "EXPA-WELCOME-RUN")
   → Composio trigger (Event Starting Soon) → Langflow Webhook
   → [1] Run Gate → [2] Sign-ups → [3] Validate → [4] Dedupe & Log → [5] Draft (Dynamic Template)
   → [6] Finish & Alert → [7] Export Spreadsheet (+ Google Drive) → [8] Chat Output
                                                                   ↓
                                                  Web Dispatcher Dashboard (localhost:3000)
```

## What's in the box

| Path | What it is |
|---|---|
| `langflow/expa-welcome-drafter.json` | Ready-to-import 9-node Langflow flow JSON (1-click setup). |
| `langflow_components/00…08_*.py` | The custom components (`01`–`06` core pipeline + `07` Spreadsheet/GDrive exporter, `08` Chat Output, and optional `00` Flaz LLM). |
| `web/` | Minimalist AIESEC-themed Web Controller & Lead Dispatcher Dashboard (`server.js` + `public/`). |
| `data/` | Three mock sign-up batches (dirty on purpose), sample Composio payload, and SQLite DB (`expa_welcome.db`). |
| `logs/run_log.txt` | Run log of 8 simulated runs: normal, replay, overlap, LLM outage, failure, kill switch. |
| `logs/review_queue_sample.csv` | What the human reviewer gets (mock data). |
| `tools/export_review_queue.py` | CLI tool that exports drafts + `wa.me` click-to-chat links from the DB. |
| `tools/build_langflow_export.js` | Rebuilds `langflow/expa-welcome-drafter.json` from `langflow_components/*.py`. |
| `tools/google_drive_uploader.js` | Secured Google Apps Script Web App (`SHARED_SECRET`) for direct spreadsheet uploads to Google Drive. |
| `tests/` | 24 unit tests, end-to-end 8-run simulation, and a lightweight stand-in for the Langflow API. |

## Quick Start: Web Dispatcher Dashboard

Requires **Node.js >= 22.5.0** (uses built-in `node:sqlite`, zero external npm dependencies required).

```bash
npm start
# Open http://localhost:3000
```

From the Web Dashboard you can:
- Inspect metrics (**Siap Dikirim**, **Perlu Perbaikan**, **Sudah Dihubungi**, **Total Pendaftar**).
- Customize the **WhatsApp Message Template** via **Template Pesan** using clickable variables (`{full_name}`, `{first_name}`, `{programme}`, `{programme_full}`, `{lc}`, `{cta_link}`) with live preview and bulk re-render.
- Review and edit drafted WhatsApp messages inline, reveal/mask phone numbers, and click **Buka WhatsApp** (`wa.me` deep link).
- Fix rejected sign-up records (missing/invalid phone, missing name, invalid programme, duplicate phone) via **Perbaiki Data Pendaftar** and re-validate them into the ready queue.
- Trigger the Langflow flow remotely (**Jalankan Flow**) with automatic API key provisioning and local fallback if Langflow is offline.
- Export validated CSV spreadsheets locally or upload directly to Google Drive (**Unduh CSV**).

## Complete Demo Guide (Web Dashboard + Langflow)

1. **Start Langflow & Import the Flow**:
   - Ensure Langflow is running at `http://127.0.0.1:7860`.
   - Click **New Flow → Import** and select `langflow/expa-welcome-drafter.json` (9 nodes, 8 pre-wired edges).
2. **Start the Web Dispatcher Dashboard**:
   - Run `npm start` and open `http://localhost:3000`.
   - The status indicator at the top right will turn **Green (`Terhubung (http://127.0.0.1:7860)`)**. If your Flow ID differs, click the **Settings (`⚙️`)** icon and paste your Langflow Flow URL or UUID.
3. **Demo 1 — Customizing the WhatsApp Message Template**:
   - Click the **Template Pesan** button in the dashboard top bar.
   - Edit the template text or insert dynamic variable chips (`{full_name}`, `{first_name}`, `{programme}`, `{programme_full}`, `{lc}`, `{cta_link}`), and check the real-time **Live Preview** and word counter below.
   - Check *"Terapkan ulang template ini ke seluruh draf berstatus Siap Kirim"* and click **Simpan & Terapkan Template**. All ready applicant cards update immediately in real time.
4. **Demo 2 — Strict Validation & Fixing Rejected Leads (`Perlu Perbaikan`)**:
   - Open the **Perlu Perbaikan** tab to inspect sign-ups automatically rejected by the validator (missing name `#1014`, unrecognized programme `#1017`, short phone `#1010`, landline number `#1013`, prompt injection `#1015`, and duplicate phone `#1019`).
   - Click **Perbaiki Data Pendaftar** on any rejected card (e.g., `#1014`), enter a valid full name, and click **Simpan & Validasi Ulang**. The record is re-validated, moves to **Siap Kirim**, and gets a freshly rendered WhatsApp draft.
5. **Demo 3 — Live Langflow Execution & CSV / Google Drive Export**:
   - Click **Jalankan Flow**: the dashboard calls `/api/v1/run/<FLOW_ID>` directly on Langflow (the notification toast displays a green **`⚡ LANGFLOW LIVE`** badge).
   - Click **Unduh CSV**: the `ExportSpreadsheetTool` component in Langflow exports all valid `draft_ready` records to a clean CSV (`expa_drafts_draft_ready_*.csv`) and uploads a backup copy to Google Drive (when the Apps Script Webhook URL is configured in Settings).
   - Click **Buka WhatsApp** on any applicant card to open `wa.me` with the pre-filled message, then click **Tandai Dihubungi** to mark the lead as contacted.

## For Demo Video Check through this link [https://drive.google.com/drive/folders/1V38hptm-5cjyIVNQ8ZLgknnv6FpyvwUx](https://drive.google.com/drive/folders/1vqCe6dXMP5nXHVT28IM9J4WtX9VMY_gu?usp=sharing)]

## Build it in Langflow

### Option A: 1-Click Flow Import (Recommended)
1. In Langflow, click **New Flow → Import** and select `langflow/expa-welcome-drafter.json`.
2. All 9 nodes and 8 edges are pre-wired automatically.

### Option B: Manual Component Setup (~30 minutes)
**1. Put the files where Langflow can read them.** Copy `data/` next to wherever Langflow runs (Docker: mount it), or set `EXPA_WORKSPACE_DIR` to the repo path. The SQLite file is created automatically at `./data/expa_welcome.db`.

**2. Add the components.** Paste each file from `langflow_components/` into *New Custom Component*.

**3. Wire it like this**

| From | To |
|---|---|
| Webhook → Data | Run Gate → *Webhook payload* |
| Run Gate → **Run** | EXPA Sign-ups → *From Run Gate* |
| EXPA Sign-ups | Validate & Normalize |
| Validate & Normalize | Dedupe & Log |
| Dedupe & Log | Draft WhatsApp Message → *From Dedupe & Log* |
| Draft WhatsApp Message | Finish Run & Alert Human |
| Finish Run & Alert Human → *Run report* | Export Drafts to Spreadsheet → *From Pipeline (optional)* |
| Export Drafts to Spreadsheet → *Report Message* | Chat Output → *Input* |

**5. Secrets: never type them into the canvas.** Create *Settings → Global Variables*: `DEDUPE_SALT` (credential, long random string), `TELEGRAM_BOT_TOKEN` (credential), `ALERT_WEBHOOK_URL` (credential, optional), `EXPA_RUN_ENABLED` (generic, `true`), plus your LLM key. Click the 🌐 icon on each field to bind it. Export the flow **without** keys ("Save with my API keys" off).

**6. Set up the scheduler (Composio + Google Calendar)**
1. In Composio, connect a Google account that owns a dedicated calendar.
2. Create a recurring event titled exactly `EXPA-WELCOME-RUN` (every 30 minutes for production, or just a few minutes from now for the demo).
3. Create a trigger: toolkit *Google Calendar*, trigger **`GOOGLECALENDAR_EVENT_STARTING_SOON_TRIGGER`**, scoped to that calendar. Check the config fields in the Composio dashboard.
4. Set Composio's webhook subscription URL to your Langflow webhook endpoint: `https://<public-host>/api/v1/webhook/<FLOW_ID>` (copy the exact URL/cURL from the Webhook component's *Controls*). Langflow must be reachable from the internet (hosted, or a tunnel such as Cloudflare Tunnel/ngrok for the demo).
5. Composio's Calendar triggers are **polling**: expect up to ~15 minutes of delay. Fine for welcome messages. The Gate makes duplicate or late deliveries harmless.

**7. Test in this order**
1. Turn the Gate's *Allow manual run* on and run once from the Playground. Check the mock sign-ups flow through.
2. `curl -X POST <webhook-url> -H 'Content-Type: application/json' -d @data/sample_composio_payload.json`. A real run. Send it again: the Gate says `replay`.
3. Point *Mock sign-ups file* at `mock_expa_signups_batch2.json`: duplicates are skipped.
4. Disconnect the model component: drafts use the template. Set a wrong API key: retries, then fallback, then an alert (turn *Dry run* off and set Telegram to see a real message).
5. Set `EXPA_RUN_ENABLED=false`: the Gate closes.
6. Before production: turn *Allow manual run* **off**, *Dry run* **off**.

## Design decisions in one place
- **Drafts, not sends.** WhatsApp bulk-sending needs approved templates and carries account-ban risk. A human gate is the safe default, and it directly prevents the "wrong message to hundreds" incident.
- **The payload only decides *whether* to run.** Sign-up data comes from EXPA (here, the mock file), never from the webhook, so a spoofed call cannot inject contacts.
- **Write before draft, with unique keys.** Re-running never creates a second draft for the same person.
- **Stages never raise.** They record the failure and pass a `halt` flag, so the final component always runs and alerts.
- **LLM sees first name, programme and LC only.** Output is checked; otherwise a fixed template is used.
- **Batch cap and backlog.** Each run drafts up to `batch_size` contacts; the rest wait for the next calendar tick. Thousands of sign-ups become several small runs.

## What was and was not tested

| Tested here (real component code) | Not tested here (needs your Langflow) |
|---|---|
| Phone/name normalization, injection and emoji handling | Pasting components into Langflow and wiring on the canvas |
| Dedupe across id, phone formats, within-batch repeats | The Webhook component's exact output shape in your version |
| Batch cap, backlog pickup, retention scrub | The real Composio trigger and its real payload/field names |
| Gate: replay, burst, kill switch, wrong trigger, fail-closed | Real model components (the LLM here is a scripted stub) |
| LLM retry, output checks, circuit breaker, call cap | Real Telegram/Slack delivery (stubbed HTTP; dry run) |
| Alert content has no personal data; secrets never logged | Load at thousands of rows (design handles it; not benchmarked) |

The Langflow API stand-in (`tests/langflow_shim.py`) mirrors only the pieces used. If Langflow's API differs in your version (for example, how `Data` or `stop()` behave), the fix will be small and local to the wrapper code at the top of each component.

## Known gaps (worth saying out loud)
- **No dead-man's switch yet.** If the trigger never fires, or the Gate fails closed, nobody is alerted. Next step: a second calendar event ("heartbeat check") that alerts if no `runs` row appeared in N hours.
- **Webhook authentication.** Langflow's Webhook component does not expose request headers to the flow, so the Composio signature can't be verified inside it. Mitigations: the Gate only accepts the expected trigger and event title; the payload is never trusted as data; blast radius is capped by batch size and the run-interval guard. For production, enable webhook authentication if your Langflow version supports it, or put a small proxy in front that verifies Composio's signature.
- **Composio payload shape** is modelled on its docs. Capture one real delivery and adjust `_dig` paths in the Gate if needed.
- **Real EXPA access** is replaced by the mock file. Swap component 2; keep the `records` contract.
- **SQLite** is right for a prototype and one runner. Use Postgres or Google Sheets if several people or machines write at once.
- **Personal data in the DB** (phone, first name, draft) is needed for human review. Mitigated with owner-only file permissions, `retention_days` scrubbing (the salted hash stays so duplicates are still caught), and masked logs. In production add disk encryption and access control.
