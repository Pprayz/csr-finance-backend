const nodemailer = require('nodemailer');

// Le transporteur n'est créé que si les identifiants SMTP sont fournis dans .env
// Sans ça, les e-mails sont simplement journalisés en console (utile en développement,
// et tant que le groupe n'a pas encore choisi/configuré son service d'envoi).
let transporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

// Envoi générique — journalise en console si le SMTP n'est pas configuré.
async function sendEmail({ toEmails, subject, text }) {
  if (!toEmails || toEmails.length === 0) return { sent: false, reason: 'Aucun destinataire' };

  if (!transporter) {
    console.log('[e-mail simulé — SMTP non configuré]', { to: toEmails, subject, text });
    return { sent: false, simulated: true, to: toEmails, subject };
  }

  await transporter.sendMail({
    from: process.env.EMAIL_FROM || process.env.SMTP_USER,
    to: toEmails.join(','),
    subject,
    text,
  });
  return { sent: true, to: toEmails, subject };
}

function buildLeaveNotificationEmail({ employeeName, entityName, type, start, end, comment }) {
  const subject = `Nouvelle demande de congé — ${employeeName}`;
  const text = [
    `${employeeName} (${entityName}) a soumis une nouvelle demande de congé.`,
    `Type : ${type}`,
    `Du : ${start}`,
    `Au : ${end}`,
    comment ? `Commentaire : ${comment}` : null,
    '',
    'Connectez-vous à CSR Finance pour l\'approuver ou la refuser.',
  ].filter(Boolean).join('\n');
  return { subject, text };
}

async function sendLeaveNotification({ toEmails, employeeName, entityName, type, start, end, comment }) {
  const { subject, text } = buildLeaveNotificationEmail({ employeeName, entityName, type, start, end, comment });
  return sendEmail({ toEmails, subject, text });
}

function buildPayslipNotificationEmail({ employeeName, period, net }) {
  const subject = `Fiche de paie disponible — ${period}`;
  const text = [
    `Bonjour ${employeeName},`,
    '',
    `Votre fiche de paie pour la période ${period} est disponible.`,
    `Net à payer : ${Number(net).toFixed(2)} €.`,
    '',
    'Connectez-vous à CSR Finance pour la consulter et la télécharger.',
  ].join('\n');
  return { subject, text };
}

async function sendPayslipNotification({ toEmails, employeeName, period, net }) {
  const { subject, text } = buildPayslipNotificationEmail({ employeeName, period, net });
  return sendEmail({ toEmails, subject, text });
}

module.exports = { sendEmail, sendLeaveNotification, buildLeaveNotificationEmail, sendPayslipNotification, buildPayslipNotificationEmail };
