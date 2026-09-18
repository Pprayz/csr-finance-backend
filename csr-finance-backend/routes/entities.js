const express = require('express');
const db = require('../db');
const { requireAuth, scopeEntity } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, scopeEntity);

router.get('/', async (req, res) => {
  const rows = req.entityScope
    ? await db.all('SELECT * FROM entities WHERE id = $1', [req.entityScope])
    : await db.all('SELECT * FROM entities');
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  if (req.entityScope && req.entityScope !== req.params.id) return res.status(403).json({ error: 'Accès non autorisé' });
  const row = await db.get('SELECT * FROM entities WHERE id = $1', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Entité introuvable' });
  res.json(row);
});

module.exports = router;
