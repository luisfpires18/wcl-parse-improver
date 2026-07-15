# Deploy to Azure App Service (Free F1)

This app is a plain Node/Express server with one dependency and no build step, so it
drops straight onto Azure App Service. These steps use the **Free (F1)** Linux plan, which
is included with Azure for Students.

## What Azure needs to know about this app

- **It's a Node app that self-starts.** `npm start` runs `node server/index.js`, and the
  server already listens on `process.env.PORT` ([server/index.js](../server/index.js)) — which
  is exactly what App Service sets. No code change needed.
- **Node 20.6+.** It uses ESM, built-in `fetch` and `node:test`. `package.json` pins
  `engines.node >= 20.6`, so Oryx (Azure's builder) picks a Node 20 runtime.
- **No build.** Oryx runs `npm install` and that's it — there's no bundler.
- **It writes files** (`characters.json`, `data/sessions.json`, `cache/`). On App Service
  those live under `/home`, which is **persistent** across restarts, so rosters and sessions
  survive a redeploy. (Keep the plan to a single instance — the Free tier is — since the
  session/roster store is on local disk, not shared.)

## 1. Prerequisites

- An Azure for Students subscription (the Free F1 plan costs nothing).
- The **Azure CLI** (`az`) — or the **Azure App Service** extension for VS Code if you prefer
  clicking. This guide shows the CLI; the VS Code flow is noted at the end.
- Node 20+ locally to test before you push.

```bash
az login
az account show   # confirm you're on the Students subscription
```

## 2. Create the Web App

Pick a globally-unique name — it becomes `https://<name>.azurewebsites.net`.

```bash
# names are yours to choose; region can be any you have quota in
az group create --name wcl-rg --location westeurope

az appservice plan create \
  --name wcl-plan --resource-group wcl-rg \
  --sku F1 --is-linux

az webapp create \
  --name wcl-parse-improver-<you> \
  --resource-group wcl-rg \
  --plan wcl-plan \
  --runtime "NODE:20-lts"
```

## 3. Register the redirect URL on Warcraft Logs

Your callback URL is now `https://<name>.azurewebsites.net/api/auth/callback`. Add it to your
API client at <https://www.warcraftlogs.com/api/clients/> (the same place you got the client
ID/secret). WCL rejects the login with `invalid_client` if the redirect isn't registered
byte-for-byte — https, no trailing slash.

## 4. Configure the environment

App Settings are how Azure supplies the `.env` values — never commit real secrets.

```bash
az webapp config appsettings set \
  --name wcl-parse-improver-<you> --resource-group wcl-rg \
  --settings \
    WCL_CLIENT_ID="your-client-id" \
    WCL_CLIENT_SECRET="your-client-secret" \
    WCL_REDIRECT_URI="https://wcl-parse-improver-<you>.azurewebsites.net/api/auth/callback" \
    SESSION_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")" \
    WEBSITES_ENABLE_APP_SERVICE_STORAGE="true"
```

- `WCL_REDIRECT_URI` is **https** (App Service terminates TLS for you). The session cookie's
  `Secure` flag switches on automatically because the redirect URI is https
  ([server/session.js](../server/session.js)).
- `WEBSITES_ENABLE_APP_SERVICE_STORAGE=true` keeps `/home` mounted, so `data/` and
  `characters.json` persist.
- The app **fails fast** if any of the four required vars is missing, so a bad config shows up
  immediately in the logs rather than as a broken login later.

## 5. Deploy the code

From the repo root. `az webapp up` zips the working tree, uploads it, and lets Oryx run
`npm install`:

```bash
az webapp up \
  --name wcl-parse-improver-<you> --resource-group wcl-rg \
  --runtime "NODE:20-lts"
```

Redeploys are the same command. `node_modules/`, `.env`, `cache/`, `data/` are gitignored and
excluded from the upload.

> Prefer continuous deploy? `az webapp deployment github-actions add --repo <owner/repo> --branch master ...` wires a GitHub Actions workflow that redeploys on every push.

## 6. Verify

```bash
# open it
az webapp browse --name wcl-parse-improver-<you> --resource-group wcl-rg

# tail the logs if the page doesn't load
az webapp log tail --name wcl-parse-improver-<you> --resource-group wcl-rg
```

You should land on the **Sign in with Warcraft Logs** screen. Sign in, and the callback returns
you to the app with your roster importable.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| App won't start, logs show `Missing required environment …` | An App Setting is missing — recheck step 4. |
| Login returns `invalid_client` | The redirect URL isn't registered on the WCL client, or `WCL_REDIRECT_URI` doesn't match it exactly (https, no trailing slash). |
| Login works but you're signed out after a restart | `WEBSITES_ENABLE_APP_SERVICE_STORAGE` is off, so `data/sessions.json` isn't persisted. |
| "Application Error" page | `az webapp log tail` — usually a Node version mismatch; confirm the runtime is `NODE:20-lts`. |
| Roster empty after redeploy | Expected only if storage is off; with it on, `characters.json` persists under `/home`. |

## Using VS Code instead of the CLI

Install the **Azure App Service** extension, sign in, right-click your subscription →
**Create Web App (Advanced)** → Linux, Node 20, Free F1. Then right-click the repo folder →
**Deploy to Web App**. Set the App Settings (step 4) under the app's **Application Settings** in
the extension. Everything else is identical.
