// ---------- API ----------
// Thin wrappers around fetch() for every backend endpoint the frontend uses.
// No dependency on app state or the DOM — pure network calls that throw a
// friendly Error on failure, so callers can catch and show a toast.

const API = '/api/links';

export async function apiList() {
  const res = await fetch(API);
  if (!res.ok) throw new Error('Failed to load');
  return res.json();
}

export async function apiCreate(payload) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Error creating node');
  return data;
}

export async function apiUpdate(id, payload) {
  const res = await fetch(`${API}/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Error updating node');
  return data;
}

export async function apiDelete(id) {
  const res = await fetch(`${API}/${id}`, { method: 'DELETE' });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || 'Error removing node');
  }
}

export async function apiBulkDelete(ids) {
  const res = await fetch(`${API}/bulk-delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Error removing nodes');
  return data;
}

export async function apiReorder(orderedIds) {
  const res = await fetch(`${API}/reorder`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderedIds }),
  });
  if (!res.ok) throw new Error('Error saving new order');
}

export async function apiCheckOne(id) {
  const res = await fetch(`${API}/${id}/check`, { method: 'POST' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Error checking link');
  return data;
}

export async function apiCheckAll() {
  const res = await fetch(`${API}/check-all`, { method: 'POST' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Error checking links');
  return data;
}

export async function apiCheckCancel() {
  const res = await fetch(`${API}/check-all/cancel`, { method: 'POST' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Error cancelling check');
  return data;
}

export async function apiCheckStatus() {
  const res = await fetch(`${API}/check-status`);
  return res.json();
}

export async function apiPreview(url) {
  const res = await fetch(`/api/preview?url=${encodeURIComponent(url)}`);
  if (!res.ok) return null;
  return res.json();
}

export async function apiImportBookmarks(html, defaultTags) {
  const res = await fetch('/api/import/bookmarks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ html, defaultTags }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Error importing bookmarks');
  return data;
}

export async function apiImportJson(items, defaultTags) {
  const res = await fetch('/api/import/json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items, defaultTags }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Error importing file');
  return data;
}

export async function apiStats() {
  const res = await fetch('/api/stats');
  if (!res.ok) throw new Error('Error fetching statistics');
  return res.json();
}

export async function apiDuplicates() {
  const res = await fetch('/api/duplicates');
  if (!res.ok) throw new Error('Error fetching duplicates');
  return res.json();
}
