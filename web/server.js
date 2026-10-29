/**
 * EXPA Welcome Drafter - Remote Controller Server
 * Serves the minimalist AIESEC-themed web frontend and communicates
 * with Langflow API and SQLite database.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

let DatabaseSync;
try {
  DatabaseSync = require('node:sqlite').DatabaseSync;
} catch (e) {
  DatabaseSync = null;
}

const PORT = process.env.PORT || 3000;
const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const DB_PATH = path.join(DATA_DIR, 'expa_welcome.db');
const CONFIG_FILE = path.join(DATA_DIR, 'frontend_config.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Default Configuration
const DEFAULT_CONFIG = {
  langflow_host: "http://127.0.0.1:7860",
  flow_id: "83ac3a5b-084b-4b02-a191-f5f89083b642",
  langflow_api_key: "",
  webhook_slug: "Webhook-trigger",
  cta_link: "https://aiesec.or.id/welcome",
  message_template: "Halo {full_name}! Terima kasih sudah mendaftar {programme} di AIESEC in {lc}. Kami senang menyambutmu untuk langkah kepemimpinan berikutnya. Informasi lengkap dan langkah selanjutnya bisa kamu akses di {cta_link}. Ada pertanyaan yang ingin kamu tanyakan ke tim kami?",
  gdrive_webhook_url: "",
  gdrive_webhook_secret: "expa-sec-token-2026",
  flaz_model: "qwen3.8-flash"
};

const PROGRAMME_FULL = {
  GV: 'Global Volunteer (GV)',
  GTa: 'Global Talent (GTa)',
  GTe: 'Global Teacher (GTe)'
};

function renderMessageFromTemplate(templateStr, contact, ctaLink) {
  const rawTpl = String(templateStr || DEFAULT_CONFIG.message_template).trim() || DEFAULT_CONFIG.message_template;
  const fullName = String(contact.full_name || contact.first_name || 'Pendaftar').trim();
  const firstName = String(contact.first_name || fullName.split(' ')[0] || 'Pendaftar').trim();
  const prog = String(contact.programme || 'GV').trim();
  const progFull = PROGRAMME_FULL[prog] || 'program AIESEC';
  const rawLc = String(contact.lc || 'Indonesia').replace(/^AIESEC\s+in\s+/i, '').trim() || 'Indonesia';
  const link = String(ctaLink || DEFAULT_CONFIG.cta_link).trim();

  let msg = rawTpl
    .replace(/\{full_name\}/gi, fullName)
    .replace(/\{first_name\}/gi, firstName)
    .replace(/\{programme\}/gi, prog)
    .replace(/\{programme_full\}/gi, progFull)
    .replace(/\{lc\}/gi, rawLc)
    .replace(/\{cta_link\}/gi, link);

  msg = msg.replace(/(AIESEC in\s+)+(AIESEC in\s+)/gi, 'AIESEC in ');
  return msg.replace(/\s+/g, ' ').trim();
}

function computePhoneHash(phone) {
  if (!phone) return '';
  const salt = process.env.DEDUPE_SALT || 'dev-only-salt';
  return crypto.createHmac('sha256', salt).update(String(phone)).digest('hex').slice(0, 32);
}

function resolveLangflowHost(host) {
  let clean = String(host || DEFAULT_CONFIG.langflow_host).trim();
  const urlMatch = clean.match(/^(https?:\/\/[^/]+)/i);
  if (urlMatch) clean = urlMatch[1];
  return clean.replace(/\/+$/, '').replace('://localhost', '://127.0.0.1');
}

function extractFlowId(rawFlowId) {
  const s = String(rawFlowId || DEFAULT_CONFIG.flow_id).trim();
  const uuidMatch = s.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return uuidMatch ? uuidMatch[1] : s;
}

async function resolveLangflowFlowId(hostUrl, configuredFlowId, configuredApiKey) {
  const cleanId = extractFlowId(configuredFlowId);
  let apiKey = String(configuredApiKey || process.env.LANGFLOW_API_KEY || '').trim();
  let token = null;

  try {
    const loginRes = await fetch(`${hostUrl}/api/v1/auto_login`, { signal: AbortSignal.timeout(2500) }).catch(() => null);
    if (loginRes && loginRes.ok) {
      const loginData = await loginRes.json().catch(() => null);
      if (loginData && loginData.access_token) token = loginData.access_token;
    }
  } catch (_) {}

  // Auto-provision Langflow API Key if webhook/run auth is enabled and no key is configured yet
  if (!apiKey && token) {
    try {
      const keyRes = await fetch(`${hostUrl}/api/v1/api_key/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ name: 'expa-web-dispatcher' }),
        signal: AbortSignal.timeout(2500)
      }).catch(() => null);
      if (keyRes && keyRes.ok) {
        const keyData = await keyRes.json().catch(() => null);
        if (keyData && keyData.api_key) {
          apiKey = keyData.api_key;
          const currentCfg = getConfig();
          saveConfig({ ...currentCfg, langflow_api_key: apiKey });
        }
      }
    } catch (_) {}
  }

  const headers = {};
  if (apiKey) headers['x-api-key'] = apiKey;
  if (token) headers['Authorization'] = `Bearer ${token}`;

  let targetFlow = null;
  try {
    // 1. Try direct lookup by UUID
    const directRes = await fetch(`${hostUrl}/api/v1/flows/${cleanId}`, {
      headers,
      signal: AbortSignal.timeout(2500)
    }).catch(() => null);
    if (directRes && directRes.ok) {
      targetFlow = await directRes.json().catch(() => null);
    }

    // 2. Fallback to listing flows
    if (!targetFlow || !targetFlow.id) {
      const flowsRes = await fetch(`${hostUrl}/api/v1/flows/`, {
        headers,
        signal: AbortSignal.timeout(2500)
      }).catch(() => null);
      if (flowsRes && flowsRes.ok) {
        const flows = await flowsRes.json().catch(() => null);
        const list = Array.isArray(flows) ? flows : (flows && Array.isArray(flows.flows) ? flows.flows : []);
        targetFlow = list.find(f =>
          f.id === cleanId ||
          f.endpoint_name === cleanId ||
          (f.name && f.name.toLowerCase().includes('expa welcome drafter'))
        ) || null;
      }
    }

    // 3. Auto-sync flow definition if components/edges need to be updated to the latest canonical flow
    if (targetFlow && targetFlow.id && targetFlow.data) {
      const nodes = Array.isArray(targetFlow.data.nodes) ? targetFlow.data.nodes : [];
      const edges = Array.isArray(targetFlow.data.edges) ? targetFlow.data.edges : [];
      const draftNode = nodes.find(n => n.data && n.data.type === 'DraftMessage');
      const valNode = nodes.find(n => n.data && n.data.type === 'ValidateNormalize');
      const dedNode = nodes.find(n => n.data && n.data.type === 'DedupeAndLog');
      const hasTemplateInput = !!(draftNode && draftNode.data?.node?.template?.message_template);
      const hasStrictValidate = !!(valNode && String(valNode.data?.node?.template?.code?.value || '').includes('unknown_programme'));
      const hasStrictDedupe = !!(dedNode && String(dedNode.data?.node?.template?.code?.value || '').includes('phone_hash=? OR phone_e164=?'));
      const canonicalFile = path.join(ROOT_DIR, 'langflow', 'expa-welcome-drafter.json');
      if ((nodes.length !== 9 || edges.length !== 8 || !hasTemplateInput || !hasStrictValidate || !hasStrictDedupe) && fs.existsSync(canonicalFile)) {
        try {
          const canonical = JSON.parse(fs.readFileSync(canonicalFile, 'utf-8'));
          const patchRes = await fetch(`${hostUrl}/api/v1/flows/${targetFlow.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify({ data: canonical.data, endpoint_name: 'expa-welcome-drafter-flow' }),
            signal: AbortSignal.timeout(4000)
          }).catch(() => null);
          if (patchRes && patchRes.ok) {
            targetFlow = await patchRes.json().catch(() => targetFlow);
          }
        } catch (_) {}
      }
    }
  } catch (_) {}

  const nodeMap = {
    Webhook: "Webhook-trigger",
    ExpaRunGate: "ExpaRunGate-gate",
    ExpaSignupsMock: "ExpaSignupsMock-src",
    ValidateNormalize: "ValidateNormalize-val",
    DedupeAndLog: "DedupeAndLog-ded",
    FlazCloudModel: "FlazCloudModel-llm",
    DraftMessage: "DraftMessage-dra",
    FinishAndAlert: "FinishAndAlert-ale",
    ExportSpreadsheetTool: "ExportSpreadsheetTool-exp",
    ChatOutput: "ChatOutput-rep"
  };

  if (targetFlow && targetFlow.data && Array.isArray(targetFlow.data.nodes)) {
    for (const n of targetFlow.data.nodes) {
      const t = (n.data && n.data.type) || '';
      if (t && nodeMap[t]) nodeMap[t] = n.id;
    }
  }

  const finalId = (targetFlow && targetFlow.id) ? targetFlow.id : cleanId;
  return {
    flowId: finalId,
    endpointName: (targetFlow && targetFlow.endpoint_name) || finalId,
    headers,
    nodeMap
  };
}

function extractLangflowText(runJson) {
  if (!runJson) return '';
  try {
    const outputs = runJson.outputs || [];
    for (const out of outputs) {
      for (const compOut of (out.outputs || [])) {
        const msg = compOut?.results?.message?.text
          || compOut?.results?.message?.data?.text
          || compOut?.results?.report?.text
          || compOut?.results?.report?.data?.text
          || compOut?.messages?.[0]?.message
          || compOut?.artifacts?.message;
        if (msg) return String(msg);
      }
    }
  } catch (_) {}
  return JSON.stringify(runJson);
}

function getConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) };
    }
  } catch (e) {
    console.error("Config read error:", e.message);
  }
  return DEFAULT_CONFIG;
}

function saveConfig(cfg) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.error("Config save error:", e.message);
    return false;
  }
}

function getDb() {
  if (!DatabaseSync) return null;
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const db = new DatabaseSync(DB_PATH);
    
    // Ensure table exists
    db.exec(`
      CREATE TABLE IF NOT EXISTS contacts (
        contact_key TEXT PRIMARY KEY, expa_id TEXT, phone_hash TEXT, phone_e164 TEXT, phone_masked TEXT,
        first_name TEXT, full_name TEXT, programme TEXT, lc TEXT, language TEXT, status TEXT, reason TEXT,
        attempts INTEGER DEFAULT 0, draft_text TEXT, draft_source TEXT,
        first_seen_run TEXT, last_run TEXT, created_at TEXT, updated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY, trigger_key TEXT UNIQUE, started_at TEXT, finished_at TEXT,
        status TEXT, summary TEXT
      );
    `);
    
    // Ensure full_name column exists
    try {
      db.exec("ALTER TABLE contacts ADD COLUMN full_name TEXT;");
    } catch (_) {}

    return db;
  } catch (e) {
    console.error("SQLite init error:", e.message);
    return null;
  }
}

// Validation & Normalization Engine (Matching Langflow ValidateNormalize Component)
const PROGRAMMES = { 'gv': 'GV', 'gta': 'GTa', 'gte': 'GTe' };
const NAME_REGEX = /^[A-Za-z\s.'-]+$/;

function maskPhone(p) {
  const digits = String(p || '').replace(/\D/g, '');
  if (digits.length < 6) return '***';
  const prefix = String(p).trim().startsWith('+') ? '+' : '';
  return prefix + digits.slice(0, 4) + '****' + digits.slice(-3);
}

function normalizePhone(raw) {
  const text = String(raw || '').trim();
  if (!text) return { error: 'missing_phone' };
  if (/[a-zA-Z]/.test(text)) return { error: 'phone_has_letters' };
  let digits = text.replace(/\D/g, '');
  let international = text.startsWith('+');
  if (digits.startsWith('00')) {
    digits = digits.slice(2);
    international = true;
  }
  if (international && !digits.startsWith('62')) {
    if (digits.length >= 8 && digits.length <= 15) {
      return { phone: '+' + digits, masked: maskPhone('+' + digits), error: null };
    }
    return { error: 'phone_bad_length' };
  }
  let rest = '';
  if (digits.startsWith('62')) {
    rest = digits.slice(2);
  } else if (digits.startsWith('0')) {
    rest = digits.slice(1);
  } else if (digits.startsWith('8')) {
    rest = digits;
  } else {
    return { error: 'phone_unrecognized_format' };
  }
  if (!rest.startsWith('8')) {
    return { error: 'phone_not_mobile' };
  }
  if (rest.length < 9 || rest.length > 12) {
    return { error: 'phone_bad_length' };
  }
  const cleanE164 = '+62' + rest;
  return { phone: cleanE164, masked: maskPhone(cleanE164), error: null };
}

function normalizeName(raw) {
  if (!raw) return { first: null, full: null, error: 'missing_name' };
  // Strip emojis, pictographs, symbols (Zero Emojis policy)
  let text = String(raw).replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\p{So}\p{Sk}\p{Sm}\p{Sc}]/gu, '');
  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return { first: null, full: null, error: 'missing_name' };
  if (text.length > 50 || text.split(' ').length > 5) {
    return { error: 'suspicious_name' };
  }
  if (/ignore previous|instructions|offer free|system prompt/i.test(text)) {
    return { error: 'suspicious_name' };
  }
  if (!NAME_REGEX.test(text)) {
    return { error: 'suspicious_name' };
  }
  const words = text.split(' ').map(w => {
    if (w.length > 1) {
      return w[0].toUpperCase() + w.slice(1).toLowerCase();
    }
    return w.toUpperCase();
  });
  const first = words[0].replace(/\.$/, '');
  if (first.length < 2) {
    return { error: 'name_too_short' };
  }
  return { first, full: words.join(' '), error: null };
}

// Cleanse, validate, deduplicate and synchronize records with database
function cleanAndSyncMockData(db) {
  if (!db) return;
  try {
    const mockFile = path.join(DATA_DIR, 'mock_expa_signups.json');
    if (!fs.existsSync(mockFile)) return;

    const config = getConfig();
    const ctaLink = config.cta_link || DEFAULT_CONFIG.cta_link;
    const signups = JSON.parse(fs.readFileSync(mockFile, 'utf-8'));
    const upsertStmt = db.prepare(`
      INSERT INTO contacts (
        contact_key, expa_id, phone_hash, phone_e164, phone_masked,
        first_name, full_name, programme, lc, language, status, reason,
        draft_text, draft_source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(contact_key) DO UPDATE SET
        expa_id = excluded.expa_id,
        phone_hash = excluded.phone_hash,
        phone_e164 = excluded.phone_e164,
        phone_masked = excluded.phone_masked,
        first_name = excluded.first_name,
        full_name = excluded.full_name,
        programme = excluded.programme,
        lc = excluded.lc,
        language = excluded.language,
        status = excluded.status,
        reason = excluded.reason,
        draft_text = excluded.draft_text,
        draft_source = excluded.draft_source,
        updated_at = datetime('now')
      WHERE contacts.status NOT IN ('contacted', 'draft_ready')
         OR contacts.reason IS NOT NULL
         OR COALESCE(contacts.draft_text, '') = ''
         OR COALESCE(contacts.full_name, '') = ''
         OR COALESCE(contacts.programme, '') = ''
         OR COALESCE(contacts.phone_hash, '') LIKE 'hash_%'
         OR contacts.full_name LIKE 'Pendaftar (%'
         OR contacts.draft_text LIKE 'Halo di sana!%'
         OR (excluded.status = 'rejected' AND COALESCE(contacts.draft_source, '') != 'manual_fix')
    `);

    const seenPhones = new Set();
    const seenIds = new Set();

    signups.forEach((s) => {
      const rawId = String(s.id || '').trim();
      if (!rawId) {
        const dummyKey = `x:missing_id`;
        upsertStmt.run(
          dummyKey,
          '',
          'hash_missing',
          '',
          '***',
          'Tanpa Nama',
          'Data Pendaftar Tanpa ID',
          'GV',
          s.lc || 'Indonesia',
          'id',
          'rejected',
          'ID EXPA tidak ditemukan pada sistem',
          '',
          'validator'
        );
        return;
      }

      const contactKey = `e:${rawId}`;
      if (seenIds.has(rawId)) {
        return;
      }
      seenIds.add(rawId);

      const nameResult = normalizeName(s.full_name);
      const phoneResult = normalizePhone(s.phone);
      const rawProg = String(s.programme || '').trim().toLowerCase();
      const prog = PROGRAMMES[rawProg];

      let status = 'draft_ready';
      let reason = null;

      if (nameResult.error) {
        status = 'rejected';
        if (nameResult.error === 'missing_name') reason = 'Nama lengkap tidak diisi';
        else if (nameResult.error === 'suspicious_name') reason = 'Nama mencurigakan / format instruksi terdeteksi';
        else if (nameResult.error === 'name_too_short') reason = 'Nama terlalu pendek';
        else reason = `Format nama tidak valid (${nameResult.error})`;
      } else if (phoneResult.error) {
        status = 'rejected';
        if (phoneResult.error === 'missing_phone') reason = 'Nomor telepon tidak diisi';
        else if (phoneResult.error === 'phone_not_mobile') reason = 'Nomor bukan ponsel/WhatsApp (telepon kabel/landline)';
        else if (phoneResult.error === 'phone_has_letters') reason = 'Nomor telepon mengandung huruf atau karakter acak';
        else if (phoneResult.error === 'phone_bad_length') reason = 'Panjang digit nomor telepon tidak memenuhi standar';
        else reason = `Nomor telepon tidak valid (${phoneResult.error})`;
      } else if (!prog) {
        status = 'rejected';
        reason = `Program tidak dikenali: "${s.programme}" (harus GV, GTa, atau GTe)`;
      } else if (phoneResult.phone && seenPhones.has(phoneResult.phone)) {
        status = 'rejected';
        reason = 'Nomor telepon ganda (duplikat pendaftar lain)';
      }

      if (phoneResult.phone) {
        seenPhones.add(phoneResult.phone);
      }

      let cleanFullName = 'Pendaftar';
      if (!nameResult.error && nameResult.full) {
        cleanFullName = nameResult.full;
      } else if (nameResult.error === 'suspicious_name') {
        cleanFullName = 'Pendaftar (Instruksi Ditolak)';
      } else if (nameResult.error === 'missing_name') {
        cleanFullName = 'Pendaftar (Tanpa Nama)';
      } else if (s.full_name) {
        cleanFullName = String(s.full_name).slice(0, 30);
      }
      const cleanFirstName = nameResult.first || cleanFullName.split(' ')[0];
      const cleanPhoneE164 = phoneResult.phone || '';
      const cleanMasked = phoneResult.masked || maskPhone(s.phone);
      const cleanProg = prog || 'GV';
      const cleanLc = s.lc ? `AIESEC in ${s.lc}` : 'AIESEC in Indonesia';

      let draftText = '';
      if (status === 'draft_ready') {
        draftText = renderMessageFromTemplate(config.message_template, {
          full_name: cleanFullName,
          first_name: cleanFirstName,
          programme: cleanProg,
          lc: s.lc || 'Indonesia'
        }, ctaLink);
      }

      upsertStmt.run(
        contactKey,
        rawId,
        computePhoneHash(cleanPhoneE164),
        cleanPhoneE164,
        cleanMasked,
        cleanFirstName,
        cleanFullName,
        cleanProg,
        s.lc || 'Indonesia',
        s.language || 'id',
        status,
        reason,
        draftText,
        status === 'draft_ready' ? 'template' : 'validator'
      );
    });

    db.exec(`
      UPDATE contacts
      SET draft_source = 'template'
      WHERE status IN ('draft_ready', 'contacted') AND draft_source IN ('validator', 'ai_drafter');
    `);

    console.log(`Validated and synchronized ${signups.length} mock sign-ups.`);
  } catch (err) {
    console.error("Clean & Sync error:", err.message);
  }
}

const dbInstance = getDb();
if (dbInstance) cleanAndSyncMockData(dbInstance);

// HTTP Server
const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;

  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // --- API ROUTES ---

  // 1. GET /api/status - Remote Langflow and System Health
  if (req.method === 'GET' && pathname === '/api/status') {
    const config = getConfig();
    const hostUrl = resolveLangflowHost(config.langflow_host);
    let langflowOnline = false;
    let langflowMessage = "Offline";

    try {
      let testReq = await fetch(`${hostUrl}/health`, {
        signal: AbortSignal.timeout(2500)
      }).catch(() => null);

      if (!testReq || !testReq.ok) {
        testReq = await fetch(`${hostUrl}/api/v1/flows/`, {
          signal: AbortSignal.timeout(2500)
        }).catch(() => null);
      }

      if (testReq && (testReq.status === 200 || testReq.status === 401 || testReq.status === 403)) {
        langflowOnline = true;
        langflowMessage = `Terhubung (${config.langflow_host})`;
      } else {
        langflowMessage = "Tidak terjangkau di port " + config.langflow_host;
      }
    } catch (e) {
      langflowMessage = "Server lokal standby";
    }

    const db = getDb();
    let totalContacts = 0;
    if (db) {
      try {
        totalContacts = db.prepare("SELECT COUNT(*) AS c FROM contacts").get().c;
      } catch (_) {}
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      langflow: {
        online: langflowOnline,
        host: config.langflow_host,
        flow_id: config.flow_id,
        message: langflowMessage
      },
      db_connected: !!db,
      total_contacts: totalContacts
    }));
    return;
  }

  // 2. GET /api/stats - Dashboard Metrics
  if (req.method === 'GET' && pathname === '/api/stats') {
    const db = getDb();
    if (!db) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: "Database offline" }));
      return;
    }

    try {
      const stats = {
        total: db.prepare("SELECT COUNT(*) AS c FROM contacts").get().c,
        draft_ready: db.prepare("SELECT COUNT(*) AS c FROM contacts WHERE status = 'draft_ready'").get().c,
        contacted: db.prepare("SELECT COUNT(*) AS c FROM contacts WHERE status = 'contacted'").get().c,
        pending: db.prepare("SELECT COUNT(*) AS c FROM contacts WHERE status = 'pending'").get().c,
        rejected: db.prepare("SELECT COUNT(*) AS c FROM contacts WHERE status = 'rejected'").get().c,
        gv_count: db.prepare("SELECT COUNT(*) AS c FROM contacts WHERE programme = 'GV'").get().c,
        gta_count: db.prepare("SELECT COUNT(*) AS c FROM contacts WHERE programme = 'GTa'").get().c,
        gte_count: db.prepare("SELECT COUNT(*) AS c FROM contacts WHERE programme = 'GTe'").get().c,
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(stats));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // 3. GET /api/contacts - Query Contacts List
  if (req.method === 'GET' && pathname === '/api/contacts') {
    const db = getDb();
    if (!db) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: "Database unavailable" }));
      return;
    }

    const filterStatus = parsedUrl.searchParams.get('status') || 'all';
    const filterProg = parsedUrl.searchParams.get('programme') || 'all';
    const search = (parsedUrl.searchParams.get('q') || '').trim();

    try {
      let query = `
        SELECT 
          contact_key, expa_id, phone_e164, phone_masked,
          first_name, COALESCE(full_name, first_name) AS full_name,
          programme, lc, language, status, reason, draft_text, draft_source,
          created_at, updated_at
        FROM contacts
        WHERE 1=1
      `;
      const params = [];

      if (filterStatus !== 'all') {
        query += " AND status = ?";
        params.push(filterStatus);
      }

      if (filterProg !== 'all') {
        query += " AND programme = ?";
        params.push(filterProg);
      }

      if (search) {
        query += " AND (full_name LIKE ? OR first_name LIKE ? OR expa_id LIKE ? OR phone_e164 LIKE ? OR lc LIKE ?)";
        const likeTerm = `%${search}%`;
        params.push(likeTerm, likeTerm, likeTerm, likeTerm, likeTerm);
      }

      const limit = Math.min(Math.max(parseInt(parsedUrl.searchParams.get('limit') || '100', 10) || 100, 1), 500);
      const offset = Math.max(parseInt(parsedUrl.searchParams.get('offset') || '0', 10) || 0, 0);
      query += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
      params.push(limit, offset);

      const rows = db.prepare(query).all(...params);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rows));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // 4. PUT /api/contacts/:id - Update Draft Text or Status
  if (req.method === 'PUT' && pathname.startsWith('/api/contacts/')) {
    const contactKey = decodeURIComponent(pathname.replace('/api/contacts/', ''));
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const db = getDb();
        if (!db) throw new Error("Database not connected");

        // If editing lead contact details (e.g. from Perbaiki Data modal)
        if (payload.full_name !== undefined || payload.phone !== undefined || payload.programme !== undefined || payload.lc !== undefined) {
          const existing = db.prepare("SELECT * FROM contacts WHERE contact_key = ?").get(contactKey);
          if (!existing) throw new Error("Kontak tidak ditemukan");

          const newName = payload.full_name !== undefined ? payload.full_name : existing.full_name;
          const newPhone = payload.phone !== undefined ? payload.phone : existing.phone_e164;
          const newProg = payload.programme !== undefined ? payload.programme : existing.programme;
          const newLc = payload.lc !== undefined ? payload.lc : existing.lc;

          const nameResult = normalizeName(newName);
          const phoneResult = normalizePhone(newPhone);
          const rawProg = String(newProg || '').trim().toLowerCase();
          const prog = PROGRAMMES[rawProg];

          let status = 'draft_ready';
          let reason = null;

          if (nameResult.error) {
            status = 'rejected';
            if (nameResult.error === 'missing_name') reason = 'Nama lengkap tidak diisi';
            else if (nameResult.error === 'suspicious_name') reason = 'Nama mencurigakan / format instruksi terdeteksi';
            else if (nameResult.error === 'name_too_short') reason = 'Nama terlalu pendek';
            else reason = `Format nama tidak valid (${nameResult.error})`;
          } else if (phoneResult.error) {
            status = 'rejected';
            if (phoneResult.error === 'missing_phone') reason = 'Nomor telepon tidak diisi';
            else if (phoneResult.error === 'phone_not_mobile') reason = 'Nomor bukan ponsel/WhatsApp (telepon kabel/landline)';
            else if (phoneResult.error === 'phone_has_letters') reason = 'Nomor telepon mengandung huruf atau karakter acak';
            else if (phoneResult.error === 'phone_bad_length') reason = 'Panjang digit nomor telepon tidak memenuhi standar';
            else reason = `Nomor telepon tidak valid (${phoneResult.error})`;
          } else if (!prog) {
            status = 'rejected';
            reason = `Program tidak dikenali: "${newProg}" (harus GV, GTa, atau GTe)`;
          } else if (phoneResult.phone) {
            const dup = db.prepare("SELECT contact_key FROM contacts WHERE phone_e164 = ? AND contact_key != ? AND status != 'rejected' LIMIT 1").get(phoneResult.phone, contactKey);
            if (dup) {
              status = 'rejected';
              reason = 'Nomor telepon ganda (duplikat pendaftar lain)';
            }
          }

          let cleanFullName = 'Pendaftar';
          if (!nameResult.error && nameResult.full) {
            cleanFullName = nameResult.full;
          } else if (nameResult.error === 'suspicious_name') {
            cleanFullName = 'Pendaftar (Instruksi Ditolak)';
          } else if (nameResult.error === 'missing_name') {
            cleanFullName = 'Pendaftar (Tanpa Nama)';
          } else if (newName) {
            cleanFullName = String(newName).slice(0, 30);
          }

          const cleanFirstName = nameResult.first || cleanFullName.split(' ')[0];
          const cleanPhoneE164 = phoneResult.phone || '';
          const cleanMasked = phoneResult.masked || maskPhone(newPhone);
          const cleanProg = prog || 'GV';

          let draftText = existing.draft_text;
          const cfg = getConfig();
          const ctaLink = cfg.cta_link || DEFAULT_CONFIG.cta_link;
          if (status === 'draft_ready' && (!draftText || existing.status === 'rejected')) {
            draftText = renderMessageFromTemplate(cfg.message_template, {
              full_name: cleanFullName,
              first_name: cleanFirstName,
              programme: cleanProg,
              lc: newLc || 'Indonesia'
            }, ctaLink);
          }

          const draftSource = status === 'draft_ready' ? 'manual_fix' : 'validator';

          db.prepare(`
            UPDATE contacts SET
              full_name = ?,
              first_name = ?,
              phone_hash = ?,
              phone_e164 = ?,
              phone_masked = ?,
              programme = ?,
              lc = ?,
              status = ?,
              reason = ?,
              draft_text = ?,
              draft_source = ?,
              updated_at = datetime('now')
            WHERE contact_key = ?
          `).run(cleanFullName, cleanFirstName, computePhoneHash(cleanPhoneE164), cleanPhoneE164, cleanMasked, cleanProg, newLc, status, reason, draftText, draftSource, contactKey);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            status,
            reason,
            message: status === 'draft_ready' ? 'Data berhasil diperbaiki dan dipindahkan ke antrean Siap Kirim!' : 'Data diperbarui: ' + reason
          }));
          return;
        }

        const updates = [];
        const params = [];

        if (payload.draft_text !== undefined) {
          updates.push("draft_text = ?");
          params.push(payload.draft_text);
        }

        if (payload.status !== undefined) {
          updates.push("status = ?");
          params.push(payload.status);
        }

        if (updates.length > 0) {
          updates.push("updated_at = datetime('now')");
          params.push(contactKey);
          db.prepare(`UPDATE contacts SET ${updates.join(', ')} WHERE contact_key = ?`).run(...params);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: "Kontak diperbarui" }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // 5. POST /api/trigger - Remote Run Flow via Langflow or Local Pipeline
  if (req.method === 'POST' && pathname === '/api/trigger') {
    const config = getConfig();
    const hostUrl = resolveLangflowHost(config.langflow_host);
    let result = { mode: "simulation", status: "completed", message: "Flow berhasil diproses" };

    try {
      const { flowId, headers: authHeaders, nodeMap } = await resolveLangflowFlowId(hostUrl, config.flow_id, config.langflow_api_key);
      const mockFile = path.join(DATA_DIR, 'mock_expa_signups.json');
      const exportDir = path.join(DATA_DIR, 'exports');

      const webhookPayload = {
        metadata: { trigger_slug: "GOOGLECALENDAR_EVENT_STARTING_SOON_TRIGGER" },
        data: {
          id: `trigger_${Date.now()}`,
          summary: "EXPA-WELCOME-RUN Manual Remote Run",
          start: { dateTime: new Date().toISOString() }
        }
      };

      const runBody = {
        input_value: JSON.stringify(webhookPayload),
        input_type: "text",
        output_type: "chat",
        tweaks: {
          [nodeMap.Webhook]: { payload_json: JSON.stringify(webhookPayload) },
          [nodeMap.ExpaRunGate]: { db_path: DB_PATH, min_minutes_between_runs: 0, allow_manual_run: true },
          [nodeMap.ExpaSignupsMock]: { file_path: mockFile, db_path: DB_PATH },
          [nodeMap.ValidateNormalize]: { db_path: DB_PATH },
          [nodeMap.DedupeAndLog]: { db_path: DB_PATH, allow_dev_salt: true },
          [nodeMap.DraftMessage]: {
            db_path: DB_PATH,
            cta_link: config.cta_link || DEFAULT_CONFIG.cta_link,
            message_template: config.message_template || DEFAULT_CONFIG.message_template,
            use_llm: false
          },
          [nodeMap.FinishAndAlert]: { db_path: DB_PATH, dry_run: true },
          [nodeMap.ExportSpreadsheetTool]: { db_path: DB_PATH, output_dir: exportDir, upload_to_gdrive: false, file_format: "csv" }
        }
      };

      // 1. Run via Langflow /api/v1/run/{flowId}
      let resp = await fetch(`${hostUrl}/api/v1/run/${flowId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify(runBody),
        signal: AbortSignal.timeout(20000)
      }).catch(() => null);

      // 2. Fallback to /api/v1/webhook/{flowId}
      if (!resp || !resp.ok) {
        resp = await fetch(`${hostUrl}/api/v1/webhook/${flowId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders },
          body: JSON.stringify(webhookPayload),
          signal: AbortSignal.timeout(6000)
        }).catch(() => null);
      }

      const db = getDb();
      if (db) {
        cleanAndSyncMockData(db);
      }

      if (resp && resp.ok) {
        const runJson = await resp.json().catch(() => null);
        const langflowReport = extractLangflowText(runJson);
        result = {
          mode: "langflow_live",
          flow_id: flowId,
          status: "success",
          langflow_output: langflowReport,
          message: `Flow berhasil dieksekusi langsung di Langflow (${flowId.slice(0, 8)}...)!`
        };
      } else {
        result = {
          mode: "local_dispatch",
          status: "success",
          message: "Langflow sedang tidak terjangkau — dieksekusi via fallback lokal."
        };
      }
    } catch (e) {
      result = { mode: "local", status: "ok", message: "Pipeline berhasil diperbarui" };
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // 6. POST /api/export - Export to Spreadsheet and Google Drive (via Langflow first, fallback local)
  if (req.method === 'POST' && pathname === '/api/export') {
    let reqBody = '';
    req.on('data', chunk => { reqBody += chunk; });
    req.on('end', async () => {
      const config = getConfig();
      const hostUrl = resolveLangflowHost(config.langflow_host);
      const db = getDb();
      if (!db) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "Database tidak tersedia" }));
        return;
      }

      let parsedOpts = {};
      try {
        if (reqBody) parsedOpts = JSON.parse(reqBody);
      } catch (_) {}
      const wantGdrive = parsedOpts.upload_to_gdrive !== undefined
        ? !!parsedOpts.upload_to_gdrive
        : !!(config.gdrive_webhook_url && config.gdrive_webhook_url.startsWith('http'));

      const exportDir = path.join(DATA_DIR, 'exports');
      if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });

      try {
        cleanAndSyncMockData(db);

        // --- STEP 1: Execute ExportSpreadsheetTool via Langflow ---
        let langflowExportedFile = null;
        let langflowOutputText = '';
        let langflowSuccess = false;

        try {
          const { flowId, headers: authHeaders, nodeMap } = await resolveLangflowFlowId(hostUrl, config.flow_id, config.langflow_api_key);
          const mockFile = path.join(DATA_DIR, 'mock_expa_signups.json');
          const secret = config.gdrive_webhook_secret || process.env.GDRIVE_WEBHOOK_SECRET || DEFAULT_CONFIG.gdrive_webhook_secret;

          const exportRunBody = {
            input_value: "",
            input_type: "text",
            output_type: "chat",
            tweaks: {
              [nodeMap.Webhook]: { payload_json: "" },
              [nodeMap.ExpaRunGate]: { db_path: DB_PATH, min_minutes_between_runs: 0, allow_manual_run: true },
              [nodeMap.ExpaSignupsMock]: { file_path: mockFile, db_path: DB_PATH },
              [nodeMap.ValidateNormalize]: { db_path: DB_PATH },
              [nodeMap.DedupeAndLog]: { db_path: DB_PATH, allow_dev_salt: true },
              [nodeMap.DraftMessage]: {
                db_path: DB_PATH,
                cta_link: config.cta_link || DEFAULT_CONFIG.cta_link,
                message_template: config.message_template || DEFAULT_CONFIG.message_template,
                use_llm: false
              },
              [nodeMap.FinishAndAlert]: { db_path: DB_PATH, dry_run: true },
              [nodeMap.ExportSpreadsheetTool]: {
                db_path: DB_PATH,
                output_dir: exportDir,
                file_format: "csv",
                filter_status: "draft_ready",
                upload_to_gdrive: wantGdrive,
                gdrive_method: "Apps Script Webhook (Direct & Stable)",
                gdrive_webhook_url: config.gdrive_webhook_url || "",
                gdrive_webhook_secret: secret
              }
            }
          };

          const lfResp = await fetch(`${hostUrl}/api/v1/run/${flowId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders },
            body: JSON.stringify(exportRunBody),
            signal: AbortSignal.timeout(20000)
          }).catch(() => null);

          if (lfResp && lfResp.ok) {
            const lfJson = await lfResp.json().catch(() => null);
            langflowOutputText = extractLangflowText(lfJson);
            const fileMatch = langflowOutputText.match(/Local File:\s*([^\r\n]+)/i);
            if (fileMatch && fileMatch[1]) {
              const candidatePath = fileMatch[1].trim();
              if (fs.existsSync(candidatePath)) {
                langflowExportedFile = candidatePath;
                langflowSuccess = true;
              }
            }
            if (!langflowExportedFile) {
              // Check newest CSV in exportDir created within the last 15 seconds
              const files = fs.readdirSync(exportDir)
                .filter(f => f.endsWith('.csv'))
                .map(f => ({ name: f, full: path.join(exportDir, f), mtime: fs.statSync(path.join(exportDir, f)).mtimeMs }))
                .sort((a, b) => b.mtime - a.mtime);
              if (files.length > 0 && (Date.now() - files[0].mtime) < 15000) {
                langflowExportedFile = files[0].full;
                langflowSuccess = true;
              }
            }
          }
        } catch (_) {}

        const rows = db.prepare(`
          SELECT 
            contact_key, expa_id, COALESCE(full_name, first_name) AS full_name,
            phone_e164, phone_masked, programme, lc, status, draft_text, updated_at
          FROM contacts
          WHERE status IN ('draft_ready', 'contacted')
            AND COALESCE(full_name, first_name, '') != ''
            AND COALESCE(programme, '') != ''
            AND COALESCE(phone_e164, '') != ''
          ORDER BY created_at DESC
        `).all();

        let fileName = '';
        let filePath = '';
        let gdriveResult = { uploaded: false, message: "Google Drive Webhook URL belum diisi di Pengaturan" };

        if (langflowSuccess && langflowExportedFile) {
          filePath = langflowExportedFile;
          fileName = path.basename(filePath);
          if (langflowOutputText.includes('Tersimpan di Google Drive') || langflowOutputText.includes('Uploaded to Google Drive')) {
            const urlMatch = langflowOutputText.match(/https?:\/\/[^\s\r\n)]+/g);
            const driveUrl = urlMatch ? urlMatch[urlMatch.length - 1] : '';
            gdriveResult = {
              uploaded: true,
              file_url: driveUrl,
              message: "Berhasil diunggah ke Google Drive via Langflow"
            };
          } else if (wantGdrive) {
            const noticeMatch = langflowOutputText.match(/Google Drive notice:\s*([^\r\n]+)/i);
            gdriveResult = {
              uploaded: false,
              message: noticeMatch ? noticeMatch[1].trim() : "Google Drive Webhook URL belum diisi di Pengaturan"
            };
          }
        } else {
          // --- STEP 2: Fallback Local Export only if Langflow is offline ---
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          fileName = `expa_drafts_${timestamp}.csv`;
          filePath = path.join(exportDir, fileName);

          const clean = v => {
            const s = String(v || '').replace(/"/g, '""');
            if (s.startsWith('=') || s.startsWith('+') || s.startsWith('-') || s.startsWith('@')) {
              return `"'${s}"`;
            }
            return `"${s}"`;
          };

          const headers = ["No", "EXPA ID", "Nama Lengkap", "Nomor WhatsApp", "Program", "Komite Lokal (LC)", "Status", "Pesan Draf", "Link WhatsApp", "Waktu"];
          const lines = [headers.join(',')];

          rows.forEach((r, idx) => {
            const phone = (r.phone_e164 || '').replace(/[^0-9]/g, '');
            const waLink = phone ? `https://wa.me/${phone}?text=${encodeURIComponent(r.draft_text || '')}` : '';
            lines.push([
              idx + 1,
              clean(r.expa_id),
              clean(r.full_name),
              clean(r.phone_e164),
              clean(r.programme),
              clean(r.lc),
              clean(r.status),
              clean(r.draft_text),
              clean(waLink),
              clean(r.updated_at)
            ].join(','));
          });

          fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');

          if (wantGdrive && config.gdrive_webhook_url && config.gdrive_webhook_url.startsWith('http')) {
            try {
              const fileContentBase64 = fs.readFileSync(filePath).toString('base64');
              const secret = config.gdrive_webhook_secret || process.env.GDRIVE_WEBHOOK_SECRET || DEFAULT_CONFIG.gdrive_webhook_secret;
              const gdriveResp = await fetch(config.gdrive_webhook_url, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'X-Webhook-Token': secret
                },
                body: JSON.stringify({
                  auth_token: secret,
                  file_name: fileName,
                  mime_type: 'text/csv',
                  base64_data: fileContentBase64
                })
              });
              const gdriveData = await gdriveResp.json().catch(() => null);
              if (gdriveData && gdriveData.status === 'success') {
                gdriveResult = {
                  uploaded: true,
                  file_url: gdriveData.file_url || gdriveData.download_url,
                  message: "Berhasil diunggah ke Google Drive (Fallback Lokal)"
                };
              } else {
                gdriveResult = {
                  uploaded: false,
                  message: gdriveData?.message || `HTTP ${gdriveResp.status}`
                };
              }
            } catch (gErr) {
              gdriveResult = { uploaded: false, message: gErr.message };
            }
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          mode: langflowSuccess ? 'langflow_live' : 'local_fallback',
          file_name: fileName,
          local_path: filePath,
          total_rows: rows.length,
          download_url: `/api/download/${fileName}`,
          gdrive: gdriveResult
        }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // 7. GET /api/download/:filename - File Download Endpoint
  if (req.method === 'GET' && pathname.startsWith('/api/download/')) {
    const filename = path.basename(pathname.replace('/api/download/', ''));
    const filePath = path.join(DATA_DIR, 'exports', filename);

    if (fs.existsSync(filePath)) {
      res.writeHead(200, {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="${filename}"`
      });
      fs.createReadStream(filePath).pipe(res);
      return;
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('File not found');
      return;
    }
  }

  // 8. GET /api/config and POST /api/config - App Settings
  if (pathname === '/api/config') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getConfig()));
      return;
      } else if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const newCfg = JSON.parse(body);
          const applyToAll = !!newCfg.apply_template_to_all;
          delete newCfg.apply_template_to_all;
          const mergedCfg = { ...getConfig(), ...newCfg };
          saveConfig(mergedCfg);

          let updatedDrafts = 0;
          if (applyToAll && mergedCfg.message_template) {
            const db = getDb();
            if (db) {
              const readyRows = db.prepare("SELECT contact_key, first_name, full_name, programme, lc FROM contacts WHERE status = 'draft_ready'").all();
              const upd = db.prepare("UPDATE contacts SET draft_text = ?, draft_source = 'template', updated_at = datetime('now') WHERE contact_key = ?");
              for (const r of readyRows) {
                const rendered = renderMessageFromTemplate(mergedCfg.message_template, r, mergedCfg.cta_link);
                upd.run(rendered, r.contact_key);
                updatedDrafts++;
              }
            }
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, config: getConfig(), updated_drafts: updatedDrafts }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
  }

  // --- STATIC FILE SERVING ---
  let reqPath = pathname === '/' ? '/index.html' : pathname;
  let filePath = path.join(PUBLIC_DIR, reqPath);

  // Security check: prevent directory traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const mimeMap = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml'
  };

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // Fallback to index.html for SPA
      const indexPath = path.join(PUBLIC_DIR, 'index.html');
      if (fs.existsSync(indexPath)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        fs.createReadStream(indexPath).pipe(res);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      }
      return;
    }

    res.writeHead(200, { 'Content-Type': mimeMap[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
});

let retriedListen = false;
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE' && !retriedListen) {
    retriedListen = true;
    try {
      const { execSync } = require('child_process');
      const out = execSync(`netstat -ano`, { encoding: 'utf-8' });
      const lines = out.split(/\r?\n/);
      for (const line of lines) {
        if (line.includes(`:${PORT}`) && line.includes('LISTENING')) {
          const parts = line.trim().split(/\s+/);
          const pid = parseInt(parts[parts.length - 1], 10);
          if (pid && pid !== process.pid) {
            try { execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' }); } catch (_) {}
          }
        }
      }
    } catch (_) {}
    setTimeout(() => {
      server.listen(PORT, '0.0.0.0');
    }, 500);
    return;
  }
  console.error('Server error:', err);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n======================================================`);
  console.log(`EXPA Welcome Drafter - Web Controller`);
  console.log(`Alamat Dashboard: http://localhost:${PORT}`);
  console.log(`======================================================\n`);
});
