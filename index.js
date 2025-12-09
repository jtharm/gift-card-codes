import express from "express";
import session from "express-session";
import { CloudantV1, IamAuthenticator } from "@ibm-cloud/cloudant";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import axios from "axios";
import { fileURLToPath } from "url";

// ESM replacement for __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ADMIN_NAME = process.env.ADMIN_NAME;

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

// ----------------------
// AUTHORIZED USER HELPERS
// ----------------------
async function loadAuthorizedUsers() {
  try {
    const doc = await client.getDocument({
      db: DB_NAME,
      docId: "authorized_users"
    });

    return doc.result.emails || [];
  } catch (err) {
    if (err.status === 404) return [];
    console.error("Error loading authorized users:", err);
    throw err;
  }
}

async function saveAuthorizedUsers(users) {
  try {
    let doc;
    try {
      doc = await client.getDocument({
        db: DB_NAME,
        docId: "authorized_users"
      });

      await client.putDocument({
        db: DB_NAME,
        docId: "authorized_users",
        document: {
          _id: "authorized_users",
          _rev: doc.result._rev,
          emails: users
        }
      });
    } catch (err) {
      if (err.status === 404) {
        await client.putDocument({
          db: DB_NAME,
          docId: "authorized_users",
          document: {
            _id: "authorized_users",
            emails: users
          }
        });
      } else {
        throw err;
      }
    }
  } catch (err) {
    console.error("Error saving authorized users:", err);
    throw err;
  }
}

async function sendPurchaseEmail(toEmail, txnId, service, codes, total) {
  const apiKey = process.env.MAIL_API_KEY;
  const apiUrl = "https://api.mailersend.com/v1/email";

  const fromEmail = "no-reply@" + process.env.MAIL_DOMAIN;
  const fromName = process.env.MAIL_FROM_NAME || "Gift Cards";

  const body = {
    from: {
      email: fromEmail,
      name: fromName
    },
    to: [
      {
        email: toEmail
      },
    ],
    subject: `Your Purchase Confirmation - ${txnId}`,
    html: `
      <p>Thank you for your purchase!</p>
      <p><strong>Transaction ID:</strong> ${txnId}</p>
      <p><strong>Service:</strong> ${service}</p>
      <p><strong>Quantity:</strong> ${codes.length}</p>
      <p><strong>Codes:</strong><br><br>${codes.join("<br>")}</p>
      <p><strong>Total:</strong> $${total}</p>
      <p>Please make e-transfer payment to ${ADMIN_EMAIL}</p>
      <p>Regards,<br><br>${ADMIN_NAME}</p>
    `,
  };

  try {
    const resp = await axios.post(apiUrl, body, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    });
    console.log("MailerSend API response:", resp.data);
  } catch (err) {
    if (err.response) {
      console.error("MailerSend API error:", err.response.status, err.response.data);
    } else {
      console.error("MailerSend request error:", err.message);
    }
  }
}

// ----------------------
// ROUTES
// ----------------------

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

app.post("/login", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.send("Email required");

  try {
    const authDoc = await client.getDocument({ db: DB_NAME, docId: "authorized_users" });
    const validEmails = authDoc.result.emails;

    const normalizedEmail = email.trim().toLowerCase();

    if (!validEmails.includes(normalizedEmail)) {
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
  req.session.destroy((err) => {
    if (err) return res.status(500).send("Error logging out");
    log(`User logged out: ${email}`);
    res.redirect("/");
  });
});

app.get("/config", (req, res) => {
  res.json({
    etransferEmail: ADMIN_EMAIL
  });
});

app.get("/session-info", (req, res) => {
  if (!req.session.email) return res.status(401).json({ error: "Unauthorized" });
  res.json({ email: req.session.email });
});

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
    const total = codesDoc.codes.length;

    return res.json({ available, total });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ available: 0, total: 0 });
  }
});

app.get("/admin/session", (req, res) => {
  if (req.session && req.session.isAdmin) {
    return res.json({ email: req.session.adminEmail });
  }
  res.status(401).send("Unauthorized");
});

app.get("/admin/auth-users", requireAdmin, async (req, res) => {
  const users = await loadAuthorizedUsers();
  res.json({ users });
});

// ADD an authorized user
app.post("/admin/auth-users/add", requireAdmin, async (req, res) => {
  const { email } = req.body;

  if (!email || typeof email !== "string") {
    return res.status(400).json({ error: "Invalid or missing email" });
  }

  try {
    const users = await loadAuthorizedUsers();

    if (users.includes(email)) {
      return res.status(409).json({ error: "User already authorized" });
    }

    users.push(email.toLowerCase().trim());
    await saveAuthorizedUsers(users);

    res.json({ success: true, message: "User added", users });
  } catch (err) {
    console.error("Error adding authorized user:", err);
    res.status(500).json({ error: "Failed to add user" });
  }
});

// REMOVE an authorized user
app.post("/admin/auth-users/remove", requireAdmin, async (req, res) => {
  const { email } = req.body;

  if (!email || typeof email !== "string") {
    return res.status(400).json({ error: "Invalid or missing email" });
  }

  try {
    const users = await loadAuthorizedUsers();

    const filtered = users.filter(u => u.toLowerCase().trim() !== email.toLowerCase().trim());

    if (filtered.length === users.length) {
      return res.status(404).json({ error: "User not found" });
    }

    await saveAuthorizedUsers(filtered);

    res.json({ success: true, message: "User removed", users: filtered });
  } catch (err) {
    console.error("Error removing authorized user:", err);
    res.status(500).json({ error: "Failed to remove user" });
  }
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
    const docs = req.body.docId ? [req.body.docId] : ["codes-uber", "codes-doordash"];

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

    console.log(`[${new Date().toISOString()}] Admin reset codes for ${docs.join(", ")}`);
    return res.json({ message: "Codes reset successfully" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Error resetting codes" });
  }
});

app.get("/admin/transactions", requireAdmin, async (req, res) => {
  const { service } = req.query;
  if (!service || !["codes-uber", "codes-doordash"].includes(service)) {
    return res.status(400).json({ error: "Invalid service" });
  }

  try {
    const docResp = await client.getDocument({ db: DB_NAME, docId: service });
    const codesDoc = docResp.result;

    const usedCodes = codesDoc.codes.filter(c => c.used && c.txnId);

    // Aggregate by txnId
    const txnMap = {};
    usedCodes.forEach(c => {
      if (!txnMap[c.txnId]) {
        txnMap[c.txnId] = { txnId: c.txnId, date: c.usedAt, email: c.usedBy, qty: 0 };
      }
      txnMap[c.txnId].qty += 1;
    });

    const transactions = Object.values(txnMap).sort((a,b) => new Date(b.date) - new Date(a.date));

    res.json({ transactions });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch transactions" });
  }
});

app.listen(3000, () => console.log("Server running on port 3000"));
