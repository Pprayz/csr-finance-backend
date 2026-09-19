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

// Modifier les informations d'une entité (réservé aux directeurs)
router.patch('/:id', async (req, res) => {
  if (req.user.role !== 'directeur') return res.status(403).json({ error: 'Réservé aux directeurs' });
  const entity = await db.get('SELECT * FROM entities WHERE id = $1', [req.params.id]);
  if (!entity) return res.status(404).json({ error: 'Entité introuvable' });

  const { name, sub, iban, address, siret, ape, urssaf, conventionCollective, tauxATMP, balance } = req.body;
  if (balance !== undefined && isNaN(balance)) return res.status(400).json({ error: 'Solde invalide' });
  if (tauxATMP !== undefined && isNaN(tauxATMP)) return res.status(400).json({ error: 'Taux AT/MP invalide' });

  await db.run(
    `UPDATE entities SET
      name = $1, sub = $2, iban = $3, address = $4, siret = $5, ape = $6, urssaf = $7,
      convention_collective = $8, taux_atmp = $9, balance = $10
     WHERE id = $11`,
    [
      name !== undefined ? name : entity.name,
      sub !== undefined ? sub : entity.sub,
      iban !== undefined ? iban : entity.iban,
      address !== undefined ? address : entity.address,
      siret !== undefined ? siret : entity.siret,
      ape !== undefined ? ape : entity.ape,
      urssaf !== undefined ? urssaf : entity.urssaf,
      conventionCollective !== undefined ? conventionCollective : entity.convention_collective,
      tauxATMP !== undefined ? tauxATMP : entity.taux_atmp,
      balance !== undefined ? balance : entity.balance,
      req.params.id,
    ]
  );
  res.json({ ok: true });
});

module.exports = router;
