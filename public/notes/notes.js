// ============================================================
// Notes — Link Manager
// Persistence: server REST API (Express), stored in the same SQLite
// database as links, in separate tables (notes, note_tags_catalog, note_tags).
// ============================================================
//
// This mirrors public/app.js's structure closely on purpose — same shared-
// state pattern, same reasoning for keeping it as one module — but drops
// everything that only makes sense for a URL bookmark: address field,
// favicon, dead-link checking, Open Graph preview, and duplicate detection
// (notes have no natural unique key to detect duplicates by). What's left
// (composer, tag filters, search, sort, drag-to-reorder, import/export,
// stats) behaves the same way it does for links.

import { escapeHtml, formatDate, timeAgo } from './js/utils.js';
import { trapFocus, releaseFocusTrap, setupGlobalFocusTrapHandler } from './js/focus-trap.js';
import {
  apiList, apiCreate, apiUpdate, apiDelete, apiBulkDelete, apiReorder,
  apiImportJson, apiStats,
} from './js/notes-api.js';

(() => {
  'use strict';

  /** @type {{id:string,title:string,content:string,tags:string[],favorite:boolean,order:number,createdAt:string,updatedAt:string}[]} */
  let notes = [];
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
  const recentlyAddedIds = new Set(); // briefly highlights newly created notes

  // Shares the same localStorage keys as the links page for theme, so
  // switching between Nodes and Notes keeps a consistent light/dark choice.
  // View mode and density are kept separate (notes-*) since a note card's
  // ideal density may differ from a link card's.
  try { viewMode = localStorage.getItem('notes-view-mode') || 'list'; } catch {}
  try { density = localStorage.getItem('notes-density') || 'comfortable'; } catch {}

  // ---------- DOM refs ----------
  const $ = (sel) => document.querySelector(sel);

  const form           = $('#noteForm');
  const editingIdInput = $('#editingId');
  const inputTitle      = $('#inputTitle');
  const inputTags       = $('#inputTags');
  const inputContent    = $('#inputContent');
  const inputFavorite   = $('#inputFavorite');
  const btnSubmit       = $('#btnSubmit');
  const btnCancelEdit   = $('#btnCancelEdit');
  const formError       = $('#formError');
  const editNoteTitle   = $('#editNoteTitle');

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
  const btnMoreMenu     = $('#btnMoreMenu');
  const moreMenu        = $('#moreMenu');
  const activeFiltersBar = $('#activeFiltersBar');
  const activeFiltersLabel = $('#activeFiltersLabel');
  const btnClearFilters = $('#btnClearFilters');

  const editNoteOverlay = $('#editNoteOverlay');
  const editNoteClose   = $('#editNoteClose');
  const btnAddNote      = $('#btnAddNote');

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
  const importTagsJson  = $('#importTagsJson');

  const statsOverlay    = $('#statsOverlay');
  const statsClose      = $('#statsClose');
  const statsContent    = $('#statsContent');

  const viewNoteOverlay  = $('#viewNoteOverlay');
  const viewNoteClose    = $('#viewNoteClose');
  const viewNoteTitle    = $('#viewNoteTitle');
  const viewNoteMeta     = $('#viewNoteMeta');
  const viewNoteTags     = $('#viewNoteTags');
  const viewNoteBody     = $('#viewNoteBody');
  const viewNoteFavorite = $('#viewNoteFavorite');
  const viewNoteDelete   = $('#viewNoteDelete');
  const viewNoteEdit     = $('#viewNoteEdit');
  const viewNoteExportTxt = $('#viewNoteExportTxt');
  const viewNotePrev     = $('#viewNotePrev');
  const viewNoteNext     = $('#viewNoteNext');
  const viewNotePosition = $('#viewNotePosition');
  const contentCounter   = $('#contentCounter');

  let viewingId = null; // id of the note currently open in the reading modal, if any

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

  async function exportAsDownload() {
    // Downloads straight from the server's /api/notes/export rather than
    // re-serializing the in-memory `notes` array — stays correct even if the
    // client's copy is stale, since the list view is paginated client-side.
    try {
      const a = document.createElement('a');
      a.href = '/api/notes/export';
      a.download = 'notes.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      showToast('.json file downloaded', 'success');
    } catch (err) {
      showToast('Error exporting', 'error');
    }
  }

  // Turns a note title into a filesystem-safe filename stem: lowercases,
  // replaces anything that isn't a letter/number/hyphen with a hyphen, and
  // collapses/trims repeats — "Deploy: staging vs. prod!" -> "deploy-staging-vs-prod".
  function slugifyForFilename(title) {
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return slug || 'note';
  }

  // Exports a single note as a plain-text file — unlike the JSON export
  // above (the whole collection, for backup/re-import), this is meant to be
  // read or shared outside the app: a plain, human-readable .txt with the
  // title, tags, and dates as a small header, unlike the JSON export.
  // Built entirely client-side (no server round-trip) since the view modal
  // already holds the full note data.
  function exportNoteAsTxt(note) {
    const lines = [note.title, '='.repeat(note.title.length), ''];
    if (note.tags && note.tags.length) lines.push(`Tags: ${note.tags.join(', ')}`);
    lines.push(`Created: ${formatDate(note.createdAt)}`);
    if (note.updatedAt && note.updatedAt !== note.createdAt) {
      lines.push(`Updated: ${formatDate(note.updatedAt)}`);
    }
    lines.push('', note.content || '');

    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${slugifyForFilename(note.title)}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast('.txt file downloaded', 'success');
  }

  function exportViewedNoteAsTxt() {
    const note = notes.find(n => n.id === viewingId);
    if (note) exportNoteAsTxt(note);
  }

  // ---------- Content textarea: auto-resize + character counter ----------

  function autoResizeContentTextarea() {
    inputContent.style.height = 'auto';
    inputContent.style.height = `${inputContent.scrollHeight}px`;
  }

  function updateContentCounter() {
    const len = inputContent.value.length;
    contentCounter.textContent = `${len.toLocaleString('en')} character${len === 1 ? '' : 's'}`;
  }

  function syncContentField() {
    autoResizeContentTextarea();
    updateContentCounter();
  }

  // ---------- Drag-and-drop a text file onto the content textarea ----------
  // Lets the user drag a .txt (or any text/*) file from their file manager
  // straight onto the content field instead of opening it and copy-pasting.
  // Reuses readFileAsText(), defined further down (function declarations are
  // hoisted, so the order here doesn't matter).

  // The server's express.json() body-size limit is 5MB total for the whole
  // request (title + tags + content + JSON overhead) — this is set a bit
  // below that so a file this size still leaves headroom, and so the
  // problem surfaces immediately on drop rather than as an opaque 413 from
  // the server after the user has already written a title and hit Save.
  const MAX_DROPPED_FILE_BYTES = 4 * 1024 * 1024; // 4MB

  function isLikelyTextFile(file) {
    // Prefer the browser-reported MIME type when present, but don't rely on
    // it alone — many OSes report no type (or a generic one) for .txt/.md
    // files, so fall back to checking the extension.
    if (file.type) {
      if (file.type.startsWith('text/')) return true;
      if (file.type !== 'application/octet-stream' && file.type !== '') return false;
    }
    return /\.(txt|text|md|markdown|log)$/i.test(file.name || '');
  }

  function setContentDropActive(active) {
    inputContent.classList.toggle('is-drop-target', active);
  }

  async function handleContentFileDrop(e) {
    e.preventDefault();
    setContentDropActive(false);

    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;
    if (files.length > 1) {
      showToast(`Only the first file ("${files[0].name}") will be used`);
    }
    const file = files[0];

    if (!isLikelyTextFile(file)) {
      showToast('Drop a text file (.txt) to load its contents', 'error');
      return;
    }
    if (file.size > MAX_DROPPED_FILE_BYTES) {
      const maxMb = (MAX_DROPPED_FILE_BYTES / (1024 * 1024)).toFixed(0);
      showToast(`"${file.name}" is too large (max ${maxMb}MB for a note)`, 'error');
      return;
    }

    if (inputContent.value.trim() && !window.confirm(`Replace the current content with the contents of "${file.name}"?`)) {
      return;
    }

    try {
      const text = await readFileAsText(file);
      inputContent.value = text;
      syncContentField();
      inputContent.focus();
      if (looksMisencoded(text)) {
        showToast(`Loaded "${file.name}" — some characters look garbled (unusual text encoding?)`, 'error');
      } else {
        showToast(`Loaded "${file.name}"`, 'success');
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  function setupContentFileDrop() {
    // Without this, dropping a file anywhere in the window *other* than the
    // textarea falls through to the browser's default behavior: it
    // navigates the whole tab to that file, discarding the app and
    // whatever was being written. Blocking dragover/drop at the window
    // level prevents that regardless of where the file lands — the
    // textarea's own listeners below still handle the one case where a
    // drop should actually do something.
    //
    // dataTransfer.types.includes('Files') distinguishes an OS file drag
    // from the app's own card-reordering drag-and-drop (public/notes.js's
    // "Drag & drop (manual reordering)" section), which carries no files
    // and must keep working normally.
    window.addEventListener('dragover', (e) => {
      if (e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes('Files')) e.preventDefault();
    });
    window.addEventListener('drop', (e) => {
      if (e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes('Files')) e.preventDefault();
    });

    // dragover must be prevented for drop to fire at all, and is what
    // controls the drag-and-drop cursor the browser shows.
    inputContent.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      setContentDropActive(true);
    });
    inputContent.addEventListener('dragleave', () => setContentDropActive(false));
    inputContent.addEventListener('drop', handleContentFileDrop);
  }

  // ---------- Unsaved-changes protection ----------
  // Notes tend to be longer-lived pieces of writing than a link's title/URL,
  // so losing an in-progress edit to an accidental navigation, tab close, or
  // closing the modal is a real risk in a way it mostly isn't for links.
  // lastSavedSnapshot captures the form's state at the last point it was
  // known to match the server (on opening/closing the modal, or right after
  // a successful save); hasUnsavedChanges() compares the live form against
  // it. This is deliberately just a dirty-check + confirmation, not a full
  // autosave/draft-recovery system — a reasonable middle ground that avoids
  // silent data loss without adding a second persistence path to reason about.

  let lastSavedSnapshot = null;

  function getFormSnapshot() {
    return JSON.stringify({
      title: inputTitle.value,
      tags: inputTags.value,
      content: inputContent.value,
      favorite: inputFavorite.checked,
    });
  }

  function markFormClean() {
    lastSavedSnapshot = getFormSnapshot();
  }

  function hasUnsavedChanges() {
    if (lastSavedSnapshot === null) return false;
    return getFormSnapshot() !== lastSavedSnapshot;
  }

  // Returns true if it's OK to proceed (either there was nothing to lose, or
  // the user confirmed discarding it) — false means the caller should abort
  // whatever action it was about to take.
  function confirmDiscardIfDirty() {
    if (!hasUnsavedChanges()) return true;
    return window.confirm('You have unsaved changes to this note. Discard them?');
  }

  window.addEventListener('beforeunload', (e) => {
    if (!hasUnsavedChanges()) return;
    e.preventDefault();
    e.returnValue = ''; // required for the browser's native "leave site?" prompt
  });

  // ---------- Add / edit note modal ----------
  // A single modal (visually matching the reading view's size and style)
  // used for both creating a new note and editing an existing one — there's
  // no separate always-visible sidebar composer; writing only happens here.

  function openEditNoteModal() {
    // Symmetric with openViewNoteModal(), which closes this modal if it's
    // open — only one full-screen modal should be considered "active" at a
    // time. Not reachable today (the reading modal's overlay blocks clicks
    // to everything behind it, including the header's "+ Add note" button),
    // but this keeps the invariant explicit rather than relying on that
    // z-index/pointer-events side effect, so a future entry point (e.g. a
    // keyboard shortcut) can't silently stack both modals.
    if (!viewNoteOverlay.classList.contains('hidden')) closeViewNoteModal();
    editNoteOverlay.classList.remove('hidden');
    trapFocus(document.querySelector('#editNoteOverlay .confirm-box'));
    syncContentField();
    inputTitle.focus();
  }

  function closeEditNoteModal() {
    editNoteOverlay.classList.add('hidden');
    releaseFocusTrap();
  }

  function requestCloseEditNoteModal() {
    if (!confirmDiscardIfDirty()) return;
    exitEditMode();
    closeEditNoteModal();
  }

  function enterCreateMode() {
    if (!confirmDiscardIfDirty()) return;
    exitEditMode(); // resets the form to a blank "create" state
    editNoteTitle.textContent = 'Add note';
    btnSubmit.textContent = 'Save note';
    openEditNoteModal();
  }

  function enterEditMode(note) {
    if (!confirmDiscardIfDirty()) return;
    editingId = note.id;
    editingIdInput.value = note.id;
    inputTitle.value = note.title;
    inputTags.value = (note.tags || []).join(', ');
    inputContent.value = note.content || '';
    inputFavorite.checked = !!note.favorite;
    editNoteTitle.textContent = 'Edit note';
    btnSubmit.textContent = 'Save changes';
    formError.classList.add('hidden');
    markFormClean();
    openEditNoteModal();
  }

  function exitEditMode() {
    editingId = null;
    editingIdInput.value = '';
    form.reset();
    formError.classList.add('hidden');
    syncContentField();
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
      tags: inputTags.value.split(',').map(t => t.trim()).filter(Boolean),
      content: inputContent.value,
      favorite: inputFavorite.checked,
    };

    btnSubmit.disabled = true;
    try {
      if (editingId) {
        const updated = await apiUpdate(editingId, payload);
        showToast('Note updated', 'success');
        markFormClean();
        exitEditMode();
        upsertLocal(updated);
      } else {
        const created = await apiCreate(payload);
        showToast('Note added', 'success');
        form.reset();
        markFormClean();
        markRecentlyAdded(created.id);
        upsertLocal(created);
      }
      closeEditNoteModal();
    } catch (err) {
      formError.textContent = err.message;
      formError.classList.remove('hidden');
    } finally {
      btnSubmit.disabled = false;
    }
  }

  function openConfirm(note) {
    pendingDeleteId = note.id;
    confirmText.textContent = `Are you sure you want to remove "${note.title}"? This action cannot be undone.`;
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
    const note = notes.find(n => n.id === pendingDeleteId);
    try {
      await apiDelete(pendingDeleteId);
      if (editingId === pendingDeleteId) {
        exitEditMode();
        closeEditNoteModal();
      }
      showToast(`"${note ? note.title : 'Note'}" removed`);
      removeLocal(pendingDeleteId);
      closeConfirm();
    } catch (err) {
      showToast(err.message, 'error');
      closeConfirm();
    }
  }

  async function toggleFavorite(id) {
    const note = notes.find(n => n.id === id);
    if (!note) return;
    try {
      const updated = await apiUpdate(id, { favorite: !note.favorite });
      upsertLocal(updated);
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  async function refresh() {
    try {
      notes = await apiList();
      setStatus('connected', 'Connected to server');
      render();
    } catch (err) {
      setStatus('error', 'Connection failed');
      showToast('Could not reach the server', 'error');
    }
  }

  // Patches the in-memory `notes` array from a single mutation's response
  // instead of re-fetching the whole collection — see app.js's upsertLocal
  // for the same reasoning on the links side.
  function upsertLocal(updatedOrCreated) {
    const idx = notes.findIndex(n => n.id === updatedOrCreated.id);
    if (idx === -1) notes.push(updatedOrCreated);
    else notes[idx] = updatedOrCreated;
    render();
  }

  function removeLocal(id) {
    notes = notes.filter(n => n.id !== id);
    render();
  }

  // ---------- Rendering ----------

  function collectTagCounts() {
    const counts = new Map();
    notes.forEach(n => (n.tags || []).forEach(t => counts.set(t, (counts.get(t) || 0) + 1)));
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

    if (activeTagFilters.size > 1) {
      const modeBtn = document.createElement('button');
      modeBtn.type = 'button';
      modeBtn.className = 'tag-mode-btn';
      modeBtn.title = tagFilterMode === 'or'
        ? 'Showing notes with any of the selected tags — click to require all'
        : 'Showing notes with all selected tags — click to accept any';
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
    let list = notes.slice();

    if (activeTagFilters.size > 0) {
      list = list.filter(n => {
        const tags = n.tags || [];
        return tagFilterMode === 'and'
          ? Array.from(activeTagFilters).every(t => tags.includes(t))
          : Array.from(activeTagFilters).some(t => tags.includes(t));
      });
    }

    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      list = list.filter(n =>
        n.title.toLowerCase().includes(q) ||
        (n.content || '').toLowerCase().includes(q) ||
        (n.tags || []).some(t => t.toLowerCase().includes(q))
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

    if (notes.length === 0) {
      emptyState.classList.add('visible');
      emptyState.querySelector('p').textContent = 'No notes in the collection yet.';
      linkListEl.style.display = 'none';
      renderedIds = [];
      updateCountLine(list.length);
      return;
    }

    if (list.length === 0) {
      emptyState.classList.add('visible');
      emptyState.querySelector('p').textContent = 'No note matches your search.';
      linkListEl.style.display = 'none';
      renderedIds = [];
      updateCountLine(list.length);
      return;
    }

    emptyState.classList.remove('visible');
    linkListEl.style.display = '';

    const slice = list.slice(0, visibleCount);
    renderedIds = slice.map(n => n.id);

    slice.forEach(note => {
      linkListEl.appendChild(buildCardEl(note));
    });

    updateCountLine(list.length);
  }

  function updateCountLine(filteredTotal) {
    const tagSummary = activeTagFilters.size > 0
      ? ` · tags: ${Array.from(activeTagFilters).join(tagFilterMode === 'and' ? ' + ' : ' or ')}`
      : '';
    const shown = Math.min(visibleCount, filteredTotal);
    countLine.textContent = `${shown} of ${filteredTotal} notes${tagSummary}`;
    footerCount.textContent = notes.length;
  }

  // A short, single-line preview of the note body shown on the card — the
  // full content is only shown when editing. Collapses whitespace so a
  // multi-line note doesn't visually break the card layout.
  function contentPreview(content, maxLen = 160) {
    const collapsed = (content || '').replace(/\s+/g, ' ').trim();
    if (collapsed.length <= maxLen) return collapsed;
    return collapsed.slice(0, maxLen).trimEnd() + '…';
  }

  function buildCardEl(note) {
    const li = document.createElement('li');
    li.className = 'link-card'
      + (note.favorite ? ' is-favorite' : '')
      + (recentlyAddedIds.has(note.id) ? ' is-recent' : '');
    li.dataset.id = note.id;
    li.draggable = sortMode === 'manual';

    const tags = note.tags || [];
    const isManual = sortMode === 'manual';

    const dragHandle = isManual
      ? `<span class="drag-handle-group">
          <button type="button" class="drag-handle" data-action="move-up" data-id="${note.id}" title="Move up" aria-label="Move ${escapeHtml(note.title)} up">▲</button>
          <span class="drag-handle-icon" aria-hidden="true">⠿</span>
          <button type="button" class="drag-handle" data-action="move-down" data-id="${note.id}" title="Move down" aria-label="Move ${escapeHtml(note.title)} down">▼</button>
        </span>`
      : `<span class="drag-handle-icon drag-handle-idle" aria-hidden="true">⠿</span>`;

    li.innerHTML = `
      ${dragHandle}
      <div class="link-favicon" aria-hidden="true">✎</div>
      <div class="link-body">
        <div class="link-title-row">
          <button type="button" class="link-title" data-action="view" data-id="${note.id}">${escapeHtml(note.title)}</button>
          ${note.favorite ? '<span class="favorite-star" title="Favorite">★</span>' : ''}
        </div>
        ${note.content ? `<button type="button" class="link-notes note-content-preview" data-action="view" data-id="${note.id}">${escapeHtml(contentPreview(note.content))}</button>` : ''}
        ${tags.length ? `<div class="link-tags">${tags.map(t => `<button type="button" class="link-tag" data-action="filter-tag" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</button>`).join('')}</div>` : ''}
        <div class="link-footer-row">
          <p class="link-meta">added ${formatDate(note.createdAt)}</p>
        </div>
      </div>
      <div class="link-actions">
        <button class="icon-btn fav-btn${note.favorite ? ' active' : ''}" title="Toggle favorite" data-action="favorite" data-id="${note.id}">★</button>
        <button class="icon-btn" title="Edit" data-action="edit" data-id="${note.id}">✎</button>
        <button class="icon-btn danger" title="Remove" data-action="delete" data-id="${note.id}">✕</button>
      </div>
    `;
    return li;
  }

  function render() {
    renderTagFilters();
    renderList();
    syncViewNoteModalIfOpen();
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
  btnCancelEdit.addEventListener('click', requestCloseEditNoteModal);

  inputContent.addEventListener('input', syncContentField);
  inputContent.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  linkListEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const { action, id } = btn.dataset;
    const note = notes.find(n => n.id === id);
    if (action === 'delete' && note) openConfirm(note);
    if (action === 'edit' && note) enterEditMode(note);
    if (action === 'view' && note) openViewNoteModal(note);
    if (action === 'favorite') toggleFavorite(id);
    if (action === 'filter-tag') {
      const tag = btn.dataset.tag;
      activeTagFilters.add(tag);
      renderTagFilters();
      resetPaginationAndRender();
    }
    if ((action === 'move-up' || action === 'move-down') && note) {
      moveNoteManually(id, action === 'move-up' ? -1 : 1, btn);
    }
  });

  viewNoteTags.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action="filter-tag"]');
    if (!btn) return;
    closeViewNoteModal();
    activeTagFilters.add(btn.dataset.tag);
    renderTagFilters();
    resetPaginationAndRender();
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

  btnExport.addEventListener('click', () => { closeMoreMenu(); exportAsDownload(); });
  $('#btnToggleTheme').addEventListener('click', toggleTheme);
  btnToggleView.addEventListener('click', toggleView);

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!confirmOverlay.classList.contains('hidden')) closeConfirm();
      else if (!importOverlay.classList.contains('hidden')) closeImportModal();
      else if (!statsOverlay.classList.contains('hidden')) closeStatsModal();
      else if (!viewNoteOverlay.classList.contains('hidden')) closeViewNoteModal();
      else if (!editNoteOverlay.classList.contains('hidden')) requestCloseEditNoteModal();
    }
    // Arrow-key navigation while the reading modal is open — both
    // ArrowUp/ArrowDown (matching the ▲▼ manual-reorder buttons elsewhere
    // in the app) and ArrowLeft/ArrowRight (the more common "prev/next
    // item" convention) move to the adjacent note in the current
    // filtered/sorted list.
    if (!viewNoteOverlay.classList.contains('hidden')) {
      if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        e.preventDefault();
        navigateView(-1);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        e.preventDefault();
        navigateView(1);
      }
    }
    if (e.key === '/' &&
        document.activeElement !== inputTitle &&
        document.activeElement !== inputTags &&
        document.activeElement !== inputContent &&
        document.activeElement !== searchInput) {
      e.preventDefault();
      searchInput.focus();
    }
  });

  // ---------- Theme / view ----------
  // Shares the "nodes-theme" localStorage key with the links page on
  // purpose, so the light/dark choice is consistent across both pages.

  function toggleTheme() {
    const isDark = document.body.dataset.theme === 'dark';
    document.body.dataset.theme = isDark ? '' : 'dark';
    try { localStorage.setItem('nodes-theme', isDark ? 'light' : 'dark'); } catch {}
  }

  function toggleView() {
    viewMode = viewMode === 'list' ? 'grid' : 'list';
    try { localStorage.setItem('notes-view-mode', viewMode); } catch {}
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
    try { localStorage.setItem('notes-density', density); } catch {}
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

  // ---------- Keyboard-accessible manual reordering ----------

  async function moveNoteManually(id, direction, btnEl) {
    const visibleList = getFilteredSorted();
    const idx = visibleList.findIndex(n => n.id === id);
    const targetIdx = idx + direction;
    if (idx === -1 || targetIdx < 0 || targetIdx >= visibleList.length) return;

    const a = visibleList[idx];
    const b = visibleList[targetIdx];

    const swappedOrder = [...visibleList];
    swappedOrder[idx] = b;
    swappedOrder[targetIdx] = a;
    const orderedIds = swappedOrder.map(n => n.id);

    try {
      await apiReorder(orderedIds);
      orderedIds.forEach((noteId, i) => {
        const note = notes.find(n => n.id === noteId);
        if (note) note.order = i;
      });
      renderList();
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

      const fromIdx = renderedIds.indexOf(dragSourceId);
      let toIdx = renderedIds.indexOf(targetCard.dataset.id);
      if (fromIdx === -1 || toIdx === -1) return;

      renderedIds.splice(fromIdx, 1);
      toIdx = renderedIds.indexOf(targetCard.dataset.id);
      renderedIds.splice(isAfter ? toIdx + 1 : toIdx, 0, dragSourceId);

      linkListEl.innerHTML = '';
      renderedIds.forEach(id => {
        const note = notes.find(n => n.id === id);
        if (note) linkListEl.appendChild(buildCardEl(note));
      });

      try {
        await apiReorder(renderedIds);
        renderedIds.forEach((id, i) => {
          const note = notes.find(n => n.id === id);
          if (note) note.order = i;
        });
      } catch (err) {
        showToast('Error saving order — reloading', 'error');
        await refresh();
      }
    });
  }

  // ---------- Import ----------

  function openImportModal() {
    importOverlay.classList.remove('hidden');
    importError.classList.add('hidden');
    importResult.classList.add('hidden');
    fileJson.value = '';
    importTagsJson.value = '';
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
      // readAsText() decodes as UTF-8 by default (no encoding argument here).
      // An older .txt file saved in Latin-1/Windows-1252 — plausible for
      // text with accents, e.g. Portuguese — will still "succeed" but
      // produce garbled characters rather than throwing. There's no
      // reliable way to detect and re-decode with a different encoding
      // using only the browser's built-in FileReader/TextDecoder, so this
      // is a known limitation rather than something silently handled.
      reader.readAsText(file);
    });
  }

  // A rough heuristic for "this text was probably decoded with the wrong
  // encoding": the UTF-8 decoder substitutes U+FFFD (�) for byte sequences
  // it can't interpret, so a cluster of them is a reasonably reliable sign
  // of a mis-decoded non-UTF-8 file rather than actual content (the
  // replacement character is vanishingly rare in real text otherwise).
  function looksMisencoded(text) {
    const replacementCount = (text.match(/\uFFFD/g) || []).length;
    return replacementCount >= 3;
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
      if (!items) throw new Error('Unexpected format — expected an array of notes.');
      const defaultTags = importTagsJson.value.split(',').map(t => t.trim()).filter(Boolean);
      const result = await apiImportJson(items, defaultTags);
      importResult.textContent = `${result.imported} note(s) imported, ${result.skipped} already existed, ${result.invalid} invalid.`;
      importResult.classList.remove('hidden');
      await refresh();
    } catch (err) {
      importError.textContent = err.message;
      importError.classList.remove('hidden');
    } finally {
      importSubmit.disabled = false;
    }
  }

  // ---------- Note reading view ----------
  // A larger, read-focused modal for viewing a note's full content clearly —
  // preserves line breaks/paragraphs (the card preview collapses them),
  // shows both created and last-edited timestamps, and offers quick actions
  // (favorite, edit, delete) without committing to edit mode first.
  //
  // Navigation (prev/next) walks the same filtered+sorted list the card grid
  // is built from (getFilteredSorted()), not just the currently-rendered
  // page — so "next" reaches every note matching the active search/tag
  // filter, even ones not yet scrolled into view.
  //
  // Sync: the modal is re-synced from the live `notes` array every time
  // render() runs (called from refresh()/upsertLocal()/removeLocal() — i.e.
  // after every mutation, whether triggered from this modal or elsewhere,
  // such as a bulk action or an import). If the note being viewed no longer
  // exists, the modal closes itself rather than keep showing stale content
  // for a note that's gone.

  function openViewNoteModal(note) {
    // Only one modal makes sense open at a time — if the add/edit modal
    // happens to be open (e.g. reached via a tag click from within it),
    // close it first rather than stacking two overlays.
    if (!editNoteOverlay.classList.contains('hidden')) {
      closeEditNoteModal();
    }
    viewingId = note.id;
    renderViewNoteModal(note);
    viewNoteOverlay.classList.remove('hidden');
    trapFocus(document.querySelector('#viewNoteOverlay .confirm-box'));
  }

  // Fills in the modal's content for a given note, without touching
  // overlay visibility or focus — used both by openViewNoteModal() (first
  // open) and by the sync/navigation paths (modal already open, just
  // needs its content refreshed for a different or updated note).
  function renderViewNoteModal(note) {
    viewNoteTitle.textContent = note.title;

    const created = `created ${formatDate(note.createdAt)}`;
    const edited = note.updatedAt && note.updatedAt !== note.createdAt
      ? ` · edited ${timeAgo(note.updatedAt)}`
      : '';
    viewNoteMeta.textContent = created + edited;

    const tags = note.tags || [];
    viewNoteTags.innerHTML = tags.length
      ? tags.map(t => `<button type="button" class="link-tag" data-action="filter-tag" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</button>`).join('')
      : '';

    if (note.content && note.content.trim()) {
      viewNoteBody.textContent = note.content; // textContent preserves line breaks via white-space: pre-wrap in CSS
      viewNoteBody.classList.remove('is-empty');
    } else {
      viewNoteBody.textContent = 'This note has no content yet.';
      viewNoteBody.classList.add('is-empty');
    }

    syncViewNoteFavoriteButton(note.favorite);
    syncViewNoteNav();
  }

  // Updates the prev/next buttons and the "N of M" position indicator based
  // on where the currently-viewed note sits in the live filtered/sorted list.
  function syncViewNoteNav() {
    const list = getFilteredSorted();
    const idx = list.findIndex(n => n.id === viewingId);

    if (idx === -1) {
      // Shouldn't normally happen (callers check existence first), but fail
      // safe: hide position info and disable navigation rather than show
      // something misleading.
      viewNotePosition.textContent = '';
      viewNotePrev.disabled = true;
      viewNoteNext.disabled = true;
      return;
    }

    viewNotePosition.textContent = `${idx + 1} of ${list.length}`;
    viewNotePrev.disabled = idx <= 0;
    viewNoteNext.disabled = idx >= list.length - 1;
  }

  function navigateView(direction) {
    const list = getFilteredSorted();
    const idx = list.findIndex(n => n.id === viewingId);
    if (idx === -1) return;
    const targetIdx = idx + direction;
    if (targetIdx < 0 || targetIdx >= list.length) return;

    viewingId = list[targetIdx].id;
    renderViewNoteModal(list[targetIdx]);
  }

  function closeViewNoteModal() {
    viewingId = null;
    viewNoteOverlay.classList.add('hidden');
    releaseFocusTrap();
  }

  // Called from render() (i.e. after every mutation to `notes`, from
  // whatever source) so the open modal never shows stale data: if the note
  // being viewed still exists, its content and prev/next state are
  // refreshed in place; if it was deleted (by this modal, a bulk action, or
  // anything else), the modal closes itself instead of lingering on a note
  // that's gone.
  function syncViewNoteModalIfOpen() {
    if (!viewingId || viewNoteOverlay.classList.contains('hidden')) return;
    const current = notes.find(n => n.id === viewingId);
    if (!current) {
      closeViewNoteModal();
      showToast('This note was removed');
      return;
    }
    renderViewNoteModal(current);
  }

  function syncViewNoteFavoriteButton(isFavorite) {
    viewNoteFavorite.textContent = isFavorite ? '★ Favorited' : '☆ Add to favorites';
    viewNoteFavorite.classList.toggle('is-favorited', isFavorite);
  }

  async function toggleFavoriteFromViewModal() {
    if (!viewingId) return;
    await toggleFavorite(viewingId);
    const updated = notes.find(n => n.id === viewingId);
    if (updated) syncViewNoteFavoriteButton(updated.favorite);
  }

  function editFromViewModal() {
    const note = notes.find(n => n.id === viewingId);
    closeViewNoteModal();
    if (note) enterEditMode(note);
  }

  function deleteFromViewModal() {
    const note = notes.find(n => n.id === viewingId);
    closeViewNoteModal();
    if (note) openConfirm(note);
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
          <div class="stat-label">Total notes</div>
        </div>
        <div class="stat-tile">
          <div class="stat-value">${stats.favorites}</div>
          <div class="stat-label">Favorites</div>
        </div>
        <div class="stat-tile">
          <div class="stat-value">${stats.totalTags}</div>
          <div class="stat-label">Tags</div>
        </div>
      </div>
    `;
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

  // ---------- Init ----------

  async function init() {
    let savedTheme = null;
    try { savedTheme = localStorage.getItem('nodes-theme'); } catch {}
    if (savedTheme === 'dark' || savedTheme === null) document.body.dataset.theme = 'dark';

    syncViewToggleUI();
    syncDensityToggleUI();
    syncContentField();
    markFormClean();

    attachDragHandlers();

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

    viewNoteClose.addEventListener('click', closeViewNoteModal);
    viewNoteOverlay.addEventListener('click', (e) => { if (e.target === viewNoteOverlay) closeViewNoteModal(); });
    viewNoteFavorite.addEventListener('click', toggleFavoriteFromViewModal);
    viewNoteEdit.addEventListener('click', editFromViewModal);
    viewNoteDelete.addEventListener('click', deleteFromViewModal);
    viewNoteExportTxt.addEventListener('click', exportViewedNoteAsTxt);
    viewNotePrev.addEventListener('click', () => navigateView(-1));
    viewNoteNext.addEventListener('click', () => navigateView(1));

    btnAddNote.addEventListener('click', enterCreateMode);
    editNoteClose.addEventListener('click', requestCloseEditNoteModal);
    editNoteOverlay.addEventListener('click', (e) => { if (e.target === editNoteOverlay) requestCloseEditNoteModal(); });

    btnToggleDensity.addEventListener('click', toggleDensity);

    setupMoreMenu();
    setupTagPopover();
    setupClearFilters();
    setupContentFileDrop();
    setupGlobalFocusTrapHandler();

    await refresh();
  }

  init();
})();
