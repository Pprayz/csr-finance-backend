const express = require('express');
const db = require('../db');
const { requireAuth, requireModule, scopeEntity } = require('../middleware/auth');

const router = express.Router();

function canEditEntity(req, entityId) {
  return req.user.role === 'directeur' || req.user.entityId === entityId;
}

// --- Produits ---
router.get('/products', requireAuth, requireModule('produits'), scopeEntity, async (req, res) => {
  const rows = req.entityScope
    ? await db.all('SELECT * FROM products WHERE entity_id = $1', [req.entityScope])
    : await db.all('SELECT * FROM products');
  res.json(rows);
});

router.post('/products', requireAuth, requireModule('produits'), async (req, res) => {
  const { entityId, name, sku, category, price, cost } = req.body;
  const targetEntity = req.user.role === 'directeur' ? entityId : req.user.entityId;
  if (!targetEntity || !name) return res.status(400).json({ error: 'Champs manquants' });
  const id = 'pr' + Date.now();
  await db.run(
    'INSERT INTO products (id,entity_id,name,sku,category,price,cost,active) VALUES ($1,$2,$3,$4,$5,$6,$7,1)',
    [id, targetEntity, name, sku || ('SKU-' + Date.now()), category || 'Divers', price || 0, cost || 0]
  );
  res.status(201).json({ id });
});

router.patch('/products/:id', requireAuth, requireModule('produits'), async (req, res) => {
  const p = await db.get('SELECT * FROM products WHERE id = $1', [req.params.id]);
  if (!p) return res.status(404).json({ error: 'Produit introuvable' });
  if (!canEditEntity(req, p.entity_id)) return res.status(403).json({ error: 'Accès non autorisé' });
  const { entityId, name, sku, category, price, cost, active } = req.body;
  const newEntity = entityId || p.entity_id;
  if (!canEditEntity(req, newEntity)) return res.status(403).json({ error: 'Accès non autorisé' });
  await db.run(
    'UPDATE products SET entity_id=$1, name=$2, sku=$3, category=$4, price=$5, cost=$6, active=$7 WHERE id=$8',
    [newEntity, name || p.name, sku || p.sku, category || p.category, price !== undefined ? price : p.price, cost !== undefined ? cost : p.cost, active !== undefined ? (active ? 1 : 0) : p.active, req.params.id]
  );
  res.json({ ok: true });
});

router.delete('/products/:id', requireAuth, requireModule('produits'), async (req, res) => {
  const p = await db.get('SELECT * FROM products WHERE id = $1', [req.params.id]);
  if (!p) return res.status(404).json({ error: 'Produit introuvable' });
  if (!canEditEntity(req, p.entity_id)) return res.status(403).json({ error: 'Accès non autorisé' });
  await db.run('DELETE FROM stock WHERE product_id = $1', [req.params.id]);
  await db.run('DELETE FROM products WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// --- Stocks ---
router.get('/stock', requireAuth, requireModule('stock'), scopeEntity, async (req, res) => {
  const rows = req.entityScope
    ? await db.all('SELECT * FROM stock WHERE entity_id = $1', [req.entityScope])
    : await db.all('SELECT * FROM stock');
  res.json(rows);
});

router.post('/stock', requireAuth, requireModule('stock'), async (req, res) => {
  const { entityId, productId, qty, threshold, unit } = req.body;
  const targetEntity = req.user.role === 'directeur' ? entityId : req.user.entityId;
  if (!targetEntity || !productId) return res.status(400).json({ error: 'Champs manquants' });
  const id = 's' + Date.now();
  await db.run(
    'INSERT INTO stock (id,entity_id,product_id,qty,threshold,unit) VALUES ($1,$2,$3,$4,$5,$6)',
    [id, targetEntity, productId, qty || 0, threshold || 0, unit || 'unités']
  );
  res.status(201).json({ id });
});

router.patch('/stock/:id', requireAuth, requireModule('stock'), async (req, res) => {
  const s = await db.get('SELECT * FROM stock WHERE id = $1', [req.params.id]);
  if (!s) return res.status(404).json({ error: 'Article introuvable' });
  if (!canEditEntity(req, s.entity_id)) return res.status(403).json({ error: 'Accès non autorisé' });
  const { entityId, productId, qty, threshold, unit } = req.body;
  const newEntity = entityId || s.entity_id;
  if (!canEditEntity(req, newEntity)) return res.status(403).json({ error: 'Accès non autorisé' });
  await db.run(
    'UPDATE stock SET entity_id=$1, product_id=$2, qty=$3, threshold=$4, unit=$5 WHERE id=$6',
    [newEntity, productId || s.product_id, qty !== undefined ? qty : s.qty, threshold !== undefined ? threshold : s.threshold, unit || s.unit, req.params.id]
  );
  res.json({ ok: true });
});

router.patch('/stock/:id/adjust', requireAuth, requireModule('stock'), scopeEntity, async (req, res) => {
  const { delta } = req.body;
  const item = await db.get('SELECT * FROM stock WHERE id = $1', [req.params.id]);
  if (!item) return res.status(404).json({ error: 'Article introuvable' });
  if (req.entityScope && item.entity_id !== req.entityScope) return res.status(403).json({ error: 'Accès non autorisé' });
  const newQty = Math.max(0, item.qty + Number(delta || 0));
  await db.run('UPDATE stock SET qty = $1 WHERE id = $2', [newQty, req.params.id]);
  res.json({ qty: newQty });
});

router.delete('/stock/:id', requireAuth, requireModule('stock'), async (req, res) => {
  const s = await db.get('SELECT * FROM stock WHERE id = $1', [req.params.id]);
  if (!s) return res.status(404).json({ error: 'Article introuvable' });
  if (!canEditEntity(req, s.entity_id)) return res.status(403).json({ error: 'Accès non autorisé' });
  await db.run('DELETE FROM stock WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
