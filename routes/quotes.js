const express = require('express');
const db = require('../db');
const { requireAuth, requireModule, scopeEntity } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireModule('facturation'), scopeEntity);

function canEditEntity(req, entityId) {
  return req.user.role === 'directeur' || req.user.entityId === entityId;
}
function computeTotal(items) {
  return (items || []).reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unitPrice) || 0), 0);
}
// Retire l'éventuel préfixe "data:application/pdf;base64," avant stockage
function cleanBase64(data) {
  if (!data) return data;
  const commaIndex = data.indexOf(',');
  return data.startsWith('data:') && commaIndex !== -1 ? data.slice(commaIndex + 1) : data;
}

// La liste n'inclut jamais le PDF (trop lourd) — seulement son nom, pour afficher un indicateur.
router.get('/', async (req, res) => {
  const cols = 'id, entity_id, number, client_name, client_address, date, valid_until, items, total, status, attachment_name, converted_invoice_id';
  const rows = req.entityScope
    ? await db.all(`SELECT ${cols} FROM quotes WHERE entity_id = $1 ORDER BY date DESC`, [req.entityScope])
    : await db.all(`SELECT ${cols} FROM quotes ORDER BY date DESC`);
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { entityId, number, clientName, clientAddress, date, validUntil, items, attachmentName, attachmentData } = req.body;
  const targetEntity = req.user.role === 'directeur' ? entityId : req.user.entityId;
  if (!targetEntity || !number || !clientName || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Champs manquants' });
  }
  const total = computeTotal(items);
  const id = 'q' + Date.now();
  await db.run(
    `INSERT INTO quotes (id,entity_id,number,client_name,client_address,date,valid_until,items,total,status,attachment_name,attachment_data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'brouillon',$10,$11)`,
    [id, targetEntity, number, clientName, clientAddress || null, date, validUntil || null, JSON.stringify(items), total, attachmentName || null, cleanBase64(attachmentData) || null]
  );
  res.status(201).json({ id, total });
});

router.patch('/:id', async (req, res) => {
  const q = await db.get('SELECT * FROM quotes WHERE id = $1', [req.params.id]);
  if (!q) return res.status(404).json({ error: 'Devis introuvable' });
  if (!canEditEntity(req, q.entity_id)) return res.status(403).json({ error: 'Accès non autorisé' });
  const { number, clientName, clientAddress, date, validUntil, items, status, attachmentName, attachmentData } = req.body;
  const newItems = Array.isArray(items) ? items : q.items;
  const total = computeTotal(newItems);
  await db.run(
    `UPDATE quotes SET number=$1, client_name=$2, client_address=$3, date=$4, valid_until=$5, items=$6, total=$7, status=$8,
     attachment_name=$9, attachment_data=$10 WHERE id=$11`,
    [number || q.number, clientName || q.client_name, clientAddress !== undefined ? clientAddress : q.client_address,
      date || q.date, validUntil !== undefined ? validUntil : q.valid_until, JSON.stringify(newItems), total, status || q.status,
      attachmentData ? (attachmentName || q.attachment_name) : q.attachment_name,
      cleanBase64(attachmentData) || q.attachment_data, req.params.id]
  );
  res.json({ ok: true });
});

router.get('/:id/attachment', async (req, res) => {
  const q = await db.get('SELECT * FROM quotes WHERE id = $1', [req.params.id]);
  if (!q) return res.status(404).json({ error: 'Devis introuvable' });
  if (req.entityScope && q.entity_id !== req.entityScope) return res.status(403).json({ error: 'Accès non autorisé' });
  if (!q.attachment_data) return res.status(404).json({ error: 'Aucun PDF pour ce devis' });
  const buffer = Buffer.from(q.attachment_data, 'base64');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${(q.attachment_name || 'devis.pdf').replace(/"/g, '')}"`);
  res.send(buffer);
});

// Transforme un devis en facture : crée la facture (avec le même PDF, adapté) et marque le devis comme converti
router.post('/:id/convert', async (req, res) => {
  const q = await db.get('SELECT * FROM quotes WHERE id = $1', [req.params.id]);
  if (!q) return res.status(404).json({ error: 'Devis introuvable' });
  if (!canEditEntity(req, q.entity_id)) return res.status(403).json({ error: 'Accès non autorisé' });
  if (q.converted_invoice_id) return res.status(400).json({ error: 'Ce devis a déjà été transformé en facture' });

  const { due, attachmentName, attachmentData } = req.body; // le PDF de facture est régénéré côté client avec le bon en-tête
  const invId = 'i' + Date.now();
  const invNumber = 'FA-' + q.number.replace(/^DEV-?/i, '');
  await db.run(
    `INSERT INTO invoices (id,entity_id,kind,number,counterparty,amount,due,status,attachment_name,attachment_data,items)
     VALUES ($1,$2,'client',$3,$4,$5,$6,'en attente',$7,$8,$9)`,
    [invId, q.entity_id, invNumber, q.client_name, q.total, due || q.valid_until || q.date, attachmentName || null, cleanBase64(attachmentData) || null, JSON.stringify(q.items)]
  );
  await db.run("UPDATE quotes SET converted_invoice_id = $1, status = 'accepté' WHERE id = $2", [invId, req.params.id]);
  res.status(201).json({ invoiceId: invId });
});

router.delete('/:id', async (req, res) => {
  const q = await db.get('SELECT * FROM quotes WHERE id = $1', [req.params.id]);
  if (!q) return res.status(404).json({ error: 'Devis introuvable' });
  if (!canEditEntity(req, q.entity_id)) return res.status(403).json({ error: 'Accès non autorisé' });
  await db.run('DELETE FROM quotes WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
