import crypto from 'node:crypto';

export const API_URL = process.env.API_URL ?? 'http://localhost:4000';

/** Register a fresh user through the API and return { email, password, token, user }. */
export async function registerUser(request, overrides = {}) {
  const id = crypto.randomUUID().slice(0, 8);
  const body = {
    name: `E2E ${id}`,
    email: `e2e-${id}@test.dev`,
    password: 'password123',
    skills: ['react'],
    timezone: 'Asia/Kolkata',
    ...overrides,
  };
  const res = await request.post(`${API_URL}/api/auth/register`, { data: body });
  if (!res.ok()) throw new Error(`register failed ${res.status()} ${await res.text()}`);
  const json = await res.json();
  return { ...body, token: json.token, user: json.user };
}

/** Open a new browser context that is already logged in as `u`. */
export async function loggedInPage(browser, u, options = {}) {
  const context = await browser.newContext(options);
  await context.addInitScript((token) => localStorage.setItem('teamup.token', token), u.token);
  const page = await context.newPage();
  return { context, page };
}
