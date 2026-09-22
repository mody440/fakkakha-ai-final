import { test, expect } from '@playwright/test';
test('home loads', async ({ page }) => { await page.goto('/'); await expect(page.locator('#app')).toBeVisible(); });
test('privacy and terms pages load', async ({ page }) => { await page.goto('/privacy.html'); await expect(page.locator('body')).toBeVisible(); await page.goto('/terms.html'); await expect(page.locator('body')).toBeVisible(); });
