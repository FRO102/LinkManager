'use strict';

const { isValidUrl } = require('./ssrf-guard');

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

// --- Import: HTML bookmarks (Netscape Bookmark format, used by Chrome/Firefox) ---
function parseBookmarksHtml(html) {
  const results = [];
  const linkRe = /<A[^>]+HREF="([^"]+)"[^>]*>([^<]*)<\/A>/gi;
  let match;
  while ((match = linkRe.exec(html)) !== null) {
    const url = match[1];
    const title = match[2].trim();
    if (!isValidUrl(url)) continue;
    // Try to extract TAGS="..." if present (Firefox exports this)
    const fullTag = match[0];
    const tagsMatch = fullTag.match(/TAGS="([^"]*)"/i);
    const tags = tagsMatch ? tagsMatch[1].split(',').map(t => t.trim()).filter(Boolean) : [];
    results.push({ url, title: title || url, tags });
  }
  return results;
}

module.exports = { normalizeUrlForCompare, parseBookmarksHtml };
