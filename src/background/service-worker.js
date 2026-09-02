import { StorageBuffer } from '../lib/storage-buffer.js';

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type === 'VIDEO_PROGRESS') {
    handleProgress(sender.tab.id, message.payload);
  }
  return true;
});

async function handleProgress(tabId, data) {
  await StorageBuffer.setSession(	ab_, data);

  if (data.progressPercent >= 85) {
    StorageBuffer.queueLocal(completed_, data);
  }
}

chrome.alarms.create('processOfflineQueue', { periodInMinutes: 5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'processOfflineQueue') {
    StorageBuffer.flush();
  }
});
