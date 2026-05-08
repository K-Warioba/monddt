// Verifies a Stripe Checkout Session is paid before letting the user
// upload PDFs on /upload.html.
//
// Expects ?session_id=cs_... in the query string. Returns:
//   { paid: true, email, tier: 'express'|'premium', maxFiles: 5|10 }
// or { paid: false, reason }.
//
// Tier resolution (in order):
//   1. session.metadata.tier  ('express' or 'premium')
//   2. fall back to 'express'
//
// To wire this end-to-end: when creating a Stripe Payment Link, set
// metadata.tier = 'express' (or 'premium') so we can read it here.

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

function resolveTier(session) {
  const raw = session?.metadata?.tier;
  if (raw === 'express' || raw === 'premium') return raw;
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
