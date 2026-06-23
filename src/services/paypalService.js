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

const PAYPAL_API_BASE = {
  sandbox: 'https://api-m.sandbox.paypal.com',
  live: 'https://api-m.paypal.com',
};

const COMPLETED_CAPTURE_STATUSES = new Set(['COMPLETED']);
const CAPTURED_ORDER_STATUSES = new Set(['COMPLETED', 'APPROVED']);
const TOP_UP_TYPES = Object.freeze({
  PACKAGE: 'PACKAGE',
  CUSTOM: 'CUSTOM',
});

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

function requirePayPalConfigured() {
  if (!config.paypal.clientId || !config.paypal.clientSecret) {
    throw createHttpError('PayPal checkout is not configured.', 503);
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
  return 'Custom top-up';
}

function normalizeCustomAmountPayload(customAmount = {}, amountUsd = undefined, currency = undefined) {
  const payload = customAmount && typeof customAmount === 'object' && !Array.isArray(customAmount) ? customAmount : {};
  const rawAmount = payload.amountUsd ?? payload.amount ?? payload.value ?? amountUsd;
  const rawAmountString = typeof rawAmount === 'number'
    ? (Number.isFinite(rawAmount) ? String(rawAmount) : '')
    : String(rawAmount ?? '').trim();

  const amountMatch = rawAmountString.match(/^(?:0|[1-9]\d*)(?:\.(\d+))?$/);
  if (!amountMatch) throw createHttpError('Custom top-up amount must be a positive decimal number.', 400);

  const fraction = amountMatch[1] || '';
  const decimalPlaces = config.paypal.customTopUp.decimalPlaces;
  if (fraction.length > decimalPlaces) {
    throw createHttpError(`Custom top-up amount supports up to ${decimalPlaces} decimal places.`, 400);
  }

  const amountMicros = moneyToMicros(rawAmountString);
  if (amountMicros <= 0n) throw createHttpError('Custom top-up amount must be greater than zero.', 400);

  const minMicros = moneyToMicros(config.paypal.customTopUp.minAmountUsd);
  const maxMicros = moneyToMicros(config.paypal.customTopUp.maxAmountUsd);
  if (amountMicros < minMicros) {
    throw createHttpError(`Custom top-up amount must be at least ${moneyString(config.paypal.customTopUp.minAmountUsd)} ${config.paypal.customTopUp.currency}.`, 400);
  }
  if (amountMicros > maxMicros) {
    throw createHttpError(`Custom top-up amount must be at most ${moneyString(config.paypal.customTopUp.maxAmountUsd)} ${config.paypal.customTopUp.currency}.`, 400);
  }

  const requestedCurrency = String(payload.currency ?? currency ?? config.paypal.customTopUp.currency).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(requestedCurrency)) {
    throw createHttpError('Custom top-up currency must be a three-letter ISO currency code.', 400);
  }
  if (requestedCurrency !== config.paypal.customTopUp.currency) {
    throw createHttpError(`Custom top-up currency must be ${config.paypal.customTopUp.currency}.`, 400);
  }

  return {
    type: TOP_UP_TYPES.CUSTOM,
    packageId: null,
    referenceId: 'custom-top-up',
    label: `Custom ${requestedCurrency} top-up`,
    description: 'RenderSphere custom prepaid credits',
    amountUsd: microsToMoneyString(amountMicros),
    currency: requestedCurrency,
    decimalPlaces,
  };
}

function normalizeTopUpSelection({ packageId, customAmount, amountUsd, currency }) {
  const normalizedPackageId = String(packageId || '').trim();
  const hasCustomPayload = customAmount !== undefined || amountUsd !== undefined || currency !== undefined;
  if (normalizedPackageId && hasCustomPayload) {
    throw createHttpError('Choose either a prepaid package or a custom top-up amount, not both.', 400);
  }
  if (normalizedPackageId) {
    const selectedPackage = getPrepaidPackage(normalizedPackageId);
    return {
      type: TOP_UP_TYPES.PACKAGE,
      packageId: selectedPackage.id,
      referenceId: selectedPackage.id,
      label: selectedPackage.label,
      description: `RenderSphere prepaid credits ${selectedPackage.label}`,
      amountUsd: moneyString(selectedPackage.amountUsd),
      currency: selectedPackage.currency,
      package: selectedPackage,
      decimalPlaces: 2,
    };
  }
  if (hasCustomPayload) return normalizeCustomAmountPayload(customAmount, amountUsd, currency);
  throw createHttpError('Select a prepaid package or enter a custom top-up amount.', 400);
}

export function prepaidTopUpIdempotencyKey({ providerOrderId, providerCaptureId }) {
  return `paypal-top-up:${providerOrderId}:${providerCaptureId || 'capture'}`;
}

export function getPrepaidPackages() {
  return config.paypal.prepaidPackages;
}

export function getPayPalCustomTopUpConfig() {
  return config.paypal.customTopUp;
}

export function getPrepaidPackage(packageId) {
  const normalizedPackageId = String(packageId || '').trim();
  const selectedPackage = config.paypal.prepaidPackages.find((item) => item.id === normalizedPackageId);
  if (!selectedPackage) throw createHttpError('Selected prepaid package is not available.', 400);
  return selectedPackage;
}

function paypalApiBase() {
  return PAYPAL_API_BASE[config.paypal.environment] || PAYPAL_API_BASE.sandbox;
}

async function readProviderResponse(response, operation) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = createHttpError(`PayPal ${operation} failed.`, response.status >= 500 ? 502 : 400);
    error.providerStatus = response.status;
    error.providerData = data;
    throw error;
  }
  return data;
}

async function getPayPalAccessToken() {
  requirePayPalConfigured();
  const credentials = Buffer.from(`${config.paypal.clientId}:${config.paypal.clientSecret}`).toString('base64');
  const response = await fetch(`${paypalApiBase()}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const data = await readProviderResponse(response, 'token request');
  if (!data.access_token) throw createHttpError('PayPal token response was invalid.', 502);
  return data.access_token;
}

function approvalLinkFromOrder(order) {
  return order?.links?.find((link) => link?.rel === 'approve')?.href || null;
}

function configuredReturnUrl() {
  if (!config.publicUrl) return undefined;
  return `${config.publicUrl.replace(/\/$/, '')}/dashboard?view=billing&paypal=return`;
}

function configuredCancelUrl() {
  if (!config.publicUrl) return undefined;
  return `${config.publicUrl.replace(/\/$/, '')}/dashboard?view=billing&paypal=cancel`;
}

async function createProviderOrder({ userId, topUp, requestId, origin }) {
  const baseOrigin = origin || config.publicUrl || `http://127.0.0.1:${process.env.PORT || 3000}`;

  const accessToken = await getPayPalAccessToken();
  const returnUrl = configuredReturnUrl();
  const cancelUrl = configuredCancelUrl();
  const body = {
    intent: 'CAPTURE',
    purchase_units: [{
      reference_id: topUp.referenceId,
      custom_id: userId,
      description: topUp.description,
      amount: {
        currency_code: topUp.currency,
        value: moneyString(topUp.amountUsd),
      },
    }],
    application_context: {
      brand_name: 'RenderSphere',
      landing_page: 'LOGIN',
      user_action: 'PAY_NOW',
      shipping_preference: 'NO_SHIPPING',
      ...(returnUrl ? { return_url: returnUrl } : {}),
      ...(cancelUrl ? { cancel_url: cancelUrl } : {}),
    },
  };

  const response = await fetch(`${paypalApiBase()}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      'PayPal-Request-Id': `rs-create-${requestId || crypto.randomUUID()}`.slice(0, 108),
    },
    body: JSON.stringify(body),
  });
  return readProviderResponse(response, 'order creation');
}

async function captureProviderOrder(providerOrderId, requestId) {
  const accessToken = await getPayPalAccessToken();
  const response = await fetch(`${paypalApiBase()}/v2/checkout/orders/${encodeURIComponent(providerOrderId)}/capture`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      'PayPal-Request-Id': `rs-capture-${providerOrderId}`.slice(0, 108),
    },
    body: '{}',
  });
  return readProviderResponse(response, 'order capture');
}

function captureFromProviderOrder(captureResult, fallbackAmountUsd, fallbackCurrency = 'USD') {
  const capture = captureResult?.purchase_units
    ?.flatMap((unit) => unit?.payments?.captures || [])
    ?.find((item) => item?.id) || null;

  if (!capture?.id) throw createHttpError('PayPal capture response did not include a capture id.', 502);
  return {
    id: capture.id,
    status: capture.status || captureResult.status || 'UNKNOWN',
    amountUsd: capture.amount?.value || moneyString(fallbackAmountUsd),
    currency: capture.amount?.currency_code || fallbackCurrency,
  };
}

export function serializePrepaidPackage(selectedPackage) {
  return {
    id: selectedPackage.id,
    amountUsd: moneyNumber(selectedPackage.amountUsd),
    currency: selectedPackage.currency,
    label: selectedPackage.label,
  };
}

export function serializeCustomTopUpConfig(customTopUp = config.paypal.customTopUp) {
  return {
    minAmountUsd: moneyNumber(customTopUp.minAmountUsd),
    maxAmountUsd: moneyNumber(customTopUp.maxAmountUsd),
    currency: customTopUp.currency,
    decimalPlaces: customTopUp.decimalPlaces,
  };
}

export function serializeTopUpSelection(topUp) {
  if (!topUp) return null;
  return {
    type: topUp.type,
    packageId: topUp.packageId,
    amountUsd: moneyNumber(topUp.amountUsd),
    currency: topUp.currency,
    label: topUp.label,
  };
}

export function serializeTopUpOrder(order) {
  if (!order) return null;
  const topUpType = normalizeTopUpType(order.topUpType, order.packageId);
  const metadata = order.metadata && typeof order.metadata === 'object' && !Array.isArray(order.metadata) ? order.metadata : null;
  return {
    id: order.id,
    provider: order.provider,
    providerOrderId: order.providerOrderId,
    providerCaptureId: order.providerCaptureId,
    providerInvoiceId: order.providerInvoiceId,
    providerPaymentId: order.providerPaymentId,
    packageId: order.packageId,
    topUpType,
    topUpLabel: topUpSelectionLabel(topUpType, order.packageId, metadata),
    amountUsd: moneyNumber(order.amountUsd),
    currency: order.currency,
    status: order.status,
    providerStatus: order.providerStatus,
    approvalUrl: order.approvalUrl,
    payCurrency: order.payCurrency,
    payAmount: order.payAmount === null || order.payAmount === undefined ? null : Number(order.payAmount),
    creditTransactionId: order.creditTransactionId,
    failureReason: order.failureReason,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    capturedAt: order.capturedAt,
    failedAt: order.failedAt,
  };
}

export async function createPayPalTopUpOrder({ userId, packageId, customAmount, amountUsd, currency, requestId, origin }) {
  if (!userId) throw createHttpError('Authentication required.', 401);
  requirePayPalConfigured();
  const topUp = normalizeTopUpSelection({ packageId, customAmount, amountUsd, currency });

  const providerOrder = await createProviderOrder({ userId, topUp, requestId, origin });
  const approvalUrl = approvalLinkFromOrder(providerOrder);
  if (!providerOrder?.id || !approvalUrl) throw createHttpError('PayPal order response did not include checkout approval details.', 502);

  const order = await prisma.prepaidTopUpOrder.create({
    data: {
      userId,
      provider: 'PAYPAL',
      providerOrderId: providerOrder.id,
      packageId: topUp.packageId,
      topUpType: topUp.type,
      amountUsd: moneyString(topUp.amountUsd),
      currency: topUp.currency,
      status: 'CREATED',
      providerStatus: providerOrder.status || 'CREATED',
      approvalUrl,
      metadata: safeJson({
        requestId,
        paypalEnvironment: config.paypal.environment,
        mock: Boolean(config.paypal.mock),
        topUpType: topUp.type,
        topUpLabel: topUp.label,
        ...(topUp.type === TOP_UP_TYPES.CUSTOM ? {
          customCurrency: topUp.currency,
          customDecimalPlaces: topUp.decimalPlaces,
        } : {}),
      }),
    },
  });

  logger.info('PayPal prepaid top-up order created', {
    context: 'billing_paypal',
    requestId,
    userId,
    providerOrderId: order.providerOrderId,
    packageId: topUp.packageId,
    topUpType: topUp.type,
    amountUsd: moneyString(topUp.amountUsd),
  });

  return { order, package: topUp.package || null, topUp };
}

export async function capturePayPalTopUpOrder({ userId, providerOrderId, requestId }) {
  if (!userId) throw createHttpError('Authentication required.', 401);
  const normalizedProviderOrderId = String(providerOrderId || '').trim();
  if (!normalizedProviderOrderId) throw createHttpError('PayPal order id is required.', 400);

  const existingOrder = await prisma.prepaidTopUpOrder.findFirst({
    where: { userId, provider: 'PAYPAL', providerOrderId: normalizedProviderOrderId },
    include: { creditTransaction: true },
  });
  if (!existingOrder) throw createHttpError('PayPal top-up order was not found.', 404);
  if (existingOrder.status === 'CAPTURED' && existingOrder.creditTransactionId) {
    return { order: existingOrder, transaction: existingOrder.creditTransaction, idempotent: true };
  }

  const topUpType = normalizeTopUpType(existingOrder.topUpType, existingOrder.packageId);
  const captureResult = await captureProviderOrder(normalizedProviderOrderId, requestId);
  const capture = captureFromProviderOrder(captureResult, existingOrder.amountUsd, existingOrder.currency);
  if (config.paypal.mock) {
    capture.amountUsd = moneyString(existingOrder.amountUsd);
    capture.currency = existingOrder.currency;
  }

  const expectedAmount = moneyToMicros(existingOrder.amountUsd);
  const capturedAmount = moneyToMicros(capture.amountUsd);
  if (capture.currency !== existingOrder.currency || capturedAmount !== expectedAmount || !COMPLETED_CAPTURE_STATUSES.has(capture.status) || !CAPTURED_ORDER_STATUSES.has(captureResult.status)) {
    const failureReason = 'PayPal capture was not completed for the expected top-up amount.';
    const failedOrder = await prisma.prepaidTopUpOrder.update({
      where: { id: existingOrder.id },
      data: {
        status: 'FAILED',
        providerStatus: capture.status || captureResult.status || 'UNKNOWN',
        providerCaptureId: capture.id,
        failureReason,
        failedAt: new Date(),
        metadata: safeJson({
          ...(existingOrder.metadata && typeof existingOrder.metadata === 'object' ? existingOrder.metadata : {}),
          requestId,
          captureStatus: capture.status,
          orderStatus: captureResult.status,
          captureCurrency: capture.currency,
          captureAmountUsd: capture.amountUsd,
        }),
      },
    });
    throw Object.assign(createHttpError(failureReason, 409), { order: failedOrder });
  }

  const result = await prisma.$transaction(async (tx) => {
    const lockedRows = await tx.$queryRaw`
      SELECT "id", "status", "creditTransactionId", "metadata"
      FROM "PrepaidTopUpOrder"
      WHERE "id" = ${existingOrder.id}
      FOR UPDATE
    `;
    const lockedOrder = lockedRows[0];
    if (!lockedOrder) throw createHttpError('PayPal top-up order was not found.', 404);

    if (lockedOrder.creditTransactionId) {
      const alreadyCredited = await tx.creditTransaction.findUnique({ where: { id: lockedOrder.creditTransactionId } });
      const order = await tx.prepaidTopUpOrder.findUnique({ where: { id: existingOrder.id }, include: { creditTransaction: true } });
      return { order, transaction: alreadyCredited, idempotent: true };
    }

    const credited = await applyCreditTransaction({
      client: tx,
      userId,
      type: CREDIT_TRANSACTION_TYPES.PREPAID_TOP_UP,
      amountUsd: existingOrder.amountUsd,
      actor: { actorType: CREDIT_ACTOR_TYPES.USER, actorId: userId },
      referenceType: 'paypal_order',
      referenceId: normalizedProviderOrderId,
      idempotencyKey: prepaidTopUpIdempotencyKey({ providerOrderId: normalizedProviderOrderId, providerCaptureId: capture.id }),
      metadata: {
        requestId,
        provider: 'PAYPAL',
        providerOrderId: normalizedProviderOrderId,
        providerCaptureId: capture.id,
        packageId: existingOrder.packageId,
        topUpType,
        amountUsd: moneyString(existingOrder.amountUsd),
        currency: existingOrder.currency,
        paypalEnvironment: config.paypal.environment,
        mock: Boolean(config.paypal.mock),
      },
      auditEventType: 'credit.prepaid_top_up_captured',
    });

    const updatedOrder = await tx.prepaidTopUpOrder.update({
      where: { id: existingOrder.id },
      data: {
        status: 'CAPTURED',
        providerStatus: capture.status,
        providerCaptureId: capture.id,
        creditTransactionId: credited.transaction.id,
        capturedAt: new Date(),
        failureReason: null,
        metadata: safeJson({
          ...(lockedOrder.metadata && typeof lockedOrder.metadata === 'object' ? lockedOrder.metadata : {}),
          requestId,
          orderStatus: captureResult.status,
          captureStatus: capture.status,
        }),
      },
      include: { creditTransaction: true },
    });

    return { order: updatedOrder, transaction: credited.transaction, idempotent: credited.idempotent };
  });

  logger.info('PayPal prepaid top-up captured', {
    context: 'billing_paypal',
    requestId,
    userId,
    providerOrderId: normalizedProviderOrderId,
    providerCaptureId: capture.id,
    orderId: result.order.id,
    topUpType,
    transactionId: result.transaction?.id || null,
    idempotent: result.idempotent,
  });

  return result;
}

export async function listPrepaidTopUpOrders({ userId, pagination }) {
  const where = { userId };
  const [totalItems, orders] = await Promise.all([
    prisma.prepaidTopUpOrder.count({ where }),
    prisma.prepaidTopUpOrder.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: pagination.skip,
      take: pagination.take,
    }),
  ]);
  return { totalItems, orders };
}
