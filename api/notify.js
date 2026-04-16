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

const FRIGO_ID    = 'TBNp1Y68mMV9nODEw6Kj';
const BASE_PATH   = `frigo/${FRIGO_ID}`;
const ZONES       = ['zone1', 'zone2', 'zone3', 'pirimi'];
const ALERT_ZONES = ['zone1', 'zone2'];

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

/**
 * FIX FCM : on utilise sendMulticast → topic avec le préfixe /topics/
 * et on s'assure que toutes les valeurs dans `data` sont des strings.
 */
async function sendFCM({ name, context, time, priority }) {
  const msg = {
    notification: {
      title: name,
      body: `${context} | ${time}`,
    },
    data: {
      name:     String(name),
      context:  String(context),
      time:     String(time),
      priority: String(priority),
    },
    topic: 'alerts',          // firebase-admin gère le préfixe /topics/ automatiquement
    android: {
      priority: 'high',       // FIX : force la livraison même si l'app est en arrière-plan
      notification: {
        sound: 'default',
        channelId: 'alerts',  // doit correspondre au channel créé côté Android
      },
    },
    apns: {                   // iOS
      payload: {
        aps: {
          sound: 'default',
          badge: 1,
        },
      },
    },
  };

  try {
    const result = await admin.messaging().send(msg);
    console.log('FCM envoyé, messageId:', result);
    return result;
  } catch (err) {
    console.error('Erreur FCM:', err);
    throw err;
  }
}

/**
 * FIX TIMESTAMP : normalise le champ __expired__ en millisecondes.
 * Si la valeur ressemble à des secondes (< 1e11), on la multiplie par 1000.
 * Les timestamps ms valides sont > 1 000 000 000 000 (13 chiffres).
 */
function getExpiredMs(product) {
  let ts = product['__expired__'];
  if (ts == null) return null;
  ts = Number(ts);
  if (isNaN(ts) || ts <= 0) return null;

  // Si le timestamp a moins de 13 chiffres → c'est des secondes, convertir
  if (ts < 1_000_000_000_000) {
    ts = ts * 1000;
  }
  return ts;
}

/** Formate un timestamp ms en date lisible (DD/MM/YYYY) */
function formatDate(ts) {
  return new Date(ts).toLocaleDateString('fr-FR');
}

/**
 * Retourne true si le produit expire dans <= 1 mois ET n'est pas encore expiré.
 * FIX : comparaison correcte maintenant que le ts est normalisé en ms.
 */
function expiresWithinOneMonth(product) {
  const ts = getExpiredMs(product);
  if (ts === null) return false;
  const now = Date.now();
  if (ts <= now) return false;                        // déjà expiré → pas concerné ici
  const oneMonthLater = new Date();
  oneMonthLater.setMonth(oneMonthLater.getMonth() + 1);
  return ts <= oneMonthLater.getTime();
}

/** Retourne true si le produit est déjà expiré */
function isExpired(product) {
  const ts = getExpiredMs(product);
  if (ts === null) return false;
  return ts <= Date.now();
}

// ─── Tâche 1 : zone1/zone2 → déplacer vers zone3 si expiration <= 1 mois ──────
async function checkAndMoveToZone3() {
  for (const zone of ALERT_ZONES) {
    const snapshot = await db.ref(`${BASE_PATH}/${zone}`).once('value');
    if (!snapshot.exists()) continue;

    const products = snapshot.val();

    for (const [key, product] of Object.entries(products)) {
      if (typeof product !== 'object' || product === null) continue; // sécurité

      if (expiresWithinOneMonth(product)) {
        const expTs = getExpiredMs(product);

        // Copier dans zone3 puis supprimer de la zone source (transaction atomique simulée)
        await db.ref(`${BASE_PATH}/zone3/${key}`).set(product);
        await db.ref(`${BASE_PATH}/${zone}/${key}`).remove();

        const time = new Date().toISOString();
        const alertData = {
          name:     `Produit bientôt expiré déplacé en Zone 3`,
          context:  `"${product.name || key}" déplacé de ${zone} vers zone3 (expire le ${formatDate(expTs)})`,
          time,
          priority: 2,
        };

        await saveAlert(alertData);
        await sendFCM(alertData);
      }
    }
  }
}

// ─── Tâche 2 : alerter si un produit est expiré dans toutes les zones ─────────
async function checkExpiredProducts() {
  for (const zone of ZONES) {
    const snapshot = await db.ref(`${BASE_PATH}/${zone}`).once('value');
    if (!snapshot.exists()) continue;

    const products = snapshot.val();

    for (const [key, product] of Object.entries(products)) {
      if (typeof product !== 'object' || product === null) continue;

      if (isExpired(product)) {
        const expTs = getExpiredMs(product);
        const time  = new Date().toISOString();
        const alertData = {
          name:     `Produit expiré détecté`,
          context:  `"${product.name || key}" dans ${zone} est expiré depuis le ${formatDate(expTs)}`,
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
  const snapshot = await db.ref(`${BASE_PATH}/pirimi`).once('value');
  if (!snapshot.exists()) return;

  const products = snapshot.val();
  // FIX : ne compter que les entrées qui sont bien des objets produit (pas des métadonnées)
  const count = Object.values(products).filter(
    (v) => typeof v === 'object' && v !== null
  ).length;

  if (count >= 10) {
    const time = new Date().toISOString();
    const alertData = {
      name:     `Boîte Pirimi pleine`,
      context:  `La zone pirimi contient ${count} produit(s) — capacité maximale atteinte (10)`,
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
console.log("🚀 FUNCTION START");

console.log("HEADERS:", req.headers);

const url = new URL(req.url, `https://${req.headers.host}`);
const task = url.searchParams.get("task");

console.log("TASK:", task);
  if (req.method === 'GET') {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const task = url.searchParams.get("task");
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
      return res.status(400).json({
        error: 'Tâche inconnue. Utiliser: moveToZone3 | checkExpired | checkPirimi | all',
      });
    } catch (err) {
      console.error('Erreur tâche automatique:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method !== 'POST') return res.status(405).end();

  const { name, context, time, priority } = req.body;
  if (!name || !context || !time || !priority)
    return res.status(400).json({ error: 'Champs manquants' });

  try {
    const alertKey  = await saveAlert({ name, context, time, priority });
    const fcmResult = await sendFCM({ name, context, time, priority });
    return res.status(200).json({ success: true, id: alertKey, fcm: fcmResult });
  } catch (err) {
    console.error('Erreur notify POST:', err);
    return res.status(500).json({ error: err.message });
  }
};
