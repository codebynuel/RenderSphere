import express from 'express';

import { asyncHandler } from '../src/controllers/controllerUtils.js';
import { buildPaginationMeta, parsePaginationQuery } from '../src/controllers/pagination.js';
import {
  capturePayPalTopUpOrder,
  createPayPalTopUpOrder,
  getPayPalCustomTopUpConfig,
  getPrepaidPackages,
  listPrepaidTopUpOrders,
  serializeCustomTopUpConfig,
  serializePrepaidPackage,
  serializeTopUpOrder,
  serializeTopUpSelection,
} from '../src/services/paypalService.js';

function createBillingRouter({ accountRateLimit, requireAuth }) {
  const router = express.Router();

  router.use(requireAuth);

  router.get('/prepaid-packages', (req, res) => {
    res.json({
      packages: getPrepaidPackages().map(serializePrepaidPackage),
      customTopUp: serializeCustomTopUpConfig(getPayPalCustomTopUpConfig()),
    });
  });

  router.get('/recharges', asyncHandler(async (req, res) => {
    const pagination = parsePaginationQuery(req.query);
    const { totalItems, orders } = await listPrepaidTopUpOrders({ userId: req.user.id, pagination });

    res.json({
      recharges: orders.map(serializeTopUpOrder),
      pagination: buildPaginationMeta({ ...pagination, totalItems }),
    });
  }));

  router.post('/paypal/orders', accountRateLimit, asyncHandler(async (req, res) => {
    const result = await createPayPalTopUpOrder({
      userId: req.user.id,
      packageId: req.body?.packageId,
      customAmount: req.body?.customAmount,
      amountUsd: req.body?.amountUsd,
      currency: req.body?.currency,
      requestId: req.id || req.requestId || null,
    });

    res.status(201).json({
      order: serializeTopUpOrder(result.order),
      package: result.package ? serializePrepaidPackage(result.package) : null,
      topUp: serializeTopUpSelection(result.topUp),
    });
  }));

  router.post('/paypal/orders/:providerOrderId/capture', accountRateLimit, asyncHandler(async (req, res) => {
    const result = await capturePayPalTopUpOrder({
      userId: req.user.id,
      providerOrderId: req.params.providerOrderId,
      requestId: req.id || req.requestId || null,
    });

    res.json({
      order: serializeTopUpOrder(result.order),
      idempotent: Boolean(result.idempotent),
      transactionId: result.transaction?.id || result.order?.creditTransactionId || null,
    });
  }));

  return router;
}

export { createBillingRouter };
