'use strict';
const UA = 'JobDesk/1.0 (personal job search assistant)';

async function request(url, { method = 'GET', headers = {}, body = null, timeout = 25000, retries = 2 } = {}) {
  let lastError = null;
  let lastText = '';
  let lastStatus = 0;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers: { 'User-Agent': UA, ...headers },
        body,
        redirect: 'follow',
        signal: AbortSignal.timeout(timeout),
      });
      // Read the body whether the call succeeded or not — an API's own error
      // detail ("rate limited", "model retired") lives in a failed response's
      // body exactly like a successful one's does, and was previously thrown
      // away here, leaving every caller with nothing but a bare status code.
      const text = await res.text();
      if (res.ok) return { ok: true, status: res.status, text };
      lastError = `HTTP ${res.status}`;
      lastText = text;
      lastStatus = res.status;
      const transient = res.status === 429 || res.status >= 500;
      if (!transient) return { ok: false, status: res.status, error: lastError, text };
    } catch (err) {
      lastError = err.name === 'TimeoutError' ? 'timed out' : err.message;
    }
    if (attempt < retries) await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
  }
  return { ok: false, status: lastStatus, error: lastError, text: lastText };
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
  // A body is returned even on a non-2xx status — providers put the real
  // reason ("You exceeded your current quota") in a JSON error object on the
  // failing response, and the caller (providers.js#parseResponse) is what
  // knows how to read a given provider's error shape. This only throws
  // directly when there is truly nothing to read: a network failure rather
  // than an answer from the service.
  if (!r.text) throw new Error(r.error || 'request failed');
  try { return JSON.parse(r.text); }
  catch {
    if (!r.ok) throw new Error(r.error || 'request failed');
    throw new Error('unexpected reply from the API');
  }
}

module.exports = { request, getJson, postJson };
