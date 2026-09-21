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

function slugify(name) {
  return name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

router.get('/', async (req, res) => {
  if (req.entityScope) {
    const rows = await db.all(BALANCE_SELECT + ' WHERE e.id = $1 AND e.active = 1', [req.entityScope]);
    return res.json(rows);
  }
  // Le directeur voit aussi les entités désactivées (pour pouvoir les réactiver)
  const rows = await db.all(BALANCE_SELECT + ' ORDER BY e.active DESC, e.name');
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  if (req.entityScope && req.entityScope !== req.params.id) return res.status(403).json({ error: 'Accès non autorisé' });
  const row = await db.get(BALANCE_SELECT + ' WHERE e.id = $1', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Entité introuvable' });
  res.json(row);
});

// Créer une nouvelle entité (réservé aux directeurs)
router.post('/', async (req, res) => {
  if (req.user.role !== 'directeur') return res.status(403).json({ error: 'Réservé aux directeurs' });
  const { name, sub, iban, address, siret, ape, urssaf, conventionCollective, tauxATMP, balance } = req.body;
  if (!name) return res.status(400).json({ error: 'Le nom est requis' });

  let id = slugify(name);
  const existing = await db.get('SELECT id FROM entities WHERE id = $1', [id]);
  if (existing) id = id + '-' + Date.now().toString().slice(-4);

  await db.run(
    `INSERT INTO entities (id,name,sub,iban,balance,address,siret,ape,urssaf,convention_collective,taux_atmp,active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1)`,
    [id, name, sub || null, iban || null, balance || 0, address || null, siret || null, ape || null, urssaf || null, conventionCollective || null, tauxATMP || 0.02]
  );
  res.status(201).json({ id });
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

// Désactiver / réactiver une entité (réservé aux directeurs) — ne supprime jamais les données
router.patch('/:id/toggle', async (req, res) => {
  if (req.user.role !== 'directeur') return res.status(403).json({ error: 'Réservé aux directeurs' });
  const entity = await db.get('SELECT * FROM entities WHERE id = $1', [req.params.id]);
  if (!entity) return res.status(404).json({ error: 'Entité introuvable' });
  const newActive = entity.active ? 0 : 1;
  await db.run('UPDATE entities SET active = $1 WHERE id = $2', [newActive, req.params.id]);
  res.json({ active: newActive === 1 });
});

module.exports = router;
