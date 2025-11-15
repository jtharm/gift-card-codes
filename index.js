require('dotenv').config();
const express = require('express');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const { CloudantV1 } = require('@ibm-cloud/cloudant');
const { IamAuthenticator } = require('ibm-cloud-sdk-core');

const app = express();
app.use(express.json());

// Cloudant client
const cloudant = new CloudantV1({
  authenticator: new IamAuthenticator({
    apikey: process.env.CLOUDANT_APIKEY
  }),
  serviceUrl: process.env.CLOUDANT_URL
});
cloudant.setServiceUrl(process.env.CLOUDANT_URL);

const DB_NAME = process.env.DB_NAME;

// --- Fetch JWKS for App ID token verification ---
let jwksCache = null;
async function getJwks() {
  if (!jwksCache) {
    const res = await axios.get(process.env.APPID_JWKS_URL);
    jwksCache = res.data.keys;
  }
  return jwksCache;
}

function getKey(header, keys) {
  return keys.find(k => k.kid === header.kid);
}

// --- Verify App ID JWT ---
async function verifyToken(token) {
  const keys = await getJwks();
  const decodedHeader = jwt.decode(token, { complete: true }).header;
  const jwk = getKey(decodedHeader, keys);
  if (!jwk) throw new Error('Key not found');

  // Convert JWK to PEM
  const { e, n } = jwk;
  const pem = require('jwk-to-pem')({ kty: 'RSA', n, e });

  return jwt.verify(token, pem, { algorithms: ['RS256'] });
}

// --- Get next code endpoint ---
app.post('/get-code', async (req, res) => {
  try {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing token' });

    const token = auth.split(' ')[1];
    await verifyToken(token);

    // Fetch codes doc
    const { result: doc } = await cloudant.getDocument({ db: DB_NAME, docId: 'codes' });

    if (doc.nextIndex >= doc.list.length) return res.status(400).json({ error: 'No codes left' });

    const code = doc.list[doc.nextIndex];
    doc.nextIndex += 1;

    await cloudant.putDocument({ db: DB_NAME, docId: 'codes', document: doc });

    res.json({ code });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to get code' });
  }
});

// --- Start server ---
const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`Server running on port ${port}`));
