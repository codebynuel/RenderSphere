import { getEnvironmentReadiness, validateRequiredEnv } from '../helpers/config.js';

try {
  validateRequiredEnv({ production: process.env.NODE_ENV === 'production' });
  const readiness = getEnvironmentReadiness({ production: process.env.NODE_ENV === 'production' });
  console.log(JSON.stringify({
    status: 'ok',
    production: readiness.production,
    requiredPresent: readiness.requiredPresent,
    r2Configured: readiness.r2Configured,
    runpodConfigured: readiness.runpodConfigured,
    publicUrlConfigured: readiness.publicUrlConfigured,
    rateLimitStore: readiness.rateLimitStore,
    redisRateLimitConfigured: readiness.redisRateLimitConfigured,
  }, null, 2));
} catch (error) {
  const readiness = getEnvironmentReadiness({ production: process.env.NODE_ENV === 'production' });
  console.error(JSON.stringify({
    status: 'error',
    production: readiness.production,
    missingRequired: readiness.missingRequired,
    invalid: readiness.invalid,
  }, null, 2));
  console.error(error.message);
  process.exit(1);
}
