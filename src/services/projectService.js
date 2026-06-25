import { prisma } from '../db.js';

const MAX_PROJECT_NAME_LENGTH = 80;
const VALID_MEMBER_ROLES = new Set(['OWNER', 'COLLABORATOR', 'VIEWER']);

export function normalizeProjectName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').slice(0, MAX_PROJECT_NAME_LENGTH);
}

function normalizeMemberRole(value) {
  const role = String(value || '').toUpperCase().trim();
  return VALID_MEMBER_ROLES.has(role) ? role : null;
}

export function serializeProject(project) {
  if (!project) return null;
  return {
    id: project.id,
    userId: project.userId,
    name: project.name,
    teamId: project.teamId || null,
    visibility: project.visibility || 'PRIVATE',
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    jobCount: project._count?.jobs ?? project.jobCount ?? 0,
  };
}

export async function listProjectsForUser(userId, { skip = 0, take = 25, search = '' } = {}) {
  // Return projects where user is the owner OR a project member
  const userProjectIds = await prisma.projectMember.findMany({
    where: { userId },
    select: { projectId: true },
  });
  const memberProjectIds = userProjectIds.map((m) => m.projectId);

  const where = {
    OR: [
      { userId },
      { id: { in: memberProjectIds } },
    ],
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

  // Enrich with user's role if they're a member but not the owner
  const enriched = projects.map((p) => {
    const serialized = serializeProject(p);
    if (p.userId !== userId) {
      const membership = userProjectIds.find((m) => m.projectId === p.id);
      serialized.myRole = membership ? 'member' : null;
    } else {
      serialized.myRole = 'owner';
    }
    return serialized;
  });

  return { projects: enriched, totalItems };
}

export async function createProjectForUser(userId, name, teamId = null) {
  const normalizedName = normalizeProjectName(name);
  if (!normalizedName) {
    const error = new Error('Project name required');
    error.status = 400;
    throw error;
  }

  // If creating a team project, verify membership
  if (teamId) {
    const membership = await prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
    });
    if (!membership || (membership.role !== 'OWNER' && membership.role !== 'MEMBER')) {
      const error = new Error('You are not a member of this team');
      error.status = 403;
      throw error;
    }
  }

  const project = await prisma.project.create({
    data: {
      userId,
      name: normalizedName,
      teamId: teamId || null,
      visibility: teamId ? 'TEAM_PROJECT' : 'PRIVATE',
    },
    include: { _count: { select: { jobs: true } } },
  });

  // Auto-add project creator as OWNER member
  await prisma.projectMember.create({
    data: { projectId: project.id, userId, role: 'OWNER' },
  });

  // If it's a team project, auto-add all team members as VIEWERs
  if (teamId) {
    const teamMembers = await prisma.teamMember.findMany({
      where: { teamId, userId: { not: userId } },
    });
    if (teamMembers.length > 0) {
      await prisma.projectMember.createMany({
        data: teamMembers.map((tm) => ({
          projectId: project.id,
          userId: tm.userId,
          role: 'VIEWER',
        })),
        skipDuplicates: true,
      });
    }
  }

  return serializeProject(project);
}

export async function updateProjectForUser(userId, projectId, name) {
  const normalizedName = normalizeProjectName(name);
  if (!normalizedName) {
    const error = new Error('Project name required');
    error.status = 400;
    throw error;
  }

  // Check ownership or COLLABORATOR+ role
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) {
    const error = new Error('Project not found');
    error.status = 404;
    throw error;
  }
  if (project.userId !== userId) {
    const membership = await prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
    });
    if (!membership || membership.role === 'VIEWER') {
      const error = new Error('Access denied');
      error.status = 403;
      throw error;
    }
  }

  const updated = await prisma.project.update({
    where: { id: projectId },
    data: { name: normalizedName },
    include: { _count: { select: { jobs: true } } },
  });

  return serializeProject(updated);
}

export async function deleteProjectForUser(userId, projectId) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) {
    const error = new Error('Project not found');
    error.status = 404;
    throw error;
  }
  if (project.userId !== userId) {
    const error = new Error('Only the project owner can delete projects');
    error.status = 403;
    throw error;
  }

  await prisma.project.delete({ where: { id: projectId } });
  return { success: true };
}

// --- Project member management ---

export async function getProjectMembers(projectId, userId) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) {
    const error = new Error('Project not found');
    error.status = 404;
    throw error;
  }
  if (project.userId !== userId) {
    const membership = await prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
    });
    if (!membership) {
      const error = new Error('Access denied');
      error.status = 403;
      throw error;
    }
  }

  const members = await prisma.projectMember.findMany({
    where: { projectId },
    include: {
      user: { select: { id: true, email: true, name: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  return members.map((m) => ({
    userId: m.user.id,
    email: m.user.email,
    name: m.user.name || m.user.email,
    role: m.role,
    createdAt: m.createdAt,
  }));
}

export async function addProjectMember(projectId, ownerId, email, role) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) {
    const error = new Error('Project not found');
    error.status = 404;
    throw error;
  }
  if (project.userId !== ownerId) {
    const error = new Error('Only the project owner can manage members');
    error.status = 403;
    throw error;
  }

  const normalizedRole = normalizeMemberRole(role) || 'VIEWER';
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    const error = new Error('User not found');
    error.status = 404;
    throw error;
  }

  const existing = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId: user.id } },
  });
  if (existing) {
    const error = new Error('User is already a member of this project');
    error.status = 409;
    throw error;
  }

  const member = await prisma.projectMember.create({
    data: { projectId, userId: user.id, role: normalizedRole },
    include: { user: { select: { id: true, email: true, name: true } } },
  });

  return {
    userId: member.user.id,
    email: member.user.email,
    name: member.user.name || member.user.email,
    role: member.role,
    createdAt: member.createdAt,
  };
}

export async function updateProjectMember(projectId, ownerId, memberUserId, role) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) {
    const error = new Error('Project not found');
    error.status = 404;
    throw error;
  }
  if (project.userId !== ownerId) {
    const error = new Error('Only the project owner can manage members');
    error.status = 403;
    throw error;
  }
  if (memberUserId === ownerId) {
    const error = new Error('Cannot change the project owner role');
    error.status = 400;
    throw error;
  }

  const normalizedRole = normalizeMemberRole(role);
  if (!normalizedRole) {
    const error = new Error('Invalid role. Use: OWNER, COLLABORATOR, or VIEWER');
    error.status = 400;
    throw error;
  }

  return prisma.projectMember.updateMany({
    where: { projectId, userId: memberUserId },
    data: { role: normalizedRole },
  });
}

export async function removeProjectMember(projectId, ownerId, memberUserId) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) {
    const error = new Error('Project not found');
    error.status = 404;
    throw error;
  }
  if (project.userId !== ownerId) {
    const error = new Error('Only the project owner can manage members');
    error.status = 403;
    throw error;
  }
  if (memberUserId === ownerId) {
    const error = new Error('Cannot remove the project owner');
    error.status = 400;
    throw error;
  }

  return prisma.projectMember.deleteMany({
    where: { projectId, userId: memberUserId },
  });
}

export async function userCanSubmitToProject(projectId, userId) {
  if (!projectId) return true; // no project = no restriction

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) return false;
  if (project.userId === userId) return true; // owner always has access

  const membership = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
  });
  if (!membership) return false;
  return membership.role === 'OWNER' || membership.role === 'COLLABORATOR';
}
