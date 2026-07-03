import { prisma } from '../src/db.js';

const activeJobs = await prisma.job.findMany({
  where: { status: { in: ['SUBMITTED', 'DISPATCHING', 'IN_QUEUE', 'IN_PROGRESS', 'RUNNING'] } },
  select: { jobId: true, status: true, providerJobId: true, dispatchStatus: true, progress: true },
  orderBy: { createdAt: 'desc' },
});

console.log('Active jobs:', JSON.stringify(activeJobs, null, 2));
await prisma.$disconnect();
