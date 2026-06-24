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
import {
  createNowPaymentsTopUpInvoice,
  handleNowPaymentsIpn,
  serializeNowPaymentsConfig,
  serializeNowPaymentsTopUpSelection,
} from '../src/services/nowpaymentsService.js';
import { isPaymentProviderEnabled } from '../src/services/settingsService.js';

function createBillingRouter({ accountRateLimit, requireAuth }) {
  const router = express.Router();

  router.post('/nowpayments/ipn', asyncHandler(async (req, res) => {
    const result = await handleNowPaymentsIpn({
      payload: req.body || {},
      signature: req.get('x-nowpayments-sig') || req.get('x-nowpayments-signature') || '',
      requestId: req.id || req.requestId || null,
    });

    res.json({
      ok: true,
      status: result.status,
      credited: Boolean(result.credited),
      idempotent: Boolean(result.idempotent),
      order: serializeTopUpOrder(result.order),
      transactionId: result.transaction?.id || result.order?.creditTransactionId || null,
    });
  }));

  router.use(requireAuth);

  router.get('/prepaid-packages', async (req, res) => {
    const [paypalEnabled, nowpaymentsConfig] = await Promise.all([
      isPaymentProviderEnabled('paypal'),
      Promise.resolve(serializeNowPaymentsConfig()),
    ]);

    const paypalPackages = paypalEnabled ? getPrepaidPackages().map(serializePrepaidPackage) : [];
    const paypalCustomTopUp = paypalEnabled ? serializeCustomTopUpConfig(getPayPalCustomTopUpConfig()) : null;

    res.json({
      packages: paypalPackages,
      customTopUp: paypalCustomTopUp,
      paypal: paypalEnabled ? {
        packages: paypalPackages,
        customTopUp: paypalCustomTopUp,
      } : null,
      nowpayments: nowpaymentsConfig,
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
    if (!(await isPaymentProviderEnabled('paypal'))) {
      return res.status(503).json({ error: 'PayPal payments are currently disabled by the administrator.' });
    }
    const result = await createPayPalTopUpOrder({
      userId: req.user.id,
      packageId: req.body?.packageId,
      customAmount: req.body?.customAmount,
      amountUsd: req.body?.amountUsd,
      currency: req.body?.currency,
      requestId: req.id || req.requestId || null,
      origin: `${req.protocol}://${req.get('host')}`,
    });

    res.status(201).json({
      order: serializeTopUpOrder(result.order),
      package: result.package ? serializePrepaidPackage(result.package) : null,
      topUp: serializeTopUpSelection(result.topUp),
    });
  }));

  router.post('/nowpayments/invoices', accountRateLimit, asyncHandler(async (req, res) => {
    if (!(await isPaymentProviderEnabled('nowpayments'))) {
      return res.status(503).json({ error: 'NOWPayments crypto payments are currently disabled by the administrator.' });
    }
    const result = await createNowPaymentsTopUpInvoice({
      userId: req.user.id,
      packageId: req.body?.packageId,
      customAmount: req.body?.customAmount,
      amountUsd: req.body?.amountUsd,
      currency: req.body?.currency,
      payCurrency: req.body?.payCurrency,
      requestId: req.id || req.requestId || null,
    });

    res.status(201).json({
      order: serializeTopUpOrder(result.order),
      package: result.package ? serializePrepaidPackage(result.package) : null,
      topUp: serializeNowPaymentsTopUpSelection(result.topUp, result.payCurrency),
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
