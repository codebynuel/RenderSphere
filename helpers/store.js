function deprecatedStoreError() {
  throw new Error('helpers/store.js has been replaced by PostgreSQL + Prisma. Use src/db.js and src/services/* instead.');
}

async function connectStore() { deprecatedStoreError(); }
async function pingStore() { deprecatedStoreError(); }
function getStoreDbName() { return 'postgres'; }
async function readStore() { deprecatedStoreError(); }
async function updateStore() { deprecatedStoreError(); }

export {
  connectStore,
  getStoreDbName,
  pingStore,
  readStore,
  updateStore,
};
