import express from 'express';
import { asyncHandler } from '../src/controllers/controllerUtils.js';
import { createRenderController } from '../src/controllers/renderController.js';

function createRenderRouter({ emitJobUpdate, renderRateLimit, requireAuth }) {
  const router = express.Router();
  const controller = createRenderController({ emitJobUpdate });

  router.post('/get-upload-url', renderRateLimit, requireAuth, asyncHandler(controller.getUploadUrl));
  router.post('/trigger-render', renderRateLimit, requireAuth, asyncHandler(controller.triggerRender));
  router.post('/cancel-job', requireAuth, asyncHandler(controller.cancelJob));

  return router;
}

export { createRenderRouter };
