require("dotenv").config();
const express = require("express");
const session = require("express-session");
const { CloudantV1, IamAuthenticator } = require("@ibm-cloud/cloudant");

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "changeme",
    resave: false,
    saveUninitialized: true,
  })
);

const client = CloudantV1.newInstance({
  authenticator: new IamAuthenticator({
    apikey: process.env.CLOUDANT_APIKEY,
  }),
  serviceUrl: process.env.CLOUDANT_URL,
});

const DB_NAME = process.env.CLOUDANT_DB;

// -----------------------------------
// GET CODE ROUTE with email authorization
// -----------------------------------
app.post("/get-code", async (req, res) => {
  const { email, service, quantity } = req.body;
  const qty = parseInt(quantity, 10) || 1;

  if (!email) return res.status(400).json({ error: "Email required" });
  if (!service || !["Uber", "DoorDash"].includes(service))
    return res.status(400).json({ error: "Please select Uber or DoorDash" });
  if (qty < 1 || qty > 4)
    return res.status(400).json({ error: "Quantity must be between 1 and 4" });

  try {
    // Check if email is authorized
    const usersResponse = await client.getDocument({
      db: DB_NAME,
      docId: "authorized_users",
    });
    const usersDoc = usersResponse.result;

    if (!usersDoc.emails.includes(email.toLowerCase()))
      return res.status(403).json({ error: "Not authorized" });

    // Choose codes document
    const docId = service === "Uber" ? "codes-uber" : "codes-doordash";
    const codesResponse = await client.getDocument({ db: DB_NAME, docId });
    const codesDoc = codesResponse.result;

    const unusedCodes = codesDoc.codes.filter(c => !c.used);

    if (unusedCodes.length < qty) {
      return res.status(400).json({ error: `Requested quantity exceeds available codes (${unusedCodes.length} left)` });
    }

    // Take the requested number of codes
    const selected = unusedCodes.slice(0, qty);
    selected.forEach(c => {
      c.used = true;
      c.usedBy = email.toLowerCase();
      c.usedAt = new Date().toISOString();
    });

    // Save updated codes document
    await client.putDocument({ db: DB_NAME, docId, document: codesDoc });

    return res.json({ codes: selected.map(c => c.code) });
  } catch (err) {
    console.error("Error retrieving codes:", err);
    return res.status(500).json({ error: "Unknown error" });
  }
});

// Endpoint to get available quantity
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
