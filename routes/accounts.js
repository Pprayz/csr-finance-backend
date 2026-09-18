const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAuth, requireModule } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireModule('acces'));

router.get('/', async (req, res) => {
  const rows = await db.all('SELECT id, name, role, entity_id, employee_id, active FROM users');
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { name, role, entityId, employeeId, password } = req.body;
  if (!name || !role || !entityId || !password || password.length < 8) {
    return res.status(400).json({ error: 'Champs manquants ou mot de passe trop court (8 caractères minimum)' });
  }
  const id = 'u' + Date.now();
  const hash = bcrypt.hashSync(password, 10);
  await db.run(
    'INSERT INTO users (id,name,role,entity_id,employee_id,password_hash) VALUES ($1,$2,$3,$4,$5,$6)',
    [id, name, role, entityId, employeeId || null, hash]
  );
  res.status(201).json({ id });
});

router.delete('/:id', async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'Impossible de supprimer votre propre compte' });
  await db.run('UPDATE users SET active = 0 WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
