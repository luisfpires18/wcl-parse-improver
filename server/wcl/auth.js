// Two OAuth2 flows against Warcraft Logs, for two different things:
//
//   client-credentials -> getToken(), an APP token. Public data only, but shared
//     by every visitor, so its responses are cacheable. All analysis runs on it.
//   authorization-code -> authorizeUrl()/exchangeCode(), a USER token. The only
//     way to read `userData.currentUser`, which is how we learn who signed in and
//     which characters they have claimed.
const TOKEN_URL = 'https://www.warcraftlogs.com/oauth/token';
const AUTHORIZE_URL = 'https://www.warcraftlogs.com/oauth/authorize';

// Just enough to read the profile and its claimed characters. We deliberately do
// not ask for view-private-reports: nothing here reads private logs yet, and the
// consent screen should not claim otherwise.
const SCOPE = 'view-user-profile';

let cached = null; // { token, expiresAt }

function clientCredentials() {
  const id = process.env.WCL_CLIENT_ID;
  const secret = process.env.WCL_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error(
      'Missing WCL_CLIENT_ID / WCL_CLIENT_SECRET. Create an API client at ' +
        'https://www.warcraftlogs.com/api/clients/ and put the values in .env (see .env.example).'
    );
  }
  return { id, secret, basic: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64') };
}

export function redirectUri() {
  const uri = process.env.WCL_REDIRECT_URI;
  if (!uri) {
    throw new Error(
      'Missing WCL_REDIRECT_URI. Add the callback URL (e.g. http://localhost:3000/api/auth/callback) ' +
        'to your API client at https://www.warcraftlogs.com/api/clients/ and to .env (see .env.example).'
    );
  }
  return uri;
}

/** POST the token endpoint and unwrap the access token. Shared by both flows. */
async function requestToken(body) {
  const { basic } = clientCredentials();
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: basic,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`OAuth token request failed: HTTP ${res.status} — ${await res.text()}`);
  }
  const data = await res.json();
  if (!data.access_token) {
    throw new Error(`OAuth response had no access_token: ${JSON.stringify(data).slice(0, 500)}`);
  }
  return {
    token: data.access_token,
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
  };
}

/** The app-wide token. Cached in memory until shortly before expiry. */
export async function getToken() {
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;
  cached = await requestToken('grant_type=client_credentials');
  return cached.token;
}

/**
 * Where to send the browser to start a login. `state` is echoed back to the
 * callback unchanged; the caller compares it to what it stored, which is what
 * stops a third party from forging the callback.
 */
export function authorizeUrl(state) {
  const { id } = clientCredentials();
  const params = new URLSearchParams({
    client_id: id,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPE,
    state,
  });
  return `${AUTHORIZE_URL}?${params}`;
}

/** Trade the one-time `code` from the callback for that user's access token. */
export async function exchangeCode(code) {
  return requestToken(
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(),
    }).toString()
  );
}
