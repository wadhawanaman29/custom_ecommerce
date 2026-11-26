// Lightweight port of WordPress wpautop(): converts double line breaks into <p> paragraphs.
// Block-editor (Gutenberg) content is returned untouched except for stripping block comments,
// which matches what the_content renders.
const BLOCK = '(?:table|thead|tfoot|caption|col|colgroup|tbody|tr|td|th|div|dl|dd|dt|ul|ol|li|pre|form|map|area|blockquote|address|math|style|p|h[1-6]|hr|fieldset|legend|section|article|aside|hgroup|header|footer|nav|figure|figcaption|details|menu|summary)';

function wpautop(text) {
  if (!text || !String(text).trim()) return '';
  let pee = String(text);
  if (pee.includes('<!-- wp:')) {
    return `${pee.replace(/<!--\s*\/?wp:[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n').trim()}\n`;
  }
  const pres = [];
  pee = pee.replace(/<pre[\s\S]*?<\/pre>/gi, (m) => { pres.push(m); return `<pre wp-pre-tag-${pres.length - 1}></pre>`; });
  pee = `${pee}\n`;
  pee = pee.replace(/<br\s*\/?>\s*<br\s*\/?>/gi, '\n\n');
  pee = pee.replace(new RegExp(`(<${BLOCK}[\\s/>])`, 'gi'), '\n\n$1');
  pee = pee.replace(new RegExp(`(</${BLOCK}>)`, 'gi'), '$1\n\n');
  pee = pee.replace(/\r\n|\r/g, '\n');
  pee = pee.replace(/\n\n+/g, '\n\n');
  const parts = pee.split(/\n\s*\n/).filter((p) => p.trim());
  pee = parts.map((p) => `<p>${p.trim()}</p>\n`).join('');
  pee = pee.replace(/<p>\s*<\/p>/g, '');
  pee = pee.replace(new RegExp(`<p>\\s*(</?${BLOCK}[^>]*>)\\s*</p>`, 'gi'), '$1');
  pee = pee.replace(new RegExp(`<p>\\s*(</?${BLOCK}[^>]*>)`, 'gi'), '$1');
  pee = pee.replace(new RegExp(`(</?${BLOCK}[^>]*>)\\s*</p>`, 'gi'), '$1');
  pee = pee.replace(/(?<!<br \/>)\s*\n(?!\s*<\/?(?:p|div|ul|ol|li|table|tr|td|th|h[1-6]|blockquote|pre)[\s>])/g, '<br />\n');
  pee = pee.replace(new RegExp(`(</?${BLOCK}[^>]*>)\\s*<br />`, 'gi'), '$1');
  pee = pee.replace(/<pre wp-pre-tag-(\d+)><\/pre>/g, (m, i) => pres[Number(i)]);
  return pee;
}

function stripTags(html) {
  return String(html || '').replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

// wp_trim_excerpt(): 55 words + " [&hellip;]"
function autoExcerpt(content, words = 55) {
  const text = stripTags(String(content || '').replace(/\[[^\]]+\]/g, ''));
  const list = text.split(' ').filter(Boolean);
  if (!list.length) return '';
  const trimmed = list.length > words ? `${list.slice(0, words).join(' ')} [&hellip;]` : list.join(' ');
  return `<p>${trimmed}</p>\n`;
}

module.exports = { wpautop, autoExcerpt, stripTags };
