function findVideoElement(root = document) {
  let video = root.querySelector('video');
  if (video) return video;

  for (const el of root.querySelectorAll('*')) {
    if (el.shadowRoot) {
      video = findVideoElement(el.shadowRoot);
      if (video) return video;
    }
  }
  return null;
}

function bindTracker() {
  const video = findVideoElement();
  if (video && !video.dataset.aniTrackActive) {
    video.dataset.aniTrackActive = 'true';
    
    video.addEventListener('timeupdate', () => {
      if (video.duration < 600) return;
      const progress = (video.currentTime / video.duration) * 100;
      
      chrome.runtime.sendMessage({
        type: 'VIDEO_PROGRESS',
        payload: {
          currentTime: video.currentTime,
          duration: video.duration,
          progressPercent: progress,
          title: document.title
        }
      });
    });
  }
}

const observer = new MutationObserver(bindTracker);
observer.observe(document.body, { childList: true, subtree: true });
bindTracker();
