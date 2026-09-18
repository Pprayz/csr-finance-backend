const express = require('express');
const db = require('../db');
const { requireAuth, scopeEntity } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, scopeEntity);

// Le solde affiché = solde d'ouverture (colonne "balance") + somme de tous les mouvements de trésorerie.
// Ainsi, créer/modifier/supprimer un mouvement met à jour le solde automatiquement, sans double gestion.
const BALANCE_SELECT = `
  SELECT e.*, (e.balance + COALESCE((SELECT SUM(t.amount) FROM transactions t WHERE t.entity_id = e.id), 0)) AS current_balance
  FROM entities e
`;

router.get('/', async (req, res) => {
  const rows = req.entityScope
    ? await db.all(BALANCE_SELECT + ' WHERE e.id = $1', [req.entityScope])
    : await db.all(BALANCE_SELECT);
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  if (req.entityScope && req.entityScope !== req.params.id) return res.status(403).json({ error: 'Accès non autorisé' });
  const row = await db.get(BALANCE_SELECT + ' WHERE e.id = $1', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Entité introuvable' });
  res.json(row);
});

// Modifier le solde d'ouverture d'une entité (réservé aux directeurs)
router.patch('/:id', async (req, res) => {
  if (req.user.role !== 'directeur') return res.status(403).json({ error: 'Réservé aux directeurs' });
  const { balance } = req.body;
  if (balance === undefined || isNaN(balance)) return res.status(400).json({ error: 'Montant invalide' });
  const entity = await db.get('SELECT * FROM entities WHERE id = $1', [req.params.id]);
  if (!entity) return res.status(404).json({ error: 'Entité introuvable' });
  await db.run('UPDATE entities SET balance = $1 WHERE id = $2', [balance, req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
