const crypto = require("crypto");
require("dotenv").config();
const express = require("express");
const session = require("express-session");
const fs = require("fs");
const path = require("path");
const createRouterUpnpService = require("./services/router-upnp");
const registerApiRoutes = require("./routes/api");
const createPortManagementService = require("./services/port-management");

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = process.env.SIMPLEPORT_DATA_DIR || __dirname;
fs.mkdirSync(DATA_DIR, { recursive: true });

const DATA_FILE = path.join(DATA_DIR, "ports.json");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const LOG_FILE = path.join(DATA_DIR, "logs.json");
const SESSION_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
const MAX_LOG_ENTRIES = 500;
const SESSION_COOKIE_SECURE = process.env.SESSION_COOKIE_SECURE === "true";
const ROUTER_ADMIN_URL = "http://10.0.0.1/";
const ROUTER_ADMIN_USERNAME = process.env.ROUTER_ADMIN_USERNAME;
const ROUTER_ADMIN_PASSWORD = process.env.ROUTER_ADMIN_PASSWORD;
const MAX_ROUTER_UPNP_EVENTS = 50;
const ROUTER_UPNP_CREDENTIALS_CONFIGURED = Boolean(ROUTER_ADMIN_USERNAME && ROUTER_ADMIN_PASSWORD);
const DEFAULT_SETTINGS = {
  healthCheckIntervalSeconds: 300,
  routerUpnpCheckIntervalSeconds: 300,
  routerUpnpMonitorEnabled: ROUTER_UPNP_CREDENTIALS_CONFIGURED
};
const gatewayFailure = { logged: false };


const DEFAULT_PORTS = [
  // {
  //   id: "1",
  //   name: "Jellyfin",
  //   externalPort: 8096,
  //   internalPort: 8096,
  //   protocol: "TCP",
  //   internalHost: "10.0.0.219",
  //   enabled: true
  // },
  // {
  //   id: "2",
  //   name: "Minecraft",
  //   externalPort: 25565,
  //   internalPort: 25565,
  //   protocol: "TCP",
  //   internalHost: "10.0.0.220",
  //   enabled: true
  // }
];

function loadPorts() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(DEFAULT_PORTS, null, 2));
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}

function savePorts(ports) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(ports, null, 2));
}

function loadSettings() {
  if (!fs.existsSync(SETTINGS_FILE)) {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(DEFAULT_SETTINGS, null, 2));
  }

  return {
    ...DEFAULT_SETTINGS,
    ...JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"))
  };
}

function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

function loadAppLogs() {
  if (!fs.existsSync(LOG_FILE)) return [];

  try {
    const logs = JSON.parse(fs.readFileSync(LOG_FILE, "utf8"));
    if (!Array.isArray(logs)) throw new Error("Log data must be an array");
    return logs.slice(0, MAX_LOG_ENTRIES);
  } catch (error) {
    const message = `Could not load saved app logs: ${error.message}`;
    console.error(message);
    return [{
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      level: "error",
      category: "Log storage",
      message
    }];
  }
}

let appLogs = loadAppLogs();

function recordLog(level, category, message) {
  const entry = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    level,
    category,
    message: String(message)
  };

  appLogs.unshift(entry);
  appLogs = appLogs.slice(0, MAX_LOG_ENTRIES);

  try {
    fs.writeFileSync(LOG_FILE, JSON.stringify(appLogs, null, 2));
  } catch (error) {
    console.error(`Could not persist app log: ${error.message}`);
  }

  if (level === "warning") {
    console.warn(`[${category}] ${entry.message}`);
  } else {
    console.error(`[${category}] ${entry.message}`);
  }
}

function clearAppLogs() {
  fs.writeFileSync(LOG_FILE, "[]");
  appLogs = [];
  gatewayFailure.logged = false;
}

const portManagement = createPortManagementService({
  loadPorts,
  loadSettings,
  recordLog,
  config: {
    miniupnpcCommand: process.env.MINIUPNPC_COMMAND || "upnpc",
    publicIp: process.env.PUBLIC_IP
  }
});

const routerUpnp = createRouterUpnpService({
  loadSettings,
  recordLog,
  config: {
    routerAdminUrl: ROUTER_ADMIN_URL,
    routerAdminUsername: ROUTER_ADMIN_USERNAME,
    routerAdminPassword: ROUTER_ADMIN_PASSWORD,
    credentialsConfigured: ROUTER_UPNP_CREDENTIALS_CONFIGURED,
    maxEvents: MAX_ROUTER_UPNP_EVENTS
  }
});

function requireAuth(req, res, next) {
  if (req.session.authenticated) return next();
  res.status(401).json({ error: "Unauthorized" });
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || "change-this-secret",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: SESSION_COOKIE_SECURE,
    maxAge: SESSION_MAX_AGE
  }
}));

app.use(express.static(path.join(__dirname, "public")));

registerApiRoutes(app, {
  requireAuth,
  loadPorts,
  ...portManagement,
  getAppLogs: () => appLogs,
  clearAppLogs,
  gatewayFailure,
  recordLog,
  routerUpnp,
  loadSettings,
  saveSettings,
  savePorts,
});

app.use((req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`UPnP Port Forward UI running on http://localhost:${PORT}`);
  portManagement.applyAllPortForwards()
    .then(portManagement.runHealthChecks)
    .catch(error => recordLog("error", "Startup", `Could not apply saved port forwards: ${error.message}`));
  portManagement.restartHealthCheckTimer();
  routerUpnp.start();
});
