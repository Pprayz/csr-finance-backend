const { Pool, types } = require('pg');
const bcrypt = require('bcryptjs');

// Les colonnes NUMERIC de Postgres reviennent en chaîne de caractères par défaut ;
// on les force en nombre JS pour que les calculs du frontend fonctionnent normalement.
types.setTypeParser(1700, (val) => (val === null ? null : parseFloat(val)));

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL manquant. Définissez-le dans le fichier .env avant de démarrer le serveur.');
}

const isLocal = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false }, // requis par la plupart des hébergeurs Postgres gratuits (Neon, Supabase...)
});

async function get(sql, params = []) {
  const res = await pool.query(sql, params);
  return res.rows[0] || null;
}
async function all(sql, params = []) {
  const res = await pool.query(sql, params);
  return res.rows;
}
async function run(sql, params = []) {
  return pool.query(sql, params);
}

// Exécute une fonction dans une transaction Postgres (BEGIN/COMMIT/ROLLBACK automatiques)
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const runOnClient = (sql, params = []) => client.query(sql, params);
    await fn(runOnClient);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ---------------- SCHEMA ----------------
async function createSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      sub TEXT,
      iban TEXT,
      balance NUMERIC DEFAULT 0,
      address TEXT,
      siret TEXT,
      ape TEXT,
      urssaf TEXT,
      convention_collective TEXT,
      taux_atmp NUMERIC DEFAULT 0.02
    );

    CREATE TABLE IF NOT EXISTS employees (
      id TEXT PRIMARY KEY,
      entity_id TEXT REFERENCES entities(id),
      name TEXT NOT NULL,
      role TEXT,
      contract TEXT,
      gross NUMERIC,
      start_date TEXT,
      matricule TEXT,
      address TEXT,
      numero_secu TEXT,
      statut_professionnel TEXT,
      groupe TEXT,
      niveau TEXT,
      taux_pas NUMERIC DEFAULT 0,
      conges_acquis NUMERIC DEFAULT 0,
      conges_pris NUMERIC DEFAULT 0,
      conges_n1_acquis NUMERIC DEFAULT 0,
      conges_n1_pris NUMERIC DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('directeur','responsable','employe')),
      entity_id TEXT REFERENCES entities(id),
      employee_id TEXT REFERENCES employees(id),
      email TEXT,
      password_hash TEXT NOT NULL,
      active INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      entity_id TEXT REFERENCES entities(id),
      date TEXT NOT NULL,
      label TEXT NOT NULL,
      category TEXT,
      amount NUMERIC NOT NULL,
      type TEXT CHECK(type IN ('credit','debit')),
      created_by TEXT REFERENCES users(id),
      payslip_id TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY,
      entity_id TEXT REFERENCES entities(id),
      holder TEXT NOT NULL,
      last4 TEXT,
      status TEXT DEFAULT 'active',
      limit_amount NUMERIC,
      spent NUMERIC DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY,
      entity_id TEXT REFERENCES entities(id),
      kind TEXT CHECK(kind IN ('client','fournisseur')),
      number TEXT,
      counterparty TEXT,
      amount NUMERIC,
      due TEXT,
      status TEXT DEFAULT 'en attente'
    );

    CREATE TABLE IF NOT EXISTS payslips (
      id TEXT PRIMARY KEY,
      employee_id TEXT REFERENCES employees(id),
      period TEXT NOT NULL,
      heures NUMERIC,
      salaire_base NUMERIC,
      heures_supp NUMERIC DEFAULT 0,
      prime_anciennete NUMERIC DEFAULT 0,
      prime13e NUMERIC DEFAULT 0,
      avantage_nature NUMERIC DEFAULT 0,
      commission NUMERIC DEFAULT 0,
      conges_jours NUMERIC DEFAULT 0,
      taux_journalier NUMERIC,
      conges_deduction NUMERIC DEFAULT 0,
      conges_indemnite NUMERIC DEFAULT 0,
      brut NUMERIC,
      lignes_salariales JSONB,
      cotis_salariales NUMERIC,
      lignes_patronales JSONB,
      cotis_patronales NUMERIC,
      net_social NUMERIC,
      net_imposable NUMERIC,
      net_avant_impot NUMERIC,
      taux_pas NUMERIC DEFAULT 0,
      montant_pas NUMERIC DEFAULT 0,
      net_paye NUMERIC,
      cout_total NUMERIC,
      conges_acquis_snapshot NUMERIC,
      conges_pris_snapshot NUMERIC,
      conges_restants_snapshot NUMERIC,
      status TEXT DEFAULT 'générée',
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS budget (
      id TEXT PRIMARY KEY,
      entity_id TEXT REFERENCES entities(id),
      month TEXT,
      category TEXT,
      budget_amount NUMERIC,
      actual_amount NUMERIC DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      entity_id TEXT REFERENCES entities(id),
      name TEXT NOT NULL,
      sku TEXT,
      category TEXT,
      price NUMERIC DEFAULT 0,
      cost NUMERIC DEFAULT 0,
      active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS stock (
      id TEXT PRIMARY KEY,
      entity_id TEXT REFERENCES entities(id),
      product_id TEXT REFERENCES products(id),
      qty NUMERIC DEFAULT 0,
      threshold NUMERIC DEFAULT 0,
      unit TEXT DEFAULT 'unités'
    );

    CREATE TABLE IF NOT EXISTS leaves (
      id TEXT PRIMARY KEY,
      employee_id TEXT REFERENCES employees(id),
      type TEXT,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      status TEXT DEFAULT 'en attente' CHECK(status IN ('en attente','approuvé','refusé')),
      comment TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
}

// ---------------- SEED (uniquement si la base est vide) ----------------
async function seedIfEmpty() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM entities');
  if (rows[0].c > 0) return;

  const entities = [
    ['csr-group', 'CSR Group', 'Holding (SAS)', 'FR76 3000 4028 3900 0102 4567 891', 284500,
      "12 Rue Ernest Deproge, 97200 Fort-de-France, Martinique", "820 123 456 00019", "7010Z", "972 201 456 00019", "Convention collective nationale des bureaux d'études techniques (Syntec)", 0.010],
    ['pwa-dou', 'Habitation Pwa Dou', 'Cosmétiques (SASU)', 'FR76 3000 4028 3900 0102 4567 892', 62300,
      "5 Rue Victor Hugo, 97200 Fort-de-France, Martinique", "820 123 456 00027", "4775Z", "972 201 456 00027", "Convention collective nationale du commerce de détail non alimentaire", 0.015],
    ['koszmar', 'Koszmar', 'Vêtements (SASU)', 'FR76 3000 4028 3900 0102 4567 893', 41800,
      "18 Rue Lamartine, 97200 Fort-de-France, Martinique", "820 123 456 00035", "1413Z", "972 201 456 00035", "Convention collective nationale des industries de l'habillement", 0.020],
    ['immobilier', 'CSR Immobilier', 'SCI', 'FR76 3000 4028 3900 0102 4567 894', 118200,
      "12 Rue Ernest Deproge, 97200 Fort-de-France, Martinique", "820 123 456 00043", "6820A", "972 201 456 00043", "Convention collective nationale de l'immobilier", 0.010],
    ['manufacture', 'Pwa Dou Manufacture', 'Fabrication cosmétique (SASU)', 'FR76 3000 4028 3900 0102 4567 895', 37650,
      "Zone Industrielle de la Lézarde, 97232 Le Lamentin, Martinique", "820 123 456 00050", "2042Z", "972 201 456 00050", "Convention collective nationale des industries chimiques", 0.028],
    ['securite', 'CSR Sécurité', 'Sécurité privée (SASU)', 'FR76 3000 4028 3900 0102 4567 896', 24900,
      "8 Rue Schoelcher, 97200 Fort-de-France, Martinique", "820 123 456 00068", "8010Z", "972 201 456 00068", "Convention collective nationale des entreprises de sécurité privée", 0.035],
    ['surete', 'CSR Sûreté', 'Sûreté électronique (SASU)', 'FR76 3000 4028 3900 0102 4567 897', 19300,
      "8 Rue Schoelcher, 97200 Fort-de-France, Martinique", "820 123 456 00076", "8020Z", "972 201 456 00076", "Convention collective nationale des entreprises de sécurité privée", 0.020],
  ];
  for (const e of entities) {
    await pool.query('INSERT INTO entities (id,name,sub,iban,balance,address,siret,ape,urssaf,convention_collective,taux_atmp) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', e);
  }

  const employees = [
    ['e1', 'csr-group', 'Yanis Chojnacki', 'Président', 'Mandat social', 5500, '2026-01-01',
      'C1001', '113 Rue Raymond Garcin, Résidence Charmax, 97200 Fort-de-France', '1 85 01 75 123 456 78', 'Cadre dirigeant', '7', '3', 0.09],
    ['e2', 'csr-group', 'Solenne Saint-Rose', 'Directrice Générale', 'Mandat social', 5200, '2026-01-01',
      'C1002', '22 Rue Perrinon, 97200 Fort-de-France', '2 88 04 75 234 567 89', 'Cadre dirigeant', '7', '3', 0.085],
    ['e3', 'pwa-dou', 'Responsable boutique', 'Responsable de vente', 'CDI', 2100, '2026-02-01',
      'C1003', '14 Rue François Arago, 97200 Fort-de-France', '2 92 09 97 345 678 91', 'Agent de maîtrise', '3', '2', 0.02],
    ['e4', 'koszmar', 'Responsable atelier', 'Responsable production', 'CDI', 2300, '2026-02-01',
      'C1004', '7 Rue Moreau de Jonnès, 97200 Fort-de-France', '1 90 06 97 456 789 12', 'Agent de maîtrise', '3', '2', 0.025],
    ['e5', 'manufacture', 'Technicien formulation', 'Chargé de fabrication', 'CDI', 2450, '2026-03-01',
      'C1005', 'Lotissement Dillon, 97200 Fort-de-France', '1 94 11 97 567 891 23', 'Employé', '4', '1', 0.03],
    ['e6', 'securite', "Chef d'équipe sécurité", 'Agent de sécurité', 'CDI', 2050, '2026-04-01',
      'C1006', '9 Rue Garnier Pagès, 97200 Fort-de-France', '1 88 02 97 678 912 34', 'Employé', '2', '1', 0.015],
    ['e7', 'surete', 'Technicien sûreté', 'Installateur électronique', 'CDI', 2200, '2026-04-01',
      'C1007', '3 Rue Blénac, 97200 Fort-de-France', '1 91 07 97 789 123 45', 'Employé', '3', '1', 0.02],
  ];
  for (const e of employees) {
    await pool.query(
      `INSERT INTO employees (id,entity_id,name,role,contract,gross,start_date,matricule,address,numero_secu,statut_professionnel,groupe,niveau,taux_pas)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, e);
  }

  const hash = (pw) => bcrypt.hashSync(pw, 10);
  const users = [
    ['u1', 'y.chojnacki', 'Yanis Chojnacki', 'directeur', 'csr-group', 'e1', 'y.chojnacki@csrgroup.fr', hash('1234')],
    ['u2', 'solenne.saintrose', 'Solenne Saint-Rose', 'directeur', 'csr-group', 'e2', 'solenne.saintrose@csrgroup.fr', hash('5678')],
    ['u3', 'responsable.pwadou', 'Responsable boutique', 'responsable', 'pwa-dou', 'e3', 'responsable.pwadou@csrgroup.fr', hash('1111')],
    ['u4', 'responsable.koszmar', 'Responsable atelier', 'responsable', 'koszmar', 'e4', 'responsable.koszmar@csrgroup.fr', hash('2222')],
    ['u5', 'technicien.manufacture', 'Technicien formulation', 'employe', 'manufacture', 'e5', 'technicien.manufacture@csrgroup.fr', hash('3333')],
    ['u6', 'chef.securite', "Chef d'équipe sécurité", 'responsable', 'securite', 'e6', 'chef.securite@csrgroup.fr', hash('4444')],
    ['u7', 'technicien.surete', 'Technicien sûreté', 'employe', 'surete', 'e7', 'technicien.surete@csrgroup.fr', hash('5555')],
  ];
  for (const u of users) {
    await pool.query('INSERT INTO users (id,username,name,role,entity_id,employee_id,email,password_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', u);
  }

  const tx = [
    ['t1', 'csr-group', '2026-07-14', 'Management fees — Pwa Dou', 'Facturation interne', 8500, 'credit'],
    ['t2', 'csr-group', '2026-07-10', 'Honoraires expert-comptable', 'Services pro', -1800, 'debit'],
    ['t3', 'pwa-dou', '2026-07-13', 'Client — Boutique Cocoa', 'Vente', 3200, 'credit'],
    ['t4', 'pwa-dou', '2026-07-11', 'Façonnage Pwa Dou Manufacture', 'Fournisseurs', -4100, 'debit'],
    ['t5', 'koszmar', '2026-07-12', 'Loyer atelier', 'Loyer', -1450, 'debit'],
    ['t6', 'koszmar', '2026-07-08', 'Vente en ligne — juillet', 'Vente', 5300, 'credit'],
    ['t7', 'immobilier', '2026-07-05', 'Loyer — CSR Group (siège)', 'Loyer perçu', 2600, 'credit'],
    ['t8', 'manufacture', '2026-07-09', 'Matières premières — fournisseur BIO', 'Approvisionnement', -6200, 'debit'],
    ['t9', 'securite', '2026-07-07', 'Contrat surveillance — Client SODEXO Antilles', 'Vente', 4800, 'credit'],
    ['t10', 'surete', '2026-07-06', 'Installation alarme — Client Résidence Anse', 'Vente', 2950, 'credit'],
  ];
  for (const t of tx) {
    await pool.query('INSERT INTO transactions (id,entity_id,date,label,category,amount,type) VALUES ($1,$2,$3,$4,$5,$6,$7)', t);
  }

  const cards = [
    ['c1', 'csr-group', 'Y. Chojnacki', '4821', 'active', 5000, 2100],
    ['c2', 'csr-group', 'S. Saint-Rose', '4822', 'active', 3000, 800],
    ['c3', 'pwa-dou', 'Responsable boutique', '7734', 'active', 1500, 1120],
  ];
  for (const c of cards) {
    await pool.query('INSERT INTO cards (id,entity_id,holder,last4,status,limit_amount,spent) VALUES ($1,$2,$3,$4,$5,$6,$7)', c);
  }

  const invoices = [
    ['i1', 'pwa-dou', 'client', 'FA-2026-014', 'Boutique Cocoa', 3200, '2026-07-25', 'payée'],
    ['i2', 'koszmar', 'client', 'FA-2026-021', 'Concept Store Marina', 2100, '2026-07-30', 'en attente'],
    ['i3', 'manufacture', 'fournisseur', 'FF-2026-009', 'BIO Ingrédients Caraïbes', 6200, '2026-07-20', 'en attente'],
  ];
  for (const i of invoices) {
    await pool.query('INSERT INTO invoices (id,entity_id,kind,number,counterparty,amount,due,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', i);
  }

  const products = [
    ['pr1', 'pwa-dou', 'Huile Mas Bwa N°09', 'PWD-MB09', 'Soin corps', 24.9, 9.2],
    ['pr2', 'koszmar', 'Chemise lin homme', 'KZ-CH-L', 'Homme', 59, 22],
  ];
  for (const p of products) {
    await pool.query('INSERT INTO products (id,entity_id,name,sku,category,price,cost,active) VALUES ($1,$2,$3,$4,$5,$6,$7,1)', p);
  }

  const stock = [
    ['s1', 'pwa-dou', 'pr1', 142, 50, 'unités'],
    ['s2', 'koszmar', 'pr2', 64, 20, 'unités'],
  ];
  for (const s of stock) {
    await pool.query('INSERT INTO stock (id,entity_id,product_id,qty,threshold,unit) VALUES ($1,$2,$3,$4,$5,$6)', s);
  }

  console.log('Base initialisée avec les données de démarrage.');
}

async function initDb() {
  await createSchema();
  await seedIfEmpty();
}

module.exports = { pool, get, all, run, withTransaction, initDb };
