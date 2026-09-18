const express = require('express');
const db = require('../db');
const { requireAuth, requireModule, scopeEntity } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireModule('tresorerie'), scopeEntity);

router.get('/', async (req, res) => {
  const rows = req.entityScope
    ? await db.all('SELECT * FROM transactions WHERE entity_id = $1 ORDER BY date DESC', [req.entityScope])
    : await db.all('SELECT * FROM transactions ORDER BY date DESC');
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { entityId, date, label, category, amount } = req.body;
  const targetEntity = req.user.role === 'directeur' ? entityId : req.user.entityId;
  if (!targetEntity || !date || !label || amount === undefined) {
    return res.status(400).json({ error: 'Champs manquants' });
  }
  const id = 't' + Date.now();
  const type = amount >= 0 ? 'credit' : 'debit';
  await db.run(
    'INSERT INTO transactions (id,entity_id,date,label,category,amount,type,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, targetEntity, date, label, category || 'Divers', amount, type, req.user.id]
  );
  res.status(201).json({ id });
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
