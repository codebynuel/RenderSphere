/**
 * create-admin.mjs
 *
 * One-time CLI to bootstrap an admin user in the RenderSphere database.
 *
 * Usage:
 *   node scripts/create-admin.mjs --email admin@example.com --password "your-password"
 *
 * The password must be at least 10 characters.
 */

import 'dotenv/config';
import crypto from 'crypto';
import { prisma } from '../src/db.js';
import { logger } from '../helpers/logger.js';

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = { email: '', password: '' };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--email' && args[i + 1]) parsed.email = args[i + 1];
    if (args[i] === '--password' && args[i + 1]) parsed.password = args[i + 1];
  }

  return parsed;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password || ''), salt, 64, (error, derivedKey) => {
      if (error) reject(error);
      else resolve({ salt, hash: derivedKey.toString('hex') });
    });
  });
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function createRawSessionToken() {
  const token = `rs_session_${crypto.randomBytes(32).toString('base64url')}`;
  return {
    token,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  };
}

async function main() {
  const args = parseArgs();
  const email = normalizeEmail(args.email);
  const password = args.password;

  if (!email || !email.includes('@')) {
    console.error('A valid email is required. Use --email admin@example.com');
    process.exit(1);
  }

  if (password.length < 10) {
    console.error('Password must be at least 10 characters. Use --password "your-password"');
    process.exit(1);
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.error(`A user with email "${email}" already exists.`);
    process.exit(1);
  }

  const pwHash = await hashPassword(password);
  const session = createRawSessionToken();

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: pwHash.hash,
      passwordSalt: pwHash.salt,
      role: 'admin',
      starterBalanceUsd: 0,
      sessions: {
        create: {
          tokenHash: session.tokenHash,
          expiresAt: session.expiresAt,
        },
      },
    },
  });

  console.log('');
  console.log('  Admin account created successfully!');
  console.log('');
  console.log(`  Email:    ${user.email}`);
  console.log(`  Password: ${password}`);
  console.log(`  Role:     ${user.role}`);
  console.log(`  User ID:  ${user.id}`);
  console.log('');
  console.log(`  Session token (use as cookie or Bearer):`);
  console.log(`  ${session.token}`);
  console.log('');
  console.log('  You can now log in at /auth or use the session token above.');
  console.log('');

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error('Failed to create admin account:', error);
  logger.error('create-admin failed', { error });
  process.exit(1);
});
