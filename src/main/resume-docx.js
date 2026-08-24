'use strict';
/**
 * Renders the same CV to .docx. Single column, no tables, no text boxes —
 * the layout applicant tracking systems read most reliably.
 */
const fs = require('node:fs');
const {
  Document, Packer, Paragraph, TextRun, AlignmentType, BorderStyle, HeadingLevel, TabStopType,
} = require('docx');

const INK = '16160F';
const BODY = '33332C';
const MUTED = '6B6B61';
const ACCENT = '3F5D4B';
const HAIR = 'D8D8CF';

const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const half = (pt) => Math.round(pt * 2);

const run = (text, o = {}) => new TextRun({
  text: String(text),
  bold: !!o.bold,
  italics: !!o.italic,
  color: o.color || BODY,
  size: half(o.size || 10),
  font: 'Calibri',
  characterSpacing: o.spacing,
  allCaps: !!o.caps,
});

const para = (children, o = {}) => new Paragraph({
  children,
  alignment: o.align || AlignmentType.LEFT,
  keepNext: !!o.keepNext,
  spacing: { before: (o.before || 0) * 20, after: (o.after ?? 3) * 20, line: Math.round((o.line || 1.14) * 240) },
  indent: o.indent,
  tabStops: o.tabStops,
  border: o.borderBottom
    ? { bottom: { style: BorderStyle.SINGLE, size: 4, space: 3, color: o.borderBottom } }
    : undefined,
});

function build(cv) {
  const body = [];
  const RIGHT_TAB = [{ type: TabStopType.RIGHT, position: 9360 }];

  body.push(para([run(String(cv.name).toUpperCase(), { bold: true, size: 18, color: INK, spacing: 24 })], { after: 1 }));
  body.push(para([run(flat(cv.headline), { size: 9.5, color: ACCENT })], { after: 2 }));

  const c = cv.contact || {};
  const bits = [c.phone, c.email, c.linkedin, c.website, c.location].filter(Boolean);
  body.push(para([run(bits.join('   |   '), { size: 8.5, color: MUTED })], { after: 7, borderBottom: ACCENT }));

  const section = (label) => body.push(para(
    [run(label.toUpperCase(), { bold: true, size: 9, color: ACCENT, spacing: 24 })],
    { before: 10, after: 4, keepNext: true, borderBottom: HAIR },
  ));

  const keyValue = (label, value, size) => body.push(para([
    run(`${label}:  `, { bold: true, size, color: INK }),
    run(flat(Array.isArray(value) ? value.join('  |  ') : value), { size, color: BODY }),
  ], { after: 2 }));

  const bullet = (t) => body.push(para(
    [run('•\t', { size: 9.5, color: '9A9A90' }), run(flat(t), { size: 9.5, color: BODY })],
    { after: 3, indent: { left: 288, hanging: 288 }, line: 1.16 },
  ));

  if (cv.summary) {
    section('Professional Summary');
    body.push(para([run(flat(cv.summary), { size: 9.5, color: BODY })], { after: 4, line: 1.22 }));
  }

  if (cv.competencies) {
    section('Core Competencies');
    for (const [k, v] of Object.entries(cv.competencies)) keyValue(k, v, 9.5);
  }

  if (cv.experience?.length) {
    section('Professional Experience');
    for (const job of cv.experience) {
      const head = job.org ? `${job.title}  ·  ${job.org}` : String(job.title || '');
      const dates = [job.start, job.end].filter(Boolean).join(' – ');
      body.push(para([
        run(head, { bold: true, size: 10.5, color: INK }),
        run('\t', { size: 8.5 }),
        run(dates, { size: 8.5, color: MUTED }),
      ], { before: 7, after: 1, keepNext: true, tabStops: RIGHT_TAB }));
      if (job.location) {
        body.push(para([run(flat(job.location), { italic: true, size: 8.5, color: MUTED })],
          { after: 3, keepNext: true }));
      }
      for (const b of job.bullets || []) bullet(b);
    }
  }

  if (cv.impact?.length) { section('Client Impact & Outcomes'); for (const b of cv.impact) bullet(b); }

  if (cv.education?.length) {
    section('Education');
    for (const ed of cv.education) {
      body.push(para([
        run(ed.degree || '', { bold: true, size: 10, color: INK }),
        run('\t', { size: 8.5 }),
        run(ed.years || '', { size: 8.5, color: MUTED }),
      ], { before: 5, after: 1, keepNext: true, tabStops: RIGHT_TAB }));
      body.push(para([run(ed.school || '', { size: 9.5, color: BODY })], { after: 1 }));
      if (ed.detail) body.push(para([run(flat(ed.detail), { italic: true, size: 8.8, color: MUTED })], { after: 3 }));
    }
  }

  if (cv.certifications) {
    section('Certifications & Training');
    for (const [k, v] of Object.entries(cv.certifications)) keyValue(k, v, 9);
  }

  if (cv.differentiators?.length) { section('What Sets Me Apart'); for (const b of cv.differentiators) bullet(b); }

  if (cv.additional) {
    section('Additional Information');
    for (const [k, v] of Object.entries(cv.additional)) keyValue(k, v, 9);
  }

  return new Document({
    creator: cv.name,
    title: `${cv.name} — CV`,
    styles: { default: { document: { run: { font: 'Calibri', size: half(10) } } } },
    sections: [{
      properties: { page: { margin: { top: 900, right: 900, bottom: 900, left: 900 } } },
      children: body,
    }],
  });
}

async function render(cv, outPath) {
  const buf = await Packer.toBuffer(build(cv));
  fs.writeFileSync(outPath, buf);
  return outPath;
}

module.exports = { render };
