'use strict';
/**
 * Plain text out of a PDF, with no parser dependency.
 *
 * The same bargain as the .docx reader: a PDF's text lives in content streams
 * that are almost always FlateDecode, and `node:zlib` already has the inflate
 * half. What is left is bookkeeping — find the objects, decode the streams,
 * walk the text operators, and map bytes back to characters through the font's
 * ToUnicode table.
 *
 * This is deliberately not a full PDF implementation. It reads the kind of file
 * a resume actually is: text, laid out by Word, Google Docs, LaTeX or this app
 * itself. It does not do encrypted files, and it cannot do scanned images,
 * because there is no text in those to find. `extractPdfText` returns what it
 * got plus an honest `quality` flag, and the caller refuses anything that does
 * not read like prose rather than showing somebody mojibake and calling it a CV.
 */
const zlib = require('node:zlib');

/* ------------------------------------------------------------- plumbing --- */

/** PDF streams are zlib, occasionally raw-deflate from older writers. */
function inflate(buf) {
  try { return zlib.inflateSync(buf); } catch { /* try raw */ }
  try { return zlib.inflateRawSync(buf); } catch { /* not deflate at all */ }
  return null;
}

/** Reads `<< ... >>` from `at`, honouring nesting, and returns the inner text. */
function readDict(s, at) {
  if (s.slice(at, at + 2) !== '<<') return '';
  let depth = 0;
  for (let i = at; i < s.length - 1; i++) {
    if (s[i] === '<' && s[i + 1] === '<') { depth++; i++; continue; }
    if (s[i] === '>' && s[i + 1] === '>') {
      depth--;
      if (depth === 0) return s.slice(at + 2, i);
      i++;
    }
  }
  return '';
}

/**
 * Every `N G obj … endobj` in the file, as {dict, stream}. Streams are located
 * by their delimiters rather than by /Length, because /Length is frequently an
 * indirect reference that would have to be resolved first.
 */
function parseObjects(latin1) {
  const objects = new Map();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = re.exec(latin1))) {
    const num = Number(m[1]);
    const bodyStart = m.index + m[0].length;
    const end = latin1.indexOf('endobj', bodyStart);
    const body = latin1.slice(bodyStart, end === -1 ? latin1.length : end);

    const dictAt = body.indexOf('<<');
    const dict = dictAt === -1 ? '' : readDict(body, dictAt);

    let stream = null;
    const sAt = body.indexOf('stream');
    if (sAt !== -1) {
      let from = sAt + 'stream'.length;
      if (body[from] === '\r') from++;
      if (body[from] === '\n') from++;
      const to = body.lastIndexOf('endstream');
      if (to > from) stream = Buffer.from(body.slice(from, to), 'latin1');
    }
    objects.set(num, { dict, stream });
  }
  return objects;
}

const hasFlate = (dict) => /\/Filter\s*(?:\/FlateDecode|\[\s*\/FlateDecode)/.test(dict);

/** The decoded bytes of an object's stream, or null. */
function streamText(obj) {
  if (!obj?.stream) return null;
  const raw = hasFlate(obj.dict) ? inflate(obj.stream) : obj.stream;
  return raw ? raw.toString('latin1') : null;
}

/**
 * PDF 1.5+ packs many small objects into one compressed /ObjStm. Fonts and
 * ToUnicode maps hide in there, so they have to be unpacked or every character
 * comes back unmapped.
 */
function expandObjectStreams(objects) {
  for (const [, obj] of [...objects]) {
    if (!/\/Type\s*\/ObjStm/.test(obj.dict)) continue;
    const body = streamText(obj);
    if (!body) continue;
    const n = Number((obj.dict.match(/\/N\s+(\d+)/) || [])[1] || 0);
    const first = Number((obj.dict.match(/\/First\s+(\d+)/) || [])[1] || 0);
    const header = body.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < n; i++) {
      const num = header[i * 2];
      const off = header[i * 2 + 1];
      if (!Number.isFinite(num) || !Number.isFinite(off)) continue;
      if (objects.has(num) && objects.get(num).dict) continue;   // real object wins
      const next = i + 1 < n ? header[(i + 1) * 2 + 1] : body.length - first;
      const chunk = body.slice(first + off, first + next);
      const dictAt = chunk.indexOf('<<');
      objects.set(num, { dict: dictAt === -1 ? chunk : readDict(chunk, dictAt), stream: null });
    }
  }
  return objects;
}

/* ---------------------------------------------------------------- fonts --- */

const hexToUtf16 = (hex) => {
  let out = '';
  for (let i = 0; i + 3 < hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
  if (hex.length === 2) out = String.fromCharCode(parseInt(hex, 16));
  return out;
};

/**
 * A ToUnicode CMap: which byte code means which character. Without this, text
 * from any subset-embedded font — which is what Word and Google Docs produce —
 * comes out as arbitrary glyph indices.
 */
function parseCMap(text) {
  const map = new Map();
  let twoByte = false;

  const space = text.match(/begincodespacerange([\s\S]*?)endcodespacerange/);
  if (space) {
    const first = space[1].match(/<([0-9A-Fa-f]+)>/);
    if (first && first[1].length >= 4) twoByte = true;
  }

  for (const block of text.match(/beginbfchar([\s\S]*?)endbfchar/g) || []) {
    const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let m;
    while ((m = re.exec(block))) {
      if (m[1].length >= 4) twoByte = true;
      map.set(parseInt(m[1], 16), hexToUtf16(m[2]));
    }
  }

  for (const block of text.match(/beginbfrange([\s\S]*?)endbfrange/g) || []) {
    // <lo> <hi> <dst>  — a run mapped to consecutive characters
    const runRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let m;
    while ((m = runRe.exec(block))) {
      if (m[1].length >= 4) twoByte = true;
      const lo = parseInt(m[1], 16);
      const hi = parseInt(m[2], 16);
      const dst = parseInt(m[3], 16);
      if (hi - lo > 65535) continue;
      for (let c = lo; c <= hi; c++) map.set(c, String.fromCharCode(dst + (c - lo)));
    }
    // <lo> <hi> [<d1> <d2> …] — a run mapped to a list
    const listRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/g;
    while ((m = listRe.exec(block))) {
      if (m[1].length >= 4) twoByte = true;
      const lo = parseInt(m[1], 16);
      const items = m[3].match(/<([0-9A-Fa-f]+)>/g) || [];
      items.forEach((item, i) => map.set(lo + i, hexToUtf16(item.slice(1, -1))));
    }
  }
  return { map, twoByte };
}

/**
 * Font resource name (`/F1`) to its character map. Built across the whole
 * document rather than per page: a resume uses the same handful of fonts
 * throughout, and resolving each page's resource dictionary separately buys
 * nothing for the extra machinery.
 */
function buildFontMap(objects) {
  const byNumber = new Map();
  for (const [num, obj] of objects) {
    if (!/\/Type\s*\/Font/.test(obj.dict)) continue;
    const ref = obj.dict.match(/\/ToUnicode\s+(\d+)\s+\d+\s+R/);
    if (!ref) { byNumber.set(num, null); continue; }
    const cmapText = streamText(objects.get(Number(ref[1])));
    byNumber.set(num, cmapText ? parseCMap(cmapText) : null);
  }

  const byName = new Map();
  for (const [, obj] of objects) {
    const fontsAt = obj.dict.indexOf('/Font');
    if (fontsAt === -1) continue;
    const dictAt = obj.dict.indexOf('<<', fontsAt);
    if (dictAt === -1) continue;
    const inner = readDict(obj.dict, dictAt);
    const re = /\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g;
    let m;
    while ((m = re.exec(inner))) {
      const cmap = byNumber.get(Number(m[2]));
      if (cmap && !byName.has(m[1])) byName.set(m[1], cmap);
    }
  }
  return byName;
}

/* ------------------------------------------------------------ the text ---- */

const ESCAPES = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };

/** Content streams are PostScript-ish; this yields only what text needs. */
function* tokenise(s) {
  let i = 0;
  while (i < s.length) {
    const c = s[i];

    if (c === '%') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\f' || c === '\0') { i++; continue; }

    if (c === '(') {                                   // literal string
      let depth = 1;
      let j = i + 1;
      const buf = [];
      while (j < s.length && depth > 0) {
        const ch = s[j];
        if (ch === '\\') {
          const next = s[j + 1];
          if (next in ESCAPES) { buf.push(ESCAPES[next]); j += 2; continue; }
          if (next >= '0' && next <= '7') {
            let oct = '';
            let k = j + 1;
            while (k < s.length && oct.length < 3 && s[k] >= '0' && s[k] <= '7') { oct += s[k]; k++; }
            buf.push(String.fromCharCode(parseInt(oct, 8)));
            j = k; continue;
          }
          if (next === '\n') { j += 2; continue; }      // line continuation
          if (next === '\r') { j += (s[j + 2] === '\n' ? 3 : 2); continue; }
          j += 2; continue;
        }
        if (ch === '(') { depth++; buf.push(ch); j++; continue; }
        if (ch === ')') { depth--; j++; if (depth === 0) break; buf.push(ch); continue; }
        buf.push(ch); j++;
      }
      yield { t: 'str', v: buf.join('') };
      i = j; continue;
    }

    if (c === '<' && s[i + 1] === '<') {                // dictionary, not a string
      yield { t: 'op', v: '<<' }; i += 2; continue;
    }
    if (c === '>' && s[i + 1] === '>') { yield { t: 'op', v: '>>' }; i += 2; continue; }

    if (c === '<') {                                    // hex string
      const end = s.indexOf('>', i);
      const hex = (end === -1 ? '' : s.slice(i + 1, end)).replace(/[^0-9A-Fa-f]/g, '');
      let out = '';
      for (let k = 0; k + 1 < hex.length; k += 2) out += String.fromCharCode(parseInt(hex.slice(k, k + 2), 16));
      if (hex.length % 2) out += String.fromCharCode(parseInt(`${hex[hex.length - 1]}0`, 16));
      yield { t: 'str', v: out };
      i = end === -1 ? s.length : end + 1; continue;
    }

    if (c === '/') {
      let j = i + 1;
      while (j < s.length && !/[\s/<>[\]()%]/.test(s[j])) j++;
      yield { t: 'name', v: s.slice(i + 1, j) };
      i = j; continue;
    }

    // Array delimiters are punctuation, not operators. Yielding them as
    // operators made the reader clear its operand stack on the "[" and again
    // on the "]", so a `[(text) -250 (more)] TJ` arrived with nothing left to
    // show — which is most of the text in most PDFs.
    if (c === '[' || c === ']') { yield { t: 'arr', v: c }; i++; continue; }

    if (/[-+.\d]/.test(c)) {
      let j = i;
      while (j < s.length && /[-+.\d]/.test(s[j])) j++;
      yield { t: 'num', v: Number(s.slice(i, j)) || 0 };
      i = j; continue;
    }

    let j = i;
    while (j < s.length && !/[\s/<>[\]()%]/.test(s[j])) j++;
    if (j === i) j++;
    yield { t: 'op', v: s.slice(i, j) };
    i = j;
  }
}

/**
 * WinAnsiEncoding is Latin-1 except for 0x80–0x9F, where Latin-1 has control
 * codes and WinAnsi has the punctuation that fills real documents: en dashes,
 * bullets, curly quotes. Without this table a date range reads "Apr 2023 ?
 * Present" and stops parsing as a range at all, which loses every job on the
 * CV. This is the single highest-value table in the file.
 */
const WIN_ANSI = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡',
  0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž', 0x91: '‘',
  0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜',
  0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
};

const fromByte = (code) => WIN_ANSI[code] ?? String.fromCharCode(code);

/** Bytes to characters, through the font's map when there is one. */
function decode(raw, font) {
  if (!font || !font.map || font.map.size === 0) {
    let plain = '';
    for (let i = 0; i < raw.length; i++) plain += fromByte(raw.charCodeAt(i));
    return plain;
  }
  if (font.twoByte) {
    let out = '';
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const code = (raw.charCodeAt(i) << 8) | raw.charCodeAt(i + 1);
      out += font.map.get(code) ?? '';
    }
    return out;
  }
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    out += font.map.get(code) ?? fromByte(code);
  }
  return out;
}

/**
 * Walks one content stream, emitting text. A PDF has no notion of a line — it
 * positions each run — so line breaks are inferred from vertical movement,
 * which is what Td, TD, T*, Tm and TL actually encode.
 */
function textFromStream(content, fonts) {
  let out = '';
  let font = null;
  let stack = [];
  let y = null;
  let leading = 0;
  let pendingBreak = false;

  const newline = () => { pendingBreak = true; };
  const write = (s) => {
    if (!s) return;
    if (pendingBreak) { out += '\n'; pendingBreak = false; }
    out += s;
  };

  for (const tok of tokenise(content)) {
    if (tok.t !== 'op') { stack.push(tok); continue; }

    switch (tok.v) {
      case 'Tf': {
        const name = [...stack].reverse().find((t) => t.t === 'name');
        if (name) font = fonts.get(name.v) || null;
        break;
      }
      case 'Tj': case "'": case '"': {
        if (tok.v !== 'Tj') newline();
        const str = [...stack].reverse().find((t) => t.t === 'str');
        if (str) write(decode(str.v, font));
        break;
      }
      case 'TJ': {
        let line = '';
        for (const t of stack) {
          if (t.t === 'str') line += decode(t.v, font);
          // A large negative kern is how PDFs draw a word space.
          else if (t.t === 'num' && t.v < -180 && line && !line.endsWith(' ')) line += ' ';
        }
        write(line);
        break;
      }
      case 'TD': case 'Td': {
        const nums = stack.filter((t) => t.t === 'num');
        const ty = nums.length >= 2 ? nums[nums.length - 1].v : 0;
        if (tok.v === 'TD') leading = -ty;
        if (ty !== 0) newline();
        break;
      }
      case 'T*': newline(); break;
      case 'TL': {
        const n = stack.filter((t) => t.t === 'num').pop();
        if (n) leading = n.v;
        break;
      }
      case 'Tm': {
        const nums = stack.filter((t) => t.t === 'num');
        if (nums.length >= 6) {
          const newY = nums[5].v;
          if (y !== null && Math.abs(newY - y) > Math.max(1, leading * 0.4)) newline();
          y = newY;
        }
        break;
      }
      case 'BT': y = null; break;
      case 'ET': newline(); break;
      default: break;
    }
    stack = [];
  }
  return out;
}

/** Content streams in page order where the page tree can be followed. */
function contentStreamNumbers(objects) {
  const refs = [];
  const seen = new Set();

  const pushRefs = (dict) => {
    const single = dict.match(/\/Contents\s+(\d+)\s+\d+\s+R/);
    if (single) { refs.push(Number(single[1])); return; }
    const arr = dict.match(/\/Contents\s*\[([^\]]*)\]/);
    if (arr) {
      const re = /(\d+)\s+\d+\s+R/g;
      let m;
      while ((m = re.exec(arr[1]))) refs.push(Number(m[1]));
    }
  };

  const walk = (num, depth = 0) => {
    if (depth > 60 || seen.has(num)) return;
    seen.add(num);
    const obj = objects.get(num);
    if (!obj) return;
    if (/\/Type\s*\/Page\b/.test(obj.dict)) { pushRefs(obj.dict); return; }
    const kids = obj.dict.match(/\/Kids\s*\[([\s\S]*?)\]/);
    if (kids) {
      const re = /(\d+)\s+\d+\s+R/g;
      let m;
      while ((m = re.exec(kids[1]))) walk(Number(m[1]), depth + 1);
    }
  };

  for (const [num, obj] of objects) {
    if (/\/Type\s*\/Catalog/.test(obj.dict)) {
      const pages = obj.dict.match(/\/Pages\s+(\d+)\s+\d+\s+R/);
      if (pages) walk(Number(pages[1]));
    } else if (/\/Type\s*\/Pages\b/.test(obj.dict) && refs.length === 0 && !seen.size) {
      walk(num);
    }
  }

  if (refs.length) return refs;
  // No usable page tree: fall back to anything that reads like a content stream.
  return [...objects.keys()];
}

/* ---------------------------------------------------------------- entry --- */

/** Enough printable prose to be believable as a resume, rather than mojibake. */
function looksLikeProse(s) {
  const text = String(s || '');
  if (text.trim().length < 40) return false;
  const printable = (text.match(/[\x20-\x7E\n\r\t -ɏ‐-‟₹]/g) || []).length;
  if (printable / text.length < 0.85) return false;
  const words = text.trim().split(/\s+/).filter((w) => /[A-Za-z]{2,}/.test(w));
  return words.length >= 15;
}

/**
 * Returns {text, quality}. `quality` is 'good' when the result reads like
 * prose, 'poor' when something came out but it is not trustworthy, and 'none'
 * when the file holds no extractable text at all — a scan, usually.
 */
function extractPdfText(buffer) {
  const latin1 = buffer.toString('latin1');

  if (!latin1.startsWith('%PDF-') && !latin1.slice(0, 1024).includes('%PDF-')) {
    return { text: '', quality: 'none', reason: 'not-a-pdf' };
  }
  if (/\/Encrypt\s+\d+\s+\d+\s+R/.test(latin1)) {
    return { text: '', quality: 'none', reason: 'encrypted' };
  }

  const objects = expandObjectStreams(parseObjects(latin1));
  const fonts = buildFontMap(objects);

  let out = '';
  for (const num of contentStreamNumbers(objects)) {
    const content = streamText(objects.get(num));
    if (!content || !content.includes('BT')) continue;
    if (!/\bTJ\b|\bTj\b|'|"/.test(content)) continue;
    const piece = textFromStream(content, fonts);
    if (piece.trim()) out += `${piece}\n`;
  }

  const text = out
    .replace(/\r\n?/g, '\n')
    .replace(/ /g, '')
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!text) return { text: '', quality: 'none', reason: 'no-text' };
  return { text, quality: looksLikeProse(text) ? 'good' : 'poor' };
}

module.exports = { extractPdfText, looksLikeProse, parseCMap, tokenise };
