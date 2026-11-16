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
  if (encode) {
    return ESCAPE_TEST.test(s) ? s.replace(ESCAPE_ALL, entityOf) : s;
  }
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

/** Percent-encode an href; null when encodeURI rejects it. */
function encodeHref(s) {
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
  text: /^[^\n]+/,
};

const GF_BLOCK = {
  lheading: /^(?! {0,3}(?:[*+-]|\d{1,9}[.)]) |(?: {4}| {0,3}\t)| {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\s|$)| {0,3}<[^\n>]+>\n| {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n)((?:.|\n(?!\s*?\n| {0,3}(?:[*+-]|\d{1,9}[.)]) | {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\s|$)| {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}<[^\n>]+>\n| {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/,
  paragraph: /^([^\n]+(?:\n(?! {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)| *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n| {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>|(?: {4}| {0,3}	)[^\n]| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)).*(?:\n|$))*)\n*|$)|[ \t]+\n)[^\n]+)*)/,
};

const PUNCT = /^((?![*_])[\s\p{P}\p{S}])/u;
const ALNUM = /[\p{L}\p{N}]/u;
const ANY_LINE = /\n.*\n/;

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

/* ================================ lexer ================================= */

class Lexer {
  constructor() {
    this.top = true;
    this.inLink = false;
    this.inRawBlock = false;
    this.linkEmitted = false;
    this.linkParenPossible = true;
    this.links = Object.create(null);
    this.queue = [];
    this.masks = [];
    this.itemRes = new Map();
    this.nextBulletRes = [];
    this.hrRes = [];
    this.fenceRes = [];
    this.headingRes = [];
    this.htmlRes = [];
    this.bqRes = [];
  }

  lex(md) {
    const tokens = [];
    md = md.replace(/\r\n|\r/g, '\n');
    this.blockTokens(md, tokens);
    for (let i = 0; i < this.queue.length; i++) {
      const q = this.queue[i];
      this.inRawBlock = false;
      this.inlineTokens(q.src, q.tokens);
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
    const used = () => whole.length - src.length;
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
    while (src) {
      let emptyStart = false;
      let text = '';
      let m;
      if (!(m = itemRe.exec(src)) || BLOCK.hr.test(src)) break;
      const begin = used();
      src = src.substring(m[0].length);
      const firstLine = m[2].split('\n', 1)[0];
      const markerLen = m[1].length;
      let content = firstLine.replace(/^[ \t]+/, (ws) => expandTabs(ws, markerLen));
      let nextLine = src.split('\n', 1)[0];
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
        src = src.substring(nextLine.length + 1);
        emptyStart = true;
      }
      if (!emptyStart) {
        const bulletRe = this.nextBullet(indent);
        const hrRe = this.hrRe(indent);
        const fenceRe = this.fenceRe(indent);
        const headRe = this.headingRe(indent);
        const htmlRe = this.htmlRe(indent);
        const bqRe = this.bqRe(indent);
        for (;;) {
          if (!src) break;
          const line = src.split('\n', 1)[0];
          let check = line;
          let expanded = line.replace(/^[ \t]+/, (ws) => expandTabs(ws));
          if (fenceRe.test(check) || headRe.test(check) || htmlRe.test(check) || bqRe.test(check) || bulletRe.test(check) || hrRe.test(check)) break;
          if (expanded.search(/[^ ]/) >= indent || !line.trim()) {
            text += '\n' + expanded.slice(indent);
          } else {
            if (
              blankFirst ||
              content.replace(/\t/g, '    ').search(/[^ ]/) >= 4 ||
              fenceRe.test(content) ||
              headRe.test(content) ||
              htmlRe.test(content) ||
              hrRe.test(content)
            ) break;
            const setext = !/^ {0,3}(?:=+|-+) *$/.test(line) ? line
              : GF_BLOCK.lheading.test(content + '\n' + line) ? '    ' + expanded.replace(/^ {0,3}/, '') : line;
            text += '\n' + setext;
          }
          blankFirst = !line.trim();
          src = src.substring(line.length + 1);
          content = expanded.slice(indent);
        }
      }
      const itemRaw = whole.slice(begin, used());
      if (!list.loose) {
        if (crossedBlank) list.loose = true;
        else if (/\n[ \t]*\n[ \t]*$/.test(itemRaw)) crossedBlank = true;
      }
      list.items.push({
        type: 'list_item',
        raw: itemRaw,
        task: /^\[[ xX]\][ \t]+\S/.test(text),
        loose: false,
        text,
        tokens: [],
      });
    }
    const lastItem = list.items[list.items.length - 1];
    if (!lastItem) return;
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
    list.raw = whole.slice(0, used()).trimEnd();
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

  paragraph(src) {
    const m = GF_BLOCK.paragraph.exec(src);
    if (!m) return;
    const text = m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
    return { type: 'paragraph', raw: m[0], text, tokens: this.inline(text) };
  }

  textBlock(src) {
    const m = BLOCK.text.exec(src);
    if (!m) return;
    return { type: 'text', raw: m[0], text: m[0], tokens: this.inline(m[0]) };
  }

  /* ---------------- cached indent regexes ---------------- */

  itemRe(markerSrc) {
    let re = this.itemRes.get(markerSrc);
    if (!re) {
      re = new RegExp('^( {0,3}' + markerSrc + ')((?:[ \\t][^\\n]*)?(?:\\n|$))');
      this.itemRes.set(markerSrc, re);
    }
    return re;
  }

  nextBullet(indent) {
    const n = Math.max(0, Math.min(3, indent - 1));
    let re = this.nextBulletRes[n];
    if (!re) {
      re = new RegExp('^ {0,' + n + '}(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))');
      this.nextBulletRes[n] = re;
    }
    return re;
  }

  hrRe(indent) {
    const n = Math.max(0, Math.min(3, indent - 1));
    let re = this.hrRes[n];
    if (!re) {
      re = new RegExp('^ {0,' + n + '}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)');
      this.hrRes[n] = re;
    }
    return re;
  }

  fenceRe(indent) {
    const n = Math.max(0, Math.min(3, indent - 1));
    let re = this.fenceRes[n];
    if (!re) {
      re = new RegExp('^ {0,' + n + '}(?:```|~~~)');
      this.fenceRes[n] = re;
    }
    return re;
  }

  headingRe(indent) {
    const n = Math.max(0, Math.min(3, indent - 1));
    let re = this.headingRes[n];
    if (!re) {
      re = new RegExp('^ {0,' + n + '}#{1,6}(?:\\s|$)');
      this.headingRes[n] = re;
    }
    return re;
  }

  htmlRe(indent) {
    const n = Math.max(0, Math.min(3, indent - 1));
    let re = this.htmlRes[n];
    if (!re) {
      re = new RegExp('^ {0,' + n + '}(?:</?(?:' + TAGS + ')(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)', 'i');
      this.htmlRes[n] = re;
    }
    return re;
  }

  bqRe(indent) {
    const n = Math.max(0, Math.min(3, indent - 1));
    let re = this.bqRes[n];
    if (!re) {
      re = new RegExp('^ {0,' + n + '}>');
      this.bqRes[n] = re;
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
      if ((tok = this.space(src))) {
        src = src.substring(tok.raw.length);
        const prev = tokens[tokens.length - 1];
        if (tok.raw.length === 1 && prev !== undefined) prev.raw += '\n';
        else tokens.push(tok);
        continue;
      }
      if ((tok = this.code(src))) {
        src = src.substring(tok.raw.length);
        const prev = tokens[tokens.length - 1];
        if (prev && (prev.type === 'paragraph' || prev.type === 'text')) {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.text;
          this.queue[this.queue.length - 1].src = prev.text;
        } else tokens.push(tok);
        continue;
      }
      if ((tok = this.fences(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.heading(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.hr(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.blockquote(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.list(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.html(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.def(src))) {
        src = src.substring(tok.raw.length);
        const prev = tokens[tokens.length - 1];
        if (prev && (prev.type === 'paragraph' || prev.type === 'text')) {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.raw;
          this.queue[this.queue.length - 1].src = prev.text;
        } else {
          if (!this.links[tok.tag]) this.links[tok.tag] = { href: tok.href, title: tok.title };
          tokens.push(tok);
        }
        continue;
      }
      if ((tok = this.table(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.lheading(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if (this.top && (tok = this.paragraph(src))) {
        const prev = tokens[tokens.length - 1];
        if (joinParagraphs && prev && prev.type === 'paragraph') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.text;
          this.queue.pop();
          this.queue[this.queue.length - 1].src = prev.text;
        } else {
          tokens.push(tok);
        }
        joinParagraphs = false;
        src = src.substring(tok.raw.length);
        continue;
      }
      if ((tok = this.textBlock(src))) {
        src = src.substring(tok.raw.length);
        const prev = tokens[tokens.length - 1];
        if (prev && prev.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.text;
          this.queue.pop();
          this.queue[this.queue.length - 1].src = prev.text;
        } else tokens.push(tok);
        continue;
      }
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
    this.top = true;
    return tokens;
  }

  inline(src, tokens = []) {
    this.queue.push({ src, tokens });
    return tokens;
  }

  /* ---------------- inline tokenizer ---------------- */

  inlineTokens(src, tokens = []) {
    const savedParen = this.linkParenPossible;
    this.linkParenPossible = savedParen && src.includes(')');
    try {
      return this.inlineCore(src, tokens);
    } finally {
      this.linkParenPossible = savedParen;
    }
  }

  inlineCore(src, tokens) {
    let masked = src;
    if (src.includes('*') || src.includes('_') || src.includes('~')) masked = this.buildMask(src);
    const info = maskInfo(masked);
    this.masks.push(info);
    try {
      return this.inlineLoop(src, masked, tokens);
    } finally {
      this.masks.pop();
    }
  }

  buildMask(src) {
    let t = src;
    if (src.includes('[')) t = this.maskReflinks(t);
    t = t.replace(INLINE.anyPunctuationOutsideCode, (all, ticks, punct) => {
      if (punct) return '+'.repeat(all.length);
      if (ticks) return ticks + all.slice(ticks.length, -ticks.length).replace(/`/g, '+') + ticks;
      return all;
    });
    t = t.replace(INLINE.blockSkip, (all) => '[' + 'a'.repeat(all.length - 2) + ']');
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

  inlineLoop(src, masked, tokens) {
    let wasText = false;
    let lastChar = '';
    let marker = Infinity;
    while (src) {
      if (src.length < marker) marker = src.length;
      else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
      if (!wasText) lastChar = '';
      wasText = false;

      let tok;
      if ((tok = this.escapeT(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.tagT(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.linkT(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.reflinkT(src))) {
        src = src.substring(tok.raw.length);
        const prev = tokens[tokens.length - 1];
        if (tok.type === 'text' && prev && prev.type === 'text') {
          prev.raw += tok.raw;
          prev.text += tok.text;
        } else tokens.push(tok);
        continue;
      }
      if ((tok = this.emStrongT(src, masked, lastChar))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.codespanT(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.brT(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.delT(src, masked, lastChar))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.autolinkT(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if (!this.inLink && (tok = this.urlT(src))) {
        src = src.substring(tok.raw.length);
        tokens.push(tok);
        continue;
      }
      if ((tok = this.textT(src))) {
        src = src.substring(tok.raw.length);
        if (tok.raw.slice(-1) !== '_') lastChar = tok.raw.slice(-1);
        wasText = true;
        const prev = tokens[tokens.length - 1];
        if (prev && prev.type === 'text') {
          prev.raw += tok.raw;
          prev.text += tok.text;
        } else tokens.push(tok);
        continue;
      }
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
    return tokens;
  }

  escapeT(src) {
    const m = INLINE.escape.exec(src);
    if (m) return { type: 'escape', raw: m[0], text: m[1] };
  }

  tagT(src) {
    const m = INLINE.tag.exec(src);
    if (!m) return;
    if (!this.inLink && /^<a /i.test(m[0])) this.inLink = true;
    else if (this.inLink && /^<\/a>/i.test(m[0])) this.inLink = false;
    if (!this.inRawBlock && /^<(pre|code|kbd|script)(\s|>)/i.test(m[0])) this.inRawBlock = true;
    else if (this.inRawBlock && /^<\/(pre|code|kbd|script)(\s|>)/i.test(m[0])) this.inRawBlock = false;
    return {
      type: 'html',
      raw: m[0],
      inLink: this.inLink,
      inRawBlock: this.inRawBlock,
      block: false,
      text: m[0],
    };
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
    const children = this.inlineTokens(text);
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
    return {
      type: isImage ? 'image' : 'link',
      raw,
      href: link.href,
      title: link.title || null,
      text,
      tokens: children,
    };
  }

  reflinkT(src) {
    const m = INLINE.reflink.exec(src) || INLINE.nolink.exec(src);
    if (!m) return;
    const off = m[0].charAt(0) === '!' ? 2 : 1;
    if (this.hasTagAcross(src, m[1], off)) return;
    const link = this.links[normalizeLabel(m[2] || m[1])];
    if (!link) {
      const c = m[0].charAt(0);
      return { type: 'text', raw: c, text: c };
    }
    return this.makeLink(m[1], link, m[0]);
  }

  emStrongT(src, masked, startText) {
    let m = INLINE.emStrongLDelim.exec(src);
    if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return;
    const ch = m[0][0];
    const sameStart = startText === ch;
    const offset = masked.length - src.length;
    let back = offset;
    while (back > 0 && masked[back - 1] === ch) back--;
    const seg = masked.slice(Math.max(0, back - 2), back);
    const prev = seg.length ? Array.from(seg).pop() : '';
    const prevPunct = prev === '*' || prev === '_' || !!PUNCT.exec(prev);
    let before = startText;
    if (back < offset) before = prev;
    const beforePunct = back < offset ? prevPunct : !!PUNCT.exec(before);
    if (m[4] && ALNUM.test(before)) return;
    const op = m[1] || m[3] || '';
    if (!op || !before || beforePunct) {
      const runLen = Array.from(m[0]).length - 1;
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
        let len = Array.from(run).length;
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
        const lead = Array.from(hit[0])[0].length;
        const raw = src.slice(0, runLen + hit.index + lead + len);
        if (Math.min(runLen, len) % 2) {
          const body = raw.slice(1, -1);
          return { type: 'em', raw, text: body, tokens: this.inlineTokens(body) };
        }
        const body = raw.slice(2, -2);
        return { type: 'strong', raw, text: body, tokens: this.inlineTokens(body) };
      }
    }
  }

  delT(src, masked, startText) {
    const m = INLINE.delLDelim.exec(src);
    if (!m) return;
    if (!(m[1] || '') || !startText || PUNCT.exec(startText)) {
      const runLen = Array.from(m[0]).length - 1;
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
        let len = Array.from(run).length;
        if (len !== runLen) continue;
        if (hit[3] || hit[4]) {
          balance += len;
          continue;
        }
        balance -= len;
        if (balance > 0) continue;
        len = Math.min(len, len + balance);
        const lead = Array.from(hit[0])[0].length;
        const raw = src.slice(0, runLen + hit.index + lead + len);
        const body = raw.slice(runLen, -runLen);
        return { type: 'del', raw, text: body, tokens: this.inlineTokens(body) };
      }
    }
  }

  lastEmCloser(masked, ch) {
    const top = this.masks[this.masks.length - 1];
    if (top && top.maskedSrc === masked) return top.em[ch];
    return maskInfo(masked).em[ch];
  }

  lastDelCloser(masked) {
    const top = this.masks[this.masks.length - 1];
    if (top && top.maskedSrc === masked) return top.del;
    return maskInfo(masked).del;
  }

  codespanT(src) {
    const m = INLINE.code.exec(src);
    if (!m) return;
    let text = m[2].replace(/\n/g, ' ');
    const hasText = /[^ ]/.test(text);
    if (hasText && /^ /.test(text) && / $/.test(text)) text = text.substring(1, text.length - 1);
    return { type: 'codespan', raw: m[0], text };
  }

  brT(src) {
    const m = INLINE.br.exec(src);
    if (m) return { type: 'br', raw: m[0] };
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
    return { type: 'link', raw: m[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
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
    return { type: 'link', raw: m[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
  }

  textT(src) {
    const m = INLINE.text.exec(src);
    if (!m) return;
    const raw = m[0];
    const escaped = this.inRawBlock;
    return { type: 'text', raw, text: escaped ? raw : unescapeNumeric(raw), escaped };
  }
}

/** Index of the last delimiter run preceded by a non-space, as marked masks it. */
function maskInfo(masked) {
  const em = { '*': -1, '_': -1 };
  let del = -1;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c !== '*' && c !== '_' && c !== '~') continue;
    const prev = i === 0 ? '\n' : masked[i - 1];
    let j = i + 1;
    while (j < masked.length && masked[j] === c) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (c === '~') del = i;
      else em[c] = i;
    }
    i = j - 1;
  }
  return { maskedSrc: masked, em, del };
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

/** Split a GFM table row into trimmed cells. */
function splitRow(row, cols) {
  const spaced = row.replace(/\|/g, (all, offset, str) => {
    let escaped = false;
    let p = offset;
    while (--p >= 0 && str[p] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = spaced.split(/ \|/);
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
    for (let i = 0; i < tokens.length; i++) out += this.inlineToken(tokens[i], textMode);
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
  const lexer = new Lexer();
  const tokens = lexer.lex(markdown);
  return new Renderer().parse(tokens);
}
export { Lexer };
