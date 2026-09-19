const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  throw new Error('JWT_SECRET manquant. Définissez-le dans le fichier .env avant de démarrer le serveur.');
}

const ROLE_VIEWS = {
  directeur: ['dashboard','tresorerie','depenses','facturation','employes','planning','salaires','budget','stock','produits','acces'],
  responsable: ['tresorerie','depenses','facturation','employes','planning','budget','stock','produits','monespace'],
  employe: ['monespace','planning'],
};

function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, name: user.name, role: user.role, entityId: user.entity_id, employeeId: user.employee_id },
    SECRET,
    { expiresIn: '12h' }
  );
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentification requise' });
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Session invalide ou expirée' });
  }
}

// Vérifie que le rôle de l'utilisateur a accès à cette ressource logique
function requireModule(moduleName) {
  return (req, res, next) => {
    const allowed = ROLE_VIEWS[req.user.role] || [];
    if (!allowed.includes(moduleName)) {
      return res.status(403).json({ error: 'Accès non autorisé pour votre rôle' });
    }
    next();
  };
}

// Restreint automatiquement une requête à l'entité de l'utilisateur, sauf pour les directeurs
function scopeEntity(req, res, next) {
  if (req.user.role === 'directeur') {
    req.entityScope = req.query.entityId || null; // null = toutes les entités
  } else {
    req.entityScope = req.user.entityId; // verrouillé sur sa propre entité
  }
  next();
}

module.exports = { signToken, requireAuth, requireModule, scopeEntity, ROLE_VIEWS };
