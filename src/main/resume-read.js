'use strict';
/**
 * Turns a resume file into plain text, with no new dependency.
 *
 * A .docx is a ZIP holding XML, and Node already has the inflate half of ZIP in
 * `node:zlib` — so the only missing piece is about forty lines of archive
 * bookkeeping, which is a far smaller cost than a parser dependency. Plain text
 * and Markdown need nothing at all, and the app's own JSON format is read
 * straight through so an exported CV can be re-imported.
 *
 * PDF is deliberately not supported: extracting text from one genuinely needs a
 * real parser, and the honest answer is to say so and offer the alternatives
 * rather than half-read it and quietly lose half the resume.
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { decodeEntities } = require('./normalize');

const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.text']);

/* ------------------------------------------------------------------ zip --- */

/** Finds the end-of-central-directory record, which may sit behind a comment. */
function findEocd(buf) {
  const min = Math.max(0, buf.length - 66_000);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

/**
 * Reads one named file out of a ZIP. Only the two compression methods that
 * actually occur in a .docx are handled — stored and deflate.
 */
function readFromZip(buf, wanted) {
  const eocd = findEocd(buf);
  if (eocd === -1) throw new Error('not a zip');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    if (name === wanted) {
      if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('damaged zip entry');
      const lNameLen = buf.readUInt16LE(localOffset + 26);
      const lExtraLen = buf.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(start, start + compressedSize);
      if (method === 0) return raw;
      if (method === 8) return zlib.inflateRawSync(raw);
      throw new Error(`unsupported compression (${method})`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/* ----------------------------------------------------------------- docx --- */

/** WordprocessingML carries the layout in the markup, so unwrap it, not strip it. */
function docxXmlToText(xml) {
  let s = String(xml);

  // Field instructions and tracked deletions are not part of what she wrote.
  s = s.replace(/<w:instrText[\s\S]*?<\/w:instrText>/g, '');
  s = s.replace(/<w:delText[\s\S]*?<\/w:delText>/g, '');

  s = s.replace(/<w:tab\b[^>]*\/?>/g, '\t');
  s = s.replace(/<w:br\b[^>]*\/?>/g, '\n');
  s = s.replace(/<\/w:p>/g, '\n');          // one paragraph, one line
  s = s.replace(/<\/w:tr>/g, '\n');         // one table row, one line
  s = s.replace(/<\/w:tc>/g, '\t');         // cells stay on the row
  s = s.replace(/<[^>]+>/g, '');            // whatever markup is left

  return decodeEntities(s);
}

function readDocx(buf) {
  let xml;
  try { xml = readFromZip(buf, 'word/document.xml'); }
  catch (err) {
    throw new Error('That Word file could not be opened — it may be damaged. '
      + `Try re-saving it from Word, or paste the text instead. (${err.message})`);
  }
  if (!xml) {
    throw new Error('That file is a Word document but has no readable text in it. '
      + 'Try re-saving it from Word, or paste the text instead.');
  }
  return docxXmlToText(xml.toString('utf8'));
}

/* ---------------------------------------------------------------- tidy up -- */

/** Collapses the ragged whitespace every converter leaves behind. */
function tidy(text) {
  return String(text || '')
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/ /g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ----------------------------------------------------------------- entry --- */

const SUPPORTED = 'Word (.docx), plain text (.txt) or Markdown (.md)';

/**
 * Reads a resume file into plain text.
 * Returns {text, kind, file}. A .json in the app's own CV format comes back as
 * {cv} instead, because it needs no parsing at all.
 */
function readResumeFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error('That file could not be found. Choose it again.');
  }
  const ext = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath);

  if (ext === '.pdf') {
    throw new Error('PDF resumes cannot be read directly. Open it, use File → Save as '
      + `and choose Word (.docx), or copy the text and paste it in. Job Desk reads ${SUPPORTED}.`);
  }
  if (ext === '.doc') {
    throw new Error('That is the older Word format. Open it in Word and use File → Save as '
      + 'to save a .docx, or paste the text in instead.');
  }

  const stat = fs.statSync(filePath);
  if (stat.size > 8 * 1024 * 1024) {
    throw new Error('That file is unusually large for a resume. Check it is the right one.');
  }

  if (ext === '.json') {
    let cv;
    try { cv = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
    catch (err) { throw new Error(`That .json file is not valid JSON. (${err.message})`); }
    if (!cv || typeof cv !== 'object' || !cv.name) {
      throw new Error('That .json file is not a Job Desk CV — it has no name in it.');
    }
    return { cv, kind: 'json', file: base };
  }

  if (ext === '.docx') {
    const text = tidy(readDocx(fs.readFileSync(filePath)));
    if (text.length < 40) {
      throw new Error('Almost no text came out of that Word file. If it is mostly images or '
        + 'text boxes, paste the text in instead.');
    }
    return { text, kind: 'docx', file: base };
  }

  if (TEXT_EXT.has(ext) || ext === '') {
    const text = tidy(fs.readFileSync(filePath, 'utf8'));
    if (text.length < 40) throw new Error('That file has almost no text in it.');
    return { text, kind: 'text', file: base };
  }

  throw new Error(`Job Desk cannot read ${ext} files. It reads ${SUPPORTED}.`);
}

module.exports = { readResumeFile, docxXmlToText, readFromZip, tidy, SUPPORTED };
