'use strict';

const dns = require('dns').promises;
const net = require('net');

function isValidUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// --- SSRF protection for server-initiated fetches (link checking, OG preview) ---
// The server fetches whatever URL a link points to, including ones that arrived
// via import. Without this, a crafted URL could probe internal services or cloud
// metadata endpoints (e.g. 169.254.169.254) from the server's own network.
function isPrivateOrReservedIp(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    if (p.length !== 4 || p.some(n => Number.isNaN(n))) return true; // malformed — treat as unsafe
    return (
      p[0] === 10 ||                                   // 10.0.0.0/8
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||     // 172.16.0.0/12
      (p[0] === 192 && p[1] === 168) ||                 // 192.168.0.0/16
      p[0] === 127 ||                                   // loopback
      (p[0] === 169 && p[1] === 254) ||                 // link-local / cloud metadata
      p[0] === 0                                        // "this network"
    );
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::1') return true;                          // loopback
    if (lower.startsWith('fe80:')) return true;                 // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local (fc00::/7)
    if (lower.startsWith('::ffff:')) {
      // IPv4-mapped IPv6 address (e.g. "::ffff:127.0.0.1") — re-check the
      // embedded IPv4 address. This is the only case that recurses, and it
      // always strips the "::ffff:" prefix first, so the recursive call
      // receives a plain IPv4 string and terminates in the net.isIPv4()
      // branch above rather than re-entering this branch.
      return isPrivateOrReservedIp(lower.slice('::ffff:'.length));
    }
    return false;
  }
  return true; // unrecognized format — fail closed
}

// Note: this checks DNS resolution at call time. A sufficiently adversarial DNS
// setup could still rebind between this check and the subsequent fetch (TOCTOU);
// that's a known limitation of this lightweight approach, acceptable for a
// personal-use tool but worth knowing if this is ever exposed more broadly.
async function assertSafeToFetch(urlString) {
  const u = new URL(urlString);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('Unsupported protocol');
  }
  const hostname = u.hostname;
  // Literal IP in the URL — check directly
  if (net.isIP(hostname)) {
    if (isPrivateOrReservedIp(hostname)) throw new Error('Refusing to fetch a private/reserved address');
    return;
  }
  if (hostname === 'localhost') throw new Error('Refusing to fetch localhost');
  const records = await dns.lookup(hostname, { all: true });
  if (records.length === 0) throw new Error('Could not resolve host');
  if (records.some(r => isPrivateOrReservedIp(r.address))) {
    throw new Error('Refusing to fetch a host that resolves to a private/reserved address');
  }
}

module.exports = { isValidUrl, isPrivateOrReservedIp, assertSafeToFetch };
