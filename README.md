# CSR Finance — Backend

Backend réel (Node.js + Express + **PostgreSQL**) pour l'application de gestion financière du groupe CSR : trésorerie multi-filiales, dépenses/cartes, facturation, salaires & paie (simulation), budget prévisionnel, stocks et produits — avec authentification sécurisée, permissions par rôle (directeur / responsable / employé), et données **partagées entre tous les utilisateurs** (contrairement au prototype local, chaque personne voit et modifie les mêmes données).

## 1. Créer la base de données (gratuit, ~2 minutes)

Ce backend a besoin d'une base Postgres accessible en ligne. Recommandé : **Neon** (gratuit, sans limite de durée, sans carte bancaire).

1. Va sur **neon.tech** → « Sign up » (avec Google ou GitHub, le plus rapide)
2. Un projet est créé automatiquement — reste sur le tableau de bord
3. Copie la **chaîne de connexion** affichée (« Connection string »), qui ressemble à :
   `postgres://utilisateur:motdepasse@ep-xxxx.aws.neon.tech/neondb?sslmode=require`

Garde cette adresse de côté, elle sert de valeur pour `DATABASE_URL` à l'étape 3.

## 2. Installer et lancer en local (optionnel, pour tester avant de déployer)

```bash
npm install
cp .env.example .env
```

Ouvre `.env` et renseigne :
- `JWT_SECRET` : une longue chaîne aléatoire (ex. générée avec `openssl rand -hex 32`)
- `DATABASE_URL` : la chaîne de connexion Neon obtenue à l'étape 1

**Ne jamais partager ces valeurs ni les commiter sur GitHub.**

```bash
npm start
```

Le serveur écoute sur `http://localhost:4000`. Le schéma et les comptes de démonstration sont créés automatiquement dans la base Postgres au premier démarrage.

## 3. Comptes de démonstration

| Utilisateur | Identifiant (userId) | Mot de passe | Rôle |
|---|---|---|---|
| Yanis Chojnacki | `u1` | `CSRgroup2026!` | directeur |
| Solenne Saint-Rose | `u2` | `CSRgroup2026!` | directeur |
| Responsable boutique (Pwa Dou) | `u3` | `PwaDou2026!` | responsable |
| Responsable atelier (Koszmar) | `u4` | `Koszmar2026!` | responsable |
| Technicien formulation (Manufacture) | `u5` | `Manuf2026!` | employé |
| Chef d'équipe sécurité | `u6` | `Secu2026!` | responsable |
| Technicien sûreté | `u7` | `Surete2026!` | employé |

**À faire avant toute mise en production réelle : changer tous ces mots de passe** (via `POST /api/accounts` pour en créer de nouveaux, puis désactiver les anciens).

## 4. Déployer en ligne sur Render

1. Dépose ce dossier sur un dépôt GitHub (voir le guide fourni séparément si besoin)
2. Sur **render.com** → « New + » → « Web Service » → sélectionne le dépôt
3. Render détecte Node.js automatiquement (Build command : `npm install`, Start command : `npm start`)
4. Dans « Environment Variables », ajoute :
   - `JWT_SECRET` : ta longue chaîne aléatoire
   - `DATABASE_URL` : la chaîne de connexion Neon de l'étape 1
5. « Create Web Service » — le déploiement prend 2-3 minutes

Aucun disque persistant n'est nécessaire côté Render : toutes les données vivent dans Neon, pas sur le serveur lui-même. Le service peut donc rester sur le plan gratuit de Render sans risque de perte de données.

## 5. Aperçu de l'API

Toutes les routes (sauf `/api/auth/login` et `/api/auth/accounts`) exigent un header `Authorization: Bearer <token>` obtenu après connexion.

- `POST /api/auth/login` — `{ userId, password }` → `{ token, user }`
- `GET /api/entities` — liste des entités (filtrée automatiquement selon le rôle)
- `GET/POST /api/transactions`, `POST /api/transactions/transfer` (virement interne, réservé directeur)
- `GET/POST /api/cards`, `PATCH /api/cards/:id/toggle`
- `GET/POST /api/invoices`, `PATCH /api/invoices/:id/status`
- `GET/POST /api/payroll/employees`, `GET/POST /api/payroll/payslips`
- `GET/POST /api/budget`
- `GET/POST /api/catalog/products`, `GET/POST /api/catalog/stock`, `PATCH /api/catalog/stock/:id/adjust`
- `GET/POST /api/accounts`, `DELETE /api/accounts/:id` (réservé directeur — gestion des accès)
- `GET/POST /api/leaves`, `PATCH /api/leaves/:id/respond` (accepter/refuser), `PATCH /api/leaves/:id` (modification complète, directeur), `DELETE /api/leaves/:id` — congés et absences, avec **notification par e-mail automatique** au responsable de la filiale et à tous les directeurs à chaque nouvelle demande (voir section 6)

Chaque route applique automatiquement les permissions : un responsable ne peut agir que sur sa propre entité, un employé n'a accès qu'à ses propres fiches de paie.

## 6. Notifications e-mail (congés)

À chaque demande de congé, le responsable de la filiale concernée (s'il existe et si ce n'est pas le demandeur) et tous les directeurs (sauf si le demandeur en est un) reçoivent un e-mail automatique.

**Tant que rien n'est configuré**, l'e-mail n'est pas envoyé : il est simplement affiché dans les logs du serveur, pour que le fonctionnement reste visible et testable sans compte e-mail. Pour activer l'envoi réel, renseigner dans `.env` (ou dans les variables d'environnement Render) :

```
SMTP_HOST=smtp.gmail.com      # ou le serveur de ton fournisseur
SMTP_PORT=587
SMTP_USER=ton-compte@gmail.com
SMTP_PASS=mot-de-passe-application   # jamais le mot de passe du compte lui-même
EMAIL_FROM=CSR Finance <notifications@csrgroup.fr>
```

Options simples pour un premier envoi réel :
- **Gmail** : nécessite un « mot de passe d'application » (à générer dans les paramètres de sécurité Google, pas le mot de passe habituel).
- **Un service transactionnel** (Resend, SendGrid, Brevo/Sendinblue) : plus adapté à terme, avec de meilleurs taux de délivrabilité et un vrai nom de domaine d'envoi (ex. `notifications@csrgroup.fr`).

Chaque compte utilisateur a un champ `email` — à mettre à jour avec les vraies adresses avant toute mise en production (les adresses de démonstration `@csrgroup.fr` sont fictives).

## 7. Ce qu'il reste à faire

1. **Connecter le prototype** (l'écran qu'on a construit) à cette API réelle, à la place des données stockées localement — en cours.
2. **Remplacer la simulation de paie** par un connecteur vers un vrai logiciel (PayFit/Silae) avant tout usage réel — les taux de ce backend sont indicatifs et non conformes à la convention collective applicable.
3. **Volet RGPD** : politique de confidentialité, registre de traitement, puisque des données salariales et personnelles seront stockées.

## 8. Sécurité — ce qui est déjà fait

- Mots de passe jamais stockés en clair (hachage bcrypt)
- Sessions signées par jeton (JWT), expirant après 12h
- Contrôle des permissions **côté serveur** à chaque requête (pas seulement dans l'interface)
- Chaque rôle est restreint à son périmètre réel de données
- Base de données Postgres hébergée séparément du serveur applicatif : les données survivent aux redémarrages, mises à jour et redéploiements du service
