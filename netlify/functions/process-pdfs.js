const Anthropic = require('@anthropic-ai/sdk');
const pdfParse = require('pdf-parse');
const Busboy = require('busboy');
const { sendDdtEmail } = require('./send-email');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function parseMultipart(event) {
  return new Promise((resolve, reject) => {
    const headers = Object.fromEntries(
      Object.entries(event.headers).map(([k, v]) => [k.toLowerCase(), v])
    );
    const bb = Busboy({ headers });
    const fields = {};
    const files = [];

    bb.on('field', (name, value) => { fields[name] = value; });

    bb.on('file', (name, stream, info) => {
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => {
        files.push({
          fieldname: name,
          filename: info.filename,
          mimetype: info.mimeType,
          buffer: Buffer.concat(chunks),
        });
      });
    });

    bb.on('finish', () => resolve({ fields, files }));
    bb.on('error', reject);

    const body = event.isBase64Encoded ? Buffer.from(event.body, 'base64') : Buffer.from(event.body);
    bb.end(body);
  });
}

async function extractPdfText(buffer, filename) {
  const data = await pdfParse(buffer);
  return { filename, text: data.text };
}

async function generateDdt(extractedDocs, reference) {
  const documentsBlock = extractedDocs
    .map(d => `<document name="${d.filename}">\n${d.text}\n</document>`)
    .join('\n\n');

  const message = await anthropic.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 8000,
    messages: [
      {
        role: 'user',
        content: `Tu es un expert en diagnostics immobiliers en France. À partir des diagnostics suivants, génère un Dossier de Diagnostic Technique (DDT) complet et structuré pour le bien suivant : ${reference || '(référence non fournie)'}.

Le DDT doit inclure:
- Synthèse globale (état général, points de vigilance)
- Détail par diagnostic (DPE, amiante, plomb, électricité, gaz, termites, ERP, etc. selon ce qui est fourni)
- Anomalies et recommandations
- Conclusions et obligations légales du propriétaire

Format: HTML structuré, prêt à être envoyé par email.

Documents source:
${documentsBlock}`,
      },
    ],
  });

  return message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n');
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { fields, files } = await parseMultipart(event);
    const email = fields.email;
    const reference = fields.reference || '';

    if (!email) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Email required' }) };
    }
    if (!files.length) {
      return { statusCode: 400, body: JSON.stringify({ error: 'At least one PDF required' }) };
    }

    const extracted = await Promise.all(
      files.map(f => extractPdfText(f.buffer, f.filename))
    );

    const ddtHtml = await generateDdt(extracted, reference);

    await sendDdtEmail({ to: email, reference, ddtHtml });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, files: files.length }),
    };
  } catch (err) {
    console.error('process-pdfs error:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
