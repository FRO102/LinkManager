// ---------- Tasks API ----------
// Thin wrappers around fetch() for the /api/tasks backend, mirroring
// js/notes-api.js's shape. No apiReorder() here — tasks sort automatically
// by due date rather than supporting manual drag-and-drop ordering.

const API = '/api/tasks';

export async function apiList(params) {
  const query = params ? `?${new URLSearchParams(params)}` : '';
  const res = await fetch(`${API}${query}`);
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
  if (!res.ok) throw new Error(data.error || 'Error creating task');
  return data;
}

export async function apiUpdate(id, payload) {
  const res = await fetch(`${API}/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Error updating task');
  return data;
}

export async function apiDelete(id) {
  const res = await fetch(`${API}/${id}`, { method: 'DELETE' });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || 'Error removing task');
  }
}

export async function apiBulkDelete(ids) {
  const res = await fetch(`${API}/bulk-delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Error removing tasks');
  return data;
}

export async function apiImportJson(items) {
  const res = await fetch('/api/tasks/import/json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
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
