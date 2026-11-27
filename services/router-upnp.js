const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");

function createRouterUpnpService({ loadSettings, recordLog, config }) {
  const ROUTER_ADMIN_URL = config.routerAdminUrl;
  const ROUTER_ADMIN_USERNAME = config.routerAdminUsername;
  const ROUTER_ADMIN_PASSWORD = config.routerAdminPassword;
  const ROUTER_UPNP_CREDENTIALS_CONFIGURED = config.credentialsConfigured;
  const MAX_ROUTER_UPNP_EVENTS = config.maxEvents;
  let routerUpnpCheckInProgress = false;
  let routerUpnpCheckGeneration = 0;
  let routerUpnpTimer;
  let routerUpnpBrowser;
  let routerUpnpPage;
  let routerUpnpScreenshot;
  let routerUpnpScreenshotUpdatedAt;
  let routerUpnpScreenshotError;
  let routerUpnpEvents = [];
  let routerUpnpState = {
    status: "disabled",
    step: "Disabled",
    message: "Router UPnP monitoring is disabled in Settings.",
    lastCheckAt: null,
    nextCheckAt: null,
    updatedAt: new Date().toISOString()
  };

  async function findVisibleElement(page, selector) {
    for (const element of await page.$$(selector)) {
      const visible = await element.evaluate(node => {
        const bounds = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return bounds.width > 0 && bounds.height > 0 &&
          style.visibility !== "hidden" && style.display !== "none";
      });

      if (visible) return element;
      await element.dispose();
    }

    return null;
  }

  async function disposeElements(...elements) {
    await Promise.all(elements.filter(Boolean).map(async element => {
      try {
        await element.dispose();
      } catch (error) {
        recordLog("warning", "Router UPnP", `Could not release a router page element: ${error.message}`);
      }
    }));
  }

  async function findRouterTextControl(page, labels, description) {
    const expected = labels.map(label => label.toLowerCase());
    const matches = [];

    for (const element of await page.$$('a, button, [role="button"], [role="link"], [role="menuitem"], input[type="submit"], input[type="button"]')) {
      const details = await element.evaluate(node => {
        const bounds = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return {
          text: (node.innerText || node.value || node.getAttribute("aria-label") || "").trim().toLowerCase(),
          visible: bounds.width > 0 && bounds.height > 0 &&
            style.visibility !== "hidden" && style.display !== "none"
        };
      });

      if (details.visible && expected.includes(details.text)) {
        matches.push(element);
      } else {
        await element.dispose();
      }
    }

    if (matches.length !== 1) {
      throw new Error(`Could not uniquely identify the router ${description}.`);
    }

    return matches[0];
  }

  async function waitForRouterTextControl(page, labels, description) {
    const expected = labels.map(label => label.toLowerCase());
    const selector = 'a, button, [role="button"], [role="link"], [role="menuitem"], input[type="submit"], input[type="button"]';

    await page.waitForFunction((expectedLabels, controlSelector) => {
      return [...document.querySelectorAll(controlSelector)].some(node => {
        const bounds = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        const text = (node.innerText || node.value || node.getAttribute("aria-label") || "").trim().toLowerCase();
        return bounds.width > 0 && bounds.height > 0 &&
          style.visibility !== "hidden" && style.display !== "none" &&
          expectedLabels.includes(text);
      });
    }, { timeout: 10000 }, expected, selector);

    return findRouterTextControl(page, labels, description);
  }

  async function loginToRouter(page) {
    const passwordInput = await findVisibleElement(page, 'input[type="password"]');
    if (!passwordInput) return;
    let usernameInput;
    let loginButton;

    try {
      usernameInput = await findVisibleElement(
        page,
        'input[autocomplete="username"], input[name*="user" i], input[id*="user" i], input[type="email"], input[type="text"]'
      );

      if (usernameInput) {
        await usernameInput.click({ clickCount: 3 });
        await usernameInput.type(ROUTER_ADMIN_USERNAME);
      }

      await passwordInput.click({ clickCount: 3 });
      await passwordInput.type(ROUTER_ADMIN_PASSWORD);

      loginButton = await findRouterTextControl(
        page,
        ["login", "log in", "sign in", "submit"],
        "login button"
      );
      await loginButton.click();
      await new Promise(resolve => setTimeout(resolve, 750));
    } finally {
      await disposeElements(usernameInput, passwordInput, loginButton);
    }
  }

  async function captureRouterUpnpScreenshot(page) {
    try {
      routerUpnpScreenshot = await page.screenshot({
        type: "jpeg",
        quality: 65
      });
      routerUpnpScreenshotUpdatedAt = new Date().toISOString();
      routerUpnpScreenshotError = null;
    } catch (error) {
      if (routerUpnpScreenshotError !== error.message) {
        recordLog("warning", "Router UPnP", `Could not refresh the live browser screen: ${error.message}`);
      }
      routerUpnpScreenshotError = error.message;
    }
  }

  async function clickRouterNavigationControl(page, control, generation) {
    try {
      const href = await control.evaluate(node => node.getAttribute("href"));
      let navigation;
      if (href && href !== "#" && !href.toLowerCase().startsWith("javascript:")) {
        navigation = page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 })
          .then(() => true)
          .catch(error => {
            if (error.name === "TimeoutError") return false;
            throw error;
          });
      }

      await control.click();
      if (navigation) await navigation;
      requireRouterUpnpMonitorEnabled(generation);
      await captureRouterUpnpScreenshot(page);
    } finally {
      await disposeElements(control);
    }
  }

  async function openRouterUpnpSettings(page, generation) {
    const currentPath = new URL(page.url()).pathname;
    if (/\/device_discovery\.jst$/i.test(currentPath)) {
      await page.waitForSelector("#upnp_enabled", { timeout: 10000 });
      return;
    }

    const advanced = await waitForRouterTextControl(page, ["advanced"], "Advanced navigation item");
    await clickRouterNavigationControl(page, advanced, generation);

    const discovery = await waitForRouterTextControl(
      page,
      ["device discovery"],
      "Device Discovery navigation item"
    );
    await clickRouterNavigationControl(page, discovery, generation);

    const destinationPath = new URL(page.url()).pathname;
    if (/\/device_discovery\.jst$/i.test(destinationPath)) {
      await page.waitForSelector("#upnp_enabled", { timeout: 10000 });
    }
  }

  async function findKnownRouterUpnpToggle(page) {
    const matches = [];

    for (const frame of page.frames()) {
      const enabledControl = await frame.$("#upnp_enabled");
      const disabledControl = await frame.$("#upnp_disabled");
      if (!enabledControl || !disabledControl) {
        if (enabledControl) await enabledControl.dispose();
        if (disabledControl) await disabledControl.dispose();
        continue;
      }

      const details = await enabledControl.evaluate(node => {
        const disabled = document.querySelector("#upnp_disabled");
        const radioEnabled = node.checked;
        const jquery = window.jQuery || window.$;
        let enabled = radioEnabled;
        if (jquery && jquery.fn && typeof jquery.fn.radioswitch === "function") {
          const state = jquery(node.closest("#upnp_switch")).radioswitch("getState");
          if (state && typeof state.on === "boolean") enabled = state.on;
        }

        return {
          isExpectedSwitch: node.id === "upnp_enabled" &&
            node.type === "radio" &&
            node.name === "upnp" &&
            Boolean(node.closest("#upnp_switch")) &&
            disabled &&
            disabled.type === "radio" &&
            disabled.name === node.name,
          enabled,
          radioEnabled,
          disabledChecked: Boolean(disabled && disabled.checked)
        };
      });

      if (!details.isExpectedSwitch || details.radioEnabled === details.disabledChecked) {
        await enabledControl.dispose();
        await disabledControl.dispose();
        continue;
      }

      let clickTarget = await frame.$('label[for="upnp_enabled"]');
      if (clickTarget) {
        const visible = await clickTarget.evaluate(node => {
          const bounds = node.getBoundingClientRect();
          const style = window.getComputedStyle(node);
          return bounds.width > 0 && bounds.height > 0 &&
            style.visibility !== "hidden" && style.display !== "none";
        });
        if (!visible) {
          await clickTarget.dispose();
          clickTarget = null;
        }
      }
      if (!clickTarget) clickTarget = await frame.$('#upnp-switch a[role="radio"]');
      if (!clickTarget) clickTarget = enabledControl;
      else await enabledControl.dispose();

      await disabledControl.dispose();
      matches.push({ element: clickTarget, enabled: details.enabled });
    }

    if (matches.length === 1) return matches[0];
    for (const match of matches) await match.element.dispose();
    if (matches.length > 1) {
      throw new Error("Found the UPnP radio switch in more than one router frame.");
    }

    return null;
  }

  async function findUpnpToggle(page) {
    const knownToggle = await findKnownRouterUpnpToggle(page);
    if (knownToggle) return knownToggle;

    const selector = [
      'input[type="checkbox"]',
      'input[type="radio"]',
      '[role="switch"]',
      "[aria-checked]",
      "[aria-pressed]",
      "[data-state]",
      "[data-checked]",
      "button",
      '[role="button"]',
      "label"
    ].join(", ");
    const deadline = Date.now() + 10000;
    let diagnostic = "";

    while (Date.now() < deadline) {
      const matches = [];

      for (const frame of page.frames()) {
        const seenControls = new Set();
        for (const element of await frame.$$(selector)) {
          const details = await element.evaluate(node => {
            const isVisible = candidate => {
              if (!candidate) return false;
              const bounds = candidate.getBoundingClientRect();
              const style = window.getComputedStyle(candidate);
              return bounds.width > 0 && bounds.height > 0 &&
                style.visibility !== "hidden" && style.display !== "none";
            };
            const controlSelector = [
              'input[type="checkbox"]',
              'input[type="radio"]',
              '[role="switch"]',
              "[aria-checked]",
              "[aria-pressed]",
              "[data-state]",
              "[data-checked]",
              "select"
            ].join(", ");
            const control = node.tagName === "LABEL"
              ? node.control || node.querySelector(controlSelector)
              : node;
            const labelTexts = node.labels
              ? [...node.labels].map(label => label.innerText || label.textContent || "")
              : [];
            if (node.tagName === "LABEL") labelTexts.push(node.innerText || node.textContent || "");

            const ancestorTexts = [];
            let ancestor = node.parentElement;
            for (let depth = 0; ancestor && depth < 4; depth += 1) {
              const text = ancestor.innerText || "";
              ancestorTexts.push(text);
              if (/upnp|universal\s+plug/i.test(text)) break;
              ancestor = ancestor.parentElement;
            }

            const directText = [
              node.innerText,
              node.textContent,
              node.getAttribute("aria-label"),
              node.getAttribute("title")
            ].filter(Boolean).join(" ").trim();
            const context = [
              node.getAttribute("aria-label"),
              node.getAttribute("title"),
              node.getAttribute("name"),
              node.id,
              ...labelTexts,
              directText,
              ...ancestorTexts
            ].filter(Boolean).join(" ");
            const matchesUpnp = /upnp|universal\s+plug/i.test(context);
            const visible = isVisible(node);

            let enabled = null;
            if (control) {
              if (control.type === "checkbox") {
                enabled = control.checked;
              } else if (control.type === "radio" && control.name) {
                const selected = [...document.querySelectorAll('input[type="radio"]')]
                  .find(radio => radio.name === control.name && radio.checked);
                if (selected) {
                  const selectedLabels = selected.labels
                    ? [...selected.labels].map(label => label.innerText || label.textContent || "")
                    : [];
                  const selectedText = [selected.value, ...selectedLabels].join(" ");
                  enabled = /\b(?:enabled|on|active|yes|true|1|enable)\b/i.test(selectedText)
                    ? true
                    : /\b(?:disabled|off|inactive|no|false|0|disable)\b/i.test(selectedText)
                      ? false
                      : null;
                }
              } else if (control.tagName === "SELECT") {
                enabled = /^(on|enabled|true|1)$/i.test(control.value)
                  ? true
                  : /^(off|disabled|false|0)$/i.test(control.value)
                    ? false
                    : null;
              } else {
                const state = [
                  control.getAttribute("aria-checked"),
                  control.getAttribute("aria-pressed"),
                  control.getAttribute("data-state"),
                  control.getAttribute("data-checked")
                ].find(value => value !== null);
                enabled = /^(true|checked|on|enabled|active|1)$/i.test(String(state))
                  ? true
                  : /^(false|unchecked|off|disabled|inactive|0)$/i.test(String(state))
                    ? false
                    : null;
              }
            }

            if (enabled === null) {
              const stateText = `${directText} ${node.getAttribute("aria-label") || ""} ${node.getAttribute("title") || ""}`;
              enabled = /\b(?:upnp\s*(?:is\s*)?)?(?:enabled|on|active)\b/i.test(stateText)
                ? true
                : /\b(?:upnp\s*(?:is\s*)?)?(?:disabled|off|inactive)\b/i.test(stateText)
                  ? false
                  : /\b(?:disable|turn off|switch off)\s+upnp\b/i.test(stateText)
                    ? true
                    : /\b(?:enable|turn on|switch on)\s+upnp\b/i.test(stateText)
                      ? false
                      : null;
            }

            const identity = control && (
              control.id ||
              control.name ||
              control.getAttribute("aria-label") ||
              control.getAttribute("data-testid")
            );
            const key = `${control ? control.tagName : node.tagName}:${identity || context}`;

            return {
              matchesUpnp,
              visible,
              enabled,
              key,
              context: context.replace(/\s+/g, " ").trim().slice(0, 160)
            };
          });

          if (details.matchesUpnp && details.visible && !seenControls.has(details.key)) {
            seenControls.add(details.key);
            matches.push({ element, enabled: details.enabled, context: details.context });
          } else {
            await element.dispose();
          }
        }
      }

      if (matches.length === 1 && matches[0].enabled !== null) {
        const match = matches[0];
        return { element: match.element, enabled: match.enabled };
      }

      if (matches.length) {
        diagnostic = matches
          .map(match => `${match.context || "UPnP control"} (state ${match.enabled === null ? "unknown" : match.enabled ? "on" : "off"})`)
          .join("; ");
      }
      for (const match of matches) await match.element.dispose();
      await new Promise(resolve => setTimeout(resolve, 250));
    }

    throw new Error(
      diagnostic
        ? `Could not safely determine the UPnP setting state. Matching controls: ${diagnostic}`
        : "Could not find a visible UPnP control in the router page or its frames."
    );
  }

  async function waitForUpnpToggleState(page, expectedEnabled, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const toggle = await findUpnpToggle(page);
      const enabled = toggle.enabled;
      await toggle.element.dispose();
      if (enabled === expectedEnabled) return true;
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    return false;
  }

  function updateRouterUpnpState(status, step, message, options = {}) {
    const timestamp = new Date().toISOString();
    routerUpnpState = {
      ...routerUpnpState,
      status,
      step,
      message,
      updatedAt: timestamp,
      ...(Object.prototype.hasOwnProperty.call(options, "lastCheckAt")
        ? { lastCheckAt: options.lastCheckAt }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(options, "nextCheckAt")
        ? { nextCheckAt: options.nextCheckAt }
        : {})
    };

    if (options.event === false) return;

    routerUpnpEvents.unshift({ timestamp, status, step, message });
    routerUpnpEvents = routerUpnpEvents.slice(0, MAX_ROUTER_UPNP_EVENTS);
  }

  function isRouterUpnpMonitorEnabled() {
    return loadSettings().routerUpnpMonitorEnabled === true;
  }

  function requireRouterUpnpMonitorEnabled(generation) {
    if (!isRouterUpnpMonitorEnabled() || generation !== routerUpnpCheckGeneration) {
      throw new Error("Router UPnP monitoring was disabled in Settings.");
    }
  }

  function getRouterBrowserExecutablePath() {
    const configuredPath = process.env.PUPPETEER_EXECUTABLE_PATH;
    if (configuredPath) {
      if (!fs.existsSync(configuredPath)) {
        throw new Error(`PUPPETEER_EXECUTABLE_PATH does not exist: ${configuredPath}`);
      }
      return configuredPath;
    }

    let candidates = [];
    if (process.platform === "win32") {
      const programFiles = process.env.ProgramFiles || "C:\\Program Files";
      const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
      const localAppData = process.env.LOCALAPPDATA || "";
      candidates = [
        path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(localAppData, "Microsoft", "Edge", "Application", "msedge.exe")
      ];
    } else if (process.platform === "darwin") {
      candidates = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
      ];
    } else {
      candidates = [
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable"
      ];
    }

    const executablePath = candidates.find(candidate => fs.existsSync(candidate));
    if (!executablePath) {
      throw new Error("Could not find Chrome, Edge, or Chromium. Install a supported browser or set PUPPETEER_EXECUTABLE_PATH.");
    }

    return executablePath;
  }

  async function checkAndEnableRouterUpnp(generation) {
    if (routerUpnpCheckInProgress || !isRouterUpnpMonitorEnabled()) return;
    routerUpnpCheckInProgress = true;
    let browser;
    let page;
    routerUpnpScreenshot = undefined;
    routerUpnpScreenshotUpdatedAt = undefined;
    routerUpnpScreenshotError = null;

    try {
      updateRouterUpnpState("checking", "Starting browser", "Launching the router-check browser.", {
        nextCheckAt: null
      });
      browser = await puppeteer.launch({
        headless: true,
        executablePath: getRouterBrowserExecutablePath(),
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--ignore-certificate-errors"
        ]
      });
      routerUpnpBrowser = browser;
      requireRouterUpnpMonitorEnabled(generation);
      page = await browser.newPage();
      routerUpnpPage = page;
      page.setDefaultTimeout(10000);
      page.on("dialog", dialog => {
        const action = dialog.type() === "prompt" ? dialog.dismiss() : dialog.accept();
        action.catch(error => {
          if (browser.connected) {
            recordLog("error", "Router UPnP", `Could not respond to a router dialog: ${error.message}`);
          }
        });
      });
      await page.setRequestInterception(true);
      page.on("request", request => {
        const requestedUrl = new URL(request.url());
        const isHttpRequest = ["http:", "https:"].includes(requestedUrl.protocol);
        const isRouterRequest = isHttpRequest && requestedUrl.hostname === "10.0.0.1";
        const action = !isHttpRequest || isRouterRequest ? request.continue() : request.abort();
        action.catch(error => {
          if (browser.connected) {
            recordLog("error", "Router UPnP", `Could not process a router page request: ${error.message}`);
          }
        });
      });

      updateRouterUpnpState("checking", "Connecting to router", "Opening the router admin page.");
      await page.goto(ROUTER_ADMIN_URL, { waitUntil: "domcontentloaded", timeout: 15000 });
      await captureRouterUpnpScreenshot(page);
      requireRouterUpnpMonitorEnabled(generation);
      updateRouterUpnpState("checking", "Signing in", "Checking the router admin session.");
      await loginToRouter(page);
      await captureRouterUpnpScreenshot(page);
      requireRouterUpnpMonitorEnabled(generation);
      updateRouterUpnpState("checking", "Opening Device Discovery", "Navigating to Advanced > Device Discovery.");
      await openRouterUpnpSettings(page, generation);

      requireRouterUpnpMonitorEnabled(generation);
      updateRouterUpnpState("checking", "Reading UPnP setting", "Inspecting the router UPnP control.");
      const upnpToggle = await findUpnpToggle(page);
      const checkedAt = new Date().toISOString();
      if (upnpToggle.enabled) {
        await disposeElements(upnpToggle.element);
        updateRouterUpnpState("enabled", "Check complete", "UPnP is already enabled on the router.", {
          lastCheckAt: checkedAt,
          nextCheckAt: null
        });
        return;
      }

      updateRouterUpnpState("checking", "Enabling UPnP", "UPnP is off; enabling the router setting.");
      try {
        requireRouterUpnpMonitorEnabled(generation);
        await upnpToggle.element.click();
        requireRouterUpnpMonitorEnabled(generation);
      } finally {
        await disposeElements(upnpToggle.element);
      }
      if (!await waitForUpnpToggleState(page, true)) {
        throw new Error("The router UPnP control still reports disabled after clicking Enable.");
      }
      await captureRouterUpnpScreenshot(page);

      updateRouterUpnpState("checking", "Saving setting", "Saving the UPnP change on the router.");
      const knownSaveButton = await findVisibleElement(page, "#save_setting");
      const saveButton = knownSaveButton || await findRouterTextControl(
        page,
        ["save", "save changes", "save settings", "apply"],
        "settings save button"
      );
      try {
        requireRouterUpnpMonitorEnabled(generation);
        const saveResponse = knownSaveButton
          ? page.waitForResponse(response => {
            const request = response.request();
            return request.method() === "POST" &&
              new URL(response.url()).pathname.toLowerCase().endsWith(
                "/actionhandler/ajaxset_upnp_configuration.jst"
              );
          }, { timeout: 5000 }).catch(error => {
            if (error.name === "TimeoutError") {
              throw new Error("The router did not complete its UPnP save request within 5 seconds.");
            }
            throw error;
          })
          : null;
        const saveNavigation = page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 5000 })
          .then(() => true)
          .catch(error => {
            if (error.name === "TimeoutError") return false;
            throw error;
          });
        await saveButton.click();
        if (saveResponse) {
          const response = await saveResponse;
          if (!response.ok()) {
            throw new Error(`The router rejected the UPnP save request (HTTP ${response.status()}).`);
          }
        }
        await saveNavigation;
      } finally {
        await disposeElements(saveButton);
      }
      await captureRouterUpnpScreenshot(page);

      requireRouterUpnpMonitorEnabled(generation);
      await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
      await captureRouterUpnpScreenshot(page);
      requireRouterUpnpMonitorEnabled(generation);
      await loginToRouter(page);
      requireRouterUpnpMonitorEnabled(generation);
      await openRouterUpnpSettings(page, generation);
      requireRouterUpnpMonitorEnabled(generation);
      const savedToggle = await findUpnpToggle(page);
      try {
        if (!savedToggle.enabled) {
          throw new Error("The router did not retain the enabled UPnP setting after saving.");
        }
      } finally {
        await disposeElements(savedToggle.element);
      }

      recordLog("warning", "Router UPnP", "UPnP was disabled; SimplePort enabled it and verified the saved setting.");
      updateRouterUpnpState("enabled", "Check complete", "UPnP was disabled; SimplePort enabled and verified it.", {
        lastCheckAt: new Date().toISOString(),
        nextCheckAt: null
      });
    } catch (error) {
      if (generation !== routerUpnpCheckGeneration) {
        if (!isRouterUpnpMonitorEnabled()) {
          updateRouterUpnpState("disabled", "Disabled", "Router UPnP monitoring is disabled in Settings.", {
            nextCheckAt: null
          });
        }
      } else if (!isRouterUpnpMonitorEnabled()) {
        updateRouterUpnpState("disabled", "Disabled", "Router UPnP monitoring is disabled in Settings.", {
          nextCheckAt: null
        });
      } else {
        recordLog("error", "Router UPnP", `Could not verify or enable UPnP: ${error.message}`);
        updateRouterUpnpState("error", "Check failed", error.message, {
          lastCheckAt: new Date().toISOString(),
          nextCheckAt: null
        });
      }
    } finally {
      if (page && browser && browser.connected) {
        await captureRouterUpnpScreenshot(page);
      }
      if (page && !page.isClosed()) {
        try {
          await page.close();
        } catch (error) {
          if (isRouterUpnpMonitorEnabled()) {
            recordLog("error", "Router UPnP", `Could not close the router-check page: ${error.message}`);
          }
        }
      }
      if (browser) {
        try {
          if (browser.connected) await browser.close();
        } catch (error) {
          if (isRouterUpnpMonitorEnabled()) {
            recordLog("error", "Router UPnP", `Could not close the router-check browser: ${error.message}`);
          }
        }
      }
      if (routerUpnpBrowser === browser) routerUpnpBrowser = null;
      if (routerUpnpPage === page) routerUpnpPage = null;
      routerUpnpCheckInProgress = false;
    }
  }

  function scheduleRouterUpnpCheck() {
    clearTimeout(routerUpnpTimer);
    routerUpnpTimer = undefined;
    if (!isRouterUpnpMonitorEnabled()) return;

    const delay = loadSettings().routerUpnpCheckIntervalSeconds * 1000;
    const nextCheckAt = new Date(Date.now() + delay).toISOString();
    routerUpnpState = { ...routerUpnpState, nextCheckAt, updatedAt: new Date().toISOString() };
    routerUpnpTimer = setTimeout(() => {
      routerUpnpTimer = undefined;
      startRouterUpnpCheck();
    }, delay);
  }

  function startRouterUpnpCheck() {
    if (!isRouterUpnpMonitorEnabled()) return false;
    if (routerUpnpCheckInProgress) return false;

    routerUpnpEvents = [];
    clearTimeout(routerUpnpTimer);
    routerUpnpTimer = undefined;
    const generation = routerUpnpCheckGeneration;

    checkAndEnableRouterUpnp(generation)
      .catch(error => {
        if (generation !== routerUpnpCheckGeneration || !isRouterUpnpMonitorEnabled()) return;
        recordLog("error", "Router UPnP", `Could not run router check: ${error.message}`);
        updateRouterUpnpState("error", "Check failed", error.message, {
          lastCheckAt: new Date().toISOString(),
          nextCheckAt: null
        });
      })
      .finally(() => {
        if (!isRouterUpnpMonitorEnabled()) return;
        if (generation !== routerUpnpCheckGeneration) {
          startRouterUpnpCheck();
        } else {
          scheduleRouterUpnpCheck();
        }
      });

    return true;
  }

  function rescheduleRouterUpnpCheck() {
    if (!isRouterUpnpMonitorEnabled() || routerUpnpCheckInProgress) return;
    scheduleRouterUpnpCheck();
  }

  function configureRouterUpnpMonitor(enabled) {
    if (enabled) {
      updateRouterUpnpState("idle", "Starting", "Router UPnP monitoring was enabled.");
      startRouterUpnpCheck();
      return;
    }

    clearTimeout(routerUpnpTimer);
    routerUpnpTimer = undefined;
    routerUpnpCheckGeneration += 1;
    updateRouterUpnpState("disabled", "Disabled", "Router UPnP monitoring is disabled in Settings.", {
      nextCheckAt: null
    });
    if (routerUpnpBrowser && routerUpnpBrowser.connected) {
      routerUpnpBrowser.close().catch(error => {
        recordLog("error", "Router UPnP", `Could not stop the router-check browser: ${error.message}`);
      });
    }
  }

  function startRouterUpnpMonitor() {
    if (!isRouterUpnpMonitorEnabled()) {
      updateRouterUpnpState("disabled", "Disabled", "Router UPnP monitoring is disabled in Settings.", {
        nextCheckAt: null
      });
      return;
    }

    if (!ROUTER_UPNP_CREDENTIALS_CONFIGURED) {
      const message = "Set both ROUTER_ADMIN_USERNAME and ROUTER_ADMIN_PASSWORD to use router UPnP monitoring.";
      recordLog("error", "Router UPnP", message);
      updateRouterUpnpState("error", "Configuration required", message, {
        lastCheckAt: null,
        nextCheckAt: null
      });
      return;
    }

    startRouterUpnpCheck();
  }

  return {
    isEnabled: isRouterUpnpMonitorEnabled,
    credentialsConfigured: ROUTER_UPNP_CREDENTIALS_CONFIGURED,
    configure: configureRouterUpnpMonitor,
    start: startRouterUpnpMonitor,
    startCheck: startRouterUpnpCheck,
    reschedule: rescheduleRouterUpnpCheck,
    getStatus() {
      return {
        enabled: isRouterUpnpMonitorEnabled(),
        credentialsConfigured: ROUTER_UPNP_CREDENTIALS_CONFIGURED,
        checking: routerUpnpCheckInProgress,
        liveViewAvailable: Boolean(routerUpnpPage && routerUpnpBrowser && routerUpnpBrowser.connected),
        hasScreenshot: Boolean(routerUpnpScreenshot),
        screenshotUpdatedAt: routerUpnpScreenshotUpdatedAt || null,
        screenshotError: routerUpnpScreenshotError,
        state: routerUpnpState,
        events: routerUpnpEvents
      };
    },
    getScreenshot() {
      return { buffer: routerUpnpScreenshot, updatedAt: routerUpnpScreenshotUpdatedAt };
    }
  };
}

module.exports = createRouterUpnpService;
