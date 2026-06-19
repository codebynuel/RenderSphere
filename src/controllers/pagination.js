import { config } from '../../helpers/config.js';

const ACTIVE_STATUS_VALUES = ['SUBMITTED', 'DISPATCHING', 'IN_QUEUE', 'IN_PROGRESS', 'RUNNING'];
const TERMINAL_STATUS_VALUES = ['COMPLETED', 'FAILED', 'CANCELLED', 'DISPATCH_FAILED'];
const JOB_STATUS_VALUES = new Set([...ACTIVE_STATUS_VALUES, ...TERMINAL_STATUS_VALUES]);

function createBadRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function parsePositiveIntegerParam(value, name, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const rawValue = String(value).trim();
  if (!/^\d+$/.test(rawValue)) throw createBadRequest(`${name} must be a positive integer`);
  const parsed = Number(rawValue);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw createBadRequest(`${name} must be a positive integer`);
  return parsed;
}

export function parsePaginationQuery(query = {}, options = {}) {
  const maxPageSize = Number(options.maxPageSize || config.maxPageSize || 100);
  const defaultPageSize = Math.min(Number(options.defaultPageSize || config.defaultPageSize || 25), maxPageSize);
  const page = parsePositiveIntegerParam(query.page, 'page', 1);
  const requestedPageSize = parsePositiveIntegerParam(query.pageSize ?? query.limit, 'pageSize', defaultPageSize);

  if (requestedPageSize > maxPageSize) {
    throw createBadRequest(`pageSize must be less than or equal to ${maxPageSize}`);
  }

  return {
    page,
    pageSize: requestedPageSize,
    skip: (page - 1) * requestedPageSize,
    take: requestedPageSize,
  };
}

export function buildPaginationMeta({ page, pageSize, totalItems }) {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  return {
    page,
    pageSize,
    totalItems,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
  };
}

export function parseSearchQuery(query = {}, { maxLength = 120 } = {}) {
  const rawSearch = query.search ?? query.q ?? '';
  const search = String(rawSearch || '').trim().replace(/\s+/g, ' ');
  if (search.length > maxLength) throw createBadRequest(`search must be ${maxLength} characters or fewer`);
  return search;
}

export function parseJobStatusFilter(value) {
  const status = String(value || 'all').trim().toUpperCase();
  if (!status || status === 'ALL') return { status: 'all', where: {} };
  if (status === 'ACTIVE') return { status: 'active', where: { status: { in: ACTIVE_STATUS_VALUES } } };
  if (status === 'HISTORY' || status === 'TERMINAL') return { status: 'history', where: { status: { in: TERMINAL_STATUS_VALUES } } };
  if (!JOB_STATUS_VALUES.has(status)) throw createBadRequest('status is not supported');
  return { status, where: { status } };
}

export { ACTIVE_STATUS_VALUES, JOB_STATUS_VALUES, TERMINAL_STATUS_VALUES };
