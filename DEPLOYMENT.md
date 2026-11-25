# SimplePort deployment

SimplePort does not need third-party hosting. Run it on the same LAN as the UPnP router, which lets the bundled `miniupnpc` client discover the gateway and manage port mappings.

## Docker or TrueNAS SCALE

1. Copy `.env.example` to `.env` and set `UI_PASSWORD` and `SESSION_SECRET` to private values.
2. Create a persistent data directory, such as `/mnt/tank/apps/simpleport` on TrueNAS.
3. Build and start the app:

```sh
docker compose up -d --build
```

4. Open `http://<NAS-IP>:3000` and sign in with the credentials from `.env`.

The included `compose.yaml` uses host networking deliberately. UPnP discovery uses local-network traffic that often does not cross a normal Docker bridge. When importing this as a custom app in TrueNAS SCALE, use the same host-network setting and mount persistent storage at `/data`.

The port mappings and health-check settings are stored in `/data`. Back up that directory to preserve the SimplePort configuration.

Enabled mappings are applied immediately when created and at app startup. Each renewal is then independently randomized between 6 and 24 hours after the previous attempt. Automatic health checks run every five minutes by default; change the interval in **Settings**. The port status shows the latest check time and result on hover, and failed checks are written to the container logs. TCP checks test reachability; UDP checks can only confirm that the gateway mapping exists. Randomized timings reduce synchronization but do not guarantee a five-minute gap between renewals.

Warnings and errors from health checks, router UPnP recovery, and port-management actions are also saved in `/data/logs.json` and shown in the **Logs** tab. The tab stays hidden when there are no entries; the log keeps the latest 500 entries. **Clear logs** clears SimplePort's saved log only, not the TrueNAS container logs.

## Router UPnP auto-recovery

Configure router UPnP auto-recovery from **Settings**. The switch is enabled by default when both `ROUTER_ADMIN_USERNAME` and `ROUTER_ADMIN_PASSWORD` are configured, including when upgrading an existing deployment. If the switch is off, SimplePort does not launch the router browser. Set credentials as private environment secrets (Compose users can put them in the ignored `.env`; do not commit real credentials in YAML or source control). The TrueNAS install YAML includes empty placeholders for these variables.

When enabled, the headless browser check runs immediately, then waits the configured **Router UPnP check interval** (300 seconds by default, minimum 5 seconds) after each check finishes before starting the next one. This avoids overlapping checks. On Windows, SimplePort auto-detects installed Chrome or Edge; on Linux, it checks standard Chromium/Chrome paths. If no browser is found or the auto-detection selects the wrong one, set `PUPPETEER_EXECUTABLE_PATH` to the browser executable path. The Docker image sets this to its bundled Chromium.

The **Router Monitor** view is always available in the sidebar; it shows whether monitoring is off or on, the current step, last and next check times, live activity, and a live browser screen that refreshes once per second while open. Use **Check now** to start a check on demand when monitoring is enabled. The monitor visits `http://10.0.0.1`, opens **Advanced > Device Discovery**, and inspects the UPnP control. It does nothing when UPnP is already on. If it can positively identify that UPnP is off, it turns it on, saves, and reloads the setting to verify it. Disabling the feature in Settings cancels scheduled checks and stops any active browser session. If login or page controls cannot be identified, it makes no setting change and records an error in the Logs tab. Router admin credentials are not written to logs. Re-enabling UPnP may restore public access through any existing UPnP mappings.

## HTTPS or remote access

For LAN-only use, keep `SESSION_COOKIE_SECURE=false` and access SimplePort over HTTP. If exposing it through an HTTPS reverse proxy or Tailscale, set `SESSION_COOKIE_SECURE=true` and restrict access with the proxy or VPN. Do not expose the admin UI directly to the public internet without HTTPS and an access control layer.

## Updating

```sh
docker compose pull
docker compose up -d --build
```

The image installs `miniupnpc` and Chromium automatically; no package installation is required on the TrueNAS host.

## TrueNAS Install via YAML

The file `truenas-install.yaml` is ready to paste into **Apps > Discover > Install via YAML**. Before installing:

1. Push this project to a GitHub repository. The included GitHub Actions workflow publishes `ghcr.io/<your-github-username>/simpleport:latest` automatically when you push to `main`.
2. In `truenas-install.yaml`, replace `REPLACE_WITH_YOUR_GITHUB_USERNAME` if needed.
3. Change `UI_PASSWORD` and `SESSION_SECRET` in the YAML.
4. Paste the YAML into TrueNAS and deploy it.

The GitHub Container Registry package must be set to **Public** under the repository's package settings. If it remains private, TrueNAS will fail during the `up` action unless registry credentials are configured.

The YAML uses host networking so `miniupnpc` can discover the router over LAN multicast. Open SimplePort at `http://<NAS-IP>:8546`. Because host networking does not declare a Compose port mapping, TrueNAS may not show a Web UI button for this custom YAML app. It asks TrueNAS to create and manage a named volume called `simpleport-data`, mounted inside the container at `/data`.