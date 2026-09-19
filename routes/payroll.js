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

/* ---------------- Moteur de paie détaillé (identique au prototype) ---------------- */
const HEURES_MENSUELLES_TEMPS_PLEIN = 151.67;
const COTIS_SALARIALES_LIGNES = [
  { label: 'Santé (mutuelle salariale)', taux: 0.015, base: 'brut' },
  { label: 'Retraite (Sécurité sociale + complémentaire)', taux: 0.1005, base: 'brut' },
  { label: 'Chômage (assurance chômage)', taux: 0.0, base: 'brut' },
  { label: 'CSG déductible', taux: 0.068, base: 'csgcrds' },
  { label: 'CSG/CRDS non déductibles', taux: 0.029, base: 'csgcrds' },
];
function cotisPatronalesLignes(entity) {
  return [
    { label: 'Santé (assurance maladie)', taux: 0.070, base: 'brut' },
    { label: 'Accidents du travail / maladies professionnelles', taux: (entity && entity.taux_atmp) || 0.020, base: 'brut' },
    { label: 'Retraite (Sécurité sociale + complémentaire)', taux: 0.1327, base: 'brut' },
    { label: 'Famille (allocations familiales)', taux: 0.0345, base: 'brut' },
    { label: 'Chômage (assurance chômage)', taux: 0.0405, base: 'brut' },
    { label: "Formation professionnelle & taxe d'apprentissage", taux: 0.0123, base: 'brut' },
    { label: 'Autres contributions (FNAL, versement mobilité...)', taux: 0.005, base: 'brut' },
  ];
}
function computePayslip(gross, opts = {}) {
  const heures = opts.heures || HEURES_MENSUELLES_TEMPS_PLEIN;
  const heuresSupp = opts.heuresSupp || 0;
  const primeAnciennete = opts.primeAnciennete || 0;
  const prime13e = opts.prime13e || 0;
  const avantageNature = opts.avantageNature || 0;
  const commission = opts.commission || 0;
  const congesJours = opts.congesJours || 0;
  const entity = opts.entity || null;
  const tauxPAS = opts.tauxPAS || 0;

  const tauxHoraire = gross / HEURES_MENSUELLES_TEMPS_PLEIN;
  const tauxJournalier = tauxHoraire * (HEURES_MENSUELLES_TEMPS_PLEIN / 30);
  const congesDeduction = congesJours * tauxJournalier;
  const congesIndemnite = congesJours * tauxJournalier;

  const salaireBase = gross;
  const brut = salaireBase + heuresSupp + primeAnciennete + prime13e + avantageNature + commission - congesDeduction + congesIndemnite;
  const assietteCSG = brut * 0.9825;

  const lignesSalariales = COTIS_SALARIALES_LIGNES.map(l => {
    const assiette = l.base === 'csgcrds' ? assietteCSG : brut;
    return { label: l.label, assiette, taux: l.taux, montant: assiette * l.taux };
  });
  const cotisSalariales = lignesSalariales.reduce((s, l) => s + l.montant, 0);
  const montantCSGNDetCRDS = lignesSalariales.find(l => l.label === 'CSG/CRDS non déductibles').montant;
  const montantRetraiteChomSante = lignesSalariales
    .filter(l => l.label !== 'CSG déductible' && l.label !== 'CSG/CRDS non déductibles')
    .reduce((s, l) => s + l.montant, 0);

  const lignesPatronales = cotisPatronalesLignes(entity).map(l => ({ label: l.label, assiette: brut, taux: l.taux, montant: brut * l.taux }));
  const cotisPatronales = lignesPatronales.reduce((s, l) => s + l.montant, 0);

  const netAvantImpot = brut - cotisSalariales;
  const netSocial = brut - montantRetraiteChomSante;
  const netImposable = netAvantImpot + montantCSGNDetCRDS;
  const montantPAS = netAvantImpot * tauxPAS;
  const netPaye = netAvantImpot - montantPAS;
  const coutTotal = brut + cotisPatronales;

  return {
    heures, salaireBase, heuresSupp, primeAnciennete, prime13e, avantageNature, commission,
    congesJours, tauxJournalier, congesDeduction, congesIndemnite,
    brut, lignesSalariales, cotisSalariales, lignesPatronales, cotisPatronales,
    netSocial, netImposable, netAvantImpot, tauxPAS, montantPAS, netPaye, net: netPaye,
    coutTotal,
  };
}

function employeeOut(e) {
  return {
    id: e.id, entityId: e.entity_id, name: e.name, role: e.role, contract: e.contract,
    gross: e.gross, start: e.start_date, matricule: e.matricule, address: e.address,
    numeroSecu: e.numero_secu, statutProfessionnel: e.statut_professionnel, groupe: e.groupe, niveau: e.niveau,
    tauxPAS: e.taux_pas, congesAcquis: e.conges_acquis, congesPris: e.conges_pris,
    congesN1Acquis: e.conges_n1_acquis, congesN1Pris: e.conges_n1_pris,
  };
}
function payslipOut(p) {
  return {
    id: p.id, employeeId: p.employee_id, period: p.period, status: p.status,
    heures: p.heures, salaireBase: p.salaire_base, heuresSupp: p.heures_supp,
    primeAnciennete: p.prime_anciennete, prime13e: p.prime13e, avantageNature: p.avantage_nature,
    commission: p.commission, congesJours: p.conges_jours, tauxJournalier: p.taux_journalier,
    congesDeduction: p.conges_deduction, congesIndemnite: p.conges_indemnite,
    brut: p.brut, lignesSalariales: p.lignes_salariales, cotisSalariales: p.cotis_salariales,
    lignesPatronales: p.lignes_patronales, cotisPatronales: p.cotis_patronales,
    netSocial: p.net_social, netImposable: p.net_imposable, netAvantImpot: p.net_avant_impot,
    tauxPAS: p.taux_pas, montantPAS: p.montant_pas, netPaye: p.net_paye, net: p.net_paye, coutTotal: p.cout_total,
    conges: { acquis: p.conges_acquis_snapshot, pris: p.conges_pris_snapshot, restants: p.conges_restants_snapshot },
  };
}

/* ---------------- Salariés ---------------- */
router.get('/employees', requireAuth, scopeEntity, async (req, res) => {
  if (req.user.role === 'employe') {
    const rows = await db.all('SELECT * FROM employees WHERE id = $1', [req.user.employeeId]);
    return res.json(rows.map(employeeOut));
  }
  if (!canSeeRoster(req)) return res.status(403).json({ error: 'Accès non autorisé' });
  const rows = req.entityScope
    ? await db.all('SELECT * FROM employees WHERE entity_id = $1', [req.entityScope])
    : await db.all('SELECT * FROM employees');
  res.json(rows.map(employeeOut));
});

router.post('/employees', requireAuth, async (req, res) => {
  const { entityId, name, role, contract, gross, matricule, address, numeroSecu, statutProfessionnel, groupe, niveau, tauxPAS } = req.body;
  if (!canEditEntity(req, entityId)) return res.status(403).json({ error: 'Accès non autorisé' });
  if (!entityId || !name || !gross) return res.status(400).json({ error: 'Champs manquants' });
  const id = 'e' + Date.now();
  await db.run(
    `INSERT INTO employees (id,entity_id,name,role,contract,gross,start_date,matricule,address,numero_secu,statut_professionnel,groupe,niveau,taux_pas,conges_acquis,conges_pris,conges_n1_acquis,conges_n1_pris)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,0,0,0,0)`,
    [id, entityId, name, role || 'Salarié', contract || 'CDI', gross, new Date().toISOString().slice(0, 10),
      matricule || null, address || null, numeroSecu || null, statutProfessionnel || null, groupe || null, niveau || null, tauxPAS || 0]
  );
  res.status(201).json({ id });
});

router.patch('/employees/:id', requireAuth, async (req, res) => {
  const emp = await db.get('SELECT * FROM employees WHERE id = $1', [req.params.id]);
  if (!emp) return res.status(404).json({ error: 'Salarié introuvable' });
  if (!canEditEntity(req, emp.entity_id)) return res.status(403).json({ error: 'Accès non autorisé' });
  const { entityId, name, role, contract, gross, matricule, address, numeroSecu, statutProfessionnel, groupe, niveau, tauxPAS } = req.body;
  const newEntity = entityId || emp.entity_id;
  if (!canEditEntity(req, newEntity)) return res.status(403).json({ error: 'Accès non autorisé' });
  await db.run(
    `UPDATE employees SET entity_id=$1, name=$2, role=$3, contract=$4, gross=$5, matricule=$6, address=$7,
     numero_secu=$8, statut_professionnel=$9, groupe=$10, niveau=$11, taux_pas=$12 WHERE id=$13`,
    [newEntity, name || emp.name, role || emp.role, contract || emp.contract, gross !== undefined ? gross : emp.gross,
      matricule !== undefined ? matricule : emp.matricule, address !== undefined ? address : emp.address,
      numeroSecu !== undefined ? numeroSecu : emp.numero_secu, statutProfessionnel !== undefined ? statutProfessionnel : emp.statut_professionnel,
      groupe !== undefined ? groupe : emp.groupe, niveau !== undefined ? niveau : emp.niveau,
      tauxPAS !== undefined ? tauxPAS : emp.taux_pas, req.params.id]
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

/* ---------------- Fiches de paie ---------------- */
router.get('/payslips', requireAuth, async (req, res) => {
  let rows;
  if (req.user.role === 'directeur') {
    rows = await db.all('SELECT * FROM payslips ORDER BY period DESC');
  } else {
    rows = await db.all('SELECT * FROM payslips WHERE employee_id = $1 ORDER BY period DESC', [req.user.employeeId]);
  }
  res.json(rows.map(payslipOut));
});

router.post('/payslips', requireAuth, requireModule('salaires'), async (req, res) => {
  const { employeeId, period, heures, heuresSupp, primeAnciennete, prime13e, avantageNature, commission, congesJours } = req.body;
  const employee = await db.get('SELECT * FROM employees WHERE id = $1', [employeeId]);
  if (!employee || !period) return res.status(400).json({ error: 'Salarié ou période invalide' });
  const entity = await db.get('SELECT * FROM entities WHERE id = $1', [employee.entity_id]);

  const calc = computePayslip(employee.gross, {
    heures, heuresSupp, primeAnciennete, prime13e, avantageNature, commission, congesJours,
    entity, tauxPAS: employee.taux_pas || 0,
  });

  const newCongesAcquis = Number(employee.conges_acquis || 0) + 2.5;
  const newCongesPris = Number(employee.conges_pris || 0) + Number(congesJours || 0);
  await db.run('UPDATE employees SET conges_acquis=$1, conges_pris=$2 WHERE id=$3', [newCongesAcquis, newCongesPris, employeeId]);

  const id = 'p' + Date.now();
  await db.run(
    `INSERT INTO payslips (
      id, employee_id, period, heures, salaire_base, heures_supp, prime_anciennete, prime13e, avantage_nature, commission,
      conges_jours, taux_journalier, conges_deduction, conges_indemnite, brut, lignes_salariales, cotis_salariales,
      lignes_patronales, cotis_patronales, net_social, net_imposable, net_avant_impot, taux_pas, montant_pas, net_paye,
      cout_total, conges_acquis_snapshot, conges_pris_snapshot, conges_restants_snapshot, status
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,'générée')`,
    [id, employeeId, period, calc.heures, calc.salaireBase, calc.heuresSupp, calc.primeAnciennete, calc.prime13e, calc.avantageNature, calc.commission,
      calc.congesJours, calc.tauxJournalier, calc.congesDeduction, calc.congesIndemnite, calc.brut,
      JSON.stringify(calc.lignesSalariales), calc.cotisSalariales, JSON.stringify(calc.lignesPatronales), calc.cotisPatronales,
      calc.netSocial, calc.netImposable, calc.netAvantImpot, calc.tauxPAS, calc.montantPAS, calc.netPaye, calc.coutTotal,
      newCongesAcquis, newCongesPris, newCongesAcquis - newCongesPris]
  );

  // Génère automatiquement la dépense correspondante dans la trésorerie de l'entité
  const [y, m] = period.split('-').map(Number);
  const payDate = new Date(y, m, 0).toISOString().slice(0, 10);
  const txId = 't' + Date.now();
  await db.run(
    'INSERT INTO transactions (id,entity_id,date,label,category,amount,type,created_by,payslip_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [txId, employee.entity_id, payDate, `Bulletin de salaire — ${employee.role} (${period})`, 'Salaires', -calc.netPaye, 'debit', req.user.id, id]
  );

  // Notification simulée/réelle au salarié concerné (s'il a un compte lié)
  const empAccount = await db.get('SELECT * FROM users WHERE employee_id = $1 AND active = 1', [employeeId]);
  let notification = { sent: false };
  if (empAccount && empAccount.email) {
    try {
      notification = await sendPayslipNotification({ toEmails: [empAccount.email], employeeName: employee.name, period, net: calc.netPaye });
    } catch (e) {
      console.error('Erreur envoi notification paie :', e.message);
    }
  }

  const saved = await db.get('SELECT * FROM payslips WHERE id = $1', [id]);
  res.status(201).json({ ...payslipOut(saved), notification });
});

router.delete('/payslips/:id', requireAuth, requireModule('salaires'), async (req, res) => {
  if (req.user.role !== 'directeur') return res.status(403).json({ error: 'Réservé aux directeurs' });
  const p = await db.get('SELECT * FROM payslips WHERE id = $1', [req.params.id]);
  if (!p) return res.status(404).json({ error: 'Fiche introuvable' });
  const emp = await db.get('SELECT * FROM employees WHERE id = $1', [p.employee_id]);
  if (emp) {
    await db.run('UPDATE employees SET conges_acquis = GREATEST(0, conges_acquis - 2.5), conges_pris = GREATEST(0, conges_pris - $1) WHERE id = $2',
      [p.conges_jours || 0, emp.id]);
  }
  await db.run('DELETE FROM transactions WHERE payslip_id = $1', [req.params.id]);
  await db.run('DELETE FROM payslips WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
