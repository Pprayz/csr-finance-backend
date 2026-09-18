const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { signToken, requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/accounts', async (req, res) => {
  const rows = await db.all(`
    SELECT u.id, u.name, u.role, u.entity_id, e.name as entity_name
    FROM users u LEFT JOIN entities e ON e.id = u.entity_id
    WHERE u.active = 1
  `);
  res.json(rows);
});

router.post('/login', async (req, res) => {
  const { userId, password } = req.body;
  if (!userId || !password) return res.status(400).json({ error: 'Identifiant et mot de passe requis' });

  const user = await db.get('SELECT * FROM users WHERE id = $1 AND active = 1', [userId]);
  if (!user) return res.status(401).json({ error: 'Compte introuvable' });

  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Mot de passe incorrect' });

  const token = signToken(user);
  res.json({
    token,
    user: { id: user.id, name: user.name, role: user.role, entityId: user.entity_id, employeeId: user.employee_id }
  });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
