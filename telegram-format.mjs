// Telegram only renders a small subset of markup, and only when parse_mode is set.
// Models write Markdown, so convert it to Telegram-safe HTML, chunk it under the
// 4096 character limit, and keep a plain-text version for the fallback path.

export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

const PLACEHOLDER = /\u0000(\d+)\u0000/g;

export function markdownToHtml(source) {
  const stash = [];
  const keep = html => { stash.push(html); return `\u0000${stash.length - 1}\u0000`; };
  let text = String(source ?? '').replace(/\r\n/g, '\n');
  text = text.replace(/```[^\n]*\n([\s\S]*?)```/g, (_, body) => keep(`<pre>${escapeHtml(body.replace(/\n$/, ''))}</pre>`));
  text = text.replace(/`([^`\n]{1,300})`/g, (_, body) => keep(`<code>${escapeHtml(body)}</code>`));
  text = text.replace(/\[([^\]\n]{1,160})\]\(\s*(https?:\/\/[^\s)]+)\s*\)/g, (_, label, url) => keep(`<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`));
  text = escapeHtml(text);
  text = text.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');
  text = text.replace(/\*\*([^*\n]{1,400})\*\*/g, '<b>$1</b>');
  text = text.replace(/__([^_\n]{1,400})__/g, '<b>$1</b>');
  text = text.replace(/(^|[\s(])\*([^*\n]{1,200})\*(?=[\s).,!?:;]|$)/g, '$1<i>$2</i>');
  text = text.replace(/(^|[\s(])_([^_\n]{1,200})_(?=[\s).,!?:;]|$)/g, '$1<i>$2</i>');
  text = text.replace(/~~([^~\n]{1,200})~~/g, '<s>$1</s>');
  text = text.replace(/^\s*[-*•]\s+/gm, '• ');
  text = text.replace(/^\s*>\s?/gm, '│ ');
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.replace(PLACEHOLDER, (_, index) => stash[Number(index)] ?? '');
  return text.trim();
}

export function stripMarkdown(source) {
  let text = String(source ?? '').replace(/\r\n/g, '\n');
  text = text.replace(/```[^\n]*\n([\s\S]*?)```/g, (_, body) => body);
  text = text.replace(/`([^`\n]+)`/g, '$1');
  text = text.replace(/\[([^\]\n]+)\]\((https?:[^\s)]+)\)/g, '$1 ($2)');
  text = text.replace(/^#{1,6}\s+/gm, '');
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '$1');
  text = text.replace(/__([^_\n]+)__/g, '$1');
  text = text.replace(/~~([^~\n]+)~~/g, '$1');
  text = text.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1$2');
  text = text.replace(/(^|[\s(])_([^_\n]+)_/g, '$1$2');
  text = text.replace(/^\s*[-*•]\s+/gm, '• ');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

function splitLongLine(line, limit) {
  const pieces = [];
  let rest = line;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf(' ', limit);
    if (cut < limit * 0.5) cut = limit;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

// Split on paragraph boundaries so every chunk has balanced tags on its own.
export function formatChunks(markdown, limit = 3500) {
  const source = String(markdown ?? '').replace(/\r\n/g, '\n');
  if (!source.trim()) return [];
  const blocks = [];
  let current = '';
  for (const line of source.split('\n')) {
    if (line.length > limit) {
      if (current) { blocks.push(current); current = ''; }
      blocks.push(...splitLongLine(line, limit));
      continue;
    }
    if (current && current.length + line.length + 1 > limit) { blocks.push(current); current = ''; }
    current += (current ? '\n' : '') + line;
  }
  if (current) blocks.push(current);
  return blocks.filter(block => block.trim()).flatMap(block => {
    const html = markdownToHtml(block), plain = stripMarkdown(block);
    if (html.length <= limit && plain.length <= limit) return [{ html, plain }];
    // A link or escaped text can expand after Markdown is converted to HTML.
    // Fall back to plain text for just this oversized block, with each piece safe.
    const pieces = [];
    let current = '', encodedLength = 0;
    for (const character of plain) {
      const size = escapeHtml(character).length;
      if (encodedLength + size > limit && current) {
        pieces.push({ html: escapeHtml(current), plain: current });
        current = ''; encodedLength = 0;
      }
      current += character; encodedLength += size;
    }
    if (current) pieces.push({ html: escapeHtml(current), plain: current });
    return pieces;
  });
}
