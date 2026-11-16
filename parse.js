// parse.js — dependency-free markdown renderer.
//
// parse(markdown) returns exactly the HTML that marked 18.1.3's
// marked.parse(markdown) returns with its default options (gfm on, breaks
// off, pedantic off). The parser is written from the grammar, following the
// same block/inline tokenisation rules marked uses so the output is byte
// identical, but with its own scanning code and renderer.

/* =========================== character helpers =========================== */

const ENTITY = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const entityOf = (c) => ENTITY[c];

const ESCAPE_TEST = /[&<>"']/;
const ESCAPE_ALL = /[&<>"']/g;
const ESCAPE_TEST_SAFE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const ESCAPE_SAFE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const NUMERIC_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUMERIC_REF_ALL = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

/** HTML-escape like marked's escape(html, encode). */
function esc(s, encode) {
  // Most text needs no escaping at all; a quick test avoids the replace.
  if (encode) return ESCAPE_TEST.test(s) ? s.replace(ESCAPE_ALL, entityOf) : s;
  return ESCAPE_TEST_SAFE.test(s) ? s.replace(ESCAPE_SAFE, entityOf) : s;
}

/** Decode numeric character references in a text token, as marked does. */
function unescapeNumeric(s) {
  if (!NUMERIC_REF.test(s)) return s;
  return s.replace(NUMERIC_REF_ALL, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    if (code === 38) return '&amp;';
    return String.fromCodePoint(code);
  });
}

const HREF_UNSAFE = /[^ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789;,.!~*'()\-_$/?:@&=+#]/;

/** Percent-encode an href; null when encodeURI rejects it. */
function encodeHref(s) {
  if (!HREF_UNSAFE.test(s)) return s;
  try {
    return encodeURI(s).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

/** Normalise a link reference label (marked's exact case folding). */
function normalizeLabel(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

/** Strip trailing occurrences of one character (marked's rtrimChar). */
function stripTail(s, ch) {
  let n = s.length;
  while (n > 0 && s.charAt(n - 1) === ch) n--;
  return s.slice(0, n);
}

/** Drop trailing blank lines in the way marked does for code/html blocks. */
function trimBlock(s) {
  const lines = s.split('\n');
  let last = lines.length - 1;
  while (last >= 0 && /^[ \t]*$/.test(lines[last])) last--;
  return lines.length - last <= 2 ? s : lines.slice(0, last + 1).join('\n');
}

/** Expand tabs to the next multiple of four columns, starting at column `col`. */
function expandTabs(text, col = 0) {
  let out = '';
  let x = col;
  for (const ch of text) {
    if (ch === '\t') {
      const add = 4 - (x % 4);
      out += ' '.repeat(add);
      x += add;
    } else {
      out += ch;
      x++;
    }
  }
  return out;
}

/** marked's bracket balance scan: -2 when unbalanced open, index of the
 *  first unmatched closer otherwise, -1 when balanced/absent. */
function parenBalance(s, pair) {
  if (s.indexOf(pair[0]) === -1 && s.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === pair[0]) depth++;
    else if (s[i] === pair[1] && (depth--, depth < 0)) return i;
  }
  return depth > 0 ? -2 : -1;
}

/* ============================= block grammar ============================= */

const TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

const BLOCK = {
  newline: /^(?:[ \t]*(?:\n|$))+/,
  code: /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,
  fences: /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/,
  heading: /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,
  hr: /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/,
  blockquote: /^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(([^\n]+(?:\n(?! {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)|[ \t]+\n)[^\n]+)*))|[^\n]*)(?:\n|$))+/,
  html: /^ {0,3}(?:<(script|pre|style|textarea)[\s>][\s\S]*?(?:<\/\1>[^\n]*\n*|$)|<!--(?:-?>|[\s\S]*?(?:-->|$))[^\n]*(\n+|$)|<\?[\s\S]*?(?:\?>[^\n]*\n*|$)|<![A-Z][\s\S]*?(?:>[^\n]*\n*|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>[^\n]*\n*|$)|<\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t]+|\n|\/?>|$)[\s\S]*?(?:(?:\n[ 	]*)+\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?: +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?)*? *\/?>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ 	]*)+\n|$)|<\/[a-z][a-z0-9-]*\s*>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ 	]*)+\n|$))/i,
  def: /^ {0,3}\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)((?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))))? *(?:\n+|$)/,
  table: /^ *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n| {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>|(?: {4}| {0,3}	)[^\n]| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)).*(?:\n|$))*)\n*|$)/,
  list: /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/,
};

// BLOCK.hr without the leading anchor, for testing at a list cursor without
// slicing the remaining source.
const HR_STICKY = new RegExp(BLOCK.hr.source.slice(1), 'y');

const GF_BLOCK = {
  lheading: /^(?! {0,3}(?:[*+-]|\d{1,9}[.)]) |(?: {4}| {0,3}\t)| {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\s|$)| {0,3}<[^\n>]+>\n| {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n)((?:.|\n(?!\s*?\n| {0,3}(?:[*+-]|\d{1,9}[.)]) | {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\s|$)| {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}<[^\n>]+>\n| {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/,
  paragraph: /^([^\n]+(?:\n(?! {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)| *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n| {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>|(?: {4}| {0,3}	)[^\n]| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)).*(?:\n|$))*)\n*|$)|[ \t]+\n)[^\n]+)*)/,
};

const PUNCT = /^((?![*_])[\s\p{P}\p{S}])/u;
const ALNUM = /[\p{L}\p{N}]/u;
const PREV_WS = /\s/;

// Characters that terminate an inline text run in marked's text rule.
const TEXT_STOP = new Uint8Array(128);
for (const ch of '\\<![`*~_') TEXT_STOP[ch.charCodeAt(0)] = 1;
// Characters allowed in the local part of an e-mail address (text rule).
const EMAIL_CHAR = new Uint8Array(128);
for (const ch of "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.!#$%&'*+/=?_`{|}~-") EMAIL_CHAR[ch.charCodeAt(0)] = 1;

// Characters a bare autolink address may start with (the url rule's local part).
const LOCAL_PART = new Uint8Array(128);
for (const ch of 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._+-') LOCAL_PART[ch.charCodeAt(0)] = 1;

// Per-character flags for the inline text scan:
// 1 stops the run, 2 is a space, 4 starts a protocol, 8 is not alphanumeric,
// 16 is an e-mail address character, 32 needs HTML escaping.
const SCAN = new Uint8Array(128);
for (let c = 0; c < 128; c++) {
  if (TEXT_STOP[c] === 1) SCAN[c] = 1;
  if (c === 32) SCAN[c] |= 2;
  else if (c === 104 || c === 72 || c === 102 || c === 70 || c === 119) SCAN[c] |= 4;
  if (!(c >= 48 && c <= 57) && !(c >= 65 && c <= 90) && !(c >= 97 && c <= 122)) SCAN[c] |= 8;
  if (EMAIL_CHAR[c] === 1) SCAN[c] |= 16;
  if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) SCAN[c] |= 32;
}
const ANY_LINE = /\n.*\n/;

// Set by scanTextLength for the run it just measured: true when the run
// contains a character that esc() would rewrite. Invariant: every call with a
// non-empty source assigns it before returning (line at the top of the scan),
// and the only reader (inlineScan) reads it immediately after such a call with
// n > 0. parse() clears it, so a value can never outlive its run or its
// parse() call.
let TEXT_ESC = false;

// Same-length replacements for masked constructs, reused by length: masking
// visits every link, code span and tag in a source, and they repeat shapes.
const MASK_FILL = [];
const maskFill = (n) => MASK_FILL[n] || (MASK_FILL[n] = '[' + 'a'.repeat(n - 2) + ']');

const INLINE = {
  escape: /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/,
  tag: /^<!--(?:-?>|[\s\S]*?-->)|^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>/,
  link: /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\([ \t\n]*(<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\)))(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)))?[ \t\n]*\)/,
  reflink: /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]/,
  nolink: /^!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\](?:\[\])?/,
  reflinkSearch: /!?\[((?:[^\[\]\\`]*(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\]|!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\](?:\[\])?(?!\()/g,
  blockSkip: /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g,
  anyPunctuation: /\\([\p{P}\p{S}])/gu,
  anyPunctuationOutsideCode: /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu,
  code: /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,
  br: /^( {2,}|\\)\n(?!\s*$)[ \t]*/,
  del: /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/,
  delLDelim: /^~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/u,
  delRDelim: /^[^~]+(?=[^~])|(?!~)[\p{P}\p{S}](~~?)(?=[\s]|$)|[^\s\p{P}\p{S}](~~?)(?!~)(?=[\s\p{P}\p{S}]|$)|(?!~)[\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])|[\s](~~?)(?!~)(?=[\p{P}\p{S}])|(?!~)[\p{P}\p{S}](~~?)(?!~)(?=[\p{P}\p{S}])|[^\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])/gu,
  emStrongLDelim: /^(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|^_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/u,
  emStrongRDelimAst: /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?=[\s]|$)|(?:[^\s\p{P}\p{S}]|~)(\*+)(?!\*)(?=(?!~)[\s\p{P}\p{S}]|$)|(?!\*)(?!~)[\s\p{P}\p{S}](\*+)(?=(?:[^\s\p{P}\p{S}]|~))|[\s](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:[^\s\p{P}\p{S}]|~)(\*+)(?=(?:[^\s\p{P}\p{S}]|~))/gu,
  emStrongRDelimUnd: /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)[\p{P}\p{S}](_+)(?=[\s]|$)|[^\s\p{P}\p{S}](_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?!_)[\s\p{P}\p{S}](_+)(?=[^\s\p{P}\p{S}])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?!_)[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])/gu,
  autolink: /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/,
  url: /^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/,
  backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/,
  text: /^(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|[hH][tT][tT][pP][sS]?|[fF][tT][pP]:\/\/|(?<![^\s*_~(])www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/,
};

/** Length in code points of the delimiter run matched by a del/emStrong left
 *  delimiter match: the run minus one for the flanking punctuation char, the
 *  same way marked measures it with [...s[0]].length - 1. The run itself is
 *  pure ASCII, so only a trailing astral flanking char changes the count. */
function runLenCp(m0) {
  const n = m0.length;
  if (n > 1) {
    const h = m0.charCodeAt(n - 2);
    if (h >= 0xd800 && h <= 0xdbff) {
      const l = m0.charCodeAt(n - 1);
      if (l >= 0xdc00 && l <= 0xdfff) return n - 2;
    }
  }
  return n - 1;
}

/* ================================ lexer ================================= */

/** True when the line after the first could be a table delimiter row. */
function tableHeadPossible(src) {
  const nl1 = src.indexOf('\n');
  if (nl1 < 0) return false;
  let nl2 = src.indexOf('\n', nl1 + 1);
  if (nl2 < 0) nl2 = src.length;
  let seen = false;
  for (let i = nl1 + 1; i < nl2; i++) {
    const ch = src.charCodeAt(i);
    if (ch === 58 || ch === 124) seen = true;
    else if (ch !== 32 && ch !== 45) return false;
  }
  return seen;
}

/** True when some line after the first is a setext underline (a `=`/`-` run). */
function hasSetextUnderline(src) {
  const len = src.length;
  let i = src.indexOf('\n');
  while (i >= 0) {
    let j = i + 1;
    let sp = 0;
    while (j < len && src.charCodeAt(j) === 32 && sp < 4) { j++; sp++; }
    const ch = src.charCodeAt(j);
    if (sp <= 3 && (ch === 61 || ch === 45)) {
      let k = j + 1;
      while (k < len && src.charCodeAt(k) === ch) k++;
      let t = k;
      while (t < len && (src.charCodeAt(t) === 32 || src.charCodeAt(t) === 9)) t++;
      if (t === len || src.charCodeAt(t) === 10) return true;
    }
    // A blank line ends the paragraph a setext heading could be built from.
    let b = i + 1;
    while (b < len && (src.charCodeAt(b) === 32 || src.charCodeAt(b) === 9)) b++;
    if (b === len || src.charCodeAt(b) === 10) return false;
    i = src.indexOf('\n', i + 1);
  }
  return false;
}

class Lexer {
  constructor() {
    this.top = true;
    this.inLink = false;
    this.inRawBlock = false;
    this.linkEmitted = false;
    this.linkParenPossible = true;
    this.atPossible = true;
    this.links = Object.create(null);
    this.linkCount = 0;
    this.queue = [];
    this.maskFrame = null;
    this.itemRes = new Map();
    this.htmlRes = [];
  }

  lex(md) {
    const tokens = [];
    md = md.replace(/\r\n|\r/g, '\n');
    this.blockTokens(md, tokens);
    for (let i = 0; i < this.queue.length; i++) {
      const q = this.queue[i];
      this.inRawBlock = false;
      // A task-list checkbox is the only token ever placed in the array before
      // it is scanned (list() unshifts it and strips the marker from the src).
      const pre = q.tokens;
      let prefix = '';
      for (let j = 0; j < pre.length; j++) {
        if (pre[j].type === 'checkbox') {
          prefix += '<input ' + (pre[j].checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
        }
      }
      const html = prefix + this.inlineRender(q.src).html;
      pre.length = 0;
      pre.push({ type: 'html', text: html });
    }
    this.queue = [];
    return tokens;
  }

  /* ---------------- block tokenizers ---------------- */

  space(src) {
    const m = BLOCK.newline.exec(src);
    if (m && m[0].length > 0) return { type: 'space', raw: m[0] };
  }

  code(src) {
    const m = BLOCK.code.exec(src);
    if (!m) return;
    const raw = trimBlock(m[0]);
    return { type: 'code', raw, codeBlockStyle: 'indented', text: raw.replace(/^(?: {0,3}\t| {1,4})/gm, '') };
  }

  fences(src) {
    const m = BLOCK.fences.exec(src);
    if (!m) return;
    const raw = m[0];
    const text = stripIndent(raw, m[3] || '');
    return {
      type: 'code',
      raw,
      lang: m[2] ? m[2].trim().replace(INLINE.anyPunctuation, '$1') : m[2],
      text,
    };
  }

  heading(src) {
    const m = BLOCK.heading.exec(src);
    if (!m) return;
    let text = m[2].trim();
    if (/#$/.test(text)) {
      const withoutHash = stripTail(text, '#');
      if (!withoutHash || /[ \t]$/.test(withoutHash)) text = withoutHash.trim();
    }
    return {
      type: 'heading',
      raw: stripTail(m[0], '\n'),
      depth: m[1].length,
      text,
      tokens: this.inline(text),
    };
  }

  hr(src) {
    const m = BLOCK.hr.exec(src);
    if (m) return { type: 'hr', raw: stripTail(m[0], '\n') };
  }

  blockquote(src) {
    const m = BLOCK.blockquote.exec(src);
    if (!m) return;
    let lines = stripTail(m[0], '\n').split('\n');
    let rawText = '';
    let textText = '';
    const tokens = [];
    while (lines.length > 0) {
      let started = false;
      const group = [];
      let p;
      for (p = 0; p < lines.length; p++) {
        if (/^ {0,3}>/.test(lines[p])) {
          group.push(lines[p]);
          started = true;
        } else if (!started) {
          group.push(lines[p]);
        } else break;
      }
      lines = lines.slice(p);
      const shown = group.join('\n');
      const body = shown
        .replace(/^( {0,3}>)([ \t]+)/gm, (all, mark, ws) => mark + expandTabs(ws, mark.length))
        .replace(/\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g, '\n    $1')
        .replace(/^ {0,3}>[ \t]?/gm, '');
      rawText = rawText ? rawText + '\n' + shown : shown;
      textText = textText ? textText + '\n' + body : body;
      const savedTop = this.top;
      this.top = true;
      this.blockTokens(body, tokens, true);
      this.top = savedTop;
      if (lines.length === 0) break;
      const last = tokens[tokens.length - 1];
      if (last && (last.type === 'code' || last.type === 'heading' || last.type === 'hr' || last.type === 'html' || last.type === 'table')) break;
      if (last && last.type === 'blockquote') {
        const inner = last;
        const joined = lines.join('\n');
        const combined = inner.raw + '\n' + joined.replace(/^ {0,3}>[ \t]?/gm, '');
        const quoted = this.blockquote(combined);
        tokens[tokens.length - 1] = quoted;
        const rest = combined.substring(quoted.raw.length).replace(/^\n/, '');
        const used = rest ? rest.split('\n').length : 0;
        const take = used ? lines.slice(0, -used) : lines;
        if (take.length > 0) rawText += '\n' + take.join('\n');
        textText = textText.substring(0, textText.length - inner.text.length) + quoted.text;
        lines = lines.slice(take.length);
        if (lines.length > 0 && /^ {0,3}>/.test(lines[0])) continue;
        break;
      } else if (last && last.type === 'list') {
        const inner = last;
        const combined = inner.raw + '\n' + lines.join('\n');
        const relisted = this.list(combined);
        tokens[tokens.length - 1] = relisted;
        const extra = relisted.raw.length > inner.raw.length
          ? combined.slice(inner.raw.length + 1, relisted.raw.length).split('\n').length
          : 0;
        if (extra > 0) {
          const taken = lines.slice(0, extra).join('\n');
          rawText += '\n' + taken;
          textText += '\n' + taken;
        }
        lines = lines.slice(extra);
        continue;
      }
    }
    return { type: 'blockquote', raw: rawText, tokens, text: textText };
  }

  list(src) {
    const first = BLOCK.list.exec(src);
    if (!first) return;
    const whole = src;
    let pos = 0;
    let marker = first[1].trim();
    const ordered = marker.length > 1;
    const list = {
      type: 'list',
      raw: '',
      ordered,
      start: ordered ? +marker.slice(0, -1) : '',
      loose: false,
      items: [],
    };
    const markerSrc = ordered ? '\\d{1,9}\\' + marker.slice(-1) : '\\' + marker;
    const itemRe = this.itemRe(markerSrc);
    let crossedBlank = false;
    while (pos < whole.length) {
      let emptyStart = false;
      let text = '';
      itemRe.lastIndex = pos;
      const m = itemRe.exec(whole);
      HR_STICKY.lastIndex = pos;
      if (!m || HR_STICKY.test(whole)) break;
      const begin = pos;
      pos += m[0].length;
      const m2 = m[2];
      const nl0 = m2.indexOf('\n');
      const firstLine = nl0 < 0 ? m2 : m2.slice(0, nl0);
      const markerLen = m[1].length;
      let lead0 = 0;
      while (lead0 < firstLine.length) {
        const ch = firstLine.charCodeAt(lead0);
        if (ch !== 32 && ch !== 9) break;
        lead0++;
      }
      let content = lead0 === 0 ? firstLine : expandTabs(firstLine.slice(0, lead0), markerLen) + firstLine.slice(lead0);
      let nl = whole.indexOf('\n', pos);
      if (nl < 0) nl = whole.length;
      let nextLine = whole.slice(pos, nl);
      let blankFirst = !content.trim();
      let indent = 0;
      if (blankFirst) {
        indent = markerLen + 1;
      } else {
        indent = content.search(/[^ ]/);
        indent = indent > 4 ? 1 : indent;
        text = content.slice(indent);
        indent += markerLen;
      }
      if (blankFirst && /^[ \t]*$/.test(nextLine)) {
        pos = nl < whole.length ? nl + 1 : whole.length;
        emptyStart = true;
      }
      if (!emptyStart) {
        const n = Math.max(0, Math.min(3, indent - 1));
        const htmlRe = this.htmlRe(n);
        while (pos < whole.length) {
          nl = whole.indexOf('\n', pos);
          if (nl < 0) nl = whole.length;
          const line = whole.slice(pos, nl);
          // Leading spaces/tabs, with the first tab position kept for the
          // expansion decision, all in one pass.
          let lead = 0;
          let tabAt = -1;
          const lineLen = line.length;
          while (lead < lineLen) {
            const ch = line.charCodeAt(lead);
            if (ch === 32) lead++;
            else if (ch === 9) { if (tabAt < 0) tabAt = lead; lead++; }
            else break;
          }
          const blank = lead === lineLen;
          const expanded = tabAt >= 0 ? expandTabs(line.slice(0, lead)) + line.slice(lead) : line;
          if (startsBlockAt(line, n, htmlRe)) break;
          const width = blank ? expanded.length : tabAt >= 0 ? expandedWidth(line, lead) : lead;
          if (width >= indent || blank) {
            text += '\n' + expanded.slice(indent);
          } else {
            if (
              blankFirst ||
              content.replace(/\t/g, '    ').search(/[^ ]/) >= 4 ||
              startsContentAt(content, n, htmlRe)
            ) break;
            const setext = !/^ {0,3}(?:=+|-+) *$/.test(line) ? line
              : GF_BLOCK.lheading.test(content + '\n' + line) ? '    ' + expanded.replace(/^ {0,3}/, '') : line;
            text += '\n' + setext;
          }
          blankFirst = blank;
          pos = nl < whole.length ? nl + 1 : whole.length;
          content = expanded.slice(indent);
        }
      }
      const itemRaw = whole.slice(begin, pos);
      if (!list.loose) {
        if (crossedBlank) list.loose = true;
        else if (endsWithBlankLine(itemRaw)) crossedBlank = true;
      }
      list.items.push({
        type: 'list_item',
        raw: itemRaw,
        task: text.charCodeAt(0) === 91 && /^\[[ xX]\][ \t]+\S/.test(text),
        loose: false,
        text,
        tokens: [],
      });
    }
    const lastItem = list.items[list.items.length - 1];
    if (!lastItem) return;
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
    list.raw = whole.slice(0, pos).trimEnd();
    for (const item of list.items) {
      this.top = false;
      item.tokens = this.blockTokens(item.text, []);
      if (!list.loose) {
        const spaces = item.tokens.filter((t) => t.type === 'space');
        list.loose = spaces.length > 0 && spaces.some((t) => ANY_LINE.test(t.raw));
      }
    }
    for (const item of list.items) {
      const lead = item.tokens[0];
      if (item.task && lead && (lead.type === 'text' || lead.type === 'paragraph')) {
        item.text = item.text.replace(/^\[[ xX]\][ \t]+/, '');
        lead.raw = lead.raw.replace(/^\[[ xX]\][ \t]+/, '');
        lead.text = lead.text.replace(/^\[[ xX]\][ \t]+/, '');
        for (let g = this.queue.length - 1; g >= 0; g--) {
          if (/^\[[ xX]\][ \t]+\S/.test(this.queue[g].src)) {
            this.queue[g].src = this.queue[g].src.replace(/^\[[ xX]\][ \t]+/, '');
            break;
          }
        }
        const hit = /\[[ xX]\]/.exec(item.raw);
        if (hit) {
          const checkbox = { type: 'checkbox', raw: hit[0] + ' ', checked: hit[0] !== '[ ]' };
          item.checked = checkbox.checked;
          if (list.loose) {
            if (lead && (lead.type === 'paragraph' || lead.type === 'text') && lead.tokens) {
              lead.raw = checkbox.raw + lead.raw;
              lead.text = checkbox.raw + lead.text;
              lead.tokens.unshift(checkbox);
            } else {
              item.tokens.unshift({ type: 'paragraph', raw: checkbox.raw, text: checkbox.raw, tokens: [checkbox] });
            }
          } else {
            item.tokens.unshift(checkbox);
          }
        }
      } else if (item.task) {
        item.task = false;
      }
    }
    if (list.loose) {
      for (const item of list.items) {
        item.loose = true;
        for (const t of item.tokens) if (t.type === 'text') t.type = 'paragraph';
      }
    }
    return list;
  }

  html(src) {
    const m = BLOCK.html.exec(src);
    if (!m) return;
    const text = trimBlock(m[0]);
    return {
      type: 'html',
      block: true,
      raw: text,
      pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style',
      text,
    };
  }

  def(src) {
    const m = BLOCK.def.exec(src);
    if (!m) return;
    if (m[2].charAt(0) !== '<' && parenBalance(m[2], '()') !== -1) return;
    const tag = normalizeLabel(m[1]);
    const href = m[2] ? m[2].replace(/^<(.*)>$/, '$1').replace(INLINE.anyPunctuation, '$1') : '';
    const title = m[3] ? m[3].substring(1, m[3].length - 1).replace(INLINE.anyPunctuation, '$1') : m[3];
    return { type: 'def', tag, raw: stripTail(m[0], '\n'), href, title };
  }

  table(src) {
    const m = BLOCK.table.exec(src);
    if (!m || !/[:|]/.test(m[2])) return;
    const header = splitRow(m[1]);
    const alignSrc = m[2].replace(/^\||\| *$/g, '').split('|');
    const rowSrc = m[3] && m[3].trim() ? m[3].replace(/\n[ \t]*$/, '').split('\n') : [];
    const table = { type: 'table', raw: stripTail(m[0], '\n'), header: [], align: [], rows: [] };
    if (header.length !== alignSrc.length) return;
    for (const cell of alignSrc) {
      table.align.push(/^ *-+: *$/.test(cell) ? 'right' : /^ *:-+: *$/.test(cell) ? 'center' : /^ *:-+ *$/.test(cell) ? 'left' : null);
    }
    for (let i = 0; i < header.length; i++) {
      table.header.push({ text: header[i], tokens: this.inline(header[i]), header: true, align: table.align[i] });
    }
    for (const row of rowSrc) {
      table.rows.push(splitRow(row, table.header.length).map((cell, i) => ({
        text: cell,
        tokens: this.inline(cell),
        header: false,
        align: table.align[i],
      })));
    }
    return table;
  }

  lheading(src) {
    const m = GF_BLOCK.lheading.exec(src);
    if (!m) return;
    const text = m[1].trim();
    return {
      type: 'heading',
      raw: stripTail(m[0], '\n'),
      depth: m[2].charAt(0) === '=' ? 1 : 2,
      text,
      tokens: this.inline(text),
    };
  }

  /* ---------------- cached indent regexes ---------------- */

  itemRe(markerSrc) {
    let re = this.itemRes.get(markerSrc);
    if (!re) {
      // Sticky, not anchored: match at the current cursor of the whole source
      // instead of allocating a fresh slice for every item iteration.
      re = new RegExp('( {0,3}' + markerSrc + ')((?:[ \\t][^\\n]*)?(?:\\n|$))', 'y');
      this.itemRes.set(markerSrc, re);
    }
    return re;
  }

  htmlRe(n) {
    let re = this.htmlRes[n];
    if (!re) {
      re = new RegExp('^ {0,' + n + '}(?:</?(?:' + TAGS + ')(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)', 'i');
      this.htmlRes[n] = re;
    }
    return re;
  }

  /* ---------------- block loop ---------------- */

  blockTokens(src, tokens, joinParagraphs = false) {
    let marker = Infinity;
    while (src) {
      if (src.length < marker) marker = src.length;
      else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
      let tok;
      // Classify the head once: blank lines and indented lines can only be
      // these tokenizers, and the first non-space character limits the rest.
      // The tokenizers that remain run in marked's order.
      const len = src.length;
      let ws = 0;
      let tabAt = -1;
      let c = 10;
      while (ws < len) {
        c = src.charCodeAt(ws);
        if (c === 32) ws++;
        else if (c === 9) { if (tabAt < 0) tabAt = ws; ws++; }
        else break;
      }
      const blank = ws === len || c === 10;
      const indented = !blank && (ws >= 4 || (tabAt >= 0 && tabAt < 4));
      const fc = blank || indented ? -1 : c;
      if (blank && (tok = this.space(src))) {
        src = src.substring(tok.raw.length);
        const prev = tokens[tokens.length - 1];
        if (tok.raw.length === 1 && prev !== undefined) prev.raw += '\n';
        else tokens.push(tok);
        continue;
      }
      if (indented && (tok = this.code(src))) {
        src = src.substring(tok.raw.length);
        const prev = tokens[tokens.length - 1];
        if (prev && (prev.type === 'paragraph' || prev.type === 'text')) {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.text;
          this.queue[this.queue.length - 1].src = prev.text;
        } else tokens.push(tok);
        continue;
      }
      if ((fc === 96 || fc === 126) && (tok = this.fences(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if (fc === 35 && (tok = this.heading(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((fc === 45 || fc === 95 || fc === 42) && (tok = this.hr(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if (fc === 62 && (tok = this.blockquote(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((fc === 42 || fc === 43 || fc === 45 || (fc >= 48 && fc <= 57)) && (tok = this.list(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if (fc === 60 && (tok = this.html(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if (fc === 91 && (tok = this.def(src))) {
        src = src.substring(tok.raw.length);
        const prev = tokens[tokens.length - 1];
        if (prev && (prev.type === 'paragraph' || prev.type === 'text')) {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.raw;
          this.queue[this.queue.length - 1].src = prev.text;
        } else {
          if (!this.links[tok.tag]) {
            this.links[tok.tag] = { href: tok.href, title: tok.title };
            this.linkCount++;
          }
          tokens.push(tok);
        }
        continue;
      }
      if (tableHeadPossible(src) && (tok = this.table(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if (hasSetextUnderline(src) && (tok = this.lheading(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if (this.top) {
        // Paragraphs join onto the previous one without materialising a new
        // token or queue entry: both would be discarded by the merge.
        const m = GF_BLOCK.paragraph.exec(src);
        if (m) {
          const text = m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
          const raw = m[0];
          const prev = tokens[tokens.length - 1];
          if (joinParagraphs && prev && prev.type === 'paragraph') {
            prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + raw;
            prev.text += '\n' + text;
            this.queue[this.queue.length - 1].src = prev.text;
          } else {
            tokens.push({ type: 'paragraph', raw, text, tokens: this.inline(text) });
          }
          joinParagraphs = false;
          src = src.substring(raw.length);
          continue;
        }
      }
      // BLOCK.text is /^[^\n]+/; the loop guarantees a non-empty source that
      // does not start with a newline, so finding the line end is enough.
      const eol = src.indexOf('\n');
      const raw = eol < 0 ? src : src.slice(0, eol);
      const prev = tokens[tokens.length - 1];
      if (prev && prev.type === 'text') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + raw;
        prev.text += '\n' + raw;
        this.queue[this.queue.length - 1].src = prev.text;
      } else {
        tokens.push({ type: 'text', raw, text: raw, tokens: this.inline(raw) });
      }
      src = src.substring(raw.length);
      continue;
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
    this.top = true;
    return tokens;
  }

  inline(src, tokens = []) {
    this.queue.push({ src, tokens });
    return tokens;
  }

  /* ---------------- inline scanner/renderer ---------------- */

  /** Scan one inline source, returning its { html, plain } projections.
   *  `needPlain` is false when the caller only renders HTML, so the plain
   *  projection is not accumulated (except where an image alt text needs it). */
  inlineRender(src, needPlain = false) {
    const savedParen = this.linkParenPossible;
    const savedAt = this.atPossible;
    const savedNeed = this.needPlain;
    const savedFrame = this.maskFrame;
    // Nested renders always scan a substring of the enclosing source, so a
    // parent without "@" (or ")") settles the child without a rescan.
    this.linkParenPossible = savedParen && src.includes(')');
    this.atPossible = savedAt && src.includes('@');
    this.needPlain = needPlain;
    this.maskFrame = null;
    const hasAt = this.atPossible;
    // The mask frame is only created if a delimiter actually opens emphasis
    // or strikethrough, so sources without one never pay for it.
    try {
      return this.inlineScan(src, hasAt);
    } finally {
      this.maskFrame = savedFrame;
      this.linkParenPossible = savedParen;
      this.atPossible = savedAt;
      this.needPlain = savedNeed;
    }
  }

  /** The mask of a whole inline source, computed at most once per call. */
  maskOf(src) {
    let frame = this.maskFrame;
    if (frame === null) {
      // The mask only rewrites code spans, link text, tags and escapes.
      const needed = src.includes('`') || src.includes('[') || src.includes('<') || src.includes('\\');
      frame = this.maskFrame = { masked: needed ? this.buildMask(src) : src, em: null, del: -1 };
    }
    return frame.masked;
  }

  buildMask(src) {
    let t = src;
    if (this.linkCount !== 0 && src.includes('[') && src.includes(']')) t = this.maskReflinks(t);
    if (src.includes('`') || src.includes('\\')) {
      t = t.replace(INLINE.anyPunctuationOutsideCode, (all, ticks, punct) => {
        if (punct) return '+'.repeat(all.length);
        if (ticks) return ticks + all.slice(ticks.length, -ticks.length).replace(/`/g, '+') + ticks;
        return all;
      });
    }
    if (t.includes('[') || t.includes('`') || t.includes('<')) {
      t = t.replace(INLINE.blockSkip, (all) => maskFill(all.length));
    }
    return t;
  }

  maskReflinks(src) {
    const re = INLINE.reflinkSearch;
    const replaceOne = (match) => {
      const open = match.lastIndexOf('[');
      if (!Object.hasOwn(this.links, normalizeLabel(match.slice(open + 1, -1)))) return match;
      if (open > 1 && match.charAt(0) !== '!') {
        const body = match.slice(1, open - 1);
        if (this.linkInText(body)) {
          return '[' + body.replace(re, replaceOne) + '][' + 'a'.repeat(match.length - open - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(match.length - 2) + ']';
    };
    return src.replace(re, (all) => replaceOne(all));
  }

  linkInText(text) {
    if (!text.includes('[')) return false;
    const linkRe = INLINE.link;
    for (const m of text.matchAll(INLINE.blockSkip)) {
      if (linkRe.test(m[0]) && text.charAt(m.index - 1) !== '!') return true;
    }
    for (const m of text.matchAll(INLINE.reflinkSearch)) {
      const s = m[0];
      const open = s.lastIndexOf('[');
      if (!(s.charAt(0) === '!' || !Object.hasOwn(this.links, normalizeLabel(s.slice(open + 1, -1)))) && !(open > 1 && this.linkInText(s.slice(1, open - 1)))) return true;
    }
    return false;
  }

  inlineScan(src, hasAt) {
    const fullSrc = src;
    let html = '';
    let plain = '';
    const needPlain = this.needPlain;
    let wasText = false;
    let lastChar = '';
    let marker = Infinity;
    while (src) {
      if (src.length < marker) marker = src.length;
      else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
      if (!wasText) lastChar = '';
      wasText = false;

      // Only the tokenizers whose first character can match at this offset are
      // tried, in marked's order; everything else falls through to url/text.
      const c = src.charCodeAt(0);
      let tok;
      if (c === 92) {
        tok = this.escapeT(src) || this.brT(src);
      } else if (c === 60) {
        tok = this.tagT(src) || this.autolinkT(src);
      } else if (c === 91 || c === 33) {
        tok = this.linkT(src) || this.reflinkT(src);
      } else if (c === 42 || c === 95) {
        tok = this.emStrongT(src, fullSrc, lastChar);
      } else if (c === 96) {
        tok = this.codespanT(src);
      } else if (c === 126) {
        tok = this.delT(src, fullSrc, lastChar);
      } else if (c === 32) {
        tok = this.brT(src);
      }
      if (tok) {
        src = src.substring(tok.raw.length);
        html += tok.html;
        if (needPlain) plain += tok.plain;
        continue;
      }
      if (!this.inLink && this.urlPossible(src, c, hasAt) && (tok = this.urlT(src))) {
        src = src.substring(tok.raw.length);
        html += tok.html;
        if (needPlain) plain += tok.plain;
        continue;
      }
      const n = scanTextLength(src, hasAt);
      if (n > 0) {
        const raw = n === src.length ? src : src.slice(0, n);
        const escaped = this.inRawBlock;
        const text = escaped ? raw : raw.indexOf('&') < 0 ? raw : unescapeNumeric(raw);
        const last = raw.charCodeAt(raw.length - 1);
        src = src.substring(n);
        if (last !== 95) lastChar = raw.charAt(raw.length - 1);
        wasText = true;
        html += escaped || !TEXT_ESC ? text : esc(text);
        if (needPlain) plain += text;
        continue;
      }
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
    return { html, plain };
  }

  escapeT(src) {
    const m = INLINE.escape.exec(src);
    if (m) return { raw: m[0], html: esc(m[1]), plain: m[1] };
  }

  tagT(src) {
    const m = INLINE.tag.exec(src);
    if (!m) return;
    if (!this.inLink && /^<a /i.test(m[0])) this.inLink = true;
    else if (this.inLink && /^<\/a>/i.test(m[0])) this.inLink = false;
    if (!this.inRawBlock && /^<(pre|code|kbd|script)(\s|>)/i.test(m[0])) this.inRawBlock = true;
    else if (this.inRawBlock && /^<\/(pre|code|kbd|script)(\s|>)/i.test(m[0])) this.inRawBlock = false;
    return { raw: m[0], html: m[0], plain: m[0] };
  }

  linkT(src) {
    if (!this.linkParenPossible) return;
    const m = INLINE.link.exec(src);
    if (!m) return;
    const off = m[0].charAt(0) === '!' ? 2 : 1;
    if (this.hasTagAcross(src, m[1], off)) return;
    let href = m[2].trim();
    if (href.charAt(0) === '<') {
      if (href.charAt(href.length - 1) !== '>') return;
      const core = stripTail(href.slice(0, -1), '\\');
      if ((href.length - core.length) % 2 === 0) return;
    } else {
      const pos = parenBalance(m[2], '()');
      if (pos === -2) return;
      if (pos > -1) {
        const cut = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + pos;
        m[2] = m[2].substring(0, pos);
        m[0] = m[0].substring(0, cut).trim();
        m[3] = '';
      }
    }
    const back = stripTail(m[0].slice(0, -1), '\\');
    if ((m[0].length - back.length) % 2 === 0) return;
    let dest = m[2];
    const title = m[3] ? m[3].slice(1, -1) : '';
    dest = dest.trim();
    if (dest.charAt(0) === '<') dest = dest.slice(1, -1);
    return this.makeLink(
      m[1],
      { href: dest && dest.replace(INLINE.anyPunctuation, '$1'), title: title && title.replace(INLINE.anyPunctuation, '$1') },
      m[0],
    );
  }

  hasTagAcross(src, label, offset) {
    if (!label.includes('<')) return false;
    for (let i = 0; i < label.length; i++) {
      if (label[i] === '\\') { i++; continue; }
      if (label[i] === '`') {
        const code = INLINE.code.exec(label.slice(i));
        if (code) { i += code[0].length - 1; continue; }
      }
      if (label[i] !== '<') continue;
      const rest = src.slice(offset + i);
      const hit = INLINE.tag.exec(rest) || INLINE.autolink.exec(rest);
      if (hit) {
        if (hit[0].length > label.length - i) return true;
        i += hit[0].length - 1;
      }
    }
    return false;
  }

  makeLink(label, link, raw) {
    const isImage = raw.charAt(0) === '!';
    const text = label.replace(/\\([\[\]])/g, '$1');
    const savedInLink = this.inLink;
    const savedEmitted = this.linkEmitted;
    const savedRaw = this.inRawBlock;
    this.inLink = true;
    this.linkEmitted = false;
    // An image's alt text always needs the plain projection of its label.
    const inner = this.inlineRender(text, this.needPlain || isImage);
    const emitted = this.linkEmitted;
    this.linkEmitted = savedEmitted;
    this.inLink = savedInLink;
    if (!isImage) {
      if (emitted) {
        this.inRawBlock = savedRaw;
        return;
      }
      this.linkEmitted = true;
    }
    const encoded = encodeHref(link.href);
    let html;
    if (isImage) {
      const alt = inner.plain;
      if (encoded === null) html = esc(alt);
      else {
        html = '<img src="' + esc(encoded) + '" alt="' + esc(alt) + '"';
        if (link.title) html += ' title="' + esc(link.title) + '"';
        html += '>';
      }
    } else if (encoded === null) {
      html = inner.html;
    } else {
      html = '<a href="' + esc(encoded) + '"';
      if (link.title) html += ' title="' + esc(link.title) + '"';
      html += '>' + inner.html + '</a>';
    }
    return { raw, html, plain: this.needPlain ? inner.plain : '' };
  }

  reflinkT(src) {
    const m = INLINE.reflink.exec(src) || INLINE.nolink.exec(src);
    if (!m) return;
    const off = m[0].charAt(0) === '!' ? 2 : 1;
    if (this.hasTagAcross(src, m[1], off)) return;
    const link = this.links[normalizeLabel(m[2] || m[1])];
    if (!link) {
      const c = m[0].charAt(0);
      return { raw: c, html: esc(c), plain: c };
    }
    return this.makeLink(m[1], link, m[0]);
  }

  emStrongT(src, fullSrc, startText) {
    let m = INLINE.emStrongLDelim.exec(src);
    if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return;
    // The mask is only consulted once this run can actually open emphasis.
    const masked = this.maskOf(fullSrc);
    const ch = m[0][0];
    const sameStart = startText === ch;
    const offset = masked.length - src.length;
    let back = offset;
    while (back > 0 && masked[back - 1] === ch) back--;
    const seg = masked.slice(Math.max(0, back - 2), back);
    const prev = lastCp(seg);
    const prevPunct = prev === '*' || prev === '_' || PUNCT.test(prev);
    let before = startText;
    if (back < offset) before = prev;
    const beforePunct = back < offset ? prevPunct : PUNCT.test(before);
    if (m[4] && ALNUM.test(before)) return;
    const op = m[1] || m[3] || '';
    if (!op || !before || beforePunct) {
      const runLen = runLenCp(m[0]);
      if (ch !== '*' && ch !== '_') return;
      const delim = ch === '*' ? INLINE.emStrongRDelimAst : INLINE.emStrongRDelimUnd;
      const lastCloser = this.lastEmCloser(masked, ch);
      const base = masked.length - src.length + runLen;
      if (lastCloser < base) return;
      const scan = masked.slice(-src.length + runLen);
      const limit = lastCloser - base;
      let balance = runLen;
      let carry = 0;
      const mod = offset - back + runLen;
      const noPrev = prev.trim() !== '' && (!!op || (ch === '*' && !prevPunct));
      delim.lastIndex = 0;
      let hit;
      while ((hit = delim.exec(scan)) !== null && !(hit.index > limit)) {
        const run = hit[1] || hit[2] || hit[3] || hit[4] || hit[5] || hit[6];
        if (!run) continue;
        let len = run.length;
        if (hit[3] || hit[4]) {
          balance += len;
          continue;
        } else if (hit[5] || hit[6] || noPrev) {
          if (sameStart && (hit[5] || hit[6])) break;
          if (mod % 3 && !((mod + len) % 3)) {
            carry += len;
            continue;
          }
        }
        balance -= len;
        if (balance > 0) continue;
        len = Math.min(len, len + balance + carry);
        const lead = firstCpLen(hit[0]);
        const raw = src.slice(0, runLen + hit.index + lead + len);
        if (Math.min(runLen, len) % 2) {
          const inner = this.inlineRender(raw.slice(1, -1), this.needPlain);
          return { raw, html: '<em>' + inner.html + '</em>', plain: this.needPlain ? inner.plain : '' };
        }
        const inner = this.inlineRender(raw.slice(2, -2), this.needPlain);
        return { raw, html: '<strong>' + inner.html + '</strong>', plain: this.needPlain ? inner.plain : '' };
      }
    }
  }

  delT(src, fullSrc, startText) {
    const m = INLINE.delLDelim.exec(src);
    if (!m) return;
    if (!(m[1] || '') || !startText || PUNCT.test(startText)) {
      const masked = this.maskOf(fullSrc);
      const runLen = runLenCp(m[0]);
      const lastDel = this.lastDelCloser(masked);
      const base = masked.length - src.length + runLen;
      if (lastDel < base) return;
      const scan = masked.slice(-src.length + runLen);
      const limit = lastDel - base;
      let balance = runLen;
      const delim = INLINE.delRDelim;
      delim.lastIndex = 0;
      let hit;
      while ((hit = delim.exec(scan)) !== null && !(hit.index > limit)) {
        const run = hit[1] || hit[2] || hit[3] || hit[4] || hit[5] || hit[6];
        if (!run) continue;
        let len = run.length;
        if (len !== runLen) continue;
        if (hit[3] || hit[4]) {
          balance += len;
          continue;
        }
        balance -= len;
        if (balance > 0) continue;
        len = Math.min(len, len + balance);
        const lead = firstCpLen(hit[0]);
        const raw = src.slice(0, runLen + hit.index + lead + len);
        const inner = this.inlineRender(raw.slice(runLen, -runLen), this.needPlain);
        return { raw, html: '<del>' + inner.html + '</del>', plain: this.needPlain ? inner.plain : '' };
      }
    }
  }

  lastEmCloser(masked, ch) {
    const frame = this.maskFrame;
    if (frame && frame.masked === masked) {
      if (frame.em === null) {
        const info = maskInfo(masked);
        frame.em = info.em;
        frame.del = info.del;
      }
      return frame.em[ch];
    }
    return maskInfo(masked).em[ch];
  }

  lastDelCloser(masked) {
    const frame = this.maskFrame;
    if (frame && frame.masked === masked) {
      if (frame.em === null) {
        const info = maskInfo(masked);
        frame.em = info.em;
        frame.del = info.del;
      }
      return frame.del;
    }
    return maskInfo(masked).del;
  }

  codespanT(src) {
    const m = INLINE.code.exec(src);
    if (!m) return;
    let text = m[2].replace(/\n/g, ' ');
    const hasText = /[^ ]/.test(text);
    if (hasText && /^ /.test(text) && / $/.test(text)) text = text.substring(1, text.length - 1);
    return { raw: m[0], html: '<code>' + esc(text, true) + '</code>', plain: text };
  }

  brT(src) {
    const m = INLINE.br.exec(src);
    if (m) return { raw: m[0], html: '<br>', plain: '' };
  }

  autolinkT(src) {
    const m = INLINE.autolink.exec(src);
    if (!m) return;
    let text, href;
    if (m[2] === '@') {
      text = m[1];
      href = 'mailto:' + text;
    } else {
      text = m[1];
      href = text;
    }
    const encoded = encodeHref(href);
    const label = esc(text, true);
    return {
      raw: m[0],
      html: encoded === null ? label : '<a href="' + esc(encoded, true) + '">' + label + '</a>',
      plain: text,
    };
  }

  urlT(src) {
    const m = INLINE.url.exec(src);
    if (!m) return;
    let text, href;
    if (m[2] === '@') {
      text = m[0];
      href = 'mailto:' + text;
    } else {
      let before;
      do {
        before = m[0];
        const back = INLINE.backpedal.exec(m[0]);
        m[0] = back ? back[0] : '';
      } while (before !== m[0]);
      text = m[0];
      href = m[1] === 'www.' ? 'http://' + text : text;
    }
    const encoded = encodeHref(href);
    const label = esc(text, true);
    return {
      raw: m[0],
      html: encoded === null ? label : '<a href="' + esc(encoded, true) + '">' + label + '</a>',
      plain: text,
    };
  }

  urlPossible(src, c, hasAt) {
    if (c === 104 || c === 72 || c === 102 || c === 70 || c === 119 || c === 87 || c === 109 || c === 120) return true;
    if (hasAt && c < 128 && LOCAL_PART[c] === 1) {
      // An address match needs '@' right after the run of address characters.
      const len = src.length;
      let i = 1;
      while (i < len) {
        const d = src.charCodeAt(i);
        if (d >= 128 || LOCAL_PART[d] === 0) break;
        i++;
      }
      return i < len && src.charCodeAt(i) === 64;
    }
    return false;
  }
}

function isAlnumCode(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

/**
 * Length of the next inline-text token, reproducing marked's text rule:
 * a plain run that ends before a construct, a protocol/www/email trigger or
 * a hard line break.
 */
function scanTextLength(src, hasAt) {
  const len = src.length;
  if (len === 0) return 0;
  const c0 = src.charCodeAt(0);
  TEXT_ESC = c0 < 128 && (SCAN[c0] & 32) !== 0;
  if (!isAlnumCode(c0)) {
    const d = src.charCodeAt(1);
    if (d === 109 ? src.startsWith('mailto:', 1) : d === 120 && src.startsWith('xmpp:', 1)) return 1;
  }

  let q = 1;
  if (c0 === 96 || c0 === 126) while (q < len && src.charCodeAt(q) === c0) q++;
  const p0 = q;
  let prevEmail = false;

  while (q < len) {
    const c = src.charCodeAt(q);
    const f = c < 128 ? SCAN[c] : 8;
    if (f === 16) {
      // A plain alphanumeric character can only end the run by starting an
      // e-mail address right after a non-address character.
      if (hasAt && !prevEmail && emailRunBeforeAt(src, q, len)) return q;
      // Consume the whole plain alphanumeric run in a tight loop; these
      // characters cannot trip any of the other rules.
      q++;
      while (q < len) {
        const c2 = src.charCodeAt(q);
        if (c2 >= 128 || SCAN[c2] !== 16) break;
        q++;
      }
      prevEmail = true;
      continue;
    }
    if (f & 1) return q;
    if (f & 4) {
      if (c === 104 || c === 72) {
        if (q + 3 < len && (src.charCodeAt(q + 1) | 32) === 116 && (src.charCodeAt(q + 2) | 32) === 116 && (src.charCodeAt(q + 3) | 32) === 112) return q;
      } else if (c === 102 || c === 70) {
        if (q + 5 < len && (src.charCodeAt(q + 1) | 32) === 116 && (src.charCodeAt(q + 2) | 32) === 112 && src.charCodeAt(q + 3) === 58 && src.charCodeAt(q + 4) === 47 && src.charCodeAt(q + 5) === 47) return q;
      } else if (q + 3 < len && src.charCodeAt(q + 1) === 119 && src.charCodeAt(q + 2) === 119 && src.charCodeAt(q + 3) === 46) {
        const p = src.charCodeAt(q - 1);
        if (p === 32 || p === 9 || p === 10 || p === 11 || p === 12 || p === 13 || p === 42 || p === 95 || p === 126 || p === 40) return q;
        if (p >= 128 && PREV_WS.test(src.charAt(q - 1))) return q;
      }
      if (hasAt && !prevEmail && emailRunBeforeAt(src, q, len)) return q;
      prevEmail = true;
      q++;
      continue;
    }
    if (f & 2) {
      let k = q;
      while (k < len && src.charCodeAt(k) === 32) k++;
      if (k - q >= 2 && k < len && src.charCodeAt(k) === 10 && (q === p0 || src.charCodeAt(q - 1) !== 32)) return q;
      if (q + 1 < len) {
        const d = src.charCodeAt(q + 1);
        if (d === 109 ? src.startsWith('mailto:', q + 1) : d === 120 && src.startsWith('xmpp:', q + 1)) return q + 1;
      }
      prevEmail = false;
      q++;
      continue;
    }
    // Any other non-alphanumeric character: a mailto:/xmpp: right after it
    // ends the run, and an e-mail address may start at it. Record its escape
    // flag first: the q + 1 return includes this character in the run.
    if ((f & 32) !== 0) TEXT_ESC = true;
    if (q + 1 < len) {
      const d = src.charCodeAt(q + 1);
      if (d === 109 ? src.startsWith('mailto:', q + 1) : d === 120 && src.startsWith('xmpp:', q + 1)) return q + 1;
    }
    if (hasAt && (f & 16) !== 0 && !prevEmail && emailRunBeforeAt(src, q, len)) return q;
    prevEmail = (f & 16) !== 0;
    q++;
  }
  return len;
}

/** True when an email address (address chars followed by '@') starts at i. */
function emailRunBeforeAt(src, i, len) {
  let k = i;
  while (k < len && src.charCodeAt(k) < 128 && EMAIL_CHAR[src.charCodeAt(k)] === 1) k++;
  return k > i && k < len && src.charCodeAt(k) === 64;
}

/** Index of the last delimiter run preceded by a non-space, as marked masks it. */
function maskInfo(masked) {
  const em = { '*': -1, '_': -1 };
  let del = -1;
  const n = masked.length;
  for (let i = 0; i < n; i++) {
    const c = masked.charCodeAt(i);
    if (c !== 42 && c !== 95 && c !== 126) continue;
    const prev = i === 0 ? 10 : masked.charCodeAt(i - 1);
    let j = i + 1;
    while (j < n && masked.charCodeAt(j) === c) j++;
    if (prev !== 32 && prev !== 9 && prev !== 10 && prev !== 13 && prev !== 12) {
      if (c === 126) del = i;
      else em[c === 42 ? '*' : '_'] = i;
    }
    i = j - 1;
  }
  return { maskedSrc: masked, em, del };
}

/** Length in code units of the first code point of s (s must be non-empty). */
function firstCpLen(s) {
  const c = s.charCodeAt(0);
  if (c >= 0xd800 && c <= 0xdbff && s.length > 1) {
    const d = s.charCodeAt(1);
    if (d >= 0xdc00 && d <= 0xdfff) return 2;
  }
  return 1;
}

/** Last code point of s, as a string ('' for an empty string). */
function lastCp(s) {
  const n = s.length;
  if (n === 0) return '';
  const c = s.charCodeAt(n - 1);
  if (c >= 0xdc00 && c <= 0xdfff && n > 1) {
    const d = s.charCodeAt(n - 2);
    if (d >= 0xd800 && d <= 0xdbff) return s.slice(n - 2);
  }
  return s.slice(n - 1);
}

/** Remove up to the fence's own indentation prefix from every line. */
function stripIndent(fenceRaw, text) {
  const m = /^(\s+)(?:```)/.exec(fenceRaw);
  if (m === null) return text;
  const prefix = m[1];
  return text.split('\n').map((line) => {
    const lead = /^\s+/.exec(line);
    if (lead === null) return line;
    return line.slice(Math.min(lead[0].length, prefix.length));
  }).join('\n');
}

/** Width of the expanded leading whitespace run. */
function expandedWidth(line, lead) {
  let col = 0;
  for (let i = 0; i < lead; i++) {
    if (line.charCodeAt(i) === 9) col += 4 - (col % 4);
    else col++;
  }
  return col;
}

function isSpaceCode(c) {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13;
}

/** True when the line is a thematic break made of `ch`. */
function isHrLine(line, start, ch) {
  let count = 0;
  for (let i = start; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === ch) count++;
    else if (c !== 32 && c !== 9) return false;
  }
  return count >= 3;
}

/** Bullet / ordered-item marker followed by a space, tab or end of line. */
function isListItemStart(line, sp) {
  const c = line.charCodeAt(sp);
  if (c === 42 || c === 43 || c === 45) {
    return sp + 1 === line.length || line.charCodeAt(sp + 1) === 32 || line.charCodeAt(sp + 1) === 9;
  }
  if (c >= 48 && c <= 57) {
    let k = sp;
    while (k < line.length && k - sp < 9) {
      const d = line.charCodeAt(k);
      if (d < 48 || d > 57) break;
      k++;
    }
    if (k === sp) return false;
    const p = line.charCodeAt(k);
    if (p !== 46 && p !== 41) return false;
    const after = k + 1;
    return after === line.length || line.charCodeAt(after) === 32 || line.charCodeAt(after) === 9;
  }
  return false;
}

/** Any block start that ends a list item's continuation line. */
function startsBlockAt(line, n, htmlRe) {
  let sp = 0;
  while (sp < line.length && line.charCodeAt(sp) === 32) sp++;
  if (sp > n) return false;
  const c = line.charCodeAt(sp);
  if (c === 96 || c === 126) return line.charCodeAt(sp + 1) === c && line.charCodeAt(sp + 2) === c;
  if (c === 35) {
    let k = sp;
    while (k < line.length && line.charCodeAt(k) === 35) k++;
    return k - sp <= 6 && (k === line.length || isSpaceCode(line.charCodeAt(k)));
  }
  if (c === 62) return true;
  if (c === 60) return htmlRe.test(line);
  if (c === 42 || c === 43 || c === 45) return isListItemStart(line, sp) || isHrLine(line, sp, c);
  if (c === 95) return isHrLine(line, sp, 95);
  if (c >= 48 && c <= 57) return isListItemStart(line, sp);
  return false;
}

/** Block starts that abort a lazy continuation line in list items. */
function startsContentAt(line, n, htmlRe) {
  let sp = 0;
  while (sp < line.length && line.charCodeAt(sp) === 32) sp++;
  if (sp > n) return false;
  const c = line.charCodeAt(sp);
  if (c === 96 || c === 126) return line.charCodeAt(sp + 1) === c && line.charCodeAt(sp + 2) === c;
  if (c === 35) {
    let k = sp;
    while (k < line.length && line.charCodeAt(k) === 35) k++;
    return k - sp <= 6 && (k === line.length || isSpaceCode(line.charCodeAt(k)));
  }
  if (c === 60) return htmlRe.test(line);
  if (c === 42 || c === 45 || c === 95) return isHrLine(line, sp, c);
  return false;
}

/** True when s ends in a blank line (only spaces/tabs before its last newline). */
function endsWithBlankLine(s) {
  let i = s.length;
  while (i > 0) {
    const c = s.charCodeAt(i - 1);
    if (c !== 32 && c !== 9) break;
    i--;
  }
  if (i === 0 || s.charCodeAt(i - 1) !== 10) return false;
  i--;
  while (i > 0) {
    const c = s.charCodeAt(i - 1);
    if (c !== 32 && c !== 9) break;
    i--;
  }
  return i > 0 && s.charCodeAt(i - 1) === 10;
}

/** Split a GFM table row into trimmed cells. */
function splitRow(row, cols) {
  // marked spaces out every unescaped pipe and splits on " |"; doing it in one
  // scan gives the same cells.
  const len = row.length;
  const cells = [];
  let start = 0;
  for (let i = 0; i < len; i++) {
    if (row.charCodeAt(i) !== 124) continue;
    let backslashes = 0;
    for (let j = i - 1; j >= 0 && row.charCodeAt(j) === 92; j--) backslashes++;
    if (backslashes % 2 === 0) {
      cells.push(row.slice(start, i));
      start = i + 1;
    }
  }
  cells.push(row.slice(start));
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (cols) {
    if (cells.length > cols) cells.splice(cols);
    else while (cells.length < cols) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

/* =============================== renderer =============================== */

class Renderer {
  parse(tokens) {
    let out = '';
    for (let i = 0; i < tokens.length; i++) out += this.block(tokens[i]);
    return out;
  }

  block(tok) {
    switch (tok.type) {
      case 'space':
      case 'def':
        return '';
      case 'hr':
        return '<hr>\n';
      case 'heading':
        return '<h' + tok.depth + '>' + this.inline(tok.tokens) + '</h' + tok.depth + '>\n';
      case 'code': {
        const lang = (tok.lang || '').match(/^\S*/)[0];
        let body = tok.text ? tok.text.replace(/\n$/, '') + '\n' : '';
        body = esc(body, true);
        return lang
          ? '<pre><code class="language-' + esc(lang) + '">' + body + '</code></pre>\n'
          : '<pre><code>' + body + '</code></pre>\n';
      }
      case 'table':
        return this.table(tok);
      case 'blockquote':
        return '<blockquote>\n' + this.parse(tok.tokens) + '</blockquote>\n';
      case 'list': {
        let items = '';
        for (let i = 0; i < tok.items.length; i++) items += this.listItem(tok.items[i]);
        const tag = tok.ordered ? 'ol' : 'ul';
        const start = tok.ordered && tok.start !== 1 ? ' start="' + tok.start + '"' : '';
        return '<' + tag + start + '>\n' + items + '</' + tag + '>\n';
      }
      case 'checkbox':
        return '<input ' + (tok.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
      case 'html':
        return tok.text;
      case 'paragraph':
        return '<p>' + this.inline(tok.tokens) + '</p>\n';
      case 'text':
        if (tok.tokens) return this.inline(tok.tokens);
        if (tok.escaped) return tok.text;
        return esc(tok.text);
      default:
        throw new Error('Token with "' + tok.type + '" type was not found.');
    }
  }

  listItem(item) {
    return '<li>' + this.parse(item.tokens) + '</li>\n';
  }

  table(tok) {
    let head = '';
    for (const cell of tok.header) head += this.tableCell(cell);
    let body = '';
    for (const row of tok.rows) {
      let rowText = '';
      for (const cell of row) rowText += this.tableCell(cell);
      body += '<tr>\n' + rowText + '</tr>\n';
    }
    if (body) body = '<tbody>' + body + '</tbody>';
    return '<table>\n<thead>\n' + '<tr>\n' + head + '</tr>\n' + '</thead>\n' + body + '</table>\n';
  }

  tableCell(cell) {
    const tag = cell.header ? 'th' : 'td';
    return (cell.align ? '<' + tag + ' align="' + cell.align + '">' : '<' + tag + '>') +
      this.inline(cell.tokens) + '</' + tag + '>\n';
  }

  inline(tokens, textMode = false) {
    let out = '';
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      // Plain text is by far the most common token; handle it without a call.
      if (tok.type === 'text' && !textMode && tok.tokens === undefined) {
        out += tok.escaped ? tok.text : esc(tok.text);
        continue;
      }
      out += this.inlineToken(tok, textMode);
    }
    return out;
  }

  inlineToken(tok, textMode) {
    switch (tok.type) {
      case 'text':
        if (textMode) return tok.text;
        if (tok.tokens) return this.inline(tok.tokens);
        if (tok.escaped) return tok.text;
        return esc(tok.text);
      case 'escape':
        return textMode ? tok.text : esc(tok.text);
      case 'html':
        return tok.text;
      case 'codespan':
        return textMode ? tok.text : '<code>' + esc(tok.text, true) + '</code>';
      case 'br':
        return textMode ? '' : '<br>';
      case 'strong':
        return textMode
          ? (tok.tokens ? this.inline(tok.tokens, true) : tok.text)
          : '<strong>' + this.inline(tok.tokens) + '</strong>';
      case 'em':
        return textMode
          ? (tok.tokens ? this.inline(tok.tokens, true) : tok.text)
          : '<em>' + this.inline(tok.tokens) + '</em>';
      case 'del':
        return textMode
          ? (tok.tokens ? this.inline(tok.tokens, true) : tok.text)
          : '<del>' + this.inline(tok.tokens) + '</del>';
      case 'checkbox':
        return textMode ? tok.raw : '<input ' + (tok.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
      case 'link':
        return this.link(tok, textMode);
      case 'image':
        return this.image(tok, textMode);
      default:
        throw new Error('Token with "' + tok.type + '" type was not found.');
    }
  }

  link(tok, textMode) {
    if (textMode) return tok.tokens ? this.inline(tok.tokens, true) : tok.text;
    const label = tok.autolink ? esc(tok.text, true) : this.inline(tok.tokens);
    const encoded = encodeHref(tok.href);
    if (encoded === null) return label;
    let out = '<a href="' + esc(encoded, tok.autolink) + '"';
    if (tok.title) out += ' title="' + esc(tok.title) + '"';
    return out + '>' + label + '</a>';
  }

  image(tok, textMode) {
    if (textMode) return tok.tokens ? this.inline(tok.tokens, true) : tok.text;
    const alt = tok.tokens ? this.inline(tok.tokens, true) : tok.text;
    const encoded = encodeHref(tok.href);
    if (encoded === null) return esc(alt);
    let out = '<img src="' + esc(encoded) + '" alt="' + esc(alt) + '"';
    if (tok.title) out += ' title="' + esc(tok.title) + '"';
    return out + '>';
  }
}

/* ================================ entry ================================= */

export function parse(markdown) {
  TEXT_ESC = false;
  const lexer = new Lexer();
  const tokens = lexer.lex(markdown);
  return new Renderer().parse(tokens);
}
