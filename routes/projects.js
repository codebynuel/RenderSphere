import express from 'express';
import { asyncHandler } from '../src/controllers/controllerUtils.js';
import { createProjectController } from '../src/controllers/projectController.js';

function createProjectsRouter({ requireAuth }) {
  const router = express.Router();
  const controller = createProjectController();

  router.use(requireAuth);
  router.get('/', asyncHandler(controller.listProjects));
  router.post('/', asyncHandler(controller.createProject));
  router.patch('/:projectId', asyncHandler(controller.updateProject));
  router.delete('/:projectId', asyncHandler(controller.deleteProject));

  return router;
}

export { createProjectsRouter };
