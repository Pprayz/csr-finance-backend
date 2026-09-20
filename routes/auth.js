const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { signToken, requireAuth } = require('../middleware/auth');

const router = express.Router();

router.post('/login', async (req, res) => {
  const { username, pin } = req.body;
  if (!username || !pin) return res.status(400).json({ error: 'Identifiant et code PIN requis' });

  const user = await db.get('SELECT * FROM users WHERE username = $1 AND active = 1', [username.toLowerCase()]);
  if (!user) return res.status(401).json({ error: 'Identifiant ou code PIN incorrect' });

  const ok = bcrypt.compareSync(pin, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Identifiant ou code PIN incorrect' });

  const token = signToken(user);
  res.json({
    token,
    user: { id: user.id, username: user.username, name: user.name, role: user.role, entityId: user.entity_id, employeeId: user.employee_id }
  });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
