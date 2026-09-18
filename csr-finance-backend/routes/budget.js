const express = require('express');
const db = require('../db');
const { requireAuth, requireModule, scopeEntity } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireModule('budget'), scopeEntity);

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

module.exports = router;
