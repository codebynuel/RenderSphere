import { createProjectForUser, deleteProjectForUser, listProjectsForUser, updateProjectForUser } from '../services/projectService.js';
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
        const project = await createProjectForUser(req.user.id, req.body.name);
        res.status(201).json({ project });
      } catch (error) {
        if (error.code === 'P2002') {
          error.status = 409;
          error.message = 'A project with this name already exists';
        }
        sendControllerError(res, error, 'Failed to create project');
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
        sendControllerError(res, error, 'Failed to update project');
      }
    },

    async deleteProject(req, res) {
      try {
        const result = await deleteProjectForUser(req.user.id, req.params.projectId);
        res.json(result);
      } catch (error) {
        sendControllerError(res, error, 'Failed to delete project');
      }
    },
  };
}
