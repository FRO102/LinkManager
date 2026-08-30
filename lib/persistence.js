'use strict';

const db = require('./db');

// --- Row <-> API object mapping ---
function rowToLink(row, tags) {
  return {
    id: row.id,
    title: row.title,
    url: row.url,
    description: row.description,
    tags: tags || [],
    favorite: !!row.favorite,
    order: row.order,
    linkStatus: row.link_status,
    linkStatusCode: row.link_status_code,
    linkStatusError: row.link_status_error,
    lastCheckedAt: row.last_checked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const stmts = {
  allLinks: db.prepare('SELECT * FROM links ORDER BY "order" ASC'),
  linkById: db.prepare('SELECT * FROM links WHERE id = ?'),
  tagsForLink: db.prepare(`
    SELECT t.name FROM tags t
    JOIN link_tags lt ON lt.tag_id = t.id
    WHERE lt.link_id = ?
    ORDER BY lt.position ASC
  `),
  allLinkTagPairs: db.prepare(`
    SELECT lt.link_id AS linkId, t.name AS name FROM link_tags lt
    JOIN tags t ON t.id = lt.tag_id
    ORDER BY lt.position ASC
  `),
  insertLink: db.prepare(`
    INSERT INTO links (id, title, url, description, favorite, "order", link_status, link_status_code, link_status_error, last_checked_at, created_at, updated_at)
    VALUES (@id, @title, @url, @description, @favorite, @order, @linkStatus, @linkStatusCode, @linkStatusError, @lastCheckedAt, @createdAt, @updatedAt)
  `),
  deleteLink: db.prepare('DELETE FROM links WHERE id = ?'),
  deleteAllLinks: db.prepare('DELETE FROM links'),
  insertTagIfMissing: db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)'),
  getTagId: db.prepare('SELECT id FROM tags WHERE name = ?'),
  linkTag: db.prepare('INSERT OR IGNORE INTO link_tags (link_id, tag_id, position) VALUES (?, ?, ?)'),
  clearLinkTags: db.prepare('DELETE FROM link_tags WHERE link_id = ?'),
  deleteOrphanTags: db.prepare(`
    DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM link_tags)
  `),
  maxOrder: db.prepare('SELECT MAX("order") AS maxOrder FROM links'),
};

function attachTags(links) {
  if (links.length === 0) return links;
  const pairs = stmts.allLinkTagPairs.all();
  const byLink = new Map();
  pairs.forEach(({ linkId, name }) => {
    if (!byLink.has(linkId)) byLink.set(linkId, []);
    byLink.get(linkId).push(name);
  });
  links.forEach(l => {
    // Preserves the order tags were added in (via the position column),
    // matching the original json-file behavior where tags were just a plain
    // JS array kept in insertion order — rather than sorting alphabetically,
    // which would be a silent behavior change for API consumers.
    l.tags = byLink.get(l.id) || [];
  });
  return links;
}

function setTagsForLink(linkId, tagNames) {
  stmts.clearLinkTags.run(linkId);
  const unique = [...new Set((tagNames || []).filter(Boolean))];
  let position = 0;
  unique.forEach((name) => {
    stmts.insertTagIfMissing.run(name);
    const tagId = stmts.getTagId.get(name).id;
    stmts.linkTag.run(linkId, tagId, position++);
  });
}

// --- Legacy array-based interface ---
// Kept so routes written against "the whole collection is a JS array" (the
// original json-file model) keep working unchanged: readLinks() hydrates
// every row (+ tags) into that same shape, and writeLinks() replaces the
// entire table content to match whatever array is passed back in. This is
// intentionally not the most efficient way to talk to a real database — see
// the direct SQL functions below, which the hotter routes use instead — but
// it's what lets the bulk of the existing route code stay as-is.
function readLinks() {
  const rows = stmts.allLinks.all();
  const links = rows.map(r => rowToLink(r, []));
  return attachTags(links);
}

const writeLinksTxn = db.transaction((links) => {
  stmts.deleteAllLinks.run(); // ON DELETE CASCADE clears link_tags too
  links.forEach((l) => {
    stmts.insertLink.run({
      id: l.id,
      title: l.title,
      url: l.url,
      description: l.description || '',
      favorite: l.favorite ? 1 : 0,
      order: l.order ?? 0,
      linkStatus: l.linkStatus ?? null,
      linkStatusCode: l.linkStatusCode ?? null,
      linkStatusError: l.linkStatusError ?? null,
      lastCheckedAt: l.lastCheckedAt ?? null,
      createdAt: l.createdAt,
      updatedAt: l.updatedAt,
    });
    setTagsForLink(l.id, l.tags);
  });
  stmts.deleteOrphanTags.run();
});

// Kept async (Promise-returning) for API compatibility with callers that
// `await writeLinks(...)` or chain `.then()` on it, even though
// better-sqlite3 itself is synchronous under the hood.
function writeLinks(links) {
  return Promise.resolve().then(() => writeLinksTxn(links));
}

// --- Direct SQL helpers ---
// Used by routes that don't need to load the whole collection just to
// operate on one link or a filtered subset — the actual benefit of moving
// off a single JSON file.

function getLinkById(id) {
  const row = stmts.linkById.get(id);
  if (!row) return null;
  return rowToLink(row, stmts.tagsForLink.all(id).map(r => r.name));
}

function insertLink(link) {
  stmts.insertLink.run({
    id: link.id,
    title: link.title,
    url: link.url,
    description: link.description || '',
    favorite: link.favorite ? 1 : 0,
    order: link.order ?? 0,
    linkStatus: link.linkStatus ?? null,
    linkStatusCode: link.linkStatusCode ?? null,
    linkStatusError: link.linkStatusError ?? null,
    lastCheckedAt: link.lastCheckedAt ?? null,
    createdAt: link.createdAt,
    updatedAt: link.updatedAt,
  });
  setTagsForLink(link.id, link.tags);
  return getLinkById(link.id);
}

function nextOrderValue() {
  const row = stmts.maxOrder.get();
  return (row.maxOrder ?? -1) + 1;
}

function deleteLinkById(id) {
  const info = stmts.deleteLink.run(id); // ON DELETE CASCADE clears link_tags
  if (info.changes > 0) stmts.deleteOrphanTags.run();
  return info.changes > 0;
}

module.exports = {
  readLinks,
  writeLinks,
  getLinkById,
  insertLink,
  deleteLinkById,
  nextOrderValue,
  attachTags,
  setTagsForLink,
  rowToLink,
  stmts,
};
