/**
 * settingsService.js
 *
 * Reads admin-configurable settings from the SystemSetting table.
 * Falls back to defaults when no DB row exists.
 */

import { prisma } from '../db.js';

const CACHE_TTL_MS = 10_000;
let cache = { values: {}, updatedAt: 0 };

const DEFAULTS = Object.freeze({
  payment_provider_paypal: 'disabled',
  payment_provider_nowpayments: 'enabled',
});

function stale() {
  return Date.now() - cache.updatedAt > CACHE_TTL_MS;
}

async function refresh() {
  try {
    const rows = await prisma.systemSetting.findMany();
    cache.values = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    cache.updatedAt = Date.now();
  } catch {
    // If the table doesn't exist yet, use empty cache
    cache.values = {};
    cache.updatedAt = Date.now();
  }
}

export async function getSetting(key) {
  if (stale()) await refresh();
  return cache.values[key] ?? DEFAULTS[key] ?? null;
}

export async function isPaymentProviderEnabled(provider) {
  const key = `payment_provider_${provider}`;
  const value = await getSetting(key);
  return value === 'enabled';
}

export function clearCache() {
  cache = { values: {}, updatedAt: 0 };
}
