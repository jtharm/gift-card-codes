require("dotenv").config();
const express = require("express");
const session = require("express-session");
const { CloudantV1, IamAuthenticator } = require("@ibm-cloud/cloudant");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const app = express();
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

const MailerSend = require("mailersend").default; // note the .default
const { EmailParams, Sender, Recipient } = require("mailersend");

const mailerSend = new MailerSend({
  apiKey: process.env.MAIL_API_KEY
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files
app.use(express.static("public"));

function log(message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.status(401).send("Unauthorized");
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

async function sendPurchaseEmail(toEmail, txnId, service, codes, total) {
  const messageText = `
Thank you for your purchase!

Transaction ID: ${txnId}
Service: ${service}
Quantity: ${codes.length}
Codes:

${codes.join("\n")}

Total: $${total}

Please make e-transfer payment to jeeva86@hotmail.com.

Regards,

Jeeva
`;

  const messageHtml = `
<p>Thank you for your purchase!</p>
<p><strong>Transaction ID:</strong> ${txnId}<br>
<strong>Service:</strong> ${service}<br>
<strong>Quantity:</strong> ${codes.length}<br>
<strong>Codes:</strong><br>${codes.join("<br>")}<br>
<strong>Total:</strong> $${total}</p>
<p>Please make e-transfer payment to <strong>jeeva86@hotmail.com</strong>.</p>
<p>Regards,<br>Jeeva</p>
`;

  try {
    const from = new Sender("no-reply@" + process.env.MAILGUN_DOMAIN, "Gift Cards"); // replace with your sending email

    const recipients = [new Recipient(toEmail)];

    const emailParams = new EmailParams()
      .setFrom(from)
      .setTo(recipients)
      .setReplyTo(from)
      .setSubject(`Your Purchase Confirmation - ${txnId}`)
      .setText(messageText)
      .setHtml(messageHtml);

    const result = await mailerSend.email.send(emailParams);
    console.log("Mail sent:", result);
  } catch (err) {
    console.error("Mail error:", err);
  }
}

// ----------------------
// ROUTES
// ----------------------

// Login page
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public/login.html"));
});

app.post("/admin/login", (req, res) => {
  const { email, password } = req.body;

  if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    req.session.adminEmail = email;
    return res.sendStatus(200);
  }

  return res.status(401).send("Invalid credentials");
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
  console.log("=== /get-code called ===");
  console.log("Body received:", req.body);
  console.log("Session:", req.session);

  const email = req.session.email;
  const { service, quantity } = req.body;
  const qty = parseInt(quantity, 10) || 1;

  if (!email) {
    console.log("FAIL: No email in session");
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!service) {
    console.log("FAIL: No service provided");
    return res.status(400).json({ error: "Service required" });
  }

  console.log("Service:", service, "Quantity:", qty);

  try {
    const docId = service === "Uber" ? "codes-uber" : "codes-doordash";
    console.log("Fetching doc:", docId);

    const codesResponse = await client.getDocument({ db: DB_NAME, docId });
    const codesDoc = codesResponse.result;

    console.log("Document retrieved. Code count:", codesDoc.codes?.length);

    const unusedCodes = codesDoc.codes.filter(c => !c.used);
    console.log("Unused codes:", unusedCodes.length);

    if (unusedCodes.length === 0) {
      console.log("FAIL: No codes left");
      return res.status(400).json({ error: `No ${service} codes left` });
    }

    if (unusedCodes.length < qty) {
      console.log("FAIL: Not enough codes available");
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

    console.log("Updating Cloudant…");
    await client.putDocument({ db: DB_NAME, docId, document: codesDoc });

    const total = selected.length * 40;
    console.log("SUCCESS:", qty, "codes, txn", txnId);

    // --- SEND EMAIL ---
    await sendPurchaseEmail(
      email,                              // buyer email
      txnId,                              // transaction ID
      service,                            // e.g. "Uber"
      selected.map(c => c.code),          // array of codes
      total                               // total price
    );

    return res.json({
      codes: selected.map(c => c.code),
      txnId,
      count: selected.length,
      total
    });

  } catch (err) {
    console.log("CATCH BLOCK TRIGGERED");
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

app.get("/admin/session", (req, res) => {
  if (req.session && req.session.isAdmin) {
    return res.json({ email: req.session.adminEmail });
  }
  res.status(401).send("Unauthorized");
});

app.post("/admin/add-codes", requireAdmin, async (req, res) => {
  const { docId, codes } = req.body;

  if (!docId || !Array.isArray(codes) || codes.length === 0) {
    return res.status(400).json({ error: "Invalid request" });
  }

  try {
    const response = await client.getDocument({ db: DB_NAME, docId });
    const doc = response.result;

    if (!Array.isArray(doc.codes)) doc.codes = [];

    const existingCodes = new Set(doc.codes.map(c => c.code.toLowerCase()));
    const added = [];
    const skipped = [];

    codes.forEach(code => {
      const normalized = code.toLowerCase();
      if (existingCodes.has(normalized)) {
        skipped.push(code);
      } else {
        doc.codes.push({ code, used: false });
        added.push(code);
        existingCodes.add(normalized);
      }
    });

    await client.putDocument({ db: DB_NAME, docId, document: doc });

    console.log(`[${new Date().toISOString()}] Admin ${req.session.adminEmail} added ${added.length} codes to ${docId}, skipped ${skipped.length}`);

    return res.json({
      message: `Successfully added ${added.length} codes.`,
      added,
      skipped,
      skippedCount: skipped.length
    });

  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error adding codes:`, err);
    return res.status(500).json({ error: "Error adding codes" });
  }
});

// Admin reset codes
app.post("/admin/reset-codes", requireAdmin, async (req, res) => {
  try {
    const docs = ["codes-uber", "codes-doordash"];

    for (const docId of docs) {
      const response = await client.getDocument({ db: DB_NAME, docId });
      const doc = response.result;

      if (!Array.isArray(doc.codes)) continue;

      doc.codes.forEach(c => {
        c.used = false;
        delete c.usedBy;
        delete c.usedAt;
        delete c.txnId;
      });

      await client.putDocument({ db: DB_NAME, docId, document: doc });
    }

    console.log(`[${new Date().toISOString()}] Admin reset all codes`);
    return res.json({ message: "All codes have been reset" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Error resetting codes" });
  }
});

app.listen(3000, () => console.log("Server running on port 3000"));
