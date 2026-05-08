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

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const RECO_COLORS = {
  ACHETER:     { bg: '#d1fae5', fg: '#065f46', border: '#10b981' },
  NÉGOCIER:    { bg: '#dbeafe', fg: '#1e40af', border: '#3b82f6' },
  APPROFONDIR: { bg: '#fef3c7', fg: '#92400e', border: '#f59e0b' },
  ÉVITER:      { bg: '#fee2e2', fg: '#991b1b', border: '#ef4444' },
};

function renderEmailHtml(s, reference) {
  const reco = (s.score_global && s.score_global.recommandation) || 'APPROFONDIR';
  const colors = RECO_COLORS[reco] || RECO_COLORS.APPROFONDIR;
  const note = (s.score_global && s.score_global.note_sur_10) ?? '?';
  const just = (s.score_global && s.score_global.justification) || '';

  const list = (arr, fn) => (Array.isArray(arr) && arr.length ? arr.map(fn).join('') : '<li style="color:#6b7280">Aucun élément.</li>');

  const sectionStyle = 'margin:0 0 24px 0;padding:0;';
  const h2Style = 'font-size:18px;font-weight:600;color:#102a43;margin:0 0 12px 0;border-bottom:1px solid #e5e7eb;padding-bottom:6px;';
  const liStyle = 'margin:6px 0;color:#243b53;line-height:1.55;';

  return `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:680px;margin:0 auto;padding:24px;color:#243b53;">
  ${reference ? `<p style="color:#6b7280;font-size:14px;margin:0 0 16px 0;">Référence : <strong>${escapeHtml(reference)}</strong></p>` : ''}

  <div style="background:${colors.bg};color:${colors.fg};border-left:4px solid ${colors.border};padding:16px 20px;border-radius:6px;margin-bottom:24px;">
    <div style="font-size:12px;text-transform:uppercase;letter-spacing:0.05em;font-weight:600;opacity:0.8;">Recommandation</div>
    <div style="font-size:24px;font-weight:700;margin:4px 0;">${escapeHtml(reco)} — ${escapeHtml(String(note))}/10</div>
    <div style="font-size:14px;">${escapeHtml(just)}</div>
  </div>

  <section style="${sectionStyle}">
    <h2 style="${h2Style}">Résumé exécutif</h2>
    <p style="margin:0;line-height:1.6;">${escapeHtml(s.resume_executif || '')}</p>
  </section>

  <section style="${sectionStyle}">
    <h2 style="${h2Style}">Documents</h2>
    <p style="margin:0 0 8px 0;"><strong>Détectés :</strong> ${(s.documents_detectes || []).map(escapeHtml).join(', ') || '—'}</p>
    <p style="margin:0;"><strong>Manquants :</strong> ${(s.documents_manquants || []).map(escapeHtml).join(', ') || 'Aucun signalé.'}</p>
  </section>

  <section style="${sectionStyle}">
    <h2 style="${h2Style}">Points forts</h2>
    <ul style="margin:0;padding-left:20px;">
      ${list(s.points_forts, p => `<li style="${liStyle}"><strong>${escapeHtml(p.titre)}</strong> — ${escapeHtml(p.detail)}</li>`)}
    </ul>
  </section>

  <section style="${sectionStyle}">
    <h2 style="${h2Style}">Points de vigilance graves</h2>
    <ul style="margin:0;padding-left:20px;">
      ${list(s.points_vigilance_graves, p => `<li style="${liStyle}"><strong>${escapeHtml(p.titre)}</strong> ${p.urgence ? `<span style="background:#fee2e2;color:#991b1b;font-size:11px;padding:2px 6px;border-radius:3px;text-transform:uppercase;margin-left:6px;">${escapeHtml(p.urgence)}</span>` : ''}<br><span style="color:#475569">${escapeHtml(p.detail)}</span><br><em style="color:#64748b;font-size:13px;">Conséquence : ${escapeHtml(p.consequence || '')}</em></li>`)}
    </ul>
  </section>

  <section style="${sectionStyle}">
    <h2 style="${h2Style}">Points à clarifier</h2>
    <ul style="margin:0;padding-left:20px;">
      ${list(s.points_a_clarifier, p => `<li style="${liStyle}"><strong>${escapeHtml(p.titre)}</strong> — ${escapeHtml(p.detail)}<br><em style="color:#64748b;font-size:13px;">À demander : « ${escapeHtml(p.question_a_poser || '')} »</em></li>`)}
    </ul>
  </section>

  <section style="${sectionStyle}">
    <h2 style="${h2Style}">Arguments de négociation</h2>
    <ul style="margin:0;padding-left:20px;">
      ${list(s.arguments_negociation, a => `<li style="${liStyle}"><strong>${escapeHtml(a.argument)}</strong><br><span style="color:#475569;font-size:13px;">Fondement : ${escapeHtml(a.fondement || '')}</span><br><span style="color:#065f46;font-weight:600;">Décote justifiable : ${escapeHtml(a.estimation_decote || 'non chiffrable')}</span></li>`)}
    </ul>
  </section>

  <section style="${sectionStyle}">
    <h2 style="${h2Style}">Vérifications légales</h2>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      <thead>
        <tr style="background:#f0f4f8;">
          <th style="text-align:left;padding:8px;border:1px solid #d9e2ec;">Diagnostic</th>
          <th style="text-align:left;padding:8px;border:1px solid #d9e2ec;">Validité</th>
          <th style="text-align:left;padding:8px;border:1px solid #d9e2ec;">Conforme</th>
          <th style="text-align:left;padding:8px;border:1px solid #d9e2ec;">Remarque</th>
        </tr>
      </thead>
      <tbody>
        ${(s.verifications_legales || []).map(v => `<tr><td style="padding:8px;border:1px solid #d9e2ec;">${escapeHtml(v.diagnostic)}</td><td style="padding:8px;border:1px solid #d9e2ec;">${escapeHtml(v.validite)}</td><td style="padding:8px;border:1px solid #d9e2ec;">${v.conforme_2025 ? '✓' : '✗'}</td><td style="padding:8px;border:1px solid #d9e2ec;">${escapeHtml(v.remarque || '')}</td></tr>`).join('') || '<tr><td colspan="4" style="padding:12px;color:#6b7280;border:1px solid #d9e2ec;">Aucune vérification disponible.</td></tr>'}
      </tbody>
    </table>
  </section>

  <section style="${sectionStyle}">
    <h2 style="${h2Style}">Checklist : questions à poser au vendeur</h2>
    <ol style="margin:0;padding-left:20px;">
      ${list(s.checklist_questions_vendeur, q => `<li style="${liStyle}">${escapeHtml(q)}</li>`)}
    </ol>
  </section>

  <p style="font-size:12px;color:#6b7280;margin-top:32px;padding-top:16px;border-top:1px solid #e5e7eb;line-height:1.5;">${escapeHtml(s.disclaimer || '')}</p>
</div>
  `.trim();
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
    const ddtHtml = renderEmailHtml(synthesis, orderId || '');

    await sendDdtEmail({ to: email, reference: orderId || '', ddtHtml });

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
exports.renderEmailHtml = renderEmailHtml;
