const { Resend } = require('resend');

// Final desired sender once DNS for monddt.fr is configured:
//   monddt <noreply@monddt.fr>
// Until DKIM/SPF are wired, fall back to Resend's verified sandbox sender via env.
const FROM = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';

let _resend;
function getResend() {
  if (!_resend) {
    if (!process.env.RESEND_API_KEY) {
      throw new Error('RESEND_API_KEY is not set');
    }
    _resend = new Resend(process.env.RESEND_API_KEY);
  }
  return _resend;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const RECO_THEME = {
  ACHETER:     { bg: '#d1fae5', fg: '#065f46', border: '#10b981', icon: '✅' },
  NÉGOCIER:    { bg: '#dbeafe', fg: '#1e40af', border: '#3b82f6', icon: '💰' },
  APPROFONDIR: { bg: '#fef3c7', fg: '#92400e', border: '#f59e0b', icon: '⚠️' },
  ÉVITER:      { bg: '#fee2e2', fg: '#991b1b', border: '#ef4444', icon: '🔴' },
};

const FR_MONTHS = ['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'];

function frenchDate(d = new Date()) {
  return `${d.getDate()} ${FR_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function card(title, icon, innerHtml) {
  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;margin:0 0 16px 0;">
  <tr>
    <td style="padding:18px 20px;">
      <h2 style="margin:0 0 12px 0;font-size:16px;font-weight:600;color:#102a43;letter-spacing:-0.01em;">
        <span style="margin-right:6px;">${icon}</span>${escapeHtml(title)}
      </h2>
      ${innerHtml}
    </td>
  </tr>
</table>`;
}

function renderSynthesisHtml(s, orderId) {
  const reco = (s.score_global && s.score_global.recommandation) || 'APPROFONDIR';
  const theme = RECO_THEME[reco] || RECO_THEME.APPROFONDIR;
  const note = (s.score_global && s.score_global.note_sur_10) ?? '?';
  const just = (s.score_global && s.score_global.justification) || '';

  const liStyle = 'margin:6px 0;color:#243b53;line-height:1.55;';
  const muted = 'color:#64748b;font-size:13px;';
  const list = (arr, fn) => (Array.isArray(arr) && arr.length
    ? `<ul style="margin:0;padding-left:20px;">${arr.map(fn).join('')}</ul>`
    : `<p style="margin:0;color:#6b7280;font-style:italic;">Aucun élément.</p>`);

  const heroHtml = `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${theme.bg};border-left:4px solid ${theme.border};border-radius:8px;margin:0 0 20px 0;">
  <tr>
    <td style="padding:20px 24px;">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;font-weight:600;color:${theme.fg};opacity:0.75;">Recommandation</div>
      <div style="font-size:26px;font-weight:700;color:${theme.fg};margin:6px 0;">
        <span style="margin-right:8px;">${theme.icon}</span>${escapeHtml(reco)} — ${escapeHtml(String(note))}/10
      </div>
      <div style="font-size:14px;color:${theme.fg};line-height:1.55;">${escapeHtml(just)}</div>
    </td>
  </tr>
</table>`;

  const resumeCard = card('Résumé exécutif', '📄',
    `<p style="margin:0;line-height:1.6;color:#243b53;">${escapeHtml(s.resume_executif || '')}</p>`);

  const documentsCard = card('Documents', '📁', `
    <p style="margin:0 0 8px 0;color:#243b53;"><strong>Détectés :</strong> ${(s.documents_detectes || []).map(escapeHtml).join(', ') || '—'}</p>
    <p style="margin:0;color:#243b53;"><strong>Manquants :</strong> ${(s.documents_manquants || []).map(escapeHtml).join(', ') || 'Aucun signalé.'}</p>
  `);

  const pointsFortsCard = card('Points forts', '✅', list(s.points_forts, p =>
    `<li style="${liStyle}"><strong>${escapeHtml(p.titre)}</strong> — ${escapeHtml(p.detail)}</li>`));

  const vigilanceCard = card('Points de vigilance graves', '🔴', list(s.points_vigilance_graves, p => `
    <li style="${liStyle}">
      <strong>${escapeHtml(p.titre)}</strong>
      ${p.urgence ? `<span style="background:#fee2e2;color:#991b1b;font-size:11px;padding:2px 6px;border-radius:3px;text-transform:uppercase;margin-left:6px;">${escapeHtml(p.urgence)}</span>` : ''}
      <br><span style="color:#475569;">${escapeHtml(p.detail)}</span>
      <br><em style="${muted}">Conséquence : ${escapeHtml(p.consequence || '')}</em>
    </li>`));

  const clarifierCard = card('Points à clarifier', '⚠️', list(s.points_a_clarifier, p => `
    <li style="${liStyle}">
      <strong>${escapeHtml(p.titre)}</strong> — ${escapeHtml(p.detail)}
      <br><em style="${muted}">À demander : « ${escapeHtml(p.question_a_poser || '')} »</em>
    </li>`));

  const negoCard = card('Arguments de négociation', '💰', list(s.arguments_negociation, a => `
    <li style="${liStyle}">
      <strong>${escapeHtml(a.argument)}</strong>
      <br><span style="${muted}">Fondement : ${escapeHtml(a.fondement || '')}</span>
      <br><span style="color:#065f46;font-weight:600;">Décote justifiable : ${escapeHtml(a.estimation_decote || 'non chiffrable')}</span>
    </li>`));

  const verifsRows = (s.verifications_legales || []).map(v => `
    <tr>
      <td style="padding:8px;border:1px solid #d9e2ec;color:#243b53;">${escapeHtml(v.diagnostic)}</td>
      <td style="padding:8px;border:1px solid #d9e2ec;color:#243b53;">${escapeHtml(v.validite)}</td>
      <td style="padding:8px;border:1px solid #d9e2ec;text-align:center;font-size:18px;">${v.conforme_2025 ? '✅' : '❌'}</td>
      <td style="padding:8px;border:1px solid #d9e2ec;color:#243b53;">${escapeHtml(v.remarque || '')}</td>
    </tr>`).join('') || `<tr><td colspan="4" style="padding:12px;color:#6b7280;border:1px solid #d9e2ec;">Aucune vérification disponible.</td></tr>`;
  const verifsCard = card('Vérifications légales', '📋', `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;font-size:14px;">
      <thead>
        <tr style="background:#f0f4f8;">
          <th style="text-align:left;padding:8px;border:1px solid #d9e2ec;color:#102a43;">Diagnostic</th>
          <th style="text-align:left;padding:8px;border:1px solid #d9e2ec;color:#102a43;">Validité</th>
          <th style="text-align:left;padding:8px;border:1px solid #d9e2ec;color:#102a43;">Conforme</th>
          <th style="text-align:left;padding:8px;border:1px solid #d9e2ec;color:#102a43;">Remarque</th>
        </tr>
      </thead>
      <tbody>${verifsRows}</tbody>
    </table>`);

  const checklistCard = card('Checklist : questions à poser au vendeur', '☑️',
    Array.isArray(s.checklist_questions_vendeur) && s.checklist_questions_vendeur.length
      ? `<ol style="margin:0;padding-left:20px;">${s.checklist_questions_vendeur.map(q => `<li style="${liStyle}">${escapeHtml(q)}</li>`).join('')}</ol>`
      : `<p style="margin:0;color:#6b7280;font-style:italic;">Aucune question.</p>`);

  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f9fafb;padding:24px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif;">
  <tr>
    <td>
      <table role="presentation" width="680" cellpadding="0" cellspacing="0" border="0" align="center" style="max-width:680px;margin:0 auto;background:#f9fafb;">
        <tr>
          <td style="padding:0 24px;">
            <p style="font-size:14px;color:#6b7280;margin:0 0 8px 0;">monddt.fr</p>
            <h1 style="font-size:24px;font-weight:700;color:#102a43;margin:0 0 4px 0;">Votre synthèse de diagnostics</h1>
            ${orderId ? `<p style="font-size:13px;color:#6b7280;margin:0 0 20px 0;">Référence : <strong>${escapeHtml(orderId)}</strong></p>` : '<div style="height:20px;"></div>'}

            ${heroHtml}
            ${resumeCard}
            ${documentsCard}
            ${pointsFortsCard}
            ${vigilanceCard}
            ${clarifierCard}
            ${negoCard}
            ${verifsCard}
            ${checklistCard}

            <p style="font-size:12px;color:#6b7280;line-height:1.55;margin:24px 0 8px 0;padding:16px;background:#f3f4f6;border-radius:6px;">
              ${escapeHtml(s.disclaimer || 'Cette synthèse est une aide à la lecture générée par IA. Elle ne remplace pas l\'avis d\'un diagnostiqueur certifié, d\'un notaire, ou d\'un avocat.')}
            </p>

            <p style="font-size:12px;color:#9ca3af;text-align:center;margin:24px 0 0 0;">
              Généré par <a href="https://monddt.fr" style="color:#9ca3af;text-decoration:underline;">monddt.fr</a> le ${frenchDate()}
            </p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`.trim();
}

async function sendDdtEmail({ to, synthesis, orderId }) {
  if (!to) throw new Error('Recipient email (to) required');
  if (!synthesis || typeof synthesis !== 'object') throw new Error('synthesis JSON required');

  const note = (synthesis.score_global && synthesis.score_global.note_sur_10) ?? '?';
  const subject = `Votre synthèse de diagnostics est prête — note ${note}/10`;
  const html = renderSynthesisHtml(synthesis, orderId);

  const result = await getResend().emails.send({
    from: FROM,
    to,
    subject,
    html,
  });

  if (result.error) {
    throw new Error(`Resend error: ${result.error.message}`);
  }
  return result.data;
}

exports.sendDdtEmail = sendDdtEmail;
exports.renderSynthesisHtml = renderSynthesisHtml;

// NOT a public endpoint. Email is sent only internally by
// process-pdfs-background.js, which calls sendDdtEmail() directly (a JS import,
// never an HTTP round-trip). Exposing this over HTTP made it an open relay:
// anyone could POST { to, synthesis } and send mail from our domain to any
// address, burning Resend quota and our sending reputation. Deny all external
// invocation; the internal export above is unaffected.
exports.handler = async () => {
  return {
    statusCode: 403,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: 'Forbidden' }),
  };
};
