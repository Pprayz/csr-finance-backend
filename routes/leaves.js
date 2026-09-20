const express = require('express');
const db = require('../db');
const { requireAuth, requireModule } = require('../middleware/auth');
const { sendLeaveNotification } = require('../mailer');

const router = express.Router();
router.use(requireAuth, requireModule('planning'));

async function employeesInScope(req) {
  if (req.user.role === 'directeur') return db.all('SELECT * FROM employees');
  if (req.user.role === 'responsable') return db.all('SELECT * FROM employees WHERE entity_id = $1', [req.user.entityId]);
  return db.all('SELECT * FROM employees WHERE id = $1', [req.user.employeeId]);
}

router.get('/', async (req, res) => {
  const scoped = await employeesInScope(req);
  const ids = scoped.map(e => e.id);
  if (ids.length === 0) return res.json([]);
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
  const rows = await db.all(`SELECT * FROM leaves WHERE employee_id IN (${placeholders}) ORDER BY start_date DESC`, ids);
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { type, start, end, comment } = req.body;
  if (!req.user.employeeId) return res.status(400).json({ error: 'Aucune fiche salarié liée à votre compte' });
  if (!start || !end || end < start) return res.status(400).json({ error: 'Dates invalides' });

  const id = 'l' + Date.now();
  await db.run(
    `INSERT INTO leaves (id,employee_id,type,start_date,end_date,status,comment)
     VALUES ($1,$2,$3,$4,$5,'en attente',$6)`,
    [id, req.user.employeeId, type, start, end, comment || null]
  );

  // Notification : responsable de la filiale (si ce n'est pas le demandeur) + tous les directeurs (sauf le demandeur)
  const employee = await db.get('SELECT * FROM employees WHERE id = $1', [req.user.employeeId]);
  const entity = await db.get('SELECT * FROM entities WHERE id = $1', [employee.entity_id]);
  const recipients = await db.all(
    `SELECT * FROM users
     WHERE active = 1 AND id != $1 AND (
       role = 'directeur' OR (role = 'responsable' AND entity_id = $2)
     )`,
    [req.user.id, employee.entity_id]
  );
  const toEmails = recipients.map(r => r.email).filter(Boolean);

  let notification = { sent: false };
  try {
    notification = await sendLeaveNotification({
      toEmails,
      employeeName: req.user.name,
      entityName: entity ? entity.name : '',
      type, start, end, comment,
    });
  } catch (e) {
    console.error('Erreur envoi notification congé :', e.message);
  }

  res.status(201).json({ id, notification });
});

router.patch('/:id/respond', async (req, res) => {
  if (req.user.role === 'employe') return res.status(403).json({ error: 'Réservé aux responsables/directeurs' });
  const { decision } = req.body;
  if (!['approuvé', 'refusé'].includes(decision)) return res.status(400).json({ error: 'Décision invalide' });

  const leave = await db.get('SELECT * FROM leaves WHERE id = $1', [req.params.id]);
  if (!leave) return res.status(404).json({ error: 'Demande introuvable' });

  if (req.user.role === 'responsable') {
    const employee = await db.get('SELECT * FROM employees WHERE id = $1', [leave.employee_id]);
    if (!employee || employee.entity_id !== req.user.entityId) return res.status(403).json({ error: 'Accès non autorisé' });
  }

  await db.run('UPDATE leaves SET status = $1 WHERE id = $2', [decision, req.params.id]);
  res.json({ ok: true });
});

// Modification complète : directeur (toutes filiales) OU l'auteur si la demande est encore en attente
router.patch('/:id', async (req, res) => {
  const leave = await db.get('SELECT * FROM leaves WHERE id = $1', [req.params.id]);
  if (!leave) return res.status(404).json({ error: 'Demande introuvable' });

  const isOwner = leave.employee_id === req.user.employeeId;
  if (req.user.role !== 'directeur') {
    if (!isOwner) return res.status(403).json({ error: 'Accès non autorisé' });
    if (leave.status !== 'en attente') return res.status(400).json({ error: 'Seule une demande en attente peut être modifiée' });
  }

  const { type, start, end, status, comment } = req.body;
  const newStatus = req.user.role === 'directeur' ? (status || leave.status) : leave.status;
  await db.run(
    'UPDATE leaves SET type = $1, start_date = $2, end_date = $3, status = $4, comment = $5 WHERE id = $6',
    [type || leave.type, start || leave.start_date, end || leave.end_date, newStatus, comment !== undefined ? comment : leave.comment, req.params.id]
  );
  res.json({ ok: true });
});

router.delete('/:id', async (req, res) => {
  const leave = await db.get('SELECT * FROM leaves WHERE id = $1', [req.params.id]);
  if (!leave) return res.status(404).json({ error: 'Demande introuvable' });

  if (req.user.role === 'directeur') {
    await db.run('DELETE FROM leaves WHERE id = $1', [req.params.id]);
    return res.json({ ok: true });
  }
  // Un salarié ne peut supprimer que sa propre demande, et seulement si elle est en attente
  if (leave.employee_id !== req.user.employeeId) return res.status(403).json({ error: 'Accès non autorisé' });
  if (leave.status !== 'en attente') return res.status(400).json({ error: 'Seule une demande en attente peut être supprimée' });
  await db.run('DELETE FROM leaves WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
