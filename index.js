import express from "express";
import path from "path";
import session from "express-session";
import passport from "passport";
import { WebAppStrategy } from "ibmcloud-appid";
import { CloudantV1, IamAuthenticator } from "@ibm-cloud/cloudant";
import dotenv from "dotenv";
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// ---------------------- SESSION ----------------------
app.use(
  session({
    secret: process.env.SESSION_SECRET || "change-this",
    resave: false,
    saveUninitialized: false
  })
);

app.use(passport.initialize());
app.use(passport.session());

// ---------------------- APP ID STRATEGY ----------------------
passport.use(
  new WebAppStrategy({
    tenantId: process.env.APPID_TENANT_ID,
    clientId: process.env.APPID_CLIENT_ID,
    secret: process.env.APPID_SECRET,
    oauthServerUrl: process.env.APPID_OAUTH_URL,
    redirectUri: process.env.APPID_REDIRECT_URI
  })
);

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

// Authentication middleware
function requiresLogin(req, res, next) {
  if (req.user) return next();
  res.redirect("/login");
}

// ---------------------- LOGIN ROUTES ----------------------
app.get("/login", passport.authenticate(WebAppStrategy.STRATEGY_NAME));

app.get(
  "/callback",
  passport.authenticate(WebAppStrategy.STRATEGY_NAME),
  (req, res) => res.redirect("/")
);

// ---------------------- CLOUDANT CLIENT ----------------------
const cloudant = CloudantV1.newInstance({
  authenticator: new IamAuthenticator({
    apikey: process.env.CLOUDANT_APIKEY
  }),
  serviceUrl: process.env.CLOUDANT_URL
});

// ---------------------- UI ROUTE ----------------------
app.use(express.static("public"));

app.get("/", requiresLogin, (req, res) => {
  res.sendFile(path.resolve("public/index.html"));
});

// ---------------------- API ROUTES ----------------------
app.get("/get-code", requiresLogin, async (req, res) => {
  try {
    const result = await cloudant.postAllDocs({
      db: process.env.CLOUDANT_DB,
      includeDocs: true,
      limit: 1
    });

    if (result.result.rows.length === 0) {
      return res.status(400).json({ error: "No codes left" });
    }

    const doc = result.result.rows[0].doc;

    await cloudant.deleteDocument({
      db: process.env.CLOUDANT_DB,
      docId: doc._id,
      rev: doc._rev
    });

    res.json({ code: doc.code });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error fetching code" });
  }
});

app.listen(port, () => console.log(`Server running on port ${port}`));