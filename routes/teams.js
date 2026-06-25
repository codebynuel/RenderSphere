import express from 'express';
import { asyncHandler } from '../src/controllers/controllerUtils.js';
import { createTeamController } from '../src/controllers/teamController.js';

function createTeamsRouter({ accountRateLimit, requireAuth }) {
  const router = express.Router();
  const controller = createTeamController();

  router.use(requireAuth);

  // Team CRUD
  router.get('/', asyncHandler(controller.list));
  router.post('/', accountRateLimit, asyncHandler(controller.create));
  router.get('/:teamId', asyncHandler(controller.detail));
  router.get('/:teamId/balance', asyncHandler(controller.balance));
  router.get('/:teamId/member-spend', asyncHandler(controller.memberSpend));
  router.post('/:teamId/invite', accountRateLimit, asyncHandler(controller.invite));
  router.patch('/:teamId/members/:memberUserId', accountRateLimit, asyncHandler(controller.updateMember));
  router.delete('/:teamId/members/:memberUserId', accountRateLimit, asyncHandler(controller.removeMember));

  // Invite links
  router.post('/:teamId/invite-links', accountRateLimit, asyncHandler(controller.createInviteLink));
  router.get('/:teamId/invite-links', asyncHandler(controller.listInviteLinks));
  router.delete('/:teamId/invite-links/:linkId', accountRateLimit, asyncHandler(controller.revokeInviteLink));

  // Join via invite link (token is in URL path, no auth needed — but requireAuth is already applied above)
  router.post('/join/:token', asyncHandler(controller.joinViaInviteLink));

  // Activity log
  router.get('/:teamId/activity', asyncHandler(controller.activity));

  return router;
}

export { createTeamsRouter };
