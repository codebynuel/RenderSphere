import crypto from 'node:crypto';

import { config } from '../../helpers/config.js';
import { logger } from '../../helpers/logger.js';
import { prisma } from '../db.js';
import {
  CREDIT_ACTOR_TYPES,
  CREDIT_TRANSACTION_TYPES,
  applyCreditTransaction,
  microsToMoneyString,
  moneyToMicros,
} from './creditService.js';

const NOWPAYMENTS_API_BASE = 'https://api.nowpayments.io/v1';
const TOP_UP_TYPES = Object.freeze({
  PACKAGE: 'PACKAGE',
  CUSTOM: 'CUSTOM',
});
const SUCCESSFUL_PAYMENT_STATUSES = new Set(['confirmed', 'finished']);
const PENDING_PAYMENT_STATUSES = new Set(['waiting', 'confirming', 'sending', 'partially_paid']);
const FAILED_PAYMENT_STATUSES = new Set(['failed', 'refunded', 'expired']);

function createHttpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function safeJson(value) {
  if (!value || typeof value !== 'object') return null;
  return value;
}

function moneyString(value) {
  return microsToMoneyString(moneyToMicros(value));
}

function moneyNumber(value) {
  return Number(moneyString(value));
}

function decimalString(value, { fallback = null } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const raw = typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : String(value).trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)) return fallback;
  return raw;
}

function requireNowPaymentsConfigured() {
  if (!config.nowpayments.apiKey) {
    throw createHttpError('NOWPayments crypto checkout is not configured.', 503);
  }
}

function requireNowPaymentsIpnConfigured() {
  if (!config.nowpayments.ipnSecret) {
    throw createHttpError('NOWPayments IPN verification is not configured.', 503);
  }
}

function normalizeTopUpType(value, packageId = null) {
  const normalized = String(value || '').trim().toUpperCase();
  if (normalized === TOP_UP_TYPES.CUSTOM) return TOP_UP_TYPES.CUSTOM;
  if (normalized === TOP_UP_TYPES.PACKAGE) return TOP_UP_TYPES.PACKAGE;
  return packageId ? TOP_UP_TYPES.PACKAGE : TOP_UP_TYPES.CUSTOM;
}

function topUpSelectionLabel(topUpType, packageId, metadata = null) {
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    const label = String(metadata.topUpLabel || metadata.packageLabel || metadata.customLabel || '').trim();
    if (label) return label;
  }
  if (topUpType === TOP_UP_TYPES.PACKAGE && packageId) return packageId;
  return 'Custom crypto top-up';
}

function normalizePayCurrency(payCurrency) {
  const allowed = config.nowpayments.allowedPayCurrencies;
  const requested = String(payCurrency || config.nowpayments.defaultPayCurrency || '').trim().toLowerCase();
  if (!requested) return null;
  if (!/^[a-z0-9_:-]{2,32}$/.test(requested)) {
    throw createHttpError('Crypto pay currency is not supported.', 400);
  }
  if (allowed.length && !allowed.includes(requested)) {
    throw createHttpError(`Crypto pay currency must be one of: ${allowed.join(', ')}.`, 400);
  }
  return requested;
}

function normalizeCustomAmountPayload(customAmount = {}, amountUsd = undefined, currency = undefined) {
  const payload = customAmount && typeof customAmount === 'object' && !Array.isArray(customAmount) ? customAmount : {};
  const rawAmount = payload.amountUsd ?? payload.amount ?? payload.value ?? amountUsd;
  const rawAmountString = typeof rawAmount === 'number'
    ? (Number.isFinite(rawAmount) ? String(rawAmount) : '')
    : String(rawAmount ?? '').trim();

  const amountMatch = rawAmountString.match(/^(?:0|[1-9]\d*)(?:\.(\d+))?$/);
  if (!amountMatch) throw createHttpError('Custom crypto top-up amount must be a positive decimal number.', 400);

  const fraction = amountMatch[1] || '';
  const decimalPlaces = config.nowpayments.customTopUp.decimalPlaces;
  if (fraction.length > decimalPlaces) {
    throw createHttpError(`Custom crypto top-up amount supports up to ${decimalPlaces} decimal places.`, 400);
  }

  const amountMicros = moneyToMicros(rawAmountString);
  if (amountMicros <= 0n) throw createHttpError('Custom crypto top-up amount must be greater than zero.', 400);

  const minMicros = moneyToMicros(config.nowpayments.customTopUp.minAmountUsd);
  const maxMicros = moneyToMicros(config.nowpayments.customTopUp.maxAmountUsd);
  if (amountMicros < minMicros) {
    throw createHttpError(`Custom crypto top-up amount must be at least ${moneyString(config.nowpayments.customTopUp.minAmountUsd)} ${config.nowpayments.customTopUp.currency}.`, 400);
  }
  if (amountMicros > maxMicros) {
    throw createHttpError(`Custom crypto top-up amount must be at most ${moneyString(config.nowpayments.customTopUp.maxAmountUsd)} ${config.nowpayments.customTopUp.currency}.`, 400);
  }

  const requestedCurrency = String(payload.currency ?? currency ?? config.nowpayments.customTopUp.currency).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(requestedCurrency)) {
    throw createHttpError('Custom crypto top-up currency must be a three-letter ISO currency code.', 400);
  }
  if (requestedCurrency !== config.nowpayments.customTopUp.currency) {
    throw createHttpError(`Custom crypto top-up currency must be ${config.nowpayments.customTopUp.currency}.`, 400);
  }

  return {
    type: TOP_UP_TYPES.CUSTOM,
    packageId: null,
    referenceId: 'custom-crypto-top-up',
    label: `Custom ${requestedCurrency} crypto top-up`,
    description: 'RenderSphere custom prepaid credits via crypto',
    amountUsd: microsToMoneyString(amountMicros),
    currency: requestedCurrency,
    decimalPlaces,
  };
}

function getNowPaymentsPrepaidPackage(packageId) {
  const normalizedPackageId = String(packageId || '').trim();
  const selectedPackage = config.nowpayments.prepaidPackages.find((item) => item.id === normalizedPackageId);
  if (!selectedPackage) throw createHttpError('Selected crypto prepaid package is not available.', 400);
  return selectedPackage;
}

function normalizeTopUpSelection({ packageId, customAmount, amountUsd, currency }) {
  const normalizedPackageId = String(packageId || '').trim();
  const hasCustomPayload = customAmount !== undefined || amountUsd !== undefined || currency !== undefined;
  if (normalizedPackageId && hasCustomPayload) {
    throw createHttpError('Choose either a crypto prepaid package or a custom crypto top-up amount, not both.', 400);
  }
  if (normalizedPackageId) {
    const selectedPackage = getNowPaymentsPrepaidPackage(normalizedPackageId);
    return {
      type: TOP_UP_TYPES.PACKAGE,
      packageId: selectedPackage.id,
      referenceId: selectedPackage.id,
      label: selectedPackage.label,
      description: `RenderSphere prepaid credits ${selectedPackage.label} via crypto`,
      amountUsd: moneyString(selectedPackage.amountUsd),
      currency: selectedPackage.currency,
      package: selectedPackage,
      decimalPlaces: 2,
    };
  }
  if (hasCustomPayload) return normalizeCustomAmountPayload(customAmount, amountUsd, currency);
  throw createHttpError('Select a crypto prepaid package or enter a custom crypto top-up amount.', 400);
}

function configuredIpnCallbackUrl() {
  const publicUrl = config.nowpayments.publicUrl || config.publicUrl;
  if (!publicUrl) return undefined;
  return `${publicUrl.replace(/\/$/, '')}/api/billing/nowpayments/ipn`;
}

function configuredSuccessUrl() {
  const publicUrl = config.nowpayments.publicUrl || config.publicUrl;
  if (!publicUrl) return undefined;
  return `${publicUrl.replace(/\/$/, '')}/dashboard?view=billing&nowpayments=return`;
}

function configuredCancelUrl() {
  const publicUrl = config.nowpayments.publicUrl || config.publicUrl;
  if (!publicUrl) return undefined;
  return `${publicUrl.replace(/\/$/, '')}/dashboard?view=billing&nowpayments=cancel`;
}

async function readProviderResponse(response, operation) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = createHttpError(`NOWPayments ${operation} failed.`, response.status >= 500 ? 502 : 400);
    error.providerStatus = response.status;
    error.providerData = data;
    throw error;
  }
  return data;
}

async function createProviderInvoice({ localOrderId, userId, topUp, payCurrency }) {
  const body = {
    price_amount: moneyString(topUp.amountUsd),
    price_currency: topUp.currency,
    order_id: localOrderId,
    order_description: topUp.description,
    ipn_callback_url: configuredIpnCallbackUrl(),
    success_url: configuredSuccessUrl(),
    cancel_url: configuredCancelUrl(),
    ...(payCurrency ? { pay_currency: payCurrency } : {}),
  };

  const response = await fetch(`${NOWPAYMENTS_API_BASE}/invoice`, {
    method: 'POST',
    headers: {
      'x-api-key': config.nowpayments.apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return readProviderResponse(response, 'invoice creation');
}

function providerInvoiceIdFromPayload(payload = {}) {
  return String(payload.invoice_id ?? payload.invoiceId ?? payload.invoice ?? '').trim();
}

function providerPaymentIdFromPayload(payload = {}) {
  return String(payload.payment_id ?? payload.paymentId ?? payload.payment ?? '').trim();
}

function providerStatusFromPayload(payload = {}) {
  return String(payload.payment_status ?? payload.paymentStatus ?? payload.status ?? '').trim().toLowerCase();
}

function sanitizedIpnMetadata(payload = {}) {
  const fields = [
    'payment_status',
    'payment_id',
    'invoice_id',
    'order_id',
    'price_amount',
    'price_currency',
    'pay_amount',
    'pay_currency',
    'actually_paid',
    'outcome_amount',
    'outcome_currency',
  ];
  return fields.reduce((memo, key) => {
    if (payload[key] !== undefined && payload[key] !== null) memo[key] = payload[key];
    return memo;
  }, {});
}

function mergeMetadata(existing, patch) {
  return safeJson({
    ...(existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {}),
    ...patch,
  });
}

function assertExpectedFiatAmount(order, payload) {
  const priceCurrency = String(payload.price_currency || payload.priceCurrency || order.currency || '').trim().toUpperCase();
  const priceAmount = decimalString(payload.price_amount ?? payload.priceAmount, { fallback: moneyString(order.amountUsd) });
  if (priceCurrency && priceCurrency !== order.currency) {
    throw createHttpError('NOWPayments IPN currency did not match the stored top-up order.', 409);
  }
  if (moneyToMicros(priceAmount) !== moneyToMicros(order.amountUsd)) {
    throw createHttpError('NOWPayments IPN amount did not match the stored top-up order.', 409);
  }
}

function sortedForSignature(value) {
  if (Array.isArray(value)) return value.map(sortedForSignature);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((memo, key) => {
      memo[key] = sortedForSignature(value[key]);
      return memo;
    }, {});
  }
  return value;
}

export function nowPaymentsIpnSignature(payload, secret = config.nowpayments.ipnSecret) {
  return crypto
    .createHmac('sha512', secret || '')
    .update(JSON.stringify(sortedForSignature(payload || {})))
    .digest('hex');
}

export function verifyNowPaymentsIpnSignature(payload, signature, secret = config.nowpayments.ipnSecret) {
  if (!secret) return false;
  const expected = nowPaymentsIpnSignature(payload, secret);
  const received = String(signature || '').trim().toLowerCase();
  if (!received || expected.length !== received.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(received, 'hex'));
}

export function nowPaymentsTopUpIdempotencyKey({ orderId, providerInvoiceId, providerPaymentId }) {
  return `nowpayments-top-up:${orderId}:${providerPaymentId || providerInvoiceId || 'payment'}`;
}

export function getNowPaymentsPrepaidPackages() {
  return config.nowpayments.prepaidPackages;
}

export function getNowPaymentsCustomTopUpConfig() {
  return config.nowpayments.customTopUp;
}

export function serializeNowPaymentsConfig() {
  return {
    packages: config.nowpayments.prepaidPackages.map((item) => ({
      id: item.id,
      amountUsd: moneyNumber(item.amountUsd),
      currency: item.currency,
      label: item.label,
    })),
    customTopUp: {
      minAmountUsd: moneyNumber(config.nowpayments.customTopUp.minAmountUsd),
      maxAmountUsd: moneyNumber(config.nowpayments.customTopUp.maxAmountUsd),
      currency: config.nowpayments.customTopUp.currency,
      decimalPlaces: config.nowpayments.customTopUp.decimalPlaces,
    },
    allowedPayCurrencies: config.nowpayments.allowedPayCurrencies,
    defaultPayCurrency: config.nowpayments.defaultPayCurrency,
    fiatCurrency: config.nowpayments.fiatCurrency,
    configured: Boolean(config.nowpayments.apiKey || config.nowpayments.prepaidPackages.length > 0),
  };
}

export function serializeNowPaymentsTopUpSelection(topUp, payCurrency = null) {
  if (!topUp) return null;
  return {
    type: topUp.type,
    packageId: topUp.packageId,
    amountUsd: moneyNumber(topUp.amountUsd),
    currency: topUp.currency,
    label: topUp.label,
    payCurrency,
  };
}

export async function createNowPaymentsTopUpInvoice({ userId, packageId, customAmount, amountUsd, currency, payCurrency, requestId }) {
  if (!userId) throw createHttpError('Authentication required.', 401);
  requireNowPaymentsConfigured();
  const topUp = normalizeTopUpSelection({ packageId, customAmount, amountUsd, currency });
  const normalizedPayCurrency = normalizePayCurrency(payCurrency);
  const localOrderId = crypto.randomUUID();
  const providerInvoice = await createProviderInvoice({ localOrderId, userId, topUp, payCurrency: normalizedPayCurrency });
  const providerInvoiceId = String(providerInvoice?.id || providerInvoice?.invoice_id || '').trim();
  const approvalUrl = String(providerInvoice?.invoice_url || providerInvoice?.payment_url || '').trim();
  if (!providerInvoiceId || !approvalUrl) throw createHttpError('NOWPayments invoice response did not include payment details.', 502);

  const providerPaymentId = String(providerInvoice.payment_id || '').trim() || null;
  const invoicePayCurrency = String(providerInvoice.pay_currency || normalizedPayCurrency || '').trim().toLowerCase() || null;
  const invoicePayAmount = decimalString(providerInvoice.pay_amount, { fallback: null });

  const order = await prisma.prepaidTopUpOrder.create({
    data: {
      id: localOrderId,
      userId,
      provider: 'NOWPAYMENTS',
      providerOrderId: providerInvoiceId,
      providerInvoiceId,
      providerPaymentId,
      packageId: topUp.packageId,
      topUpType: topUp.type,
      amountUsd: moneyString(topUp.amountUsd),
      currency: topUp.currency,
      status: 'PENDING',
      providerStatus: providerInvoice.payment_status || 'waiting',
      approvalUrl,
      payCurrency: invoicePayCurrency,
      payAmount: invoicePayAmount,
      metadata: safeJson({
        requestId,
        topUpType: topUp.type,
        topUpLabel: topUp.label,
        requestedPayCurrency: normalizedPayCurrency,
        fiatCurrency: topUp.currency,
        ...(topUp.type === TOP_UP_TYPES.CUSTOM ? {
          customCurrency: topUp.currency,
          customDecimalPlaces: topUp.decimalPlaces,
        } : {}),
      }),
    },
  });

  logger.info('NOWPayments crypto top-up invoice created', {
    context: 'billing_nowpayments',
    requestId,
    userId,
    providerInvoiceId,
    providerPaymentId,
    packageId: topUp.packageId,
    topUpType: topUp.type,
    amountUsd: moneyString(topUp.amountUsd),
    currency: topUp.currency,
    payCurrency: invoicePayCurrency,
  });

  return { order, package: topUp.package || null, topUp, payCurrency: invoicePayCurrency };
}

export async function handleNowPaymentsIpn({ payload, signature, requestId }) {
  requireNowPaymentsIpnConfigured();
  if (!verifyNowPaymentsIpnSignature(payload, signature)) {
    throw createHttpError('Invalid NOWPayments IPN signature.', 401);
  }

  const providerInvoiceId = providerInvoiceIdFromPayload(payload);
  const providerPaymentId = providerPaymentIdFromPayload(payload);
  const providerStatus = providerStatusFromPayload(payload);
  const localOrderId = String(payload?.order_id || payload?.orderId || '').trim();
  if (!providerStatus) throw createHttpError('NOWPayments IPN did not include a payment status.', 400);
  if (!providerInvoiceId && !providerPaymentId && !localOrderId) throw createHttpError('NOWPayments IPN did not identify an order.', 400);

  const order = await prisma.prepaidTopUpOrder.findFirst({
    where: {
      provider: 'NOWPAYMENTS',
      OR: [
        ...(localOrderId ? [{ id: localOrderId }] : []),
        ...(providerInvoiceId ? [{ providerOrderId: providerInvoiceId }, { providerInvoiceId }] : []),
        ...(providerPaymentId ? [{ providerPaymentId }, { providerCaptureId: providerPaymentId }] : []),
      ],
    },
    include: { creditTransaction: true },
  });
  if (!order) throw createHttpError('NOWPayments top-up order was not found.', 404);

  assertExpectedFiatAmount(order, payload);

  const payCurrency = String(payload.pay_currency || payload.payCurrency || order.payCurrency || '').trim().toLowerCase() || null;
  const payAmount = decimalString(payload.pay_amount ?? payload.payAmount, { fallback: order.payAmount ? String(order.payAmount) : null });
  const safeIpn = sanitizedIpnMetadata(payload);

  if (PENDING_PAYMENT_STATUSES.has(providerStatus)) {
    const updatedOrder = await prisma.prepaidTopUpOrder.update({
      where: { id: order.id },
      data: {
        status: order.creditTransactionId ? 'CAPTURED' : 'PENDING',
        providerStatus,
        ...(providerInvoiceId ? { providerInvoiceId, providerOrderId: providerInvoiceId } : {}),
        ...(providerPaymentId ? { providerPaymentId } : {}),
        ...(payCurrency ? { payCurrency } : {}),
        ...(payAmount ? { payAmount } : {}),
        metadata: mergeMetadata(order.metadata, { requestId, lastIpn: safeIpn }),
      },
    });
    return { order: updatedOrder, credited: false, idempotent: Boolean(order.creditTransactionId), status: providerStatus };
  }

  if (FAILED_PAYMENT_STATUSES.has(providerStatus)) {
    const updatedOrder = order.creditTransactionId
      ? await prisma.prepaidTopUpOrder.update({
        where: { id: order.id },
        data: {
          providerStatus,
          metadata: mergeMetadata(order.metadata, { requestId, lastIpn: safeIpn }),
        },
      })
      : await prisma.prepaidTopUpOrder.update({
        where: { id: order.id },
        data: {
          status: 'FAILED',
          providerStatus,
          failureReason: `NOWPayments payment ${providerStatus}.`,
          failedAt: new Date(),
          ...(providerInvoiceId ? { providerInvoiceId, providerOrderId: providerInvoiceId } : {}),
          ...(providerPaymentId ? { providerPaymentId } : {}),
          ...(payCurrency ? { payCurrency } : {}),
          ...(payAmount ? { payAmount } : {}),
          metadata: mergeMetadata(order.metadata, { requestId, lastIpn: safeIpn }),
        },
      });
    return { order: updatedOrder, credited: false, idempotent: Boolean(order.creditTransactionId), status: providerStatus };
  }

  if (!SUCCESSFUL_PAYMENT_STATUSES.has(providerStatus)) {
    const updatedOrder = await prisma.prepaidTopUpOrder.update({
      where: { id: order.id },
      data: {
        providerStatus,
        metadata: mergeMetadata(order.metadata, { requestId, lastIpn: safeIpn }),
      },
    });
    return { order: updatedOrder, credited: false, idempotent: Boolean(order.creditTransactionId), status: providerStatus };
  }

  const result = await prisma.$transaction(async (tx) => {
    const lockedRows = await tx.$queryRaw`
      SELECT "id", "userId", "status", "creditTransactionId", "metadata"
      FROM "PrepaidTopUpOrder"
      WHERE "id" = ${order.id}
      FOR UPDATE
    `;
    const lockedOrder = lockedRows[0];
    if (!lockedOrder) throw createHttpError('NOWPayments top-up order was not found.', 404);

    if (lockedOrder.creditTransactionId) {
      const alreadyCredited = await tx.creditTransaction.findUnique({ where: { id: lockedOrder.creditTransactionId } });
      const updatedOrder = await tx.prepaidTopUpOrder.update({
        where: { id: order.id },
        data: {
          status: 'CAPTURED',
          providerStatus,
          ...(providerInvoiceId ? { providerInvoiceId, providerOrderId: providerInvoiceId } : {}),
          ...(providerPaymentId ? { providerPaymentId, providerCaptureId: providerPaymentId } : {}),
          ...(payCurrency ? { payCurrency } : {}),
          ...(payAmount ? { payAmount } : {}),
          metadata: mergeMetadata(lockedOrder.metadata, { requestId, lastIpn: safeIpn }),
        },
        include: { creditTransaction: true },
      });
      return { order: updatedOrder, transaction: alreadyCredited, credited: false, idempotent: true };
    }

    const topUpType = normalizeTopUpType(order.topUpType, order.packageId);
    const credited = await applyCreditTransaction({
      client: tx,
      userId: order.userId,
      type: CREDIT_TRANSACTION_TYPES.PREPAID_TOP_UP,
      amountUsd: order.amountUsd,
      actor: { actorType: CREDIT_ACTOR_TYPES.SYSTEM },
      referenceType: 'nowpayments_payment',
      referenceId: providerPaymentId || providerInvoiceId || order.id,
      idempotencyKey: nowPaymentsTopUpIdempotencyKey({ orderId: order.id, providerInvoiceId: providerInvoiceId || order.providerInvoiceId, providerPaymentId }),
      metadata: {
        requestId,
        provider: 'NOWPAYMENTS',
        providerInvoiceId: providerInvoiceId || order.providerInvoiceId,
        providerPaymentId: providerPaymentId || null,
        packageId: order.packageId,
        topUpType,
        amountUsd: moneyString(order.amountUsd),
        currency: order.currency,
        payCurrency,
        payAmount,
      },
      auditEventType: 'credit.prepaid_top_up_captured',
    });

    const updatedOrder = await tx.prepaidTopUpOrder.update({
      where: { id: order.id },
      data: {
        status: 'CAPTURED',
        providerStatus,
        ...(providerInvoiceId ? { providerInvoiceId, providerOrderId: providerInvoiceId } : {}),
        ...(providerPaymentId ? { providerPaymentId, providerCaptureId: providerPaymentId } : {}),
        ...(payCurrency ? { payCurrency } : {}),
        ...(payAmount ? { payAmount } : {}),
        creditTransactionId: credited.transaction.id,
        capturedAt: new Date(),
        failureReason: null,
        metadata: mergeMetadata(lockedOrder.metadata, { requestId, lastIpn: safeIpn }),
      },
      include: { creditTransaction: true },
    });

    return { order: updatedOrder, transaction: credited.transaction, credited: !credited.idempotent, idempotent: credited.idempotent };
  });

  logger.info('NOWPayments crypto top-up IPN processed', {
    context: 'billing_nowpayments',
    requestId,
    userId: result.order.userId,
    orderId: result.order.id,
    providerInvoiceId: providerInvoiceId || result.order.providerInvoiceId,
    providerPaymentId: providerPaymentId || result.order.providerPaymentId,
    providerStatus,
    transactionId: result.transaction?.id || null,
    idempotent: result.idempotent,
  });

  return { ...result, status: providerStatus };
}

export { SUCCESSFUL_PAYMENT_STATUSES, PENDING_PAYMENT_STATUSES, FAILED_PAYMENT_STATUSES };
