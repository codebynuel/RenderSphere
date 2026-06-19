import express from 'express';
import { ACTIVE_JOB_STATUSES, config } from '../helpers/config.js';
import { prisma } from '../src/db.js';

function createAdminRouter({ requireAdmin }) {
  const router = express.Router();

  router.use(requireAdmin);

  router.get('/summary', async (req, res) => {
    const [usersCount, uploadsCount, jobsCount, activeJobs, failedJobs, completedJobs, revenue] = await Promise.all([
      prisma.user.count(),
      prisma.upload.count(),
      prisma.job.count(),
      prisma.job.count({ where: { status: { in: Array.from(ACTIVE_JOB_STATUSES) } } }),
      prisma.job.count({ where: { status: 'FAILED' } }),
      prisma.job.count({ where: { status: 'COMPLETED' } }),
      prisma.job.aggregate({ _sum: { priceUsd: true, billableSeconds: true } }),
    ]);

    res.json({
      users: usersCount,
      uploads: uploadsCount,
      jobs: jobsCount,
      activeJobs,
      failedJobs,
      completedJobs,
      revenueUsd: revenue._sum.priceUsd || 0,
      billableSeconds: revenue._sum.billableSeconds || 0,
      database: 'postgres',
      limits: {
        maxUploadBytes: config.maxUploadBytes,
        maxRenderSamples: config.maxRenderSamples,
        maxResolutionPct: config.maxResolutionPct,
        maxAnimationFrames: config.maxAnimationFrames,
        maxConcurrentJobsPerUser: config.maxConcurrentJobsPerUser,
        maxQueuedJobsPerUser: config.maxQueuedJobsPerUser,
        renderPricePerSecondUsd: config.renderPricePerSecondUsd,
        renderEstimateBaseSecondsPerFrame: config.renderEstimateBaseSecondsPerFrame,
        minRenderReservationUsd: config.minRenderReservationUsd,
        defaultRenderMaxBudgetUsd: config.defaultRenderMaxBudgetUsd,
        maxRenderBudgetUsd: config.maxRenderBudgetUsd,
        starterBalanceUsd: config.freeRenderCredits,
        minRenderStartBalanceUsd: config.minRenderStartBalanceUsd,
        jobRecordRetentionDays: config.jobRecordRetentionDays,
      },
    });
  });

  router.get('/users', async (req, res) => {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        jobs: { select: { status: true } },
        accessKeys: { select: { id: true } },
        projects: { select: { id: true } },
      },
    });

    const mappedUsers = users.map((user) => ({
      id: user.id,
      email: user.email,
      starterBalanceUsd: user.starterBalanceUsd,
      accessKeyCount: user.accessKeys.length,
      projectCount: user.projects.length,
      createdAt: user.createdAt,
      jobs: user.jobs.length,
      activeJobs: user.jobs.filter((job) => ACTIVE_JOB_STATUSES.has(job.status)).length,
    }));

    res.json({ users: mappedUsers });
  });

  router.get('/jobs', async (req, res) => {
    const jobs = await prisma.job.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        project: true,
        user: { select: { id: true, email: true } },
      },
    });

    res.json({ jobs });
  });

  router.post('/cleanup-records', async (req, res) => {
    const cutoff = new Date(Date.now() - config.jobRecordRetentionDays * 24 * 60 * 60 * 1000);

    const [deletedSessions, deletedUploads, deletedJobs] = await Promise.all([
      prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } }),
      prisma.upload.deleteMany({ where: { createdAt: { lt: cutoff }, used: true } }),
      prisma.job.deleteMany({
        where: {
          createdAt: { lt: cutoff },
          status: { notIn: Array.from(ACTIVE_JOB_STATUSES) },
        },
      }),
    ]);

    res.json({
      removed: {
        sessions: deletedSessions.count,
        uploads: deletedUploads.count,
        jobs: deletedJobs.count,
      },
    });
  });

  return router;
}

export { createAdminRouter };
