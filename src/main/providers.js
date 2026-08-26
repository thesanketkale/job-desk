'use strict';
/**
 * Which AI service the app talks to, and how to shape a request for it.
 *
 * Only two wire formats matter. Anthropic has its own; everybody else worth
 * using — Google, OpenRouter, OpenAI — exposes an OpenAI-compatible
 * `/chat/completions`, so one adapter covers all of them and adding a fourth
 * provider is a table entry rather than a code path.
 *
 * Everything above this file works in one shape: `{text, usage}` with usage
 * counted as `input_tokens` / `output_tokens`. Normalising here is what keeps
 * `budget.js`, the truth guard and the tailoring path provider-agnostic.
 *
 * PRICES GO STALE. They are US dollars per million tokens and want checking
 * against the provider's own pricing page before they are trusted.
 */

const PROVIDERS = {
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    wire: 'openai',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    modelsUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/models',
    secret: 'gemini_api_key',
    keyUrl: 'https://aistudio.google.com/apikey',
    keyHint: 'Free from aistudio.google.com — no card needed.',
    // Google issues more than one valid key shape — a real key tested against
    // this app during development did not start with "AIza", which is the only
    // format most documentation mentions. The live call in ping() is the actual
    // judge; this only catches the empty-box case and an obvious wrong-provider
    // paste, rather than guessing at a format Google itself does not commit to.
    keyLooksWrong: (k) => {
      if (k.length < 15) return 'That looks too short for a Google API key. Get one free at aistudio.google.com/apikey.';
      if (k.startsWith('sk-ant-')) return 'That looks like a Claude key, not a Google one.';
      if (k.startsWith('sk-or-')) return 'That looks like an OpenRouter key, not a Google one.';
      return '';
    },
    defaultModel: 'gemini-3.7-flash',
    // Confirmed live against the real API (2026-08-26): passing
    // reasoning_effort on the OpenAI-compat endpoint stops Gemini burning its
    // token budget on invisible thinking — used only for calls that do not
    // need reasoning quality, like a key check. 'minimal' was the value here
    // and was never re-checked when the default model moved to the 3.x
    // family — Gemini 3.7 Flash rejects it outright ("Thinking level MINIMAL
    // is not supported for this model"), which broke every key check on the
    // new default. 'low' is confirmed live on 3.5 Flash-Lite, 3.6 Flash and
    // 3.7 Flash; the model catalogue lists a value working, it does not mean
    // that value works everywhere, so re-verify this if the model list here
    // ever changes again.
    cheapReasoningField: 'reasoning_effort',
    cheapReasoningValue: 'low',
    freeTier: true,
    freeNote: 'Google\'s free tier covers roughly 1,000 requests a day on Flash models. '
      + 'The figures below are what it would cost only if you turn on billing and go past that.',
    dataNote: 'On the free tier Google may use what is sent to improve its models. '
      + 'On the paid tier it does not. Tailoring sends your whole CV.',
    // Confirmed live against the real API — gemini-2.5-flash and gemini-2.5-pro
    // now 404 with "no longer available to new users", which the models list
    // does not warn about; it still lists them as though they worked.
    // Checked against ai.google.dev/gemini-api/docs/pricing on 2026-08-25. Two
    // traps live in that page. 3.6 and 3.7 Flash are on promotional pricing that
    // doubles on 2027-01-01 — the figures that used to be here were the *future*
    // ones, so those two looked twice as dear as they are. And 3.5 Flash is the
    // dearest of the four despite being the oldest, while this table priced it
    // at Flash-Lite rates and made it the default: a month of tailoring was
    // being billed into the ledger at a fifth of what Google actually charged.
    // Revisit these in December 2026, when the promotion ends.
    models: {
      'gemini-3.7-flash':      { in: 0.75, out: 3.75, label: 'Gemini 3.7 Flash — newest, cheapest, the right default' },
      'gemini-3.6-flash':      { in: 0.75, out: 3.75, label: 'Gemini 3.6 Flash — same price, one generation back' },
      'gemini-3.5-flash-lite': { in: 0.30, out: 2.50, label: 'Gemini 3.5 Flash-Lite — cheapest, weakest at strict JSON' },
      'gemini-3.5-flash':      { in: 1.50, out: 9.00, label: 'Gemini 3.5 Flash — older and dearer, kept for installs already on it' },
    },
  },

  anthropic: {
    id: 'anthropic',
    label: 'Anthropic Claude',
    wire: 'anthropic',
    endpoint: 'https://api.anthropic.com/v1/messages',
    modelsUrl: 'https://api.anthropic.com/v1/models',
    secret: 'anthropic_api_key',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keyHint: 'Prepaid credit from console.anthropic.com. Keys begin with "sk-ant-".',
    keyLooksWrong: (k) => (k.startsWith('sk-ant-')
      ? (k.length < 30 ? 'That key looks truncated. Copy the whole value.' : '')
      : 'Claude API keys begin with "sk-ant-". Check you copied the whole thing '
        + 'from console.anthropic.com.'),
    defaultModel: 'claude-sonnet-5',
    freeTier: false,
    dataNote: 'Anthropic does not train on what is sent through the API.',
    // Sonnet 5's list price is $3/$15. It launched at $2/$10 as an introductory
    // rate that ends 2026-08-31, and the introductory figure was what this table
    // held — which would have under-counted the ledger by a third from September
    // onwards. A price set too high only makes the cap refuse early; one set too
    // low lets the cap be sailed straight through, so round up when unsure.
    models: {
      'claude-opus-5':    { in: 5, out: 25, label: 'Opus 5 — most capable, three times the price for no gain here' },
      'claude-sonnet-5':  { in: 3, out: 15, label: 'Sonnet 5 — the right default' },
      'claude-haiku-4-5': { in: 1, out: 5,  label: 'Haiku 4.5 — a third of the price, good enough most days' },
    },
  },

  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    wire: 'openai',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    modelsUrl: 'https://openrouter.ai/api/v1/models',
    secret: 'openrouter_api_key',
    keyUrl: 'https://openrouter.ai/keys',
    keyHint: 'One key for many models. Keys begin with "sk-or-". Model ids ending ":free" cost nothing.',
    keyLooksWrong: (k) => (k.startsWith('sk-or-') ? ''
      : 'OpenRouter keys begin with "sk-or-". Get one at openrouter.ai/keys.'),
    defaultModel: 'google/gemini-3.7-flash',
    freeTier: true,
    freeNote: 'Model ids ending in ":free" cost nothing, but they are rate limited hard at busy '
      + 'times and are withdrawn without notice — which is why none are named here. Check '
      + 'openrouter.ai/models for the ones live today and type the id in.',
    dataNote: 'Free models on OpenRouter generally allow the provider to train on what is sent. '
      + 'Tailoring sends your whole CV — prefer a paid model id if that matters to you.',
    // Checked against openrouter.ai/api/v1/models on 2026-08-25. The two ':free'
    // ids that used to be here — openai/gpt-oss-120b:free and
    // deepseek/deepseek-chat:free — do not exist on OpenRouter at all any more,
    // so choosing either was a guaranteed 404 that this table then priced at
    // nothing. That is the failure mode to watch for on a catalogue nobody can
    // see go stale: a wrong price costs money, a wrong id costs the feature.
    // OpenRouter's free ids rotate constantly, which is what the live list
    // fetched on key validation is for; none are hard-coded here on purpose.
    models: {
      'google/gemini-3.7-flash':      { in: 0.375, out: 1.875, label: 'Gemini 3.7 Flash — newest, and the cheapest here' },
      'google/gemini-3.5-flash-lite': { in: 0.30, out: 2.50, label: 'Gemini 3.5 Flash-Lite — fastest' },
      'anthropic/claude-sonnet-5':    { in: 2, out: 10, label: 'Claude Sonnet 5 — best at strict JSON, dearest here' },
      'openai/gpt-oss-120b':          { in: 0.037, out: 0.17, label: 'GPT-OSS 120B — open weights, near enough free' },
    },
  },
};

const DEFAULT_PROVIDER = 'gemini';

const get = (id) => PROVIDERS[id] || PROVIDERS[DEFAULT_PROVIDER];
const ids = () => Object.keys(PROVIDERS);

/** Everything the interface needs to draw the picker, minus the functions. */
function describe(id) {
  const p = get(id);
  return {
    id: p.id,
    label: p.label,
    keyUrl: p.keyUrl,
    keyHint: p.keyHint,
    freeTier: !!p.freeTier,
    freeNote: p.freeNote || '',
    dataNote: p.dataNote || '',
    defaultModel: p.defaultModel,
    models: p.models,
  };
}

const catalogue = () => ids().map(describe);

/* ------------------------------------------------------------- the wire --- */

/**
 * Builds one request. The two formats differ in three ways that matter: where
 * the system prompt goes, how the key is presented, and what the reply is
 * called.
 */
function buildRequest(providerId, { model, system, user, maxTokens, key, cheap = false }) {
  const p = get(providerId);

  if (p.wire === 'anthropic') {
    const body = {
      model,
      max_tokens: maxTokens,
      system,                                     // its own top-level field
      messages: [{ role: 'user', content: user }],
    };
    // Claude's current models think before answering unless told not to, and
    // thinking is spent out of max_tokens. The key check asks for one word in a
    // tiny budget, so left alone the whole budget goes on invisible reasoning
    // and the reply comes back with no text in it — which this app reads as a
    // broken key and refuses to save. A working key would look dead. Gemini has
    // the same trap and is handled below; this is the same fix on the other
    // wire. Only the key check turns it off — tailoring wants the reasoning.
    if (cheap) body.thinking = { type: 'disabled' };
    return {
      url: p.endpoint,
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body,
    };
  }

  const body = {
    model,
    max_tokens: maxTokens,
    messages: [                                 // the system prompt is a message
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };
  // Confirmed live on Gemini: reasoning models spend the entire token budget on
  // invisible "thinking" before answering, which starves a small max_tokens call
  // (like a key check) of any room for the actual answer. Turned down only for
  // calls that do not need reasoning quality, and only for a provider this has
  // been proven to accept — an unrecognised field is a 400 on some backends.
  if (cheap && p.cheapReasoningField) body[p.cheapReasoningField] = p.cheapReasoningValue || 'low';

  return { url: p.endpoint, headers: { Authorization: `Bearer ${key}` }, body };
}

/**
 * Normalises a reply, or returns {error} with whatever the provider called its
 * complaint. Token counts come back under different names and are mapped onto
 * the Anthropic ones, which the ledger already speaks.
 */
function parseResponse(providerId, raw) {
  const p = get(providerId);
  // Confirmed live on Gemini: an error on the OpenAI-compat endpoint can come
  // back wrapped in a one-element array — [{"error": {...}}] — rather than as
  // a bare object, on at least a 404 for a retired model.
  const res = Array.isArray(raw) ? raw[0] : raw;

  const error = res?.error?.message || (typeof res?.error === 'string' ? res.error : null);
  if (error) return { error };

  if (p.wire === 'anthropic') {
    const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    // 'max_tokens' means the reply was cut off mid-thought, not finished — the
    // text that came back may look like valid JSON right up to where it stops
    // and still fail to parse. Passed through so the caller can say that,
    // rather than the generic "could not read the reply" it looked like before.
    return { text, usage: res.usage || {}, stopReason: res.stop_reason };
  }

  const choice = (res.choices || [])[0];
  if (!choice) return { error: 'the service replied without an answer in it' };
  const content = choice.message?.content;
  // A few OpenAI-compatible services return the content as an array of parts.
  const text = Array.isArray(content)
    ? content.map((c) => (typeof c === 'string' ? c : c?.text || '')).join('')
    : String(content || '');

  const u = res.usage || {};
  const promptTok = Number(u.prompt_tokens || u.input_tokens || 0);
  const visibleTok = Number(u.completion_tokens || u.output_tokens || 0);
  const totalTok = Number(u.total_tokens || 0);
  // Reasoning models (confirmed on Gemini 3.x) spend "thinking" tokens that are
  // invisible in completion_tokens but billed at the full output rate — on a
  // real request they can be 70-85% of the actual bill. total_tokens includes
  // them; completion_tokens does not. Falling back to completion_tokens only
  // when a provider omits total_tokens keeps this safe either way.
  const outputTok = totalTok > promptTok + visibleTok ? totalTok - promptTok : visibleTok;

  // OpenAI-compatible finish_reason: 'length' is this wire's equivalent of
  // Anthropic's 'max_tokens' — the reply was cut off, not finished.
  return { text, usage: { input_tokens: promptTok, output_tokens: outputTok }, stopReason: choice.finish_reason };
}

/** Pulls the live model list, so a stale table here is never the only source. */
function parseModelList(providerId, res) {
  const rows = res?.data || res?.models || [];
  return rows
    .map((m) => String(m.id || m.name || '').replace(/^models\//, ''))
    .filter(Boolean)
    .sort();
}

module.exports = {
  PROVIDERS, DEFAULT_PROVIDER, get, ids, describe, catalogue,
  buildRequest, parseResponse, parseModelList,
};
