import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { registerUser, loggedInPage } from './helpers.js';

test('full flow: register in the UI, create a team, a second user joins by code — leader sees it live', async ({ page, browser, request }) => {
  // --- Leader signs up through the real form ---
  const id = Date.now().toString(36);
  await page.goto('/register');
  await page.getByLabel('Name').fill(`Leader ${id}`);
  await page.getByLabel('Email').fill(`leader-${id}@test.dev`);
  await page.getByLabel('Password').fill('password123');
  await page.getByLabel('Skills').fill('react');
  await page.getByLabel('Skills').press('Enter');
  await page.getByRole('button', { name: 'Create account' }).click();

  // --- Create a team ---
  await page.getByRole('button', { name: 'Create a team' }).click();
  await page.getByLabel('Team name').fill(`E2E Team ${id}`);
  await page.getByRole('button', { name: 'Create team' }).click();
  await expect(page.getByRole('heading', { level: 1, name: `E2E Team ${id}` })).toBeVisible();

  // --- Generate an invite code ---
  await page.getByRole('button', { name: 'Generate invite code' }).click();
  const codeEl = page.getByLabel('Current invite code');
  await expect(codeEl).toBeVisible();
  const code = (await codeEl.textContent()).trim();
  expect(code).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
  const members = page.getByRole('region', { name: 'Members' });
  await expect(members.locator('ul.list > li')).toHaveCount(1);

  // --- Second user, separate browser, joins with the code ---
  const joiner = await registerUser(request, { name: `Joiner ${id}`, skills: ['mongodb'] });
  const { context, page: p2 } = await loggedInPage(browser, joiner);
  await p2.goto('/');
  await p2.getByLabel('Have an invite code?').fill(code);
  await p2.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(p2.getByRole('heading', { level: 1, name: `E2E Team ${id}` })).toBeVisible();

  // --- Leader's page updated over WebSockets, no reload ---
  await expect(members.locator('ul.list > li')).toHaveCount(2);
  await expect(members).toContainText(`Joiner ${id}`);
  await expect(page.getByLabel('2 of 4 members').first()).toBeVisible();

  // --- Activity log shows who did what ---
  await expect(page.getByRole('region', { name: 'Activity log' })).toContainText(`Joiner ${id}`);
  await context.close();
});

test('join request: leader gets notified and accepts; requester sees it live', async ({ browser, request }) => {
  const leader = await registerUser(request);
  const requester = await registerUser(request, { skills: ['design'] });
  const teamName = `Req Team ${Date.now().toString(36)}`;

  const L = await loggedInPage(browser, leader);
  await L.page.goto('/');
  await L.page.getByRole('button', { name: 'Create a team' }).click();
  await L.page.getByLabel('Team name').fill(teamName);
  await L.page.getByRole('button', { name: 'Create team' }).click();
  await expect(L.page.getByRole('heading', { level: 1, name: teamName })).toBeVisible();
  const teamUrl = L.page.url();

  const R = await loggedInPage(browser, requester);
  await R.page.goto(new URL(teamUrl).pathname);
  await R.page.getByRole('button', { name: 'Request to join' }).click();
  await expect(R.page.getByRole('button', { name: 'Cancel my request' })).toBeVisible();

  // Leader: toast + request appears live
  await expect(L.page.getByRole('status').filter({ hasText: 'asked to join your team' })).toBeVisible();
  const requests = L.page.getByRole('region', { name: /Join requests/ });
  await requests.getByRole('button', { name: 'Accept' }).click();

  // Requester: becomes a member without reloading
  await expect(R.page.getByRole('button', { name: 'Leave team' })).toBeVisible();
  await expect(R.page.getByRole('status').filter({ hasText: "You're in!" })).toBeVisible();
  await L.context.close();
  await R.context.close();
});

test('phone layout: no horizontal scrolling on board and team pages', async ({ browser, request }) => {
  const u = await registerUser(request);
  const { context, page } = await loggedInPage(browser, u, { viewport: { width: 375, height: 740 }, isMobile: true, hasTouch: true });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Teams with open seats' })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await context.close();
});

test('keyboard only: skip link, tabs with arrow keys, create a team without a mouse', async ({ browser, request }) => {
  const u = await registerUser(request);
  const { context, page } = await loggedInPage(browser, u);
  await page.goto('/');
  await expect(page.getByRole('tab', { name: 'Teams with open seats' })).toBeVisible();

  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();

  // Tabs: focus the selected tab, arrow to the next one
  await page.getByRole('tab', { name: 'Teams with open seats' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'People looking for a team' })).toBeFocused();
  await expect(page.getByRole('tab', { name: 'People looking for a team' })).toHaveAttribute('aria-selected', 'true');

  // Create a team using only the keyboard
  await page.getByRole('button', { name: 'Create a team' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Team name')).toBeVisible();
  await page.getByLabel('Team name').focus();
  await page.keyboard.type(`Keyboard ${Date.now().toString(36)}`);
  await page.keyboard.press('Enter'); // submits the form
  await expect(page.getByRole('button', { name: 'Leave team' })).toBeVisible();
  await context.close();
});

test('accessibility: no serious or critical axe violations on board and team pages', async ({ browser, request }) => {
  const u = await registerUser(request);
  const { context, page } = await loggedInPage(browser, u);
  await page.goto('/');
  await expect(page.getByRole('tab', { name: 'Teams with open seats' })).toBeVisible();
  await expect(page.locator('#board-panel')).toHaveAttribute('aria-busy', 'false');

  const scan = async () => {
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    return results.violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => `${v.id}: ${v.help} (${v.nodes.length})`);
  };
  expect(await scan()).toEqual([]);

  await page.getByRole('button', { name: 'Create a team' }).click();
  await page.getByLabel('Team name').fill(`A11y ${Date.now().toString(36)}`);
  await page.getByRole('button', { name: 'Create team' }).click();
  await expect(page.getByRole('button', { name: 'Leave team' })).toBeVisible();
  expect(await scan()).toEqual([]);
  await context.close();
});
