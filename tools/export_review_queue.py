"""Export drafts waiting for human review, with a click-to-chat wa.me link per contact.

The CSV contains personal data: store it carefully, delete it after use.
Usage: python3 tools/export_review_queue.py --db ./data/expa_welcome.db --out review_queue.csv
"""
import argparse, csv, sqlite3, urllib.parse

ap = argparse.ArgumentParser()
ap.add_argument("--db", default="./data/expa_welcome.db")
ap.add_argument("--out", default="review_queue.csv")
a = ap.parse_args()
conn = sqlite3.connect(a.db); conn.row_factory = sqlite3.Row
rows = conn.execute("SELECT contact_key, COALESCE(full_name, first_name) AS full_name, phone_e164, programme, lc, draft_source, draft_text FROM contacts"
                    " WHERE status='draft_ready' AND phone_e164 IS NOT NULL ORDER BY created_at, contact_key").fetchall()
def sanitize_cell(val):
    s = str(val or "")
    if s.startswith(("=", "+", "-", "@", "\t", "\r")):
        return "'" + s
    return s

with open(a.out, "w", newline="", encoding="utf-8") as fh:
    w = csv.writer(fh)
    w.writerow(["contact_key", "full_name", "phone", "programme", "lc", "draft_source", "draft", "wa_link"])
    for r in rows:
        link = f"https://wa.me/{r['phone_e164'].lstrip('+')}?text={urllib.parse.quote(r['draft_text'])}"
        w.writerow([
            sanitize_cell(r["contact_key"]),
            sanitize_cell(r["full_name"]),
            sanitize_cell(r["phone_e164"]),
            sanitize_cell(r["programme"]),
            sanitize_cell(r["lc"]),
            sanitize_cell(r["draft_source"]),
            sanitize_cell(r["draft_text"]),
            link
        ])
print(f"exported {len(rows)} drafts to {a.out}")

