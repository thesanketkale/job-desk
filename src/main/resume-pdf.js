'use strict';
/**
 * Renders a CV to PDF. Standard Helvetica only — no embedded fonts — because
 * that is what applicant tracking systems parse most reliably, and it keeps
 * the file small enough to attach to any email.
 */
const PDFDocument = require('pdfkit');
const fs = require('node:fs');

const INK = '#16160f';
const BODY = '#33332c';
const MUTED = '#6b6b61';
const HAIR = '#d8d8cf';
const ACCENT = '#3f5d4b';

const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/**
 * Windows-1252 (WinAnsi) — all an unembedded standard font like Helvetica can
 * encode: ASCII, Latin-1 supplement, and a fixed set of typographic
 * characters remapped into the 0x80-0x9F control range. pdfkit does not
 * reject or warn on anything outside that; it silently reinterprets each
 * UTF-16 code unit as a WinAnsi byte instead. Confirmed live: rendering
 * "₹50,000 and नमस्ते" came back, read straight out of the produced PDF, as
 * "¹50,000 and '‰."‰M'IG" — a different, wrong-looking result with no error
 * anywhere, in a document that goes to a real employer as the person's CV.
 */
const WINANSI_EXTRA = new Set([0x20AC, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6,
  0x2030, 0x0160, 0x2039, 0x0152, 0x017D, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014,
  0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x017E, 0x0178]);
const winAnsiSafe = (code) => code <= 0x7F || (code >= 0xA0 && code <= 0xFF) || WINANSI_EXTRA.has(code);

// A handful of substitutions read better than the generic fallback below.
const TRANSLITERATE = { '₹': 'Rs. ' };   // ₹ — common in an Indian salary figure

/**
 * Replaces anything the font cannot encode with a visible placeholder rather
 * than letting it silently become a different, wrong character. Iterates by
 * code point (`for...of` on a string), not UTF-16 unit, so a surrogate pair
 * — an emoji, say — is judged and replaced as one character, not two.
 */
function sanitizeForPdf(s) {
  const str = String(s ?? '');
  let out = '';
  for (const ch of str) {
    if (TRANSLITERATE[ch]) { out += TRANSLITERATE[ch]; continue; }
    out += winAnsiSafe(ch.codePointAt(0)) ? ch : '?';
  }
  return out;
}

function render(cv, outPath) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 48, bottom: 46, left: 46, right: 46 },
      info: { Title: `${cv.name} — CV`, Author: cv.name, Creator: 'Job Desk' },
    });
    // Patched once, here, rather than wrapping every call site in flat() or a
    // sanitizer by hand — several calls below (the name, job titles, schools)
    // pass user data straight through without going via flat() at all, and a
    // per-call-site approach only works until the next one forgets to.
    const rawText = doc.text.bind(doc);
    doc.text = (text, ...rest) => rawText(sanitizeForPdf(text), ...rest);
    const stream = fs.createWriteStream(outPath);
    stream.on('finish', () => resolve(outPath));
    stream.on('error', reject);
    doc.pipe(stream);

    const L = doc.page.margins.left;
    const R = doc.page.width - doc.page.margins.right;
    const W = R - L;

    const rule = (y, color = HAIR, thickness = 0.6) => {
      doc.save().moveTo(L, y).lineTo(R, y).lineWidth(thickness).strokeColor(color).stroke().restore();
    };

    const room = (needed) => {
      if (doc.y + needed > doc.page.height - doc.page.margins.bottom) doc.addPage();
    };

    const section = (label) => {
      room(52);
      doc.moveDown(0.85);
      doc.font('Helvetica-Bold').fontSize(8.4).fillColor(ACCENT)
        .text(label.toUpperCase(), L, doc.y, { characterSpacing: 1.5 });
      doc.moveDown(0.25);
      rule(doc.y);
      doc.moveDown(0.35);
    };

    const bullet = (t) => {
      room(26);
      const y = doc.y;
      doc.font('Helvetica').fontSize(9.1).fillColor('#9a9a90').text('•', L, y, { width: 10 });
      doc.font('Helvetica').fontSize(9.1).fillColor(BODY)
        .text(flat(t), L + 11, y, { width: W - 11, lineGap: 1.1 });
      doc.moveDown(0.22);
    };

    const keyValue = (label, value, size, labelWidth) => {
      room(20);
      const y = doc.y;
      doc.font('Helvetica-Bold').fontSize(size).fillColor(INK)
        .text(`${label}:`, L, y, { width: labelWidth - 8 });
      const afterLabel = doc.y;
      doc.font('Helvetica').fontSize(size).fillColor(BODY)
        .text(flat(value), L + labelWidth, y, { width: W - labelWidth, lineGap: 1 });
      doc.y = Math.max(doc.y, afterLabel);
      doc.moveDown(0.12);
    };

    const columnWidth = (labels, size) => {
      doc.font('Helvetica-Bold').fontSize(size);
      const widest = Math.max(...labels.map((l) => doc.widthOfString(`${l}:`)));
      return Math.min(widest + 10, W * 0.34);
    };

    /* -- header ------------------------------------------------------- */
    doc.font('Helvetica-Bold').fontSize(17).fillColor(INK)
      .text(String(cv.name).toUpperCase(), L, doc.y, { characterSpacing: 1.4 });
    doc.moveDown(0.15);
    doc.font('Helvetica').fontSize(9).fillColor(ACCENT).text(flat(cv.headline), { characterSpacing: 0.3 });
    doc.moveDown(0.2);

    const c = cv.contact || {};
    const bits = [c.phone, c.email, c.linkedin, c.website, c.location].filter(Boolean);
    const contactY = doc.y;
    doc.font("Helvetica").fontSize(7.9).fillColor(MUTED).text(bits.join('   |   '), L, contactY, { width: W });
    if (c.email) {
      const before = doc.widthOfString(`${c.phone || ''}   |   `);
      doc.link(L + before, contactY - 1, doc.widthOfString(c.email), 10, `mailto:${c.email}`);
    }
    doc.moveDown(0.45);
    rule(doc.y, ACCENT, 1.1);
    doc.moveDown(0.1);

    /* -- body --------------------------------------------------------- */
    if (cv.summary) {
      section('Professional Summary');
      doc.font('Helvetica').fontSize(9.2).fillColor(BODY)
        .text(flat(cv.summary), L, doc.y, { width: W, align: 'left', lineGap: 1.4 });
    }

    if (cv.competencies && Object.keys(cv.competencies).length) {
      section('Core Competencies');
      const labels = Object.keys(cv.competencies);
      const lw = columnWidth(labels, 9);
      for (const label of labels) {
        const v = cv.competencies[label];
        keyValue(label, Array.isArray(v) ? v.join('  |  ') : v, 9, lw);
      }
    }

    if (cv.experience?.length) {
      section('Professional Experience');
      for (const job of cv.experience) {
        room(72);
        doc.moveDown(0.45);
        const dates = [job.start, job.end].filter(Boolean).join(' – ');
        const head = job.org ? `${job.title}  ·  ${job.org}` : String(job.title || '');
        const y = doc.y;
        doc.font('Helvetica').fontSize(8.6);
        const dw = doc.widthOfString(dates);
        doc.font('Helvetica-Bold').fontSize(10.2).fillColor(INK)
          .text(head, L, y, { width: W - dw - 14 });
        const afterHead = doc.y;
        doc.font('Helvetica').fontSize(8.6).fillColor(MUTED).text(dates, R - dw, y + 1.5, { width: dw });
        doc.y = Math.max(doc.y, afterHead);
        if (job.location) {
          doc.font('Helvetica-Oblique').fontSize(8.4).fillColor(MUTED)
            .text(flat(job.location), L, doc.y, { width: W });
        }
        doc.moveDown(0.25);
        for (const b of job.bullets || []) bullet(b);
      }
    }

    if (cv.impact?.length) {
      section('Client Impact & Outcomes');
      for (const b of cv.impact) bullet(b);
    }

    if (cv.education?.length) {
      section('Education');
      for (const ed of cv.education) {
        room(46);
        doc.moveDown(0.3);
        const y = doc.y;
        doc.font('Helvetica').fontSize(8.6);
        const yw = doc.widthOfString(ed.years || '');
        doc.font('Helvetica-Bold').fontSize(9.8).fillColor(INK)
          .text(ed.degree || '', L, y, { width: W - yw - 12 });
        const afterDegree = doc.y;
        doc.font('Helvetica').fontSize(8.6).fillColor(MUTED).text(ed.years || '', R - yw, y + 1, { width: yw });
        doc.y = Math.max(doc.y, afterDegree);
        doc.font('Helvetica').fontSize(9).fillColor(BODY).text(ed.school || '', L, doc.y, { width: W });
        if (ed.detail) {
          doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(MUTED)
            .text(flat(ed.detail), L, doc.y, { width: W, lineGap: 0.6 });
        }
      }
    }

    if (cv.certifications && Object.keys(cv.certifications).length) {
      section('Certifications & Training');
      const labels = Object.keys(cv.certifications);
      const lw = columnWidth(labels, 8.8);
      for (const label of labels) {
        const v = cv.certifications[label];
        keyValue(label, Array.isArray(v) ? v.join('  |  ') : v, 8.8, lw);
      }
    }

    if (cv.differentiators?.length) {
      section('What Sets Me Apart');
      for (const b of cv.differentiators) bullet(b);
    }

    if (cv.additional && Object.keys(cv.additional).length) {
      section('Additional Information');
      const labels = Object.keys(cv.additional);
      const lw = columnWidth(labels, 8.8);
      for (const label of labels) keyValue(label, cv.additional[label], 8.8, lw);
    }

    doc.end();
  });
}

module.exports = { render, sanitizeForPdf };
