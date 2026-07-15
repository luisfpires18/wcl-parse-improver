// Sign in with Warcraft Logs.
//
// The whole app is behind a session: every /api route except /api/auth/* answers
// 401 without one. So rather than teach a dozen call sites in mplus.js, raid.js
// and report.js to handle that, we wrap fetch once — any 401 means the session
// died (expired, revoked, server restarted with a new SESSION_SECRET) and the
// only useful thing left to do is show the sign-in screen.
import { $, esc } from './util.js';
import { CLASS_COLORS, classIconUrl, roleIconUrl, sigilUrl } from './icons.js';

let onSignedOut = null;

/** Wrap window.fetch so a 401 from our own API drops back to sign-in. */
export function installAuthFetch(handler) {
  onSignedOut = handler;
  const original = window.fetch;
  window.fetch = async (input, init) => {
    const res = await original(input, init);
    const url = String(input?.url ?? input ?? '');
    if (res.status === 401 && url.includes('/api/') && !url.includes('/api/auth/me')) {
      onSignedOut?.();
    }
    return res;
  };
}

/** The signed-in user, or null. */
export async function fetchMe() {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Sign-in gets its own container rather than borrowing #status, which the view
// router clears whenever it redraws.
export function renderSignIn(message) {
  $('#nav').hidden = true;
  $('#char-bar').hidden = true;
  $('#status').innerHTML = '';
  $('#user-bar').innerHTML = '';
  for (const v of ['characters', 'mplus', 'raid']) $(`#view-${v}`).hidden = true;
  // The class strip: every class, in its own colour. It is the one piece of
  // decoration that also says what the app is for, without a word.
  const strip = Object.keys(CLASS_COLORS)
    .map(
      (cls) => `<img class="icon" src="${esc(classIconUrl(cls))}" alt=""
                     style="--glow: ${CLASS_COLORS[cls]}" loading="lazy" />`
    )
    .join('');

  const roles = ['Tank', 'Healer', 'DPS']
    .map((r) => `<span class="role-tag"><img class="icon role" src="${esc(roleIconUrl(r))}" alt="" /> ${r}</span>`)
    .join('');

  $('#signin').hidden = false;
  $('#signin').innerHTML = `
    <div class="hero">
      <div class="class-strip">${strip}</div>

      <img class="hero-sigil" src="${esc(sigilUrl('sword'))}" alt="" />
      <h2>Know why your parse is what it is</h2>
      <p class="lede">Your best run, next to the top runs of your spec at your key level: deaths,
        idle time, cast rates, buff uptimes, and one sentence on each gap that matters.</p>

      ${message ? `<p class="error">${esc(message)}</p>` : ''}

      <p><a class="button big" href="/api/auth/login">Sign in with Warcraft Logs</a></p>

      <p class="roles">${roles}</p>
      <p class="lede small">Every character you've claimed on Warcraft Logs, imported with its
        specs, item level and M+ rating, tanks and healers included. No server slugs to type.</p>

      <p><small class="muted">We ask for one scope, <code>view-user-profile</code>: enough to see who you
        are and which characters are yours. We never see your password, and your access token stays on
        the server; your browser only ever holds a signed session id.</small></p>
    </div>`;
}

export function renderUserBar(user, onSignOut) {
  const el = $('#user-bar');
  if (!el) return;
  $('#signin').hidden = true;
  el.innerHTML = `
    <div class="user-chip">
      ${user.avatar ? `<img src="${esc(user.avatar)}" alt="" class="avatar" />` : ''}
      <span>${esc(user.name)}</span>
      <button type="button" class="mini" id="sign-out">Sign out</button>
    </div>`;
  $('#sign-out').addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    onSignOut();
  });
}
