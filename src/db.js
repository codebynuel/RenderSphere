import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis;
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is required');
}

function parseDatabaseUrl(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function databaseSchemaFromUrl(url) {
  return parseDatabaseUrl(url)?.searchParams.get('schema') || undefined;
}

function connectionStringForPg(url) {
  const parsedUrl = parseDatabaseUrl(url);
  const schema = parsedUrl?.searchParams.get('schema');
  if (!parsedUrl || !schema || parsedUrl.searchParams.has('options')) return url;

  parsedUrl.searchParams.delete('schema');
  parsedUrl.searchParams.set('options', `-c search_path=${schema}`);
  return parsedUrl.toString();
}

function createPrismaClient() {
  const adapter = new PrismaPg(
    { connectionString: connectionStringForPg(connectionString) },
    { schema: databaseSchemaFromUrl(connectionString) }
  );
  return new PrismaClient({
    adapter,
    log: process.env.PRISMA_LOG_QUERIES === 'true' ? ['query', 'error', 'warn'] : ['error', 'warn'],
  });
}

export const prisma = globalForPrisma.renderSpherePrisma || createPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.renderSpherePrisma = prisma;
}
