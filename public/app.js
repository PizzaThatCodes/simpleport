let ports = [];
let logs = [];
let gatewayTimer;
let portsRefreshTimer;
let routerUpnpRefreshTimer;
let routerUpnpScreenRefreshTimer;
let gatewayCheckInFlight = false;
let portsRefreshInFlight = false;
let routerUpnpRefreshInFlight = false;
let routerUpnpScreenRefreshInFlight = false;
let routerUpnpLiveViewAvailable = false;
let routerUpnpScreenError = "";
let routerUpnpScreenDisplayedAt = "";
let testingSelected = false;

const $ = id => document.getElementById(id);

const loginPage = $("loginPage");
const dashboard = $("dashboard");
const portsPage = $("portsPage");
const settingsPage = $("settingsPage");
const logsPage = $("logsPage");
const routerUpnpPage = $("routerUpnpPage");
const modal = $("modal");
const testModal = $("testModal");
const table = $("portsTable");
const empty = $("empty");
const search = $("search");
const selectAll = $("selectAll");
const testSelected = $("testSelected");
const deleteSelected = $("deleteSelected");

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || "Request failed");
  }

  return data;
}

async function init() {
  try {
    const auth = await api("/api/auth");

    if (auth.authenticated) {
      showDashboard();
    } else {
      showLogin();
    }
  } catch {
    showLogin();
  }
}

function showLogin() {
  setRouterMonitorScrollLock(false);
  loginPage.classList.remove("hidden");
  dashboard.classList.add("hidden");
  settingsPage.classList.add("hidden");
  logsPage.classList.add("hidden");
  routerUpnpPage.classList.add("hidden");
  clearInterval(gatewayTimer);
  clearInterval(portsRefreshTimer);
  clearInterval(routerUpnpRefreshTimer);
  clearInterval(routerUpnpScreenRefreshTimer);
  clearRouterUpnpScreen();
}

async function showDashboard() {
  loginPage.classList.add("hidden");
  dashboard.classList.remove("hidden");
  await loadPorts();
  await refreshLogs();
  await refreshRouterUpnp();
  await showPageFromHash();
  updateGatewayStatus();
  clearInterval(gatewayTimer);
  gatewayTimer = setInterval(updateGatewayStatus, 10000);
  clearInterval(portsRefreshTimer);
  portsRefreshTimer = setInterval(refreshPortStatuses, 30000);
}

async function refreshPortStatuses() {
  if (portsRefreshInFlight) return;
  portsRefreshInFlight = true;

  try {
    ports = await api("/api/ports");
    for (const badge of table.querySelectorAll(".port-health-status")) {
      const port = ports.find(entry => entry.id === badge.dataset.healthId);
      if (port) updatePortHealthBadge(port, badge);
    }
    await refreshLogs();
  } catch (error) {
    console.error(`Could not refresh port statuses: ${error.message}`);
  } finally {
    portsRefreshInFlight = false;
  }
}

async function refreshLogs() {
  try {
    logs = await api("/api/logs");
    $("logsError").textContent = "";
    renderLogs();
  } catch (error) {
    $("logsError").textContent = error.message;
    console.error(`Could not load app logs: ${error.message}`);
  }
}

async function refreshRouterUpnp() {
  if (routerUpnpRefreshInFlight) return;
  routerUpnpRefreshInFlight = true;

  try {
    const monitor = await api("/api/router-upnp");
    $("routerUpnpError").textContent = "";
    renderRouterUpnp(monitor);
  } catch (error) {
    $("routerUpnpError").textContent = error.message;
    console.error(`Could not load router UPnP monitor status: ${error.message}`);
  } finally {
    routerUpnpRefreshInFlight = false;
  }
}

async function refreshRouterUpnpScreen(force = false) {
  if (routerUpnpScreenRefreshInFlight || (!routerUpnpLiveViewAvailable && !force) ||
      routerUpnpPage.classList.contains("hidden")) return;
  routerUpnpScreenRefreshInFlight = true;

  try {
    const response = await fetch(
      `/api/router-upnp/screenshot?after=${encodeURIComponent(routerUpnpScreenDisplayedAt)}`,
      {
        cache: "no-store"
      }
    );
    if (response.status === 204) return;
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || "Could not capture the router browser screen.");
    }

    const objectUrl = URL.createObjectURL(await response.blob());
    const image = $("routerUpnpScreen");
    const previousUrl = image.dataset.objectUrl;
    image.src = objectUrl;
    image.dataset.objectUrl = objectUrl;
    image.classList.remove("hidden");
    routerUpnpScreenDisplayedAt = response.headers.get("X-Screenshot-Updated-At") || "";
    if (previousUrl) URL.revokeObjectURL(previousUrl);

    routerUpnpScreenError = "";
    $("routerUpnpScreenHint").textContent = "Live browser screen; refreshes several times per second.";
  } catch (error) {
    routerUpnpScreenError = error.message;
    $("routerUpnpScreenHint").textContent = `Live screen capture failed: ${error.message}`;
  } finally {
    routerUpnpScreenRefreshInFlight = false;
  }
}

function clearRouterUpnpScreen() {
  const image = $("routerUpnpScreen");
  if (image.dataset.objectUrl) URL.revokeObjectURL(image.dataset.objectUrl);
  delete image.dataset.objectUrl;
  image.removeAttribute("src");
  image.classList.add("hidden");
  routerUpnpLiveViewAvailable = false;
  routerUpnpScreenError = "";
  routerUpnpScreenDisplayedAt = "";
}

function renderRouterUpnp(monitor) {
  const state = monitor.state;
  setRouterUpnpNavigationVisible(monitor.enabled);
  const badge = $("routerUpnpStatus");
  const statusLabels = {
    checking: "Checking",
    enabled: "UPnP enabled",
    error: "Error",
    disabled: "Disabled",
    idle: "Waiting"
  };
  const statusClass = ["checking", "enabled", "error", "disabled", "idle"].includes(state.status)
    ? state.status
    : "error";

  badge.className = `router-status-badge ${statusClass}`;
  badge.textContent = statusLabels[state.status] || "Unknown";
  $("routerUpnpStep").textContent = state.step;
  $("routerUpnpMessage").textContent = state.message;
  $("routerUpnpLastCheck").textContent = state.lastCheckAt
    ? new Date(state.lastCheckAt).toLocaleString()
    : "Never";
  $("routerUpnpNextCheck").textContent = state.nextCheckAt
    ? new Date(state.nextCheckAt).toLocaleString()
    : "Not scheduled";
  $("routerUpnpCheckButton").disabled = !monitor.enabled || monitor.checking;
  $("routerUpnpSettingsButton").classList.toggle("hidden", monitor.enabled);
  routerUpnpLiveViewAvailable = monitor.liveViewAvailable;

  const screenImage = $("routerUpnpScreen");
  const screenHint = $("routerUpnpScreenHint");
  if (!monitor.hasScreenshot) {
    if (screenImage.dataset.objectUrl) URL.revokeObjectURL(screenImage.dataset.objectUrl);
    delete screenImage.dataset.objectUrl;
    screenImage.removeAttribute("src");
    screenImage.classList.add("hidden");
  }
  if (routerUpnpScreenError) {
    screenHint.textContent = `Live screen capture failed: ${routerUpnpScreenError}`;
  } else if (monitor.screenshotError) {
    screenHint.textContent = `Live screen capture failed: ${monitor.screenshotError}`;
  } else if (monitor.liveViewAvailable) {
    screenHint.textContent = monitor.hasScreenshot
      ? "Live browser screen; refreshes several times per second."
      : "Browser started; waiting for the first screen capture.";
  } else if (monitor.hasScreenshot) {
    screenHint.textContent = "The check has ended; showing its last captured screen.";
  } else if (state.status === "error") {
    screenHint.textContent = "No screen was captured. See the current status for the browser error.";
  } else if (monitor.checking) {
    screenHint.textContent = "The browser is launching; the screen will appear when the router page opens.";
  } else if (monitor.enabled) {
    screenHint.textContent = "The monitor is enabled and waiting for its next check.";
  } else {
    screenHint.textContent = "Monitoring is off. Enable automatic UPnP recovery in Settings to start a check.";
  }
  if (!monitor.liveViewAvailable && monitor.hasScreenshot &&
      monitor.screenshotUpdatedAt !== routerUpnpScreenDisplayedAt) {
    refreshRouterUpnpScreen(true);
  }

  const events = $("routerUpnpEvents");

  if (!monitor.events.length) {
    const emptyState = document.createElement("p");
    emptyState.className = "router-monitor-empty";
    emptyState.textContent = "No monitor activity yet.";
    if (!events.querySelector(".router-monitor-empty")) {
      events.replaceChildren(emptyState);
    }
    return;
  }

  const emptyState = events.querySelector(".router-monitor-empty");
  if (emptyState) emptyState.remove();

  const existingEvents = new Map(
    [...events.querySelectorAll(".router-monitor-event")]
      .map(item => [item.dataset.activityId, item])
  );

  let index = 0;
  for (const entry of monitor.events) {
    const activityId = `${entry.timestamp}|${entry.status}|${entry.step}|${entry.message}`;
    let item = existingEvents.get(activityId);

    if (item) {
      existingEvents.delete(activityId);
    } else {
      item = document.createElement("article");
      item.className = `router-monitor-event ${entry.status} activity-enter`;
      item.dataset.activityId = activityId;

      const heading = document.createElement("div");
      heading.className = "router-monitor-event-heading";

      const step = document.createElement("strong");
      step.textContent = entry.step;

      const time = document.createElement("time");
      time.dateTime = entry.timestamp;
      time.textContent = new Date(entry.timestamp).toLocaleString();

      const message = document.createElement("p");
      message.textContent = entry.message;

      heading.append(step, time);
      item.append(heading, message);
    }

    if (events.children[index] !== item) {
      events.insertBefore(item, events.children[index] || null);
    }
    index += 1;
  }

  for (const item of existingEvents.values()) item.remove();
}

function setRouterUpnpNavigationVisible(visible) {
  $("routerUpnpNav").classList.toggle("hidden", !visible);
}

function renderLogs() {
  const nav = $("logsNav");
  nav.classList.remove("hidden");
  $("logCount").textContent = logs.length > 99 ? "99+" : String(logs.length);

  const list = $("logsList");
  list.replaceChildren();

  if (!logs.length) {
    const emptyState = document.createElement("p");
    emptyState.className = "logs-empty";
    emptyState.textContent = "No warnings or errors have been recorded.";
    list.appendChild(emptyState);
  }

  for (const entry of logs) {
    const item = document.createElement("article");
    item.className = `log-entry ${entry.level === "warning" ? "warning" : "error"}`;

    const header = document.createElement("div");
    header.className = "log-entry-header";

    const level = document.createElement("span");
    level.className = "log-level";
    level.textContent = entry.level.toUpperCase();

    const category = document.createElement("span");
    category.className = "log-category";
    category.textContent = entry.category;

    const time = document.createElement("time");
    time.className = "log-time";
    time.dateTime = entry.timestamp;
    time.textContent = new Date(entry.timestamp).toLocaleString();

    const message = document.createElement("p");
    message.className = "log-message";
    message.textContent = entry.message;

    header.append(level, category, time);
    item.append(header, message);
    list.appendChild(item);
  }

}

function getPortHealthDisplay(port) {
  const healthLabels = {
    up: "Up",
    down: "Down",
    error: "Check error",
    mapped: "Mapped (UDP)"
  };
  const healthClasses = {
    up: "health-up",
    down: "health-down",
    error: "health-error",
    mapped: "health-mapped"
  };

  if (!port.enabled) {
    return { label: "Disabled", className: "off", title: "This port forward is disabled." };
  }

  const health = port.health;
  if (!health) {
    return {
      label: "Checking...",
      className: "checking",
      title: "Waiting for the first automatic health check."
    };
  }

  return {
    label: healthLabels[health.status] || "Unknown",
    className: healthClasses[health.status] || "health-error",
    title: `Last check: ${new Date(health.checkedAt).toLocaleString()}\n${health.message}`
  };
}

function updatePortHealthBadge(port, badge) {
  const status = getPortHealthDisplay(port);
  badge.className = `badge port-health-status ${status.className}`;
  badge.textContent = status.label;
  badge.title = status.title;
  badge.setAttribute("aria-label", status.title);
}

async function updateGatewayStatus() {
  if (gatewayCheckInFlight) return;
  gatewayCheckInFlight = true;

  try {
    const gateway = await api("/api/gateway");
    const status = $("gatewayStatus");
    const dot = $("gatewayStatusDot");

    status.textContent = gateway.connected ? "Gateway connected" : "Gateway unavailable";
    status.title = gateway.message;
    dot.className = `status-dot ${gateway.connected ? "connected" : "disconnected"}`;
    if (!gateway.connected) await refreshLogs();
  } catch (error) {
    $("gatewayStatus").textContent = "Gateway check failed";
    $("gatewayStatus").title = error.message;
    $("gatewayStatusDot").className = "status-dot disconnected";
    await refreshLogs();
  } finally {
    gatewayCheckInFlight = false;
  }
}

async function loadPorts() {
  ports = await api("/api/ports");
  render();
}

function render() {
  const query = search.value.trim().toLowerCase();

  const filtered = ports.filter(port => {
    return [
      port.name,
      port.externalPort,
      port.internalPort,
      port.protocol,
      port.internalHost
    ].some(value => String(value).toLowerCase().includes(query));
  });

  table.innerHTML = "";

  filtered.forEach(port => {
    const row = document.createElement("tr");
    const status = getPortHealthDisplay(port);

    row.innerHTML = `
      <td>
        <input type="checkbox" class="row-check" data-id="${port.id}">
      </td>
      <td><span class="port-name">${escapeHtml(port.name)}</span></td>
      <td class="mono">${port.externalPort}</td>
      <td class="mono">${port.internalPort}</td>
      <td>${escapeHtml(port.protocol)}</td>
      <td class="mono">${escapeHtml(port.internalHost)}</td>
      <td>
        <span class="badge port-health-status ${status.className}" data-health-id="${escapeHtml(port.id)}" title="${escapeHtml(status.title)}" aria-label="${escapeHtml(status.title)}">
          ${escapeHtml(status.label)}
        </span>
      </td>
      <td>
        <button class="action-btn test-btn" data-id="${port.id}">Test</button>
        <button class="action-btn edit-btn" data-id="${port.id}">Edit</button>
        <span class="port-test-status" data-status-id="${port.id}" aria-live="polite"></span>
      </td>
    `;

    table.appendChild(row);
  });

  empty.classList.toggle("hidden", filtered.length !== 0);
  $("count").textContent = `${filtered.length} port forward${filtered.length === 1 ? "" : "s"}`;

  updateSelectionState();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function openCreate() {
  $("modalTitle").textContent = "Create port forward";
  $("editId").value = "";
  $("name").value = "";
  $("externalPort").value = "";
  $("internalPort").value = "";
  $("protocol").value = "TCP";
  $("internalHost").value = "";
  $("enabled").checked = true;
  $("formError").textContent = "";
  modal.classList.remove("hidden");
}

function openEdit(id) {
  const port = ports.find(p => p.id === id);
  if (!port) return;

  $("modalTitle").textContent = "Edit port forward";
  $("editId").value = port.id;
  $("name").value = port.name;
  $("externalPort").value = port.externalPort;
  $("internalPort").value = port.internalPort;
  $("protocol").value = port.protocol;
  $("internalHost").value = port.internalHost;
  $("enabled").checked = port.enabled;
  $("formError").textContent = "";
  modal.classList.remove("hidden");
}

function closeModal() {
  modal.classList.add("hidden");
}

function updateSelectionState() {
  const selected = [...document.querySelectorAll(".row-check:checked")];
  testSelected.disabled = selected.length === 0 || testingSelected;
  deleteSelected.disabled = selected.length === 0 || testingSelected;

  const checks = [...document.querySelectorAll(".row-check")];
  selectAll.checked = checks.length > 0 && selected.length === checks.length;
  selectAll.indeterminate = selected.length > 0 && selected.length < checks.length;
}

$("loginForm").addEventListener("submit", async event => {
  event.preventDefault();

  $("loginError").textContent = "";

  try {
    await api("/api/login", {
      method: "POST",
      body: JSON.stringify({
        username: $("username").value,
        password: $("password").value
      })
    });

    $("password").value = "";
    await showDashboard();
  } catch (error) {
    $("loginError").textContent = error.message;
  }
});

$("logoutBtn").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  showLogin();
});

$("createBtn").addEventListener("click", openCreate);
$("closeModal").addEventListener("click", closeModal);
$("cancelModal").addEventListener("click", closeModal);
$("modal").querySelector(".modal-backdrop").addEventListener("click", closeModal);
$("testModalClose").addEventListener("click", closeTestModal);
$("testModal").querySelector(".modal-backdrop").addEventListener("click", closeTestModal);
$("settingsNav").addEventListener("click", event => {
  event.preventDefault();
  openSettings();
});
$("routerUpnpNav").addEventListener("click", event => {
  event.preventDefault();
  showRouterUpnpPage();
});
$("logsNav").addEventListener("click", async event => {
  event.preventDefault();
  await refreshLogs();
  showLogsPage();
});
$("portsNav").addEventListener("click", event => {
  event.preventDefault();
  showPortsPage();
});
$("refreshLogsButton").addEventListener("click", refreshLogs);
$("routerUpnpCheckButton").addEventListener("click", async () => {
  $("routerUpnpError").textContent = "";
  $("routerUpnpCheckButton").disabled = true;

  try {
    await api("/api/router-upnp/check", { method: "POST" });
    await refreshRouterUpnp();
  } catch (error) {
    $("routerUpnpError").textContent = error.message;
    await refreshRouterUpnp();
  }
});
$("routerUpnpBackButton").addEventListener("click", showPortsPage);
$("routerUpnpSettingsButton").addEventListener("click", openSettings);
$("viewRouterUpnpButton").addEventListener("click", showRouterUpnpPage);
$("clearLogsButton").addEventListener("click", async () => {
  if (!confirm("Clear all saved app logs?")) return;

  $("logsError").textContent = "";
  try {
    await api("/api/logs", { method: "DELETE" });
    logs = [];
    renderLogs();
  } catch (error) {
    $("logsError").textContent = error.message;
    console.error(`Could not clear app logs: ${error.message}`);
  }
});
$("backToPorts").addEventListener("click", showPortsPage);

$("portForm").addEventListener("submit", async event => {
  event.preventDefault();
  $("formError").textContent = "";

  const id = $("editId").value;

  const data = {
    name: $("name").value,
    externalPort: Number($("externalPort").value),
    internalPort: Number($("internalPort").value),
    protocol: $("protocol").value,
    internalHost: $("internalHost").value,
    enabled: $("enabled").checked
  };

  try {
    if (id) {
      await api(`/api/ports/${id}`, {
        method: "PUT",
        body: JSON.stringify(data)
      });
    } else {
      await api("/api/ports", {
        method: "POST",
        body: JSON.stringify(data)
      });
    }

    closeModal();
    await loadPorts();
  } catch (error) {
    $("formError").textContent = error.message;
    await refreshLogs();
  }
});

search.addEventListener("input", render);

selectAll.addEventListener("change", () => {
  document.querySelectorAll(".row-check").forEach(check => {
    check.checked = selectAll.checked;
  });

  updateSelectionState();
});

table.addEventListener("change", event => {
  if (event.target.classList.contains("row-check")) {
    updateSelectionState();
  }
});

table.addEventListener("click", event => {
  const testButton = event.target.closest(".test-btn");
  if (testButton) {
    testPort(testButton.dataset.id, testButton);
    return;
  }

  const button = event.target.closest(".edit-btn");
  if (button) openEdit(button.dataset.id);
});

async function testPort(id, button) {
  const port = ports.find(entry => entry.id === id);
  if (!port) return;

  const status = document.querySelector(`[data-status-id="${id}"]`);
  button.disabled = true;
  button.textContent = "Testing...";
  status.textContent = "";
  status.className = "port-test-status";
  openTestModal(port);

  try {
    const result = await api(`/api/ports/${id}/test`, { method: "POST" });
    status.textContent = result.reachable ? "Open" : "Closed";
    status.classList.add(result.reachable ? "success" : "failure");
    status.title = result.message;
    showTestResult(port, result.reachable, result.message);
    if (!result.reachable) await refreshLogs();
    return result.reachable;
  } catch (error) {
    status.textContent = "Failed";
    status.classList.add("failure");
    status.title = error.message;
    showTestResult(port, false, error.message, true);
    await refreshLogs();
    return false;
  } finally {
    button.disabled = false;
    button.textContent = "Test";
  }
}

testSelected.addEventListener("click", async () => {
  const ids = [...document.querySelectorAll(".row-check:checked")]
    .map(check => check.dataset.id);

  if (!ids.length || testingSelected) return;

  testingSelected = true;
  updateSelectionState();

  let reachableCount = 0;

  try {
    for (const id of ids) {
      const button = document.querySelector(`.test-btn[data-id="${id}"]`);
      if (button && await testPort(id, button)) reachableCount += 1;
    }

    const allReachable = reachableCount === ids.length;
    $("testModalTitle").textContent = allReachable ? "All selected ports are open" : "Some selected ports are closed";
    $("testModalResult").textContent = `${reachableCount} of ${ids.length} selected port forwards are reachable.`;
    $("testModalResult").className = `test-modal-result ${allReachable ? "success" : "failure"}`;
  } finally {
    testingSelected = false;
    updateSelectionState();
  }
});

function openTestModal(port) {
  $("testModalTitle").textContent = `Testing ${port.name}...`;
  $("testModalResult").textContent = `Checking port rule ${port.externalPort} (${port.protocol})...`;
  $("testModalResult").className = "test-modal-result loading";
  testModal.classList.remove("hidden");
}

function showTestResult(port, reachable, message, failed = false) {
  const result = $("testModalResult");
  const outcome = failed ? "Test failed" : reachable ? "Open" : "Closed";

  $("testModalTitle").textContent = `${port.name}: ${outcome}`;
  result.textContent = `Port rule ${port.externalPort} (${port.protocol}) is ${failed ? "unavailable to test" : reachable ? "open" : "closed"}. ${message}`;
  result.className = `test-modal-result ${failed || !reachable ? "failure" : "success"}`;
}

function closeTestModal() {
  testModal.classList.add("hidden");
}

function showPortsPage() {
  setRouterMonitorScrollLock(false);
  clearInterval(routerUpnpRefreshTimer);
  clearInterval(routerUpnpScreenRefreshTimer);
  portsPage.classList.remove("hidden");
  settingsPage.classList.add("hidden");
  logsPage.classList.add("hidden");
  routerUpnpPage.classList.add("hidden");
  $("portsNav").classList.add("active");
  $("settingsNav").classList.remove("active");
  $("routerUpnpNav").classList.remove("active");
  $("logsNav").classList.remove("active");
  setPageHash("ports");
}

function showLogsPage() {
  setRouterMonitorScrollLock(false);
  clearInterval(routerUpnpRefreshTimer);
  clearInterval(routerUpnpScreenRefreshTimer);
  portsPage.classList.add("hidden");
  settingsPage.classList.add("hidden");
  logsPage.classList.remove("hidden");
  routerUpnpPage.classList.add("hidden");
  $("portsNav").classList.remove("active");
  $("settingsNav").classList.remove("active");
  $("routerUpnpNav").classList.remove("active");
  $("logsNav").classList.add("active");
  setPageHash("logs");
}

function showSettingsPage() {
  setRouterMonitorScrollLock(false);
  clearInterval(routerUpnpRefreshTimer);
  clearInterval(routerUpnpScreenRefreshTimer);
  portsPage.classList.add("hidden");
  logsPage.classList.add("hidden");
  routerUpnpPage.classList.add("hidden");
  settingsPage.classList.remove("hidden");
  $("portsNav").classList.remove("active");
  $("settingsNav").classList.add("active");
  $("routerUpnpNav").classList.remove("active");
  $("logsNav").classList.remove("active");
  setPageHash("settings");
}

function showRouterUpnpPage() {
  setRouterMonitorScrollLock(true);
  portsPage.classList.add("hidden");
  settingsPage.classList.add("hidden");
  logsPage.classList.add("hidden");
  routerUpnpPage.classList.remove("hidden");
  $("portsNav").classList.remove("active");
  $("settingsNav").classList.remove("active");
  $("routerUpnpNav").classList.add("active");
  $("logsNav").classList.remove("active");
  setPageHash("router-monitor");
  clearInterval(routerUpnpRefreshTimer);
  clearInterval(routerUpnpScreenRefreshTimer);
  refreshRouterUpnp();
  refreshRouterUpnpScreen();
  routerUpnpRefreshTimer = setInterval(refreshRouterUpnp, 500);
  routerUpnpScreenRefreshTimer = setInterval(refreshRouterUpnpScreen, 300);
}

function setRouterMonitorScrollLock(locked) {
  document.documentElement.classList.toggle("router-monitor-open", locked);
  document.body.classList.toggle("router-monitor-open", locked);
}

function setPageHash(page) {
  const hash = `#${page}`;
  window.scrollTo(0, 0);
  if (window.location.hash === hash) return;
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${hash}`);
}

async function showPageFromHash() {
  switch (window.location.hash) {
    case "#settings":
      await openSettings();
      break;
    case "#logs":
      showLogsPage();
      break;
    case "#router-monitor":
      showRouterUpnpPage();
      break;
    default:
      showPortsPage();
  }
}

async function openSettings() {
  $("settingsError").textContent = "";
  showSettingsPage();

  try {
    const settings = await api("/api/settings");
    $("healthCheckInterval").value = settings.healthCheckIntervalSeconds;
    $("routerUpnpCheckInterval").value = settings.routerUpnpCheckIntervalSeconds;
    $("routerUpnpMonitorEnabled").checked = settings.routerUpnpMonitorEnabled;
    setRouterUpnpNavigationVisible(settings.routerUpnpMonitorEnabled);
    $("routerUpnpCredentialsHelp").textContent = settings.routerUpnpCredentialsConfigured
      ? "Router credentials are configured privately in the app environment."
      : settings.routerUpnpMonitorEnabled
        ? "Router credentials are missing. Add both admin credentials in the app environment or turn monitoring off."
        : "Add ROUTER_ADMIN_USERNAME and ROUTER_ADMIN_PASSWORD to the app environment before saving this switch as enabled.";
    $("viewRouterUpnpButton").classList.toggle("hidden", !settings.routerUpnpMonitorEnabled);
  } catch (error) {
    $("settingsError").textContent = error.message;
  }
}

$("settingsForm").addEventListener("submit", async event => {
  event.preventDefault();
  $("settingsError").textContent = "";

  try {
    const settings = await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        healthCheckIntervalSeconds: Number($("healthCheckInterval").value),
        routerUpnpCheckIntervalSeconds: Number($("routerUpnpCheckInterval").value),
        routerUpnpMonitorEnabled: $("routerUpnpMonitorEnabled").checked
      })
    });

    setRouterUpnpNavigationVisible(settings.routerUpnpMonitorEnabled);
    await refreshRouterUpnp();
  } catch (error) {
    $("settingsError").textContent = error.message;
  }
});

deleteSelected.addEventListener("click", async () => {
  const ids = [...document.querySelectorAll(".row-check:checked")]
    .map(check => check.dataset.id);

  if (!ids.length) return;

  if (!confirm(`Delete ${ids.length} selected port forward${ids.length === 1 ? "" : "s"}?`)) {
    return;
  }

  try {
    await api("/api/ports/delete", {
      method: "POST",
      body: JSON.stringify({ ids })
    });

    await loadPorts();
  } catch (error) {
    alert(error.message);
    await refreshLogs();
  }
});

init();
