'use strict';

const { OG_FETCH_TIMEOUT_MS, OG_CACHE_TTL_MS, OG_CACHE_FAILURE_TTL_MS, CHECK_USER_AGENT } = require('./config');
const { assertSafeToFetch } = require('./ssrf-guard');

// --- Open Graph scraping (lightweight, regex-based — no extra dependencies) ---
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
  try {
    await assertSafeToFetch(url);
  } catch {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OG_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': CHECK_USER_AGENT },
    });
    clearTimeout(timeout);
    if (!res.ok) return null;

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) return null;

    // Only reads the first ~100KB — enough for the <head> on the vast majority of sites
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

// Simple in-memory cache so we don't re-fetch OG data repeatedly in the same
// session. A failed fetch (data === null — network error, timeout, blocked
// by the SSRF guard, non-HTML content, etc.) is cached for a much shorter
// OG_CACHE_FAILURE_TTL_MS rather than the full success TTL: otherwise a
// transient outage (the site was down for a minute) would leave the preview
// looking broken for the entire hour, even once the site recovers.
const ogCache = new Map();

async function getOgDataCached(url) {
  const cached = ogCache.get(url);
  if (cached) {
    const ttl = cached.data === null ? OG_CACHE_FAILURE_TTL_MS : OG_CACHE_TTL_MS;
    if (Date.now() - cached.ts < ttl) return cached.data;
  }
  const data = await fetchOgData(url);
  ogCache.set(url, { data, ts: Date.now() });
  return data;
}

module.exports = { fetchOgData, getOgDataCached };
