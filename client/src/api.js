/**
 * API client.
 *
 * - Adds the JWT to every request.
 * - Every mutating request gets an Idempotency-Key that is generated ONCE per user action and
 *   REUSED for automatic retries. If the network drops after the server committed, the retry
 *   gets the stored response back instead of joining twice.
 */
export const API_URL = (import.meta.env.VITE_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');

const TOKEN_KEY = 'teamup.token';

export const tokenStore = {
  get: () => {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set: (t) => {
    try {
      if (t) localStorage.setItem(TOKEN_KEY, t);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* private mode: token lives only in memory for this tab */
    }
  },
};

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const newKey = () =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function api(path, { method = 'GET', body, retries = 2 } = {}) {
  const headers = { Accept: 'application/json' };
  const token = tokenStore.get();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') headers['Idempotency-Key'] = newKey(); // one key for this action, all attempts

  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(`${API_URL}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      // Network failure: we don't know if the server applied it. Safe to retry thanks to the key.
      if (attempt < retries) {
        await wait(300 * (attempt + 1));
        continue;
      }
      throw new ApiError(0, 'NETWORK', 'Network error — check your connection');
    }
    // Original request still running on the server: wait and ask again (we'll get the replay).
    if (res.status === 409 && attempt < retries + 3) {
      const peek = await res.clone().json().catch(() => null);
      if (peek?.error?.code === 'REQUEST_IN_PROGRESS') {
        await wait(400 * (attempt + 1));
        continue;
      }
    }
    // Server says "busy, try again" (e.g. a crashed transaction still holds the team): honour Retry-After.
    if (res.status === 503 && attempt < retries + 3) {
      const secs = Number(res.headers.get('Retry-After')) || 2;
      await wait(secs * 1000);
      continue;
    }
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) {
      const e = data?.error ?? {};
      if (res.status === 401 && token) {
        tokenStore.set(null);
        window.dispatchEvent(new Event('auth:expired'));
      }
      throw new ApiError(res.status, e.code ?? 'ERROR', e.message ?? `Request failed (${res.status})`, e.details);
    }
    return data;
  }
}

/** Friendly text for the error codes the API returns. */
export function errorText(err) {
  const map = {
    TEAM_FULL: 'Too late — that team just filled its last seat.',
    ALREADY_IN_TEAM: 'You are already in a team. Leave it first to join another.',
    TEAM_NAME_TAKEN: 'That team name is taken.',
    INVALID_INVITE: 'That invite code is not valid.',
    INVITE_EXPIRED: 'That invite code has expired. Ask the leader for a new one.',
    RATE_LIMITED: 'Too many attempts. Wait a few minutes and try again.',
    NOT_LEADER: 'Only the team leader can do that.',
    ALREADY_DECIDED: 'Someone already handled this request.',
    TEAM_NOT_FOUND: 'This team no longer exists.',
    TEAM_FORMATION_CLOSED: 'Team formation for this hackathon has closed.',
    TRY_AGAIN: 'That team is busy right now. Please try again in a moment.',
  };
  if (err?.code === 'VALIDATION_ERROR' && err.details?.length) {
    return err.details.map((d) => `${d.path.split('.').slice(1).join('.')}: ${d.message}`).join(' · ');
  }
  return map[err?.code] ?? err?.message ?? 'Something went wrong';
}
