import { InMemoryStorage } from './fakes.js';
import { describeStorageContract } from './storage-contract.js';

describeStorageContract('InMemoryStorage', {
  reachable: async () => ({ storage: new InMemoryStorage() }),
  unreachable: async () => {
    const storage = new InMemoryStorage();
    storage.reachable = false;
    return { storage };
  },
});
