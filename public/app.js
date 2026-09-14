let ports = [];
let gatewayTimer;
let gatewayCheckInFlight = false;

const $ = id => document.getElementById(id);

const loginPage = $("loginPage");
const dashboard = $("dashboard");
const portsPage = $("portsPage");
const settingsPage = $("settingsPage");
const modal = $("modal");
const testModal = $("testModal");
const table = $("portsTable");
const empty = $("empty");
const search = $("search");
const selectAll = $("selectAll");
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
  loginPage.classList.remove("hidden");
  dashboard.classList.add("hidden");
  settingsPage.classList.add("hidden");
  clearInterval(gatewayTimer);
}

async function showDashboard() {
  loginPage.classList.add("hidden");
  dashboard.classList.remove("hidden");
  await loadPorts();
  showPortsPage();
  updateGatewayStatus();
  clearInterval(gatewayTimer);
  gatewayTimer = setInterval(updateGatewayStatus, 10000);
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
  } catch (error) {
    $("gatewayStatus").textContent = "Gateway check failed";
    $("gatewayStatus").title = error.message;
    $("gatewayStatusDot").className = "status-dot disconnected";
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
        <span class="badge ${port.enabled ? "" : "off"}">
          ${port.enabled ? "Active" : "Disabled"}
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
  deleteSelected.disabled = selected.length === 0;

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
$("portsNav").addEventListener("click", event => {
  event.preventDefault();
  showPortsPage();
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
  } catch (error) {
    status.textContent = "Failed";
    status.classList.add("failure");
    status.title = error.message;
    showTestResult(port, false, error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "Test";
  }
}

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
  portsPage.classList.remove("hidden");
  settingsPage.classList.add("hidden");
  $("portsNav").classList.add("active");
  $("settingsNav").classList.remove("active");
}

async function openSettings() {
  $("settingsError").textContent = "";
  portsPage.classList.add("hidden");
  settingsPage.classList.remove("hidden");
  $("portsNav").classList.remove("active");
  $("settingsNav").classList.add("active");

  try {
    const settings = await api("/api/settings");
    $("refreshDelay").value = settings.refreshDelaySeconds;
  } catch (error) {
    $("settingsError").textContent = error.message;
  }
}

$("settingsForm").addEventListener("submit", async event => {
  event.preventDefault();
  $("settingsError").textContent = "";

  try {
    await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        refreshDelaySeconds: Number($("refreshDelay").value)
      })
    });

    closeSettings();
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
  }
});

init();
