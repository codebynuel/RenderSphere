import express from 'express';
import { asyncHandler } from '../src/controllers/controllerUtils.js';
import { createTeamController } from '../src/controllers/teamController.js';

function createTeamsRouter({ accountRateLimit, requireAuth }) {
  const router = express.Router();
  const controller = createTeamController();

  router.use(requireAuth);

  router.get('/', asyncHandler(controller.list));
  router.post('/', accountRateLimit, asyncHandler(controller.create));
  router.get('/:teamId', asyncHandler(controller.detail));
  router.get('/:teamId/balance', asyncHandler(controller.balance));
  router.post('/:teamId/invite', accountRateLimit, asyncHandler(controller.invite));
  router.patch('/:teamId/members/:memberUserId', accountRateLimit, asyncHandler(controller.updateMember));
  router.delete('/:teamId/members/:memberUserId', accountRateLimit, asyncHandler(controller.removeMember));

  return router;
}

export { createTeamsRouter };
