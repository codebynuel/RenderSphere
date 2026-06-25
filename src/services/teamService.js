import crypto from 'node:crypto';
import { prisma } from '../db.js';

const VALID_ROLES = new Set(['OWNER', 'MEMBER', 'READ_ONLY']);

export function normalizeRole(value) {
  const role = String(value || '').toUpperCase().trim();
  return VALID_ROLES.has(role) ? role : null;
}

function generateInviteToken() {
  return crypto.randomBytes(24).toString('base64url');
}

async function logTeamActivity(teamId, actorId, actorEmail, action, targetId, targetEmail, metadata) {
  return prisma.teamActivity.create({
    data: { teamId, actorId, actorEmail, action, targetId, targetEmail, metadata: metadata || undefined },
  });
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

  const owner = await prisma.user.findUnique({ where: { id: ownerId }, select: { email: true, name: true } });
  await logTeamActivity(teamId, ownerId, owner?.email, 'member_invited', existingUser?.id, email, { role: normalizedRole, budgetCapUsd: budgetCapUsd || null });

  return member;
}

export async function updateTeamMember(teamId, ownerId, memberUserId, updates) {
  const team = await prisma.team.findUnique({ where: { id: teamId } });
  if (!team) throw Object.assign(new Error('Team not found'), { status: 404 });
  if (team.ownerId !== ownerId) throw Object.assign(new Error('Only the team owner can update members'), { status: 403 });
  if (memberUserId === ownerId) throw Object.assign(new Error('Cannot change the owner role'), { status: 400 });

  const data = {};
  const changes = {};
  if (updates.role) {
    const role = normalizeRole(updates.role);
    if (!role) throw Object.assign(new Error('Invalid role'), { status: 400 });
    data.role = role;
    changes.role = role;
  }
  if (updates.budgetCapUsd !== undefined) {
    data.budgetCapUsd = updates.budgetCapUsd || null;
    changes.budgetCapUsd = updates.budgetCapUsd;
  }

  const memberUser = await prisma.user.findUnique({ where: { id: memberUserId }, select: { email: true, name: true } });
  const owner = await prisma.user.findUnique({ where: { id: ownerId }, select: { email: true, name: true } });
  await logTeamActivity(teamId, ownerId, owner?.email, 'member_updated', memberUserId, memberUser?.email, changes);

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

  const memberUser = await prisma.user.findUnique({ where: { id: memberUserId }, select: { email: true, name: true } });
  const owner = await prisma.user.findUnique({ where: { id: ownerId }, select: { email: true, name: true } });
  await logTeamActivity(teamId, ownerId, owner?.email, 'member_removed', memberUserId, memberUser?.email);

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

export async function getTeamMemberSpend(teamId, userId) {
  const membership = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId } },
  });
  if (!membership) throw Object.assign(new Error('Access denied'), { status: 403 });

  const team = await prisma.team.findUnique({
    where: { id: teamId },
    include: {
      members: {
        include: {
          user: { select: { id: true, email: true, name: true } },
        },
      },
    },
  });

  if (!team) throw Object.assign(new Error('Team not found'), { status: 404 });
  const isOwner = team.ownerId === userId;

  const memberSpend = await Promise.all(
    team.members.map(async (member) => {
      const result = await prisma.job.aggregate({
        where: { userId: member.user.id, billedAt: { not: null } },
        _sum: { priceUsd: true },
        _count: true,
      });
      return {
        userId: member.user.id,
        name: member.user.name || member.user.email,
        email: member.user.email,
        role: member.role,
        budgetCapUsd: member.budgetCapUsd ? Number(member.budgetCapUsd) : null,
        spentUsd: Number(result._sum.priceUsd || 0),
        jobCount: result._count,
      };
    })
  );

  return {
    ownerId: team.ownerId,
    ownerName: team.owner?.name || team.owner?.email || 'Owner',
    isOwner,
    members: isOwner ? memberSpend : memberSpend.filter((m) => m.userId === userId),
  };
}

export async function createInviteLink(teamId, ownerId, options = {}) {
  const team = await prisma.team.findUnique({ where: { id: teamId } });
  if (!team) throw Object.assign(new Error('Team not found'), { status: 404 });
  if (team.ownerId !== ownerId) throw Object.assign(new Error('Only the team owner can create invite links'), { status: 403 });

  const role = normalizeRole(options.role) || 'MEMBER';
  const maxUses = options.maxUses ? Number(options.maxUses) : null;
  let expiresAt = null;
  if (options.expiresInHours) {
    expiresAt = new Date(Date.now() + Number(options.expiresInHours) * 3600000);
  }

  const link = await prisma.teamInviteLink.create({
    data: {
      teamId,
      token: generateInviteToken(),
      role,
      maxUses: maxUses && maxUses > 0 ? maxUses : null,
      expiresAt,
      createdBy: ownerId,
    },
  });

  const owner = await prisma.user.findUnique({ where: { id: ownerId }, select: { email: true, name: true } });
  await logTeamActivity(teamId, ownerId, owner?.email, 'invite_link_created', link.id, null, { role, maxUses, expiresInHours: options.expiresInHours });

  return link;
}

export async function listInviteLinks(teamId, userId) {
  const membership = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId } },
  });
  if (!membership || (membership.role !== 'OWNER' && membership.role !== 'MEMBER')) {
    throw Object.assign(new Error('Access denied'), { status: 403 });
  }

  const links = await prisma.teamInviteLink.findMany({
    where: { teamId },
    orderBy: { createdAt: 'desc' },
  });

  return links.map((link) => ({
    ...link,
    expired: link.expiresAt ? link.expiresAt < new Date() : false,
    exhausted: link.maxUses ? link.useCount >= link.maxUses : false,
  }));
}

export async function revokeInviteLink(linkId, teamId, ownerId) {
  const team = await prisma.team.findUnique({ where: { id: teamId } });
  if (!team) throw Object.assign(new Error('Team not found'), { status: 404 });
  if (team.ownerId !== ownerId) throw Object.assign(new Error('Only the team owner can revoke invite links'), { status: 403 });

  const link = await prisma.teamInviteLink.findUnique({ where: { id: linkId } });
  if (!link || link.teamId !== teamId) throw Object.assign(new Error('Invite link not found'), { status: 404 });

  return prisma.teamInviteLink.update({
    where: { id: linkId },
    data: { active: false },
  });
}

export async function joinViaInviteLink(token, userId) {
  const link = await prisma.teamInviteLink.findUnique({ where: { token } });
  if (!link) throw Object.assign(new Error('Invite link not found'), { status: 404 });
  if (!link.active) throw Object.assign(new Error('This invite link has been revoked'), { status: 410 });
  if (link.expiresAt && link.expiresAt < new Date()) throw Object.assign(new Error('This invite link has expired'), { status: 410 });
  if (link.maxUses && link.useCount >= link.maxUses) throw Object.assign(new Error('This invite link has reached its usage limit'), { status: 410 });

  const team = await prisma.team.findUnique({ where: { id: link.teamId } });
  if (!team) throw Object.assign(new Error('Team not found'), { status: 404 });

  const existingMember = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId: link.teamId, userId } },
  });
  if (existingMember) throw Object.assign(new Error('You are already a member of this team'), { status: 409 });

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, name: true } });

  const member = await prisma.$transaction(async (tx) => {
    const m = await tx.teamMember.create({
      data: {
        teamId: link.teamId,
        userId,
        role: link.role,
        invitedBy: link.createdBy,
        invitedEmail: user?.email || null,
        acceptedAt: new Date(),
      },
    });

    await tx.teamInviteLink.update({
      where: { id: link.id },
      data: { useCount: { increment: 1 } },
    });

    return m;
  });

  await logTeamActivity(link.teamId, userId, user?.email, 'member_joined', userId, user?.email, { role: link.role, viaInviteLink: true });

  return { team, member };
}

export async function getTeamActivity(teamId, userId, limit = 30) {
  const membership = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId } },
  });
  if (!membership) throw Object.assign(new Error('Access denied'), { status: 403 });

  const activities = await prisma.teamActivity.findMany({
    where: { teamId },
    orderBy: { createdAt: 'desc' },
    take: Math.min(limit, 100),
  });

  return activities;
}
