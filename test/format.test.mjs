import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatChunks, markdownToHtml, stripMarkdown } from '../telegram-format.mjs';

test('markdown renders as Telegram HTML with escaped text', () => {
  const html = markdownToHtml('**Saturday, 21 November** is free.\n\n[Check buses](https://example.com/a?b=1&c=2) and `code` <script>');
  assert.match(html, /<b>Saturday, 21 November<\/b>/);
  assert.match(html, /<a href="https:\/\/example\.com\/a\?b=1&amp;c=2">Check buses<\/a>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /\*\*/);
  assert.doesNotMatch(html, /\]\(/);
});

test('plain fallback keeps readable text instead of markup', () => {
  assert.equal(stripMarkdown('**Bold** and [site](https://example.com)'), 'Bold and site (https://example.com)');
  assert.equal(stripMarkdown('- one\n- two'), '• one\n• two');
});

test('chunks stay under the Telegram limit with balanced tags', () => {
  const source = Array.from({ length: 200 }, (_, index) => `**Line ${index}** with enough words to fill the line`).join('\n');
  const chunks = formatChunks(source);
  assert.ok(chunks.length > 1, 'long replies must split');
  for (const chunk of chunks) {
    assert.ok(chunk.html.length <= 4096, `chunk too large: ${chunk.html.length}`);
    assert.equal((chunk.html.match(/<b>/g) || []).length, (chunk.html.match(/<\/b>/g) || []).length);
    assert.ok(chunk.plain.length > 0);
  }
  assert.deepEqual(formatChunks(''), []);
});

test('escaped text and long links never exceed the Telegram limit', () => {
  const source = `[Details](https://example.com/${'a'.repeat(3300)}) ${'&'.repeat(1200)}`;
  const chunks = formatChunks(source);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.html.length <= 3500);
    assert.ok(chunk.plain.length <= 3500);
  }
});
