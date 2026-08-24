'use strict';
/**
 * Spend guard. The Claude API bills per token against a prepaid balance, and
 * the whole point of this file is that a mistake costs a rupee, not a month.
 *
 * The cap is enforced before a request is made, not after it is billed.
 */
const db = require('./db');
const settings = require('./settings');

/** US dollars per million tokens. Verified against claude.com/pricing. */
const PRICING = {
  'claude-opus-5':   { in: 5, out: 25, label: 'Opus 5 — most capable, most expensive' },
  'claude-sonnet-5': { in: 2, out: 10, label: 'Sonnet 5 — the right default' },
  'claude-haiku-4-5': { in: 1, out: 5, label: 'Haiku 4.5 — half the price, still good' },
};
const DEFAULT_MODEL = 'claude-sonnet-5';

const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);

function model() {
  const m = settings.get('claude_model', DEFAULT_MODEL);
  return PRICING[m] ? m : DEFAULT_MODEL;
}

function priceOf(m = model()) {
  return PRICING[m] || PRICING[DEFAULT_MODEL];
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
    pricing: PRICING,
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

module.exports = { PRICING, DEFAULT_MODEL, model, priceOf, cost, typicalCost,
  status, checkBeforeCall, record, monthKey, spentThisMonth };
