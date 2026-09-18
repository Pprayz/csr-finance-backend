const express = require('express');
const db = require('../db');
const { requireAuth, requireModule, scopeEntity } = require('../middleware/auth');

const router = express.Router();

const CHARGES_SALARIALES = 0.22;
const CHARGES_PATRONALES = 0.42;
function computePayslip(gross) {
  const salarial = gross * CHARGES_SALARIALES;
  const patronal = gross * CHARGES_PATRONALES;
  return { brut: gross, cotisSalariales: salarial, net: gross - salarial, cotisPatronales: patronal, coutTotal: gross + patronal };
}

// --- Salariés : réservé aux directeurs (masse salariale groupe) ---
router.get('/employees', requireAuth, requireModule('salaires'), scopeEntity, async (req, res) => {
  const rows = req.entityScope
    ? await db.all('SELECT * FROM employees WHERE entity_id = $1', [req.entityScope])
    : await db.all('SELECT * FROM employees');
  res.json(rows);
});

router.post('/employees', requireAuth, requireModule('salaires'), async (req, res) => {
  const { entityId, name, role, contract, gross } = req.body;
  if (!entityId || !name || !gross) return res.status(400).json({ error: 'Champs manquants' });
  const id = 'e' + Date.now();
  await db.run(
    'INSERT INTO employees (id,entity_id,name,role,contract,gross,start_date) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id, entityId, name, role || 'Salarié', contract || 'CDI', gross, new Date().toISOString().slice(0, 10)]
  );
  res.status(201).json({ id });
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
  res.status(201).json({ id, ...calc });
});

module.exports = router;
