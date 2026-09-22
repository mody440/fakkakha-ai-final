import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: '.', use: { baseURL: process.env.BASE_URL || 'http://127.0.0.1:3000' }, timeout: 30000 });
