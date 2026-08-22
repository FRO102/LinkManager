// ============================================================
// Nodes — Link Manager
// Persistence: server REST API (Express), stored in data/links.json
// ============================================================

(() => {
  'use strict';

  const API = '/api/links';

  /** @type {{id:string,url:string,title:string,tags:string[],description:string,favorite:boolean,order:number,linkStatus:string|null,linkStatusCode:number|null,lastCheckedAt:string|null,createdAt:string,updatedAt:string}[]} */
  let links = [];
  let editingId = null;
  let pendingDeleteId = null;

  let activeTagFilters = new Set();
  let tagFilterMode = 'or'; // 'or' = any selected tag; 'and' = all
  let searchTerm = '';
  let sortMode = 'recent';
  let viewMode = 'list';
  let density = 'comfortable';

  // Transparent pagination: the list grows as you approach the end of the page,
  // with no visible page numbers — just an automatic "load more".
  const PAGE_SIZE = 40;
  let visibleCount = PAGE_SIZE;
  let renderedIds = []; // IDs currently in the DOM, in order — used by drag & drop

  try { viewMode = localStorage.getItem('nodes-view-mode') || 'list'; } catch {}
  try { density = localStorage.getItem('nodes-density') || 'comfortable'; } catch {}

  // ---------- DOM refs ----------
  const $ = (sel) => document.querySelector(sel);

  const form           = $('#linkForm');
  const editingIdInput = $('#editingId');
  const inputUrl        = $('#inputUrl');
  const inputTitle      = $('#inputTitle');
  const inputTags       = $('#inputTags');
  const inputNotes      = $('#inputNotes');
  const inputFavorite   = $('#inputFavorite');
  const btnSubmit       = $('#btnSubmit');
  const btnCancelEdit   = $('#btnCancelEdit');
  const formError       = $('#formError');
  const composerTitle   = $('#composerTitle');

  const fileStatus      = $('#fileStatus');

  const searchInput     = $('#searchInput');
  const filterTagsEl    = $('#filterTags');
  const sortSelect      = $('#sortSelect');
  const countLine       = $('#countLine');
  const footerCount     = $('#footerCount');
  const linkListEl      = $('#linkList');
  const emptyState      = $('#emptyState');
  const toastEl         = $('#toast');
  const btnToggleView   = $('#btnToggleView');
  const btnToggleDensity = $('#btnToggleDensity');
  const btnExport       = $('#btnExport');
  const btnImport       = $('#btnImport');
  const btnStats        = $('#btnStats');
  const btnDuplicates   = $('#btnDuplicates');
  const btnCheckLinks   = $('#btnCheckLinks');
  const checkProgress   = $('#checkProgress');
  const checkProgressText = $('#checkProgressText');

  const confirmOverlay  = $('#confirmOverlay');
  const confirmText     = $('#confirmText');
  const confirmCancel   = $('#confirmCancel');
  const confirmDelete   = $('#confirmDelete');

  const importOverlay   = $('#importOverlay');
  const importClose     = $('#importClose');
  const importCancel    = $('#importCancel');
  const importSubmit    = $('#importSubmit');
  const importError     = $('#importError');
  const importResult    = $('#importResult');
  const tabBookmarks    = $('#tabBookmarks');
  const tabJson         = $('#tabJson');
  const panelBookmarks  = $('#panelBookmarks');
  const panelJson       = $('#panelJson');
  const fileBookmarks   = $('#fileBookmarks');
  const fileJson        = $('#fileJson');
  const importTagsBookmarks = $('#importTagsBookmarks');
  const importTagsJson  = $('#importTagsJson');

  const statsOverlay    = $('#statsOverlay');
  const statsClose      = $('#statsClose');
  const statsContent    = $('#statsContent');

  const duplicatesOverlay = $('#duplicatesOverlay');
  const duplicatesClose = $('#duplicatesClose');
  const duplicatesContent = $('#duplicatesContent');

  const linkPreviewEl   = $('#linkPreview');
  const previewLoading  = $('#previewLoading');
  const previewBody     = $('#previewBody');
  const previewImage    = $('#previewImage');
  const previewTitle    = $('#previewTitle');
  const previewDescription = $('#previewDescription');
  const previewEmpty    = $('#previewEmpty');

  // ---------- Utilities ----------

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function normalizeUrl(raw) {
    let value = raw.trim();
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) {
      value = 'https://' + value;
    }
    return value;
  }

  function faviconFor(url) {
    try {
      const u = new URL(url);
      return `https://www.google.com/s2/favicons?sz=64&domain=${u.hostname}`;
    } catch {
      return null;
    }
  }

  function hostnameFor(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return url;
    }
  }

  function formatDate(iso) {
    try {
      const d = new Date(iso);
      return d.toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' });
    } catch {
      return '';
    }
  }

  function showToast(message, type = 'default') {
    toastEl.textContent = message;
    toastEl.className = 'toast visible' + (type !== 'default' ? ' ' + type : '');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => {
      toastEl.classList.remove('visible');
    }, 2600);
  }

  function setStatus(state, label) {
    fileStatus.dataset.state = state;
    fileStatus.querySelector('.status-label').textContent = label;
  }

  function timeAgo(iso) {
    if (!iso) return null;
    const diffMs = Date.now() - new Date(iso).getTime();
    const mins = Math.round(diffMs / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    return `${days}d ago`;
  }

  // ---------- API ----------

  async function apiList() {
    const res = await fetch(API);
    if (!res.ok) throw new Error('Failed to load');
    return res.json();
  }

  async function apiCreate(payload) {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error creating node');
    return data;
  }

  async function apiUpdate(id, payload) {
    const res = await fetch(`${API}/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error updating node');
    return data;
  }

  async function apiDelete(id) {
    const res = await fetch(`${API}/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Error removing node');
    }
  }

  async function apiReorder(orderedIds) {
    const res = await fetch(`${API}/reorder`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderedIds }),
    });
    if (!res.ok) throw new Error('Error saving new order');
  }

  async function apiCheckOne(id) {
    const res = await fetch(`${API}/${id}/check`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error checking link');
    return data;
  }

  async function apiCheckAll() {
    const res = await fetch(`${API}/check-all`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error checking links');
    return data;
  }

  async function apiCheckStatus() {
    const res = await fetch(`${API}/check-status`);
    return res.json();
  }

  async function apiPreview(url) {
    const res = await fetch(`/api/preview?url=${encodeURIComponent(url)}`);
    if (!res.ok) return null;
    return res.json();
  }

  async function apiImportBookmarks(html, defaultTags) {
    const res = await fetch('/api/import/bookmarks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html, defaultTags }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error importing bookmarks');
    return data;
  }

  async function apiImportJson(items, defaultTags) {
    const res = await fetch('/api/import/json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items, defaultTags }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error importing file');
    return data;
  }

  async function apiStats() {
    const res = await fetch('/api/stats');
    if (!res.ok) throw new Error('Error fetching statistics');
    return res.json();
  }

  async function apiDuplicates() {
    const res = await fetch('/api/duplicates');
    if (!res.ok) throw new Error('Error fetching duplicates');
    return res.json();
  }

  function exportAsDownload() {
    const blob = new Blob([JSON.stringify(links, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'links.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast('.json file downloaded', 'success');
  }

  // ---------- CRUD ----------

  function enterEditMode(link) {
    editingId = link.id;
    editingIdInput.value = link.id;
    inputUrl.value = link.url;
    inputTitle.value = link.title;
    inputTags.value = (link.tags || []).join(', ');
    inputNotes.value = link.description || '';
    inputFavorite.checked = !!link.favorite;
    composerTitle.textContent = '01 — Edit node';
    btnSubmit.textContent = 'Save changes';
    btnCancelEdit.classList.remove('hidden');
    formError.classList.add('hidden');
    inputUrl.focus();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function exitEditMode() {
    editingId = null;
    editingIdInput.value = '';
    form.reset();
    composerTitle.textContent = '01 — Add node';
    btnSubmit.textContent = 'Save node';
    btnCancelEdit.classList.add('hidden');
    formError.classList.add('hidden');
  }

  async function handleSubmit(e) {
    e.preventDefault();
    formError.classList.add('hidden');

    const url = normalizeUrl(inputUrl.value);
    try {
      new URL(url);
    } catch {
      formError.textContent = 'Invalid address.';
      formError.classList.remove('hidden');
      return;
    }

    // Duplicate detection — only when creating, not when editing the node itself
    if (!editingId) {
      try {
        const dupRes = await fetch(`${API}/check-duplicate?url=${encodeURIComponent(url)}`);
        const dupData = await dupRes.json();
        if (dupData.duplicate) {
          const proceed = window.confirm(
            `You already have a node with this address: "${dupData.existing.title}".\n\nSave anyway?`
          );
          if (!proceed) return;
        }
      } catch {
        // If the check fails, don't block the flow — proceed anyway
      }
    }

    const payload = {
      url,
      title: inputTitle.value.trim() || hostnameFor(url),
      tags: inputTags.value.split(',').map(t => t.trim()).filter(Boolean),
      description: inputNotes.value.trim(),
      favorite: inputFavorite.checked,
    };

    btnSubmit.disabled = true;
    try {
      if (editingId) {
        await apiUpdate(editingId, payload);
        showToast('Node updated', 'success');
        exitEditMode();
      } else {
        await apiCreate(payload);
        showToast('Node added', 'success');
        form.reset();
      }
      await refresh();
    } catch (err) {
      formError.textContent = err.message;
      formError.classList.remove('hidden');
    } finally {
      btnSubmit.disabled = false;
    }
  }

  function openConfirm(link) {
    pendingDeleteId = link.id;
    confirmText.textContent = `Are you sure you want to remove "${link.title}"? This action cannot be undone.`;
    confirmOverlay.classList.remove('hidden');
  }

  function closeConfirm() {
    pendingDeleteId = null;
    confirmOverlay.classList.add('hidden');
  }

  async function confirmDeleteNow() {
    if (!pendingDeleteId) return;
    const link = links.find(l => l.id === pendingDeleteId);
    try {
      await apiDelete(pendingDeleteId);
      if (editingId === pendingDeleteId) exitEditMode();
      showToast(`"${link ? link.title : 'Node'}" removed`);
      closeConfirm();
      await refresh();
    } catch (err) {
      showToast(err.message, 'error');
      closeConfirm();
    }
  }

  async function toggleFavorite(id) {
    const link = links.find(l => l.id === id);
    if (!link) return;
    try {
      await apiUpdate(id, { favorite: !link.favorite });
      await refresh();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  async function refresh() {
    try {
      links = await apiList();
      setStatus('connected', 'Connected to server');
      render();
    } catch (err) {
      setStatus('error', 'Connection failed');
      showToast('Could not reach the server', 'error');
    }
  }

  // ---------- Rendering ----------

  function collectTagCounts() {
    const counts = new Map();
    links.forEach(l => (l.tags || []).forEach(t => counts.set(t, (counts.get(t) || 0) + 1)));
    return counts;
  }

  function renderTagFilters() {
    const counts = collectTagCounts();
    const tags = Array.from(counts.keys()).sort((a, b) => {
      const diff = counts.get(b) - counts.get(a);
      return diff !== 0 ? diff : a.localeCompare(b, 'en');
    });

    filterTagsEl.innerHTML = '';

    tags.forEach(tag => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'tag-chip' + (activeTagFilters.has(tag) ? ' active' : '');
      chip.setAttribute('aria-pressed', String(activeTagFilters.has(tag)));
      chip.innerHTML = `${escapeHtml(tag)} <span class="tag-count">${counts.get(tag)}</span>`;
      chip.addEventListener('click', () => {
        if (activeTagFilters.has(tag)) {
          activeTagFilters.delete(tag);
        } else {
          activeTagFilters.add(tag);
        }
        renderTagFilters();
        resetPaginationAndRender();
      });
      filterTagsEl.appendChild(chip);
    });

    // AND/OR mode control — only relevant with 2+ tags selected
    if (activeTagFilters.size > 1) {
      const modeBtn = document.createElement('button');
      modeBtn.type = 'button';
      modeBtn.className = 'tag-mode-btn';
      modeBtn.title = tagFilterMode === 'or'
        ? 'Showing nodes with any of the selected tags — click to require all'
        : 'Showing nodes with all selected tags — click to accept any';
      modeBtn.textContent = tagFilterMode === 'or' ? 'any' : 'all';
      modeBtn.addEventListener('click', () => {
        tagFilterMode = tagFilterMode === 'or' ? 'and' : 'or';
        renderTagFilters();
        resetPaginationAndRender();
      });
      filterTagsEl.appendChild(modeBtn);
    }

    if (activeTagFilters.size > 0) {
      const clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.className = 'tag-clear-btn';
      clearBtn.title = 'Clear tag filter';
      clearBtn.textContent = '✕ clear';
      clearBtn.addEventListener('click', () => {
        activeTagFilters.clear();
        renderTagFilters();
        resetPaginationAndRender();
      });
      filterTagsEl.appendChild(clearBtn);
    }
  }

  function getFilteredSorted() {
    let list = links.slice();

    if (activeTagFilters.size > 0) {
      list = list.filter(l => {
        const tags = l.tags || [];
        return tagFilterMode === 'and'
          ? Array.from(activeTagFilters).every(t => tags.includes(t))
          : Array.from(activeTagFilters).some(t => tags.includes(t));
      });
    }

    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      list = list.filter(l =>
        l.title.toLowerCase().includes(q) ||
        l.url.toLowerCase().includes(q) ||
        (l.description || '').toLowerCase().includes(q) ||
        (l.tags || []).some(t => t.toLowerCase().includes(q))
      );
    }

    switch (sortMode) {
      case 'oldest':
        list.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
        break;
      case 'az':
        list.sort((a, b) => a.title.localeCompare(b.title, 'en'));
        break;
      case 'za':
        list.sort((a, b) => b.title.localeCompare(a.title, 'en'));
        break;
      case 'favorites':
        list.sort((a, b) => (b.favorite - a.favorite) || (new Date(b.createdAt) - new Date(a.createdAt)));
        break;
      case 'manual':
        list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        break;
      case 'recent':
      default:
        list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        break;
    }

    return list;
  }

  function renderList() {
    const list = getFilteredSorted();

    linkListEl.innerHTML = '';
    linkListEl.className = 'link-list'
      + (viewMode === 'grid' ? ' view-grid' : '')
      + (density === 'compact' ? ' density-compact' : '')
      + (sortMode === 'manual' ? ' sort-manual' : '');

    if (links.length === 0) {
      emptyState.classList.add('visible');
      emptyState.querySelector('p').textContent = 'No nodes in the collection yet.';
      linkListEl.style.display = 'none';
      renderedIds = [];
      updateCountLine(list.length);
      return;
    }

    if (list.length === 0) {
      emptyState.classList.add('visible');
      emptyState.querySelector('p').textContent = 'No node matches your search.';
      linkListEl.style.display = 'none';
      renderedIds = [];
      updateCountLine(list.length);
      return;
    }

    emptyState.classList.remove('visible');
    linkListEl.style.display = '';

    // Transparent pagination: only renders the first `visibleCount`.
    // More items load automatically near the end (see scroll listener in init).
    const slice = list.slice(0, visibleCount);
    renderedIds = slice.map(l => l.id);

    slice.forEach(link => {
      linkListEl.appendChild(buildCardEl(link));
    });

    updateCountLine(list.length);
  }

  function updateCountLine(filteredTotal) {
    const tagSummary = activeTagFilters.size > 0
      ? ` · tags: ${Array.from(activeTagFilters).join(tagFilterMode === 'and' ? ' + ' : ' or ')}`
      : '';
    const shown = Math.min(visibleCount, filteredTotal);
    countLine.textContent = `${shown} of ${filteredTotal} nodes${tagSummary}`;
    footerCount.textContent = links.length;
  }

  // Codes that mean "the server is up but refused/rate-limited this request" —
  // shown as "blocked" rather than "broken", since the site itself may be fine.
  const BLOCKED_STATUS_CODES = new Set([401, 403, 429]);

  function buildHealthBadge(link) {
    if (!link.linkStatus) {
      return `<button type="button" class="link-health-badge" data-status="unchecked" data-action="check-one" data-id="${link.id}" title="Not checked yet — click to check">
          <span class="health-dot"></span>unchecked
        </button>`;
    }

    const isBlocked = link.linkStatus === 'broken' && BLOCKED_STATUS_CODES.has(link.linkStatusCode);
    const badgeStatus = isBlocked ? 'blocked' : link.linkStatus;
    const label = link.linkStatus === 'ok' ? 'ok' : (isBlocked ? 'blocked' : 'broken');

    let tooltip;
    if (link.linkStatus === 'ok') {
      tooltip = 'Link is reachable';
    } else if (isBlocked) {
      tooltip = 'Site is likely online but blocked this automated request (this happens with some anti-bot protections) — worth checking manually in your browser';
    } else if (link.linkStatusError === 'timeout') {
      tooltip = 'The site took too long to respond (timeout)';
    } else if (link.linkStatusError === 'unreachable') {
      tooltip = 'Could not connect at all (DNS failure, connection refused, or similar) — worth double-checking the address is correct';
    } else {
      tooltip = 'Link may be down';
    }

    return `<button type="button" class="link-health-badge" data-status="${badgeStatus}" data-action="check-one" data-id="${link.id}" title="${tooltip}${link.linkStatusCode ? ' (HTTP ' + link.linkStatusCode + ')' : ''} · checked ${timeAgo(link.lastCheckedAt) || ''} · click to check again">
          <span class="health-dot"></span>${label}
        </button>`;
  }

  function buildCardEl(link) {
    const li = document.createElement('li');
    li.className = 'link-card' + (link.favorite ? ' is-favorite' : '');
    li.dataset.id = link.id;
    li.draggable = sortMode === 'manual';

    const favicon = faviconFor(link.url);
    const tags = link.tags || [];

    const healthBadge = buildHealthBadge(link);

    li.innerHTML = `
      <span class="drag-handle" title="Drag to reorder">⠿</span>
      <div class="link-favicon">${favicon ? `<img src="${favicon}" alt="" loading="lazy" onerror="this.parentElement.textContent='◈'">` : '◈'}</div>
      <div class="link-body">
        <div class="link-title-row">
          <a class="link-title" href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer" data-action="preview-target">${escapeHtml(link.title)}</a>
          ${link.favorite ? '<span class="favorite-star">★</span>' : ''}
          ${healthBadge}
        </div>
        <a class="link-url" href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(hostnameFor(link.url))}</a>
        ${link.description ? `<p class="link-notes">${escapeHtml(link.description)}</p>` : ''}
        ${tags.length ? `<div class="link-tags">${tags.map(t => `<button type="button" class="link-tag" data-action="filter-tag" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</button>`).join('')}</div>` : ''}
        <p class="link-meta">added on ${formatDate(link.createdAt)}</p>
      </div>
      <div class="link-actions">
        <button class="icon-btn fav-btn${link.favorite ? ' active' : ''}" title="Toggle favorite" data-action="favorite" data-id="${link.id}">★</button>
        <button class="icon-btn" title="Copy URL" data-action="copy" data-id="${link.id}">⧉</button>
        <button class="icon-btn" title="Edit" data-action="edit" data-id="${link.id}">✎</button>
        <button class="icon-btn danger" title="Remove" data-action="delete" data-id="${link.id}">✕</button>
      </div>
    `;
    return li;
  }

  function render() {
    renderTagFilters();
    renderList();
  }

  function resetPaginationAndRender() {
    visibleCount = PAGE_SIZE;
    renderList();
  }

  // ---------- Event wiring ----------

  form.addEventListener('submit', handleSubmit);
  btnCancelEdit.addEventListener('click', exitEditMode);

  linkListEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const { action, id } = btn.dataset;
    const link = links.find(l => l.id === id);
    if (action === 'delete' && link) openConfirm(link);
    if (action === 'edit' && link) enterEditMode(link);
    if (action === 'favorite') toggleFavorite(id);
    if (action === 'copy' && link) {
      navigator.clipboard.writeText(link.url).then(() => showToast('URL copied!'));
    }
    if (action === 'filter-tag') {
      const tag = btn.dataset.tag;
      activeTagFilters.add(tag);
      renderTagFilters();
      resetPaginationAndRender();
    }
    if (action === 'check-one' && link) checkOneLink(link, btn);
  });

  confirmCancel.addEventListener('click', closeConfirm);
  confirmDelete.addEventListener('click', confirmDeleteNow);
  confirmOverlay.addEventListener('click', (e) => {
    if (e.target === confirmOverlay) closeConfirm();
  });

  let searchDebounce;
  searchInput.addEventListener('input', (e) => {
    clearTimeout(searchDebounce);
    const value = e.target.value;
    searchDebounce = setTimeout(() => {
      searchTerm = value;
      resetPaginationAndRender();
    }, 180);
  });

  sortSelect.addEventListener('change', (e) => {
    sortMode = e.target.value;
    resetPaginationAndRender();
  });

  btnExport.addEventListener('click', exportAsDownload);
  $('#btnToggleTheme').addEventListener('click', toggleTheme);
  btnToggleView.addEventListener('click', toggleView);

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeConfirm();
    if (e.key === '/' &&
        document.activeElement !== inputUrl &&
        document.activeElement !== inputTitle &&
        document.activeElement !== inputTags &&
        document.activeElement !== inputNotes &&
        document.activeElement !== searchInput) {
      e.preventDefault();
      searchInput.focus();
    }
  });

  // ---------- Theme / view ----------

  function toggleTheme() {
    const isDark = document.body.dataset.theme === 'dark';
    document.body.dataset.theme = isDark ? '' : 'dark';
    try { localStorage.setItem('nodes-theme', isDark ? 'light' : 'dark'); } catch {}
  }

  function toggleView() {
    viewMode = viewMode === 'list' ? 'grid' : 'list';
    try { localStorage.setItem('nodes-view-mode', viewMode); } catch {}
    btnToggleView.textContent = viewMode === 'list' ? '⊞' : '≡';
    renderList();
  }

  function toggleDensity() {
    density = density === 'comfortable' ? 'compact' : 'comfortable';
    try { localStorage.setItem('nodes-density', density); } catch {}
    renderList();
  }

  // ---------- Dead link checking ----------

  async function checkOneLink(link, btnEl) {
    const original = btnEl.innerHTML;
    btnEl.disabled = true;
    btnEl.innerHTML = '<span class="health-dot"></span>checking…';
    try {
      const updated = await apiCheckOne(link.id);
      const idx = links.findIndex(l => l.id === link.id);
      if (idx !== -1) links[idx] = updated;
      renderList();

      const isBlocked = updated.linkStatus === 'broken' && BLOCKED_STATUS_CODES.has(updated.linkStatusCode);
      const message = updated.linkStatus === 'ok'
        ? 'Link is reachable'
        : isBlocked
          ? `Request was blocked (HTTP ${updated.linkStatusCode}) — the site may still be online`
          : 'Link seems to be down';
      showToast(message, updated.linkStatus === 'ok' ? 'success' : 'error');
    } catch (err) {
      showToast(err.message, 'error');
      btnEl.disabled = false;
      btnEl.innerHTML = original;
    }
  }

  let checkPollTimer = null;

  async function checkAllLinksNow() {
    try {
      const { inProgress } = await apiCheckStatus();
      if (inProgress) {
        showToast('A check is already in progress', 'error');
        startCheckPolling();
        return;
      }
    } catch {}

    btnCheckLinks.disabled = true;
    checkProgress.classList.remove('hidden');
    checkProgressText.textContent = 'Checking links…';

    try {
      await apiCheckAll();
      await refresh();
      showToast('Check complete', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      btnCheckLinks.disabled = false;
      checkProgress.classList.add('hidden');
    }
  }

  function startCheckPolling() {
    checkProgress.classList.remove('hidden');
    btnCheckLinks.disabled = true;
    clearInterval(checkPollTimer);
    checkPollTimer = setInterval(async () => {
      try {
        const { inProgress } = await apiCheckStatus();
        if (!inProgress) {
          clearInterval(checkPollTimer);
          checkProgress.classList.add('hidden');
          btnCheckLinks.disabled = false;
          await refresh();
        }
      } catch {
        clearInterval(checkPollTimer);
        checkProgress.classList.add('hidden');
        btnCheckLinks.disabled = false;
      }
    }, 4000);
  }

  // ---------- Drag & drop (manual reordering) ----------

  let dragSourceId = null;

  function attachDragHandlers() {
    linkListEl.addEventListener('dragstart', (e) => {
      const card = e.target.closest('.link-card');
      if (!card || sortMode !== 'manual') { e.preventDefault(); return; }
      dragSourceId = card.dataset.id;
      card.classList.add('is-dragging');
      e.dataTransfer.effectAllowed = 'move';
    });

    linkListEl.addEventListener('dragend', (e) => {
      const card = e.target.closest('.link-card');
      if (card) card.classList.remove('is-dragging');
      linkListEl.querySelectorAll('.drag-over-top, .drag-over-bottom').forEach(el => {
        el.classList.remove('drag-over-top', 'drag-over-bottom');
      });
      dragSourceId = null;
    });

    linkListEl.addEventListener('dragover', (e) => {
      if (sortMode !== 'manual' || !dragSourceId) return;
      e.preventDefault();
      const card = e.target.closest('.link-card');
      if (!card || card.dataset.id === dragSourceId) return;

      const rect = card.getBoundingClientRect();
      const isAfter = e.clientY > rect.top + rect.height / 2;

      linkListEl.querySelectorAll('.drag-over-top, .drag-over-bottom').forEach(el => {
        if (el !== card) el.classList.remove('drag-over-top', 'drag-over-bottom');
      });
      card.classList.toggle('drag-over-bottom', isAfter);
      card.classList.toggle('drag-over-top', !isAfter);
    });

    linkListEl.addEventListener('drop', async (e) => {
      if (sortMode !== 'manual' || !dragSourceId) return;
      e.preventDefault();
      const targetCard = e.target.closest('.link-card');
      linkListEl.querySelectorAll('.drag-over-top, .drag-over-bottom').forEach(el => {
        el.classList.remove('drag-over-top', 'drag-over-bottom');
      });
      if (!targetCard || targetCard.dataset.id === dragSourceId) return;

      const rect = targetCard.getBoundingClientRect();
      const isAfter = e.clientY > rect.top + rect.height / 2;

      // Reorder renderedIds locally for immediate feedback
      const fromIdx = renderedIds.indexOf(dragSourceId);
      let toIdx = renderedIds.indexOf(targetCard.dataset.id);
      if (fromIdx === -1 || toIdx === -1) return;

      renderedIds.splice(fromIdx, 1);
      toIdx = renderedIds.indexOf(targetCard.dataset.id);
      renderedIds.splice(isAfter ? toIdx + 1 : toIdx, 0, dragSourceId);

      // Re-render the visible list in the new order immediately
      linkListEl.innerHTML = '';
      renderedIds.forEach(id => {
        const link = links.find(l => l.id === id);
        if (link) linkListEl.appendChild(buildCardEl(link));
      });

      try {
        await apiReorder(renderedIds);
        // Update the `order` field locally to reflect the new position
        renderedIds.forEach((id, i) => {
          const link = links.find(l => l.id === id);
          if (link) link.order = i;
        });
      } catch (err) {
        showToast('Error saving order — reloading', 'error');
        await refresh();
      }
    });
  }

  // ---------- Preview on hover (Open Graph) ----------

  let previewHoverTimer = null;
  let previewRequestToken = 0;

  function setupPreviewHover() {
    linkListEl.addEventListener('mouseover', (e) => {
      const target = e.target.closest('[data-action="preview-target"]');
      if (!target) return;
      const card = target.closest('.link-card');
      const link = links.find(l => l.id === card?.dataset.id);
      if (!link) return;

      clearTimeout(previewHoverTimer);
      previewHoverTimer = setTimeout(() => showPreview(link, target), 400);
    });

    linkListEl.addEventListener('mouseout', (e) => {
      const target = e.target.closest('[data-action="preview-target"]');
      if (!target) return;
      clearTimeout(previewHoverTimer);
      hidePreview();
    });
  }

  async function showPreview(link, anchorEl) {
    const myToken = ++previewRequestToken;
    const rect = anchorEl.getBoundingClientRect();

    let left = rect.left;
    let top = rect.bottom + 8;
    if (left + 280 > window.innerWidth - 16) left = window.innerWidth - 296;
    if (top + 220 > window.innerHeight) top = rect.top - 228;

    linkPreviewEl.style.left = `${Math.max(8, left)}px`;
    linkPreviewEl.style.top = `${Math.max(8, top)}px`;
    linkPreviewEl.classList.remove('hidden');
    requestAnimationFrame(() => linkPreviewEl.classList.add('visible'));

    previewLoading.classList.remove('hidden');
    previewBody.classList.add('hidden');
    previewEmpty.classList.add('hidden');

    try {
      const data = await apiPreview(link.url);
      if (myToken !== previewRequestToken) return; // target already changed — ignore stale response

      previewLoading.classList.add('hidden');

      if (!data || (!data.ogTitle && !data.ogDescription && !data.ogImage)) {
        previewEmpty.classList.remove('hidden');
        return;
      }

      previewBody.classList.remove('hidden');
      if (data.ogImage) {
        previewImage.src = data.ogImage;
        previewImage.classList.remove('hidden');
      } else {
        previewImage.classList.add('hidden');
      }
      previewTitle.textContent = data.ogTitle || link.title;
      previewDescription.textContent = data.ogDescription || '';
    } catch {
      if (myToken !== previewRequestToken) return;
      previewLoading.classList.add('hidden');
      previewEmpty.classList.remove('hidden');
    }
  }

  function hidePreview() {
    previewRequestToken++; // invalidate any pending request
    linkPreviewEl.classList.remove('visible');
    setTimeout(() => {
      if (!linkPreviewEl.classList.contains('visible')) linkPreviewEl.classList.add('hidden');
    }, 150);
  }

  // ---------- Import ----------

  function openImportModal() {
    importOverlay.classList.remove('hidden');
    importError.classList.add('hidden');
    importResult.classList.add('hidden');
    fileBookmarks.value = '';
    fileJson.value = '';
    importTagsBookmarks.value = '';
    importTagsJson.value = '';
  }

  function closeImportModal() {
    importOverlay.classList.add('hidden');
  }

  function switchImportTab(tab) {
    const isBookmarks = tab === 'bookmarks';
    tabBookmarks.classList.toggle('active', isBookmarks);
    tabBookmarks.setAttribute('aria-selected', String(isBookmarks));
    tabJson.classList.toggle('active', !isBookmarks);
    tabJson.setAttribute('aria-selected', String(!isBookmarks));
    panelBookmarks.classList.toggle('hidden', !isBookmarks);
    panelJson.classList.toggle('hidden', isBookmarks);
    importError.classList.add('hidden');
    importResult.classList.add('hidden');
  }

  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Could not read the file'));
      reader.readAsText(file);
    });
  }

  async function handleImportSubmit() {
    importError.classList.add('hidden');
    importResult.classList.add('hidden');

    const isBookmarksTab = !tabBookmarks.classList.contains('hidden') && tabBookmarks.classList.contains('active');
    importSubmit.disabled = true;

    try {
      if (isBookmarksTab) {
        const file = fileBookmarks.files[0];
        if (!file) throw new Error('Choose a bookmarks .html file first.');
        const html = await readFileAsText(file);
        const defaultTags = importTagsBookmarks.value.split(',').map(t => t.trim()).filter(Boolean);
        const result = await apiImportBookmarks(html, defaultTags);
        importResult.textContent = `${result.imported} node(s) imported, ${result.skipped} already existed.`;
        importResult.classList.remove('hidden');
      } else {
        const file = fileJson.files[0];
        if (!file) throw new Error('Choose a .json file first.');
        const raw = await readFileAsText(file);
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw new Error('The file is not valid JSON.');
        }
        const items = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.items) ? parsed.items : null);
        if (!items) throw new Error('Unexpected format — expected an array of links.');
        const defaultTags = importTagsJson.value.split(',').map(t => t.trim()).filter(Boolean);
        const result = await apiImportJson(items, defaultTags);
        importResult.textContent = `${result.imported} node(s) imported, ${result.skipped} already existed, ${result.invalid} invalid.`;
        importResult.classList.remove('hidden');
      }
      await refresh();
    } catch (err) {
      importError.textContent = err.message;
      importError.classList.remove('hidden');
    } finally {
      importSubmit.disabled = false;
    }
  }

  // ---------- Statistics ----------

  async function openStatsModal() {
    statsOverlay.classList.remove('hidden');
    statsContent.innerHTML = '<p class="import-hint">Loading…</p>';
    try {
      const stats = await apiStats();
      statsContent.innerHTML = renderStatsHtml(stats);
    } catch (err) {
      statsContent.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    }
  }

  function closeStatsModal() {
    statsOverlay.classList.add('hidden');
  }

  function renderStatsHtml(stats) {
    const maxTag = stats.topTags[0]?.count || 1;
    const maxDomain = stats.topDomains[0]?.count || 1;

    const tagBars = stats.topTags.map(t => `
      <div class="stat-bar-row">
        <span class="stat-bar-label" title="${escapeHtml(t.tag)}">${escapeHtml(t.tag)}</span>
        <span class="stat-bar-track"><span class="stat-bar-fill" style="width:${(t.count / maxTag) * 100}%"></span></span>
        <span class="stat-bar-count">${t.count}</span>
      </div>
    `).join('') || '<p class="import-hint">No tags yet.</p>';

    const domainBars = stats.topDomains.map(d => `
      <div class="stat-bar-row">
        <span class="stat-bar-label" title="${escapeHtml(d.domain)}">${escapeHtml(d.domain)}</span>
        <span class="stat-bar-track"><span class="stat-bar-fill" style="width:${(d.count / maxDomain) * 100}%"></span></span>
        <span class="stat-bar-count">${d.count}</span>
      </div>
    `).join('') || '<p class="import-hint">No data.</p>';

    return `
      <div class="stats-grid">
        <div class="stat-tile">
          <div class="stat-value">${stats.total}</div>
          <div class="stat-label">Total nodes</div>
        </div>
        <div class="stat-tile">
          <div class="stat-value">${stats.favorites}</div>
          <div class="stat-label">Favorites</div>
        </div>
        <div class="stat-tile">
          <div class="stat-value">${stats.totalTags}</div>
          <div class="stat-label">Tags</div>
        </div>
        <div class="stat-tile">
          <div class="stat-value">${stats.linkHealth.ok}</div>
          <div class="stat-label">Links ok</div>
        </div>
        <div class="stat-tile stat-broken">
          <div class="stat-value">${stats.linkHealth.broken}</div>
          <div class="stat-label">Broken</div>
        </div>
      </div>

      <div class="stats-section">
        <h4>Most used tags</h4>
        ${tagBars}
      </div>

      <div class="stats-section">
        <h4>Most saved domains</h4>
        ${domainBars}
      </div>
    `;
  }

  // ---------- Duplicates ----------

  async function openDuplicatesModal() {
    duplicatesOverlay.classList.remove('hidden');
    duplicatesContent.innerHTML = '<p class="import-hint">Looking for duplicates…</p>';
    try {
      const groups = await apiDuplicates();
      if (groups.length === 0) {
        duplicatesContent.innerHTML = '<p class="import-hint">No duplicate nodes found. 🎉</p>';
        return;
      }
      duplicatesContent.innerHTML = groups.map(group => `
        <div class="duplicate-group">
          <p class="duplicate-group-url">${escapeHtml(group[0].url)}</p>
          ${group.map(l => `
            <div class="duplicate-item">
              <span class="duplicate-item-title">${escapeHtml(l.title)}</span>
              <span class="duplicate-item-date">${formatDate(l.createdAt)}</span>
              <button class="icon-btn danger" data-action="delete-duplicate" data-id="${l.id}" title="Remove this one">✕</button>
            </div>
          `).join('')}
        </div>
      `).join('');
    } catch (err) {
      duplicatesContent.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    }
  }

  function closeDuplicatesModal() {
    duplicatesOverlay.classList.add('hidden');
  }

  duplicatesContent.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action="delete-duplicate"]');
    if (!btn) return;
    try {
      await apiDelete(btn.dataset.id);
      showToast('Node removed', 'success');
      await refresh();
      await openDuplicatesModal();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // ---------- Init ----------

  async function init() {
    let savedTheme = null;
    try { savedTheme = localStorage.getItem('nodes-theme'); } catch {}
    if (savedTheme === 'dark' || savedTheme === null) document.body.dataset.theme = 'dark';

    btnToggleView.textContent = viewMode === 'list' ? '⊞' : '≡';

    attachDragHandlers();
    setupPreviewHover();

    // Simple infinite scroll: watches the end of the page instead of a per-item
    // sentinel, which is enough for most screens and avoids rebuilding the observer on every render.
    window.addEventListener('scroll', () => {
      const nearBottom = window.innerHeight + window.scrollY >= document.body.offsetHeight - 600;
      if (!nearBottom) return;
      const total = getFilteredSorted().length;
      if (visibleCount < total) {
        visibleCount = Math.min(visibleCount + PAGE_SIZE, total);
        renderList();
      }
    }, { passive: true });

    btnImport.addEventListener('click', openImportModal);
    importClose.addEventListener('click', closeImportModal);
    importCancel.addEventListener('click', closeImportModal);
    importOverlay.addEventListener('click', (e) => { if (e.target === importOverlay) closeImportModal(); });
    tabBookmarks.addEventListener('click', () => switchImportTab('bookmarks'));
    tabJson.addEventListener('click', () => switchImportTab('json'));
    importSubmit.addEventListener('click', handleImportSubmit);

    btnStats.addEventListener('click', openStatsModal);
    statsClose.addEventListener('click', closeStatsModal);
    statsOverlay.addEventListener('click', (e) => { if (e.target === statsOverlay) closeStatsModal(); });

    btnDuplicates.addEventListener('click', openDuplicatesModal);
    duplicatesClose.addEventListener('click', closeDuplicatesModal);
    duplicatesOverlay.addEventListener('click', (e) => { if (e.target === duplicatesOverlay) closeDuplicatesModal(); });

    btnCheckLinks.addEventListener('click', checkAllLinksNow);
    btnToggleDensity.addEventListener('click', toggleDensity);

    await refresh();

    // If a check is already in progress at server startup, show the indicator
    try {
      const { inProgress } = await apiCheckStatus();
      if (inProgress) startCheckPolling();
    } catch {}
  }

  init();
})();
