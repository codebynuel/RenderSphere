import express from 'express';
import { ACTIVE_JOB_STATUSES, config } from '../helpers/config.js';
import { prisma } from '../src/db.js';

function createAdminRouter({ buildOperationalSnapshot, requireAdmin }) {
  const router = express.Router();

  // Extension error reporting — no auth required for POST (reported by add-on)
  router.post('/extension-errors', async (req, res) => {
    try {
      const { message, level, jobId, details, addonVersion, blenderVersion, os, email } = req.body;
      await prisma.extensionError.create({
        data: {
          message: String(message || '').slice(0, 2000),
          level: level || 'error',
          jobId: String(jobId || '').slice(0, 80) || null,
          details: details || undefined,
          addonVersion: String(addonVersion || '').slice(0, 30) || null,
          blenderVersion: String(blenderVersion || '').slice(0, 30) || null,
          os: String(os || '').slice(0, 30) || null,
          email: String(email || '').slice(0, 255) || null,
        },
      });
      return res.json({ success: true });
    } catch (error) {
      return res.status(500).json({ error: 'Failed to store error report' });
    }
  });

  router.use(requireAdmin);

  router.get('/summary', async (req, res) => {
    const [usersCount, uploadsCount, jobsCount, activeJobs, failedJobs, completedJobs, revenue, projectsCount] = await Promise.all([
      prisma.user.count(),
      prisma.upload.count(),
      prisma.job.count(),
      prisma.job.count({ where: { status: { in: Array.from(ACTIVE_JOB_STATUSES) } } }),
      prisma.job.count({ where: { status: 'FAILED' } }),
      prisma.job.count({ where: { status: 'COMPLETED' } }),
      prisma.job.aggregate({ _sum: { priceUsd: true, billableSeconds: true } }),
      prisma.project.count(),
    ]);

    res.json({
      users: usersCount,
      uploads: uploadsCount,
      jobs: jobsCount,
      projects: projectsCount,
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
        runpodRequestTimeoutMs: config.runpodRequestTimeoutMs,
        runpodStatusMaxRetries: config.runpodStatusMaxRetries,
        runpodCancelMaxRetries: config.runpodCancelMaxRetries,
        runpodRetryBackoffMs: config.runpodRetryBackoffMs,
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
      role: user.role,
      starterBalanceUsd: user.starterBalanceUsd,
      accessKeyCount: user.accessKeys.length,
      projectCount: user.projects.length,
      createdAt: user.createdAt,
      jobs: user.jobs.length,
      activeJobs: user.jobs.filter((job) => ACTIVE_JOB_STATUSES.has(job.status)).length,
    }));

    res.json({ users: mappedUsers });
  });

  // Extension error list — admin only (viewed on dashboard)
  router.get('/extension-errors', async (req, res) => {
    const errors = await prisma.extensionError.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
    res.json({ errors });
  });

  router.get('/user/:id', async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      include: {
        _count: { select: { jobs: true, projects: true, accessKeys: true, uploads: true, sessions: true } },
        jobs: { orderBy: { createdAt: 'desc' }, take: 50, include: { project: { select: { name: true } } } },
        projects: { orderBy: { createdAt: 'desc' } },
        accessKeys: { orderBy: { createdAt: 'desc' } },
      },
    });

    if (!user) return res.status(404).json({ error: 'User not found' });

    const { passwordHash, passwordSalt, ...safeUser } = user;
    res.json({ user: safeUser });
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

  router.get('/job/:jobId', async (req, res) => {
    const job = await prisma.job.findUnique({
      where: { jobId: req.params.jobId },
      include: {
        user: { select: { id: true, email: true } },
        project: true,
        creditTransactions: { orderBy: { createdAt: 'desc' } },
      },
    });

    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json({ job });
  });

  router.get('/projects', async (req, res) => {
    const projects = await prisma.project.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { id: true, email: true } },
        _count: { select: { jobs: true } },
      },
    });

    res.json({ projects });
  });

  router.get('/uploads', async (req, res) => {
    const uploads = await prisma.upload.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        user: { select: { id: true, email: true } },
      },
    });

    const safeUploads = uploads.map((u) => ({
      ...u,
      fileSizeBytes: Number(u.fileSizeBytes || 0),
    }));
    res.json({ uploads: safeUploads });
  });

  router.get('/credits', async (req, res) => {
    const transactions = await prisma.creditTransaction.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        user: { select: { id: true, email: true } },
        job: { select: { jobId: true, status: true } },
      },
    });

    res.json({ transactions });
  });

  router.get('/metrics', async (req, res) => {
    const snapshot = await buildOperationalSnapshot();
    res.json({ ...snapshot, requestId: req.id || req.requestId || null });
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

  router.get('/settings', async (req, res) => {
    const rows = await prisma.systemSetting.findMany();
    const settings = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    res.json({
      settings,
      defaults: {
        payment_provider_paypal: 'enabled',
        payment_provider_nowpayments: 'enabled',
      },
    });
  });

  router.put('/settings', async (req, res) => {
    const allowed = new Set(['payment_provider_paypal', 'payment_provider_nowpayments']);
    const entries = Object.entries(req.body || {});
    const results = [];

    for (const [key, value] of entries) {
      if (!allowed.has(key)) continue;
      const stringValue = String(value).trim();
      if (stringValue !== 'enabled' && stringValue !== 'disabled') continue;

      const upserted = await prisma.systemSetting.upsert({
        where: { key },
        update: { value: stringValue },
        create: { key, value: stringValue },
      });
      results.push(upserted);
    }

    const rows = await prisma.systemSetting.findMany();
    const settings = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    res.json({ settings, updated: results.length });
  });

  return router;
}

export { createAdminRouter };
