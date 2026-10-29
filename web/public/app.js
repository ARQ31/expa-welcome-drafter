/**
 * AIESEC EXPA Welcome Drafter - Frontend Client Logic
 * Remote Controller for Langflow, Lead Review, and WhatsApp Dispatcher
 */

document.addEventListener('DOMContentLoaded', () => {
  // State
  let currentStatus = 'draft_ready';
  let currentProgram = 'all';
  let currentSearch = '';
  let viewMode = 'grid'; // 'grid' | 'list'
  let contactsData = [];
  let maskedStates = {};

  // DOM Elements
  const statusDot = document.getElementById('langflow-status-dot');
  const statusLabel = document.getElementById('langflow-status-label');
  const leadsContainer = document.getElementById('leads-container');
  const renderedCount = document.getElementById('rendered-count');

  // Stats Elements
  const statTotal = document.getElementById('stat-total');
  const statReady = document.getElementById('stat-ready');
  const statContacted = document.getElementById('stat-contacted');
  const statRejected = document.getElementById('stat-rejected');
  const statProgBreakdown = document.getElementById('stat-prog-breakdown');
  const metricCards = document.querySelectorAll('.metric-card[data-status-card]');

  // Tab Badge Elements
  const tabCntReady = document.getElementById('tab-cnt-ready');
  const tabCntRejected = document.getElementById('tab-cnt-rejected');
  const tabCntContacted = document.getElementById('tab-cnt-contacted');
  const tabCntAll = document.getElementById('tab-cnt-all');

  // Action Buttons
  const btnRun = document.getElementById('btn-run-pipeline');
  const btnRunLabel = document.getElementById('btn-run-label');
  const btnExportCsv = document.getElementById('btn-export-csv');
  const btnSyncGdrive = document.getElementById('btn-sync-gdrive');
  const gdriveBtnLabel = document.getElementById('gdrive-btn-label');
  const btnRefreshList = document.getElementById('btn-refresh-list');

  // View Toggle Buttons
  const btnViewGrid = document.getElementById('btn-view-grid');
  const btnViewList = document.getElementById('btn-view-list');

  // Search & Filter
  const searchInput = document.getElementById('search-input');
  const btnClearSearch = document.getElementById('btn-clear-search');
  const programSelect = document.getElementById('program-select');
  const segButtons = document.querySelectorAll('.seg-btn');

  // Settings Modal Elements
  const modal = document.getElementById('settings-modal');
  const btnOpenSettings = document.getElementById('btn-open-settings');
  const btnCloseSettings = document.getElementById('btn-close-settings');
  const btnCancelSettings = document.getElementById('btn-cancel-settings');
  const settingsForm = document.getElementById('settings-form');
  const cfgLangflowHost = document.getElementById('cfg-langflow-host');
  const cfgFlowId = document.getElementById('cfg-flow-id');
  const cfgLangflowApiKey = document.getElementById('cfg-langflow-apikey');
  const cfgGdriveUrl = document.getElementById('cfg-gdrive-url');
  const cfgGdriveSecret = document.getElementById('cfg-gdrive-secret');
  const cfgCtaLink = document.getElementById('cfg-cta-link');

  // Template Modal Elements
  const DEFAULT_MESSAGE_TEMPLATE = 'Halo {full_name}! Terima kasih sudah mendaftar {programme} di AIESEC in {lc}. Kami senang menyambutmu untuk langkah kepemimpinan berikutnya. Informasi lengkap dan langkah selanjutnya bisa kamu akses di {cta_link}. Ada pertanyaan yang ingin kamu tanyakan ke tim kami?';
  const templateModal = document.getElementById('template-modal');
  const btnOpenTemplate = document.getElementById('btn-open-template');
  const btnCloseTemplate = document.getElementById('btn-close-template');
  const btnCancelTemplate = document.getElementById('btn-cancel-template');
  const btnResetTemplate = document.getElementById('btn-reset-template');
  const templateForm = document.getElementById('template-form');
  const cfgMessageTemplate = document.getElementById('cfg-message-template');
  const cfgApplyTemplateAll = document.getElementById('cfg-apply-template-all');
  const templatePreviewText = document.getElementById('template-preview-text');
  const templatePreviewWords = document.getElementById('template-preview-words');
  const varChips = document.querySelectorAll('.var-chip');
  let cachedCtaLink = 'https://aiesec.or.id/welcome';

  // Edit Lead Modal Elements
  const editModal = document.getElementById('edit-lead-modal');
  const btnCloseEditLead = document.getElementById('btn-close-edit-lead');
  const btnCancelEditLead = document.getElementById('btn-cancel-edit-lead');
  const editLeadForm = document.getElementById('edit-lead-form');
  const editContactKey = document.getElementById('edit-contact-key');
  const editFullName = document.getElementById('edit-full-name');
  const editPhone = document.getElementById('edit-phone');
  const editProgramme = document.getElementById('edit-programme');
  const editLc = document.getElementById('edit-lc');
  const editLeadTitle = document.getElementById('edit-lead-title');

  // --- 1. Notification Toast Helper ---
  function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast-item ${type}`;

    let svgIcon = '';
    if (type === 'success') {
      svgIcon = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#10B981" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
    } else if (type === 'error') {
      svgIcon = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#EF4444" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`;
    } else {
      svgIcon = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#037EF3" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`;
    }

    toast.innerHTML = `${svgIcon}<span>${escapeHtml(message)}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
      toast.remove();
    }, 3200);
  }

  // --- 2. System Status & Health Check ---
  async function checkStatus() {
    try {
      const res = await fetch('/api/status');
      const data = await res.json();

      if (data.langflow && data.langflow.online) {
        statusDot.className = 'status-indicator-dot online';
        statusLabel.textContent = `Langflow Aktif (${data.langflow.host})`;
      } else {
        statusDot.className = 'status-indicator-dot offline';
        statusLabel.textContent = 'Mode Lokal Siap (Langflow Standby)';
      }
    } catch (e) {
      statusDot.className = 'status-indicator-dot offline';
      statusLabel.textContent = 'Menghubungkan ke Server...';
    }
  }

  // --- 3. Stats Fetching ---
  async function fetchStats() {
    try {
      const res = await fetch('/api/stats');
      const stats = await res.json();

      statTotal.textContent = stats.total || 0;
      statReady.textContent = stats.draft_ready || 0;
      statContacted.textContent = stats.contacted || 0;
      if (statRejected) statRejected.textContent = stats.rejected || 0;

      if (statProgBreakdown) {
        statProgBreakdown.textContent = `GV ${stats.gv_count || 0} · GTa ${stats.gta_count || 0} · GTe ${stats.gte_count || 0}`;
      }

      if (tabCntReady) tabCntReady.textContent = stats.draft_ready || 0;
      if (tabCntRejected) tabCntRejected.textContent = stats.rejected || 0;
      if (tabCntContacted) tabCntContacted.textContent = stats.contacted || 0;
      if (tabCntAll) tabCntAll.textContent = stats.total || 0;
    } catch (e) {
      console.error('Failed to load stats:', e);
    }
  }

  // Sync active tab and active metric card UI
  function syncStatusFilterUI(status) {
    currentStatus = status;
    segButtons.forEach(b => {
      const isMatch = b.getAttribute('data-status') === status;
      b.classList.toggle('active', isMatch);
      b.setAttribute('aria-selected', isMatch ? 'true' : 'false');
    });
    metricCards.forEach(c => {
      c.classList.toggle('active', c.getAttribute('data-status-card') === status);
    });
  }

  // --- 4. Contacts Query & Rendering ---
  async function fetchContacts() {
    leadsContainer.innerHTML = `
      <div class="empty-state-card">
        <p class="empty-state-text">Memuat data pendaftar...</p>
      </div>
    `;

    try {
      const params = new URLSearchParams({
        status: currentStatus,
        programme: currentProgram,
        q: currentSearch
      });

      const res = await fetch(`/api/contacts?${params.toString()}`);
      contactsData = await res.json();
      renderContacts(contactsData);
    } catch (e) {
      leadsContainer.innerHTML = `
        <div class="empty-state-card">
          <p class="empty-state-text">Gagal memuat antrean data pendaftar.</p>
        </div>
      `;
    }
  }

  function countWords(text) {
    const clean = String(text || '').trim();
    if (!clean) return 0;
    return clean.split(/\s+/).length;
  }

  function renderContacts(items) {
    renderedCount.textContent = `${items.length} pendaftar`;

    if (!items || items.length === 0) {
      leadsContainer.innerHTML = `
        <div class="empty-state-card">
          <p class="empty-state-text">Tidak ada pendaftar yang cocok dengan filter saat ini.</p>
        </div>
      `;
      return;
    }

    leadsContainer.innerHTML = items.map(c => {
      const prog = (c.programme || 'GV').toUpperCase();
      let progClass = 'gv';
      let progLabel = 'GV';
      if (prog === 'GTA' || prog === 'GT') {
        progClass = 'gta';
        progLabel = 'GTa';
      } else if (prog === 'GTE') {
        progClass = 'gte';
        progLabel = 'GTe';
      }

      const isContacted = c.status === 'contacted';
      const isPending = c.status === 'pending';
      const isRejected = c.status === 'rejected';

      let statusBadge = '';
      if (currentStatus === 'all') {
        if (isContacted) {
          statusBadge = `<span class="badge-status contacted">Sudah Dihubungi</span>`;
        } else if (isPending) {
          statusBadge = `<span class="badge-status pending">Antrean</span>`;
        } else if (isRejected) {
          statusBadge = `<span class="badge-status rejected">Perlu Perbaikan</span>`;
        } else {
          statusBadge = `<span class="badge-status ready">Siap Kirim</span>`;
        }
      }

      const rawPhone = String(c.phone_e164 || '').replace(/[^0-9]/g, '');
      const hasPhone = rawPhone.length > 0;
      const maskedPhone = c.phone_masked || (hasPhone ? rawPhone.slice(0, 4) + '****' + rawPhone.slice(-3) : '***');
      const isRevealed = !!maskedStates[c.contact_key];
      const displayPhone = hasPhone ? (isRevealed ? (c.phone_e164 || rawPhone) : maskedPhone) : 'Nomor belum valid';

      const fullName = c.full_name || c.first_name || 'Pendaftar EXPA';
      const rawLc = String(c.lc || 'Indonesia').replace(/^AIESEC in\s+/i, '');
      const lcName = `LC ${rawLc}`;
      const draftText = c.draft_text || '';
      const words = countWords(draftText);
      const waLink = rawPhone && !isRejected ? `https://wa.me/${rawPhone}?text=${encodeURIComponent(draftText)}` : '#';

      const contentSectionHtml = isRejected ? `
        <div class="rejected-lead-resolution">
          <div class="lead-rejection-banner">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="12" y1="8" x2="12" y2="12"></line>
              <line x1="12" y1="16" x2="12.01" y2="16"></line>
            </svg>
            <span>${escapeHtml(c.reason || 'Data tidak memenuhi kriteria validasi EXPA')}</span>
          </div>
          <p class="rejection-note">Klik tombol di bawah untuk mengoreksi nama atau nomor telepon agar draf WhatsApp otomatis dibuat.</p>
        </div>
      ` : `
        <div class="lead-draft-box">
          <div class="draft-box-header">
            <div class="draft-header-left">
              <span class="draft-label">Draf Pesan</span>
              <span class="draft-source-tag">${escapeHtml(c.draft_source === 'ai_drafter' ? 'TEMPLATE' : (c.draft_source || 'TEMPLATE'))}</span>
            </div>
            <div class="draft-header-right">
              <span class="draft-word-count" id="wc-${escapeHtml(c.contact_key)}">${words} kata</span>
              <button type="button" class="btn-ghost-xs btn-copy-draft" data-key="${escapeHtml(c.contact_key)}" title="Salin teks pesan">
                Salin Pesan
              </button>
            </div>
          </div>
          <textarea 
            class="draft-textarea" 
            id="draft-${escapeHtml(c.contact_key)}" 
            data-key="${escapeHtml(c.contact_key)}"
            placeholder="Tulis pesan..."
          >${escapeHtml(draftText)}</textarea>
        </div>
      `;

      const actionsHtml = isRejected ? `
        <div class="lead-card-actions">
          <button 
            type="button"
            class="btn btn-secondary btn-edit-lead" 
            data-key="${escapeHtml(c.contact_key)}"
            data-name="${escapeHtml(c.full_name || '')}"
            data-phone="${escapeHtml(c.phone_e164 || '')}"
            data-prog="${escapeHtml(c.programme || 'GV')}"
            data-lc="${escapeHtml(rawLc)}"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
            </svg>
            <span>Perbaiki Data Pendaftar</span>
          </button>
        </div>
      ` : `
        <div class="lead-card-actions">
          <a 
            href="${waLink}" 
            target="_blank" 
            rel="noopener noreferrer" 
            class="btn btn-primary btn-dispatch-wa" 
            data-key="${escapeHtml(c.contact_key)}"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path>
            </svg>
            <span>Buka WhatsApp</span>
          </a>

          <button 
            type="button"
            class="btn btn-secondary btn-mark-contacted" 
            data-key="${escapeHtml(c.contact_key)}" 
            data-status="${isContacted ? 'draft_ready' : 'contacted'}"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
            <span>${isContacted ? 'Batal Tandai' : 'Tandai Dihubungi'}</span>
          </button>
        </div>
      `;

      return `
        <article class="lead-card" data-key="${escapeHtml(c.contact_key)}">
          <div class="lead-card-top">
            <div class="lead-info-col">
              <span class="lead-name">${escapeHtml(fullName)}</span>
              <div class="lead-meta-row">
                <span class="meta-id">#${escapeHtml(c.expa_id || '-')}</span>
                <span class="meta-sep">&middot;</span>
                <span class="meta-lc">${escapeHtml(lcName)}</span>
              </div>
            </div>
            <div class="lead-badges-col">
              <span class="badge-program ${progClass}">${escapeHtml(progLabel)}</span>
              ${statusBadge}
            </div>
          </div>

          <div class="lead-phone-row">
            <div class="phone-left">
              <svg class="phone-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path>
              </svg>
              <span class="phone-digits ${!hasPhone ? 'text-muted' : ''}" id="phone-${escapeHtml(c.contact_key)}">${escapeHtml(displayPhone)}</span>
            </div>
            ${hasPhone ? `
              <div class="phone-actions">
                <button type="button" class="btn-ghost-xs phone-toggle-btn" data-key="${escapeHtml(c.contact_key)}">
                  ${isRevealed ? 'Sembunyikan' : 'Tampilkan'}
                </button>
                <button type="button" class="btn-ghost-xs btn-copy-phone" data-key="${escapeHtml(c.contact_key)}" title="Salin nomor telepon">
                  Salin
                </button>
              </div>
            ` : ''}
          </div>

          ${contentSectionHtml}

          ${actionsHtml}
        </article>
      `;
    }).join('');

    attachCardListeners();
  }

  function attachCardListeners() {
    // Phone toggle mask/unmask
    document.querySelectorAll('.phone-toggle-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const key = e.currentTarget.getAttribute('data-key');
        maskedStates[key] = !maskedStates[key];
        const contact = contactsData.find(c => c.contact_key === key);
        if (contact) {
          const rawPhone = String(contact.phone_e164 || '').replace(/[^0-9]/g, '');
          const maskedPhone = contact.phone_masked || (rawPhone ? rawPhone.slice(0, 4) + '****' + rawPhone.slice(-3) : '***');
          const phoneEl = document.getElementById(`phone-${key}`);
          if (phoneEl) {
            phoneEl.textContent = maskedStates[key] ? (contact.phone_e164 || rawPhone) : maskedPhone;
          }
          e.currentTarget.textContent = maskedStates[key] ? 'Sembunyikan' : 'Tampilkan';
        }
      });
    });

    // Copy phone number
    document.querySelectorAll('.btn-copy-phone').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const key = e.currentTarget.getAttribute('data-key');
        const contact = contactsData.find(c => c.contact_key === key);
        if (contact && contact.phone_e164) {
          try {
            await navigator.clipboard.writeText(contact.phone_e164);
            showToast(`Nomor ${contact.phone_masked || ''} disalin`, 'success');
          } catch (_) {
            showToast('Gagal menyalin nomor', 'error');
          }
        }
      });
    });

    // Copy draft text
    document.querySelectorAll('.btn-copy-draft').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const key = e.currentTarget.getAttribute('data-key');
        const textarea = document.getElementById(`draft-${key}`);
        const text = textarea ? textarea.value : '';
        if (text) {
          try {
            await navigator.clipboard.writeText(text);
            showToast('Draf pesan disalin ke clipboard', 'success');
          } catch (_) {
            showToast('Gagal menyalin pesan', 'error');
          }
        }
      });
    });

    // Live word count + auto-save draft on change
    document.querySelectorAll('.draft-textarea').forEach(textarea => {
      textarea.addEventListener('input', (e) => {
        const key = e.currentTarget.getAttribute('data-key');
        const wcEl = document.getElementById(`wc-${key}`);
        if (wcEl) {
          wcEl.textContent = `${countWords(e.currentTarget.value)} kata`;
        }
      });

      textarea.addEventListener('change', async (e) => {
        const key = e.currentTarget.getAttribute('data-key');
        const newDraft = e.currentTarget.value;
        try {
          await fetch(`/api/contacts/${encodeURIComponent(key)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ draft_text: newDraft })
          });
          const contact = contactsData.find(c => c.contact_key === key);
          if (contact) {
            contact.draft_text = newDraft;
            const rawPhone = String(contact.phone_e164 || '').replace(/[^0-9]/g, '');
            const btnWa = document.querySelector(`.btn-dispatch-wa[data-key="${key}"]`);
            if (btnWa) {
              btnWa.href = `https://wa.me/${rawPhone}?text=${encodeURIComponent(newDraft)}`;
            }
          }
          showToast('Draf pesan tersimpan', 'success');
        } catch (err) {
          showToast('Gagal menyimpan draf pesan', 'error');
        }
      });
    });

    // Mark as Contacted
    document.querySelectorAll('.btn-mark-contacted').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const targetBtn = e.currentTarget;
        const key = targetBtn.getAttribute('data-key');
        const nextStatus = targetBtn.getAttribute('data-status');

        try {
          await fetch(`/api/contacts/${encodeURIComponent(key)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: nextStatus })
          });
          showToast(nextStatus === 'contacted' ? 'Kontak ditandai sudah dihubungi' : 'Status kontak dikembalikan', 'success');
          fetchStats();
          fetchContacts();
        } catch (err) {
          showToast('Gagal memperbarui status kontak', 'error');
        }
      });
    });

    // Edit Lead
    document.querySelectorAll('.btn-edit-lead').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const targetBtn = e.currentTarget;
        const key = targetBtn.getAttribute('data-key');
        const name = targetBtn.getAttribute('data-name');
        const phone = targetBtn.getAttribute('data-phone');
        const prog = targetBtn.getAttribute('data-prog');
        const lc = targetBtn.getAttribute('data-lc');

        if (editContactKey) editContactKey.value = key;
        if (editFullName) editFullName.value = name.startsWith('Pendaftar (') ? '' : name;
        if (editPhone) editPhone.value = phone || '';
        if (editProgramme) editProgramme.value = prog || 'GV';
        if (editLc) editLc.value = lc || '';
        if (editLeadTitle) editLeadTitle.textContent = `Perbaiki Data (${key.replace('e:', 'ID #')})`;

        if (editModal) {
          editModal.classList.add('open');
          editModal.setAttribute('aria-hidden', 'false');
          if (editFullName) editFullName.focus();
        }
      });
    });
  }

  // --- Edit Lead Modal Handlers ---
  function closeEditModal() {
    if (editModal) {
      editModal.classList.remove('open');
      editModal.setAttribute('aria-hidden', 'true');
    }
  }

  if (btnCloseEditLead) btnCloseEditLead.addEventListener('click', closeEditModal);
  if (btnCancelEditLead) btnCancelEditLead.addEventListener('click', closeEditModal);
  if (editModal) {
    editModal.addEventListener('click', (e) => {
      if (e.target === editModal) closeEditModal();
    });
  }

  if (editLeadForm) {
    editLeadForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const key = editContactKey.value;
      const payload = {
        full_name: editFullName.value.trim(),
        phone: editPhone.value.trim(),
        programme: editProgramme.value,
        lc: editLc.value.trim()
      };

      try {
        const res = await fetch(`/api/contacts/${encodeURIComponent(key)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (res.ok) {
          showToast(data.message || 'Data pendaftar berhasil diperbarui', data.status === 'draft_ready' ? 'success' : 'info');
          closeEditModal();
          await fetchStats();
          await fetchContacts();
        } else {
          showToast(data.error || 'Gagal menyimpan perubahan', 'error');
        }
      } catch (err) {
        showToast('Terjadi kesalahan saat menyimpan data', 'error');
      }
    });
  }

  // --- 5. Remote Trigger Langflow Flow ---
  btnRun.addEventListener('click', async () => {
    btnRun.disabled = true;
    const spinIcon = btnRun.querySelector('.icon-spin-target');
    if (spinIcon) spinIcon.classList.add('is-spinning');
    btnRunLabel.textContent = 'Memproses...';

    try {
      const res = await fetch('/api/trigger', { method: 'POST' });
      const data = await res.json();

      showToast(data.message || 'Alur pendaftar berhasil diproses!', 'success');
      await fetchStats();
      await fetchContacts();
      await checkStatus();
    } catch (err) {
      showToast('Gagal memicu alur pendaftar', 'error');
    } finally {
      btnRun.disabled = false;
      if (spinIcon) spinIcon.classList.remove('is-spinning');
      btnRunLabel.textContent = 'Sinkronisasi Pendaftar';
    }
  });

  // --- 6. Export to Spreadsheet (.CSV) ---
  btnExportCsv.addEventListener('click', async () => {
    btnExportCsv.disabled = true;
    try {
      const res = await fetch('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ upload_to_gdrive: false })
      });
      const data = await res.json();

      if (data.success && data.download_url) {
        const a = document.createElement('a');
        a.href = data.download_url;
        a.download = data.file_name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        const sourceLabel = data.mode === 'langflow_live' ? 'via Langflow' : 'Fallback Lokal';
        showToast(`Spreadsheet diunduh ${sourceLabel} (${data.total_rows} kontak)`, 'success');
      } else {
        showToast('Gagal menyiapkan spreadsheet ekspor', 'error');
      }
    } catch (err) {
      showToast('Terjadi kesalahan saat mengekspor data', 'error');
    } finally {
      btnExportCsv.disabled = false;
    }
  });

  // --- 7. Google Drive Direct Backup ---
  btnSyncGdrive.addEventListener('click', async () => {
    btnSyncGdrive.disabled = true;
    gdriveBtnLabel.textContent = 'Mengunggah...';

    try {
      const res = await fetch('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ upload_to_gdrive: true })
      });
      const data = await res.json();

      if (data.gdrive && data.gdrive.uploaded) {
        showToast(data.gdrive.message || 'Berhasil diunggah ke Google Drive!', 'success');
        if (data.gdrive.file_url) {
          window.open(data.gdrive.file_url, '_blank');
        }
      } else {
        const msg = data.gdrive?.message || 'Google Drive belum dikonfigurasi';
        showToast(msg, 'error');
      }
    } catch (err) {
      showToast('Gagal mengunggah file ke Google Drive', 'error');
    } finally {
      btnSyncGdrive.disabled = false;
      gdriveBtnLabel.textContent = 'Backup Drive';
    }
  });

  // --- 8. Filter, Search, Metric Card & View Mode Handlers ---
  segButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      syncStatusFilterUI(btn.getAttribute('data-status'));
      fetchContacts();
    });
  });

  metricCards.forEach(card => {
    card.addEventListener('click', () => {
      syncStatusFilterUI(card.getAttribute('data-status-card'));
      fetchContacts();
    });
  });

  if (btnViewGrid && btnViewList) {
    btnViewGrid.addEventListener('click', () => {
      viewMode = 'grid';
      btnViewGrid.classList.add('active');
      btnViewList.classList.remove('active');
      leadsContainer.classList.remove('list-view');
    });

    btnViewList.addEventListener('click', () => {
      viewMode = 'list';
      btnViewList.classList.add('active');
      btnViewGrid.classList.remove('active');
      leadsContainer.classList.add('list-view');
    });
  }

  programSelect.addEventListener('change', (e) => {
    currentProgram = e.target.value;
    fetchContacts();
  });

  let debounceTimer = null;
  searchInput.addEventListener('input', (e) => {
    const val = e.target.value;
    if (btnClearSearch) {
      btnClearSearch.hidden = val.length === 0;
    }
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      currentSearch = val.trim();
      fetchContacts();
    }, 200);
  });

  if (btnClearSearch) {
    btnClearSearch.addEventListener('click', () => {
      searchInput.value = '';
      btnClearSearch.hidden = true;
      currentSearch = '';
      fetchContacts();
      searchInput.focus();
    });
  }

  // Keyboard shortcuts: '/' focuses search, 'Escape' closes modals
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeModal();
      closeEditModal();
      closeTemplateModal();
    } else if (e.key === '/' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
      e.preventDefault();
      searchInput.focus();
    }
  });

  btnRefreshList.addEventListener('click', () => {
    fetchStats();
    fetchContacts();
    checkStatus();
    showToast('Data antrean disegarkan', 'info');
  });

  // --- 9. Template Pesan Modal Configuration ---
  function updateTemplatePreview() {
    if (!cfgMessageTemplate || !templatePreviewText) return;
    const raw = cfgMessageTemplate.value || DEFAULT_MESSAGE_TEMPLATE;
    const rendered = raw
      .replace(/\{full_name\}/g, 'Budi Santoso')
      .replace(/\{first_name\}/g, 'Budi')
      .replace(/\{programme_full\}/g, 'Global Volunteer')
      .replace(/\{programme\}/g, 'GV')
      .replace(/\{lc\}/g, 'Bandung')
      .replace(/\{cta_link\}/g, cachedCtaLink || 'https://aiesec.or.id/welcome');
    templatePreviewText.textContent = rendered;
    if (templatePreviewWords) {
      templatePreviewWords.textContent = `${countWords(rendered)} kata`;
    }
  }

  function closeTemplateModal() {
    if (templateModal) {
      templateModal.classList.remove('open');
      templateModal.setAttribute('aria-hidden', 'true');
    }
  }

  if (btnOpenTemplate) {
    btnOpenTemplate.addEventListener('click', async () => {
      await loadConfig();
      updateTemplatePreview();
      if (templateModal) {
        templateModal.classList.add('open');
        templateModal.setAttribute('aria-hidden', 'false');
        if (cfgMessageTemplate) cfgMessageTemplate.focus();
      }
    });
  }

  if (btnCloseTemplate) btnCloseTemplate.addEventListener('click', closeTemplateModal);
  if (btnCancelTemplate) btnCancelTemplate.addEventListener('click', closeTemplateModal);
  if (templateModal) {
    templateModal.addEventListener('click', (e) => {
      if (e.target === templateModal) closeTemplateModal();
    });
  }

  if (cfgMessageTemplate) {
    cfgMessageTemplate.addEventListener('input', updateTemplatePreview);
  }

  if (btnResetTemplate) {
    btnResetTemplate.addEventListener('click', () => {
      if (cfgMessageTemplate) {
        cfgMessageTemplate.value = DEFAULT_MESSAGE_TEMPLATE;
        updateTemplatePreview();
        cfgMessageTemplate.focus();
      }
    });
  }

  varChips.forEach(chip => {
    chip.addEventListener('click', () => {
      if (!cfgMessageTemplate) return;
      const token = chip.getAttribute('data-var') || '';
      const start = cfgMessageTemplate.selectionStart ?? cfgMessageTemplate.value.length;
      const end = cfgMessageTemplate.selectionEnd ?? cfgMessageTemplate.value.length;
      const val = cfgMessageTemplate.value;
      cfgMessageTemplate.value = val.slice(0, start) + token + val.slice(end);
      cfgMessageTemplate.focus();
      cfgMessageTemplate.setSelectionRange(start + token.length, start + token.length);
      updateTemplatePreview();
    });
  });

  if (templateForm) {
    templateForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const tplText = cfgMessageTemplate ? cfgMessageTemplate.value.trim() : DEFAULT_MESSAGE_TEMPLATE;
      const applyAll = cfgApplyTemplateAll ? cfgApplyTemplateAll.checked : true;

      try {
        const res = await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message_template: tplText,
            apply_template_to_all: applyAll
          })
        });
        const data = await res.json();
        if (res.ok) {
          showToast(
            applyAll
              ? `Template disimpan & diterapkan ke ${data.updated_drafts ?? 0} pendaftar!`
              : 'Template pesan berhasil disimpan',
            'success'
          );
          closeTemplateModal();
          await fetchContacts();
        } else {
          showToast('Gagal menyimpan template pesan', 'error');
        }
      } catch (err) {
        showToast('Terjadi kesalahan saat menyimpan template', 'error');
      }
    });
  }

  // --- 10. Settings Modal Configuration ---
  async function loadConfig() {
    try {
      const res = await fetch('/api/config');
      const cfg = await res.json();
      cfgLangflowHost.value = cfg.langflow_host || '';
      cfgFlowId.value = cfg.flow_id || '';
      if (cfgLangflowApiKey) cfgLangflowApiKey.value = cfg.langflow_api_key || '';
      cfgGdriveUrl.value = cfg.gdrive_webhook_url || '';
      if (cfgGdriveSecret) cfgGdriveSecret.value = cfg.gdrive_webhook_secret || '';
      cfgCtaLink.value = cfg.cta_link || '';
      cachedCtaLink = cfg.cta_link || 'https://aiesec.or.id/welcome';
      if (cfgMessageTemplate) {
        cfgMessageTemplate.value = cfg.message_template || DEFAULT_MESSAGE_TEMPLATE;
      }
    } catch (e) {
      console.error('Failed to load settings:', e);
    }
  }

  btnOpenSettings.addEventListener('click', () => {
    loadConfig();
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
  });

  function closeModal() {
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
  }

  btnCloseSettings.addEventListener('click', closeModal);
  btnCancelSettings.addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });

  settingsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const newCfg = {
      langflow_host: cfgLangflowHost.value.trim(),
      flow_id: cfgFlowId.value.trim(),
      langflow_api_key: cfgLangflowApiKey ? cfgLangflowApiKey.value.trim() : undefined,
      gdrive_webhook_url: cfgGdriveUrl.value.trim(),
      gdrive_webhook_secret: cfgGdriveSecret ? cfgGdriveSecret.value.trim() : undefined,
      cta_link: cfgCtaLink.value.trim()
    };

    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newCfg)
      });
      if (res.ok) {
        showToast('Pengaturan integrasi berhasil disimpan', 'success');
        closeModal();
        checkStatus();
      } else {
        showToast('Gagal menyimpan pengaturan', 'error');
      }
    } catch (err) {
      showToast('Terjadi kesalahan saat menyimpan pengaturan', 'error');
    }
  });

  // Helper Escape HTML
  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // --- Initial Mount ---
  checkStatus();
  fetchStats();
  fetchContacts();
  setInterval(checkStatus, 30000);
});
