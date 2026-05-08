// Verifies a Stripe Checkout Session is paid before letting the user
// upload PDFs on /upload.html.
//
// Expects ?session_id=cs_... in the query string. Returns:
//   { paid: true, email, tier: 'express'|'premium', maxFiles: 5|10 }
// or { paid: false, reason }.
//
// Tier resolution (priority order):
//   1. session.metadata.tier  ('express' or 'premium') — only set if a
//      Checkout Session is created via the API with explicit metadata.
//      Note: metadata on a Payment Link does NOT flow to the Session.
//   2. session.amount_total   — 1400 (€14.00) => express, 2400 => premium.
//      This is the server-verified source of truth for Payment Link flows
//      and is immune to URL tampering.
//   3. fall back to 'express' (safest default).

const Stripe = require('stripe');

let _stripe;
function getStripe() {
  if (!_stripe) {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error('STRIPE_SECRET_KEY is not set');
    }
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
  }
  return _stripe;
}

const TIER_LIMITS = { express: 5, premium: 10 };

// Amounts in minor units (cents) per Stripe convention.
const TIER_BY_AMOUNT = {
  1400: 'express', // €14.00
  2400: 'premium', // €24.00
};

function resolveTier(session) {
  const meta = session?.metadata?.tier;
  if (meta === 'express' || meta === 'premium') return meta;

  const amountTier = TIER_BY_AMOUNT[session?.amount_total];
  if (amountTier) return amountTier;

  return 'express';
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paid: false, reason: 'Method Not Allowed' }),
    };
  }

  const sessionId = event.queryStringParameters?.session_id;
  if (!sessionId || !/^cs_[A-Za-z0-9_]+$/.test(sessionId)) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paid: false, reason: 'session_id manquant ou invalide' }),
    };
  }

  try {
    const session = await getStripe().checkout.sessions.retrieve(sessionId);

    if (session.payment_status !== 'paid') {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paid: false, reason: `payment_status=${session.payment_status}` }),
      };
    }

    const tier = resolveTier(session);
    const email = session.customer_details?.email || session.customer_email || '';

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paid: true,
        email,
        tier,
        maxFiles: TIER_LIMITS[tier],
        orderId: session.id,
      }),
    };
  } catch (err) {
    console.error('verify-payment error', { sessionId, message: err.message });
    const status = err.statusCode === 404 ? 404 : 500;
    return {
      statusCode: status,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paid: false, reason: err.message }),
    };
  }
};
