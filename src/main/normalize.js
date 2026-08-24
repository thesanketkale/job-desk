'use strict';
/** Turns wildly inconsistent feed data into one comparable shape. */
const crypto = require('node:crypto');

const REMOTE_HINTS = ['fully remote','100% remote','work from home','wfh','remote-first','remote first',
  'work anywhere','distributed team','telecommute','remote,','remote |','(remote)','[remote]',
  'remote position','remote role','virtual position','home-based','home based','telehealth','teletherapy'];
const HYBRID_HINTS = ['hybrid','partially remote','days in office','days in the office','flexible working location',
  'part remote','office and home','blended working','days on campus'];
const ONSITE_HINTS = ['on-site','onsite','in-office','in office','on site only','no remote','office-based','office based'];

function workMode(title = '', location = '', description = '', flag = null) {
  const hay = `${title} ~ ${location} ~ ${description.slice(0, 4000)}`.toLowerCase();
  if (HYBRID_HINTS.some((h) => hay.includes(h))) return 'hybrid';
  if (REMOTE_HINTS.some((h) => hay.includes(h))) return 'remote';
  if (flag === true) return 'remote';
  if (ONSITE_HINTS.some((h) => hay.includes(h))) return 'onsite';
  if (/\bremote\b/i.test(`${title} ${location}`)) return 'remote';
  if (flag === false && location) return 'onsite';
  return 'unknown';
}

const COUNTRY_MAP = {
  india: 'India', in: 'India', bharat: 'India',
  'united states': 'United States', usa: 'United States', us: 'United States', 'u.s.': 'United States',
  'united states of america': 'United States',
  'united kingdom': 'United Kingdom', uk: 'United Kingdom', england: 'United Kingdom',
  scotland: 'United Kingdom', wales: 'United Kingdom',
  canada: 'Canada', ca: 'Canada', australia: 'Australia', au: 'Australia',
  singapore: 'Singapore', uae: 'United Arab Emirates', 'united arab emirates': 'United Arab Emirates',
  dubai: 'United Arab Emirates', germany: 'Germany', deutschland: 'Germany',
  netherlands: 'Netherlands', ireland: 'Ireland', 'new zealand': 'New Zealand', philippines: 'Philippines',

  // The list above was written around one job search and left most of the world
  // as "unknown", which loses the country filter on the board as well as the
  // location read off a resume.
  spain: 'Spain', france: 'France', italy: 'Italy', portugal: 'Portugal',
  belgium: 'Belgium', switzerland: 'Switzerland', austria: 'Austria',
  sweden: 'Sweden', norway: 'Norway', denmark: 'Denmark', finland: 'Finland',
  poland: 'Poland', czechia: 'Czechia', 'czech republic': 'Czechia',
  romania: 'Romania', greece: 'Greece', hungary: 'Hungary', ukraine: 'Ukraine',
  turkey: 'Turkey', türkiye: 'Turkey', israel: 'Israel',
  nigeria: 'Nigeria', kenya: 'Kenya', ghana: 'Ghana', egypt: 'Egypt',
  'south africa': 'South Africa', morocco: 'Morocco', tanzania: 'Tanzania',
  brazil: 'Brazil', brasil: 'Brazil', mexico: 'Mexico', argentina: 'Argentina',
  chile: 'Chile', colombia: 'Colombia', peru: 'Peru',
  japan: 'Japan', china: 'China', 'hong kong': 'Hong Kong', taiwan: 'Taiwan',
  'south korea': 'South Korea', korea: 'South Korea', vietnam: 'Vietnam',
  thailand: 'Thailand', malaysia: 'Malaysia', indonesia: 'Indonesia',
  pakistan: 'Pakistan', bangladesh: 'Bangladesh', 'sri lanka': 'Sri Lanka',
  nepal: 'Nepal', 'saudi arabia': 'Saudi Arabia', qatar: 'Qatar', kuwait: 'Kuwait',
  bahrain: 'Bahrain', oman: 'Oman',

  remote: 'Remote', worldwide: 'Remote', anywhere: 'Remote', global: 'Remote',
};

const INDIA_CITIES = ['vadodara','baroda','ahmedabad','surat','rajkot','gandhinagar','mumbai','bombay','pune',
  'nagpur','thane','navi mumbai','bengaluru','bangalore','mysuru','mysore','chennai','madras','coimbatore',
  'hyderabad','secunderabad','delhi','new delhi','noida','gurgaon','gurugram','ghaziabad','faridabad',
  'kolkata','calcutta','jaipur','lucknow','kanpur','indore','bhopal','chandigarh','kochi','cochin',
  'thiruvananthapuram','visakhapatnam','bhubaneswar','guwahati','dehradun','goa','panaji','nashik'];

const US_STATES = new Set(['CA','NY','TX','WA','MA','IL','FL','GA','CO','NC','VA','PA','OH','AZ','OR','MI','NJ','MN','UT','TN']);

function canonCountry(s = '') {
  return COUNTRY_MAP[s.trim().replace(/[. ]/g, '').toLowerCase()] || '';
}

function place(raw = '') {
  const clean = raw.replace(/\s+/g, ' ').trim();
  if (!clean) return { city: '', region: '', country: '' };
  const lower = clean.toLowerCase();
  if (['remote', 'worldwide', 'anywhere', 'global', 'remote - anywhere'].includes(lower)) {
    return { city: '', region: '', country: 'Remote' };
  }
  let parts = clean.split(/[,|/]|\s+–\s+|\s+-\s+/).map((p) => p.trim())
    .filter((p) => p && !/^remote$/i.test(p));
  if (!parts.length) return { city: '', region: '', country: 'Remote' };

  let country = canonCountry(parts[parts.length - 1]);
  if (country) parts.pop();
  else country = guessCountry(parts[0] || '');

  return { city: parts[0] || '', region: parts[1] || '', country };
}

function guessCountry(city = '') {
  const c = city.trim().toLowerCase();
  if (!c) return '';
  if (INDIA_CITIES.some((ic) => c === ic || c.startsWith(`${ic} `))) return 'India';
  const m = city.match(/\b([A-Z]{2})\b/);
  if (m && city.trim().length <= 25 && US_STATES.has(m[1])) return 'United States';
  return '';
}

/* HTML entity decoding. Job feeds are full of these, and a stray &eacute; in a
   candidate's CV or an employer's name looks careless. */
const LATIN1 = 'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml'.split(' ');

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '\u2013', mdash: '\u2014', lsquo: '\u2018', rsquo: '\u2019',
  ldquo: '\u201C', rdquo: '\u201D', hellip: '\u2026', bull: '\u2022',
  dagger: '\u2020', permil: '\u2030', lsaquo: '\u2039', rsaquo: '\u203A',
  euro: '\u20AC', trade: '\u2122', rarr: '\u2192', larr: '\u2190',
  minus: '\u2212', prime: '\u2032', Prime: '\u2033',
};
LATIN1.forEach((name, i) => { if (!(name in ENTITIES)) ENTITIES[name] = String.fromCharCode(160 + i); });

function decodeEntities(s = '') {
  return s.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (full, name) => {
    if (name[0] === '#') {
      const code = (name[1] === 'x' || name[1] === 'X')
        ? parseInt(name.slice(2), 16)
        : parseInt(name.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10FFFF) return full;
      try { return String.fromCodePoint(code); } catch { return full; }
    }
    if (name in ENTITIES) return ENTITIES[name];                 // case-sensitive first
    const lower = name.toLowerCase();
    return lower in ENTITIES ? ENTITIES[lower] : full;
  });
}

function text(html = '') {
  if (!html) return '';
  let s = decodeEntities(html);
  s = s.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\s*\/?>/gi, '\n');
  s = s.replace(/<li[^>]*>/gi, '• ');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/[ \t ]+/g, ' ').replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

const ALLOWED = new Set(['p','br','ul','ol','li','strong','b','em','i','u','h1','h2','h3','h4','h5','h6',
  'a','blockquote','hr','table','thead','tbody','tr','td','th','code','pre','div','span']);

/** Strips everything but a safe subset so a description can be shown inline. */
function safeHtml(html = '') {
  if (!html) return '';
  let s = html.replace(/<(script|style|iframe|object|embed|form|link|meta)[^>]*>[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<(script|style|iframe|object|embed|form|link|meta)[^>]*\/?>/gi, '');
  s = s.replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  s = s.replace(/\s(href|src)\s*=\s*("|')?\s*javascript:[^"'>\s]*("|')?/gi, '');
  s = s.replace(/<\/?([a-zA-Z0-9]+)([^>]*)>/g, (full, tag, attrs) => {
    if (!ALLOWED.has(tag.toLowerCase())) return '';
    if (full.startsWith('</')) return `</${tag.toLowerCase()}>`;
    if (tag.toLowerCase() === 'a') {
      const href = (attrs.match(/href\s*=\s*"([^"]*)"/i) || attrs.match(/href\s*=\s*'([^']*)'/i) || [])[1] || '';
      return /^https?:\/\//i.test(href)
        ? `<a href="${href.replace(/"/g, '&quot;')}" target="_blank" rel="noopener">` : '<a>';
    }
    return `<${tag.toLowerCase()}>`;
  });
  return s.trim();
}

const BAD_EMAIL = /(noreply|no-reply|donotreply|example\.(com|org)|sentry|@w3\.org|\.(png|jpg|gif|svg)$)/i;

function findEmail(body = '') {
  const found = body.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || [];
  for (const addr of found) if (!BAD_EMAIL.test(addr)) return addr;
  return '';
}

function fingerprint(company = '', title = '', externalId = '', url = '') {
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
  let seed;
  if (externalId) seed = `${norm(company)}|${externalId}`;
  else {
    let pathPart = url;
    try { pathPart = new URL(url).pathname; } catch { /* not a URL, use as-is */ }
    seed = `${norm(company)}|${norm(title)}|${norm(pathPart)}`;
  }
  return crypto.createHash('sha1').update(seed).digest('hex');
}

/** Everything is stored as 'YYYY-MM-DD HH:MM:SS' UTC so SQLite can compare it. */
function date(v) {
  if (!v) return null;
  let d;
  if (typeof v === 'number') d = new Date(v > 1e12 ? v : v * 1000);
  else d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

module.exports = { workMode, place, canonCountry, text, safeHtml, findEmail, fingerprint, date, decodeEntities };
