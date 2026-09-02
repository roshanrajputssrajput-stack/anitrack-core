let pendingWrites = {};
let flushTimer = null;

export const StorageBuffer = {
  async setSession(key, value) {
    await chrome.storage.session.set({ [key]: value });
  },

  queueLocal(key, value) {
    pendingWrites[key] = value;
    if (!flushTimer) {
      flushTimer = setTimeout(this.flush, 10000);
    }
  },

  async flush() {
    if (Object.keys(pendingWrites).length === 0) return;
    const dataToSet = { ...pendingWrites };
    pendingWrites = {};
    flushTimer = null;
    await chrome.storage.local.set(dataToSet);
  }
};
