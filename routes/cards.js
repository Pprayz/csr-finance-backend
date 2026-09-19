const express = require('express');
const db = require('../db');
const { requireAuth, requireModule, scopeEntity } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireModule('depenses'), scopeEntity);

function canEditEntity(req, entityId) {
  return req.user.role === 'directeur' || req.user.entityId === entityId;
}

router.get('/', async (req, res) => {
  const rows = req.entityScope
    ? await db.all('SELECT * FROM cards WHERE entity_id = $1', [req.entityScope])
    : await db.all('SELECT * FROM cards');
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { entityId, holder, last4, limitAmount } = req.body;
  const targetEntity = req.user.role === 'directeur' ? entityId : req.user.entityId;
  if (!targetEntity || !holder) return res.status(400).json({ error: 'Champs manquants' });
  const id = 'c' + Date.now();
  await db.run(
    "INSERT INTO cards (id,entity_id,holder,last4,status,limit_amount,spent) VALUES ($1,$2,$3,$4,'active',$5,0)",
    [id, targetEntity, holder, last4 || '0000', limitAmount || 1000]
  );
  res.status(201).json({ id });
});

router.patch('/:id', async (req, res) => {
  const card = await db.get('SELECT * FROM cards WHERE id = $1', [req.params.id]);
  if (!card) return res.status(404).json({ error: 'Carte introuvable' });
  if (!canEditEntity(req, card.entity_id)) return res.status(403).json({ error: 'Accès non autorisé' });
  const { entityId, holder, last4, limitAmount } = req.body;
  const newEntity = entityId || card.entity_id;
  if (!canEditEntity(req, newEntity)) return res.status(403).json({ error: 'Accès non autorisé' });
  await db.run(
    'UPDATE cards SET entity_id=$1, holder=$2, last4=$3, limit_amount=$4 WHERE id=$5',
    [newEntity, holder || card.holder, last4 || card.last4, limitAmount !== undefined ? limitAmount : card.limit_amount, req.params.id]
  );
  res.json({ ok: true });
});

router.patch('/:id/toggle', async (req, res) => {
  const card = await db.get('SELECT * FROM cards WHERE id = $1', [req.params.id]);
  if (!card) return res.status(404).json({ error: 'Carte introuvable' });
  if (req.entityScope && card.entity_id !== req.entityScope) return res.status(403).json({ error: 'Accès non autorisé' });
  const newStatus = card.status === 'active' ? 'blocked' : 'active';
  await db.run('UPDATE cards SET status = $1 WHERE id = $2', [newStatus, req.params.id]);
  res.json({ status: newStatus });
});

router.delete('/:id', async (req, res) => {
  const card = await db.get('SELECT * FROM cards WHERE id = $1', [req.params.id]);
  if (!card) return res.status(404).json({ error: 'Carte introuvable' });
  if (!canEditEntity(req, card.entity_id)) return res.status(403).json({ error: 'Accès non autorisé' });
  await db.run('DELETE FROM cards WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
