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

The port mappings and refresh settings are stored in `/data`. Back up that directory to preserve the SimplePort configuration.

## HTTPS or remote access

For LAN-only use, keep `SESSION_COOKIE_SECURE=false` and access SimplePort over HTTP. If exposing it through an HTTPS reverse proxy or Tailscale, set `SESSION_COOKIE_SECURE=true` and restrict access with the proxy or VPN. Do not expose the admin UI directly to the public internet without HTTPS and an access control layer.

## Updating

```sh
docker compose pull
docker compose up -d --build
```

The image installs `miniupnpc` automatically; no package installation is required on the TrueNAS host.

## TrueNAS Install via YAML

The file `truenas-install.yaml` is ready to paste into **Apps > Discover > Install via YAML**. Before installing:

1. Push this project to a GitHub repository. The included GitHub Actions workflow publishes `ghcr.io/<your-github-username>/simpleport:latest` automatically when you push to `main`.
2. In `truenas-install.yaml`, replace `REPLACE_WITH_YOUR_GITHUB_USERNAME` if needed.
3. Change `UI_PASSWORD` and `SESSION_SECRET` in the YAML.
4. Paste the YAML into TrueNAS and deploy it.

The GitHub Container Registry package must be set to **Public** under the repository's package settings. If it remains private, TrueNAS will fail during the `up` action unless registry credentials are configured.

The YAML uses host networking so `miniupnpc` can discover the router over LAN multicast. Open SimplePort at `http://<NAS-IP>:8546`. Because host networking does not declare a Compose port mapping, TrueNAS may not show a Web UI button for this custom YAML app. It asks TrueNAS to create and manage a named volume called `simpleport-data`, mounted inside the container at `/data`.