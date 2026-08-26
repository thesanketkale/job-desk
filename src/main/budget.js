'use strict';
/**
 * Spend guard. The Claude API bills per token against a prepaid balance, and
 * the whole point of this file is that a mistake costs a rupee, not a month.
 *
 * The cap is enforced before a request is made, not after it is billed.
 */
const db = require('./db');
const settings = require('./settings');

const providers = require('./providers');

const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);

/**
 * Which service is in use. An install that already had a Claude key keeps
 * using it — changing somebody's provider underneath them would silently
 * change what their applications cost.
 */
function providerId() {
  const chosen = settings.get('ai_provider', '');
  if (chosen && providers.PROVIDERS[chosen]) return chosen;
  if (settings.hasSecret('anthropic_api_key')) return 'anthropic';
  return providers.DEFAULT_PROVIDER;
}

const provider = () => providers.get(providerId());

/**
 * The model list to offer for the provider in use, priced where the price is
 * known. The Settings dropdown is drawn from this and used to be drawn from the
 * hard-coded table alone — so it could only ever offer four models, three of
 * which had gone stale, while the app told the person underneath it that the
 * list was refreshed from the service. It is now: anything the provider's own
 * catalogue returned on the last key check is merged in here.
 *
 * A merged-in model carries no price of its own, so it is given the default
 * model's rate rather than nothing — near enough for a sibling model, and it
 * keeps the cap honest instead of letting an unpriced choice spend freely.
 */
function modelsFor(id = providerId()) {
  const p = providers.get(id);
  const live = settings.get(`ai_models_${p.id}`, []);
  if (!Array.isArray(live) || !live.length) return p.models;
  const base = p.models[p.defaultModel] || UNPRICED;
  const out = { ...p.models };
  for (const m of live.filter(answersInText)) {
    // Priced at the default model's rate, not at nothing. A zero here does not
    // just mis-report one line — it makes the model the cheapest thing in the
    // list, so the onboarding screen worked out its "what it costs" figure from
    // it and told people tailoring was free.
    if (!out[m]) out[m] = { in: base.in, out: base.out, label: m };
  }
  return out;
}

const pricing = () => modelsFor();

/**
 * A provider's model list is everything it sells, not everything that can hold
 * a conversation — Google's includes embeddings, image and video generation and
 * text-to-speech, none of which can rewrite a CV. Offering them in the dropdown
 * would let somebody pick one and get a failure that looks like a broken key.
 * Named exclusions rather than an allow-list, so a model released tomorrow is
 * still offered; the cost of a wrong guess here is one line in a dropdown.
 */
const NOT_CHAT = /embedding|embed-|imagen|veo-|whisper|tts|audio|image-gen|aqa|rerank|moderation/i;
const answersInText = (id) => !NOT_CHAT.test(id);

function model() {
  const p = provider();
  // `claude_model` is what installs from before multiple providers called it.
  const m = settings.get('ai_model', '') || settings.get('claude_model', '');
  if (m && p.models[m]) return m;
  // A model typed in by hand is allowed: the catalogue here goes stale, the
  // provider's own list does not. It simply has no price, so it counts as free.
  if (m && settings.get('ai_model_custom', false)) return m;
  return p.defaultModel;
}

const UNPRICED = { in: 0, out: 0, label: 'Typed in by hand — cost not known to the app' };

function priceOf(m = model()) {
  const p = provider();
  return p.models[m] || p.models[p.defaultModel] || UNPRICED;
}

function cost(usage = {}, m = model()) {
  const p = priceOf(m);
  const inTok = Number(usage.input_tokens || 0) + Number(usage.cache_read_input_tokens || 0);
  const outTok = Number(usage.output_tokens || 0);
  return (inTok / 1e6) * p.in + (outTok / 1e6) * p.out;
}

/** A deliberately generous estimate, used to refuse a call before making it. */
function worstCaseCost(m = model()) {
  const p = priceOf(m);
  return (12000 / 1e6) * p.in + (8000 / 1e6) * p.out;
}

const ledger = () => settings.get('spend_by_month', {}) || {};

function spentThisMonth() {
  return Number(ledger()[monthKey()] || 0);
}

function status() {
  const cap = Number(settings.get('budget_usd_monthly', 0));
  const spent = spentThisMonth();
  return {
    month: monthKey(),
    spent: Math.round(spent * 10000) / 10000,
    cap,
    capped: cap > 0,
    remaining: cap > 0 ? Math.max(0, cap - spent) : null,
    percent: cap > 0 ? Math.min(100, Math.round((spent / cap) * 100)) : 0,
    model: model(),
    modelLabel: priceOf().label,
    pricing: pricing(),
    provider: providerId(),
    providerLabel: provider().label,
    freeTier: !!provider().freeTier,
    freeNote: provider().freeNote || '',
    dataNote: provider().dataNote || '',
    perApplication: Math.round(typicalCost() * 10000) / 10000,
    history: ledger(),
  };
}

/** What one tailored application actually costs, on the current model. */
function typicalCost(m = model()) {
  const p = priceOf(m);
  return (8000 / 1e6) * p.in + (4000 / 1e6) * p.out;
}

/** Throws before a request is sent if it could take the month over its cap. */
function checkBeforeCall() {
  const cap = Number(settings.get('budget_usd_monthly', 0));
  if (cap <= 0) return;
  const spent = spentThisMonth();
  if (spent >= cap) {
    throw new Error(
      `This month's spending limit of $${cap.toFixed(2)} is used up (about $${spent.toFixed(2)} so far). `
      + 'Raise it in Settings, or wait until next month — the limit resets on the 1st.',
    );
  }
  if (spent + worstCaseCost() > cap) {
    throw new Error(
      `That would go past this month's $${cap.toFixed(2)} limit — about $${(cap - spent).toFixed(2)} is left, `
      + 'and one application can cost more than that. Raise the limit in Settings to carry on.',
    );
  }
}

/** Records what a call actually cost, after the fact. */
function record(usage, m = model(), kind = 'tailor') {
  const spend = cost(usage, m);
  const book = ledger();
  const key = monthKey();
  book[key] = Number(book[key] || 0) + spend;

  // Keep a rolling year so the Settings chart has something to show.
  const keys = Object.keys(book).sort();
  while (keys.length > 12) delete book[keys.shift()];

  settings.set('spend_by_month', book);
  const allTime = Number(settings.get('spend_usd', 0)) + spend;
  settings.set('spend_usd', Math.round(allTime * 10000) / 10000);
  if (kind === 'tailor') settings.set('tailor_count', Number(settings.get('tailor_count', 0)) + 1);

  const cap = Number(settings.get('budget_usd_monthly', 0));
  const warned = settings.get('budget_warned_month', '');
  let warning = null;
  if (cap > 0 && book[key] >= cap * 0.8 && warned !== key) {
    settings.set('budget_warned_month', key);
    warning = `About $${book[key].toFixed(2)} of this month's $${cap.toFixed(2)} is used.`;
  }

  db.logActivity('spend', `${kind}: $${spend.toFixed(4)} on ${m}`);
  return { spend, monthTotal: book[key], warning };
}

module.exports = { model, priceOf, pricing, modelsFor, cost, typicalCost, provider, providerId,
  status, checkBeforeCall, record, monthKey, spentThisMonth };
