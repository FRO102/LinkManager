// ============================================================
// Tasks — Link Manager
// Persistence: server REST API (Express), stored in the same SQLite
// database as links/notes, in its own table (tasks).
// ============================================================
//
// Deliberately simpler than notes.js: no tags, no drag-and-drop manual
// ordering (tasks sort by due date automatically), and no separate reading
// modal (a task's content is short enough that clicking it goes straight to
// editing, the way links already work). What's kept: the single add/edit
// modal pattern, unsaved-changes protection, search, sort, and the
// import/export/stats/overflow-menu conventions shared with links and notes.

import { escapeHtml, formatDate } from './js/utils.js';
import { trapFocus, releaseFocusTrap, setupGlobalFocusTrapHandler } from './js/focus-trap.js';
import {
  apiList, apiCreate, apiUpdate, apiDelete, apiBulkDelete, apiImportJson, apiStats,
} from './js/tasks-api.js';

(() => {
  'use strict';

  /** @type {{id:string,title:string,description:string,dueDate:string|null,completed:boolean,order:number,createdAt:string,updatedAt:string}[]} */
  let tasks = [];
  let editingId = null;
  let pendingDeleteId = null;

  let searchTerm = '';
  let sortMode = 'due';
  let showCompleted = false;
  let showOverdueOnly = false;

  // Transparent pagination: the list grows as you approach the end of the
  // page, with no visible page numbers — just an automatic "load more".
  const PAGE_SIZE = 40;
  let visibleCount = PAGE_SIZE;
  const recentlyAddedIds = new Set(); // briefly highlights newly created tasks

  // ---------- DOM refs ----------
  const $ = (sel) => document.querySelector(sel);

  const form            = $('#taskForm');
  const editingIdInput  = $('#editingId');
  const inputTitle      = $('#inputTitle');
  const inputDueDate    = $('#inputDueDate');
  const inputDescription = $('#inputDescription');
  const inputCompleted  = $('#inputCompleted');
  const btnSubmit       = $('#btnSubmit');
  const btnCancelEdit   = $('#btnCancelEdit');
  const formError       = $('#formError');
  const editTaskTitle   = $('#editTaskTitle');

  const fileStatus      = $('#fileStatus');

  const searchInput     = $('#searchInput');
  const sortSelect      = $('#sortSelect');
  const showCompletedInput = $('#showCompleted');
  const showOverdueOnlyInput = $('#showOverdueOnly');
  const countLine       = $('#countLine');
  const footerCount     = $('#footerCount');
  const linkListEl      = $('#linkList');
  const emptyState      = $('#emptyState');
  const toastEl         = $('#toast');
  const btnExport       = $('#btnExport');
  const btnImport       = $('#btnImport');
  const btnStats        = $('#btnStats');
  const btnClearCompleted = $('#btnClearCompleted');
  const btnMoreMenu     = $('#btnMoreMenu');
  const moreMenu        = $('#moreMenu');
  const activeFiltersBar = $('#activeFiltersBar');
  const activeFiltersLabel = $('#activeFiltersLabel');
  const btnClearFilters = $('#btnClearFilters');

  const editTaskOverlay = $('#editTaskOverlay');
  const editTaskClose   = $('#editTaskClose');
  const btnAddTask      = $('#btnAddTask');

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
  const fileJson        = $('#fileJson');

  const statsOverlay    = $('#statsOverlay');
  const statsClose      = $('#statsClose');
  const statsContent    = $('#statsContent');

  // ---------- Utilities ----------
  // escapeHtml/formatDate live in js/utils.js. showToast/setStatus stay here
  // since they close over local DOM refs.

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

  function todayIso() {
    return new Date().toISOString().slice(0, 10);
  }

  function isOverdue(task) {
    return !task.completed && task.dueDate && task.dueDate < todayIso();
  }

  async function exportAsDownload() {
    // Downloads straight from the server's /api/tasks/export rather than
    // re-serializing the in-memory `tasks` array — stays correct even if
    // the client's copy is stale or filtered.
    try {
      const a = document.createElement('a');
      a.href = '/api/tasks/export';
      a.download = 'tasks.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      showToast('.json file downloaded', 'success');
    } catch (err) {
      showToast('Error exporting', 'error');
    }
  }

  // ---------- Unsaved-changes protection ----------
  // Same pattern as notes.js: a task's description can be long enough that
  // losing an in-progress edit to an accidental close is a real annoyance.

  let lastSavedSnapshot = null;

  function getFormSnapshot() {
    return JSON.stringify({
      title: inputTitle.value,
      dueDate: inputDueDate.value,
      description: inputDescription.value,
      completed: inputCompleted.checked,
    });
  }

  function markFormClean() {
    lastSavedSnapshot = getFormSnapshot();
  }

  function hasUnsavedChanges() {
    if (lastSavedSnapshot === null) return false;
    return getFormSnapshot() !== lastSavedSnapshot;
  }

  function confirmDiscardIfDirty() {
    if (!hasUnsavedChanges()) return true;
    return window.confirm('You have unsaved changes to this task. Discard them?');
  }

  window.addEventListener('beforeunload', (e) => {
    if (!hasUnsavedChanges()) return;
    e.preventDefault();
    e.returnValue = '';
  });

  // ---------- Add / edit task modal ----------
  // A single modal used for both creating a new task and editing an
  // existing one — no separate reading view, since a task's content is
  // short enough that clicking it can go straight to editing.

  function openEditTaskModal() {
    editTaskOverlay.classList.remove('hidden');
    trapFocus(document.querySelector('#editTaskOverlay .confirm-box'));
    inputTitle.focus();
  }

  function closeEditTaskModal() {
    editTaskOverlay.classList.add('hidden');
    releaseFocusTrap();
  }

  function requestCloseEditTaskModal() {
    if (!confirmDiscardIfDirty()) return;
    exitEditMode();
    closeEditTaskModal();
  }

  function enterCreateMode() {
    if (!confirmDiscardIfDirty()) return;
    exitEditMode();
    editTaskTitle.textContent = 'Add task';
    btnSubmit.textContent = 'Save task';
    openEditTaskModal();
  }

  function enterEditMode(task) {
    if (!confirmDiscardIfDirty()) return;
    editingId = task.id;
    editingIdInput.value = task.id;
    inputTitle.value = task.title;
    inputDueDate.value = task.dueDate || '';
    inputDescription.value = task.description || '';
    inputCompleted.checked = !!task.completed;
    editTaskTitle.textContent = 'Edit task';
    btnSubmit.textContent = 'Save changes';
    formError.classList.add('hidden');
    markFormClean();
    openEditTaskModal();
  }

  function exitEditMode() {
    editingId = null;
    editingIdInput.value = '';
    form.reset();
    formError.classList.add('hidden');
    markFormClean();
  }

  async function handleSubmit(e) {
    e.preventDefault();
    formError.classList.add('hidden');

    const title = inputTitle.value.trim();
    if (!title) {
      formError.textContent = 'Title is required.';
      formError.classList.remove('hidden');
      return;
    }

    const payload = {
      title,
      dueDate: inputDueDate.value || null,
      description: inputDescription.value,
      completed: inputCompleted.checked,
    };

    btnSubmit.disabled = true;
    try {
      if (editingId) {
        const updated = await apiUpdate(editingId, payload);
        showToast('Task updated', 'success');
        markFormClean();
        exitEditMode();
        await refreshAfterMutation(updated, 'upsert');
      } else {
        const created = await apiCreate(payload);
        showToast('Task added', 'success');
        form.reset();
        markFormClean();
        markRecentlyAdded(created.id);
        await refreshAfterMutation(created, 'upsert');
      }
      closeEditTaskModal();
    } catch (err) {
      formError.textContent = err.message;
      formError.classList.remove('hidden');
    } finally {
      btnSubmit.disabled = false;
    }
  }

  function openConfirm(task) {
    pendingDeleteId = task.id;
    confirmText.textContent = `Are you sure you want to remove "${task.title}"? This action cannot be undone.`;
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
    const task = tasks.find(t => t.id === pendingDeleteId);
    try {
      await apiDelete(pendingDeleteId);
      if (editingId === pendingDeleteId) {
        exitEditMode();
        closeEditTaskModal();
      }
      showToast(`"${task ? task.title : 'Task'}" removed`);
      await refreshAfterMutation(pendingDeleteId, 'remove');
      closeConfirm();
    } catch (err) {
      showToast(err.message, 'error');
      closeConfirm();
    }
  }

  async function toggleCompleted(id) {
    const task = tasks.find(t => t.id === id);
    if (!task) return;
    try {
      const updated = await apiUpdate(id, { completed: !task.completed });
      // A completed task may need to disappear from the current view
      // entirely (completed tasks are hidden by default), so this always
      // goes through a full refresh rather than a local upsert.
      showToast(updated.completed ? 'Task completed' : 'Task reopened');
      await refresh();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  // ---------- Data loading ----------
  // Unlike notes/links (which filter client-side after loading everything),
  // the completed/overdue filters go to the server — the "hide completed by
  // default" behavior in particular is meant to keep the fetched set small
  // as completed tasks pile up over time, not just hide them in the DOM.

  function currentQueryParams() {
    const params = {};
    if (showOverdueOnly) params.overdue = 'true';
    else if (showCompleted) params.completed = 'all';
    // else: default server-side behavior already hides completed tasks
    if (searchTerm) params.q = searchTerm;
    return params;
  }

  async function refresh() {
    try {
      tasks = await apiList(currentQueryParams());
      setStatus('connected', 'Connected to server');
      render();
    } catch (err) {
      setStatus('error', 'Connection failed');
      showToast('Could not reach the server', 'error');
    }
  }

  // After a create/update/delete, the mutated task may or may not still
  // belong in the current filtered view (e.g. it just got marked completed
  // while "Show completed" is off) — simplest correct behavior is a full
  // refetch with the active filters rather than trying to patch local state
  // and guess whether it should still be visible.
  async function refreshAfterMutation() {
    await refresh();
  }

  // ---------- Rendering ----------

  function getFilteredSorted() {
    let list = tasks.slice();

    switch (sortMode) {
      case 'recent':
        list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        break;
      case 'az':
        list.sort((a, b) => a.title.localeCompare(b.title, 'en'));
        break;
      case 'due':
      default:
        // Server already returns this order; re-sorting client-side keeps
        // it stable if the array was mutated locally between refreshes.
        list.sort((a, b) => {
          if (!a.dueDate && !b.dueDate) return new Date(b.createdAt) - new Date(a.createdAt);
          if (!a.dueDate) return 1;
          if (!b.dueDate) return -1;
          return a.dueDate.localeCompare(b.dueDate);
        });
        break;
    }

    return list;
  }

  function renderList() {
    const list = getFilteredSorted();

    updateActiveFiltersBar();

    linkListEl.innerHTML = '';

    if (tasks.length === 0) {
      emptyState.classList.add('visible');
      emptyState.querySelector('p').textContent = 'No tasks yet.';
      linkListEl.style.display = 'none';
      updateCountLine(list.length);
      return;
    }

    if (list.length === 0) {
      emptyState.classList.add('visible');
      emptyState.querySelector('p').textContent = 'No task matches your search.';
      linkListEl.style.display = 'none';
      updateCountLine(list.length);
      return;
    }

    emptyState.classList.remove('visible');
    linkListEl.style.display = '';

    const slice = list.slice(0, visibleCount);
    slice.forEach(task => {
      linkListEl.appendChild(buildCardEl(task));
    });

    updateCountLine(list.length);
  }

  function updateCountLine(filteredTotal) {
    const shown = Math.min(visibleCount, filteredTotal);
    countLine.textContent = `${shown} of ${filteredTotal} task${filteredTotal === 1 ? '' : 's'}`;
    footerCount.textContent = tasks.length;
  }

  function descriptionPreview(description, maxLen = 160) {
    const collapsed = (description || '').replace(/\s+/g, ' ').trim();
    if (collapsed.length <= maxLen) return collapsed;
    return collapsed.slice(0, maxLen).trimEnd() + '…';
  }

  function dueDateLabel(task) {
    if (!task.dueDate) return '';
    const overdue = isOverdue(task);
    const label = formatDate(task.dueDate);
    return `<span class="task-due-date${overdue ? ' is-overdue' : ''}">${overdue ? '⚠ overdue — ' : ''}due ${escapeHtml(label)}</span>`;
  }

  function buildCardEl(task) {
    const li = document.createElement('li');
    li.className = 'link-card task-card'
      + (task.completed ? ' is-completed' : '')
      + (isOverdue(task) ? ' is-overdue' : '')
      + (recentlyAddedIds.has(task.id) ? ' is-recent' : '');
    li.dataset.id = task.id;

    li.innerHTML = `
      <label class="task-checkbox-wrap">
        <input type="checkbox" class="task-checkbox" data-action="toggle-completed" data-id="${task.id}" ${task.completed ? 'checked' : ''} aria-label="Mark ${escapeHtml(task.title)} as ${task.completed ? 'not completed' : 'completed'}">
      </label>
      <div class="link-body">
        <div class="link-title-row">
          <button type="button" class="link-title" data-action="edit" data-id="${task.id}">${escapeHtml(task.title)}</button>
        </div>
        ${task.description ? `<p class="link-notes">${escapeHtml(descriptionPreview(task.description))}</p>` : ''}
        <div class="link-footer-row">
          ${task.dueDate ? dueDateLabel(task) : '<span class="link-meta">no due date</span>'}
        </div>
      </div>
      <div class="link-actions">
        <button class="icon-btn" title="Edit" data-action="edit" data-id="${task.id}">✎</button>
        <button class="icon-btn danger" title="Remove" data-action="delete" data-id="${task.id}">✕</button>
      </div>
    `;
    return li;
  }

  function render() {
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
  btnCancelEdit.addEventListener('click', requestCloseEditTaskModal);

  linkListEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const { action, id } = btn.dataset;
    const task = tasks.find(t => t.id === id);
    if (action === 'delete' && task) openConfirm(task);
    if (action === 'edit' && task) enterEditMode(task);
  });

  linkListEl.addEventListener('change', (e) => {
    const checkbox = e.target.closest('input[data-action="toggle-completed"]');
    if (!checkbox) return;
    toggleCompleted(checkbox.dataset.id);
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
    searchDebounce = setTimeout(async () => {
      searchTerm = value;
      resetPaginationAndRender();
      await refresh();
    }, 250);
  });

  sortSelect.addEventListener('change', (e) => {
    sortMode = e.target.value;
    resetPaginationAndRender();
  });

  showCompletedInput.addEventListener('change', async (e) => {
    showCompleted = e.target.checked;
    if (showCompleted) showOverdueOnlyInput.checked = showOverdueOnly = false;
    resetPaginationAndRender();
    await refresh();
  });

  showOverdueOnlyInput.addEventListener('change', async (e) => {
    showOverdueOnly = e.target.checked;
    if (showOverdueOnly) showCompletedInput.checked = showCompleted = false;
    resetPaginationAndRender();
    await refresh();
  });

  btnExport.addEventListener('click', () => { closeMoreMenu(); exportAsDownload(); });
  $('#btnToggleTheme').addEventListener('click', toggleTheme);

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!confirmOverlay.classList.contains('hidden')) closeConfirm();
      else if (!importOverlay.classList.contains('hidden')) closeImportModal();
      else if (!statsOverlay.classList.contains('hidden')) closeStatsModal();
      else if (!editTaskOverlay.classList.contains('hidden')) requestCloseEditTaskModal();
    }
    if (e.key === '/' &&
        document.activeElement !== inputTitle &&
        document.activeElement !== inputDescription &&
        document.activeElement !== searchInput) {
      e.preventDefault();
      searchInput.focus();
    }
  });

  // ---------- Theme ----------
  // Shares the "nodes-theme" localStorage key with links/notes on purpose,
  // so the light/dark choice is consistent across all three pages.

  function toggleTheme() {
    const isDark = document.body.dataset.theme === 'dark';
    document.body.dataset.theme = isDark ? '' : 'dark';
    try { localStorage.setItem('nodes-theme', isDark ? 'light' : 'dark'); } catch {}
  }

  // ---------- Import ----------

  function openImportModal() {
    importOverlay.classList.remove('hidden');
    importError.classList.add('hidden');
    importResult.classList.add('hidden');
    fileJson.value = '';
    trapFocus(document.querySelector('#importOverlay .confirm-box'));
  }

  function closeImportModal() {
    importOverlay.classList.add('hidden');
    releaseFocusTrap();
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
    importSubmit.disabled = true;

    try {
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
      if (!items) throw new Error('Unexpected format — expected an array of tasks.');
      const result = await apiImportJson(items);
      importResult.textContent = `${result.imported} task(s) imported, ${result.skipped} already existed, ${result.invalid} invalid.`;
      importResult.classList.remove('hidden');
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
          <div class="stat-label">Total tasks</div>
        </div>
        <div class="stat-tile">
          <div class="stat-value">${stats.outstanding}</div>
          <div class="stat-label">Outstanding</div>
        </div>
        <div class="stat-tile">
          <div class="stat-value">${stats.completed}</div>
          <div class="stat-label">Completed</div>
        </div>
        <div class="stat-tile${stats.overdue > 0 ? ' stat-broken' : ''}">
          <div class="stat-value">${stats.overdue}</div>
          <div class="stat-label">Overdue</div>
        </div>
      </div>
    `;
  }

  // ---------- Clear completed ----------

  async function clearCompleted() {
    closeMoreMenu();
    try {
      const completedRes = await apiList({ completed: 'true' });
      if (completedRes.length === 0) {
        showToast('No completed tasks to clear');
        return;
      }
      if (!window.confirm(`Remove ${completedRes.length} completed task(s)? This cannot be undone.`)) return;
      const result = await apiBulkDelete(completedRes.map(t => t.id));
      showToast(`${result.deleted} completed task(s) removed`, 'success');
      await refresh();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

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

  // ---------- Clear all filters ----------

  function setupClearFilters() {
    btnClearFilters.addEventListener('click', async () => {
      searchTerm = '';
      searchInput.value = '';
      showCompleted = false;
      showCompletedInput.checked = false;
      showOverdueOnly = false;
      showOverdueOnlyInput.checked = false;
      resetPaginationAndRender();
      await refresh();
    });
  }

  function updateActiveFiltersBar() {
    const parts = [];
    if (searchTerm) parts.push(`search "${searchTerm}"`);
    if (showOverdueOnly) parts.push('overdue only');
    else if (showCompleted) parts.push('showing completed');

    if (parts.length === 0) {
      activeFiltersBar.classList.add('hidden');
      return;
    }

    activeFiltersBar.classList.remove('hidden');
    activeFiltersLabel.innerHTML = `Filtering by <strong>${escapeHtml(parts.join(' + '))}</strong>`;
  }

  // ---------- Init ----------

  async function init() {
    let savedTheme = null;
    try { savedTheme = localStorage.getItem('nodes-theme'); } catch {}
    if (savedTheme === 'dark' || savedTheme === null) document.body.dataset.theme = 'dark';

    markFormClean();

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
    importSubmit.addEventListener('click', handleImportSubmit);

    btnStats.addEventListener('click', () => { closeMoreMenu(); openStatsModal(); });
    statsClose.addEventListener('click', closeStatsModal);
    statsOverlay.addEventListener('click', (e) => { if (e.target === statsOverlay) closeStatsModal(); });

    btnClearCompleted.addEventListener('click', clearCompleted);

    btnAddTask.addEventListener('click', enterCreateMode);
    editTaskClose.addEventListener('click', requestCloseEditTaskModal);
    editTaskOverlay.addEventListener('click', (e) => { if (e.target === editTaskOverlay) requestCloseEditTaskModal(); });

    setupMoreMenu();
    setupClearFilters();
    setupGlobalFocusTrapHandler();

    await refresh();
  }

  init();
})();
