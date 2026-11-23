const crypto = require("crypto");
const { execFile } = require("child_process");
require("dotenv").config();
const express = require("express");
const session = require("express-session");
const fs = require("fs");
const https = require("https");
const net = require("net");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = process.env.SIMPLEPORT_DATA_DIR || __dirname;
fs.mkdirSync(DATA_DIR, { recursive: true });

const DATA_FILE = path.join(DATA_DIR, "ports.json");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const SESSION_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_FIRST_REFRESH_DELAY_MS = 6 * 60 * 60 * 1000;
const DEFAULT_SETTINGS = { healthCheckIntervalSeconds: 300 };
const MINIUPNPC_COMMAND = process.env.MINIUPNPC_COMMAND || "upnpc";
const SESSION_COOKIE_SECURE = process.env.SESSION_COOKIE_SECURE === "true";
const refreshTimers = new Map();
const healthChecks = new Map();
let cachedPublicIp;
let healthCheckTimer;
let healthCheckInProgress = false;

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

function runMiniupnpc(args, timeout = 15000) {
  return new Promise((resolve, reject) => {
    execFile(MINIUPNPC_COMMAND, args, { timeout }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || error.message).trim()));
        return;
      }

      resolve(stdout.trim());
    });
  });
}

function addPortForward(port) {
  return Promise.all(getProtocols(port).map(protocol => runMiniupnpc([
    "-a",
    port.internalHost,
    String(port.internalPort),
    String(port.externalPort),
    protocol,
    "0"
  ])));
}

function removePortForward(port) {
  return Promise.all(getProtocols(port).map(protocol => runMiniupnpc([
    "-d",
    String(port.externalPort),
    protocol
  ])));
}

function getProtocols(port) {
  return port.protocol === "TCP/UDP" ? ["TCP", "UDP"] : [port.protocol];
}

async function applyPortForward(port) {
  if (port.enabled) await addPortForward(port);
}

function stopRefreshTimer(id) {
  const timer = refreshTimers.get(id);
  if (timer) clearTimeout(timer);
  refreshTimers.delete(id);
}

function getRandomRefreshDelay() {
  return MIN_FIRST_REFRESH_DELAY_MS
    + Math.floor(Math.random() * (DAY_MS - MIN_FIRST_REFRESH_DELAY_MS + 1));
}

function startRefreshTimer(port) {
  stopRefreshTimer(port.id);

  if (!port.enabled) return;

  schedulePortRefresh(port, getRandomRefreshDelay());
}

function schedulePortRefresh(port, delay) {
  stopRefreshTimer(port.id);

  const timer = setTimeout(async () => {
    refreshTimers.delete(port.id);

    try {
      const currentPort = loadPorts().find(entry => entry.id === port.id);
      if (!currentPort || !currentPort.enabled) return;

      await addPortForward(currentPort);
    } catch (error) {
      console.error(`Could not refresh port ${port.externalPort}: ${error.message}`);
    }

    try {
      const currentPort = loadPorts().find(entry => entry.id === port.id);
      if (currentPort && currentPort.enabled) {
        schedulePortRefresh(currentPort, getRandomRefreshDelay());
      }
    } catch (error) {
      console.error(`Could not schedule refresh for port ${port.externalPort}: ${error.message}`);
    }
  }, delay);

  refreshTimers.set(port.id, timer);
}

async function applyAllPortForwards() {
  for (const port of loadPorts()) {
    try {
      await applyPortForward(port);
      startRefreshTimer(port);
    } catch (error) {
      console.error(`Could not apply port ${port.externalPort}: ${error.message}`);
    }
  }
}

async function testTcpPortForward(port, gatewayOutput) {
  const publicIp = await getPublicIp();
  const publicReachable = await testTcpPort(publicIp, port.externalPort);

  if (publicReachable) {
    return {
      reachable: true,
      message: `TCP port ${port.externalPort} accepted an external connection on ${publicIp}.`
    };
  }

  const output = gatewayOutput || await runMiniupnpc(["-l"], 5000);
  const mappingActive = hasUpnpMapping(output, port);
  const internalReachable = mappingActive && await testTcpPort(port.internalHost, port.internalPort);

  return {
    reachable: internalReachable,
    message: internalReachable
      ? `The UPnP rule is active and ${port.internalHost}:${port.internalPort} accepted a connection. Your router does not support NAT loopback, so the local public-IP check could not be completed.`
      : `No TCP connection was accepted on ${publicIp}:${port.externalPort}, and the configured internal service could not be verified.`
  };
}

async function checkPortHealth(port) {
  const checkedAt = new Date().toISOString();

  try {
    const gatewayOutput = await runMiniupnpc(["-l"], 5000);
    const mappingActive = hasUpnpMapping(gatewayOutput, port);

    let result;
    if (!mappingActive) {
      result = {
        status: "down",
        message: "The configured UPnP mapping was not found on the gateway."
      };
    } else if (port.protocol === "UDP") {
      result = {
        status: "mapped",
        message: "The UPnP mapping exists. UDP service reachability cannot be verified automatically."
      };
    } else {
      const tcpResult = await testTcpPortForward(port, gatewayOutput);
      result = {
        status: tcpResult.reachable ? "up" : "down",
        message: tcpResult.message
      };
    }

    healthChecks.set(port.id, { checkedAt, ...result });
    if (result.status === "down") {
      console.error(`Health check failed for port ${port.externalPort} (${port.name}): ${result.message}`);
    }
  } catch (error) {
    const message = error.message || "Health check failed";
    healthChecks.set(port.id, { checkedAt, status: "error", message });
    console.error(`Could not check port ${port.externalPort} (${port.name}): ${message}`);
  }
}

async function runHealthChecks() {
  if (healthCheckInProgress) return;
  healthCheckInProgress = true;

  try {
    for (const port of loadPorts()) {
      if (port.enabled) await checkPortHealth(port);
    }
  } catch (error) {
    console.error(`Could not load ports for health checks: ${error.message}`);
  } finally {
    healthCheckInProgress = false;
  }
}

function restartHealthCheckTimer() {
  clearTimeout(healthCheckTimer);
  const delay = loadSettings().healthCheckIntervalSeconds * 1000;

  healthCheckTimer = setTimeout(async () => {
    await runHealthChecks();
    restartHealthCheckTimer();
  }, delay);
}

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

app.post("/api/login", (req, res) => {
  const { username, password } = req.body;

  const expectedUser = process.env.UI_USERNAME || "admin";
  const expectedPassword = process.env.UI_PASSWORD || "admin";

  if (username === expectedUser && password === expectedPassword) {
    req.session.authenticated = true;
    return res.json({ success: true });
  }

  res.status(401).json({ error: "Invalid username or password" });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

app.get("/api/auth", (req, res) => {
  res.json({ authenticated: !!req.session.authenticated });
});

app.get("/api/ports", requireAuth, (req, res) => {
  res.json(loadPorts().map(port => ({
    ...port,
    health: healthChecks.get(port.id) || null
  })));
});

app.get("/api/settings", requireAuth, (req, res) => {
  res.json(loadSettings());
});

app.get("/api/gateway", requireAuth, async (req, res) => {
  try {
    await runMiniupnpc(["-l"], 5000);
    res.json({ connected: true, message: "UPnP gateway detected" });
  } catch (error) {
    res.json({
      connected: false,
      message: error.message || "No UPnP gateway detected"
    });
  }
});

app.put("/api/settings", requireAuth, async (req, res) => {
  const healthCheckIntervalSeconds = Number(req.body.healthCheckIntervalSeconds);

  if (!Number.isInteger(healthCheckIntervalSeconds) || healthCheckIntervalSeconds < 60 || healthCheckIntervalSeconds > 86400) {
    return res.status(400).json({ error: "Health check interval must be between 60 and 86400 seconds" });
  }

  saveSettings({ healthCheckIntervalSeconds });
  restartHealthCheckTimer();

  res.json({ healthCheckIntervalSeconds });
});

function getPublicIp() {
  if (process.env.PUBLIC_IP) return Promise.resolve(process.env.PUBLIC_IP);
  if (cachedPublicIp) return Promise.resolve(cachedPublicIp);

  return new Promise((resolve, reject) => {
    https.get("https://api.ipify.org?format=json", response => {
      let body = "";

      response.on("data", chunk => {
        body += chunk;
      });

      response.on("end", () => {
        try {
          cachedPublicIp = JSON.parse(body).ip;
          resolve(cachedPublicIp);
        } catch {
          reject(new Error("Could not determine the public IP address"));
        }
      });
    }).on("error", reject);
  });
}

function testTcpPort(host, port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port });
    let settled = false;

    const finish = reachable => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reachable);
    };

    socket.setTimeout(5000);
    socket.on("connect", () => finish(true));
    socket.on("timeout", () => finish(false));
    socket.on("error", () => finish(false));
  });
}

function hasUpnpMapping(output, port) {
  return getProtocols(port).every(protocol => {
    const mappingPattern = new RegExp(`\\b${protocol}\\s+${port.externalPort}->`);
    return mappingPattern.test(output);
  });
}

app.post("/api/ports/:id/test", requireAuth, async (req, res) => {
  const port = loadPorts().find(entry => entry.id === req.params.id);

  if (!port) {
    return res.status(404).json({ error: "Port forward not found" });
  }

  if (port.protocol === "UDP") {
    return res.json({
      reachable: false,
      message: "UDP ports cannot be verified with a TCP connection test."
    });
  }

  try {
    res.json(await testTcpPortForward(port));
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.post("/api/ports", requireAuth, (req, res) => {
  const {
    name,
    externalPort,
    internalPort,
    protocol,
    internalHost,
    enabled = true
  } = req.body;

  if (!name || !externalPort || !internalPort || !protocol || !internalHost) {
    return res.status(400).json({ error: "All fields are required" });
  }

  const ports = loadPorts();

  const entry = {
    id: crypto.randomUUID(),
    name: String(name).trim(),
    externalPort: Number(externalPort),
    internalPort: Number(internalPort),
    protocol: String(protocol).toUpperCase(),
    internalHost: String(internalHost).trim(),
    enabled: Boolean(enabled)
  };

  const setup = entry.enabled ? addPortForward(entry) : Promise.resolve();

  setup
    .then(() => {
      ports.push(entry);
      savePorts(ports);
      startRefreshTimer(entry);
      if (entry.enabled) checkPortHealth(entry);
      res.status(201).json(entry);
    })
    .catch(error => {
      res.status(502).json({ error: `Could not configure port forward: ${error.message}` });
    });
});

app.put("/api/ports/:id", requireAuth, async (req, res) => {
  const ports = loadPorts();
  const index = ports.findIndex(p => p.id === req.params.id);

  if (index === -1) {
    return res.status(404).json({ error: "Port forward not found" });
  }

  const {
    name,
    externalPort,
    internalPort,
    protocol,
    internalHost,
    enabled = true
  } = req.body;

  const previous = ports[index];
  const updated = {
    ...ports[index],
    name: String(name).trim(),
    externalPort: Number(externalPort),
    internalPort: Number(internalPort),
    protocol: String(protocol).toUpperCase(),
    internalHost: String(internalHost).trim(),
    enabled: Boolean(enabled)
  };

  try {
    await applyPortForward(updated);

    if (previous.enabled && (
      previous.externalPort !== updated.externalPort ||
      previous.protocol !== updated.protocol
    )) {
      await removePortForward(previous);
    }

    ports[index] = updated;
    savePorts(ports);
    startRefreshTimer(updated);
    if (updated.enabled) {
      checkPortHealth(updated);
    } else {
      healthChecks.delete(updated.id);
    }
    res.json(updated);
  } catch (error) {
    res.status(502).json({ error: `Could not configure port forward: ${error.message}` });
  }
});

app.delete("/api/ports/:id", requireAuth, async (req, res) => {
  const ports = loadPorts();
  const port = ports.find(p => p.id === req.params.id);

  if (!port) {
    return res.status(404).json({ error: "Port forward not found" });
  }

  try {
    if (port.enabled) await removePortForward(port);
    stopRefreshTimer(port.id);
    healthChecks.delete(port.id);
    savePorts(ports.filter(p => p.id !== req.params.id));
    res.json({ success: true });
  } catch (error) {
    res.status(502).json({ error: `Could not remove port forward: ${error.message}` });
  }
});

app.post("/api/ports/delete", requireAuth, async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];

  if (!ids.length) {
    return res.status(400).json({ error: "No entries selected" });
  }

  const ports = loadPorts();
  const selected = ports.filter(port => ids.includes(port.id));

  try {
    for (const port of selected) {
      if (port.enabled) await removePortForward(port);
    }

    selected.forEach(port => stopRefreshTimer(port.id));
    selected.forEach(port => healthChecks.delete(port.id));
    savePorts(ports.filter(port => !ids.includes(port.id)));
    res.json({ success: true });
  } catch (error) {
    res.status(502).json({ error: `Could not remove port forward: ${error.message}` });
  }
});

app.use((req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`UPnP Port Forward UI running on http://localhost:${PORT}`);
  applyAllPortForwards().then(runHealthChecks);
  restartHealthCheckTimer();
});
