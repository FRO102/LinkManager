// ---------- Notes API ----------
// Thin wrappers around fetch() for the /api/notes backend, mirroring
// js/api.js's shape for the links side.

const API = '/api/notes';

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
  if (!res.ok) throw new Error(data.error || 'Error creating note');
  return data;
}

export async function apiUpdate(id, payload) {
  const res = await fetch(`${API}/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Error updating note');
  return data;
}

export async function apiDelete(id) {
  const res = await fetch(`${API}/${id}`, { method: 'DELETE' });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || 'Error removing note');
  }
}

export async function apiBulkDelete(ids) {
  const res = await fetch(`${API}/bulk-delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Error removing notes');
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

export async function apiImportJson(items, defaultTags) {
  const res = await fetch('/api/notes/import/json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items, defaultTags }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Error importing file');
  return data;
}

export async function apiStats() {
  const res = await fetch(`${API}/stats`);
  if (!res.ok) throw new Error('Error fetching statistics');
  return res.json();
}
