// ============================================================
// Nós — Gestor de Links
// Persistência: API REST do servidor (Express), guardada em data/links.json
// ============================================================

(() => {
  'use strict';

  const API = '/api/links';

  /** @type {{id:string,url:string,title:string,tags:string[],description:string,favorite:boolean,createdAt:string,updatedAt:string}[]} */
  let links = [];
  let editingId = null;
  let pendingDeleteId = null;

  let activeTagFilters = new Set();
  let tagFilterMode = 'or'; // 'or' = qualquer etiqueta selecionada; 'and' = todas
  let searchTerm = '';
  let sortMode = 'recent';
  let viewMode = 'list';

  try { viewMode = localStorage.getItem('nos-view-mode') || 'list'; } catch {}

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
  const btnExport       = $('#btnExport');

  const confirmOverlay  = $('#confirmOverlay');
  const confirmText     = $('#confirmText');
  const confirmCancel   = $('#confirmCancel');
  const confirmDelete   = $('#confirmDelete');

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
        renderList();
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
        renderList();
      });
      filterTagsEl.appendChild(modeBtn);
    }

    if (activeTagFilters.size > 0) {
      const clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.className = 'tag-clear-btn';
      clearBtn.title = 'Limpar filtro de etiquetas';
      clearBtn.textContent = '✕ limpar';
      clearBtn.addEventListener('click', () => {
        activeTagFilters.clear();
        renderTagFilters();
        renderList();
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

    linkListEl.className = 'link-list ' + (viewMode === 'grid' ? 'view-grid' : '');

    if (links.length === 0) {
      emptyState.classList.add('visible');
      emptyState.querySelector('p').textContent = 'Ainda não há nós na coleção.';
      linkListEl.style.display = 'none';
    } else if (list.length === 0) {
      emptyState.classList.add('visible');
      emptyState.querySelector('p').textContent = 'Nenhum nó corresponde à pesquisa.';
      linkListEl.style.display = 'none';
    } else {
      emptyState.classList.remove('visible');
      linkListEl.style.display = '';

      list.forEach(link => {
        const li = document.createElement('li');
        li.className = 'link-card' + (link.favorite ? ' is-favorite' : '');

        const favicon = faviconFor(link.url);
        const tags = link.tags || [];

        li.innerHTML = `
          <div class="link-favicon">${favicon ? `<img src="${favicon}" alt="" loading="lazy" onerror="this.parentElement.textContent='◈'">` : '◈'}</div>
          <div class="link-body">
            <div class="link-title-row">
              <a class="link-title" href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.title)}</a>
              ${link.favorite ? '<span class="favorite-star">★</span>' : ''}
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
        linkListEl.appendChild(li);
      });
    }

    const tagSummary = activeTagFilters.size > 0
      ? ` · etiquetas: ${Array.from(activeTagFilters).join(tagFilterMode === 'and' ? ' + ' : ' ou ')}`
      : '';
    countLine.textContent = `${list.length} de ${links.length} nós${tagSummary}`;
    footerCount.textContent = links.length;
  }

  function render() {
    renderTagFilters();
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
      renderList();
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
      renderList();
    }, 180);
  });

  sortSelect.addEventListener('change', (e) => {
    sortMode = e.target.value;
    renderList();
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

  // ---------- Init ----------

  async function init() {
    let savedTheme = null;
    try { savedTheme = localStorage.getItem('nos-theme'); } catch {}
    if (savedTheme === 'dark' || savedTheme === null) document.body.dataset.theme = 'dark';

    btnToggleView.textContent = viewMode === 'list' ? '⊞' : '≡';

    await refresh();
  }

  init();
})();
