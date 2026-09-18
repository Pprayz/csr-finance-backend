const express = require('express');
const db = require('../db');
const { requireAuth, requireModule, scopeEntity } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireModule('facturation'), scopeEntity);

function canEditEntity(req, entityId) {
  return req.user.role === 'directeur' || req.user.entityId === entityId;
}

// Garde la trésorerie synchronisée avec le statut de la facture :
// une facture "payée" génère (ou met à jour) le mouvement correspondant ;
// toute autre statut retire ce mouvement s'il existait.
async function syncInvoiceTransaction(invoice) {
  const existingTx = await db.get('SELECT * FROM transactions WHERE invoice_id = $1', [invoice.id]);

  if (invoice.status === 'payée') {
    const signedAmount = invoice.kind === 'client' ? Math.abs(invoice.amount) : -Math.abs(invoice.amount);
    const type = signedAmount >= 0 ? 'credit' : 'debit';
    const label = `Facture ${invoice.kind === 'client' ? 'encaissée' : 'réglée'} — ${invoice.number} (${invoice.counterparty})`;

    if (existingTx) {
      await db.run(
        'UPDATE transactions SET entity_id=$1, label=$2, amount=$3, type=$4 WHERE id=$5',
        [invoice.entity_id, label, signedAmount, type, existingTx.id]
      );
    } else {
      const txId = 'tf' + Date.now();
      const date = new Date().toISOString().slice(0, 10);
      await db.run(
        'INSERT INTO transactions (id,entity_id,date,label,category,amount,type,invoice_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [txId, invoice.entity_id, date, label, 'Facturation', signedAmount, type, invoice.id]
      );
    }
  } else if (existingTx) {
    await db.run('DELETE FROM transactions WHERE id = $1', [existingTx.id]);
  }
}

router.get('/', async (req, res) => {
  const rows = req.entityScope
    ? await db.all('SELECT * FROM invoices WHERE entity_id = $1 ORDER BY due', [req.entityScope])
    : await db.all('SELECT * FROM invoices ORDER BY due');
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { entityId, kind, number, counterparty, amount, due } = req.body;
  const targetEntity = req.user.role === 'directeur' ? entityId : req.user.entityId;
  if (!targetEntity || !kind || !number || !counterparty || !amount || !due) {
    return res.status(400).json({ error: 'Champs manquants' });
  }
  const id = 'i' + Date.now();
  await db.run(
    "INSERT INTO invoices (id,entity_id,kind,number,counterparty,amount,due,status) VALUES ($1,$2,$3,$4,$5,$6,$7,'en attente')",
    [id, targetEntity, kind, number, counterparty, amount, due]
  );
  res.status(201).json({ id });
});

router.patch('/:id', async (req, res) => {
  const inv = await db.get('SELECT * FROM invoices WHERE id = $1', [req.params.id]);
  if (!inv) return res.status(404).json({ error: 'Facture introuvable' });
  if (!canEditEntity(req, inv.entity_id)) return res.status(403).json({ error: 'Accès non autorisé' });
  const { entityId, kind, number, counterparty, amount, due, status } = req.body;
  const newEntity = entityId || inv.entity_id;
  if (!canEditEntity(req, newEntity)) return res.status(403).json({ error: 'Accès non autorisé' });
  await db.run(
    'UPDATE invoices SET entity_id=$1, kind=$2, number=$3, counterparty=$4, amount=$5, due=$6, status=$7 WHERE id=$8',
    [newEntity, kind || inv.kind, number || inv.number, counterparty || inv.counterparty, amount !== undefined ? amount : inv.amount, due || inv.due, status || inv.status, req.params.id]
  );
  const updated = await db.get('SELECT * FROM invoices WHERE id = $1', [req.params.id]);
  await syncInvoiceTransaction(updated);
  res.json({ ok: true });
});

router.patch('/:id/status', async (req, res) => {
  const { status } = req.body;
  if (!['payée', 'en attente', 'en retard'].includes(status)) return res.status(400).json({ error: 'Statut invalide' });
  const inv = await db.get('SELECT * FROM invoices WHERE id = $1', [req.params.id]);
  if (!inv) return res.status(404).json({ error: 'Facture introuvable' });
  if (req.entityScope && inv.entity_id !== req.entityScope) return res.status(403).json({ error: 'Accès non autorisé' });
  await db.run('UPDATE invoices SET status = $1 WHERE id = $2', [status, req.params.id]);
  const updated = await db.get('SELECT * FROM invoices WHERE id = $1', [req.params.id]);
  await syncInvoiceTransaction(updated);
  res.json({ ok: true });
});

router.delete('/:id', async (req, res) => {
  const inv = await db.get('SELECT * FROM invoices WHERE id = $1', [req.params.id]);
  if (!inv) return res.status(404).json({ error: 'Facture introuvable' });
  if (!canEditEntity(req, inv.entity_id)) return res.status(403).json({ error: 'Accès non autorisé' });
  await db.run('DELETE FROM transactions WHERE invoice_id = $1', [req.params.id]);
  await db.run('DELETE FROM invoices WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
