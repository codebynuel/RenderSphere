import { prisma } from '../db.js';

const VALID_ROLES = new Set(['OWNER', 'MEMBER', 'READ_ONLY']);

export function normalizeRole(value) {
  const role = String(value || '').toUpperCase().trim();
  return VALID_ROLES.has(role) ? role : null;
}

export async function createTeam(ownerId, name) {
  return prisma.$transaction(async (tx) => {
    const team = await tx.team.create({
      data: { name, ownerId },
    });

    await tx.teamMember.create({
      data: { teamId: team.id, userId: ownerId, role: 'OWNER' },
    });

    return team;
  });
}

export async function inviteTeamMember(teamId, ownerId, email, role, budgetCapUsd) {
  const team = await prisma.team.findUnique({ where: { id: teamId } });
  if (!team) throw Object.assign(new Error('Team not found'), { status: 404 });
  if (team.ownerId !== ownerId) throw Object.assign(new Error('Only the team owner can invite members'), { status: 403 });

  const normalizedRole = normalizeRole(role) || 'MEMBER';
  const existingUser = await prisma.user.findUnique({ where: { email } });

  const member = await prisma.teamMember.create({
    data: {
      teamId,
      userId: existingUser?.id || ownerId,
      role: normalizedRole,
      budgetCapUsd: budgetCapUsd || null,
      invitedBy: ownerId,
      invitedEmail: email,
      acceptedAt: existingUser ? new Date() : null,
    },
  });

  return member;
}

export async function updateTeamMember(teamId, ownerId, memberUserId, updates) {
  const team = await prisma.team.findUnique({ where: { id: teamId } });
  if (!team) throw Object.assign(new Error('Team not found'), { status: 404 });
  if (team.ownerId !== ownerId) throw Object.assign(new Error('Only the team owner can update members'), { status: 403 });
  if (memberUserId === ownerId) throw Object.assign(new Error('Cannot change the owner role'), { status: 400 });

  const data = {};
  if (updates.role) {
    const role = normalizeRole(updates.role);
    if (!role) throw Object.assign(new Error('Invalid role'), { status: 400 });
    data.role = role;
  }
  if (updates.budgetCapUsd !== undefined) {
    data.budgetCapUsd = updates.budgetCapUsd || null;
  }

  return prisma.teamMember.updateMany({
    where: { teamId, userId: memberUserId },
    data,
  });
}

export async function removeTeamMember(teamId, ownerId, memberUserId) {
  const team = await prisma.team.findUnique({ where: { id: teamId } });
  if (!team) throw Object.assign(new Error('Team not found'), { status: 404 });
  if (team.ownerId !== ownerId) throw Object.assign(new Error('Only the team owner can remove members'), { status: 403 });
  if (memberUserId === ownerId) throw Object.assign(new Error('Cannot remove the team owner'), { status: 400 });

  return prisma.teamMember.deleteMany({
    where: { teamId, userId: memberUserId },
  });
}

export async function getTeamsForUser(userId) {
  const memberships = await prisma.teamMember.findMany({
    where: { userId },
    include: {
      team: {
        include: {
          owner: { select: { id: true, email: true, name: true } },
          _count: { select: { members: true } },
        },
      },
    },
  });

  return memberships.map((m) => ({
    ...m.team,
    role: m.role,
    memberCount: m.team._count.members,
  }));
}

export async function getTeamDetail(teamId, userId) {
  const membership = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId } },
  });
  if (!membership) throw Object.assign(new Error('Access denied'), { status: 403 });

  const team = await prisma.team.findUnique({
    where: { id: teamId },
    include: {
      owner: { select: { id: true, email: true, name: true } },
      members: {
        include: {
          user: { select: { id: true, email: true, name: true } },
        },
      },
      projects: { select: { id: true, name: true, createdAt: true } },
    },
  });

  return { ...team, myRole: membership.role };
}

export async function getTeamBalance(teamId, ownerId) {
  const team = await prisma.team.findUnique({ where: { id: teamId } });
  if (!team) throw Object.assign(new Error('Team not found'), { status: 404 });
  if (team.ownerId !== ownerId) throw Object.assign(new Error('Access denied'), { status: 403 });

  const user = await prisma.user.findUnique({
    where: { id: ownerId },
    select: { starterBalanceUsd: true },
  });

  return { balanceUsd: user?.starterBalanceUsd || 0 };
}
