const express = require('express');
const db = require('../db');
const { requireAuth, requireModule, scopeEntity } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireModule('budget'), scopeEntity);

function canEditEntity(req, entityId) {
  return req.user.role === 'directeur' || req.user.entityId === entityId;
}

router.get('/', async (req, res) => {
  const rows = req.entityScope
    ? await db.all('SELECT * FROM budget WHERE entity_id = $1', [req.entityScope])
    : await db.all('SELECT * FROM budget');
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { entityId, month, category, budgetAmount, actualAmount } = req.body;
  const targetEntity = req.user.role === 'directeur' ? entityId : req.user.entityId;
  if (!targetEntity || !month || !category || !budgetAmount) return res.status(400).json({ error: 'Champs manquants' });
  const id = 'b' + Date.now();
  await db.run(
    'INSERT INTO budget (id,entity_id,month,category,budget_amount,actual_amount) VALUES ($1,$2,$3,$4,$5,$6)',
    [id, targetEntity, month, category, budgetAmount, actualAmount || 0]
  );
  res.status(201).json({ id });
});

router.patch('/:id', async (req, res) => {
  const b = await db.get('SELECT * FROM budget WHERE id = $1', [req.params.id]);
  if (!b) return res.status(404).json({ error: 'Ligne budgétaire introuvable' });
  if (!canEditEntity(req, b.entity_id)) return res.status(403).json({ error: 'Accès non autorisé' });
  const { entityId, month, category, budgetAmount, actualAmount } = req.body;
  const newEntity = entityId || b.entity_id;
  if (!canEditEntity(req, newEntity)) return res.status(403).json({ error: 'Accès non autorisé' });
  await db.run(
    'UPDATE budget SET entity_id=$1, month=$2, category=$3, budget_amount=$4, actual_amount=$5 WHERE id=$6',
    [newEntity, month || b.month, category || b.category, budgetAmount !== undefined ? budgetAmount : b.budget_amount, actualAmount !== undefined ? actualAmount : b.actual_amount, req.params.id]
  );
  res.json({ ok: true });
});

router.delete('/:id', async (req, res) => {
  const b = await db.get('SELECT * FROM budget WHERE id = $1', [req.params.id]);
  if (!b) return res.status(404).json({ error: 'Ligne budgétaire introuvable' });
  if (!canEditEntity(req, b.entity_id)) return res.status(403).json({ error: 'Accès non autorisé' });
  await db.run('DELETE FROM budget WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
