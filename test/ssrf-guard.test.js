'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { isPrivateOrReservedIp, isValidUrl } = require('../lib/ssrf-guard');

describe('isPrivateOrReservedIp — IPv4', () => {
  test('flags private ranges', () => {
    assert.equal(isPrivateOrReservedIp('10.0.0.1'), true);
    assert.equal(isPrivateOrReservedIp('172.16.0.1'), true);
    assert.equal(isPrivateOrReservedIp('172.31.255.255'), true);
    assert.equal(isPrivateOrReservedIp('192.168.1.1'), true);
    assert.equal(isPrivateOrReservedIp('127.0.0.1'), true);
    assert.equal(isPrivateOrReservedIp('169.254.169.254'), true); // cloud metadata
    assert.equal(isPrivateOrReservedIp('0.0.0.0'), true);
  });

  test('does not flag public addresses', () => {
    assert.equal(isPrivateOrReservedIp('8.8.8.8'), false);
    assert.equal(isPrivateOrReservedIp('1.1.1.1'), false);
    assert.equal(isPrivateOrReservedIp('172.15.0.1'), false); // just outside 172.16.0.0/12
    assert.equal(isPrivateOrReservedIp('172.32.0.1'), false); // just outside 172.16.0.0/12
  });
});

describe('isPrivateOrReservedIp — IPv6 (regression: stack overflow bug)', () => {
  // Regression test: an operator-precedence bug in the original implementation
  // combined `||` with `? :` such that `::1`, `fe80::`, `fc`/`fd`-prefixed
  // addresses recursed into isPrivateOrReservedIp() with the SAME unmodified
  // string (since .replace('::ffff:', '') is a no-op when that substring
  // isn't present), causing infinite recursion and a RangeError: Maximum
  // call stack size exceeded. Every case here must both terminate and
  // return the correct boolean, not just avoid throwing.

  test('loopback (::1) is flagged without throwing', () => {
    assert.doesNotThrow(() => isPrivateOrReservedIp('::1'));
    assert.equal(isPrivateOrReservedIp('::1'), true);
  });

  test('link-local (fe80::/10) is flagged without throwing', () => {
    assert.doesNotThrow(() => isPrivateOrReservedIp('fe80::1'));
    assert.equal(isPrivateOrReservedIp('fe80::1'), true);
    assert.equal(isPrivateOrReservedIp('FE80::1'), true); // case-insensitive
  });

  test('unique local (fc00::/7, both fc and fd) is flagged without throwing', () => {
    assert.doesNotThrow(() => isPrivateOrReservedIp('fc00::1'));
    assert.equal(isPrivateOrReservedIp('fc00::1'), true);
    assert.doesNotThrow(() => isPrivateOrReservedIp('fd12:3456::1'));
    assert.equal(isPrivateOrReservedIp('fd12:3456::1'), true);
  });

  test('IPv4-mapped IPv6 addresses recurse into the IPv4 check correctly', () => {
    assert.doesNotThrow(() => isPrivateOrReservedIp('::ffff:127.0.0.1'));
    assert.equal(isPrivateOrReservedIp('::ffff:127.0.0.1'), true); // mapped loopback -> private
    assert.equal(isPrivateOrReservedIp('::ffff:10.0.0.1'), true); // mapped private -> private
    assert.equal(isPrivateOrReservedIp('::ffff:8.8.8.8'), false); // mapped public -> public
  });

  test('public IPv6 addresses are not flagged', () => {
    assert.equal(isPrivateOrReservedIp('2001:4860:4860::8888'), false); // Google DNS
    assert.equal(isPrivateOrReservedIp('2606:4700:4700::1111'), false); // Cloudflare DNS
  });
});

describe('isValidUrl', () => {
  test('accepts http and https', () => {
    assert.equal(isValidUrl('http://example.com'), true);
    assert.equal(isValidUrl('https://example.com/path?q=1'), true);
  });

  test('rejects other protocols and malformed URLs', () => {
    assert.equal(isValidUrl('ftp://example.com'), false);
    assert.equal(isValidUrl('javascript:alert(1)'), false);
    assert.equal(isValidUrl('not a url'), false);
    assert.equal(isValidUrl(''), false);
  });
});
