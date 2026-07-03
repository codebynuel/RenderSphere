import { prisma } from '../src/db.js';

const recentJobs = await prisma.job.findMany({
  orderBy: { createdAt: 'desc' },
  take: 5,
  select: { jobId: true, status: true, providerJobId: true, dispatchStatus: true, progress: true, createdAt: true },
});

console.log('Recent jobs:', JSON.stringify(recentJobs, null, 2));
await prisma.$disconnect();
