/**
 * Service worker - badge updates and optional data persistence
 */

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type === 'xfe_update_badge' && sender.tab?.id) {
    const count = message.count || 0;
    const text = count > 0 ? String(count) : '';
    chrome.action.setBadgeText({ text, tabId: sender.tab.id });
    chrome.action.setBadgeBackgroundColor({
      color: '#1d9bf0',
      tabId: sender.tab.id,
    });
  }
});

// Clear badge when tab navigates away
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) {
    const isFollowerPage =
      /\/(followers|following|verified_followers)\/?$/.test(changeInfo.url);
    if (!isFollowerPage) {
      chrome.action.setBadgeText({ text: '', tabId });
    }
  }
});
