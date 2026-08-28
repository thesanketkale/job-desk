'use strict';
const UA = 'JobDesk/1.0 (personal job search assistant)';

async function request(url, { method = 'GET', headers = {}, body = null, timeout = 25000, retries = 2 } = {}) {
  let lastError = null;
  let lastText = '';
  let lastStatus = 0;
  let lastRetryAfter = '';
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
      const retryAfter = res.headers.get('retry-after') || '';
      lastRetryAfter = retryAfter;
      if (res.ok) return { ok: true, status: res.status, text, retryAfter };
      lastError = `HTTP ${res.status}`;
      lastText = text;
      lastStatus = res.status;
      const transient = res.status === 429 || res.status >= 500;
      if (!transient) return { ok: false, status: res.status, error: lastError, text, retryAfter };
    } catch (err) {
      lastError = err.name === 'TimeoutError' ? 'timed out' : err.message;
    }
    if (attempt < retries) await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
  }
  return { ok: false, status: lastStatus, error: lastError, text: lastText, retryAfter: lastRetryAfter };
}

/** Turns a bare status code into something worth reading; a network failure
 *  (no status at all — a timeout, DNS, offline) already has a plain-English
 *  message from request(), so it passes through untouched. */
function describeHttpError(status, fallback) {
  if (!status) return fallback || 'the request failed';
  if (status === 404) return 'nothing was found there';
  if (status === 401 || status === 403) return 'the request was refused — check the key or the name';
  if (status === 429) return 'too many requests right now — try again shortly';
  if (status >= 500) return 'that service is having trouble right now';
  return fallback || 'the request failed';
}

async function getJson(url, headers = {}, timeout = 25000) {
  const r = await request(url, { headers: { Accept: 'application/json', ...headers }, timeout });
  if (!r.ok) {
    const err = new Error(describeHttpError(r.status, r.error));
    err.status = r.status;
    throw err;
  }
  try { return JSON.parse(r.text); }
  catch { throw new Error('the server replied with something that is not JSON'); }
}

async function postJsonResult(url, payload, headers = {}, timeout = 180000, retries = 1) {
  const r = await request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: JSON.stringify(payload),
    timeout,
    retries,
  });
  // A body is returned even on a non-2xx status — providers put the real
  // reason ("You exceeded your current quota") in a JSON error object on the
  // failing response, and the caller (providers.js#parseResponse) is what
  // knows how to read a given provider's error shape. This only throws
  // directly when there is truly nothing to read: a network failure rather
  // than an answer from the service.
  if (!r.text) {
    const err = new Error(r.error || 'request failed');
    err.status = r.status || 0;
    throw err;
  }
  try {
    return {
      data: JSON.parse(r.text),
      ok: r.ok,
      status: r.status,
      retryAfter: r.retryAfter || '',
    };
  }
  catch {
    const err = new Error(r.ok ? 'unexpected reply from the API' : (r.error || 'request failed'));
    err.status = r.status || 0;
    throw err;
  }
}

async function postJson(url, payload, headers = {}, timeout = 180000, retries = 1) {
  return (await postJsonResult(url, payload, headers, timeout, retries)).data;
}

module.exports = { request, getJson, postJson, postJsonResult, describeHttpError };
