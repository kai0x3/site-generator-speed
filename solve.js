// A fast static-site generator with byte-exact output parity against the
// makefun-site 1.0.0 reference build. The whole build for one case lives in
// run(): nothing is shared between calls, so a case can never observe the
// previous one. The implementation favours index-based scanning over
// per-character work and regular expressions, which is where the reference
// spends most of its time.

// ---------------------------------------------------------------------------
// Small text helpers
// ---------------------------------------------------------------------------

// HTML escaping, matching the reference's five replacements. Most spans of
// generated text contain no special character at all, so scan first and only
// pay for slicing when something actually needs replacing.
const ESC_REPLACEMENTS = {
  38: '&amp;', 60: '&lt;', 62: '&gt;', 34: '&quot;', 39: '&#39;',
};

function esc(s) {
  let first = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) { first = i; break; }
  }
  if (first === -1) return s;
  let out = s.slice(0, first);
  let span = first;
  for (let i = first; i < s.length; i++) {
    const rep = ESC_REPLACEMENTS[s.charCodeAt(i)];
    if (rep !== undefined) {
      if (i > span) out += s.slice(span, i);
      out += rep;
      span = i + 1;
    }
  }
  if (span < s.length) out += s.slice(span);
  return out;
}

// Whether a UTF-16 code unit is whitespace in the sense of the JavaScript
// \s class. Used wherever the reference relies on \s semantics.
function isWsCode(c) {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 ||
    c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8232 ||
    c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279;
}

function hasWs(s) {
  for (let i = 0; i < s.length; i++) if (isWsCode(s.charCodeAt(i))) return true;
  return false;
}

function byCodeUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// The slug rule: NFKD-normalise, drop combining marks, lowercase, fold every
// run of non [a-z0-9] characters into one dash, cap at 64 code units, drop a
// dangling dash, and fall back to "untitled". Pure-ASCII input (the common
// case by far) skips the normalisation entirely because ASCII text has no
// decompositions and no marks.
function slugifyRaw(text) {
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let c = ch;
    if (c >= 'A' && c <= 'Z') c = c.toLowerCase();
    if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) {
      if (gap && out !== '') out += '-';
      gap = false;
      out += c;
    } else {
      gap = true;
    }
  }
  if (out.length > 64) out = out.slice(0, 64);
  while (out.endsWith('-')) out = out.slice(0, -1);
  return out === '' ? 'untitled' : out;
}

function uniqueSlug(base, taken) {
  let slug = base;
  let n = 2;
  while (taken.has(slug)) {
    slug = `${base}-${n}`;
    n += 1;
  }
  taken.add(slug);
  return slug;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December',
];

function longDate(iso) {
  const parts = iso.split('-');
  return `${Number(parts[2])} ${MONTH_NAMES[Number(parts[1]) - 1]} ${parts[0]}`;
}

// Count the runs of non-whitespace in a body (the reference counts /\S+/g
// matches). A single pass over code units does the same job without building
// a match array. The whitespace test is inlined here because this loop runs
// over every body byte: the ASCII separators are checked first and the
// Unicode ones only for code units above 127.
function countWords(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws = c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 ||
      (c > 127 && (c === 160 || c === 5760 || (c >= 8192 && c <= 8202) ||
        c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 ||
        c === 65279));
    if (ws) {
      inWord = false;
    } else if (!inWord) {
      inWord = true;
      count += 1;
    }
  }
  return count;
}

function trimLine(s) {
  let a = 0;
  let b = s.length;
  while (a < b && (s.charCodeAt(a) === 32 || s.charCodeAt(a) === 9)) a += 1;
  while (b > a && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b -= 1;
  return a === 0 && b === s.length ? s : s.slice(a, b);
}

// ---------------------------------------------------------------------------
// Front matter
// ---------------------------------------------------------------------------

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

// A quoted string value: only \" and \\ escapes are allowed, and no bare
// quote may appear inside. Mirrors the reference's value reader exactly.
function readQuoted(raw) {
  if (raw.length < 2 || raw[raw.length - 1] !== '"') {
    return { error: 'a quoted string is not closed' };
  }
  let out = '';
  for (let i = 1; i < raw.length - 1; i++) {
    const c = raw[i];
    if (c === '\\') {
      const n = raw[i + 1];
      if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) {
        return { error: 'a quoted string holds an escape other than \\" or \\\\' };
      }
      out += n;
      i += 1;
    } else if (c === '"') {
      return { error: 'a quoted string holds a stray quote' };
    } else {
      out += c;
    }
  }
  return { value: out };
}

function readPlainString(raw) {
  if (raw[0] === '"') return readQuoted(raw);
  if (raw[0] === '[') return { error: 'a bare string opens on [' };
  return { value: raw };
}

function isDigitRun(s, from, to) {
  for (let i = from; i < to; i++) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  return true;
}

function readDateValue(raw) {
  const fail = { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
  if (raw.length !== 10 || raw[4] !== '-' || raw[7] !== '-' ||
      !isDigitRun(raw, 0, 4) || !isDigitRun(raw, 5, 7) || !isDigitRun(raw, 8, 10)) {
    return fail;
  }
  const year = Number(raw.slice(0, 4));
  const month = Number(raw.slice(5, 7));
  const day = Number(raw.slice(8, 10));
  if (year < 1970 || year > 2099 || month < 1 || month > 12) return fail;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysIn = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > daysIn[month - 1]) return fail;
  return { value: raw };
}

function readTagsValue(raw) {
  if (raw[0] !== '[' || raw[raw.length - 1] !== ']') {
    return { error: 'key "tags": not a list [a, b]' };
  }
  const inner = raw.slice(1, -1);
  if (inner.trim() === '') return { value: [] };
  const names = inner.split(',').map((part) => part.trim());
  for (const name of names) {
    if (name === '' || name.includes('"') || name.includes('[') || name.includes(']')) {
      return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
    }
  }
  return { value: names };
}

function isTemplateName(raw) {
  if (raw === '') return false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
  }
  return true;
}

function isSlugText(raw) {
  if (raw === '' || raw.length > 64) return false;
  let segment = 0;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c === 45) {
      if (segment === 0) return false;
      segment = 0;
    } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) {
      segment += 1;
    } else {
      return false;
    }
  }
  return segment > 0;
}

function readFmValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = readPlainString(raw);
      return s.error ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': return readDateValue(raw);
    case 'tags': return readTagsValue(raw);
    case 'draft':
      if (raw === 'true') return { value: true };
      if (raw === 'false') return { value: false };
      return { error: 'key "draft": true or false' };
    case 'layout':
      return isTemplateName(raw)
        ? { value: raw }
        : { error: 'key "layout": not a template name' };
    case 'slug':
      return isSlugText(raw) ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

// Split one front-matter line into key and value text. Returns null when the
// line is not shaped like "key: value" (key is [a-z_]+, then a colon, then
// either the end of the line or one space and the value). The value's
// trailing spaces and tabs are dropped.
function splitFmLine(line) {
  let k = 0;
  while (k < line.length) {
    const c = line.charCodeAt(k);
    if ((c >= 97 && c <= 122) || c === 95) k += 1;
    else break;
  }
  if (k === 0 || line[k] !== ':') return null;
  let raw;
  if (k + 1 === line.length) raw = '';
  else if (line[k + 1] === ' ') raw = line.slice(k + 2);
  else return null;
  let end = raw.length;
  while (end > 0 && (raw.charCodeAt(end - 1) === 32 || raw.charCodeAt(end - 1) === 9)) end -= 1;
  return { key: line.slice(0, k), raw: raw.slice(0, end) };
}

function isBlankFm(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Parse the front matter of one source. On success returns { data, body };
// on failure { error } with the reference's exact message.
function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  const line0 = firstNl === -1 ? text : text.slice(0, firstNl);
  if (line0 !== '---') return { error: 'no front matter' };
  // Find the closing line, remembering the lines in between.
  const fmLines = [];
  let pos = firstNl === -1 ? text.length : firstNl + 1;
  let body = null;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const line = nl === -1 ? text.slice(pos) : text.slice(pos, nl);
    if (line === '---') {
      body = nl === -1 ? '' : text.slice(nl + 1);
      break;
    }
    fmLines.push(line);
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (body === null) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 0; i < fmLines.length; i++) {
    const line = fmLines[i];
    if (isBlankFm(line) || line.startsWith('#')) continue;
    const split = splitFmLine(line);
    if (split === null) {
      return { error: `line ${i + 2} is not "key: value"` };
    }
    const { key, raw } = split;
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = readFmValue(key, raw);
    if (v.error) return { error: v.error };
    data[key] = v.value;
  }
  if (data.title === undefined) return { error: 'no title' };
  return { data, body };
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

// Characters a backslash can quote. Stored as a lookup table by char code.
const ESCAPABLE = new Set(
  ['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>'],
);

// Find `what` starting the search at `from`, skipping backslash-quoted
// characters, never looking past `hi`. Mirrors the reference's scanner.
function findUnescaped(s, what, from, hi) {
  const wlen = what.length;
  for (let j = from; j <= hi - wlen; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < hi && ESCAPABLE.has(s[j + 1])) {
      j += 1;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

// Find the next star that is not part of a ** pair, with the same quoting
// rule. The reference's walk skips a pair by stepping onto its second star
// and letting the loop step past it.
function findSingleStar(s, from, hi) {
  for (let j = from; j < hi; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < hi && ESCAPABLE.has(s[j + 1])) {
      j += 1;
      continue;
    }
    if (c !== '*') continue;
    if (j + 1 < hi && s[j + 1] === '*') {
      j += 1;
      continue;
    }
    return j;
  }
  return -1;
}

// Render inline markup over s[lo, hi) into the parts array. Plain runs are
// accumulated and escaped in bulk; only the marked-up segments recurse.
function inlineRange(s, lo, hi, env, parts) {
  let i = lo;
  let span = lo;
  const flush = (upto) => {
    if (upto > span) parts.push(esc(s.slice(span, upto)));
  };
  while (i < hi) {
    const code = s.charCodeAt(i);
    if (code === 92) { // backslash
      if (i + 1 < hi && ESCAPABLE.has(s[i + 1])) {
        flush(i);
        parts.push(esc(s[i + 1]));
        i += 2;
        span = i;
      } else {
        i += 1;
      }
      continue;
    }
    if (code === 96) { // backtick
      const j = s.indexOf('`', i + 1);
      if (j !== -1 && j < hi && j > i + 1) {
        flush(i);
        parts.push('<code>', esc(s.slice(i + 1, j)), '</code>');
        i = j + 1;
        span = i;
      } else {
        i += 1;
      }
      continue;
    }
    if (code === 42) { // star
      if (i + 1 < hi && s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2, hi);
        if (j > i + 2) {
          flush(i);
          parts.push('<strong>');
          inlineRange(s, i + 2, j, env, parts);
          parts.push('</strong>');
          i = j + 2;
          span = i;
        } else {
          i += 2;
        }
      } else {
        const j = findSingleStar(s, i + 1, hi);
        if (j > i + 1) {
          flush(i);
          parts.push('<em>');
          inlineRange(s, i + 1, j, env, parts);
          parts.push('</em>');
          i = j + 1;
          span = i;
        } else {
          i += 1;
        }
      }
      continue;
    }
    if (code === 91) { // [
      const k = findUnescaped(s, ']', i + 1, hi);
      let m = -1;
      if (k !== -1 && k + 1 < hi && s[k + 1] === '(') {
        const found = s.indexOf(')', k + 2);
        if (found !== -1 && found < hi) m = found;
      }
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !hasWs(target)) {
        flush(i);
        parts.push('<a href="', esc(env.link(target)), '">');
        inlineRange(s, i + 1, k, env, parts);
        parts.push('</a>');
        i = m + 1;
        span = i;
      } else {
        i += 1;
      }
      continue;
    }
    i += 1;
  }
  flush(hi);
}

function inlineStr(text, env) {
  if (text === '') return '';
  // Most headings, list items and many paragraphs carry no inline markup at
  // all; those only need escaping.
  let plain = true;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 92 || c === 96 || c === 42 || c === 91) { plain = false; break; }
  }
  if (plain) return esc(text);
  const parts = [];
  inlineRange(text, 0, text.length, env, parts);
  return parts.join('');
}

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// A fence opens with exactly three backticks, an optional language made of
// [A-Za-z0-9_+-], and nothing but spaces or tabs after. Returns the language
// (possibly '') or null.
function fenceOpen(line) {
  if (!line.startsWith('```')) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) ||
        c === 95 || c === 43 || c === 45) {
      i += 1;
    } else {
      break;
    }
  }
  const lang = line.slice(3, i);
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i += 1;
  }
  return lang;
}

function isFenceClose(line) {
  if (!line.startsWith('```')) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// A heading is 1-6 hashes, at least one space or tab, and some text (its own
// surrounding spaces and tabs are not part of the text). Returns
// { depth, text } or null.
function headingOf(line) {
  let h = 0;
  while (h < line.length && line.charCodeAt(h) === 35) h += 1;
  if (h === 0 || h > 6) return null;
  if (h >= line.length) return null;
  const after = line.charCodeAt(h);
  if (after !== 32 && after !== 9) return null;
  const text = trimLine(line.slice(h));
  if (text === '') return null;
  return { depth: h, text };
}

function isHr(line) {
  if (!line.startsWith('---') && !line.startsWith('***')) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// A bullet item starts with "- " or "* "; the item text is the rest.
function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

// An ordered item starts with 1-9 digits, a dot and a space.
function orderedOf(line) {
  let d = 0;
  while (d < line.length) {
    const c = line.charCodeAt(d);
    if (c >= 48 && c <= 57) d += 1;
    else break;
  }
  if (d === 0 || d > 9) return null;
  if (line.charCodeAt(d) !== 46 || line.charCodeAt(d + 1) !== 32) return null;
  return { num: Number(line.slice(0, d)), text: line.slice(d + 2) };
}

// A list continuation line: at least two leading spaces, then a non-space.
function isContinued(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 32) n += 1;
  if (n < 2 || n >= line.length) return false;
  return !isWsCode(line.charCodeAt(n));
}

function endsParagraph(line) {
  return isBlankLine(line) || fenceOpen(line) !== null ||
    headingOf(line) !== null || isHr(line);
}

// Render a Markdown body. Blocks are recognised and rendered in one pass;
// the heading table of contents (levels 2 and 3) and the first paragraph's
// inline HTML (the excerpt) are collected along the way.
function renderMarkdown(src, env, slug) {
  const lines = src.split('\n');
  const ids = new Set();
  const toc = [];
  const parts = [];
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlankLine(line)) {
      i += 1;
      continue;
    }
    const lang = fenceOpen(line);
    if (lang !== null) {
      i += 1;
      let body = '';
      while (i < n && !isFenceClose(lines[i])) {
        body += esc(lines[i]) + '\n';
        i += 1;
      }
      i += 1;
      parts.push('<pre><code');
      if (lang !== '') parts.push(` class="language-${esc(lang)}"`);
      parts.push('>', body, '</code></pre>\n');
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slug(heading.text), ids);
      const html = inlineStr(heading.text, env);
      parts.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>\n`);
      if (heading.depth === 2 || heading.depth === 3) {
        toc.push({ level: heading.depth, id, html });
      }
      i += 1;
      continue;
    }
    if (isHr(line)) {
      parts.push('<hr>\n');
      i += 1;
      continue;
    }
    if (line.charCodeAt(0) === 62) { // >
      const kept = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let l = lines[i].slice(1);
        if (l.charCodeAt(0) === 32) l = l.slice(1);
        l = trimLine(l);
        if (l !== '') kept.push(l);
        i += 1;
      }
      if (kept.length === 0) {
        parts.push('<blockquote>\n</blockquote>\n');
      } else {
        parts.push('<blockquote>\n<p>', inlineStr(kept.join('\n'), env), '</p>\n</blockquote>\n');
      }
      continue;
    }
    const bullet = bulletOf(line);
    const ordered = bullet === null ? orderedOf(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrd = ordered !== null;
      const items = [];
      let cur = null;
      while (i < n) {
        const l = lines[i];
        const m = isOrd ? orderedOf(l) : bulletOf(l);
        if (m !== null) {
          cur = [trimLine(isOrd ? m.text : m)];
          items.push(cur);
          i += 1;
        } else if (isContinued(l)) {
          cur.push(trimLine(l));
          i += 1;
        } else {
          break;
        }
      }
      const tag = isOrd ? 'ol' : 'ul';
      let block = (isOrd && ordered.num !== 1 ? `<ol start="${ordered.num}">` : `<${tag}>`) + '\n';
      for (const item of items) {
        block += `<li>${inlineStr(item.join('\n'), env)}</li>\n`;
      }
      block += `</${tag}>\n`;
      parts.push(block);
      continue;
    }
    const plines = [trimLine(line)];
    i += 1;
    while (i < n && !endsParagraph(lines[i])) {
      plines.push(trimLine(lines[i]));
      i += 1;
    }
    const html = inlineStr(plines.join('\n'), env);
    if (excerpt === null) excerpt = html;
    parts.push(`<p>${html}</p>\n`);
  }
  return { html: parts.join(''), toc, excerpt: excerpt === null ? '' : excerpt };
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

class TemplateError extends Error {}

// A path is dot-joined names, each [A-Za-z_][A-Za-z0-9_]*. Returns the name
// list, or null when the text is not a path.
function readPath(text) {
  if (text === '') return null;
  const names = text.split('.');
  for (const name of names) {
    if (name === '') return null;
    const c0 = name.charCodeAt(0);
    if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122) || c0 === 95)) return null;
    for (let i = 1; i < name.length; i++) {
      const c = name.charCodeAt(i);
      if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
            (c >= 48 && c <= 57) || c === 95)) return null;
    }
  }
  return names;
}

function isSpaceTabOnly(s, from, to) {
  for (let i = from; i < to; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Split a template into text, variable and tag tokens. A {% %} tag that sits
// alone on its line takes the whole line, newline included.
function tokenizeTemplate(name, src) {
  const fail = (msg) => {
    throw new TemplateError(`template "${name}": ${msg}`);
  };
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const closeMark = raw ? '}}}' : '}}';
      const close = src.indexOf(closeMark, open + (raw ? 3 : 2));
      if (close === -1) fail(`a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', s: text });
      text = '';
      const inner = src.slice(open + (raw ? 3 : 2), close).trim();
      const path = readPath(inner);
      if (path === null) fail(`${JSON.stringify(inner)} is not a path`);
      tokens.push({ t: raw ? 'raw' : 'var', path });
      i = close + closeMark.length;
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) fail('a {% is not closed');
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone =
      isSpaceTabOnly(src, lineStart, open) && isSpaceTabOnly(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', s: text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', s: text });
  return tokens;
}

// Match "for <name> in <path>" exactly; returns { name, pathText } or null.
function matchForTag(tag) {
  if (!tag.startsWith('for ')) return null;
  let i = 4;
  const c0 = tag.charCodeAt(4);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122) || c0 === 95)) return null;
  i = 5;
  while (i < tag.length) {
    const c = tag.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
        (c >= 48 && c <= 57) || c === 95) i += 1;
    else break;
  }
  const name = tag.slice(4, i);
  if (!tag.startsWith(' in ', i)) return null;
  const pathText = tag.slice(i + 4);
  if (pathText === '' || hasWs(pathText)) return null;
  return { name, pathText };
}

// Match "if <path>" or "if not <path>"; returns { not, pathText } or null.
function matchIfTag(tag) {
  if (!tag.startsWith('if ')) return null;
  let rest = tag.slice(3);
  let not = false;
  if (rest.startsWith('not ')) {
    not = true;
    rest = rest.slice(4);
  }
  if (rest === '' || hasWs(rest)) return null;
  return { not, pathText: rest };
}

// Match include "<name>" with a [a-z0-9-]+ template name; returns the name
// or null.
function matchIncludeTag(tag) {
  if (!tag.startsWith('include "') || !tag.endsWith('"') || tag.length <= 9) {
    return null;
  }
  const inner = tag.slice(9, -1);
  if (inner === '') return null;
  for (let i = 0; i < inner.length; i++) {
    const c = inner.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return null;
  }
  return inner;
}

function parseTemplate(name, src) {
  const fail = (msg) => {
    throw new TemplateError(`template "${name}": ${msg}`);
  };
  const root = [];
  const stack = [{ kind: 'root', nodes: root }];
  const top = () => stack[stack.length - 1];
  for (const tok of tokenizeTemplate(name, src)) {
    if (tok.t === 'text') {
      top().nodes.push({ t: 'text', s: tok.s });
      continue;
    }
    if (tok.t === 'var' || tok.t === 'raw') {
      top().nodes.push(tok);
      continue;
    }
    const tag = tok.tag;
    const forMatch = matchForTag(tag);
    if (forMatch !== null) {
      const path = readPath(forMatch.pathText);
      if (path === null) fail(`${JSON.stringify(forMatch.pathText)} is not a path`);
      const node = { t: 'for', name: forMatch.name, path, body: [] };
      top().nodes.push(node);
      stack.push({ kind: 'for', nodes: node.body });
      continue;
    }
    const ifMatch = matchIfTag(tag);
    if (ifMatch !== null) {
      const path = readPath(ifMatch.pathText);
      if (path === null) fail(`${JSON.stringify(ifMatch.pathText)} is not a path`);
      const node = {
        t: 'if', path, not: ifMatch.not, then: [], otherwise: null,
      };
      top().nodes.push(node);
      stack.push({ kind: 'if', nodes: node.then, node });
      continue;
    }
    if (tag === 'else') {
      const frame = top();
      if (frame.kind !== 'if' || frame.node.otherwise !== null) {
        fail('an else outside an if');
      }
      frame.node.otherwise = [];
      frame.nodes = frame.node.otherwise;
      continue;
    }
    if (tag === 'endfor' || tag === 'endif') {
      if (top().kind !== tag.slice(3)) fail(`an ${tag} with no open ${tag.slice(3)}`);
      stack.pop();
      continue;
    }
    const include = matchIncludeTag(tag);
    if (include !== null) {
      top().nodes.push({ t: 'include', name: include });
      continue;
    }
    fail(`{% ${tag} %} is not a tag`);
  }
  if (stack.length > 1) fail(`a ${top().kind} is not closed`);
  return root;
}

function lookupName(scope, path) {
  let s = scope;
  const head = path[0];
  while (s !== null && !Object.hasOwn(s.vars, head)) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[head];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) {
      return undefined;
    }
    v = v[path[k]];
  }
  return v;
}

function valueText(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(valueText).join(', ');
  return '';
}

function isTruthy(v) {
  if (v === undefined || v === null || v === false || v === '' || v === 0) {
    return false;
  }
  if (Array.isArray(v) && v.length === 0) return false;
  return true;
}

function renderNodes(nodes, scope, ctx, depth) {
  let out = '';
  for (const node of nodes) {
    switch (node.t) {
      case 'text':
        out += node.s;
        break;
      case 'var': {
        const v = lookupName(scope, node.path);
        out += esc(typeof v === 'string' ? v : valueText(v));
        break;
      }
      case 'raw': {
        const v = lookupName(scope, node.path);
        out += typeof v === 'string' ? v : valueText(v);
        break;
      }
      case 'for': {
        const xs = lookupName(scope, node.path);
        if (Array.isArray(xs)) {
          for (let idx = 0; idx < xs.length; idx++) {
            const vars = {
              [node.name]: xs[idx],
              loop: {
                index: idx + 1,
                first: idx === 0,
                last: idx === xs.length - 1,
                length: xs.length,
              },
            };
            out += renderNodes(node.body, { vars, parent: scope }, ctx, depth);
          }
        }
        break;
      }
      case 'if': {
        let show = isTruthy(lookupName(scope, node.path));
        if (node.not) show = !show;
        if (show) out += renderNodes(node.then, scope, ctx, depth);
        else if (node.otherwise !== null) {
          out += renderNodes(node.otherwise, scope, ctx, depth);
        }
        break;
      }
      case 'include': {
        if (depth < 8) {
          // An include whose target only ever reads the case-constant root
          // values (site, tags, recent) renders the same string every time
          // it is reached from a top-level render, so it is computed once
          // per build. build() marks such nodes cacheOk; the depth check
          // keeps deeper renders on the exact reference path.
          if (depth === 0 && node.cacheOk === true) {
            let hit = ctx.includeCache.get(node.name);
            if (hit === undefined) {
              const sub = ctx.templates.get(node.name);
              hit = sub === undefined ? '' : renderNodes(sub, scope, ctx, 1);
              ctx.includeCache.set(node.name, hit);
            }
            out += hit;
          } else {
            const sub = ctx.templates.get(node.name);
            if (sub !== undefined) out += renderNodes(sub, scope, ctx, depth + 1);
          }
        }
        break;
      }
      default:
        break;
    }
  }
  return out;
}

// The head names a template's rendering can observe from its scope: every
// variable path head it reads that is not bound by one of its own loops,
// following includes (which render in the same scope). Returns null when
// the include graph cycles or nests implausibly deep, in which case the
// template is treated as fully scope-dependent.
function freeNamesOf(templates, rootName) {
  const memo = new Map();
  const resolve = (name, stack) => {
    if (memo.has(name)) return memo.get(name);
    const nodes = templates.get(name);
    if (nodes === undefined) return new Set();
    if (stack.has(name)) return null;
    stack.add(name);
    const acc = new Set();
    const walk = (list, bound) => {
      for (const node of list) {
        if (node.t === 'var' || node.t === 'raw' || node.t === 'if') {
          if (!bound.has(node.path[0])) acc.add(node.path[0]);
          if (node.t === 'if') {
            walk(node.then, bound);
            if (node.otherwise !== null) walk(node.otherwise, bound);
          }
        } else if (node.t === 'for') {
          if (!bound.has(node.path[0])) acc.add(node.path[0]);
          const inner = new Set(bound);
          inner.add(node.name);
          inner.add('loop');
          walk(node.body, inner);
        } else if (node.t === 'include') {
          if (stack.size > 8) {
            acc.add(' deep');
          } else {
            const sub = resolve(node.name, stack);
            if (sub === null) acc.add(' cycle');
            else for (const n of sub) if (!bound.has(n)) acc.add(n);
          }
        }
      }
    };
    walk(nodes, new Set());
    stack.delete(name);
    const result = (acc.has(' deep') || acc.has(' cycle')) ? null : acc;
    memo.set(name, result);
    return result;
  };
  return resolve(rootName, new Set());
}

// Names bound by any for loop in any template of the case.
function allBoundNames(templates) {
  const bound = new Set();
  const walk = (list) => {
    for (const node of list) {
      if (node.t === 'for') {
        bound.add(node.name);
        walk(node.body);
      } else if (node.t === 'if') {
        walk(node.then);
        if (node.otherwise !== null) walk(node.otherwise);
      }
    }
  };
  for (const nodes of templates.values()) walk(nodes);
  return bound;
}

// ---------------------------------------------------------------------------
// The build
// ---------------------------------------------------------------------------

const RESERVED_DIRS = ['posts', 'tags', 'page'];

function dirOf(path) {
  const at = path.lastIndexOf('/');
  return at === -1 ? '' : path.slice(0, at);
}

// Resolve a link path against a directory, honouring . and .. without ever
// climbing above the root; returns null when it would escape.
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.join('/');
}

function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true; // :
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
          (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) {
      return false;
    }
  }
  return false;
}

function build(input) {
  // Slugs repeat constantly across a case (tag names come from a small pool,
  // headings repeat), so memoise slugify within the call.
  const slugCache = new Map();
  const slug = (text) => {
    let v = slugCache.get(text);
    if (v === undefined) {
      v = slugifyRaw(text);
      slugCache.set(text, v);
    }
    return v;
  };

  const report = [];
  const templates = new Map();
  const templateNames = Object.keys(input.templates).sort(byCodeUnits);
  for (const name of templateNames) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const templateCtx = { templates, includeCache: new Map() };
  // Mark include nodes whose target reads only the case-constant root
  // values (site, tags, recent): those renders can be reused all case long.
  // The marking is skipped entirely if any loop in any template binds one
  // of those names, since such a binding could shadow the root value.
  {
    const boundAnywhere = allBoundNames(templates);
    if (!boundAnywhere.has('site') && !boundAnywhere.has('tags') &&
        !boundAnywhere.has('recent')) {
      const constant = new Set(['site', 'tags', 'recent']);
      const annotate = (list) => {
        for (const node of list) {
          if (node.t === 'include') {
            const free = freeNamesOf(templates, node.name);
            node.cacheOk = free !== null &&
              [...free].every((n) => constant.has(n));
          } else if (node.t === 'for') {
            annotate(node.body);
          } else if (node.t === 'if') {
            annotate(node.then);
            if (node.otherwise !== null) annotate(node.otherwise);
          }
        }
      };
      for (const nodes of templates.values()) annotate(nodes);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // -- read the sources -----------------------------------------------------
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      let text = f.content;
      if (text.includes('\r')) text = text.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, text });
    } else {
      statics.push({ path: f.path, content: f.content });
    }
  }

  // -- front matter ---------------------------------------------------------
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if (fm.error !== undefined) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    const own = RESERVED_DIRS.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    if (s.post && s.data.date === undefined) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    s.layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(s.layout)) {
      report.push(`refused ${s.path}: layout "${s.layout}" is no template that parses`);
      continue;
    }
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // -- permalinks -----------------------------------------------------------
  const takenByDir = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let taken = takenByDir.get(dir);
    if (taken === undefined) {
      taken = dir === '' ? new Set(RESERVED_DIRS) : new Set();
      takenByDir.set(dir, taken);
    }
    s.slug = uniqueSlug(s.data.slug ?? slug(s.data.title), taken);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // -- markdown -------------------------------------------------------------
  const broken = new Set();
  const staticPaths = new Set(statics.map((f) => f.path));
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (hasScheme(target) || target.startsWith('/') || target.startsWith('#')) {
          return target;
        }
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const resolved = rel === '' ? null : resolvePath(dir, rel);
        if (resolved !== null) {
          const dest = bySource.get(resolved);
          if (dest !== undefined) return dest.url + frag;
          if (staticPaths.has(resolved)) return `${base}/${resolved}${frag}`;
        }
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const rendered = renderMarkdown(s.body, env, slug);
    s.html = rendered.html;
    s.toc = rendered.toc;
    s.excerpt = rendered.excerpt;
  }

  // -- collections ----------------------------------------------------------
  const posts = kept
    .filter((s) => s.post)
    .sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let i = 0; i < posts.length; i++) {
    posts[i].newer = posts[i - 1] ?? null;
    posts[i].older = posts[i + 1] ?? null;
  }
  for (const s of kept) {
    if (!s.post) {
      s.newer = null;
      s.older = null;
    }
  }

  // -- tags -----------------------------------------------------------------
  const ownTagsOf = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const sl = slug(name);
      if (!seen.has(sl)) {
        seen.add(sl);
        out.push(name);
      }
    }
    return out;
  };
  const tagsBySlug = new Map();
  for (const p of posts) {
    for (const name of ownTagsOf(p)) {
      const sl = slug(name);
      let t = tagsBySlug.get(sl);
      if (t === undefined) {
        t = { name, slug: sl, url: `${base}/tags/${sl}/`, posts: [] };
        tagsBySlug.set(sl, t);
      }
      t.posts.push(p);
    }
  }
  for (const s of kept) {
    s.tagRefs = ownTagsOf(s).map((name) => {
      const t = tagsBySlug.get(slug(name));
      if (t !== undefined) return { name: t.name, slug: t.slug, url: t.url };
      return { name, slug: slug(name), url: '', posts: [] };
    });
  }
  const allTags = [...tagsBySlug.values()]
    .sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug))
    .map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));

  // -- layouts --------------------------------------------------------------
  const siteView = { title: input.site.title, base_url: base };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const scope = {
      vars: { site: siteView, tags: allTags, recent: recentCards, ...vars },
      parent: null,
    };
    return renderNodes(nodes, scope, templateCtx, 0);
  };
  const cardOf = (s) => {
    if (s.card !== undefined) return s.card;
    const card = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(countWords(s.body) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
    s.card = card;
    return card;
  };
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const recentCards = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const linkOf = (s) => (s === null
    ? null
    : {
        title: s.data.title,
        url: s.url,
        date: s.data.date ?? '',
        date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      });
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  const output = {};
  for (const s of kept) {
    output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  }
  const perPage = input.site.per_page;
  const pageCount = Math.max(1, Math.ceil(posts.length / perPage));
  for (let k = 1; k <= pageCount; k++) {
    const path = k === 1 ? 'index.html' : `page/${k}/index.html`;
    const pager = {
      number: k,
      total: pageCount,
      url: k === 1 ? `${base}/` : `${base}/page/${k}/`,
      newer_url: k === 1 ? '' : (k === 2 ? `${base}/` : `${base}/page/${k - 1}/`),
      older_url: k === pageCount ? '' : `${base}/page/${k + 1}/`,
    };
    const cardsPage = posts.slice((k - 1) * perPage, k * perPage).map((p) => cards.get(p));
    const html = render('index', { posts: cardsPage, pager });
    if (html !== null) output[path] = html;
  }
  for (const t of allTags) {
    const full = tagsBySlug.get(t.slug);
    const view = {
      name: full.name,
      slug: full.slug,
      url: full.url,
      count: full.posts.length,
      posts: full.posts.map((p) => cards.get(p)),
    };
    const html = render('tag', { tag: view });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  let staticCount = 0;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) {
      report.push(`shadowed ${f.path}: a built page has its path`);
    } else {
      output[f.path] = f.content;
      staticCount += 1;
    }
  }

  // -- the build report -----------------------------------------------------
  const pageCountSources = kept.filter((s) => !s.post).length;
  const lines = [...report, ...broken].sort(byCodeUnits);
  lines.push(
    `built ${pageCountSources} pages, ${posts.length} posts, ${tagsBySlug.size} tags and ${staticCount} static files`,
  );
  output['build-report.txt'] = lines.map((l) => `${l}\n`).join('');
  return output;
}

export function run(input) {
  return build(input);
}
