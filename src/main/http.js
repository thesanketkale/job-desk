'use strict';
const UA = 'JobDesk/1.0 (personal job search assistant)';

async function request(url, { method = 'GET', headers = {}, body = null, timeout = 25000, retries = 2 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers: { 'User-Agent': UA, ...headers },
        body,
        redirect: 'follow',
        signal: AbortSignal.timeout(timeout),
      });
      if (res.ok) return { ok: true, status: res.status, text: await res.text() };
      const transient = res.status === 429 || res.status >= 500;
      lastError = `HTTP ${res.status}`;
      if (!transient) return { ok: false, status: res.status, error: lastError };
    } catch (err) {
      lastError = err.name === 'TimeoutError' ? 'timed out' : err.message;
    }
    if (attempt < retries) await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
  }
  return { ok: false, status: 0, error: lastError };
}

async function getJson(url, headers = {}, timeout = 25000) {
  const r = await request(url, { headers: { Accept: 'application/json', ...headers }, timeout });
  if (!r.ok) throw new Error(`${url.split('?')[0]} — ${r.error}`);
  try { return JSON.parse(r.text); }
  catch { throw new Error('the server replied with something that is not JSON'); }
}

async function postJson(url, payload, headers = {}, timeout = 180000) {
  const r = await request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: JSON.stringify(payload),
    timeout,
    retries: 1,
  });
  if (!r.ok && !r.text) throw new Error(r.error || 'request failed');
  try { return JSON.parse(r.text); }
  catch { throw new Error('unexpected reply from the API'); }
}

module.exports = { request, getJson, postJson };
