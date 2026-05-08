const Anthropic = require('@anthropic-ai/sdk');
const { sendDdtEmail } = require('./send-email');
const { MASTER_PROMPT } = require('./master-prompt');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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

  const { orderId, email, pdfTexts, tier } = body || {};

  if (!email) {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'email required' }) };
  }
  if (!Array.isArray(pdfTexts) || pdfTexts.length === 0) {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'pdfTexts must be a non-empty array' }) };
  }
  if (tier && tier !== 'express' && tier !== 'premium') {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'tier must be "express" or "premium"' }) };
  }

  const tierFinal = tier || 'express';

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
