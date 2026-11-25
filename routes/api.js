const crypto = require("crypto");

function registerApiRoutes(app, dependencies) {
  const {
    requireAuth,
    loadPorts,
    healthChecks,
    getAppLogs,
    clearAppLogs,
    gatewayFailure,
    recordLog,
    routerUpnp,
    runMiniupnpc,
    loadSettings,
    saveSettings,
    restartHealthCheckTimer,
    checkPortHealth,
    testTcpPortForward,
    addPortForward,
    savePorts,
    startRefreshTimer,
    applyPortForward,
    removePortForward,
    stopRefreshTimer
  } = dependencies;

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

  app.get("/api/logs", requireAuth, (req, res) => {
    res.json(getAppLogs());
  });

  app.delete("/api/logs", requireAuth, (req, res) => {
    try {
      clearAppLogs();
      res.json({ success: true });
    } catch (error) {
      const message = `Could not clear app logs: ${error.message}`;
      recordLog("error", "Log storage", message);
      res.status(500).json({ error: message });
    }
  });

  app.get("/api/settings", requireAuth, (req, res) => {
    res.json({
      ...loadSettings(),
      routerUpnpCredentialsConfigured: routerUpnp.credentialsConfigured
    });
  });

  app.get("/api/router-upnp", requireAuth, (req, res) => {
    res.json(routerUpnp.getStatus());
  });

  app.get("/api/router-upnp/screenshot", requireAuth, (req, res) => {
    const screenshot = routerUpnp.getScreenshot();
    if (!screenshot.buffer) return res.status(204).end();
    if (req.query.after === screenshot.updatedAt) return res.status(204).end();
    res
      .status(200)
      .type("image/jpeg")
      .set("Cache-Control", "no-store, no-cache, must-revalidate")
      .set("X-Screenshot-Updated-At", screenshot.updatedAt || "")
      .send(screenshot.buffer);
  });

  app.post("/api/router-upnp/check", requireAuth, (req, res) => {
    if (!routerUpnp.isEnabled()) {
      return res.status(409).json({ error: "Enable router UPnP monitoring in Settings before running a check." });
    }
    if (!routerUpnp.credentialsConfigured) {
      return res.status(400).json({ error: "Set both router admin credentials in the app environment before checking." });
    }
    if (!routerUpnp.startCheck()) {
      return res.status(409).json({ error: "A router UPnP check is already in progress." });
    }
    res.status(202).json({ success: true });
  });

  app.get("/api/gateway", requireAuth, async (req, res) => {
    try {
      await runMiniupnpc(["-l"], 5000);
      gatewayFailure.logged = false;
      res.json({ connected: true, message: "UPnP gateway detected" });
    } catch (error) {
      const message = error.message || "No UPnP gateway detected";
      if (!gatewayFailure.logged) {
        recordLog("warning", "Gateway check", message);
        gatewayFailure.logged = true;
      }
      res.json({
        connected: false,
        message
      });
    }
  });

  app.put("/api/settings", requireAuth, async (req, res) => {
    const healthCheckIntervalSeconds = Number(req.body.healthCheckIntervalSeconds);
    const currentSettings = loadSettings();
    const routerUpnpCheckIntervalSeconds = Number(req.body.routerUpnpCheckIntervalSeconds === undefined
      ? currentSettings.routerUpnpCheckIntervalSeconds
      : req.body.routerUpnpCheckIntervalSeconds);
    const routerUpnpMonitorEnabled = req.body.routerUpnpMonitorEnabled === undefined
      ? currentSettings.routerUpnpMonitorEnabled
      : req.body.routerUpnpMonitorEnabled;
    if (!Number.isInteger(healthCheckIntervalSeconds) || healthCheckIntervalSeconds < 60 || healthCheckIntervalSeconds > 86400) {
      return res.status(400).json({ error: "Health check interval must be between 60 and 86400 seconds" });
    }
    if (!Number.isInteger(routerUpnpCheckIntervalSeconds) || routerUpnpCheckIntervalSeconds < 5 || routerUpnpCheckIntervalSeconds > 86400) {
      return res.status(400).json({ error: "Router UPnP check interval must be between 5 and 86400 seconds" });
    }
    if (typeof routerUpnpMonitorEnabled !== "boolean") {
      return res.status(400).json({ error: "Router UPnP monitoring must be enabled or disabled." });
    }
    if (routerUpnpMonitorEnabled && !routerUpnp.credentialsConfigured) {
      return res.status(400).json({ error: "Set both router admin credentials in the app environment before enabling monitoring." });
    }
    saveSettings({ ...currentSettings, healthCheckIntervalSeconds, routerUpnpCheckIntervalSeconds, routerUpnpMonitorEnabled });
    restartHealthCheckTimer();
    if (routerUpnpMonitorEnabled !== currentSettings.routerUpnpMonitorEnabled) {
      routerUpnp.configure(routerUpnpMonitorEnabled);
    } else if (routerUpnpCheckIntervalSeconds !== currentSettings.routerUpnpCheckIntervalSeconds) {
      routerUpnp.reschedule();
    }
    res.json({
      healthCheckIntervalSeconds,
      routerUpnpCheckIntervalSeconds,
      routerUpnpMonitorEnabled,
      routerUpnpCredentialsConfigured: routerUpnp.credentialsConfigured
    });
  });

  app.post("/api/ports/:id/test", requireAuth, async (req, res) => {
    const port = loadPorts().find(entry => entry.id === req.params.id);
    if (!port) {
      recordLog("warning", "Port test", `Port forward ${req.params.id} was not found.`);
      return res.status(404).json({ error: "Port forward not found" });
    }
    if (port.protocol === "UDP") {
      return res.json({
        reachable: false,
        message: "UDP ports cannot be verified with a TCP connection test."
      });
    }
    try {
      const result = await testTcpPortForward(port);
      if (!result.reachable) {
        recordLog("warning", "Port test", `Port ${port.externalPort} (${port.name}): ${result.message}`);
      }
      res.json(result);
    } catch (error) {
      recordLog("error", "Port test", `Could not test port ${port.externalPort} (${port.name}): ${error.message}`);
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
      recordLog("warning", "Port creation", "Could not create port forward: all fields are required.");
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
        recordLog("error", "Port creation", `Could not create port forward: ${error.message}`);
        res.status(502).json({ error: `Could not configure port forward: ${error.message}` });
      });
  });

  app.put("/api/ports/:id", requireAuth, async (req, res) => {
    const ports = loadPorts();
    const index = ports.findIndex(p => p.id === req.params.id);
    if (index === -1) {
      recordLog("warning", "Port update", `Port forward ${req.params.id} was not found.`);
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
      recordLog("error", "Port update", `Could not update port ${previous.externalPort} (${previous.name}): ${error.message}`);
      res.status(502).json({ error: `Could not configure port forward: ${error.message}` });
    }
  });

  app.delete("/api/ports/:id", requireAuth, async (req, res) => {
    const ports = loadPorts();
    const port = ports.find(p => p.id === req.params.id);
    if (!port) {
      recordLog("warning", "Port deletion", `Port forward ${req.params.id} was not found.`);
      return res.status(404).json({ error: "Port forward not found" });
    }
    try {
      if (port.enabled) await removePortForward(port);
      stopRefreshTimer(port.id);
      healthChecks.delete(port.id);
      savePorts(ports.filter(p => p.id !== req.params.id));
      res.json({ success: true });
    } catch (error) {
      recordLog("error", "Port deletion", `Could not delete port ${port.externalPort} (${port.name}): ${error.message}`);
      res.status(502).json({ error: `Could not remove port forward: ${error.message}` });
    }
  });

  app.post("/api/ports/delete", requireAuth, async (req, res) => {
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    if (!ids.length) {
      recordLog("warning", "Port deletion", "Could not delete selected ports: no entries were selected.");
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
      recordLog("error", "Port deletion", `Could not delete selected port forwards: ${error.message}`);
      res.status(502).json({ error: `Could not remove port forward: ${error.message}` });
    }
  });
}
module.exports = registerApiRoutes;