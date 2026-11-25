const { execFile } = require("child_process");
const https = require("https");
const net = require("net");

function createPortManagementService({ loadPorts, loadSettings, recordLog, config }) {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const MIN_FIRST_REFRESH_DELAY_MS = 6 * 60 * 60 * 1000;
  const MINIUPNPC_COMMAND = config.miniupnpcCommand;
  const refreshTimers = new Map();
  const healthChecks = new Map();
  let cachedPublicIp;
  let healthCheckTimer;
  let healthCheckInProgress = false;

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
        recordLog("error", "Port renewal", `Could not refresh port ${port.externalPort}: ${error.message}`);
      }

      try {
        const currentPort = loadPorts().find(entry => entry.id === port.id);
        if (currentPort && currentPort.enabled) {
          schedulePortRefresh(currentPort, getRandomRefreshDelay());
        }
      } catch (error) {
        recordLog("error", "Port renewal", `Could not schedule refresh for port ${port.externalPort}: ${error.message}`);
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
        recordLog("error", "Port setup", `Could not apply port ${port.externalPort}: ${error.message}`);
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
        recordLog("warning", "Health check", `Port ${port.externalPort} (${port.name}): ${result.message}`);
      }
    } catch (error) {
      const message = error.message || "Health check failed";
      healthChecks.set(port.id, { checkedAt, status: "error", message });
      recordLog("error", "Health check", `Could not check port ${port.externalPort} (${port.name}): ${message}`);
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
      recordLog("error", "Health check", `Could not load ports for health checks: ${error.message}`);
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

  function getPublicIp() {
    if (config.publicIp) return Promise.resolve(config.publicIp);
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

  return {
    healthChecks,
    runMiniupnpc,
    addPortForward,
    removePortForward,
    applyPortForward,
    stopRefreshTimer,
    startRefreshTimer,
    applyAllPortForwards,
    testTcpPortForward,
    checkPortHealth,
    runHealthChecks,
    restartHealthCheckTimer
  };
}

module.exports = createPortManagementService;
