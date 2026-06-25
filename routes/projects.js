import express from 'express';
import { asyncHandler } from '../src/controllers/controllerUtils.js';
import { createProjectController } from '../src/controllers/projectController.js';

function createProjectsRouter({ accountRateLimit, requireAuth }) {
  const router = express.Router();
  const controller = createProjectController();

  router.use(requireAuth);

  // Project CRUD
  router.get('/', asyncHandler(controller.listProjects));
  router.post('/', accountRateLimit, asyncHandler(controller.createProject));
  router.patch('/:projectId', accountRateLimit, asyncHandler(controller.updateProject));
  router.delete('/:projectId', accountRateLimit, asyncHandler(controller.deleteProject));

  // Project member management
  router.get('/:projectId/members', asyncHandler(controller.listMembers));
  router.post('/:projectId/members', accountRateLimit, asyncHandler(controller.addMember));
  router.patch('/:projectId/members/:memberUserId', accountRateLimit, asyncHandler(controller.updateMember));
  router.delete('/:projectId/members/:memberUserId', accountRateLimit, asyncHandler(controller.removeMember));

  return router;
}

export { createProjectsRouter };
