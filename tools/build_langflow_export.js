const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const componentsDir = path.join(rootDir, 'langflow_components');
const outputDir = path.join(rootDir, 'langflow');
const outputFile = path.join(outputDir, 'expa-welcome-drafter.json');

// Ensure output directory exists
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// Read custom component codes directly from langflow_components
const code00 = fs.readFileSync(path.join(componentsDir, '00_flaz_model.py'), 'utf-8');
const code01 = fs.readFileSync(path.join(componentsDir, '01_run_gate.py'), 'utf-8');
const code02 = fs.readFileSync(path.join(componentsDir, '02_expa_source.py'), 'utf-8');
const code03 = fs.readFileSync(path.join(componentsDir, '03_validate_normalize.py'), 'utf-8');
const code04 = fs.readFileSync(path.join(componentsDir, '04_dedupe_log.py'), 'utf-8');
const code05 = fs.readFileSync(path.join(componentsDir, '05_draft_message.py'), 'utf-8');
const code06 = fs.readFileSync(path.join(componentsDir, '06_alert_human.py'), 'utf-8');
const code07 = fs.readFileSync(path.join(componentsDir, '07_export_spreadsheet.py'), 'utf-8');
const code08 = fs.readFileSync(path.join(componentsDir, '08_chat_output.py'), 'utf-8');

// Python codes for Webhook, FlazCloudModel, and ChatOutput
const codeWebhook = `import json
from langflow.custom import Component
from langflow.io import MultilineInput, Output
from langflow.schema import Data

class Webhook(Component):
    display_name = "Webhook"
    description = "Defines a webhook input for the flow."
    icon = "Webhook"
    name = "Webhook"

    inputs = [
        MultilineInput(
            name="payload_json",
            display_name="Data",
            info="Test payload in JSON format.",
            value="",
        ),
    ]

    outputs = [
        Output(display_name="Data", name="data", method="build_data"),
    ]

    def build_data(self) -> Data:
        raw = self.payload_json
        if not raw:
            return Data(data={})
        if isinstance(raw, dict):
            return Data(data=raw)
        try:
            val = json.loads(raw)
            return Data(data=val if isinstance(val, dict) else {"payload": val})
        except Exception:
            return Data(data={"payload": str(raw)})
`;



function makeEdge(sourceId, sourceName, sourceTypes, targetId, targetField, targetTypes, targetTypeStr) {
  const sourceHandleObj = {
    dataType: sourceId.split('-')[0],
    id: sourceId,
    name: sourceName,
    output_types: sourceTypes
  };
  const targetHandleObj = {
    fieldName: targetField,
    id: targetId,
    inputTypes: targetTypes,
    type: targetTypeStr || "other"
  };

  const sourceHandleStr = JSON.stringify(sourceHandleObj);
  const targetHandleStr = JSON.stringify(targetHandleObj);
  const edgeId = `reactflow__edge-${sourceId}${sourceName}-${targetId}${targetField}`;

  return {
    id: edgeId,
    source: sourceId,
    target: targetId,
    sourceHandle: sourceHandleStr,
    targetHandle: targetHandleStr,
    data: {
      sourceHandle: sourceHandleObj,
      targetHandle: targetHandleObj
    },
    animated: false,
    selected: false
  };
}

const nodes = [
  // 1. Webhook
  {
    id: "Webhook-trigger",
    type: "genericNode",
    position: { x: 60, y: 280 },
    data: {
      type: "Webhook",
      id: "Webhook-trigger",
      node: {
        display_name: "Webhook",
        description: "Defines a webhook input for the flow to receive Composio Google Calendar trigger payloads.",
        icon: "Webhook",
        template: {
          _type: "Component",
          code: {
            type: "code",
            required: true,
            show: true,
            multiline: true,
            name: "code",
            advanced: true,
            dynamic: true,
            value: codeWebhook
          },
          payload_json: {
            type: "str",
            required: false,
            show: true,
            multiline: true,
            name: "payload_json",
            display_name: "Data",
            info: "Test payload in JSON format.",
            value: ""
          }
        },
        outputs: [
          {
            display_name: "Data",
            name: "data",
            method: "build_data",
            types: ["Data"],
            selected: "Data"
          }
        ],
        field_order: ["payload_json"]
      }
    }
  },

  // 2. ExpaRunGate
  {
    id: "ExpaRunGate-gate",
    type: "genericNode",
    position: { x: 440, y: 280 },
    data: {
      type: "ExpaRunGate",
      id: "ExpaRunGate-gate",
      node: {
        display_name: "EXPA Run Gate",
        description: "Decides if a run may start: kill switch, trigger check, replay and overlap protection.",
        icon: "shield-check",
        template: {
          _type: "Component",
          code: {
            type: "code",
            required: true,
            show: true,
            multiline: true,
            name: "code",
            advanced: true,
            dynamic: true,
            value: code01
          },
          payload: {
            type: "other",
            required: false,
            show: true,
            name: "payload",
            display_name: "Webhook payload",
            info: "Connect the Webhook component here. Leave empty for a manual test run.",
            input_types: ["Data"],
            value: null
          },
          run_enabled: {
            type: "str",
            required: false,
            show: true,
            name: "run_enabled",
            display_name: "Runs enabled (kill switch)",
            info: "Bind to a global variable EXPA_RUN_ENABLED. Set to 'false' to stop all runs instantly.",
            value: "true"
          },
          expected_trigger_slug: {
            type: "str",
            required: false,
            show: true,
            advanced: true,
            name: "expected_trigger_slug",
            display_name: "Expected Composio trigger",
            value: "GOOGLECALENDAR_EVENT_STARTING_SOON_TRIGGER"
          },
          title_prefix: {
            type: "str",
            required: false,
            show: true,
            name: "title_prefix",
            display_name: "Calendar event title prefix",
            info: "Only calendar events whose title starts with this may start a run.",
            value: "EXPA-WELCOME-RUN"
          },
          min_minutes_between_runs: {
            type: "int",
            required: false,
            show: true,
            advanced: true,
            name: "min_minutes_between_runs",
            display_name: "Min minutes between runs",
            info: "Protects against duplicate or bursty deliveries.",
            value: 10
          },
          allow_manual_run: {
            type: "bool",
            required: false,
            show: true,
            name: "allow_manual_run",
            display_name: "Allow manual run (no payload)",
            info: "Handy for testing in the Playground. Turn OFF in production.",
            value: true
          },
          db_path: {
            type: "str",
            required: false,
            show: true,
            advanced: true,
            name: "db_path",
            display_name: "Database path",
            value: "./data/expa_welcome.db"
          },
          webhook_secret_token: {
            type: "str",
            required: false,
            show: true,
            password: true,
            advanced: true,
            name: "webhook_secret_token",
            display_name: "Webhook secret token (optional)",
            info: "If configured, webhook requests must include this token to start a run, preventing unauthorized triggers.",
            value: ""
          }
        },
        outputs: [
          {
            display_name: "Run",
            name: "run",
            method: "open_gate",
            types: ["Data"],
            selected: "Data"
          },
          {
            display_name: "Skipped",
            name: "skipped",
            method: "closed_info",
            types: ["Data"],
            selected: "Data"
          }
        ],
        field_order: [
          "payload",
          "run_enabled",
          "expected_trigger_slug",
          "title_prefix",
          "min_minutes_between_runs",
          "allow_manual_run",
          "db_path"
        ]
      }
    }
  },

  // 3. ExpaSignupsMock
  {
    id: "ExpaSignupsMock-src",
    type: "genericNode",
    position: { x: 820, y: 280 },
    data: {
      type: "ExpaSignupsMock",
      id: "ExpaSignupsMock-src",
      node: {
        display_name: "EXPA Sign-ups (Mock)",
        description: "Loads mock EXPA sign-ups from a JSON file. Swap for the real EXPA call later.",
        icon: "download",
        template: {
          _type: "Component",
          code: {
            type: "code",
            required: true,
            show: true,
            multiline: true,
            name: "code",
            advanced: true,
            dynamic: true,
            value: code02
          },
          upstream: {
            type: "other",
            required: false,
            show: true,
            name: "upstream",
            display_name: "From Run Gate",
            input_types: ["Data"],
            value: null
          },
          file_path: {
            type: "str",
            required: false,
            show: true,
            name: "file_path",
            display_name: "Mock sign-ups file",
            value: "./data/mock_expa_signups.json"
          },
          max_rows: {
            type: "int",
            required: false,
            show: true,
            advanced: true,
            name: "max_rows",
            display_name: "Max rows per run",
            value: 5000
          },
          db_path: {
            type: "str",
            required: false,
            show: true,
            advanced: true,
            name: "db_path",
            display_name: "Database path",
            value: "./data/expa_welcome.db"
          }
        },
        outputs: [
          {
            display_name: "Sign-ups",
            name: "signups",
            method: "fetch",
            types: ["Data"],
            selected: "Data"
          }
        ],
        field_order: ["upstream", "file_path", "max_rows", "db_path"]
      }
    }
  },

  // 4. ValidateNormalize
  {
    id: "ValidateNormalize-val",
    type: "genericNode",
    position: { x: 1200, y: 280 },
    data: {
      type: "ValidateNormalize",
      id: "ValidateNormalize-val",
      node: {
        display_name: "Validate & Normalize",
        description: "Cleans sign-ups, rejects unusable or suspicious rows and logs why.",
        icon: "list-checks",
        template: {
          _type: "Component",
          code: {
            type: "code",
            required: true,
            show: true,
            multiline: true,
            name: "code",
            advanced: true,
            dynamic: true,
            value: code03
          },
          upstream: {
            type: "other",
            required: false,
            show: true,
            name: "upstream",
            display_name: "From Sign-ups",
            input_types: ["Data"],
            value: null
          },
          db_path: {
            type: "str",
            required: false,
            show: true,
            advanced: true,
            name: "db_path",
            display_name: "Database path",
            value: "./data/expa_welcome.db"
          }
        },
        outputs: [
          {
            display_name: "Valid sign-ups",
            name: "valid",
            method: "validate",
            types: ["Data"],
            selected: "Data"
          }
        ],
        field_order: ["upstream", "db_path"]
      }
    }
  },

  // 5. DedupeAndLog
  {
    id: "DedupeAndLog-ded",
    type: "genericNode",
    position: { x: 1580, y: 280 },
    data: {
      type: "DedupeAndLog",
      id: "DedupeAndLog-ded",
      node: {
        display_name: "Dedupe & Log",
        description: "Skips known contacts, logs every contact, selects this run's batch.",
        icon: "database",
        template: {
          _type: "Component",
          code: {
            type: "code",
            required: true,
            show: true,
            multiline: true,
            name: "code",
            advanced: true,
            dynamic: true,
            value: code04
          },
          upstream: {
            type: "other",
            required: false,
            show: true,
            name: "upstream",
            display_name: "From Validate",
            input_types: ["Data"],
            value: null
          },
          dedupe_salt: {
            type: "str",
            required: false,
            show: true,
            password: true,
            name: "dedupe_salt",
            display_name: "Dedupe salt (secret)",
            info: "Bind to a global variable DEDUPE_SALT. Falls back to the DEDUPE_SALT environment variable.",
            value: ""
          },
          batch_size: {
            type: "int",
            required: false,
            show: true,
            name: "batch_size",
            display_name: "Batch size per run",
            value: 50
          },
          max_attempts: {
            type: "int",
            required: false,
            show: true,
            advanced: true,
            name: "max_attempts",
            display_name: "Max draft attempts per contact",
            value: 3
          },
          retention_days: {
            type: "int",
            required: false,
            show: true,
            advanced: true,
            name: "retention_days",
            display_name: "Keep personal data (days)",
            value: 30
          },
          allow_dev_salt: {
            type: "bool",
            required: false,
            show: true,
            advanced: true,
            name: "allow_dev_salt",
            display_name: "Allow dev salt (testing only)",
            value: true
          },
          db_path: {
            type: "str",
            required: false,
            show: true,
            advanced: true,
            name: "db_path",
            display_name: "Database path",
            value: "./data/expa_welcome.db"
          }
        },
        outputs: [
          {
            display_name: "To draft",
            name: "to_draft",
            method: "process",
            types: ["Data"],
            selected: "Data"
          }
        ],
        field_order: [
          "upstream",
          "dedupe_salt",
          "batch_size",
          "max_attempts",
          "retention_days",
          "allow_dev_salt",
          "db_path"
        ]
      }
    }
  },

  // 6. DraftMessage
  {
    id: "DraftMessage-dra",
    type: "genericNode",
    position: { x: 1960, y: 280 },
    data: {
      type: "DraftMessage",
      id: "DraftMessage-dra",
      node: {
        display_name: "Draft WhatsApp Message",
        description: "Drafts a welcome message per contact using a customizable template (never sends automatically).",
        icon: "message-square",
        template: {
          _type: "Component",
          code: {
            type: "code",
            required: true,
            show: true,
            multiline: true,
            name: "code",
            advanced: true,
            dynamic: true,
            value: code05
          },
          upstream: {
            type: "other",
            required: false,
            show: true,
            name: "upstream",
            display_name: "From Dedupe & Log",
            input_types: ["Data"],
            value: null
          },
          message_template: {
            type: "str",
            required: false,
            show: true,
            multiline: true,
            name: "message_template",
            display_name: "Message Template",
            info: "Template pesan WhatsApp. Gunakan variabel: {full_name}, {first_name}, {programme}, {programme_full}, {lc}, {cta_link}.",
            value: "Halo {full_name}! Terima kasih sudah mendaftar {programme} di AIESEC in {lc}. Kami senang menyambutmu untuk langkah kepemimpinan berikutnya. Informasi lengkap dan langkah selanjutnya bisa kamu akses di {cta_link}. Ada pertanyaan yang ingin kamu tanyakan ke tim kami?"
          },
          cta_link: {
            type: "str",
            required: false,
            show: true,
            name: "cta_link",
            display_name: "Call-to-action link",
            info: "The only link allowed in a message. Replace with the real sign-up/next-step link.",
            value: "https://aiesec.or.id/welcome"
          },
          llm: {
            type: "other",
            required: false,
            show: true,
            advanced: true,
            name: "llm",
            display_name: "Language Model (optional)",
            info: "Optional legacy LLM input. Leave empty to use the fast deterministic template.",
            input_types: ["LanguageModel"],
            value: null
          },
          use_llm: {
            type: "bool",
            required: false,
            show: true,
            advanced: true,
            name: "use_llm",
            display_name: "Use LLM",
            value: false
          },
          max_llm_calls: {
            type: "int",
            required: false,
            show: true,
            advanced: true,
            name: "max_llm_calls",
            display_name: "Max LLM calls per run",
            value: 50
          },
          llm_retries: {
            type: "int",
            required: false,
            show: true,
            advanced: true,
            name: "llm_retries",
            display_name: "LLM retries",
            value: 2
          },
          breaker_after: {
            type: "int",
            required: false,
            show: true,
            advanced: true,
            name: "breaker_after",
            display_name: "Open circuit after N failed contacts",
            value: 3
          },
          max_attempts: {
            type: "int",
            required: false,
            show: true,
            advanced: true,
            name: "max_attempts",
            display_name: "Max draft attempts per contact",
            value: 3
          },
          include_wa_link: {
            type: "bool",
            required: false,
            show: true,
            advanced: true,
            name: "include_wa_link",
            display_name: "Include wa.me link in output",
            info: "Off by default: the link contains the phone number. The reviewer exports it from the DB instead.",
            value: false
          },
          db_path: {
            type: "str",
            required: false,
            show: true,
            advanced: true,
            name: "db_path",
            display_name: "Database path",
            value: "./data/expa_welcome.db"
          }
        },
        outputs: [
          {
            display_name: "Drafts",
            name: "drafts",
            method: "draft_all",
            types: ["Data"],
            selected: "Data"
          }
        ],
        field_order: [
          "upstream",
          "message_template",
          "cta_link",
          "llm",
          "use_llm",
          "max_llm_calls",
          "llm_retries",
          "breaker_after",
          "max_attempts",
          "include_wa_link",
          "db_path"
        ]
      }
    }
  },

  // 8. FinishAndAlert
  {
    id: "FinishAndAlert-ale",
    type: "genericNode",
    position: { x: 2340, y: 280 },
    data: {
      type: "FinishAndAlert",
      id: "FinishAndAlert-ale",
      node: {
        display_name: "Finish Run & Alert Human",
        description: "Closes the run, summarizes it, and alerts a human when something needs attention.",
        icon: "bell",
        template: {
          _type: "Component",
          code: {
            type: "code",
            required: true,
            show: true,
            multiline: true,
            name: "code",
            advanced: true,
            dynamic: true,
            value: code06
          },
          upstream: {
            type: "other",
            required: false,
            show: true,
            name: "upstream",
            display_name: "From Draft Message",
            input_types: ["Data"],
            value: null
          },
          telegram_bot_token: {
            type: "str",
            required: false,
            show: true,
            password: true,
            name: "telegram_bot_token",
            display_name: "Telegram bot token (secret)",
            value: ""
          },
          telegram_chat_id: {
            type: "str",
            required: false,
            show: true,
            advanced: true,
            name: "telegram_chat_id",
            display_name: "Telegram chat id",
            value: ""
          },
          webhook_url: {
            type: "str",
            required: false,
            show: true,
            password: true,
            name: "webhook_url",
            display_name: "Webhook URL (secret, Slack/Discord)",
            value: ""
          },
          dry_run: {
            type: "bool",
            required: false,
            show: true,
            name: "dry_run",
            display_name: "Dry run (do not send)",
            info: "ON for demos and tests.",
            value: true
          },
          fallback_threshold_pct: {
            type: "int",
            required: false,
            show: true,
            advanced: true,
            name: "fallback_threshold_pct",
            display_name: "Alert if LLM fallback above (%)",
            value: 30
          },
          reject_threshold_pct: {
            type: "int",
            required: false,
            show: true,
            advanced: true,
            name: "reject_threshold_pct",
            display_name: "Alert if rejected above (%)",
            value: 40
          },
          backlog_threshold: {
            type: "int",
            required: false,
            show: true,
            advanced: true,
            name: "backlog_threshold",
            display_name: "Alert if backlog above",
            value: 500
          },
          db_path: {
            type: "str",
            required: false,
            show: true,
            advanced: true,
            name: "db_path",
            display_name: "Database path",
            value: "./data/expa_welcome.db"
          }
        },
        outputs: [
          {
            display_name: "Run report",
            name: "report",
            method: "finish",
            types: ["Data"],
            selected: "Data"
          },
          {
            display_name: "Message",
            name: "message",
            method: "as_message",
            types: ["Message"],
            selected: "Message"
          }
        ],
        field_order: [
          "upstream",
          "telegram_bot_token",
          "telegram_chat_id",
          "webhook_url",
          "dry_run",
          "fallback_threshold_pct",
          "reject_threshold_pct",
          "backlog_threshold",
          "db_path"
        ]
      }
    }
  },

  // 9. ExportSpreadsheetTool (Pipeline step & Agentic Tool)
  {
    id: "ExportSpreadsheetTool-exp",
    type: "genericNode",
    position: { x: 2720, y: 280 },
    data: {
      type: "ExportSpreadsheetTool",
      id: "ExportSpreadsheetTool-exp",
      node: {
        display_name: "Export Drafts to Spreadsheet",
        description: "Exports WhatsApp draft messages to an Excel (.xlsx) or CSV spreadsheet. Can be used in pipeline or as an Agentic Tool.",
        icon: "FileSpreadsheet",
        template: {
          _type: "Component",
          code: {
            type: "code",
            required: true,
            show: true,
            multiline: true,
            name: "code",
            advanced: true,
            dynamic: true,
            value: code07
          },
          upstream: {
            type: "other",
            required: false,
            show: true,
            name: "upstream",
            display_name: "From Pipeline (optional)",
            input_types: ["Data", "Message"],
            value: null
          },
          upload_to_gdrive: {
            type: "bool",
            required: false,
            show: true,
            name: "upload_to_gdrive",
            display_name: "Upload to Google Drive",
            value: true,
            info: "Automatically upload the generated spreadsheet to Google Drive."
          },
          gdrive_method: {
            type: "str",
            required: false,
            show: true,
            name: "gdrive_method",
            display_name: "Google Drive Method",
            value: "Apps Script Webhook (Direct & Stable)",
            options: ["Apps Script Webhook (Direct & Stable)", "Composio (Legacy)"],
            info: "Metode upload ke Google Drive. Apps Script Webhook langsung menyimpan file ke Google Drive Anda tanpa perantara pihak ketiga."
          },
          gdrive_webhook_url: {
            type: "str",
            required: false,
            show: true,
            password: true,
            name: "gdrive_webhook_url",
            display_name: "Google Drive Webhook URL",
            value: "",
            info: "URL Web App Google Apps Script Anda (https://script.google.com/macros/s/.../exec)."
          },
          gdrive_webhook_secret: {
            type: "str",
            required: false,
            show: true,
            password: true,
            advanced: true,
            name: "gdrive_webhook_secret",
            display_name: "Google Drive Webhook Secret",
            value: "expa-sec-token-2026",
            info: "Secret token untuk autentikasi ke Google Apps Script Webhook (SHARED_SECRET)."
          },
          gdrive_folder_id: {
            type: "str",
            required: false,
            show: true,
            advanced: true,
            name: "gdrive_folder_id",
            display_name: "Google Drive Folder ID (optional)",
            value: "",
            info: "ID Folder Google Drive tujuan (opsional). Kosongkan untuk simpan di My Drive utama."
          },
          composio_api_key: {
            type: "str",
            required: false,
            show: true,
            password: true,
            advanced: true,
            name: "composio_api_key",
            display_name: "Composio API Key (if using Composio)",
            value: "COMPOSIO_API_KEY",
            info: "Your Composio API Key (sk-comp-...). Falls back to COMPOSIO_API_KEY environment variable."
          },
          composio_user_id: {
            type: "str",
            required: false,
            show: true,
            advanced: true,
            name: "composio_user_id",
            display_name: "Composio User ID (if using Composio)",
            value: "default",
            info: "User ID atau workspace Composio Anda."
          },
          connected_account_id: {
            type: "str",
            required: false,
            show: true,
            advanced: true,
            name: "connected_account_id",
            display_name: "Composio Account ID (optional)",
            value: "",
            info: "Specific Connected Account ID (ca_...) for Google Drive. Leave empty to auto-detect."
          },
          file_format: {
            type: "str",
            required: false,
            show: true,
            name: "file_format",
            display_name: "File Format",
            value: "xlsx",
            options: ["xlsx", "csv"]
          },
          filter_status: {
            type: "str",
            required: false,
            show: true,
            name: "filter_status",
            display_name: "Filter Status",
            value: "draft_ready",
            options: ["draft_ready", "all", "pending", "duplicate", "rejected"]
          },
          db_path: {
            type: "str",
            required: false,
            show: true,
            advanced: true,
            name: "db_path",
            display_name: "Database path",
            value: "./data/expa_welcome.db"
          },
          output_dir: {
            type: "str",
            required: false,
            show: true,
            advanced: true,
            name: "output_dir",
            display_name: "Output Directory",
            value: "./data/exports"
          },
          tool_description: {
            type: "str",
            required: false,
            show: true,
            advanced: true,
            name: "tool_description",
            display_name: "Tool Description (for Agent)",
            value: "Exports EXPA WhatsApp draft messages to an Excel/CSV spreadsheet and uploads to Google Drive. Returns the file path and Google Drive status."
          }
        },
        outputs: [
          {
            display_name: "Report Message",
            name: "report",
            method: "export_pipeline",
            types: ["Message"],
            selected: "Message"
          },
          {
            display_name: "Agent Tool",
            name: "tool",
            method: "build_tool",
            types: ["Tool"],
            selected: "Tool"
          }
        ],
        field_order: [
          "upstream",
          "upload_to_gdrive",
          "gdrive_method",
          "gdrive_webhook_url",
          "gdrive_webhook_secret",
          "gdrive_folder_id",
          "file_format",
          "filter_status",
          "db_path",
          "output_dir",
          "composio_api_key",
          "composio_user_id",
          "connected_account_id",
          "tool_description"
        ]
      }
    }
  },

  // 10. ChatOutput
  {
    id: "ChatOutput-rep",
    type: "genericNode",
    position: { x: 3120, y: 280 },
    data: {
      type: "ChatOutput",
      id: "ChatOutput-rep",
      node: {
        display_name: "Chat Output",
        description: "Displays run summary report in the Playground.",
        icon: "MessagesSquare",
        template: {
          _type: "Component",
          code: {
            type: "code",
            required: true,
            show: true,
            multiline: true,
            name: "code",
            advanced: true,
            dynamic: true,
            value: code08
          },
          input_value: {
            type: "str",
            required: false,
            show: true,
            name: "input_value",
            display_name: "Input",
            input_types: ["Data", "Message", "str"],
            value: ""
          }
        },
        outputs: [
          {
            display_name: "Message",
            name: "message",
            method: "build_message",
            types: ["Message"],
            selected: "Message"
          }
        ],
        field_order: ["input_value"]
      }
    }
  }
];

const edges = [
  // 1. Webhook (data) -> Run Gate (payload)
  makeEdge("Webhook-trigger", "data", ["Data"], "ExpaRunGate-gate", "payload", ["Data"], "other"),

  // 2. Run Gate (run) -> EXPA Sign-ups (upstream)
  makeEdge("ExpaRunGate-gate", "run", ["Data"], "ExpaSignupsMock-src", "upstream", ["Data"], "other"),

  // 3. EXPA Sign-ups (signups) -> Validate & Normalize (upstream)
  makeEdge("ExpaSignupsMock-src", "signups", ["Data"], "ValidateNormalize-val", "upstream", ["Data"], "other"),

  // 4. Validate & Normalize (valid) -> Dedupe & Log (upstream)
  makeEdge("ValidateNormalize-val", "valid", ["Data"], "DedupeAndLog-ded", "upstream", ["Data"], "other"),

  // 5. Dedupe & Log (to_draft) -> Draft WhatsApp Message (upstream)
  makeEdge("DedupeAndLog-ded", "to_draft", ["Data"], "DraftMessage-dra", "upstream", ["Data"], "other"),

  // 6. Draft WhatsApp Message (drafts) -> Finish Run & Alert Human (upstream)
  makeEdge("DraftMessage-dra", "drafts", ["Data"], "FinishAndAlert-ale", "upstream", ["Data"], "other"),

  // 7. Finish Run & Alert Human (report) -> Export Drafts to Spreadsheet (upstream)
  makeEdge("FinishAndAlert-ale", "report", ["Data"], "ExportSpreadsheetTool-exp", "upstream", ["Data", "Message"], "other"),

  // 8. Export Drafts to Spreadsheet (report) -> Chat Output (input_value)
  makeEdge("ExportSpreadsheetTool-exp", "report", ["Message"], "ChatOutput-rep", "input_value", ["Data", "Message", "str"], "str")
];

const flowData = {
  id: "expa-welcome-drafter-flow",
  endpoint_name: "expa-welcome-drafter-flow",
  name: "EXPA Welcome Drafter",
  description: "Gets new EXPA sign-ups → drafts a WhatsApp message per person → logs every contact and skips duplicates → alerts a human when something fails. Nothing is sent automatically: drafts wait for a human review.",
  is_component: false,
  data: {
    nodes: nodes,
    edges: edges,
    viewport: {
      x: 0,
      y: 0,
      zoom: 0.8
    }
  }
};

fs.writeFileSync(outputFile, JSON.stringify(flowData, null, 2), 'utf-8');
console.log(`Successfully generated Langflow flow file at: ${outputFile}`);
console.log(`Total nodes: ${nodes.length}, Total edges: ${edges.length}`);
