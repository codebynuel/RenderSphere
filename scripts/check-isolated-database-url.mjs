import { env } from 'node:process';

const isolatedSchemaPattern = /^(smoke|ci|test|disposable|local)[_-]/i;

function parsePostgresUrl(name, value) {
  if (!value) {
    throw new Error(`${name} is required and must point to an isolated PostgreSQL schema.`);
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new Error(`${name} must be a valid PostgreSQL URL: ${error.message}`);
  }

  if (!['postgresql:', 'postgres:'].includes(parsed.protocol)) {
    throw new Error(`${name} must use the postgresql:// or postgres:// protocol.`);
  }

  const schema = parsed.searchParams.get('schema');
  if (!schema || schema === 'public' || !isolatedSchemaPattern.test(schema)) {
    throw new Error(`${name} must include an isolated schema query parameter such as schema=ci_<unique-id> or schema=smoke_<unique-id>.`);
  }

  return { database: parsed.pathname.replace(/^\//, ''), schema };
}

const migrationTarget = parsePostgresUrl('DATABASE_URL', env.DATABASE_URL);
const smokeTarget = env.SMOKE_TEST_DATABASE_URL
  ? parsePostgresUrl('SMOKE_TEST_DATABASE_URL', env.SMOKE_TEST_DATABASE_URL)
  : null;

if (smokeTarget && smokeTarget.schema === migrationTarget.schema) {
  throw new Error('SMOKE_TEST_DATABASE_URL must use a different isolated schema than DATABASE_URL.');
}

console.log(`Isolated migration database target verified: database=${migrationTarget.database || '(default)'} schema=${migrationTarget.schema}`);
if (smokeTarget) {
  console.log(`Isolated smoke-test database target verified: database=${smokeTarget.database || '(default)'} schema=${smokeTarget.schema}`);
}
