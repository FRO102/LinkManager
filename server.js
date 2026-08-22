const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'links.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const BACKUP_RETENTION = parseInt(process.env.BACKUP_RETENTION || '14', 10); // dias/cópias a manter
const LINK_CHECK_INTERVAL_MS = parseInt(process.env.LINK_CHECK_INTERVAL_HOURS || '24', 10) * 60 * 60 * 1000;
const LINK_CHECK_TIMEOUT_MS = 8000;
const OG_FETCH_TIMEOUT_MS = 6000;

// Garante que as pastas e o ficheiro existem
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]', 'utf-8');

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- Helpers de persistência ---
function readLinks() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    return JSON.parse(raw || '[]');
  } catch (err) {
    console.error('Erro ao ler links.json:', err);
    return [];
  }
}

function writeLinks(links) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(links, null, 2), 'utf-8');
}

function isValidUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeUrlForCompare(url) {
  try {
    const u = new URL(url);
    let host = u.hostname.replace(/^www\./, '');
    let pathPart = u.pathname.replace(/\/+$/, '');
    return `${host}${pathPart}${u.search}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

// Garante que todos os links têm um campo `order` coerente (migração suave)
function ensureOrder(links) {
  let changed = false;
  links.forEach((l, i) => {
    if (typeof l.order !== 'number') {
      l.order = i;
      changed = true;
    }
  });
  return changed;
}

// --- Backups ---
function createBackup() {
  try {
    const links = readLinks();
    if (links.length === 0) return; // nada a preservar
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = path.join(BACKUP_DIR, `links-${ts}.json`);
    fs.writeFileSync(backupFile, JSON.stringify(links, null, 2), 'utf-8');
    rotateBackups();
  } catch (err) {
    console.error('Erro ao criar backup:', err);
  }
}

function rotateBackups() {
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('links-') && f.endsWith('.json'))
      .map(f => ({ name: f, time: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
      .sort((a, b) => b.time - a.time);

    files.slice(BACKUP_RETENTION).forEach(f => {
      fs.unlinkSync(path.join(BACKUP_DIR, f.name));
    });
  } catch (err) {
    console.error('Erro ao rodar backups:', err);
  }
}

function listBackups() {
  try {
    return fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('links-') && f.endsWith('.json'))
      .map(f => {
        const stat = fs.statSync(path.join(BACKUP_DIR, f));
        return { file: f, createdAt: stat.mtime.toISOString(), size: stat.size };
      })
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  } catch {
    return [];
  }
}

// --- Verificação de links mortos ---
async function checkLinkStatus(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LINK_CHECK_TIMEOUT_MS);
  try {
    let res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: controller.signal });
    // Alguns servidores não suportam HEAD corretamente; tenta GET como fallback
    if (res.status === 405 || res.status === 501) {
      res = await fetch(url, { method: 'GET', redirect: 'follow', signal: controller.signal });
    }
    clearTimeout(timeout);
    return { status: res.ok ? 'ok' : 'broken', statusCode: res.status, checkedAt: new Date().toISOString() };
  } catch (err) {
    clearTimeout(timeout);
    return { status: 'broken', statusCode: null, error: err.name === 'AbortError' ? 'timeout' : 'unreachable', checkedAt: new Date().toISOString() };
  }
}

async function checkAllLinks() {
  const links = readLinks();
  console.log(`[link-check] a verificar ${links.length} links...`);
  // Corre em lotes pequenos para não disparar dezenas de pedidos em simultâneo
  const BATCH_SIZE = 5;
  for (let i = 0; i < links.length; i += BATCH_SIZE) {
    const batch = links.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(l => checkLinkStatus(l.url)));
    batch.forEach((l, idx) => {
      l.linkStatus = results[idx].status;
      l.linkStatusCode = results[idx].statusCode;
      l.lastCheckedAt = results[idx].checkedAt;
    });
  }
  writeLinks(links);
  console.log('[link-check] concluído');
  return links;
}

// --- Open Graph scraping (leve, via regex — sem dependências extra) ---
function extractMeta(html, property) {
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${property}["']`, 'i'),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return m[1];
  }
  return null;
}

function extractTitleFallback(html) {
  const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return m ? m[1].trim() : null;
}

async function fetchOgData(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OG_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NosLinkManager/1.0)' },
    });
    clearTimeout(timeout);
    if (!res.ok) return null;

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) return null;

    // Só lê os primeiros ~100KB — suficiente para o <head> na esmagadora maioria dos sites
    const reader = res.body.getReader();
    let html = '';
    let bytesRead = 0;
    const MAX_BYTES = 100_000;
    const decoder = new TextDecoder();
    while (bytesRead < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.length;
      html += decoder.decode(value, { stream: true });
      if (/<\/head>/i.test(html)) break;
    }
    try { reader.cancel(); } catch {}

    return {
      ogTitle: extractMeta(html, 'og:title') || extractTitleFallback(html),
      ogDescription: extractMeta(html, 'og:description') || extractMeta(html, 'description'),
      ogImage: extractMeta(html, 'og:image'),
      fetchedAt: new Date().toISOString(),
    };
  } catch (err) {
    clearTimeout(timeout);
    return null;
  }
}

// Cache simples em memória para não voltar a buscar OG data repetidamente na mesma sessão
const ogCache = new Map();
const OG_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hora

async function getOgDataCached(url) {
  const cached = ogCache.get(url);
  if (cached && Date.now() - cached.ts < OG_CACHE_TTL_MS) {
    return cached.data;
  }
  const data = await fetchOgData(url);
  ogCache.set(url, { data, ts: Date.now() });
  return data;
}

// --- Importação: bookmarks HTML (Netscape Bookmark format, usado por Chrome/Firefox) ---
function parseBookmarksHtml(html) {
  const results = [];
  const linkRe = /<A[^>]+HREF="([^"]+)"[^>]*>([^<]*)<\/A>/gi;
  let match;
  while ((match = linkRe.exec(html)) !== null) {
    const url = match[1];
    const title = match[2].trim();
    if (!isValidUrl(url)) continue;
    // Tenta extrair TAGS="..." se presente (Firefox exporta isto)
    const fullTag = match[0];
    const tagsMatch = fullTag.match(/TAGS="([^"]*)"/i);
    const tags = tagsMatch ? tagsMatch[1].split(',').map(t => t.trim()).filter(Boolean) : [];
    results.push({ url, title: title || url, tags });
  }
  return results;
}


// --- Rotas da API ---

// IMPORTANTE: rotas com segmento fixo (ex: /api/links/reorder) têm de vir
// antes de rotas com parâmetro (ex: /api/links/:id), senão o Express interpreta
// o segmento fixo como um valor de :id.

// Listar todos os links (com filtros opcionais via query params)
app.get('/api/links', (req, res) => {
  let links = readLinks();
  if (ensureOrder(links)) writeLinks(links);

  const { q, tag, favorite } = req.query;

  if (q) {
    const term = q.toLowerCase();
    links = links.filter(l =>
      l.title.toLowerCase().includes(term) ||
      l.url.toLowerCase().includes(term) ||
      (l.description || '').toLowerCase().includes(term) ||
      (l.tags || []).some(t => t.toLowerCase().includes(term))
    );
  }

  if (tag) {
    links = links.filter(l => (l.tags || []).includes(tag));
  }

  if (favorite === 'true') {
    links = links.filter(l => l.favorite === true);
  }

  // Ordem manual (drag-and-drop) é a ordem base; o frontend reordena depois consoante o sort escolhido
  links.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  res.json(links);
});

// Verificar se uma URL já existe na coleção (deteção de duplicados)
app.get('/api/links/check-duplicate', (req, res) => {
  const { url, excludeId } = req.query;
  if (!url) return res.status(400).json({ error: 'Falta o parâmetro url' });

  const links = readLinks();
  const normalized = normalizeUrlForCompare(url);
  const match = links.find(l => l.id !== excludeId && normalizeUrlForCompare(l.url) === normalized);

  res.json({ duplicate: !!match, existing: match || null });
});

// Listar todos os grupos de duplicados existentes na coleção
app.get('/api/duplicates', (req, res) => {
  const links = readLinks();
  const groups = new Map();

  links.forEach(l => {
    const key = normalizeUrlForCompare(l.url);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(l);
  });

  const duplicateGroups = Array.from(groups.values()).filter(g => g.length > 1);
  res.json(duplicateGroups);
});

// Estado da verificação de links em curso (tem de vir antes de /:id/check)
app.get('/api/links/check-status', (req, res) => {
  res.json({ inProgress: checkInProgress });
});

// Verificar todos os links (pode demorar — corre em lotes)
app.post('/api/links/check-all', async (req, res) => {
  if (checkInProgress) {
    return res.status(409).json({ error: 'Já existe uma verificação em curso' });
  }
  checkInProgress = true;
  try {
    const links = await checkAllLinks();
    res.json({ checked: links.length, links });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao verificar links' });
  } finally {
    checkInProgress = false;
  }
});

// Reordenar links (drag-and-drop) — recebe a lista de IDs na nova ordem desejada
app.put('/api/links/reorder', (req, res) => {
  const { orderedIds } = req.body;
  if (!Array.isArray(orderedIds)) {
    return res.status(400).json({ error: 'orderedIds deve ser um array de IDs' });
  }

  const links = readLinks();
  const byId = new Map(links.map(l => [l.id, l]));

  orderedIds.forEach((id, index) => {
    const link = byId.get(id);
    if (link) link.order = index;
  });

  writeLinks(links);
  res.json({ success: true });
});

// Obter um link específico
app.get('/api/links/:id', (req, res) => {
  const links = readLinks();
  const link = links.find(l => l.id === req.params.id);
  if (!link) return res.status(404).json({ error: 'Link não encontrado' });
  res.json(link);
});

// Verificar um único link (tem de vir depois de /check-all e /check-status para não colidir)
app.post('/api/links/:id/check', async (req, res) => {
  const links = readLinks();
  const idx = links.findIndex(l => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Link não encontrado' });

  const result = await checkLinkStatus(links[idx].url);
  links[idx].linkStatus = result.status;
  links[idx].linkStatusCode = result.statusCode;
  links[idx].lastCheckedAt = result.checkedAt;
  writeLinks(links);

  res.json(links[idx]);
});

// Criar novo link
app.post('/api/links', (req, res) => {
  const { title, url, description, tags, favorite } = req.body;

  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'O título é obrigatório' });
  }
  if (!url || !isValidUrl(url)) {
    return res.status(400).json({ error: 'URL inválido. Usa http:// ou https://' });
  }

  const links = readLinks();
  ensureOrder(links);

  const maxOrder = links.reduce((max, l) => Math.max(max, l.order ?? 0), -1);
  const newLink = {
    id: crypto.randomUUID(),
    title: title.trim(),
    url: url.trim(),
    description: (description || '').trim(),
    tags: Array.isArray(tags) ? tags.filter(Boolean) : [],
    favorite: !!favorite,
    order: maxOrder + 1,
    linkStatus: null,
    linkStatusCode: null,
    lastCheckedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  links.push(newLink);
  writeLinks(links);
  res.status(201).json(newLink);
});

// Editar link existente
app.put('/api/links/:id', (req, res) => {
  const links = readLinks();
  const idx = links.findIndex(l => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Link não encontrado' });

  const { title, url, description, tags, favorite } = req.body;

  if (title !== undefined) {
    if (!title.trim()) return res.status(400).json({ error: 'O título é obrigatório' });
    links[idx].title = title.trim();
  }
  if (url !== undefined) {
    if (!isValidUrl(url)) return res.status(400).json({ error: 'URL inválido. Usa http:// ou https://' });
    links[idx].url = url.trim();
    // Muda a URL -> o estado de verificação anterior deixa de ser válido
    links[idx].linkStatus = null;
    links[idx].linkStatusCode = null;
    links[idx].lastCheckedAt = null;
  }
  if (description !== undefined) links[idx].description = description.trim();
  if (tags !== undefined) links[idx].tags = Array.isArray(tags) ? tags.filter(Boolean) : [];
  if (favorite !== undefined) links[idx].favorite = !!favorite;

  links[idx].updatedAt = new Date().toISOString();

  writeLinks(links);
  res.json(links[idx]);
});

// Apagar link
app.delete('/api/links/:id', (req, res) => {
  const links = readLinks();
  const idx = links.findIndex(l => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Link não encontrado' });

  const [removed] = links.splice(idx, 1);
  writeLinks(links);
  res.json(removed);
});

// Listar todas as tags existentes (útil para filtros no frontend)
app.get('/api/tags', (req, res) => {
  const links = readLinks();
  const tagSet = new Set();
  links.forEach(l => (l.tags || []).forEach(t => tagSet.add(t)));
  res.json([...tagSet].sort());
});

// --- Preview (Open Graph) ---
app.get('/api/preview', async (req, res) => {
  const { url } = req.query;
  if (!url || !isValidUrl(url)) {
    return res.status(400).json({ error: 'URL inválido' });
  }
  const data = await getOgDataCached(url);
  if (!data) return res.status(502).json({ error: 'Não foi possível obter preview' });
  res.json(data);
});

// --- Importação ---

// Importar a partir de bookmarks HTML (Netscape Bookmark format)
app.post('/api/import/bookmarks', (req, res) => {
  const { html, defaultTags } = req.body;
  if (!html || typeof html !== 'string') {
    return res.status(400).json({ error: 'Falta o conteúdo HTML dos bookmarks' });
  }

  const parsed = parseBookmarksHtml(html);
  if (parsed.length === 0) {
    return res.status(400).json({ error: 'Nenhum bookmark válido encontrado no ficheiro' });
  }

  const links = readLinks();
  ensureOrder(links);
  const existingUrls = new Set(links.map(l => normalizeUrlForCompare(l.url)));
  let maxOrder = links.reduce((max, l) => Math.max(max, l.order ?? 0), -1);

  const extraTags = Array.isArray(defaultTags) ? defaultTags.filter(Boolean) : [];
  const imported = [];
  const skipped = [];

  parsed.forEach(item => {
    const key = normalizeUrlForCompare(item.url);
    if (existingUrls.has(key)) {
      skipped.push(item.url);
      return;
    }
    existingUrls.add(key);
    maxOrder += 1;
    const newLink = {
      id: crypto.randomUUID(),
      title: item.title || item.url,
      url: item.url,
      description: '',
      tags: [...new Set([...item.tags, ...extraTags])],
      favorite: false,
      order: maxOrder,
      linkStatus: null,
      linkStatusCode: null,
      lastCheckedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    links.push(newLink);
    imported.push(newLink);
  });

  writeLinks(links);
  res.json({ imported: imported.length, skipped: skipped.length, links: imported });
});

// Importar a partir de um links.json (desta app ou de outra instância)
app.post('/api/import/json', (req, res) => {
  const { items, defaultTags } = req.body;
  if (!Array.isArray(items)) {
    return res.status(400).json({ error: 'O corpo deve conter um array "items"' });
  }

  const links = readLinks();
  ensureOrder(links);
  const existingUrls = new Set(links.map(l => normalizeUrlForCompare(l.url)));
  let maxOrder = links.reduce((max, l) => Math.max(max, l.order ?? 0), -1);

  const extraTags = Array.isArray(defaultTags) ? defaultTags.filter(Boolean) : [];
  const imported = [];
  const skipped = [];
  const invalid = [];

  items.forEach(item => {
    if (!item || !item.url || !isValidUrl(item.url)) {
      invalid.push(item);
      return;
    }
    const key = normalizeUrlForCompare(item.url);
    if (existingUrls.has(key)) {
      skipped.push(item.url);
      return;
    }
    existingUrls.add(key);
    maxOrder += 1;
    const newLink = {
      id: crypto.randomUUID(),
      title: (item.title || item.url).toString().trim(),
      url: item.url.trim(),
      description: (item.description || '').toString().trim(),
      tags: [...new Set([...(Array.isArray(item.tags) ? item.tags.filter(Boolean) : []), ...extraTags])],
      favorite: !!item.favorite,
      order: maxOrder,
      linkStatus: null,
      linkStatusCode: null,
      lastCheckedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    links.push(newLink);
    imported.push(newLink);
  });

  writeLinks(links);
  res.json({ imported: imported.length, skipped: skipped.length, invalid: invalid.length, links: imported });
});

// --- Backups ---
app.get('/api/backups', (req, res) => {
  res.json(listBackups());
});

app.post('/api/backups', (req, res) => {
  createBackup();
  res.json({ success: true, backups: listBackups() });
});

app.post('/api/backups/:file/restore', (req, res) => {
  const file = req.params.file;
  const filePath = path.join(BACKUP_DIR, file);
  if (!file.startsWith('links-') || !file.endsWith('.json') || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Backup não encontrado' });
  }
  try {
    // Faz backup do estado atual antes de restaurar, por segurança
    createBackup();
    const raw = fs.readFileSync(filePath, 'utf-8');
    const restoredLinks = JSON.parse(raw);
    writeLinks(restoredLinks);
    res.json({ success: true, count: restoredLinks.length });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao restaurar backup' });
  }
});

// --- Estatísticas ---
app.get('/api/stats', (req, res) => {
  const links = readLinks();
  const tagCounts = new Map();
  let favoriteCount = 0;
  let brokenCount = 0;
  let okCount = 0;
  let uncheckedCount = 0;
  const byMonth = new Map();
  const byDomain = new Map();

  links.forEach(l => {
    if (l.favorite) favoriteCount++;

    if (l.linkStatus === 'broken') brokenCount++;
    else if (l.linkStatus === 'ok') okCount++;
    else uncheckedCount++;

    (l.tags || []).forEach(t => tagCounts.set(t, (tagCounts.get(t) || 0) + 1));

    const month = (l.createdAt || '').slice(0, 7); // YYYY-MM
    if (month) byMonth.set(month, (byMonth.get(month) || 0) + 1);

    try {
      const host = new URL(l.url).hostname.replace(/^www\./, '');
      byDomain.set(host, (byDomain.get(host) || 0) + 1);
    } catch {}
  });

  const topTags = Array.from(tagCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([tag, count]) => ({ tag, count }));

  const topDomains = Array.from(byDomain.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([domain, count]) => ({ domain, count }));

  const addedByMonth = Array.from(byMonth.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, count]) => ({ month, count }));

  res.json({
    total: links.length,
    favorites: favoriteCount,
    linkHealth: { ok: okCount, broken: brokenCount, unchecked: uncheckedCount },
    topTags,
    topDomains,
    addedByMonth,
    totalTags: tagCounts.size,
  });
});

// Health check (útil para Docker healthcheck)
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

let checkInProgress = false;

app.listen(PORT, () => {
  console.log(`Nós — Gestor de Links a correr em http://localhost:${PORT}`);

  // Backup ao arrancar, e depois periodicamente (diário)
  createBackup();
  setInterval(createBackup, 24 * 60 * 60 * 1000);

  // Verificação de links mortos ao arrancar (com atraso, para não atrasar o boot) e depois periodicamente
  setTimeout(() => {
    checkInProgress = true;
    checkAllLinks().catch(err => console.error('[link-check] erro:', err)).finally(() => { checkInProgress = false; });
  }, 15_000);
  setInterval(() => {
    if (checkInProgress) return;
    checkInProgress = true;
    checkAllLinks().catch(err => console.error('[link-check] erro:', err)).finally(() => { checkInProgress = false; });
  }, LINK_CHECK_INTERVAL_MS);
});
