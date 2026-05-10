import { MongoClient } from 'mongodb';

const STORE_COLLECTIONS = ['users', 'sessions', 'uploads', 'jobs'];

let writeQueue = Promise.resolve();
let mongoClient;
let mongoDb;
let mongoDbName;

function createEmptyStore() {
  return {
    users: [],
    sessions: [],
    uploads: [],
    jobs: [],
  };
}

function collection(name) {
  if (!mongoDb) throw new Error('MongoDB is not connected');
  return mongoDb.collection(name);
}

async function connectStore({ uri, dbName }) {
  mongoClient = new MongoClient(uri);
  await mongoClient.connect();
  mongoDbName = dbName;
  mongoDb = mongoClient.db(dbName);

  await Promise.all([
    collection('users').createIndex({ id: 1 }, { unique: true }),
    collection('users').createIndex({ email: 1 }, { unique: true }),
    collection('users').createIndex({ apiKeyHash: 1 }, { sparse: true }),
    collection('sessions').createIndex({ id: 1 }, { unique: true }),
    collection('sessions').createIndex({ tokenHash: 1 }, { unique: true }),
    collection('sessions').createIndex({ expiresAt: 1 }),
    collection('uploads').createIndex({ key: 1 }, { unique: true }),
    collection('jobs').createIndex({ jobId: 1 }, { unique: true }),
  ]);
}

async function pingStore() {
  if (!mongoDb) throw new Error('MongoDB is not connected');
  await mongoDb.command({ ping: 1 });
}

function getStoreDbName() {
  return mongoDbName;
}

async function readStore() {
  const [users, sessions, uploads, jobs] = await Promise.all(
    STORE_COLLECTIONS.map((name) => collection(name).find({}, { projection: { _id: 0 } }).toArray())
  );

  return {
    users,
    sessions,
    uploads,
    jobs,
  };
}

async function writeStore(store) {
  const normalizedStore = { ...createEmptyStore(), ...store };

  await Promise.all(STORE_COLLECTIONS.map(async (name) => {
    const docs = normalizedStore[name] || [];
    const targetCollection = collection(name);
    await targetCollection.deleteMany({});
    if (docs.length > 0) {
      await targetCollection.insertMany(docs, { ordered: true });
    }
  }));
}

async function updateStore(mutator) {
  writeQueue = writeQueue.then(async () => {
    const store = await readStore();
    const result = await mutator(store);
    await writeStore(store);
    return result;
  });
  return writeQueue;
}

export {
  connectStore,
  getStoreDbName,
  pingStore,
  readStore,
  updateStore,
};
