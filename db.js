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
      conges_n1_pris NUMERIC DEFAULT 0,
      contract_pdf_name TEXT,
      contract_pdf_data TEXT
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
      invoice_id TEXT,
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
      status TEXT DEFAULT 'en attente',
      attachment_name TEXT,
      attachment_data TEXT,
      items JSONB
    );

    CREATE TABLE IF NOT EXISTS quotes (
      id TEXT PRIMARY KEY,
      entity_id TEXT REFERENCES entities(id),
      number TEXT,
      client_name TEXT,
      client_address TEXT,
      date TEXT,
      valid_until TEXT,
      items JSONB,
      total NUMERIC,
      status TEXT DEFAULT 'brouillon' CHECK(status IN ('brouillon','envoyé','accepté','refusé')),
      attachment_name TEXT,
      attachment_data TEXT,
      converted_invoice_id TEXT,
      created_at TIMESTAMP DEFAULT NOW()
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

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const q = (sql, params) => client.query(sql, params);

    const entities = [
      ['csr-group', 'CSR Group', 'Holding (SAS)', 'FR76 3000 4028 3900 0102 4567 891', 1000,
        "12 Rue Ernest Deproge, 97200 Fort-de-France, Martinique", "820 123 456 00019", "7010Z", "972 201 456 00019", "Convention collective nationale des bureaux d'études techniques (Syntec)", 0.010],
      ['pwa-dou', 'Habitation Pwa Dou', 'Cosmétiques (SASU)', 'FR76 3000 4028 3900 0102 4567 892', 1000,
        "5 Rue Victor Hugo, 97200 Fort-de-France, Martinique", "820 123 456 00027", "4775Z", "972 201 456 00027", "Convention collective nationale du commerce de détail non alimentaire", 0.015],
      ['koszmar', 'Koszmar', 'Vêtements (SASU)', 'FR76 3000 4028 3900 0102 4567 893', 1000,
        "18 Rue Lamartine, 97200 Fort-de-France, Martinique", "820 123 456 00035", "1413Z", "972 201 456 00035", "Convention collective nationale des industries de l'habillement", 0.020],
      ['immobilier', 'CSR Immobilier', 'SCI', 'FR76 3000 4028 3900 0102 4567 894', 1000,
        "12 Rue Ernest Deproge, 97200 Fort-de-France, Martinique", "820 123 456 00043", "6820A", "972 201 456 00043", "Convention collective nationale de l'immobilier", 0.010],
      ['manufacture', 'Pwa Dou Manufacture', 'Fabrication cosmétique (SASU)', 'FR76 3000 4028 3900 0102 4567 895', 1000,
        "Zone Industrielle de la Lézarde, 97232 Le Lamentin, Martinique", "820 123 456 00050", "2042Z", "972 201 456 00050", "Convention collective nationale des industries chimiques", 0.028],
      ['securite', 'CSR Sécurité', 'Sécurité privée (SASU)', 'FR76 3000 4028 3900 0102 4567 896', 1000,
        "8 Rue Schoelcher, 97200 Fort-de-France, Martinique", "820 123 456 00068", "8010Z", "972 201 456 00068", "Convention collective nationale des entreprises de sécurité privée", 0.035],
      ['surete', 'CSR Sûreté', 'Sûreté électronique (SASU)', 'FR76 3000 4028 3900 0102 4567 897', 1000,
        "8 Rue Schoelcher, 97200 Fort-de-France, Martinique", "820 123 456 00076", "8020Z", "972 201 456 00076", "Convention collective nationale des entreprises de sécurité privée", 0.020],
    ];
    for (const e of entities) {
      await q('INSERT INTO entities (id,name,sub,iban,balance,address,siret,ape,urssaf,convention_collective,taux_atmp) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', e);
    }

    const employees = [
      ['e1', 'csr-group', 'Yanis Chojnacki', 'Président', 'Mandat social', 5500, '2026-01-01',
        'C1001', '113 Rue Raymond Garcin, Résidence Charmax, 97200 Fort-de-France', '1 85 01 75 123 456 78', 'Cadre dirigeant', '7', '3', 0.09],
      ['e2', 'csr-group', 'Solenne Saint-Rose', 'Directrice Générale', 'Mandat social', 5200, '2026-01-01',
        'C1002', '22 Rue Perrinon, 97200 Fort-de-France', '2 88 04 75 234 567 89', 'Cadre dirigeant', '7', '3', 0.085],
    ];
    for (const e of employees) {
      await q(
        `INSERT INTO employees (id,entity_id,name,role,contract,gross,start_date,matricule,address,numero_secu,statut_professionnel,groupe,niveau,taux_pas)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, e);
    }

    const hash = (pw) => bcrypt.hashSync(pw, 10);
    const users = [
      ['u1', 'y.chojnacki', 'Yanis Chojnacki', 'directeur', 'csr-group', 'e1', 'y.chojnacki@csrgroup.fr', hash('1234')],
      ['u2', 'solenne.saintrose', 'Solenne Saint-Rose', 'directeur', 'csr-group', 'e2', 'solenne.saintrose@csrgroup.fr', hash('5678')],
    ];
    for (const u of users) {
      await q('INSERT INTO users (id,username,name,role,entity_id,employee_id,email,password_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', u);
    }

    // Aucune donnée métier de démonstration : trésorerie, cartes, factures, budget, produits
    // et stocks démarrent vides. Seul le capital social (solde des entités) est renseigné.

    await client.query('COMMIT');
    console.log('Base initialisée avec les données de démarrage.');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Échec du seed, tout a été annulé (aucune donnée partielle laissée) :', e.message);
    throw e;
  } finally {
    client.release();
  }
}

// ---------------- MIGRATIONS (ajouts de colonnes sur une base déjà existante) ----------------
async function runMigrations() {
  await pool.query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS invoice_id TEXT;`);
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS attachment_name TEXT;`);
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS attachment_data TEXT;`);
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS items JSONB;`);
  await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS contract_pdf_name TEXT;`);
  await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS contract_pdf_data TEXT;`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS quotes (
      id TEXT PRIMARY KEY,
      entity_id TEXT REFERENCES entities(id),
      number TEXT,
      client_name TEXT,
      client_address TEXT,
      date TEXT,
      valid_until TEXT,
      items JSONB,
      total NUMERIC,
      status TEXT DEFAULT 'brouillon' CHECK(status IN ('brouillon','envoyé','accepté','refusé')),
      attachment_name TEXT,
      attachment_data TEXT,
      converted_invoice_id TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
}

async function initDb() {
  await createSchema();
  await runMigrations();
  await seedIfEmpty();
}

module.exports = { pool, get, all, run, withTransaction, initDb };
