import express from 'express';
import { asyncHandler } from '../src/controllers/controllerUtils.js';
import { createJobController } from '../src/controllers/jobController.js';

function createJobsRouter({ emitJobUpdate, requireAuth }) {
  const router = express.Router();
  const controller = createJobController({ emitJobUpdate });

  router.get('/jobs', requireAuth, asyncHandler(controller.listJobs));
  router.get('/rendered-files', requireAuth, asyncHandler(controller.listRenderedFiles));
  router.get('/rendered-files/:jobId/download', requireAuth, asyncHandler(controller.downloadRenderedFile));
  router.get('/job-status/:jobId', requireAuth, asyncHandler(controller.getJobStatus));

  return router;
}

export { createJobsRouter };
