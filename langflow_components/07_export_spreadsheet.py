"""Component 7: Export Drafts to Spreadsheet (Excel/CSV) + Google Drive (Composio).

Can operate as:
1. Pipeline step: reads contacts from DB and saves to .xlsx/.csv, then uploads to Google Drive.
2. Agentic Tool (toolmode): exposes `build_tool()` returning a LangChain Tool that an
   AI Agent can dynamically invoke to export & upload drafts.
"""
import csv
from datetime import datetime, timezone
import json
import os
import re
import sqlite3
import urllib.parse
import urllib.request
from typing import Any

from langchain_core.tools import Tool
from langflow.custom import Component
from langflow.io import BoolInput, DataInput, DropdownInput, MessageTextInput, Output, SecretStrInput
from langflow.schema import Data
from langflow.schema.message import Message


def _now():
    return datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")


def _resolve_path(p, default_name):
    if not p:
        p = default_name
    base = os.environ.get("EXPA_WORKSPACE_DIR") or os.getcwd()
    candidates = [
        p,
        os.path.join(base, p.lstrip("./\\")),
        os.path.join(base, "data", os.path.basename(p)),
    ]
    for c in candidates:
        if os.path.exists(c):
            return c
    return p


def _sanitize_cell(val):
    if val is None:
        return ""
    s = str(val)
    if s.startswith(("=", "+", "-", "@", "\t", "\r")):
        return "'" + s
    return s


class ExportSpreadsheetTool(Component):
    display_name = "Export Drafts to Spreadsheet"
    description = "Exports WhatsApp draft messages to an Excel (.xlsx) / CSV spreadsheet and uploads to Google Drive via Composio."
    icon = "FileSpreadsheet"
    name = "ExportSpreadsheetTool"

    inputs = [
        DataInput(
            name="upstream",
            display_name="From Pipeline (optional)",
            info="Connect upstream component here if running directly in the pipeline.",
            input_types=["Data", "Message"],
            required=False,
        ),
        BoolInput(
            name="upload_to_gdrive",
            display_name="Upload to Google Drive",
            value=True,
            info="Automatically upload the generated spreadsheet to Google Drive.",
        ),
        DropdownInput(
            name="gdrive_method",
            display_name="Google Drive Method",
            options=["Apps Script Webhook (Direct & Stable)", "Composio (Legacy)"],
            value="Apps Script Webhook (Direct & Stable)",
            info="Metode upload ke Google Drive. Apps Script Webhook langsung menyimpan file ke Google Drive Anda tanpa perantara dan tanpa ribet akun Composio.",
        ),
        SecretStrInput(
            name="gdrive_webhook_url",
            display_name="Google Drive Webhook URL",
            value="",
            info="URL Web App Google Apps Script Anda (https://script.google.com/macros/s/.../exec).",
            advanced=False,
            required=False,
        ),
        SecretStrInput(
            name="gdrive_webhook_secret",
            display_name="Google Drive Webhook Secret",
            value="expa-sec-token-2026",
            info="Secret token untuk autentikasi ke Google Apps Script Webhook (SHARED_SECRET).",
            advanced=True,
            required=False,
        ),
        MessageTextInput(
            name="gdrive_folder_id",
            display_name="Google Drive Folder ID / URL (optional)",
            value="",
            info="ID folder atau URL lengkap folder Google Drive tujuan (misal: drive.google.com/drive/folders/1ABC...). Kosongkan untuk simpan di My Drive utama.",
            advanced=False,
        ),
        SecretStrInput(
            name="composio_api_key",
            display_name="Composio API Key (if using Composio)",
            value="COMPOSIO_API_KEY",
            info="Your Composio API Key jika menggunakan metode Composio.",
            advanced=True,
            required=False,
        ),
        MessageTextInput(
            name="composio_user_id",
            display_name="Composio User ID (if using Composio)",
            value="default",
            info="User ID Composio jika menggunakan metode Composio.",
            advanced=True,
        ),
        MessageTextInput(
            name="connected_account_id",
            display_name="Composio Account ID (optional)",
            value="",
            info="Specific Connected Account ID (ca_...) for Google Drive. Leave empty to auto-detect.",
            advanced=True,
        ),
        DropdownInput(
            name="file_format",
            display_name="File Format",
            options=["xlsx", "csv"],
            value="xlsx",
            info="Format of the exported file.",
        ),
        DropdownInput(
            name="filter_status",
            display_name="Filter Status",
            options=["draft_ready", "all", "pending", "duplicate", "rejected"],
            value="draft_ready",
            info="Filter contacts to export. 'draft_ready' exports contacts with generated messages.",
        ),
        MessageTextInput(
            name="db_path",
            display_name="Database path",
            value="./data/expa_welcome.db",
            info="Path to expa_welcome.db SQLite database.",
            advanced=True,
        ),
        MessageTextInput(
            name="output_dir",
            display_name="Output Directory",
            value="./data/exports",
            info="Local folder where spreadsheet files are saved before upload.",
            advanced=True,
        ),
        MessageTextInput(
            name="tool_description",
            display_name="Tool Description (for Agent)",
            value="Exports EXPA WhatsApp draft messages to an Excel/CSV spreadsheet and uploads to Google Drive. Returns the file path and Google Drive status.",
            advanced=True,
        ),
    ]

    outputs = [
        Output(display_name="Report Message", name="report", method="export_pipeline"),
        Output(display_name="Agent Tool", name="tool", method="build_tool"),
    ]

    def update_build_config(self, build_config: dict, field_value: Any, field_name: str | None = None) -> dict:
        """Cek status koneksi Google Drive secara interaktif atau buatkan link login OAuth."""
        api_key = build_config.get("composio_api_key", {}).get("value") or os.environ.get("COMPOSIO_API_KEY", "")
        if api_key == "COMPOSIO_API_KEY":
            api_key = os.environ.get("COMPOSIO_API_KEY", "")

        user_id = build_config.get("composio_user_id", {}).get("value") or os.environ.get("COMPOSIO_USER_ID", "default")
        if not user_id:
            user_id = "default"

        try:
            from composio import Composio
            client = Composio(api_key=api_key) if api_key else Composio()

            found_active = False
            account_desc = ""
            try:
                accs = client.connected_accounts.list()
                items = getattr(accs, "items", accs)
                if isinstance(items, list):
                    for a in items:
                        slug = str(getattr(a, "app_name", "") or getattr(getattr(a, "toolkit", None), "slug", "") or "")
                        status = str(getattr(a, "status", "")).upper()
                        if "googledrive" in slug.lower() or "drive" in slug.lower() or "drive" in str(a).lower():
                            if not status or status == "ACTIVE":
                                found_active = True
                                name = getattr(a, "name", None) or getattr(a, "id", None) or "Active"
                                account_desc = f"{name} (Status: ACTIVE)"
                                break
            except Exception:
                pass

            if found_active:
                build_config["auth_status"]["value"] = f"✅ TERHUBUNG: {account_desc}"
            else:
                login_url = None
                try:
                    session = client.create(user_id=user_id)
                    conn_req = session.authorize("googledrive")
                    login_url = getattr(conn_req, "redirect_url", None)
                except Exception:
                    login_url = f"https://dashboard.composio.dev/{user_id}/~/chat/apps/googledrive"

                build_config["auth_status"]["value"] = f"🔗 Link Login: {login_url}"
        except Exception as e:
            build_config["auth_status"]["value"] = f"⚠️ Cek gagal: {str(e)}"

        return build_config

    def _get_db(self):
        return _resolve_path(self.db_path, "expa_welcome.db")

    def _fetch_rows(self, filter_status="draft_ready"):
        db_file = self._get_db()
        if not os.path.exists(db_file):
            return [], f"Database not found at {db_file}"

        conn = sqlite3.connect(db_file)
        conn.row_factory = sqlite3.Row
        try:
            if filter_status == "all":
                query = "SELECT * FROM contacts ORDER BY created_at DESC"
                rows = conn.execute(query).fetchall()
            elif filter_status == "draft_ready":
                query = (
                    "SELECT * FROM contacts WHERE status = ?"
                    " AND COALESCE(first_name, full_name, '') != ''"
                    " AND COALESCE(programme, '') != ''"
                    " AND COALESCE(phone_e164, '') != ''"
                    " ORDER BY created_at DESC"
                )
                rows = conn.execute(query, (filter_status,)).fetchall()
            else:
                query = "SELECT * FROM contacts WHERE status = ? ORDER BY created_at DESC"
                rows = conn.execute(query, (filter_status,)).fetchall()
            return [dict(r) for r in rows], None
        finally:
            conn.close()

    def _upload_via_apps_script(self, file_path, file_name):
        raw_url = getattr(self, "gdrive_webhook_url", "") or os.environ.get("GDRIVE_WEBHOOK_URL", "")
        if hasattr(raw_url, "get_secret_value"):
            url = raw_url.get_secret_value().strip()
        elif hasattr(raw_url, "value"):
            url = str(raw_url.value).strip()
        else:
            url = str(raw_url or "").strip()
        if not url:
            return False, (
                "Google Drive Webhook URL belum diisi.\n"
                "👉 Cara cepat: Buka script.google.com, buat script Google Drive (tersedia di tools/google_drive_uploader.js), Deploy as Web App, lalu masukkan Web App URL-nya ke kolom ini."
            )

        import base64
        import json

        try:
            with open(file_path, "rb") as f:
                b64 = base64.b64encode(f.read()).decode("utf-8")

            mime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" if file_name.endswith(".xlsx") else "text/csv"
            folder_raw = str(getattr(self, "gdrive_folder_id", "") or "").strip()
            folder_match = re.search(r"folders/([a-zA-Z0-9_-]+)", folder_raw)
            clean_folder_id = folder_match.group(1) if folder_match else (folder_raw.split("?")[0].rstrip("/").split("/")[-1] if folder_raw else "")

            raw_secret = getattr(self, "gdrive_webhook_secret", "") or os.environ.get("GDRIVE_WEBHOOK_SECRET", "expa-sec-token-2026")
            if hasattr(raw_secret, "get_secret_value"):
                secret = raw_secret.get_secret_value().strip()
            elif hasattr(raw_secret, "value"):
                secret = str(raw_secret.value).strip()
            else:
                secret = str(raw_secret or "expa-sec-token-2026").strip()

            payload = {
                "auth_token": secret,
                "file_name": file_name,
                "mime_type": mime,
                "base64_data": b64,
                "folder_id": clean_folder_id,
            }

            headers = {
                "Content-Type": "application/json",
                "X-Webhook-Token": secret,
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            }

            res_json = None
            try:
                import requests
                resp = requests.post(url, json=payload, headers=headers, timeout=60, allow_redirects=True)
                if resp.status_code == 403:
                    return False, (
                        "HTTP 403 Forbidden: Google Apps Script menolak akses.\n"
                        "👉 Penyebab: Pengaturan izin akses di Google Apps Script belum dibuka untuk 'Anyone'.\n"
                        "👉 Solusi (10 detik):\n"
                        "1. Buka https://script.google.com/ proyek kamu.\n"
                        "2. Klik 'Deploy' -> 'Manage deployments' (Kelola penerapan).\n"
                        "3. Klik ikon pensil ✏️ (Edit).\n"
                        "4. Ubah 'Who has access' (Siapa yang memiliki akses) menjadi 'Anyone' (Siapa saja).\n"
                        "5. Klik 'Deploy' dan jalankan kembali flow!"
                    )
                try:
                    res_json = resp.json()
                except Exception:
                    res_json = {"status": "error", "message": f"HTTP {resp.status_code}: {resp.text[:200]}"}
            except Exception:
                import urllib.request
                import urllib.error
                req = urllib.request.Request(
                    url,
                    data=json.dumps(payload).encode("utf-8"),
                    headers=headers,
                    method="POST",
                )
                opener = urllib.request.build_opener(urllib.request.HTTPRedirectHandler)
                try:
                    with opener.open(req, timeout=60) as resp:
                        res_json = json.loads(resp.read().decode("utf-8"))
                except urllib.error.HTTPError as http_err:
                    if http_err.code == 403:
                        return False, (
                            "HTTP 403 Forbidden: Google Apps Script menolak akses.\n"
                            "👉 Penyebab: Pengaturan izin akses di Google Apps Script belum dibuka untuk 'Anyone'.\n"
                            "👉 Solusi (10 detik):\n"
                            "1. Buka https://script.google.com/ proyek kamu.\n"
                            "2. Klik 'Deploy' -> 'Manage deployments' (Kelola penerapan).\n"
                            "3. Klik ikon pensil ✏️ (Edit).\n"
                            "4. Ubah 'Who has access' (Siapa yang memiliki akses) menjadi 'Anyone' (Siapa saja).\n"
                            "5. Klik 'Deploy' dan jalankan kembali flow!"
                        )
                    raise http_err

            if res_json and res_json.get("status") == "success":
                file_url = res_json.get("file_url") or res_json.get("url") or ""
                return True, f"Tersimpan di Google Drive! Buka file: {file_url}"
            else:
                err_detail = (res_json.get("message") if res_json else "No response")
                return False, f"Apps Script notice: {err_detail}"
        except Exception as e:
            return False, f"Gagal upload via Google Apps Script: {str(e)}"

    def _upload_to_gdrive(self, file_path, file_name):
        method = str(getattr(self, "gdrive_method", "") or "Apps Script").lower()
        if "apps script" in method or "webhook" in method or "direct" in method:
            return self._upload_via_apps_script(file_path, file_name)

        api_key = str(self.composio_api_key or os.environ.get("COMPOSIO_API_KEY", "")).strip()
        if api_key == "COMPOSIO_API_KEY":
            api_key = os.environ.get("COMPOSIO_API_KEY", "").strip()

        abs_path = os.path.abspath(file_path)
        folder_id = str(self.gdrive_folder_id or "").strip()
        user_id = str(self.composio_user_id or "default").strip() or "default"

        # Method 1: Modern Composio Client (v0.5+)
        try:
            from composio import Composio

            kwargs = {"api_key": api_key} if api_key else {}
            client = Composio(**kwargs)

            # Auto-detect connected Google Drive account
            target_account_id = str(getattr(self, "connected_account_id", "") or "").strip() or None
            target_user_id = user_id if user_id and user_id != "default" else None
            found_drive_accounts = []

            try:
                acc_list = client.connected_accounts.list()
                items = getattr(acc_list, "items", acc_list)
                if isinstance(items, list):
                    for acc in items:
                        slug = ""
                        if hasattr(acc, "toolkit") and hasattr(acc.toolkit, "slug"):
                            slug = str(acc.toolkit.slug)
                        elif hasattr(acc, "app_name"):
                            slug = str(acc.app_name)
                        elif isinstance(acc, dict):
                            slug = str(acc.get("app_name") or acc.get("toolkit", {}).get("slug", ""))

                        if "googledrive" in slug.lower() or "drive" in slug.lower():
                            status = str(getattr(acc, "status", "") or (acc.get("status") if isinstance(acc, dict) else "")).upper()
                            acc_id = getattr(acc, "id", None) or (acc.get("id") if isinstance(acc, dict) else None)
                            u_id = getattr(acc, "user_id", None) or getattr(acc, "entity_id", None) or (acc.get("user_id") if isinstance(acc, dict) else None)
                            found_drive_accounts.append(f"ID:{acc_id} (user:{u_id}, status:{status})")
                            if (not status or status == "ACTIVE") and not target_account_id:
                                target_account_id = acc_id
                                if not target_user_id and u_id:
                                    target_user_id = str(u_id)
            except Exception:
                pass

            if not target_user_id:
                target_user_id = user_id or "default"

            args = {"file_to_upload": abs_path}
            if folder_id:
                args["parent_folder_id"] = folder_id

            exec_kwargs = {
                "slug": "GOOGLEDRIVE_UPLOAD_FILE",
                "arguments": args,
                "dangerously_skip_version_check": True,
            }
            if target_account_id:
                exec_kwargs["connected_account_id"] = target_account_id

            # Prepare list of user IDs to try (user input, env var, default)
            candidate_users = []
            for u_cand in (target_user_id, os.environ.get("COMPOSIO_USER_ID"), "default"):
                if u_cand and u_cand not in candidate_users:
                    candidate_users.append(u_cand)

            resp = None
            last_err = None
            for u in candidate_users:
                try:
                    kwargs_to_try = dict(exec_kwargs)
                    kwargs_to_try["user_id"] = u
                    resp = client.tools.execute(**kwargs_to_try)
                    last_err = None
                    break
                except Exception as ex:
                    last_err = ex
                    # If failed with connected_account_id, try without connected_account_id
                    if "connected_account_id" in kwargs_to_try:
                        try:
                            kwargs_to_try.pop("connected_account_id")
                            resp = client.tools.execute(**kwargs_to_try)
                            last_err = None
                            break
                        except Exception as ex2:
                            last_err = ex2

            if resp is None and last_err is not None:
                err_str = str(last_err)
                if any(x in err_str for x in ["ConnectedAccountNotFound", "No connected account found", "ActionExecute_ConnectedAccountEntityIdRequired", "1810"]):
                    eff_uid = target_user_id or "default"
                    login_url = None
                    try:
                        session = client.create(user_id=eff_uid)
                        conn_req = session.authorize("googledrive")
                        login_url = getattr(conn_req, "redirect_url", None)
                    except Exception:
                        login_url = f"https://dashboard.composio.dev/{eff_uid}/~/chat/apps/googledrive"

                    login_msg = (
                        f"Akun Google Drive belum terhubung untuk User ID '{eff_uid}'.\n"
                        f"👉 Silakan klik tautan berikut untuk login & otorisasi Google Drive Anda:\n"
                        f"{login_url}\n"
                        f"*(Setelah login selesai di browser, klik 'Run Flow' kembali untuk otomatis upload)*"
                    )
                    return False, login_msg
                raise last_err

            file_link = ""
            if isinstance(resp, dict):
                data_block = resp.get("data") or resp.get("response_data") or resp
                file_link = (
                    data_block.get("webViewLink")
                    or data_block.get("alternateLink")
                    or data_block.get("id")
                    or str(data_block)
                )
            else:
                file_link = str(resp)
            return True, f"Uploaded to Google Drive via Composio! Link/ID: {file_link}"
        except Exception as e_client:
            err_str = str(e_client)
            if any(x in err_str for x in ["ConnectedAccountNotFound", "No connected account found", "ActionExecute_ConnectedAccountEntityIdRequired", "1810"]):
                eff_uid = target_user_id or "default"
                login_url = None
                try:
                    from composio import Composio
                    client = Composio(api_key=api_key) if api_key else Composio()
                    session = client.create(user_id=eff_uid)
                    conn_req = session.authorize("googledrive")
                    login_url = getattr(conn_req, "redirect_url", None)
                except Exception:
                    login_url = f"https://dashboard.composio.dev/{eff_uid}/~/chat/apps/googledrive"

                login_msg = (
                    f"Akun Google Drive belum terhubung untuk User ID '{eff_uid}'.\n"
                    f"👉 Silakan klik tautan berikut untuk login & otorisasi Google Drive Anda:\n"
                    f"{login_url}\n"
                    f"*(Setelah login selesai di browser, klik 'Run Flow' kembali untuk otomatis upload)*"
                )
                return False, login_msg
            # Method 2: ComposioToolSet with string action slug
            try:
                from composio import ComposioToolSet

                toolset = ComposioToolSet(api_key=api_key) if api_key else ComposioToolSet()
                params = {
                    "file_path": abs_path,
                    "file_to_upload": abs_path,
                    "name": file_name,
                }
                if folder_id:
                    params["parent_folder_id"] = folder_id

                resp = toolset.execute_action(action="GOOGLEDRIVE_UPLOAD_FILE", params=params)
                file_link = ""
                if isinstance(resp, dict):
                    data_block = resp.get("data") or resp.get("response_data") or resp
                    file_link = data_block.get("webViewLink") or data_block.get("alternateLink") or data_block.get("id") or str(data_block)
                else:
                    file_link = str(resp)
                return True, f"Uploaded to Google Drive via Composio ToolSet! Link: {file_link}"
            except Exception as e_toolset:
                # Method 3: composio_langchain Action enum (if legacy installed)
                try:
                    from composio_langchain import Action, ComposioToolSet
                    toolset = ComposioToolSet(api_key=api_key) if api_key else ComposioToolSet()
                    resp = toolset.execute_action(action=Action.GOOGLEDRIVE_UPLOAD_FILE, params={"file_path": abs_path, "name": file_name})
                    return True, f"Uploaded to Google Drive! (Response: {resp})"
                except Exception as e_legacy:
                    return False, f"Composio execute notice: {str(e_client)} | ToolSet: {str(e_toolset)}"

    def _do_export(self, filter_status=None, custom_filename=None):
        status_to_use = filter_status or self.filter_status or "draft_ready"
        if "draft_ready" in status_to_use:
            status_to_use = "draft_ready"
        elif "all" in status_to_use:
            status_to_use = "all"

        rows, err = self._fetch_rows(status_to_use)
        if err:
            return err

        if not rows:
            return f"No contacts found with status '{status_to_use}'. Total exported: 0 rows."

        out_dir = self.output_dir or "./data/exports"
        if not os.path.isabs(out_dir):
            base = os.environ.get("EXPA_WORKSPACE_DIR") or os.getcwd()
            out_dir = os.path.join(base, out_dir.lstrip("./\\"))
        os.makedirs(out_dir, exist_ok=True)

        timestamp = _now()
        fmt = (self.file_format or "xlsx").lower()
        if custom_filename:
            clean_name = os.path.basename(str(custom_filename)).strip()
            clean_name = re.sub(r"[^a-zA-Z0-9_\-]", "_", clean_name)
            base_name = clean_name or f"expa_drafts_{status_to_use}_{timestamp}"
        else:
            base_name = f"expa_drafts_{status_to_use}_{timestamp}"
        target_file = os.path.join(out_dir, f"{base_name}.{fmt}")

        headers = [
            "No",
            "EXPA ID",
            "Nama Lengkap",
            "Nomor WhatsApp",
            "Nomor Masked",
            "Programme",
            "LC (Komite Lokal)",
            "Status",
            "Sumber Draft",
            "Isi Pesan WhatsApp",
            "Link Kirim WhatsApp",
            "Waktu Update",
        ]

        data_rows = []
        for idx, r in enumerate(rows, start=1):
            phone_raw = str(r.get("phone_e164") or "").lstrip("+")
            raw_draft = str(r.get("draft_text") or "")
            draft_text = _sanitize_cell(raw_draft)
            wa_link = f"https://wa.me/{phone_raw}?text={urllib.parse.quote(raw_draft)}" if phone_raw else ""
            display_name = r.get("full_name") or r.get("first_name") or ""
            data_rows.append([
                idx,
                _sanitize_cell(r.get("expa_id") or ""),
                _sanitize_cell(display_name),
                _sanitize_cell(r.get("phone_e164") or ""),
                _sanitize_cell(r.get("phone_masked") or ""),
                _sanitize_cell(r.get("programme") or ""),
                _sanitize_cell(r.get("lc") or ""),
                _sanitize_cell(r.get("status") or ""),
                _sanitize_cell(r.get("draft_source") or ""),
                draft_text,
                wa_link,
                _sanitize_cell(r.get("updated_at") or r.get("created_at") or ""),
            ])

        written_format = fmt
        if fmt == "xlsx":
            try:
                import openpyxl
                from openpyxl.styles import Font, PatternFill, Alignment

                wb = openpyxl.Workbook()
                ws = wb.active
                ws.title = "WhatsApp Drafts"
                ws.append(headers)

                header_fill = PatternFill(start_color="1F497D", end_color="1F497D", fill_type="solid")
                header_font = Font(color="FFFFFF", bold=True)
                for cell in ws[1]:
                    cell.fill = header_fill
                    cell.font = header_font
                    cell.alignment = Alignment(horizontal="center", vertical="center")

                for row in data_rows:
                    ws.append(row)

                for col in ws.columns:
                    col_letter = col[0].column_letter
                    if col_letter == "J":  # WhatsApp message column
                        ws.column_dimensions[col_letter].width = 50
                        for cell in col[1:]:
                            cell.alignment = Alignment(wrap_text=True, vertical="top")
                    else:
                        ws.column_dimensions[col_letter].width = 18

                wb.save(target_file)
            except ImportError:
                written_format = "csv"
                target_file = os.path.join(out_dir, f"{base_name}.csv")
                with open(target_file, "w", newline="", encoding="utf-8-sig") as f:
                    writer = csv.writer(f)
                    writer.writerow(headers)
                    writer.writerows(data_rows)
        else:
            with open(target_file, "w", newline="", encoding="utf-8-sig") as f:
                writer = csv.writer(f)
                writer.writerow(headers)
                writer.writerows(data_rows)

        # Upload to Google Drive if enabled
        gdrive_status = ""
        if self.upload_to_gdrive:
            success, detail = self._upload_to_gdrive(target_file, f"{base_name}.{written_format}")
            if success:
                gdrive_status = f"\n☁️ Google Drive: {detail}"
            else:
                gdrive_status = f"\n⚠️ Google Drive notice: {detail}"

        summary_msg = (
            f"Successfully exported {len(data_rows)} contacts ({status_to_use}) to {written_format.upper()} spreadsheet:\n"
            f"📁 Local File: {target_file}"
            f"{gdrive_status}"
        )
        return summary_msg

    def export_pipeline(self) -> Message:
        result = self._do_export()
        self.status = result
        upstream_text = ""
        if self.upstream:
            d = getattr(self.upstream, "data", self.upstream)
            if isinstance(d, dict):
                upstream_text = d.get("text") or ""
            elif hasattr(self.upstream, "text"):
                upstream_text = str(self.upstream.text or "")
        combined = f"{upstream_text}\n\n[Spreadsheet & Google Drive Export]\n{result}".strip() if upstream_text else result
        return Message(text=combined)

    def build_tool(self) -> Tool:
        def _tool_run(query: str = "") -> str:
            status = "draft_ready"
            q_lower = (query or "").lower()
            if "all" in q_lower:
                status = "all"
            elif "duplicate" in q_lower:
                status = "duplicate"
            elif "rejected" in q_lower:
                status = "rejected"
            return self._do_export(filter_status=status)

        return Tool(
            name="export_whatsapp_drafts_spreadsheet",
            description=self.tool_description or "Exports EXPA WhatsApp draft messages to an Excel/CSV spreadsheet and uploads to Google Drive via Composio. Argument can be empty or 'all', 'draft_ready'.",
            func=_tool_run,
        )

