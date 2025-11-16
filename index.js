require("dotenv").config();
const express = require("express");
const session = require("express-session");
const { CloudantV1, IamAuthenticator } = require("@ibm-cloud/cloudant");
const { v4: uuidv4 } = require("uuid");
const path = require("path");

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files
app.use(express.static("public"));

function log(message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
}

// ----------------------
// SESSION
// ----------------------
app.use(
  session({
    secret: process.env.SESSION_SECRET || "changeme",
    resave: false,
    saveUninitialized: true,
  })
);

// ----------------------
// CLOUDANT CLIENT
// ----------------------
const client = CloudantV1.newInstance({
  authenticator: new IamAuthenticator({
    apikey: process.env.CLOUDANT_APIKEY,
  }),
  serviceUrl: process.env.CLOUDANT_URL,
});

const DB_NAME = process.env.CLOUDANT_DB;

// ----------------------
// ROUTES
// ----------------------

// Login page
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public/login.html"));
});

// Handle login
app.post("/login", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.send("Email required");

  try {
    const authDoc = await client.getDocument({ db: DB_NAME, docId: "authorized_users" });
    const validEmails = authDoc.result.emails;

    if (!validEmails.includes(email)) {
      log(`Unauthorized login attempt: ${email}`);
      return res.send("Not authorized");
    }

    req.session.email = email;
    log(`User logged in: ${email}`);

    res.redirect("/codes");
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
});

app.post("/logout", (req, res) => {
  const email = req.session.email;
  req.session.destroy(err => {
    if (err) {
      console.error(err);
      return res.status(500).send("Error logging out");
    }
    log(`User logged out: ${email}`);
    res.redirect("/");
  });
});

app.get("/session-info", (req, res) => {
  if (!req.session.email) return res.status(401).json({ error: "Unauthorized" });
  res.json({ email: req.session.email });
});

// Code request page
app.get("/codes", (req, res) => {
  if (!req.session.email) return res.redirect("/");
  res.sendFile(path.join(__dirname, "public/codes.html"));
});

// ----------------------
// API ENDPOINTS
// ----------------------

app.post("/retrieve-codes", async (req, res) => {
  const email = req.session.email;
  const { txnId } = req.body;

  if (!email) return res.status(401).json({ error: "Unauthorized" });

  try {
    const services = ["codes-uber", "codes-doordash"];
    let foundCodes = [];

    for (const docId of services) {
      const docResp = await client.getDocument({ db: DB_NAME, docId });
      const codesDoc = docResp.result;
      const matches = codesDoc.codes.filter(c => c.txnId === txnId && c.usedBy === email);
      foundCodes = foundCodes.concat(matches.map(c => `${c.code} (${docId.replace('codes-', '')})`));
    }

    if (foundCodes.length === 0) {
      log(`No codes found for txnId ${txnId} by ${email}`);
      return res.status(404).json({ error: "No codes found for this transaction ID" });
    }

    log(`Retrieved ${foundCodes.length} code(s) for txnId ${txnId} by ${email}`);
    return res.json({ codes: foundCodes });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Unknown error" });
  }
});

// Get codes
app.post("/get-code", async (req, res) => {
  const email = req.session.email;
  const { service, quantity } = req.body;
  const qty = parseInt(quantity, 10) || 1;

  if (!email) return res.status(401).json({ error: "Unauthorized" });

  try {
    const docId = service === "Uber" ? "codes-uber" : "codes-doordash";
    const codesResponse = await client.getDocument({ db: DB_NAME, docId });
    const codesDoc = codesResponse.result;

    const unusedCodes = codesDoc.codes.filter(c => !c.used);

    if (unusedCodes.length === 0) {
      log(`Code request when none left: ${email} requested ${qty} ${service} code(s)`);
      return res.status(400).json({ error: `No ${service} codes left` });
    }

    if (unusedCodes.length < qty) {
      return res.status(400).json({ error: `Only ${unusedCodes.length} codes available` });
    }

    const selected = unusedCodes.slice(0, qty);
    const txnId = uuidv4();

    selected.forEach(c => {
      c.used = true;
      c.usedBy = email;
      c.usedAt = new Date().toISOString();
      c.txnId = txnId;
    });

    await client.putDocument({ db: DB_NAME, docId, document: codesDoc });

    log(`Transaction ${txnId} - ${email} requested ${qty} ${service} code(s)`);

    return res.json({ codes: selected.map(c => c.code), txnId });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Unknown error" });
  }
});

// Available codes
app.get("/available", async (req, res) => {
  const { service } = req.query;
  if (!service || !["Uber", "DoorDash"].includes(service))
    return res.status(400).json({ error: "Invalid service" });

  try {
    const docId = service === "Uber" ? "codes-uber" : "codes-doordash";
    const codesResponse = await client.getDocument({ db: DB_NAME, docId });
    const codesDoc = codesResponse.result;
    const available = codesDoc.codes.filter(c => !c.used).length;
    return res.json({ available });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ available: 0 });
  }
});

app.listen(3000, () => console.log("Server running on port 3000"));
