require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const { initDb } = require('./db');

const authRoutes = require('./routes/auth');
const entityRoutes = require('./routes/entities');
const transactionRoutes = require('./routes/transactions');
const cardRoutes = require('./routes/cards');
const invoiceRoutes = require('./routes/invoices');
const quoteRoutes = require('./routes/quotes');
const payrollRoutes = require('./routes/payroll');
const budgetRoutes = require('./routes/budget');
const catalogRoutes = require('./routes/catalog');
const accountRoutes = require('./routes/accounts');
const leaveRoutes = require('./routes/leaves');

const app = express();
app.use(cors());
app.use(express.json({ limit: '12mb' })); // marge pour les factures PDF jointes (encodées en base64)

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.use('/api/auth', authRoutes);
app.use('/api/entities', entityRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/cards', cardRoutes);
app.use('/api/invoices', invoiceRoutes);
app.use('/api/quotes', quoteRoutes);
app.use('/api/payroll', payrollRoutes);
app.use('/api/budget', budgetRoutes);
app.use('/api/catalog', catalogRoutes);
app.use('/api/accounts', accountRoutes);
app.use('/api/leaves', leaveRoutes);

// Sert le frontend une fois construit (voir README)
app.use(express.static(path.join(__dirname, 'public')));

// Gestionnaire d'erreurs global : toute erreur async non interceptée renvoie un 500 propre au lieu de planter le serveur
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Erreur serveur' });
});

const PORT = process.env.PORT || 4000;

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`CSR Finance API en écoute sur http://localhost:${PORT}`));
  })
  .catch((e) => {
    console.error('Échec de l\'initialisation de la base de données :', e.message);
    process.exit(1);
  });
