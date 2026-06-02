const Anthropic = require('@anthropic-ai/sdk');
const Stripe = require('stripe');
const { sendDdtEmail } = require('./send-email');
const { MASTER_PROMPT } = require('./master-prompt');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

let _stripe;
function getStripe() {
  if (!_stripe) {
    if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not set');
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
  }
  return _stripe;
}

const TIER_LIMITS = { express: 5, premium: 10 };
const TIER_BY_AMOUNT = { 1400: 'express', 2400: 'premium' };
// Hard ceiling on total characters sent to the model — defence-in-depth against
// cost abuse even with a valid paid session (generous for ~10 diagnostic PDFs).
const MAX_TOTAL_CHARS = 600000;

function resolveTier(session) {
  const meta = session?.metadata?.tier;
  if (meta === 'express' || meta === 'premium') return meta;
  return TIER_BY_AMOUNT[session?.amount_total] || 'express';
}

// AUTH GATE. Re-verify the Stripe Checkout Session server-side. The cs_ id is a
// bearer token proving a real payment was made. Without this check the endpoint
// is an open, unauthenticated Anthropic-API drain (anyone can run up the bill).
async function verifyPaidSession(sessionId) {
  if (!sessionId || !/^cs_[A-Za-z0-9_]+$/.test(sessionId)) {
    return { ok: false, reason: 'orderId (session Stripe) manquant ou invalide' };
  }
  const session = await getStripe().checkout.sessions.retrieve(sessionId);
  if (session.payment_status !== 'paid') {
    return { ok: false, reason: `paiement non confirmé (payment_status=${session.payment_status})` };
  }
  const tier = resolveTier(session);
  return { ok: true, tier, maxFiles: TIER_LIMITS[tier] };
}

async function generateSynthesis(pdfTexts) {
  const documentsBlock = pdfTexts
    .map(d => `=== FICHIER: ${d.filename} ===\n${d.text}`)
    .join('\n\n');

  const prompt = MASTER_PROMPT.replace('{DOCUMENTS_TEXT}', documentsBlock);

  const message = await anthropic.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 8000,
    messages: [
      { role: 'user', content: prompt },
    ],
  });

  const completion = message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
    .trim();

  // Defensive: strip markdown fences, then slice to the outermost {...} in case
  // the model adds any preamble/postamble despite the prompt's instructions.
  let raw = completion
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();

  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    raw = raw.slice(firstBrace, lastBrace + 1);
  }

  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error('Model returned non-JSON output (first 800 chars):', raw.slice(0, 800));
    throw new Error('Synthèse invalide (JSON non parsable)');
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method Not Allowed' }),
    };
  }

  let body;
  try {
    body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
  } catch (err) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid JSON body' }),
    };
  }

  const { orderId, email, pdfTexts } = body || {};

  if (!email) {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'email required' }) };
  }
  if (!Array.isArray(pdfTexts) || pdfTexts.length === 0) {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'pdfTexts must be a non-empty array' }) };
  }

  // --- AUTH GATE: require a real, paid Stripe session before any paid work ---
  let auth;
  try {
    auth = await verifyPaidSession(orderId);
  } catch (err) {
    console.error('verifyPaidSession error', { orderId, message: err.message });
    return { statusCode: 502, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'payment verification failed' }) };
  }
  if (!auth.ok) {
    return { statusCode: 402, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: auth.reason }) };
  }

  const tierFinal = auth.tier;

  // Enforce the tier's file limit + a hard input-size ceiling, server-side.
  if (pdfTexts.length > auth.maxFiles) {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: `Trop de fichiers pour l'offre ${tierFinal} (max ${auth.maxFiles}).` }) };
  }
  const totalChars = pdfTexts.reduce((n, d) => n + (typeof d?.text === 'string' ? d.text.length : 0), 0);
  if (totalChars > MAX_TOTAL_CHARS) {
    return { statusCode: 413, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'Contenu trop volumineux.' }) };
  }

  try {
    const synthesis = await generateSynthesis(pdfTexts);

    await sendDdtEmail({ to: email, synthesis, orderId: orderId || null });

    // TODO premium: generate downloadable PDF (HTML -> PDF). For now both tiers
    // receive the same HTML email; PDF download will come in a follow-up.

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, orderId: orderId || null, tier: tierFinal, synthesis }),
    };
  } catch (err) {
    console.error('process-pdfs error', { orderId, email, tier: tierFinal, message: err.message, stack: err.stack });
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, orderId: orderId || null, error: err.message }),
    };
  }
};

exports.generateSynthesis = generateSynthesis;
