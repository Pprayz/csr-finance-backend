const express = require('express');
const db = require('../db');
const { requireAuth, requireModule } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireModule('formations'));

const MAX_ATTESTATION_LENGTH = 6 * 1024 * 1024;
function cleanBase64(data) {
  if (!data) return data;
  const commaIndex = data.indexOf(',');
  return data.startsWith('data:') && commaIndex !== -1 ? data.slice(commaIndex + 1) : data;
}
async function employeeEntity(employeeId) {
  const e = await db.get('SELECT entity_id FROM employees WHERE id = $1', [employeeId]);
  return e ? e.entity_id : null;
}
// Un directeur peut tout ; un responsable peut agir sur les salariés de sa propre entité (lui-même inclus)
async function canActOnEmployee(req, employeeId) {
  if (req.user.role === 'directeur') return true;
  if (req.user.employeeId === employeeId) return false; // pas d'auto-validation, voir usages spécifiques
  if (req.user.role === 'responsable') {
    const entityId = await employeeEntity(employeeId);
    return entityId === req.user.entityId;
  }
  return false;
}

function trainingOut(t) {
  return { id: t.id, title: t.title, description: t.description, duration: t.duration, category: t.category, modules: t.modules || [], active: t.active === 1 || t.active === true };
}
function enrollmentOut(e) {
  return {
    id: e.id, trainingId: e.training_id, employeeId: e.employee_id, status: e.status, progress: e.progress,
    completedModules: e.completed_modules || [],
    requestedAt: e.requested_at, decidedAt: e.decided_at, completedAt: e.completed_at, attestationName: e.attestation_name,
    trainingTitle: e.training_title, employeeName: e.employee_name, entityId: e.entity_id,
  };
}

// --- Catalogue ---
router.get('/', async (req, res) => {
  const rows = await db.all('SELECT * FROM trainings WHERE active = 1 ORDER BY title');
  res.json(rows.map(trainingOut));
});

router.post('/', async (req, res) => {
  if (req.user.role !== 'directeur') return res.status(403).json({ error: 'Réservé aux directeurs' });
  const { title, description, duration, category, modules } = req.body;
  if (!title) return res.status(400).json({ error: 'Le titre est requis' });
  const id = 'fo' + Date.now();
  const cleanModules = Array.isArray(modules) ? modules.filter(m => m && m.trim()) : [];
  await db.run('INSERT INTO trainings (id,title,description,duration,category,modules) VALUES ($1,$2,$3,$4,$5,$6)',
    [id, title, description || null, duration || null, category || null, JSON.stringify(cleanModules)]);
  res.status(201).json({ id });
});

router.patch('/:id', async (req, res) => {
  if (req.user.role !== 'directeur') return res.status(403).json({ error: 'Réservé aux directeurs' });
  const t = await db.get('SELECT * FROM trainings WHERE id = $1', [req.params.id]);
  if (!t) return res.status(404).json({ error: 'Formation introuvable' });
  const { title, description, duration, category, active, modules } = req.body;
  const newModules = Array.isArray(modules) ? modules.filter(m => m && m.trim()) : (t.modules || []);
  await db.run(
    'UPDATE trainings SET title=$1, description=$2, duration=$3, category=$4, active=$5, modules=$6 WHERE id=$7',
    [title || t.title, description !== undefined ? description : t.description, duration !== undefined ? duration : t.duration,
      category !== undefined ? category : t.category, active !== undefined ? (active ? 1 : 0) : t.active, JSON.stringify(newModules), req.params.id]
  );
  res.json({ ok: true });
});

router.delete('/:id', async (req, res) => {
  if (req.user.role !== 'directeur') return res.status(403).json({ error: 'Réservé aux directeurs' });
  await db.run('DELETE FROM trainings WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// --- Inscriptions / demandes ---
const ENROLLMENT_SELECT = `
  SELECT en.*, t.title AS training_title, emp.name AS employee_name, emp.entity_id AS entity_id
  FROM training_enrollments en
  JOIN trainings t ON t.id = en.training_id
  JOIN employees emp ON emp.id = en.employee_id
`;

router.get('/enrollments', async (req, res) => {
  let rows;
  if (req.user.role === 'directeur') {
    rows = await db.all(ENROLLMENT_SELECT + ' ORDER BY en.requested_at DESC');
  } else if (req.user.role === 'responsable') {
    rows = await db.all(ENROLLMENT_SELECT + ' WHERE emp.entity_id = $1 ORDER BY en.requested_at DESC', [req.user.entityId]);
  } else {
    rows = await db.all(ENROLLMENT_SELECT + ' WHERE en.employee_id = $1 ORDER BY en.requested_at DESC', [req.user.employeeId]);
  }
  res.json(rows.map(enrollmentOut));
});

router.post('/:id/request', async (req, res) => {
  if (!req.user.employeeId) return res.status(400).json({ error: 'Aucune fiche salarié liée à votre compte' });
  const training = await db.get('SELECT * FROM trainings WHERE id = $1 AND active = 1', [req.params.id]);
  if (!training) return res.status(404).json({ error: 'Formation introuvable' });
  const existing = await db.get(
    "SELECT * FROM training_enrollments WHERE training_id = $1 AND employee_id = $2 AND status != 'refusée'",
    [req.params.id, req.user.employeeId]
  );
  if (existing) return res.status(400).json({ error: 'Une demande existe déjà pour cette formation' });
  const id = 'te' + Date.now();
  await db.run('INSERT INTO training_enrollments (id,training_id,employee_id) VALUES ($1,$2,$3)', [id, req.params.id, req.user.employeeId]);
  res.status(201).json({ id });
});

router.patch('/enrollments/:id/respond', async (req, res) => {
  const en = await db.get('SELECT * FROM training_enrollments WHERE id = $1', [req.params.id]);
  if (!en) return res.status(404).json({ error: 'Demande introuvable' });
  const { decision } = req.body;
  if (!['approuvée', 'refusée'].includes(decision)) return res.status(400).json({ error: 'Décision invalide' });
  if (req.user.role === 'employe') return res.status(403).json({ error: 'Réservé aux responsables/directeurs' });
  if (req.user.role === 'responsable') {
    const entityId = await employeeEntity(en.employee_id);
    if (entityId !== req.user.entityId) return res.status(403).json({ error: 'Accès non autorisé' });
  }
  await db.run("UPDATE training_enrollments SET status = $1, decided_at = NOW() WHERE id = $2", [decision, req.params.id]);
  res.json({ ok: true });
});

router.patch('/enrollments/:id/progress', async (req, res) => {
  const en = await db.get('SELECT * FROM training_enrollments WHERE id = $1', [req.params.id]);
  if (!en) return res.status(404).json({ error: 'Inscription introuvable' });
  if (en.status !== 'approuvée' && en.status !== 'terminée') return res.status(400).json({ error: "La formation doit d'abord être approuvée" });

  const isSelf = req.user.employeeId === en.employee_id;
  let allowed = isSelf || req.user.role === 'directeur';
  if (!allowed && req.user.role === 'responsable') {
    const entityId = await employeeEntity(en.employee_id);
    allowed = entityId === req.user.entityId;
  }
  if (!allowed) return res.status(403).json({ error: 'Accès non autorisé' });

  let { progress } = req.body;
  progress = Math.max(0, Math.min(100, Number(progress) || 0));
  const newStatus = progress >= 100 ? 'terminée' : 'approuvée';
  await db.run(
    `UPDATE training_enrollments SET progress = $1, status = $2, completed_at = ${progress >= 100 ? 'NOW()' : 'completed_at'} WHERE id = $3`,
    [progress, newStatus, req.params.id]
  );
  res.json({ ok: true, status: newStatus });
});

// Coche/décoche un module précis — la progression est recalculée automatiquement (modules cochés / total)
router.patch('/enrollments/:id/modules', async (req, res) => {
  const en = await db.get('SELECT * FROM training_enrollments WHERE id = $1', [req.params.id]);
  if (!en) return res.status(404).json({ error: 'Inscription introuvable' });
  if (en.status !== 'approuvée' && en.status !== 'terminée') return res.status(400).json({ error: "La formation doit d'abord être approuvée" });

  const isSelf = req.user.employeeId === en.employee_id;
  let allowed = isSelf || req.user.role === 'directeur';
  if (!allowed && req.user.role === 'responsable') {
    const entityId = await employeeEntity(en.employee_id);
    allowed = entityId === req.user.entityId;
  }
  if (!allowed) return res.status(403).json({ error: 'Accès non autorisé' });

  const training = await db.get('SELECT * FROM trainings WHERE id = $1', [en.training_id]);
  const totalModules = (training.modules || []).length;
  if (totalModules === 0) return res.status(400).json({ error: "Cette formation n'a pas de modules définis" });

  const { moduleIndex, checked } = req.body;
  let completed = Array.isArray(en.completed_modules) ? [...en.completed_modules] : [];
  if (checked) {
    if (!completed.includes(moduleIndex)) completed.push(moduleIndex);
  } else {
    completed = completed.filter(i => i !== moduleIndex);
  }
  const progress = Math.round((completed.length / totalModules) * 100);
  const newStatus = progress >= 100 ? 'terminée' : 'approuvée';
  await db.run(
    `UPDATE training_enrollments SET completed_modules = $1, progress = $2, status = $3, completed_at = ${progress >= 100 ? 'NOW()' : 'NULL'} WHERE id = $4`,
    [JSON.stringify(completed), progress, newStatus, req.params.id]
  );
  res.json({ ok: true, progress, status: newStatus, completedModules: completed });
});

// Stocke l'attestation générée côté client une fois la formation terminée
router.post('/enrollments/:id/attestation', async (req, res) => {
  const en = await db.get('SELECT * FROM training_enrollments WHERE id = $1', [req.params.id]);
  if (!en) return res.status(404).json({ error: 'Inscription introuvable' });
  const isSelf = req.user.employeeId === en.employee_id;
  if (!isSelf && req.user.role !== 'directeur') return res.status(403).json({ error: 'Accès non autorisé' });
  if (en.status !== 'terminée') return res.status(400).json({ error: "La formation n'est pas terminée" });
  const { attachmentName, attachmentData } = req.body;
  const cleaned = cleanBase64(attachmentData);
  if (!cleaned || cleaned.length > MAX_ATTESTATION_LENGTH) return res.status(400).json({ error: 'Fichier invalide ou trop volumineux' });
  await db.run('UPDATE training_enrollments SET attestation_name = $1, attestation_data = $2 WHERE id = $3', [attachmentName || 'attestation.pdf', cleaned, req.params.id]);
  res.json({ ok: true });
});

router.get('/enrollments/:id/attestation', async (req, res) => {
  const en = await db.get('SELECT * FROM training_enrollments WHERE id = $1', [req.params.id]);
  if (!en) return res.status(404).json({ error: 'Inscription introuvable' });
  const isSelf = req.user.employeeId === en.employee_id;
  let allowed = isSelf || req.user.role === 'directeur';
  if (!allowed && req.user.role === 'responsable') {
    const entityId = await employeeEntity(en.employee_id);
    allowed = entityId === req.user.entityId;
  }
  if (!allowed) return res.status(403).json({ error: 'Accès non autorisé' });
  if (!en.attestation_data) return res.status(404).json({ error: 'Aucune attestation disponible' });
  const buffer = Buffer.from(en.attestation_data, 'base64');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${(en.attestation_name || 'attestation.pdf').replace(/"/g, '')}"`);
  res.send(buffer);
});

router.delete('/enrollments/:id', async (req, res) => {
  const en = await db.get('SELECT * FROM training_enrollments WHERE id = $1', [req.params.id]);
  if (!en) return res.status(404).json({ error: 'Inscription introuvable' });
  const isSelf = req.user.employeeId === en.employee_id;
  if (isSelf && en.status !== 'en attente') return res.status(400).json({ error: 'Seule une demande en attente peut être annulée' });
  if (!isSelf && req.user.role !== 'directeur') {
    if (req.user.role !== 'responsable') return res.status(403).json({ error: 'Accès non autorisé' });
    const entityId = await employeeEntity(en.employee_id);
    if (entityId !== req.user.entityId) return res.status(403).json({ error: 'Accès non autorisé' });
  }
  await db.run('DELETE FROM training_enrollments WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
