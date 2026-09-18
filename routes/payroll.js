const express = require('express');
const db = require('../db');
const { requireAuth, requireModule, scopeEntity } = require('../middleware/auth');
const { sendPayslipNotification } = require('../mailer');

const router = express.Router();

function canEditEntity(req, entityId) {
  return req.user.role === 'directeur' || req.user.entityId === entityId;
}
function canSeeRoster(req) {
  return req.user.role === 'directeur' || req.user.role === 'responsable';
}

const CHARGES_SALARIALES = 0.22;
const CHARGES_PATRONALES = 0.42;
function computePayslip(gross) {
  const salarial = gross * CHARGES_SALARIALES;
  const patronal = gross * CHARGES_PATRONALES;
  return { brut: gross, cotisSalariales: salarial, net: gross - salarial, cotisPatronales: patronal, coutTotal: gross + patronal };
}

// --- Salariés : directeur (tout le groupe) et responsable (sa propre filiale) ---
router.get('/employees', requireAuth, scopeEntity, async (req, res) => {
  if (!canSeeRoster(req)) return res.status(403).json({ error: 'Accès non autorisé' });
  const rows = req.entityScope
    ? await db.all('SELECT * FROM employees WHERE entity_id = $1', [req.entityScope])
    : await db.all('SELECT * FROM employees');
  res.json(rows);
});

router.post('/employees', requireAuth, async (req, res) => {
  const { entityId, name, role, contract, gross } = req.body;
  if (!canEditEntity(req, entityId)) return res.status(403).json({ error: 'Accès non autorisé' });
  if (!entityId || !name || !gross) return res.status(400).json({ error: 'Champs manquants' });
  const id = 'e' + Date.now();
  await db.run(
    'INSERT INTO employees (id,entity_id,name,role,contract,gross,start_date) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id, entityId, name, role || 'Salarié', contract || 'CDI', gross, new Date().toISOString().slice(0, 10)]
  );
  res.status(201).json({ id });
});

router.patch('/employees/:id', requireAuth, async (req, res) => {
  const emp = await db.get('SELECT * FROM employees WHERE id = $1', [req.params.id]);
  if (!emp) return res.status(404).json({ error: 'Salarié introuvable' });
  if (!canEditEntity(req, emp.entity_id)) return res.status(403).json({ error: 'Accès non autorisé' });
  const { entityId, name, role, contract, gross } = req.body;
  const newEntity = entityId || emp.entity_id;
  if (!canEditEntity(req, newEntity)) return res.status(403).json({ error: 'Accès non autorisé' });
  await db.run(
    'UPDATE employees SET entity_id=$1, name=$2, role=$3, contract=$4, gross=$5 WHERE id=$6',
    [newEntity, name || emp.name, role || emp.role, contract || emp.contract, gross !== undefined ? gross : emp.gross, req.params.id]
  );
  res.json({ ok: true });
});

router.delete('/employees/:id', requireAuth, async (req, res) => {
  const emp = await db.get('SELECT * FROM employees WHERE id = $1', [req.params.id]);
  if (!emp) return res.status(404).json({ error: 'Salarié introuvable' });
  if (!canEditEntity(req, emp.entity_id)) return res.status(403).json({ error: 'Accès non autorisé' });
  await db.run('DELETE FROM transactions WHERE payslip_id IN (SELECT id FROM payslips WHERE employee_id = $1)', [req.params.id]);
  await db.run('DELETE FROM payslips WHERE employee_id = $1', [req.params.id]);
  await db.run('DELETE FROM employees WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// --- Fiches de paie : directeur voit tout, responsable/employé voient les leurs ---
router.get('/payslips', requireAuth, async (req, res) => {
  let rows;
  if (req.user.role === 'directeur') {
    rows = await db.all('SELECT * FROM payslips ORDER BY period DESC');
  } else {
    rows = await db.all('SELECT * FROM payslips WHERE employee_id = $1 ORDER BY period DESC', [req.user.employeeId]);
  }
  res.json(rows);
});

router.post('/payslips', requireAuth, requireModule('salaires'), async (req, res) => {
  const { employeeId, period } = req.body;
  const employee = await db.get('SELECT * FROM employees WHERE id = $1', [employeeId]);
  if (!employee || !period) return res.status(400).json({ error: 'Salarié ou période invalide' });
  const calc = computePayslip(employee.gross);
  const id = 'p' + Date.now();
  await db.run(
    `INSERT INTO payslips (id,employee_id,period,brut,cotis_salariales,net,cotis_patronales,cout_total,status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'générée')`,
    [id, employeeId, period, calc.brut, calc.cotisSalariales, calc.net, calc.cotisPatronales, calc.coutTotal]
  );

  // Génère automatiquement la dépense correspondante dans la trésorerie de l'entité
  const [y, m] = period.split('-').map(Number);
  const payDate = new Date(y, m, 0).toISOString().slice(0, 10);
  const txId = 't' + Date.now();
  await db.run(
    'INSERT INTO transactions (id,entity_id,date,label,category,amount,type,created_by,payslip_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [txId, employee.entity_id, payDate, `Bulletin de salaire — ${employee.role} (${period})`, 'Salaires', -calc.net, 'debit', req.user.id, id]
  );

  // Notification simulée/réelle au salarié concerné (s'il a un compte lié)
  const empAccount = await db.get('SELECT * FROM users WHERE employee_id = $1 AND active = 1', [employeeId]);
  let notification = { sent: false };
  if (empAccount && empAccount.email) {
    try {
      notification = await sendPayslipNotification({
        toEmails: [empAccount.email],
        employeeName: employee.name,
        period,
        net: calc.net,
      });
    } catch (e) {
      console.error('Erreur envoi notification paie :', e.message);
    }
  }

  res.status(201).json({ id, ...calc, notification });
});

router.delete('/payslips/:id', requireAuth, requireModule('salaires'), async (req, res) => {
  if (req.user.role !== 'directeur') return res.status(403).json({ error: 'Réservé aux directeurs' });
  await db.run('DELETE FROM transactions WHERE payslip_id = $1', [req.params.id]);
  await db.run('DELETE FROM payslips WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
