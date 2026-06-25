import {
  addProjectMember,
  createProjectForUser,
  deleteProjectForUser,
  getProjectMembers,
  listProjectsForUser,
  removeProjectMember,
  updateProjectForUser,
  updateProjectMember,
} from '../services/projectService.js';
import { sendControllerError } from './controllerUtils.js';
import { buildPaginationMeta, parsePaginationQuery, parseSearchQuery } from './pagination.js';

export function createProjectController() {
  return {
    async listProjects(req, res) {
      const pagination = parsePaginationQuery(req.query);
      const search = parseSearchQuery(req.query);
      const { projects, totalItems } = await listProjectsForUser(req.user.id, { ...pagination, search });
      res.json({
        projects,
        pagination: buildPaginationMeta({ ...pagination, totalItems }),
        filters: { search },
      });
    },

    async createProject(req, res) {
      try {
        const { name, teamId } = req.body;
        const project = await createProjectForUser(req.user.id, name, teamId || null);
        res.status(201).json({ project });
      } catch (error) {
        if (error.code === 'P2002') {
          error.status = 409;
          error.message = 'A project with this name already exists';
        }
        sendControllerError(req, res, error, 'Failed to create project');
      }
    },

    async updateProject(req, res) {
      try {
        const project = await updateProjectForUser(req.user.id, req.params.projectId, req.body.name);
        res.json({ project });
      } catch (error) {
        if (error.code === 'P2002') {
          error.status = 409;
          error.message = 'A project with this name already exists';
        }
        sendControllerError(req, res, error, 'Failed to update project');
      }
    },

    async deleteProject(req, res) {
      try {
        const result = await deleteProjectForUser(req.user.id, req.params.projectId);
        res.json(result);
      } catch (error) {
        sendControllerError(req, res, error, 'Failed to delete project');
      }
    },

    // --- Project member management ---

    async listMembers(req, res) {
      try {
        const members = await getProjectMembers(req.params.projectId, req.user.id);
        res.json({ members });
      } catch (error) {
        if (error.status) return res.status(error.status).json({ error: error.message });
        sendControllerError(req, res, error, 'Failed to list project members');
      }
    },

    async addMember(req, res) {
      const { email, role } = req.body;
      if (!email) return res.status(400).json({ error: 'Email is required' });

      try {
        const member = await addProjectMember(req.params.projectId, req.user.id, email, role);
        res.status(201).json({ member });
      } catch (error) {
        if (error.status) return res.status(error.status).json({ error: error.message });
        sendControllerError(req, res, error, 'Failed to add project member');
      }
    },

    async updateMember(req, res) {
      const { role } = req.body;
      if (!role) return res.status(400).json({ error: 'Role is required' });

      try {
        await updateProjectMember(req.params.projectId, req.user.id, req.params.memberUserId, role);
        res.json({ success: true });
      } catch (error) {
        if (error.status) return res.status(error.status).json({ error: error.message });
        sendControllerError(req, res, error, 'Failed to update project member');
      }
    },

    async removeMember(req, res) {
      try {
        await removeProjectMember(req.params.projectId, req.user.id, req.params.memberUserId);
        res.json({ success: true });
      } catch (error) {
        if (error.status) return res.status(error.status).json({ error: error.message });
        sendControllerError(req, res, error, 'Failed to remove project member');
      }
    },
  };
}
