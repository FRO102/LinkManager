// ============================================================
// Nós — Gestor de Links
// Persistência: API REST do servidor (Express), guardada em data/links.json
// ============================================================

(() => {
  'use strict';

  const API = '/api/links';

  /** @type {{id:string,url:string,title:string,tags:string[],description:string,favorite:boolean,order:number,linkStatus:string|null,linkStatusCode:number|null,lastCheckedAt:string|null,createdAt:string,updatedAt:string}[]} */
  let links = [];
  let editingId = null;
  let pendingDeleteId = null;

  let activeTagFilters = new Set();
  let tagFilterMode = 'or'; // 'or' = qualquer etiqueta selecionada; 'and' = todas
  let searchTerm = '';
  let sortMode = 'recent';
  let viewMode = 'list';
  let density = 'comfortable';

  // Paginação transparente: a lista cresce conforme se aproxima do fim da página,
  // sem números de página visíveis — apenas um "carregar mais" automático.
  const PAGE_SIZE = 40;
  let visibleCount = PAGE_SIZE;
  let renderedIds = []; // IDs atualmente na DOM, na ordem — usado pelo drag & drop

  try { viewMode = localStorage.getItem('nos-view-mode') || 'list'; } catch {}
  try { density = localStorage.getItem('nos-density') || 'comfortable'; } catch {}

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
      return d.toLocaleDateString('pt-PT', { day: '2-digit', month: 'short', year: 'numeric' });
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
    if (mins < 1) return 'agora mesmo';
    if (mins < 60) return `há ${mins} min`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `há ${hours}h`;
    const days = Math.round(hours / 24);
    return `há ${days}d`;
  }

  // ---------- API ----------

  async function apiList() {
    const res = await fetch(API);
    if (!res.ok) throw new Error('Falha ao carregar');
    return res.json();
  }

  async function apiCreate(payload) {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erro ao criar nó');
    return data;
  }

  async function apiUpdate(id, payload) {
    const res = await fetch(`${API}/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erro ao atualizar nó');
    return data;
  }

  async function apiDelete(id) {
    const res = await fetch(`${API}/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Erro ao remover nó');
    }
  }

  async function apiReorder(orderedIds) {
    const res = await fetch(`${API}/reorder`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderedIds }),
    });
    if (!res.ok) throw new Error('Erro ao guardar nova ordem');
  }

  async function apiCheckOne(id) {
    const res = await fetch(`${API}/${id}/check`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erro ao verificar link');
    return data;
  }

  async function apiCheckAll() {
    const res = await fetch(`${API}/check-all`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erro ao verificar links');
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
    if (!res.ok) throw new Error(data.error || 'Erro ao importar bookmarks');
    return data;
  }

  async function apiImportJson(items, defaultTags) {
    const res = await fetch('/api/import/json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items, defaultTags }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erro ao importar ficheiro');
    return data;
  }

  async function apiStats() {
    const res = await fetch('/api/stats');
    if (!res.ok) throw new Error('Erro ao obter estatísticas');
    return res.json();
  }

  async function apiDuplicates() {
    const res = await fetch('/api/duplicates');
    if (!res.ok) throw new Error('Erro ao obter duplicados');
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
    showToast('Ficheiro .json descarregado', 'success');
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
    composerTitle.textContent = '01 — Editar nó';
    btnSubmit.textContent = 'Guardar alterações';
    btnCancelEdit.classList.remove('hidden');
    formError.classList.add('hidden');
    inputUrl.focus();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function exitEditMode() {
    editingId = null;
    editingIdInput.value = '';
    form.reset();
    composerTitle.textContent = '01 — Adicionar nó';
    btnSubmit.textContent = 'Guardar nó';
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
      formError.textContent = 'Endereço inválido.';
      formError.classList.remove('hidden');
      return;
    }

    // Deteção de duplicados — só ao criar, não ao editar o próprio nó
    if (!editingId) {
      try {
        const dupRes = await fetch(`${API}/check-duplicate?url=${encodeURIComponent(url)}`);
        const dupData = await dupRes.json();
        if (dupData.duplicate) {
          const proceed = window.confirm(
            `Já tens um nó com este endereço: "${dupData.existing.title}".\n\nQueres guardar mesmo assim?`
          );
          if (!proceed) return;
        }
      } catch {
        // Se a verificação falhar, não bloqueia o fluxo — segue em frente
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
        showToast('Nó atualizado', 'success');
        exitEditMode();
      } else {
        await apiCreate(payload);
        showToast('Nó adicionado', 'success');
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
    confirmText.textContent = `Tens a certeza que queres remover "${link.title}"? Esta ação não pode ser desfeita.`;
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
      showToast(`"${link ? link.title : 'Nó'}" removido`);
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
      setStatus('connected', 'Ligado ao servidor');
      render();
    } catch (err) {
      setStatus('error', 'Falha na ligação');
      showToast('Não foi possível contactar o servidor', 'error');
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
      return diff !== 0 ? diff : a.localeCompare(b, 'pt');
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

    // Controlo de modo AND/OR — só relevante com 2+ etiquetas selecionadas
    if (activeTagFilters.size > 1) {
      const modeBtn = document.createElement('button');
      modeBtn.type = 'button';
      modeBtn.className = 'tag-mode-btn';
      modeBtn.title = tagFilterMode === 'or'
        ? 'A mostrar nós com qualquer uma das etiquetas — clica para exigir todas'
        : 'A mostrar nós com todas as etiquetas — clica para aceitar qualquer uma';
      modeBtn.textContent = tagFilterMode === 'or' ? 'qualquer uma' : 'todas';
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
      clearBtn.title = 'Limpar filtro de tags';
      clearBtn.textContent = '✕ limpar';
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
        list.sort((a, b) => a.title.localeCompare(b.title, 'pt'));
        break;
      case 'za':
        list.sort((a, b) => b.title.localeCompare(a.title, 'pt'));
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
      emptyState.querySelector('p').textContent = 'Ainda não há nós na coleção.';
      linkListEl.style.display = 'none';
      renderedIds = [];
      updateCountLine(list.length);
      return;
    }

    if (list.length === 0) {
      emptyState.classList.add('visible');
      emptyState.querySelector('p').textContent = 'Nenhum nó corresponde à pesquisa.';
      linkListEl.style.display = 'none';
      renderedIds = [];
      updateCountLine(list.length);
      return;
    }

    emptyState.classList.remove('visible');
    linkListEl.style.display = '';

    // Paginação transparente: só renderiza os primeiros `visibleCount`.
    // Mais itens entram automaticamente ao aproximar-se do fim (ver observer no init).
    const slice = list.slice(0, visibleCount);
    renderedIds = slice.map(l => l.id);

    slice.forEach(link => {
      linkListEl.appendChild(buildCardEl(link));
    });

    updateCountLine(list.length);
  }

  function updateCountLine(filteredTotal) {
    const tagSummary = activeTagFilters.size > 0
      ? ` · etiquetas: ${Array.from(activeTagFilters).join(tagFilterMode === 'and' ? ' + ' : ' ou ')}`
      : '';
    const shown = Math.min(visibleCount, filteredTotal);
    countLine.textContent = `${shown} de ${filteredTotal} nós${tagSummary}`;
    footerCount.textContent = links.length;
  }

  function buildCardEl(link) {
    const li = document.createElement('li');
    li.className = 'link-card' + (link.favorite ? ' is-favorite' : '');
    li.dataset.id = link.id;
    li.draggable = sortMode === 'manual';

    const favicon = faviconFor(link.url);
    const tags = link.tags || [];

    const healthBadge = link.linkStatus
      ? `<button type="button" class="link-health-badge" data-status="${link.linkStatus}" data-action="check-one" data-id="${link.id}" title="${link.linkStatus === 'ok' ? 'Link acessível' : 'Link pode estar em baixo'}${link.linkStatusCode ? ' (HTTP ' + link.linkStatusCode + ')' : ''} · verificado ${timeAgo(link.lastCheckedAt) || ''} · clica para verificar de novo">
          <span class="health-dot"></span>${link.linkStatus === 'ok' ? 'ok' : 'quebrado'}
        </button>`
      : `<button type="button" class="link-health-badge" data-status="unchecked" data-action="check-one" data-id="${link.id}" title="Ainda não verificado — clica para verificar">
          <span class="health-dot"></span>por verificar
        </button>`;

    li.innerHTML = `
      <span class="drag-handle" title="Arrastar para reordenar">⠿</span>
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
        <p class="link-meta">adicionado em ${formatDate(link.createdAt)}</p>
      </div>
      <div class="link-actions">
        <button class="icon-btn fav-btn${link.favorite ? ' active' : ''}" title="Alternar favorito" data-action="favorite" data-id="${link.id}">★</button>
        <button class="icon-btn" title="Copiar URL" data-action="copy" data-id="${link.id}">⧉</button>
        <button class="icon-btn" title="Editar" data-action="edit" data-id="${link.id}">✎</button>
        <button class="icon-btn danger" title="Remover" data-action="delete" data-id="${link.id}">✕</button>
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
      navigator.clipboard.writeText(link.url).then(() => showToast('URL copiado!'));
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
    try { localStorage.setItem('nos-theme', isDark ? 'light' : 'dark'); } catch {}
  }

  function toggleView() {
    viewMode = viewMode === 'list' ? 'grid' : 'list';
    try { localStorage.setItem('nos-view-mode', viewMode); } catch {}
    btnToggleView.textContent = viewMode === 'list' ? '⊞' : '≡';
    renderList();
  }

  function toggleDensity() {
    density = density === 'comfortable' ? 'compact' : 'comfortable';
    try { localStorage.setItem('nos-density', density); } catch {}
    renderList();
  }

  // ---------- Verificação de links mortos ----------

  async function checkOneLink(link, btnEl) {
    const original = btnEl.innerHTML;
    btnEl.disabled = true;
    btnEl.innerHTML = '<span class="health-dot"></span>a verificar…';
    try {
      const updated = await apiCheckOne(link.id);
      const idx = links.findIndex(l => l.id === link.id);
      if (idx !== -1) links[idx] = updated;
      renderList();
      showToast(updated.linkStatus === 'ok' ? 'Link acessível' : 'Link parece estar em baixo', updated.linkStatus === 'ok' ? 'success' : 'error');
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
        showToast('Já há uma verificação em curso', 'error');
        startCheckPolling();
        return;
      }
    } catch {}

    btnCheckLinks.disabled = true;
    checkProgress.classList.remove('hidden');
    checkProgressText.textContent = 'A verificar links…';

    try {
      await apiCheckAll();
      await refresh();
      showToast('Verificação concluída', 'success');
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

  // ---------- Drag & drop (reordenar manualmente) ----------

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

      // Reordena renderedIds localmente para feedback imediato
      const fromIdx = renderedIds.indexOf(dragSourceId);
      let toIdx = renderedIds.indexOf(targetCard.dataset.id);
      if (fromIdx === -1 || toIdx === -1) return;

      renderedIds.splice(fromIdx, 1);
      toIdx = renderedIds.indexOf(targetCard.dataset.id);
      renderedIds.splice(isAfter ? toIdx + 1 : toIdx, 0, dragSourceId);

      // Re-renderiza a lista visível na nova ordem imediatamente
      linkListEl.innerHTML = '';
      renderedIds.forEach(id => {
        const link = links.find(l => l.id === id);
        if (link) linkListEl.appendChild(buildCardEl(link));
      });

      try {
        await apiReorder(renderedIds);
        // Atualiza o campo `order` localmente para refletir a nova posição
        renderedIds.forEach((id, i) => {
          const link = links.find(l => l.id === id);
          if (link) link.order = i;
        });
      } catch (err) {
        showToast('Erro ao guardar ordem — a recarregar', 'error');
        await refresh();
      }
    });
  }

  // ---------- Preview on-hover (Open Graph) ----------

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
      if (myToken !== previewRequestToken) return; // já mudou de alvo — ignora resposta antiga

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
    previewRequestToken++; // invalida qualquer pedido pendente
    linkPreviewEl.classList.remove('visible');
    setTimeout(() => {
      if (!linkPreviewEl.classList.contains('visible')) linkPreviewEl.classList.add('hidden');
    }, 150);
  }

  // ---------- Importação ----------

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
      reader.onerror = () => reject(new Error('Não foi possível ler o ficheiro'));
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
        if (!file) throw new Error('Escolhe um ficheiro .html de bookmarks primeiro.');
        const html = await readFileAsText(file);
        const defaultTags = importTagsBookmarks.value.split(',').map(t => t.trim()).filter(Boolean);
        const result = await apiImportBookmarks(html, defaultTags);
        importResult.textContent = `${result.imported} nó(s) importado(s), ${result.skipped} já existia(m).`;
        importResult.classList.remove('hidden');
      } else {
        const file = fileJson.files[0];
        if (!file) throw new Error('Escolhe um ficheiro .json primeiro.');
        const raw = await readFileAsText(file);
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw new Error('O ficheiro não é um JSON válido.');
        }
        const items = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.items) ? parsed.items : null);
        if (!items) throw new Error('Formato inesperado — esperava um array de links.');
        const defaultTags = importTagsJson.value.split(',').map(t => t.trim()).filter(Boolean);
        const result = await apiImportJson(items, defaultTags);
        importResult.textContent = `${result.imported} nó(s) importado(s), ${result.skipped} já existia(m), ${result.invalid} inválido(s).`;
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

  // ---------- Estatísticas ----------

  async function openStatsModal() {
    statsOverlay.classList.remove('hidden');
    statsContent.innerHTML = '<p class="import-hint">A carregar…</p>';
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
    `).join('') || '<p class="import-hint">Ainda sem tags.</p>';

    const domainBars = stats.topDomains.map(d => `
      <div class="stat-bar-row">
        <span class="stat-bar-label" title="${escapeHtml(d.domain)}">${escapeHtml(d.domain)}</span>
        <span class="stat-bar-track"><span class="stat-bar-fill" style="width:${(d.count / maxDomain) * 100}%"></span></span>
        <span class="stat-bar-count">${d.count}</span>
      </div>
    `).join('') || '<p class="import-hint">Sem dados.</p>';

    return `
      <div class="stats-grid">
        <div class="stat-tile">
          <div class="stat-value">${stats.total}</div>
          <div class="stat-label">Total de links</div>
        </div>
        <div class="stat-tile">
          <div class="stat-value">${stats.favorites}</div>
          <div class="stat-label">Favoritos</div>
        </div>
        <div class="stat-tile">
          <div class="stat-value">${stats.totalTags}</div>
          <div class="stat-label">Tags</div>
        </div>
        <div class="stat-tile">
          <div class="stat-value">${stats.linkHealth.ok}</div>
          <div class="stat-label">Online</div>
        </div>
        <div class="stat-tile stat-broken">
          <div class="stat-value">${stats.linkHealth.broken}</div>
          <div class="stat-label">Offline</div>
        </div>
      </div>

      <div class="stats-section">
        <h4>Tags mais usadas</h4>
        ${tagBars}
      </div>

      <div class="stats-section">
        <h4>Domínios mais guardados</h4>
        ${domainBars}
      </div>
    `;
  }

  // ---------- Duplicados ----------

  async function openDuplicatesModal() {
    duplicatesOverlay.classList.remove('hidden');
    duplicatesContent.innerHTML = '<p class="import-hint">A procurar duplicados…</p>';
    try {
      const groups = await apiDuplicates();
      if (groups.length === 0) {
        duplicatesContent.innerHTML = '<p class="import-hint">Nenhum nó duplicado encontrado. 🎉</p>';
        return;
      }
      duplicatesContent.innerHTML = groups.map(group => `
        <div class="duplicate-group">
          <p class="duplicate-group-url">${escapeHtml(group[0].url)}</p>
          ${group.map(l => `
            <div class="duplicate-item">
              <span class="duplicate-item-title">${escapeHtml(l.title)}</span>
              <span class="duplicate-item-date">${formatDate(l.createdAt)}</span>
              <button class="icon-btn danger" data-action="delete-duplicate" data-id="${l.id}" title="Remover este">✕</button>
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
      showToast('Nó removido', 'success');
      await refresh();
      await openDuplicatesModal();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // ---------- Init ----------

  async function init() {
    let savedTheme = null;
    try { savedTheme = localStorage.getItem('nos-theme'); } catch {}
    if (savedTheme === 'dark' || savedTheme === null) document.body.dataset.theme = 'dark';

    btnToggleView.textContent = viewMode === 'list' ? '⊞' : '≡';

    attachDragHandlers();
    setupPreviewHover();

    // Scroll infinito simples: observa o fim da página em vez de um sentinel por item,
    // suficiente para a maioria dos ecrãs e evita reconstruir o observer a cada render.
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

    // Se já houver uma verificação em curso no arranque do servidor, mostra o indicador
    try {
      const { inProgress } = await apiCheckStatus();
      if (inProgress) startCheckPolling();
    } catch {}
  }

  init();
})();
