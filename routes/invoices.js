const express = require('express');
const db = require('../db');
const { requireAuth, requireModule, scopeEntity } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireModule('facturation'), scopeEntity);

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

router.patch('/:id/status', async (req, res) => {
  const { status } = req.body;
  if (!['payée', 'en attente', 'en retard'].includes(status)) return res.status(400).json({ error: 'Statut invalide' });
  const inv = await db.get('SELECT * FROM invoices WHERE id = $1', [req.params.id]);
  if (!inv) return res.status(404).json({ error: 'Facture introuvable' });
  if (req.entityScope && inv.entity_id !== req.entityScope) return res.status(403).json({ error: 'Accès non autorisé' });
  await db.run('UPDATE invoices SET status = $1 WHERE id = $2', [status, req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
