const express = require('express');
const db = require('../db');
const { requireAuth, requireModule, scopeEntity } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireModule('tresorerie'), scopeEntity);

function canEditEntity(req, entityId) {
  return req.user.role === 'directeur' || req.user.entityId === entityId;
}

const MAX_ATTACHMENT_BASE64_LENGTH = 7 * 1024 * 1024; // ~5 Mo par fichier une fois décodé
function cleanBase64(data) {
  if (!data) return data;
  const commaIndex = data.indexOf(',');
  return data.startsWith('data:') && commaIndex !== -1 ? data.slice(commaIndex + 1) : data;
}

router.get('/', async (req, res) => {
  const rows = req.entityScope
    ? await db.all('SELECT * FROM transactions WHERE entity_id = $1 ORDER BY date DESC', [req.entityScope])
    : await db.all('SELECT * FROM transactions ORDER BY date DESC');
  res.json(rows);
});

// Liste des pièces jointes d'un mouvement (sans le contenu, pour rester léger)
router.get('/:id/attachments', async (req, res) => {
  const t = await db.get('SELECT * FROM transactions WHERE id = $1', [req.params.id]);
  if (!t) return res.status(404).json({ error: 'Mouvement introuvable' });
  if (req.entityScope && t.entity_id !== req.entityScope) return res.status(403).json({ error: 'Accès non autorisé' });
  const rows = await db.all('SELECT id, file_name, mime_type FROM transaction_attachments WHERE transaction_id = $1 ORDER BY created_at', [req.params.id]);
  res.json(rows);
});

// Ajouter une pièce jointe (appelé une fois par fichier depuis le client)
router.post('/:id/attachments', async (req, res) => {
  const t = await db.get('SELECT * FROM transactions WHERE id = $1', [req.params.id]);
  if (!t) return res.status(404).json({ error: 'Mouvement introuvable' });
  if (!canEditEntity(req, t.entity_id)) return res.status(403).json({ error: 'Accès non autorisé' });
  const { fileName, fileData, mimeType } = req.body;
  const cleaned = cleanBase64(fileData);
  if (!cleaned) return res.status(400).json({ error: 'Fichier manquant' });
  if (cleaned.length > MAX_ATTACHMENT_BASE64_LENGTH) return res.status(400).json({ error: 'Fichier trop volumineux (5 Mo maximum)' });
  const count = await db.get('SELECT COUNT(*)::int AS c FROM transaction_attachments WHERE transaction_id = $1', [req.params.id]);
  if (count.c >= 10) return res.status(400).json({ error: '10 pièces jointes maximum par mouvement' });
  const attId = 'ta' + Date.now() + Math.random().toString(36).slice(2, 6);
  await db.run(
    'INSERT INTO transaction_attachments (id,transaction_id,file_name,file_data,mime_type) VALUES ($1,$2,$3,$4,$5)',
    [attId, req.params.id, fileName || 'justificatif', cleaned, mimeType || 'application/octet-stream']
  );
  res.status(201).json({ id: attId });
});

// Télécharger une pièce jointe précise
router.get('/:id/attachments/:attId', async (req, res) => {
  const t = await db.get('SELECT * FROM transactions WHERE id = $1', [req.params.id]);
  if (!t) return res.status(404).json({ error: 'Mouvement introuvable' });
  if (req.entityScope && t.entity_id !== req.entityScope) return res.status(403).json({ error: 'Accès non autorisé' });
  const att = await db.get('SELECT * FROM transaction_attachments WHERE id = $1 AND transaction_id = $2', [req.params.attId, req.params.id]);
  if (!att) return res.status(404).json({ error: 'Pièce jointe introuvable' });
  const buffer = Buffer.from(att.file_data, 'base64');
  res.setHeader('Content-Type', att.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${(att.file_name || 'justificatif').replace(/"/g, '')}"`);
  res.send(buffer);
});

// Supprimer une pièce jointe précise
router.delete('/:id/attachments/:attId', async (req, res) => {
  const t = await db.get('SELECT * FROM transactions WHERE id = $1', [req.params.id]);
  if (!t) return res.status(404).json({ error: 'Mouvement introuvable' });
  if (!canEditEntity(req, t.entity_id)) return res.status(403).json({ error: 'Accès non autorisé' });
  await db.run('DELETE FROM transaction_attachments WHERE id = $1 AND transaction_id = $2', [req.params.attId, req.params.id]);
  res.json({ ok: true });
});

router.post('/', async (req, res) => {
  const { entityId, date, label, category, amount, cardId } = req.body;
  const targetEntity = req.user.role === 'directeur' ? entityId : req.user.entityId;
  if (!targetEntity || !date || !label || amount === undefined) {
    return res.status(400).json({ error: 'Champs manquants' });
  }
  const id = 't' + Date.now();
  const type = amount >= 0 ? 'credit' : 'debit';
  await db.run(
    'INSERT INTO transactions (id,entity_id,date,label,category,amount,type,created_by,card_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [id, targetEntity, date, label, category || 'Divers', amount, type, req.user.id, cardId || null]
  );
  res.status(201).json({ id });
});

router.patch('/:id', async (req, res) => {
  const t = await db.get('SELECT * FROM transactions WHERE id = $1', [req.params.id]);
  if (!t) return res.status(404).json({ error: 'Mouvement introuvable' });
  if (!canEditEntity(req, t.entity_id)) return res.status(403).json({ error: 'Accès non autorisé' });
  const { entityId, date, label, category, amount, cardId } = req.body;
  const newEntity = entityId || t.entity_id;
  if (!canEditEntity(req, newEntity)) return res.status(403).json({ error: 'Accès non autorisé' });
  const newAmount = amount !== undefined ? amount : t.amount;
  const type = newAmount >= 0 ? 'credit' : 'debit';
  await db.run(
    'UPDATE transactions SET entity_id=$1, date=$2, label=$3, category=$4, amount=$5, type=$6, card_id=$7 WHERE id=$8',
    [newEntity, date || t.date, label || t.label, category || t.category, newAmount, type, cardId!==undefined?(cardId||null):t.card_id, req.params.id]
  );
  res.json({ ok: true });
});

router.delete('/:id', async (req, res) => {
  const t = await db.get('SELECT * FROM transactions WHERE id = $1', [req.params.id]);
  if (!t) return res.status(404).json({ error: 'Mouvement introuvable' });
  if (!canEditEntity(req, t.entity_id)) return res.status(403).json({ error: 'Accès non autorisé' });
  await db.run('DELETE FROM transactions WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// Virement interne entre deux entités du groupe (réservé aux directeurs)
router.post('/transfer', async (req, res) => {
  if (req.user.role !== 'directeur') return res.status(403).json({ error: 'Réservé aux directeurs' });
  const { fromEntity, toEntity, amount, label } = req.body;
  if (!fromEntity || !toEntity || fromEntity === toEntity || !amount || amount <= 0) {
    return res.status(400).json({ error: 'Paramètres de virement invalides' });
  }
  const date = new Date().toISOString().slice(0, 10);
  await db.withTransaction(async (run) => {
    await run(
      'INSERT INTO transactions (id,entity_id,date,label,category,amount,type,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      ['t' + Date.now() + 'a', fromEntity, date, (label || 'Virement interne') + ' → sortant', 'Virement interne', -Math.abs(amount), 'debit', req.user.id]
    );
    await run(
      'INSERT INTO transactions (id,entity_id,date,label,category,amount,type,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      ['t' + Date.now() + 'b', toEntity, date, (label || 'Virement interne') + ' ← entrant', 'Virement interne', Math.abs(amount), 'credit', req.user.id]
    );
  });
  res.status(201).json({ ok: true });
});

module.exports = router;
