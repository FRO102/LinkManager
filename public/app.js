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
  const recentlyAddedIds = new Set(); // briefly highlights newly created nodes

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
  const viewToggleLabel = $('#viewToggleLabel');
  const densityToggleLabel = $('#densityToggleLabel');
  const btnExport       = $('#btnExport');
  const btnImport       = $('#btnImport');
  const btnStats        = $('#btnStats');
  const btnDuplicates   = $('#btnDuplicates');
  const btnCheckLinks   = $('#btnCheckLinks');
  const btnMoreMenu     = $('#btnMoreMenu');
  const moreMenu        = $('#moreMenu');
  const checkProgress   = $('#checkProgress');
  const checkProgressText = $('#checkProgressText');
  const activeFiltersBar = $('#activeFiltersBar');
  const activeFiltersLabel = $('#activeFiltersLabel');
  const btnClearFilters = $('#btnClearFilters');

  const composerPanel   = $('#composerPanel');
  const composerOverlay = $('#composerOverlay');
  const btnFab          = $('#btnFab');
  const btnCloseComposer = $('#btnCloseComposer');

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

  // ---------- Focus trap (accessibility) ----------
  // Keeps Tab/Shift+Tab cycling inside the active modal instead of leaking
  // focus out to the page behind it. One trap is active at a time.

  let activeFocusTrap = null;

  function getFocusableEls(container) {
    const selector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    return Array.from(container.querySelectorAll(selector)).filter(el => el.offsetParent !== null);
  }

  function trapFocus(container, restoreEl) {
    activeFocusTrap = { container, restoreEl: restoreEl || document.activeElement };
    const focusable = getFocusableEls(container);
    if (focusable.length > 0) focusable[0].focus();
  }

  function releaseFocusTrap() {
    if (activeFocusTrap && activeFocusTrap.restoreEl && document.body.contains(activeFocusTrap.restoreEl)) {
      activeFocusTrap.restoreEl.focus();
    }
    activeFocusTrap = null;
  }

  function setupGlobalFocusTrapHandler() {
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab' || !activeFocusTrap) return;
      const focusable = getFocusableEls(activeFocusTrap.container);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      } else if (!activeFocusTrap.container.contains(document.activeElement)) {
        // Focus somehow escaped the trap (e.g. programmatic focus elsewhere) — pull it back in.
        e.preventDefault();
        first.focus();
      }
    });
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
    if (isComposerCollapsible()) {
      openComposerPanel();
    } else {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    inputUrl.focus();
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
        const created = await apiCreate(payload);
        showToast('Node added', 'success');
        form.reset();
        markRecentlyAdded(created.id);
      }
      await refresh();
      if (isComposerCollapsible()) closeComposerPanel();
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
    trapFocus(document.querySelector('#confirmOverlay .confirm-box'));
  }

  function closeConfirm() {
    pendingDeleteId = null;
    confirmOverlay.classList.add('hidden');
    releaseFocusTrap();
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

  const VISIBLE_TAG_COUNT = 4;
  let tagPopoverOpen = false;
  let tagPopoverSearch = '';

  function buildTagChip(tag, count) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'tag-chip' + (activeTagFilters.has(tag) ? ' active' : '');
    chip.setAttribute('aria-pressed', String(activeTagFilters.has(tag)));
    chip.innerHTML = `${escapeHtml(tag)} <span class="tag-count">${count}</span>`;
    chip.addEventListener('click', () => {
      if (activeTagFilters.has(tag)) {
        activeTagFilters.delete(tag);
      } else {
        activeTagFilters.add(tag);
      }
      renderTagFilters();
      resetPaginationAndRender();
    });
    return chip;
  }

  function renderTagFilters() {
    const counts = collectTagCounts();
    const allTags = Array.from(counts.keys()).sort((a, b) => {
      const diff = counts.get(b) - counts.get(a);
      return diff !== 0 ? diff : a.localeCompare(b, 'en');
    });

    filterTagsEl.innerHTML = '';

    // Always show the top N most-used tags, plus any active tag that didn't
    // make the cut — an applied filter should never silently disappear from view.
    const topTags = allTags.slice(0, VISIBLE_TAG_COUNT);
    const topTagSet = new Set(topTags);
    const activeOverflow = allTags.filter(t => activeTagFilters.has(t) && !topTagSet.has(t));
    const visibleTags = [...topTags, ...activeOverflow];
    const remainingTags = allTags.filter(t => !visibleTags.includes(t));

    visibleTags.forEach(tag => {
      filterTagsEl.appendChild(buildTagChip(tag, counts.get(tag)));
    });

    if (remainingTags.length > 0) {
      const moreWrap = document.createElement('div');
      moreWrap.className = 'tag-more-wrap';

      const moreBtn = document.createElement('button');
      moreBtn.type = 'button';
      moreBtn.className = 'tag-chip tag-more-btn';
      moreBtn.setAttribute('aria-haspopup', 'true');
      moreBtn.setAttribute('aria-expanded', String(tagPopoverOpen));
      moreBtn.textContent = `+${remainingTags.length} more`;
      moreBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        tagPopoverOpen = !tagPopoverOpen;
        renderTagFilters();
        if (tagPopoverOpen) {
          const input = filterTagsEl.querySelector('.tag-popover-search');
          if (input) input.focus();
        }
      });
      moreWrap.appendChild(moreBtn);

      if (tagPopoverOpen) {
        moreWrap.appendChild(buildTagPopover(remainingTags, counts));
      }

      filterTagsEl.appendChild(moreWrap);
    }

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

  function buildTagPopover(remainingTags, counts) {
    const popover = document.createElement('div');
    popover.className = 'tag-popover';

    const searchWrap = document.createElement('div');
    searchWrap.className = 'tag-popover-search-wrap';
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'tag-popover-search';
    search.placeholder = 'Filter tags…';
    search.value = tagPopoverSearch;
    search.addEventListener('input', (e) => {
      tagPopoverSearch = e.target.value;
      renderTagFilters();
      const input = filterTagsEl.querySelector('.tag-popover-search');
      if (input) {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
    });
    search.addEventListener('click', (e) => e.stopPropagation());
    searchWrap.appendChild(search);
    popover.appendChild(searchWrap);

    const list = document.createElement('div');
    list.className = 'tag-popover-list';

    const term = tagPopoverSearch.trim().toLowerCase();
    const filtered = term ? remainingTags.filter(t => t.toLowerCase().includes(term)) : remainingTags;

    if (filtered.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'tag-popover-empty';
      empty.textContent = 'No matching tags.';
      list.appendChild(empty);
    } else {
      filtered.forEach(tag => {
        const chip = buildTagChip(tag, counts.get(tag));
        list.appendChild(chip);
      });
    }

    popover.appendChild(list);
    popover.addEventListener('click', (e) => e.stopPropagation());
    return popover;
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

    updateActiveFiltersBar();

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
    // Problem states get a shape marker (▲) in addition to color, so the signal
    // doesn't rely on color alone — helps with color vision differences and low contrast.
    const marker = link.linkStatus === 'ok' ? '<span class="health-dot"></span>' : '<span class="health-mark">▲</span>';

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
          ${marker}${label}
        </button>`;
  }

  function buildCardEl(link) {
    const li = document.createElement('li');
    const isProblem = link.linkStatus === 'broken';
    li.className = 'link-card'
      + (link.favorite ? ' is-favorite' : '')
      + (isProblem ? ' has-problem' : '')
      + (recentlyAddedIds.has(link.id) ? ' is-recent' : '');
    li.dataset.id = link.id;
    li.draggable = sortMode === 'manual';

    const favicon = faviconFor(link.url);
    const tags = link.tags || [];
    const isManual = sortMode === 'manual';

    const healthBadge = buildHealthBadge(link);

    const dragHandle = isManual
      ? `<span class="drag-handle-group">
          <button type="button" class="drag-handle" data-action="move-up" data-id="${link.id}" title="Move up" aria-label="Move ${escapeHtml(link.title)} up">▲</button>
          <span class="drag-handle-icon" aria-hidden="true">⠿</span>
          <button type="button" class="drag-handle" data-action="move-down" data-id="${link.id}" title="Move down" aria-label="Move ${escapeHtml(link.title)} down">▼</button>
        </span>`
      : `<span class="drag-handle-icon drag-handle-idle" aria-hidden="true">⠿</span>`;

    li.innerHTML = `
      ${dragHandle}
      <div class="link-favicon">${favicon ? `<img src="${favicon}" alt="" loading="lazy" onerror="this.parentElement.textContent='◈'">` : '◈'}</div>
      <div class="link-body">
        <div class="link-title-row">
          <a class="link-title" href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer" data-action="preview-target">${escapeHtml(link.title)}</a>
          ${link.favorite ? '<span class="favorite-star" title="Favorite">★</span>' : ''}
        </div>
        <a class="link-url" href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(hostnameFor(link.url))}</a>
        ${link.description ? `<p class="link-notes">${escapeHtml(link.description)}</p>` : ''}
        ${tags.length ? `<div class="link-tags">${tags.map(t => `<button type="button" class="link-tag" data-action="filter-tag" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</button>`).join('')}</div>` : ''}
        <div class="link-footer-row">
          <p class="link-meta">added ${formatDate(link.createdAt)}</p>
          ${healthBadge}
        </div>
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

  function markRecentlyAdded(id) {
    recentlyAddedIds.add(id);
    setTimeout(() => {
      recentlyAddedIds.delete(id);
      const el = linkListEl.querySelector(`.link-card[data-id="${id}"]`);
      if (el) el.classList.remove('is-recent');
    }, 2600);
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
    if ((action === 'move-up' || action === 'move-down') && link) {
      moveNodeManually(id, action === 'move-up' ? -1 : 1, btn);
    }
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
    if (e.key === 'Escape') {
      if (!confirmOverlay.classList.contains('hidden')) closeConfirm();
      else if (!importOverlay.classList.contains('hidden')) closeImportModal();
      else if (!statsOverlay.classList.contains('hidden')) closeStatsModal();
      else if (!duplicatesOverlay.classList.contains('hidden')) closeDuplicatesModal();
      else if (isComposerCollapsible() && composerPanel.classList.contains('is-open')) closeComposerPanel();
    }
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
    syncViewToggleUI();
    renderList();
  }

  function syncViewToggleUI() {
    const isGrid = viewMode === 'grid';
    viewToggleLabel.textContent = isGrid ? 'Grid' : 'List';
    btnToggleView.title = isGrid ? 'Switch to list view' : 'Switch to grid view';
    btnToggleView.setAttribute('aria-pressed', String(isGrid));
    btnToggleView.classList.toggle('is-active-toggle', isGrid);
  }

  function toggleDensity() {
    density = density === 'comfortable' ? 'compact' : 'comfortable';
    try { localStorage.setItem('nodes-density', density); } catch {}
    syncDensityToggleUI();
    renderList();
  }

  function syncDensityToggleUI() {
    const isCompact = density === 'compact';
    densityToggleLabel.textContent = isCompact ? 'Compact' : 'Comfortable';
    btnToggleDensity.title = isCompact ? 'Switch to comfortable density' : 'Switch to compact density';
    btnToggleDensity.setAttribute('aria-pressed', String(isCompact));
    btnToggleDensity.classList.toggle('is-active-toggle', isCompact);
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

  // ---------- Keyboard-accessible manual reordering ----------

  async function moveNodeManually(id, direction, btnEl) {
    // Work against the currently visible, filtered/sorted order so "up/down"
    // matches what the user actually sees on screen.
    const visibleList = getFilteredSorted();
    const idx = visibleList.findIndex(l => l.id === id);
    const targetIdx = idx + direction;
    if (idx === -1 || targetIdx < 0 || targetIdx >= visibleList.length) return;

    const a = visibleList[idx];
    const b = visibleList[targetIdx];

    // Swap their `order` values and push the new order for every visible node,
    // so the rest of the manual sequence stays consistent.
    const swappedOrder = [...visibleList];
    swappedOrder[idx] = b;
    swappedOrder[targetIdx] = a;
    const orderedIds = swappedOrder.map(l => l.id);

    try {
      await apiReorder(orderedIds);
      orderedIds.forEach((linkId, i) => {
        const link = links.find(l => l.id === linkId);
        if (link) link.order = i;
      });
      renderList();
      // Restore focus to the same node's move button so keyboard users don't lose their place.
      const movedBtn = linkListEl.querySelector(`.link-card[data-id="${id}"] [data-action="${direction === -1 ? 'move-up' : 'move-down'}"]`);
      if (movedBtn) movedBtn.focus();
      showToast(`Moved ${direction === -1 ? 'up' : 'down'}`);
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  // ---------- Drag & drop (manual reordering) ----------

  let dragSourceId = null;

  function attachDragHandlers() {
    linkListEl.addEventListener('dragstart', (e) => {
      const card = e.target.closest('.link-card');
      if (!card || sortMode !== 'manual') { e.preventDefault(); return; }
      // Don't start a drag when the user is actually clicking the up/down
      // keyboard-accessible move buttons — those have their own click handler.
      if (e.target.closest('.drag-handle')) { e.preventDefault(); return; }
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
    trapFocus(document.querySelector('#importOverlay .confirm-box'));
  }

  function closeImportModal() {
    importOverlay.classList.add('hidden');
    releaseFocusTrap();
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
    trapFocus(document.querySelector('#statsOverlay .confirm-box'));
    try {
      const stats = await apiStats();
      statsContent.innerHTML = renderStatsHtml(stats);
    } catch (err) {
      statsContent.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    }
  }

  function closeStatsModal() {
    statsOverlay.classList.add('hidden');
    releaseFocusTrap();
  }

  function renderStatsHtml(stats) {
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
    `;
  }

  // ---------- Duplicates ----------

  async function openDuplicatesModal() {
    duplicatesOverlay.classList.remove('hidden');
    duplicatesContent.innerHTML = '<p class="import-hint">Looking for duplicates…</p>';
    trapFocus(document.querySelector('#duplicatesOverlay .confirm-box'));
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
    releaseFocusTrap();
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

  // ---------- Overflow "More actions" menu ----------

  function openMoreMenu() {
    moreMenu.classList.remove('hidden');
    btnMoreMenu.setAttribute('aria-expanded', 'true');
  }

  function closeMoreMenu() {
    moreMenu.classList.add('hidden');
    btnMoreMenu.setAttribute('aria-expanded', 'false');
  }

  function setupMoreMenu() {
    btnMoreMenu.addEventListener('click', (e) => {
      e.stopPropagation();
      if (moreMenu.classList.contains('hidden')) openMoreMenu();
      else closeMoreMenu();
    });

    document.addEventListener('click', (e) => {
      if (!moreMenu.classList.contains('hidden') && !moreMenu.contains(e.target) && e.target !== btnMoreMenu) {
        closeMoreMenu();
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeMoreMenu();
    });
  }

  // ---------- "More tags" popover ----------

  function setupTagPopover() {
    document.addEventListener('click', (e) => {
      if (!tagPopoverOpen) return;
      const wrap = filterTagsEl.querySelector('.tag-more-wrap');
      if (wrap && !wrap.contains(e.target)) {
        tagPopoverOpen = false;
        tagPopoverSearch = '';
        renderTagFilters();
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && tagPopoverOpen) {
        tagPopoverOpen = false;
        tagPopoverSearch = '';
        renderTagFilters();
      }
    });
  }

  // ---------- Clear all filters ----------

  function setupClearFilters() {
    btnClearFilters.addEventListener('click', () => {
      activeTagFilters.clear();
      searchTerm = '';
      searchInput.value = '';
      renderTagFilters();
      resetPaginationAndRender();
    });
  }

  function updateActiveFiltersBar() {
    const parts = [];
    if (searchTerm) parts.push(`search "${searchTerm}"`);
    if (activeTagFilters.size > 0) {
      parts.push(`${activeTagFilters.size} tag${activeTagFilters.size > 1 ? 's' : ''}`);
    }

    if (parts.length === 0) {
      activeFiltersBar.classList.add('hidden');
      return;
    }

    activeFiltersBar.classList.remove('hidden');
    activeFiltersLabel.innerHTML = `Filtering by <strong>${escapeHtml(parts.join(' + '))}</strong>`;
  }

  // ---------- Collapsible composer panel (mobile) ----------

  let composerMediaQuery = null;

  function isComposerCollapsible() {
    return composerMediaQuery ? composerMediaQuery.matches : false;
  }

  function openComposerPanel() {
    composerPanel.classList.add('is-open');
    composerOverlay.classList.remove('hidden');
    requestAnimationFrame(() => composerOverlay.classList.add('is-visible'));
    btnFab.classList.add('is-hidden');
  }

  function closeComposerPanel() {
    composerPanel.classList.remove('is-open');
    composerOverlay.classList.remove('is-visible');
    btnFab.classList.remove('is-hidden');
    setTimeout(() => {
      if (!composerOverlay.classList.contains('is-visible')) composerOverlay.classList.add('hidden');
    }, 200);
  }

  function setupComposerPanel() {
    composerMediaQuery = window.matchMedia('(max-width: 860px)');

    btnFab.addEventListener('click', openComposerPanel);
    btnCloseComposer.addEventListener('click', closeComposerPanel);
    composerOverlay.addEventListener('click', closeComposerPanel);
    btnCancelEdit.addEventListener('click', () => { if (isComposerCollapsible()) closeComposerPanel(); });

    // If the viewport grows past the breakpoint while the sheet is open, just reset state
    composerMediaQuery.addEventListener('change', (e) => {
      if (!e.matches) {
        composerPanel.classList.remove('is-open');
        composerOverlay.classList.add('hidden');
        composerOverlay.classList.remove('is-visible');
        btnFab.classList.remove('is-hidden');
      }
    });
  }

  // ---------- Init ----------

  async function init() {
    let savedTheme = null;
    try { savedTheme = localStorage.getItem('nodes-theme'); } catch {}
    if (savedTheme === 'dark' || savedTheme === null) document.body.dataset.theme = 'dark';

    syncViewToggleUI();
    syncDensityToggleUI();

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

    btnImport.addEventListener('click', () => { closeMoreMenu(); openImportModal(); });
    importClose.addEventListener('click', closeImportModal);
    importCancel.addEventListener('click', closeImportModal);
    importOverlay.addEventListener('click', (e) => { if (e.target === importOverlay) closeImportModal(); });
    tabBookmarks.addEventListener('click', () => switchImportTab('bookmarks'));
    tabJson.addEventListener('click', () => switchImportTab('json'));
    importSubmit.addEventListener('click', handleImportSubmit);

    btnStats.addEventListener('click', () => { closeMoreMenu(); openStatsModal(); });
    statsClose.addEventListener('click', closeStatsModal);
    statsOverlay.addEventListener('click', (e) => { if (e.target === statsOverlay) closeStatsModal(); });

    btnDuplicates.addEventListener('click', () => { closeMoreMenu(); openDuplicatesModal(); });
    duplicatesClose.addEventListener('click', closeDuplicatesModal);
    duplicatesOverlay.addEventListener('click', (e) => { if (e.target === duplicatesOverlay) closeDuplicatesModal(); });

    btnCheckLinks.addEventListener('click', () => { closeMoreMenu(); checkAllLinksNow(); });
    btnToggleDensity.addEventListener('click', toggleDensity);

    setupMoreMenu();
    setupTagPopover();
    setupClearFilters();
    setupComposerPanel();
    setupGlobalFocusTrapHandler();

    await refresh();

    // If a check is already in progress at server startup, show the indicator
    try {
      const { inProgress } = await apiCheckStatus();
      if (inProgress) startCheckPolling();
    } catch {}
  }

  init();
})();
