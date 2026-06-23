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
  if (config.paypal.mock) return;
  if (!config.paypal.clientId || !config.paypal.clientSecret) {
    throw createHttpError('PayPal checkout is not configured.', 503);
  }
}

export function prepaidTopUpIdempotencyKey({ providerOrderId, providerCaptureId }) {
  return `paypal-top-up:${providerOrderId}:${providerCaptureId || 'capture'}`;
}

export function getPrepaidPackages() {
  return config.paypal.prepaidPackages;
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

async function createProviderOrder({ userId, package: selectedPackage, requestId }) {
  if (config.paypal.mock) {
    const providerOrderId = `PAYPAL-MOCK-ORDER-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return {
      id: providerOrderId,
      status: 'CREATED',
      links: [{ rel: 'approve', href: `${config.publicUrl || 'http://127.0.0.1:3000'}/mock-paypal/approve/${providerOrderId}` }],
      mock: true,
    };
  }

  const accessToken = await getPayPalAccessToken();
  const returnUrl = configuredReturnUrl();
  const cancelUrl = configuredCancelUrl();
  const body = {
    intent: 'CAPTURE',
    purchase_units: [{
      reference_id: selectedPackage.id,
      custom_id: userId,
      description: `RenderSphere prepaid credits ${selectedPackage.label}`,
      amount: {
        currency_code: selectedPackage.currency,
        value: moneyString(selectedPackage.amountUsd),
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
  if (config.paypal.mock) {
    const captureId = `PAYPAL-MOCK-CAPTURE-${providerOrderId}`;
    return {
      id: providerOrderId,
      status: 'COMPLETED',
      purchase_units: [{
        payments: {
          captures: [{
            id: captureId,
            status: 'COMPLETED',
            amount: { currency_code: 'USD', value: '0.00' },
          }],
        },
      }],
      mock: true,
    };
  }

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

function captureFromProviderOrder(captureResult, fallbackAmountUsd) {
  const capture = captureResult?.purchase_units
    ?.flatMap((unit) => unit?.payments?.captures || [])
    ?.find((item) => item?.id) || null;

  if (!capture?.id) throw createHttpError('PayPal capture response did not include a capture id.', 502);
  return {
    id: capture.id,
    status: capture.status || captureResult.status || 'UNKNOWN',
    amountUsd: capture.amount?.value || moneyString(fallbackAmountUsd),
    currency: capture.amount?.currency_code || 'USD',
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

export function serializeTopUpOrder(order) {
  if (!order) return null;
  return {
    id: order.id,
    provider: order.provider,
    providerOrderId: order.providerOrderId,
    providerCaptureId: order.providerCaptureId,
    packageId: order.packageId,
    amountUsd: moneyNumber(order.amountUsd),
    currency: order.currency,
    status: order.status,
    providerStatus: order.providerStatus,
    approvalUrl: order.approvalUrl,
    creditTransactionId: order.creditTransactionId,
    failureReason: order.failureReason,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    capturedAt: order.capturedAt,
    failedAt: order.failedAt,
  };
}

export async function createPayPalTopUpOrder({ userId, packageId, requestId }) {
  if (!userId) throw createHttpError('Authentication required.', 401);
  requirePayPalConfigured();
  const selectedPackage = getPrepaidPackage(packageId);

  const providerOrder = await createProviderOrder({ userId, package: selectedPackage, requestId });
  const approvalUrl = approvalLinkFromOrder(providerOrder);
  if (!providerOrder?.id || !approvalUrl) throw createHttpError('PayPal order response did not include checkout approval details.', 502);

  const order = await prisma.prepaidTopUpOrder.create({
    data: {
      userId,
      provider: 'PAYPAL',
      providerOrderId: providerOrder.id,
      packageId: selectedPackage.id,
      amountUsd: moneyString(selectedPackage.amountUsd),
      currency: selectedPackage.currency,
      status: 'CREATED',
      providerStatus: providerOrder.status || 'CREATED',
      approvalUrl,
      metadata: safeJson({
        requestId,
        paypalEnvironment: config.paypal.environment,
        mock: Boolean(config.paypal.mock),
      }),
    },
  });

  logger.info('PayPal prepaid top-up order created', {
    context: 'billing_paypal',
    requestId,
    userId,
    providerOrderId: order.providerOrderId,
    packageId: selectedPackage.id,
    amountUsd: moneyString(selectedPackage.amountUsd),
  });

  return { order, package: selectedPackage };
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

  const selectedPackage = getPrepaidPackage(existingOrder.packageId);
  const captureResult = await captureProviderOrder(normalizedProviderOrderId, requestId);
  const capture = captureFromProviderOrder(captureResult, selectedPackage.amountUsd);
  if (config.paypal.mock) capture.amountUsd = moneyString(selectedPackage.amountUsd);

  const expectedAmount = moneyToMicros(existingOrder.amountUsd);
  const capturedAmount = moneyToMicros(capture.amountUsd);
  if (capture.currency !== existingOrder.currency || capturedAmount !== expectedAmount || !COMPLETED_CAPTURE_STATUSES.has(capture.status) || !CAPTURED_ORDER_STATUSES.has(captureResult.status)) {
    const failureReason = 'PayPal capture was not completed for the expected package amount.';
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
        packageId: selectedPackage.id,
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
