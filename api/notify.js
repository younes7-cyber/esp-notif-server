const admin = require('firebase-admin');

// ─── Init Firebase Admin ───────────────────────────────────────────────────────
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)
    ),
    databaseURL: process.env.FB_DB_URL,
  });
}

const db = admin.database();

const FRIGO_ID   = 'TBNp1Y68mMV9nODEw6Kj';
const BASE_PATH  = `frigo/${FRIGO_ID}`;
const ZONES      = ['zone1', 'zone2', 'zone3', 'pirimi'];
const ALERT_ZONES = ['zone1', 'zone2']; // zones surveillées pour le déplacement vers zone3

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Enregistre une alerte dans Realtime Database */
async function saveAlert({ name, context, time, priority }) {
  const alertRef = db.ref(`${BASE_PATH}/alerts`).push();
  await alertRef.set({
    name,
    context,
    time,
    priority,
    isRead: false,
    createdAt: Date.now(),
  });
  return alertRef.key;
}

/** Envoie une notification FCM sur le topic 'alerts' */
async function sendFCM({ name, context, time, priority }) {
  const msg = {
    notification: {
      title: `${name}`,
      body: `${context} | ${time}`,
    },
    data: { name, context, time, priority: String(priority) },
    topic: 'alerts',
  };
  return admin.messaging().send(msg);
}

/**
 * Lit le champ __expired__ (timestamp ms) d'un produit.
 * Retourne le timestamp numérique, ou null si absent/invalide.
 */
function getExpiredTs(product) {
  const ts = product['__expired__'];
  if (ts == null || isNaN(Number(ts))) return null;
  return Number(ts);
}

/** Formate un timestamp ms en date lisible (DD/MM/YYYY) */
function formatDate(ts) {
  return new Date(ts).toLocaleDateString('fr-FR');
}

/** Retourne true si l'expiration est dans <= 1 mois ET pas encore passée */
function expiresWithinOneMonth(product) {
  const ts = getExpiredTs(product);
  if (ts === null) return false;
  const now = Date.now();
  const oneMonthLater = new Date();
  oneMonthLater.setMonth(oneMonthLater.getMonth() + 1);
  return ts > now && ts <= oneMonthLater.getTime();
}

/** Retourne true si le produit est déjà expiré */
function isExpired(product) {
  const ts = getExpiredTs(product);
  if (ts === null) return false;
  return ts <= Date.now();
}

// ─── Tâche 1 : zone1/zone2 → déplacer vers zone3 si expiration <= 1 mois ──────
async function checkAndMoveToZone3() {
  for (const zone of ALERT_ZONES) {
    const zoneRef = db.ref(`${BASE_PATH}/${zone}`);
    const snapshot = await zoneRef.once('value');
    if (!snapshot.exists()) continue;

    const products = snapshot.val();

    for (const [key, product] of Object.entries(products)) {
      if (expiresWithinOneMonth(product)) {
        // Copier dans zone3
        await db.ref(`${BASE_PATH}/zone3/${key}`).set(product);

        // Supprimer de l'ancienne zone
        await db.ref(`${BASE_PATH}/${zone}/${key}`).remove();

        const time = new Date().toISOString();
        const expTs = getExpiredTs(product);
        const alertData = {
          name: `Produit bientôt expiré déplacé en Zone 3`,
          context: `"${product.name || key}" déplacé de ${zone} vers zone3 (expire le ${formatDate(expTs)})`,
          time,
          priority: 2,
        };

        await saveAlert(alertData);
        await sendFCM(alertData);
      }
    }
  }
}

// ─── Tâche 2 : alerter si un produit est expiré dans zone1/zone2/zone3/pirimi ──
async function checkExpiredProducts() {
  for (const zone of ZONES) {
    const zoneRef = db.ref(`${BASE_PATH}/${zone}`);
    const snapshot = await zoneRef.once('value');
    if (!snapshot.exists()) continue;

    const products = snapshot.val();

    for (const [key, product] of Object.entries(products)) {
      if (isExpired(product)) {
        const time = new Date().toISOString();
        const expTs = getExpiredTs(product);
        const alertData = {
          name: `Produit expiré détecté`,
          context: `"${product.name || key}" dans ${zone} est expiré depuis le ${formatDate(expTs)}`,
          time,
          priority: 3,
        };

        await saveAlert(alertData);
        await sendFCM(alertData);
      }
    }
  }
}

// ─── Tâche 3 : alerter si pirimi est plein (10 produits) ──────────────────────
async function checkPirimiCapacity() {
  const pirimiRef = db.ref(`${BASE_PATH}/pirimi`);
  const snapshot = await pirimiRef.once('value');
  if (!snapshot.exists()) return;

  const products = snapshot.val();
  const count = Object.keys(products).length;

  if (count >= 10) {
    const time = new Date().toISOString();
    const alertData = {
      name: `Boîte Pirimi pleine`,
      context: `La zone pirimi contient ${count} produit(s) — capacité maximale atteinte (10)`,
      time,
      priority: 2,
    };

    await saveAlert(alertData);
    await sendFCM(alertData);
  }
}

// ─── Handler principal ────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // ── GET /api/notify?task=... → déclenchement des tâches automatiques ─────
  if (req.method === 'GET') {
    const task = req.query.task;
    try {
      if (task === 'moveToZone3') {
        await checkAndMoveToZone3();
        return res.status(200).json({ success: true, task });
      }
      if (task === 'checkExpired') {
        await checkExpiredProducts();
        return res.status(200).json({ success: true, task });
      }
      if (task === 'checkPirimi') {
        await checkPirimiCapacity();
        return res.status(200).json({ success: true, task });
      }
      if (task === 'all') {
        await checkAndMoveToZone3();
        await checkExpiredProducts();
        await checkPirimiCapacity();
        return res.status(200).json({ success: true, task: 'all' });
      }
      return res.status(400).json({ error: 'Tâche inconnue. Utiliser: moveToZone3 | checkExpired | checkPirimi | all' });
    } catch (err) {
      console.error('Erreur tâche automatique:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── POST /api/notify → enregistrer une alerte manuellement ───────────────
  if (req.method !== 'POST') return res.status(405).end();

  const { name, context, time, priority } = req.body;
  if (!name || !context || !time || !priority)
    return res.status(400).json({ error: 'Champs manquants' });

  try {
    const alertKey = await saveAlert({ name, context, time, priority });
    const fcmResult = await sendFCM({ name, context, time, priority });
    return res.status(200).json({ success: true, id: alertKey, fcm: fcmResult });
  } catch (err) {
    console.error('Erreur notify POST:', err);
    return res.status(500).json({ error: err.message });
  }
};
