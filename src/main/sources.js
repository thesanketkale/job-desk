'use strict';
/**
 * One adapter per job source. Every adapter returns the same shape.
 * Nothing here scrapes: each endpoint is a published API or a company's own
 * career feed, so it will not break on a redesign or get an IP blocked.
 */
const { getJson, request } = require('./http');

const TYPES = {
  adzuna:     'Adzuna — multi-country, including India',
  remotive:   'Remotive — remote roles',
  remoteok:   'RemoteOK — remote roles',
  himalayas:  'Himalayas — remote roles',
  arbeitnow:  'Arbeitnow — EU/UK feed',
  usajobs:    'USAJOBS — US federal',
  greenhouse: 'Company board — Greenhouse',
  lever:      'Company board — Lever',
  ashby:      'Company board — Ashby',
  workable:   'Company board — Workable',
  rss:        'RSS or Atom feed',
};

const row = (r) => ({
  external_id: '', title: '', company: '', company_site: '', location_raw: '',
  remote_flag: null, employment_type: '', salary_text: '', description_html: '',
  apply_url: '', apply_email: '', posted_at: null, ...r,
});

const pretty = (slug) => slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();

/**
 * Free job APIs are metered per call, and this app multiplies keywords by
 * countries by pages. Left unbounded a single refresh can spend a month's
 * quota. Each adapter takes a slice of the keyword list and the slice moves on
 * every refresh, so over a day every keyword is still used — just not all at
 * once.
 */
function budgetedQueries(queries, max, rotationSeed) {
  if (!Array.isArray(queries) || queries.length <= max) return queries || [];
  const start = (rotationSeed % queries.length + queries.length) % queries.length;
  const out = [];
  for (let i = 0; i < max; i++) out.push(queries[(start + i) % queries.length]);
  return out;
}

/** Distinguishes "no more results" from "the API refused us". */
function isQuotaError(err) {
  return /\b429\b|rate.?limit|quota|too many requests|forbidden|\b403\b/i.test(String(err && err.message));
}

/* ------------------------------------------------------------------ */
/*  Aggregators                                                        */
/* ------------------------------------------------------------------ */

async function adzuna({ config, secrets, queries, rotation }) {
  const { app_id: id, app_key: key } = secrets.adzuna || {};
  if (!id || !key) throw new Error('Adzuna keys are not set — add them in Settings');
  const countries = config.countries || ['in'];
  const pages = Math.max(1, Math.min(5, config.pages || 2));
  const maxQueries = Math.max(1, Math.min(6, config.max_queries || 3));
  const out = [];

  for (const cc of countries) {
    for (const q of budgetedQueries(queries, maxQueries, rotation)) {
      for (let p = 1; p <= pages; p++) {
        const url = `https://api.adzuna.com/v1/api/jobs/${encodeURIComponent(cc)}/search/${p}`
          + `?app_id=${encodeURIComponent(id)}&app_key=${encodeURIComponent(key)}`
          + `&results_per_page=50&what=${encodeURIComponent(q)}&content-type=application/json&sort_by=date`;
        let d;
        try {
          d = await getJson(url);
        } catch (err) {
          if (isQuotaError(err)) throw new Error('Adzuna refused further requests (rate limit). Some roles may be missing from this run.');
          break;
        }
        const results = d.results || [];
        if (!results.length) break;
        for (const j of results) {
          const cur = cc === 'in' ? 'INR' : cc === 'gb' ? 'GBP' : cc === 'us' ? 'USD' : cc.toUpperCase();
          const salary = j.salary_min
            ? `${cur} ${Math.round(j.salary_min).toLocaleString()}–${Math.round(j.salary_max || j.salary_min).toLocaleString()}`
            : '';
          out.push(row({
            external_id: `adzuna:${j.id}`,
            title: j.title || '',
            company: j.company?.display_name || '',
            location_raw: j.location?.display_name || '',
            employment_type: j.contract_time || '',
            salary_text: salary,
            description_html: j.description || '',
            apply_url: j.redirect_url || '',
            posted_at: j.created || null,
          }));
        }
        if (results.length < 50) break;
      }
    }
  }
  return out;
}

async function remotive({ queries, config = {}, rotation }) {
  const out = [];
  const maxQueries = Math.max(1, Math.min(6, config.max_queries || 4));
  for (const q of budgetedQueries(queries, maxQueries, rotation)) {
    let d;
    try {
      d = await getJson(`https://remotive.com/api/remote-jobs?limit=100&search=${encodeURIComponent(q)}`);
    } catch (err) {
      if (isQuotaError(err)) throw new Error('Remotive refused further requests (rate limit). Some roles may be missing from this run.');
      continue;
    }
    for (const j of d.jobs || []) {
      out.push(row({
        external_id: `remotive:${j.id}`,
        title: j.title, company: j.company_name,
        location_raw: j.candidate_required_location || 'Remote',
        remote_flag: true,
        employment_type: j.job_type || '', salary_text: j.salary || '',
        description_html: j.description || '', apply_url: j.url || '',
        posted_at: j.publication_date || null,
      }));
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return out;
}

async function remoteok() {
  const d = await getJson('https://remoteok.com/api');
  return (d || []).filter((j) => j && j.position).map((j) => row({
    external_id: `remoteok:${j.id}`,
    title: j.position, company: j.company,
    location_raw: j.location || 'Remote', remote_flag: true,
    salary_text: j.salary_min ? `${j.salary_min}–${j.salary_max || j.salary_min}` : '',
    description_html: j.description || '',
    apply_url: j.apply_url || j.url || '',
    posted_at: j.date || null,
  }));
}

async function arbeitnow() {
  const out = [];
  for (let p = 1; p <= 3; p++) {
    let d;
    try {
      d = await getJson(`https://www.arbeitnow.com/api/job-board-api?page=${p}`);
    } catch (err) {
      if (isQuotaError(err)) throw new Error('Arbeitnow refused further requests (rate limit). Some roles may be missing from this run.');
      break;
    }
    if (!d.data?.length) break;
    for (const j of d.data) {
      out.push(row({
        external_id: `arbeitnow:${j.slug}`,
        title: j.title, company: j.company_name,
        location_raw: j.location || '', remote_flag: !!j.remote,
        employment_type: (j.job_types || []).join(', '),
        description_html: j.description || '', apply_url: j.url || '',
        posted_at: j.created_at || null,
      }));
    }
  }
  return out;
}

async function himalayas() {
  const out = [];
  for (let off = 0; off < 300; off += 100) {
    let d;
    try {
      d = await getJson(`https://himalayas.app/jobs/api?limit=100&offset=${off}`);
    } catch (err) {
      if (isQuotaError(err)) throw new Error('Himalayas refused further requests (rate limit). Some roles may be missing from this run.');
      break;
    }
    if (!d.jobs?.length) break;
    for (const j of d.jobs) {
      out.push(row({
        external_id: `himalayas:${j.guid || (j.title || '') + (j.companyName || '')}`,
        title: j.title, company: j.companyName, company_site: j.companyWebsite || '',
        location_raw: (j.locationRestrictions || []).join(', ') || 'Remote',
        remote_flag: true, employment_type: j.employmentType || '',
        description_html: j.description || j.excerpt || '',
        apply_url: j.applicationLink || j.url || '',
        posted_at: j.pubDate || null,
      }));
    }
  }
  return out;
}

async function usajobs({ secrets, queries, config = {}, rotation }) {
  const { email, api_key: key } = secrets.usajobs || {};
  if (!email || !key) throw new Error('USAJOBS credentials are not set');
  const out = [];
  const maxQueries = Math.max(1, Math.min(6, config.max_queries || 4));
  for (const q of budgetedQueries(queries, maxQueries, rotation)) {
    let d;
    try {
      d = await getJson(`https://data.usajobs.gov/api/search?ResultsPerPage=50&Keyword=${encodeURIComponent(q)}`,
        { Host: 'data.usajobs.gov', 'User-Agent': email, 'Authorization-Key': key });
    } catch (err) {
      if (isQuotaError(err)) throw new Error('USAJOBS refused further requests (rate limit). Some roles may be missing from this run.');
      continue;
    }
    for (const item of d.SearchResult?.SearchResultItems || []) {
      const j = item.MatchedObjectDescriptor || {};
      out.push(row({
        external_id: `usajobs:${item.MatchedObjectId}`,
        title: j.PositionTitle, company: j.OrganizationName,
        location_raw: j.PositionLocationDisplay || '',
        employment_type: j.PositionSchedule?.[0]?.Name || '',
        description_html: `${j.UserArea?.Details?.JobSummary || ''} ${j.QualificationSummary || ''}`,
        apply_url: j.PositionURI || '', posted_at: j.PublicationStartDate || null,
      }));
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  Company career boards — the highest-signal sources                 */
/* ------------------------------------------------------------------ */

async function greenhouse({ slug }) {
  if (!slug) throw new Error('Greenhouse board name is missing');
  const d = await getJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`);
  const { decodeEntities } = require('./normalize');
  return (d.jobs || []).map((j) => row({
    external_id: `gh:${slug}:${j.id}`,
    title: j.title, company: j.company_name || pretty(slug),
    location_raw: j.location?.name || '',
    description_html: decodeEntities(j.content || ''),
    apply_url: j.absolute_url || '',
    posted_at: j.first_published || j.updated_at || null,
  }));
}

async function lever({ slug }) {
  if (!slug) throw new Error('Lever site name is missing');
  const d = await getJson(`https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`);
  return (d || []).filter(Boolean).map((j) => {
    const extra = (j.lists || []).map((l) => `<h4>${l.text || ''}</h4>${l.content || ''}`).join('');
    return row({
      external_id: `lever:${slug}:${j.id}`,
      title: j.text, company: pretty(slug),
      location_raw: j.categories?.location || '',
      remote_flag: j.workplaceType === 'remote' ? true : null,
      employment_type: j.categories?.commitment || '',
      description_html: `${j.description || ''}${extra}${j.additional || ''}`,
      apply_url: j.applyUrl || j.hostedUrl || '',
      posted_at: j.createdAt || null,
    });
  });
}

async function ashby({ slug }) {
  if (!slug) throw new Error('Ashby board name is missing');
  const d = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`);
  return (d.jobs || []).filter((j) => j.isListed !== false).map((j) => {
    const wt = String(j.workplaceType || '').toLowerCase();
    return row({
      external_id: `ashby:${slug}:${j.id}`,
      title: j.title, company: d.name || pretty(slug),
      location_raw: j.location || '',
      remote_flag: j.isRemote || wt === 'remote' ? true : wt === 'onsite' ? false : null,
      employment_type: j.employmentType || '',
      description_html: j.descriptionHtml || '',
      apply_url: j.applyUrl || j.jobUrl || '',
      posted_at: j.publishedAt || null,
    });
  });
}

async function workable({ slug }) {
  if (!slug) throw new Error('Workable account name is missing');
  const d = await getJson(`https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(slug)}?details=true`);
  return (d.jobs || []).map((j) => row({
    external_id: `workable:${slug}:${j.shortcode}`,
    title: j.title, company: d.name || pretty(slug),
    location_raw: [j.location?.city, j.location?.region, j.location?.country].filter(Boolean).join(', '),
    remote_flag: j.telecommuting ? true : null,
    employment_type: j.type || '',
    description_html: `${j.description || ''}${j.requirements || ''}`,
    apply_url: j.url || j.application_url || '',
    posted_at: j.published_on || null,
  }));
}

async function rss({ slug }) {
  if (!slug) throw new Error('Feed address is missing');
  const r = await request(slug, { headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml' } });
  if (!r.ok) throw new Error(`feed unreachable — ${r.error}`);
  const xml = r.text;
  const blocks = xml.match(/<(item|entry)[\s\S]*?<\/\1>/gi) || [];
  const pick = (b, tag) => {
    const m = b.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
    return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';
  };
  return blocks.map((b) => {
    const link = pick(b, 'link') || (b.match(/<link[^>]*href="([^"]+)"/i) || [])[1] || '';
    return row({
      external_id: `rss:${pick(b, 'guid') || link}`,
      title: pick(b, 'title'),
      company: pick(b, 'author') || pick(b, 'dc:creator'),
      description_html: pick(b, 'description') || pick(b, 'summary') || pick(b, 'content'),
      apply_url: link,
      posted_at: pick(b, 'pubDate') || pick(b, 'updated') || null,
    });
  }).filter((j) => j.title);
}

const ADAPTERS = { adzuna, remotive, remoteok, himalayas, arbeitnow, usajobs, greenhouse, lever, ashby, workable, rss };

/** @returns {{rows: object[], error: string|null}} — never throws. */
async function fetchSource(source, queries, secrets, rotation = 0) {
  const adapter = ADAPTERS[source.type];
  if (!adapter) return { rows: [], error: `Unknown source type: ${source.type}` };
  let config = {};
  try { config = JSON.parse(source.config || '{}'); } catch { /* keep {} */ }
  try {
    const rows = await adapter({ slug: (source.slug || '').trim(), config, secrets, queries, rotation });
    return { rows, error: null };
  } catch (err) {
    return { rows: [], error: String(err.message || err).slice(0, 400) };
  }
}

/** Used by the Test button so a wrong board name is caught before it is saved. */
async function probe(type, slug, secrets) {
  const r = await fetchSource({ type, slug, config: '{}' }, ['counsellor'], secrets || {}, 0);
  return {
    ok: r.error === null,
    count: r.rows.length,
    error: r.error,
    samples: r.rows.slice(0, 5).map((x) => ({ title: x.title, location: x.location_raw })),
  };
}

module.exports = { TYPES, fetchSource, probe, budgetedQueries, isQuotaError };
