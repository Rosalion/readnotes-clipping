// 后台 Service Worker
// 作用：让工具栏上的扩展图标点击即可"开/关"侧边栏。
// Chrome 在 setPanelBehavior({ openPanelOnActionClick: true }) 后，
// 会把扩展图标变成侧边栏的开关（再次点击即收起）。

function enableActionToggle() {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch((err) => console.warn("[阅读剪藏] setPanelBehavior 失败:", err));
  }
}

chrome.runtime.onInstalled.addListener(enableActionToggle);
chrome.runtime.onStartup.addListener(enableActionToggle);
// Service Worker 每次被唤醒也确保一次（幂等）。
enableActionToggle();
