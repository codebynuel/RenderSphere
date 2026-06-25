import { logger, withRequest } from '../../helpers/logger.js';
import {
  createTeam,
  createInviteLink,
  getTeamActivity,
  getTeamBalance,
  getTeamDetail,
  getTeamMemberSpend,
  getTeamsForUser,
  inviteTeamMember,
  joinViaInviteLink,
  listInviteLinks,
  normalizeRole,
  removeTeamMember,
  revokeInviteLink,
  updateTeamMember,
} from '../services/teamService.js';

export function createTeamController() {
  return {
    async create(req, res) {
      const { name } = req.body;
      if (!name || String(name).trim().length < 1) return res.status(400).json({ error: 'Team name is required' });

      try {
        const team = await createTeam(req.user.id, String(name).trim());
        logger.info('Team created', { context: 'team', userId: req.user.id, teamId: team.id });
        return res.status(201).json({ team });
      } catch (error) {
        logger.error('Failed to create team', withRequest(req, { context: 'team', error }));
        return res.status(500).json({ error: 'Failed to create team' });
      }
    },

    async list(req, res) {
      try {
        const teams = await getTeamsForUser(req.user.id);
        return res.json({ teams });
      } catch (error) {
        logger.error('Failed to list teams', withRequest(req, { context: 'team', error }));
        return res.status(500).json({ error: 'Failed to list teams' });
      }
    },

    async detail(req, res) {
      try {
        const team = await getTeamDetail(req.params.teamId, req.user.id);
        return res.json({ team });
      } catch (error) {
        if (error.status === 403) return res.status(403).json({ error: error.message });
        logger.error('Failed to get team', withRequest(req, { context: 'team', error }));
        return res.status(500).json({ error: 'Failed to get team' });
      }
    },

    async invite(req, res) {
      const { email, role, budgetCapUsd } = req.body;
      if (!email) return res.status(400).json({ error: 'Email is required' });

      try {
        const member = await inviteTeamMember(req.params.teamId, req.user.id, email, role, budgetCapUsd);
        logger.info('Team member invited', { context: 'team', userId: req.user.id, teamId: req.params.teamId, email, role });
        return res.status(201).json({ member });
      } catch (error) {
        if (error.status === 404) return res.status(404).json({ error: error.message });
        if (error.status === 403) return res.status(403).json({ error: error.message });
        logger.error('Failed to invite team member', withRequest(req, { context: 'team', error }));
        return res.status(500).json({ error: 'Failed to invite member' });
      }
    },

    async updateMember(req, res) {
      try {
        await updateTeamMember(req.params.teamId, req.user.id, req.params.memberUserId, req.body);
        return res.json({ success: true });
      } catch (error) {
        if (error.status) return res.status(error.status).json({ error: error.message });
        logger.error('Failed to update team member', withRequest(req, { context: 'team', error }));
        return res.status(500).json({ error: 'Failed to update member' });
      }
    },

    async removeMember(req, res) {
      try {
        await removeTeamMember(req.params.teamId, req.user.id, req.params.memberUserId);
        return res.json({ success: true });
      } catch (error) {
        if (error.status) return res.status(error.status).json({ error: error.message });
        logger.error('Failed to remove team member', withRequest(req, { context: 'team', error }));
        return res.status(500).json({ error: 'Failed to remove member' });
      }
    },

    async balance(req, res) {
      try {
        const balance = await getTeamBalance(req.params.teamId, req.user.id);
        return res.json(balance);
      } catch (error) {
        if (error.status === 403) return res.status(403).json({ error: error.message });
        return res.status(500).json({ error: 'Failed to get team balance' });
      }
    },

    async memberSpend(req, res) {
      try {
        const data = await getTeamMemberSpend(req.params.teamId, req.user.id);
        return res.json(data);
      } catch (error) {
        if (error.status === 403) return res.status(403).json({ error: error.message });
        return res.status(500).json({ error: 'Failed to get member spend' });
      }
    },

    // --- Invite links ---

    async createInviteLink(req, res) {
      const { role, maxUses, expiresInHours } = req.body;
      try {
        const link = await createInviteLink(req.params.teamId, req.user.id, { role, maxUses, expiresInHours });
        logger.info('Team invite link created', { context: 'team', userId: req.user.id, teamId: req.params.teamId, linkId: link.id });
        return res.status(201).json({ link });
      } catch (error) {
        if (error.status) return res.status(error.status).json({ error: error.message });
        logger.error('Failed to create invite link', withRequest(req, { context: 'team', error }));
        return res.status(500).json({ error: 'Failed to create invite link' });
      }
    },

    async listInviteLinks(req, res) {
      try {
        const links = await listInviteLinks(req.params.teamId, req.user.id);
        return res.json({ links });
      } catch (error) {
        if (error.status === 403) return res.status(403).json({ error: error.message });
        logger.error('Failed to list invite links', withRequest(req, { context: 'team', error }));
        return res.status(500).json({ error: 'Failed to list invite links' });
      }
    },

    async revokeInviteLink(req, res) {
      try {
        await revokeInviteLink(req.params.linkId, req.params.teamId, req.user.id);
        return res.json({ success: true });
      } catch (error) {
        if (error.status) return res.status(error.status).json({ error: error.message });
        logger.error('Failed to revoke invite link', withRequest(req, { context: 'team', error }));
        return res.status(500).json({ error: 'Failed to revoke invite link' });
      }
    },

    async joinViaInviteLink(req, res) {
      const { token } = req.params;
      try {
        const result = await joinViaInviteLink(token, req.user.id);
        logger.info('User joined team via invite link', { context: 'team', userId: req.user.id, teamId: result.team.id });
        return res.json({ team: result.team });
      } catch (error) {
        if (error.status) return res.status(error.status).json({ error: error.message });
        logger.error('Failed to join via invite link', withRequest(req, { context: 'team', error }));
        return res.status(500).json({ error: 'Failed to join team' });
      }
    },

    // --- Activity log ---

    async activity(req, res) {
      try {
        const activities = await getTeamActivity(req.params.teamId, req.user.id);
        return res.json({ activities });
      } catch (error) {
        if (error.status === 403) return res.status(403).json({ error: error.message });
        logger.error('Failed to get team activity', withRequest(req, { context: 'team', error }));
        return res.status(500).json({ error: 'Failed to get activity' });
      }
    },
  };
}
