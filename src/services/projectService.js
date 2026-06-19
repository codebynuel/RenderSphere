import { prisma } from '../db.js';

const MAX_PROJECT_NAME_LENGTH = 80;

export function normalizeProjectName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').slice(0, MAX_PROJECT_NAME_LENGTH);
}

export function serializeProject(project) {
  if (!project) return null;
  return {
    id: project.id,
    userId: project.userId,
    name: project.name,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    jobCount: project._count?.jobs ?? project.jobCount ?? 0,
  };
}

export async function listProjectsForUser(userId, { skip = 0, take = 25, search = '' } = {}) {
  const where = {
    userId,
    ...(search ? { name: { contains: search, mode: 'insensitive' } } : {}),
  };
  const [totalItems, projects] = await Promise.all([
    prisma.project.count({ where }),
    prisma.project.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
      skip,
      take,
      include: { _count: { select: { jobs: true } } },
    }),
  ]);

  return { projects: projects.map(serializeProject), totalItems };
}

export async function createProjectForUser(userId, name) {
  const normalizedName = normalizeProjectName(name);
  if (!normalizedName) {
    const error = new Error('Project name required');
    error.status = 400;
    throw error;
  }

  const project = await prisma.project.create({
    data: { userId, name: normalizedName },
    include: { _count: { select: { jobs: true } } },
  });

  return serializeProject(project);
}

export async function updateProjectForUser(userId, projectId, name) {
  const normalizedName = normalizeProjectName(name);
  if (!normalizedName) {
    const error = new Error('Project name required');
    error.status = 400;
    throw error;
  }

  const updated = await prisma.project.updateMany({
    where: { id: projectId, userId },
    data: { name: normalizedName },
  });

  if (updated.count === 0) {
    const error = new Error('Project not found');
    error.status = 404;
    throw error;
  }

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { _count: { select: { jobs: true } } },
  });

  return serializeProject(project);
}

export async function deleteProjectForUser(userId, projectId) {
  const deleted = await prisma.project.deleteMany({ where: { id: projectId, userId } });
  if (deleted.count === 0) {
    const error = new Error('Project not found');
    error.status = 404;
    throw error;
  }

  return { success: true };
}
