const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAuth, requireModule } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireModule('acces'));

router.get('/', async (req, res) => {
  const rows = await db.all('SELECT id, username, name, role, entity_id, employee_id, active FROM users WHERE active = 1');
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { username, name, role, entityId, employeeId, pin } = req.body;
  if (!username || !name || !role || !entityId || !pin || !/^[0-9]{4,6}$/.test(pin)) {
    return res.status(400).json({ error: 'Champs manquants ou PIN invalide (4 à 6 chiffres)' });
  }
  const existing = await db.get('SELECT id FROM users WHERE username = $1', [username.toLowerCase()]);
  if (existing) return res.status(400).json({ error: 'Cet identifiant est déjà utilisé' });
  const id = 'u' + Date.now();
  const hash = bcrypt.hashSync(pin, 10);
  await db.run(
    'INSERT INTO users (id,username,name,role,entity_id,employee_id,password_hash) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id, username.toLowerCase(), name, role, entityId, employeeId || null, hash]
  );
  res.status(201).json({ id });
});

router.patch('/:id', async (req, res) => {
  const user = await db.get('SELECT * FROM users WHERE id = $1', [req.params.id]);
  if (!user) return res.status(404).json({ error: 'Compte introuvable' });
  const { username, name, role, entityId, employeeId, pin } = req.body;
  if (username) {
    const existing = await db.get('SELECT id FROM users WHERE username = $1 AND id != $2', [username.toLowerCase(), req.params.id]);
    if (existing) return res.status(400).json({ error: 'Cet identifiant est déjà utilisé' });
  }
  const passwordHash = pin ? bcrypt.hashSync(pin, 10) : user.password_hash;
  await db.run(
    'UPDATE users SET username=$1, name=$2, role=$3, entity_id=$4, employee_id=$5, password_hash=$6 WHERE id=$7',
    [username ? username.toLowerCase() : user.username, name || user.name, role || user.role, entityId || user.entity_id, employeeId !== undefined ? employeeId : user.employee_id, passwordHash, req.params.id]
  );
  res.json({ ok: true });
});

router.delete('/:id', async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'Impossible de supprimer votre propre compte' });
  await db.run('UPDATE users SET active = 0 WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
