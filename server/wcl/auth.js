// OAuth2 client-credentials flow against Warcraft Logs.
// Token is cached in memory until shortly before expiry.
const TOKEN_URL = 'https://www.warcraftlogs.com/oauth/token';

let cached = null; // { token, expiresAt }

export async function getToken() {
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;

  const id = process.env.WCL_CLIENT_ID;
  const secret = process.env.WCL_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error(
      'Missing WCL_CLIENT_ID / WCL_CLIENT_SECRET. Create an API client at ' +
        'https://www.warcraftlogs.com/api/clients/ and put the values in .env (see .env.example).'
    );
  }

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) {
    throw new Error(`OAuth token request failed: HTTP ${res.status} — ${await res.text()}`);
  }
  const data = await res.json();
  if (!data.access_token) {
    throw new Error(`OAuth response had no access_token: ${JSON.stringify(data).slice(0, 500)}`);
  }
  cached = {
    token: data.access_token,
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
  };
  return cached.token;
}
