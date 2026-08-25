#!/usr/bin/env node
/**
 * Dumps one raw response from a job API so an adapter can be written against
 * what the service actually returns rather than what its documentation says.
 *
 *   node scripts/probe-source.mjs jooble  YOUR_KEY
 *   node scripts/probe-source.mjs jsearch YOUR_RAPIDAPI_KEY
 */
const [, , which, key] = process.argv;
if (!which || !key) { console.error('usage: node scripts/probe-source.mjs <jooble|jsearch> <key>'); process.exit(1); }

const show = (label, data) => {
  console.log(`\n--- ${label} ---`);
  const first = Array.isArray(data) ? data[0] : data;
  if (first === undefined) { console.log('(none — check the HTTP status and top-level keys above)'); return; }
  console.log(JSON.stringify(first, null, 2).slice(0, 2500));
};

const run = async () => {
  if (which === 'jooble') {
    const res = await fetch('https://jooble.org/api/' + encodeURIComponent(key), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keywords: 'counselling psychologist', location: 'India', page: '1' }),
    });
    console.log('HTTP', res.status);
    const d = await res.json();
    console.log('top-level keys:', Object.keys(d));
    show('first job', d.jobs);
  }
  if (which === 'jsearch') {
    const url = 'https://jsearch.p.rapidapi.com/search?query='
      + encodeURIComponent('counselling psychologist in India') + '&page=1&num_pages=1&country=in';
    const res = await fetch(url, { headers: { 'X-RapidAPI-Key': key, 'X-RapidAPI-Host': 'jsearch.p.rapidapi.com' } });
    console.log('HTTP', res.status);
    const d = await res.json();
    console.log('top-level keys:', Object.keys(d));
    show('first job', d.data);
  }
};
run().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
