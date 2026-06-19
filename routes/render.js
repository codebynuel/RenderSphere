import express from 'express';
import { asyncHandler } from '../src/controllers/controllerUtils.js';
import { createRenderController } from '../src/controllers/renderController.js';

function createRenderRouter({ emitJobUpdate, renderRateLimit, requireAuth }) {
  const router = express.Router();
  const controller = createRenderController({ emitJobUpdate });

  router.post('/get-upload-url', requireAuth, renderRateLimit, asyncHandler(controller.getUploadUrl));
  router.post('/trigger-render', requireAuth, renderRateLimit, asyncHandler(controller.triggerRender));
  router.post('/cancel-job', requireAuth, renderRateLimit, asyncHandler(controller.cancelJob));

  return router;
}

export { createRenderRouter };
