const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)
    ),
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') return res.status(405).end();

  const { name, context, time, priority } = req.body;
  if (!name || !context || !time || !priority)
    return res.status(400).json({ error: 'Champs manquants' });

  // Sauvegarde dans Firestore → frigo/TBNp1Y68mMV9nODEw6Kj/alerts
  await admin
    .firestore()
    .collection('frigo')
    .doc('TBNp1Y68mMV9nODEw6Kj')
    .collection('alerts')
    .add({
      name,
      context,
      time,
      priority,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

  // Envoi notification FCM
  const msg = {
    notification: {
      title: `${name}`,
      body:  `${context} | ${time}`,
    },
    data: { name, context, time, priority: String(priority) },
    topic: 'alerts',
  };

  const result = await admin.messaging().send(msg);
  return res.status(200).json({ success: true, id: result });
};
