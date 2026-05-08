const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';

async function sendDdtEmail({ to, reference, ddtHtml }) {
  const subject = reference
    ? `Votre DDT — ${reference}`
    : 'Votre Dossier de Diagnostic Technique';

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 720px; margin: 0 auto; padding: 24px;">
      <h1 style="color: #1a1a1a;">Votre DDT est prêt</h1>
      <p>Bonjour,</p>
      <p>Voici votre Dossier de Diagnostic Technique compilé${reference ? ` pour <strong>${reference}</strong>` : ''} à partir des PDFs que vous nous avez transmis.</p>
      <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
      ${ddtHtml}
      <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
      <p style="color: #6b7280; font-size: 0.9rem;">Document généré automatiquement par monDDT. Ce DDT est un récapitulatif synthétique — les diagnostics originaux restent les documents légalement opposables.</p>
    </div>
  `;

  const result = await resend.emails.send({
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

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { to, reference, ddtHtml } = JSON.parse(event.body || '{}');
    if (!to || !ddtHtml) {
      return { statusCode: 400, body: JSON.stringify({ error: 'to and ddtHtml required' }) };
    }
    const data = await sendDdtEmail({ to, reference, ddtHtml });
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, id: data?.id }),
    };
  } catch (err) {
    console.error('send-email error:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
