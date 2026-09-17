'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeUrlForCompare, parseBookmarksHtml } = require('../lib/url-utils');

describe('normalizeUrlForCompare', () => {
  test('removes www. and trailing slashes', () => {
    assert.equal(normalizeUrlForCompare('https://www.google.com/'), 'google.com');
    assert.equal(normalizeUrlForCompare('http://google.com/'), 'google.com');
    assert.equal(normalizeUrlForCompare('https://www.example.com/path/'), 'example.com/path');
    assert.equal(normalizeUrlForCompare('https://example.com/path'), 'example.com/path');
  });

  test('preserves query strings', () => {
    assert.equal(normalizeUrlForCompare('https://www.google.com/search?q=claude'), 'google.com/search?q=claude');
    assert.equal(normalizeUrlForCompare('http://example.com/page?id=123&sort=desc'), 'example.com/page?id=123&sort=desc');
  });

  test('is case-insensitive', () => {
    assert.equal(normalizeUrlForCompare('HTTPS://WWW.Google.Com/'), 'google.com');
    assert.equal(normalizeUrlForCompare('https://Example.Com/Path'), 'example.com/path');
  });

  test('handles invalid URLs gracefully (fallback to lowercase)', () => {
    assert.equal(normalizeUrlForCompare('not-a-url'), 'not-a-url');
    assert.equal(normalizeUrlForCompare('Some Random Text'), 'some random text');
  });
});

describe('parseBookmarksHtml', () => {
  test('extracts simple bookmarks', () => {
    const html = '<DT><A HREF="https://google.com">Google</A>';
    const result = parseBookmarksHtml(html);
    assert.equal(result.length, 1);
    assert.equal(result[0].url, 'https://google.com');
    assert.equal(result[0].title, 'Google');
    assert.deepEqual(result[0].tags, []);
  });

  test('extracts bookmarks with Firefox tags', () => {
    const html = '<DT><A HREF="https://github.com" TAGS="coding,git">GitHub</A>';
    const result = parseBookmarksHtml(html);
    assert.equal(result.length, 1);
    assert.equal(result[0].url, 'https://github.com');
    assert.deepEqual(result[0].tags, ['coding', 'git']);
  });

  test('handles multiple bookmarks and mixed content', () => {
    const html = `
      <DL><P>
        <DT><A HREF="https://a.com">A</A>
        <DT><A HREF="https://b.com" TAGS="t1">B</A>
        <DT><A HREF="invalid-url">Invalid</A>
        <DT><A HREF="https://c.com">C</A>
      </P></DL>
    `;
    const result = parseBookmarksHtml(html);
    // Invalid URL should be skipped by isValidUrl check in parseBookmarksHtml
    assert.equal(result.length, 3);
    assert.equal(result[0].url, 'https://a.com');
    assert.equal(result[1].url, 'https://b.com');
    assert.equal(result[2].url, 'https://c.com');
  });

  test('handles empty or malformed HTML', () => {
    assert.deepEqual(parseBookmarksHtml(''), []);
    assert.deepEqual(parseBookmarksHtml('<div>No links here</div>'), []);
    assert.deepEqual(parseBookmarksHtml('<A HREF="https://example.com">Missing closing tag'), []);
  });
});
