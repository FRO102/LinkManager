const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'links.json');

// Garante que a pasta de dados e o ficheiro existem
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]', 'utf-8');

app.use(express.json());
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

// --- Rotas da API ---

// Listar todos os links (com filtros opcionais via query params)
app.get('/api/links', (req, res) => {
  let links = readLinks();
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

  // Mais recentes primeiro
  links.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  res.json(links);
});

// Obter um link específico
app.get('/api/links/:id', (req, res) => {
  const links = readLinks();
  const link = links.find(l => l.id === req.params.id);
  if (!link) return res.status(404).json({ error: 'Link não encontrado' });
  res.json(link);
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
  const newLink = {
    id: crypto.randomUUID(),
    title: title.trim(),
    url: url.trim(),
    description: (description || '').trim(),
    tags: Array.isArray(tags) ? tags.filter(Boolean) : [],
    favorite: !!favorite,
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

// Health check (útil para Docker healthcheck)
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`Link Manager a correr em http://localhost:${PORT}`);
});
