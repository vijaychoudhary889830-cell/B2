// Premium payments through Cashfree Payment Gateway (no SDK: Node's built-in fetch + crypto).
// Flow: checkout page -> POST /premium/order creates a Cashfree order (guild + user stored in order_tags)
//       -> browser opens Cashfree's hosted checkout -> buyer pays -> Cashfree redirects to /premium/return
//       and also calls our webhook. Both paths re-fetch the order from Cashfree and call fulfil(), which
//       grants premium exactly once per order ID.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../database');

const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '..');
const PAYMENTS_PATH = path.join(DATA_DIR, 'payments.json');
const API_VERSION = '2023-08-01';

const cfg = () => {
  const env = String(process.env.CASHFREE_ENV || 'sandbox').toLowerCase();
  return {
    appId: process.env.CASHFREE_APP_ID || '',
    secret: process.env.CASHFREE_SECRET_KEY || '',
    mode: ['production', 'prod', 'live'].includes(env) ? 'production' : 'sandbox',
    priceInr: Number(process.env.PREMIUM_PRICE_INR || 99),
    priceUsd: Number(process.env.PREMIUM_PRICE_USD || 1.99),
    days: Number(process.env.PREMIUM_DAYS || 30),
  };
};
// Four plans. Prices and days live on the SERVER (the browser only sends the plan key), so a buyer can't
// change them. 'month' = your existing plan (PREMIUM_PRICE_INR / PREMIUM_PRICE_USD / PREMIUM_DAYS).
// Change the other prices on Railway:
//   week     PREMIUM_PRICE_INR_7    / PREMIUM_PRICE_USD_7      (7 days)
//   months4  PREMIUM_PRICE_INR_120  / PREMIUM_PRICE_USD_120    (120 days)
//   lifetime PREMIUM_PRICE_INR_LIFE / PREMIUM_PRICE_USD_LIFE   (100 years, i.e. "lifetime")
// Optional: PREMIUM_PRICE_INR_WAS_* / PREMIUM_PRICE_USD_WAS_* show a struck-through "was" price on a card.
const LIFETIME_DAYS = 36500;
const was = (k) => Number(process.env['PREMIUM_PRICE_INR_WAS_' + k] || 0) || null;
const plans = () => {
  const c = cfg();
  return {
    week:     { key: 'week',     label: '7 Days',   days: 7,             priceInr: Number(process.env.PREMIUM_PRICE_INR_7 || 35),         priceUsd: Number(process.env.PREMIUM_PRICE_USD_7 || 0.99),          wasInr: was('7') },
    month:    { key: 'month',    label: '1 Month',  days: c.days,        priceInr: c.priceInr,                                           priceUsd: c.priceUsd,                                              wasInr: was('30') },
    months4:  { key: 'months4',  label: '4 Months', days: 120,           priceInr: Number(process.env.PREMIUM_PRICE_INR_120 || 349),      priceUsd: Number(process.env.PREMIUM_PRICE_USD_120 || 6.99),        wasInr: was('120') },
    lifetime: { key: 'lifetime', label: 'Lifetime', days: LIFETIME_DAYS, priceInr: Number(process.env.PREMIUM_PRICE_INR_LIFE || 999),     priceUsd: Number(process.env.PREMIUM_PRICE_USD_LIFE || 19.99),      wasInr: was('LIFE'), lifetime: true },
  };
};
const planKey = (k) => (Object.prototype.hasOwnProperty.call(plans(), k) ? k : 'month');
const enabled = () => !!(cfg().appId && cfg().secret);
const baseUrl = () => (cfg().mode === 'production' ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg');
const headers = () => ({
  'x-client-id': cfg().appId, 'x-client-secret': cfg().secret,
  'x-api-version': API_VERSION, 'Content-Type': 'application/json',
});

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a || ''), 'utf8'), y = Buffer.from(String(b || ''), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// Processed order IDs, so a webhook + browser redirect (or a retry) can never grant twice.
function readPayments() { try { return JSON.parse(fs.readFileSync(PAYMENTS_PATH, 'utf8')); } catch { return {}; } }
function writePayments(p) { fs.writeFileSync(PAYMENTS_PATH, JSON.stringify(p, null, 2)); }

async function cf(method, urlPath, body) {
  const res = await fetch(baseUrl() + urlPath, { method, headers: headers(), body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.message || `Cashfree error (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Creates an order for one server. Returns what the browser needs to open Cashfree's checkout.
// returnUrl must contain the literal {order_id}; Cashfree fills it in.
async function createOrder({ guildId, userId, name, email, phone, returnUrl, notifyUrl, currency, plan }) {
  const c = plans()[planKey(plan)];   // unknown plan name -> the normal plan
  const cur = currency === 'USD' ? 'USD' : 'INR';
  const amount = cur === 'USD' ? c.priceUsd : c.priceInr;
  const orderId = `spdy_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
  const customer = { customer_id: String(userId), customer_phone: String(phone || '').replace(/\D/g, '') };
  if (email) customer.customer_email = email;
  if (name) customer.customer_name = String(name).slice(0, 100);
  const data = await cf('POST', '/orders', {
    order_id: orderId,
    order_amount: Number(amount.toFixed(2)),
    order_currency: cur,
    customer_details: customer,
    order_meta: { return_url: returnUrl, notify_url: notifyUrl },
    order_note: `Premium (${c.lifetime ? 'lifetime' : c.days + ' days'}) for server ${guildId}`.slice(0, 200),
    order_tags: { guild_id: String(guildId), user_id: String(userId), days: String(c.days) },
  });
  if (!data.payment_session_id) throw new Error('Cashfree did not return a payment session.');
  return { orderId: data.order_id || orderId, paymentSessionId: data.payment_session_id, mode: c.mode };
}

const fetchOrder = (orderId) => cf('GET', `/orders/${encodeURIComponent(orderId)}`);

// Grants premium for a paid payment. Returns { granted, days, guildId, userId, until } or { granted:false }.
function fulfil({ paymentId, guildId, userId, days, amount }) {
  if (!paymentId || !guildId) return { granted: false };
  const all = readPayments();
  if (all[paymentId]) return { granted: false, duplicate: true, guildId: all[paymentId].guildId };
  const d = Math.max(1, Math.min(LIFETIME_DAYS, parseInt(days, 10) || cfg().days));
  const until = db.grantPremium(guildId, d);
  all[paymentId] = { guildId, userId, days: d, amount, at: Date.now() };
  writePayments(all); // written right after granting; a crash between the two is the only (tiny) double-grant window
  return { granted: true, days: d, guildId, userId, until };
}

// Takes an order fetched from Cashfree. Only a PAID order with our guild tag can grant premium.
function settleOrder(order, expectGuildId) {
  if (!order || order.order_status !== 'PAID') return { granted: false, reason: 'unpaid' };
  const t = order.order_tags || {};
  if (!t.guild_id) return { granted: false, reason: 'untagged' };
  if (expectGuildId && String(t.guild_id) !== String(expectGuildId)) return { granted: false, reason: 'wrong-guild' };
  return fulfil({ paymentId: order.order_id, guildId: t.guild_id, userId: t.user_id, days: t.days, amount: order.order_amount });
}

// Webhook signature: base64(HMAC-SHA256(secret, timestamp + rawBody)).
function verifyWebhook(rawBody, signature, timestamp) {
  const secret = cfg().secret;
  if (!secret || !signature || !timestamp) return false;
  const expected = crypto.createHmac('sha256', secret).update(String(timestamp) + rawBody).digest('base64');
  return safeEqual(expected, signature);
}

module.exports = { cfg, plans, planKey, enabled, createOrder, fetchOrder, fulfil, settleOrder, verifyWebhook };
