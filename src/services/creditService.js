import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';

export const CREDIT_TRANSACTION_TYPES = Object.freeze({
  CREDIT_GRANT: 'CREDIT_GRANT',
  PROMO_CREDIT: 'PROMO_CREDIT',
  PREPAID_TOP_UP: 'PREPAID_TOP_UP',
  RENDER_RESERVATION_HOLD: 'RENDER_RESERVATION_HOLD',
  RENDER_CHARGE: 'RENDER_CHARGE',
  REFUND: 'REFUND',
  RESERVATION_RELEASE: 'RESERVATION_RELEASE',
  ADMIN_ADJUSTMENT: 'ADMIN_ADJUSTMENT',
});

export class InsufficientCreditsError extends Error {
  constructor({ requiredUsd, availableUsd }) {
    super(`Insufficient prepaid credits. Required $${Number(requiredUsd).toFixed(2)}, available $${Number(availableUsd).toFixed(2)}.`);
    this.name = 'InsufficientCreditsError';
    this.status = 402;
    this.requiredUsd = requiredUsd;
    this.availableUsd = availableUsd;
  }
}

export const CREDIT_ACTOR_TYPES = Object.freeze({
  USER: 'USER',
  ADMIN: 'ADMIN',
  SYSTEM: 'SYSTEM',
});

const MONEY_SCALE = 1_000_000n;
const MONEY_DECIMAL_PLACES = 6;
const DEBIT_TYPES = new Set([
  CREDIT_TRANSACTION_TYPES.RENDER_RESERVATION_HOLD,
  CREDIT_TRANSACTION_TYPES.RENDER_CHARGE,
]);
const CREDIT_TYPES = new Set([
  CREDIT_TRANSACTION_TYPES.CREDIT_GRANT,
  CREDIT_TRANSACTION_TYPES.PROMO_CREDIT,
  CREDIT_TRANSACTION_TYPES.PREPAID_TOP_UP,
  CREDIT_TRANSACTION_TYPES.REFUND,
  CREDIT_TRANSACTION_TYPES.RESERVATION_RELEASE,
]);

function decimalLikeToString(value) {
  if (value instanceof Prisma.Decimal) return value.toFixed(MONEY_DECIMAL_PLACES);
  if (typeof value === 'number') return value.toFixed(MONEY_DECIMAL_PLACES);
  return String(value ?? '0').trim();
}

export function moneyToMicros(value) {
  const rawValue = decimalLikeToString(value);
  const match = rawValue.match(/^(-)?(\d+)(?:\.(\d+))?$/);
  if (!match) throw new Error(`Invalid USD money value: ${rawValue}`);

  const [, negative, wholePart, fractionPart = ''] = match;
  const paddedFraction = fractionPart.padEnd(MONEY_DECIMAL_PLACES + 1, '0');
  const micros = BigInt(wholePart) * MONEY_SCALE + BigInt(paddedFraction.slice(0, MONEY_DECIMAL_PLACES));
  const roundedMicros = Number(paddedFraction[MONEY_DECIMAL_PLACES] || '0') >= 5 ? micros + 1n : micros;
  return negative ? -roundedMicros : roundedMicros;
}

export function microsToMoneyString(micros) {
  const sign = micros < 0n ? '-' : '';
  const absoluteMicros = micros < 0n ? -micros : micros;
  const whole = absoluteMicros / MONEY_SCALE;
  const fraction = String(absoluteMicros % MONEY_SCALE).padStart(MONEY_DECIMAL_PLACES, '0');
  return `${sign}${whole}.${fraction}`;
}

export function microsToNumber(micros) {
  return Number(micros) / Number(MONEY_SCALE);
}

export function normalizeMoneyNumber(value) {
  return microsToNumber(moneyToMicros(value));
}

function signedAmountMicros(type, amountUsd) {
  const amountMicros = moneyToMicros(amountUsd);
  const absoluteMicros = amountMicros < 0n ? -amountMicros : amountMicros;
  if (absoluteMicros <= 0n) throw new Error('Credit transaction amount must be greater than zero.');

  if (DEBIT_TYPES.has(type)) return -absoluteMicros;
  if (CREDIT_TYPES.has(type)) return absoluteMicros;
  return amountMicros;
}

function normalizeActor(actor = {}) {
  const actorType = Object.values(CREDIT_ACTOR_TYPES).includes(actor.actorType) ? actor.actorType : CREDIT_ACTOR_TYPES.SYSTEM;
  return {
    actorType,
    actorId: actor.actorId ? String(actor.actorId).slice(0, 120) : null,
    actorEmail: actor.actorEmail ? String(actor.actorEmail).slice(0, 320) : null,
  };
}

function normalizeOptionalString(value, maxLength = 160) {
  const normalized = String(value || '').trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

async function findExistingTransaction(tx, idempotencyKey) {
  if (!idempotencyKey) return null;
  return tx.creditTransaction.findUnique({ where: { idempotencyKey } });
}

export async function writeCreditAuditEvent({
  client = prisma,
  eventType,
  targetUserId = null,
  actor = {},
  creditTransactionId = null,
  jobId = null,
  referenceType = null,
  referenceId = null,
  idempotencyKey = null,
  metadata = null,
}) {
  const normalizedActor = normalizeActor(actor);
  return client.creditAuditEvent.create({
    data: {
      eventType: String(eventType || '').trim().slice(0, 160) || 'credit.audit_event',
      targetUserId,
      ...normalizedActor,
      creditTransactionId,
      jobId,
      referenceType: normalizeOptionalString(referenceType),
      referenceId: normalizeOptionalString(referenceId),
      idempotencyKey: normalizeOptionalString(idempotencyKey, 240),
      metadata,
    },
  });
}

export async function applyCreditTransaction({
  client = prisma,
  userId,
  type,
  amountUsd,
  actor = {},
  referenceType = null,
  referenceId = null,
  jobId = null,
  idempotencyKey = null,
  metadata = null,
  auditEventType = null,
  allowNegativeBalance = false,
}) {
  if (!userId) throw new Error('userId is required for credit transactions.');
  if (!Object.values(CREDIT_TRANSACTION_TYPES).includes(type)) throw new Error(`Unsupported credit transaction type: ${type}`);

  const normalizedIdempotencyKey = normalizeOptionalString(idempotencyKey, 240);
  const run = async (tx) => {
    const existing = await findExistingTransaction(tx, normalizedIdempotencyKey);
    if (existing) return { transaction: existing, idempotent: true };

    const signedMicros = signedAmountMicros(type, amountUsd);
    const lockedUsers = await tx.$queryRaw`
      SELECT "starterBalanceUsd"
      FROM "User"
      WHERE "id" = ${userId}
      FOR UPDATE
    `;
    const user = lockedUsers[0];
    if (!user) throw new Error(`User ${userId} not found for credit transaction.`);

    const balanceBeforeMicros = moneyToMicros(user.starterBalanceUsd);
    const balanceAfterMicros = balanceBeforeMicros + signedMicros;
    if (!allowNegativeBalance && balanceAfterMicros < 0n) {
      throw new InsufficientCreditsError({
        requiredUsd: microsToNumber(signedMicros < 0n ? -signedMicros : signedMicros),
        availableUsd: microsToNumber(balanceBeforeMicros),
      });
    }
    const balanceAfterNumber = microsToNumber(balanceAfterMicros);
    const normalizedActor = normalizeActor(actor);

    const updatedUser = await tx.user.update({
      where: { id: userId },
      data: { starterBalanceUsd: balanceAfterNumber },
      select: { starterBalanceUsd: true },
    });

    const transaction = await tx.creditTransaction.create({
      data: {
        userId,
        type,
        amountUsd: microsToMoneyString(signedMicros),
        balanceBeforeUsd: microsToMoneyString(balanceBeforeMicros),
        balanceAfterUsd: microsToMoneyString(moneyToMicros(updatedUser.starterBalanceUsd)),
        ...normalizedActor,
        referenceType: normalizeOptionalString(referenceType),
        referenceId: normalizeOptionalString(referenceId),
        jobId: normalizeOptionalString(jobId),
        idempotencyKey: normalizedIdempotencyKey,
        metadata,
      },
    });

    await writeCreditAuditEvent({
      client: tx,
      eventType: auditEventType || `credit.${type.toLowerCase()}`,
      targetUserId: userId,
      actor,
      creditTransactionId: transaction.id,
      jobId: normalizeOptionalString(jobId),
      referenceType,
      referenceId,
      idempotencyKey: normalizedIdempotencyKey,
      metadata: {
        ...(metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}),
        amountUsd: transaction.amountUsd,
        balanceBeforeUsd: transaction.balanceBeforeUsd,
        balanceAfterUsd: transaction.balanceAfterUsd,
      },
    });

    return { transaction, idempotent: false };
  };

  if (client === prisma) return prisma.$transaction(run);
  return run(client);
}

export function renderReservationIdempotencyKey(referenceId) {
  return `render-reservation:${referenceId}`;
}

export function renderReservationReleaseIdempotencyKey(referenceId) {
  return `render-reservation-release:${referenceId}`;
}

export function renderChargeIdempotencyKey(jobId) {
  return `render-charge:${jobId}`;
}

export async function reserveRenderCredits({
  client = prisma,
  userId,
  referenceId,
  jobId = null,
  amountUsd,
  estimatedCostUsd = null,
  maxBudgetUsd = null,
  actor = { actorType: CREDIT_ACTOR_TYPES.SYSTEM },
  metadata = {},
}) {
  return applyCreditTransaction({
    client,
    userId,
    type: CREDIT_TRANSACTION_TYPES.RENDER_RESERVATION_HOLD,
    amountUsd,
    actor,
    referenceType: 'render_reservation',
    referenceId,
    jobId,
    idempotencyKey: renderReservationIdempotencyKey(referenceId),
    metadata: {
      ...metadata,
      estimatedCostUsd,
      maxBudgetUsd,
    },
    auditEventType: 'credit.render_reservation_created',
  });
}

export async function releaseRenderReservation({
  client = prisma,
  userId,
  referenceId,
  jobId = null,
  amountUsd,
  actor = { actorType: CREDIT_ACTOR_TYPES.SYSTEM },
  metadata = {},
}) {
  return applyCreditTransaction({
    client,
    userId,
    type: CREDIT_TRANSACTION_TYPES.RESERVATION_RELEASE,
    amountUsd,
    actor,
    referenceType: 'render_reservation',
    referenceId,
    jobId,
    idempotencyKey: renderReservationReleaseIdempotencyKey(referenceId),
    metadata,
    auditEventType: 'credit.render_reservation_released',
  });
}

export async function chargeRenderCredits({
  client = prisma,
  userId,
  jobId,
  amountUsd,
  billableSeconds = null,
  pricePerSecondUsd = null,
  actor = { actorType: CREDIT_ACTOR_TYPES.SYSTEM },
  metadata = {},
}) {
  return applyCreditTransaction({
    client,
    userId,
    type: CREDIT_TRANSACTION_TYPES.RENDER_CHARGE,
    amountUsd,
    actor,
    referenceType: 'render_job',
    referenceId: jobId,
    jobId,
    idempotencyKey: renderChargeIdempotencyKey(jobId),
    metadata: {
      ...metadata,
      billableSeconds,
      pricePerSecondUsd,
    },
    auditEventType: 'credit.render_charge_applied',
  });
}

export async function grantCredits({
  client = prisma,
  userId,
  amountUsd,
  actor = { actorType: CREDIT_ACTOR_TYPES.SYSTEM },
  referenceType = 'credit_grant',
  referenceId = null,
  idempotencyKey = null,
  metadata = {},
  type = CREDIT_TRANSACTION_TYPES.CREDIT_GRANT,
}) {
  return applyCreditTransaction({
    client,
    userId,
    type,
    amountUsd,
    actor,
    referenceType,
    referenceId,
    idempotencyKey,
    metadata,
    auditEventType: 'credit.grant_applied',
  });
}
