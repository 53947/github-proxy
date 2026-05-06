// lib/log-buffer.js — capture log persisted in chrome.storage.local
// under the single key 'linksblue.captures'. Capped at 200 most-recent
// entries; oldest are dropped. Loaded after storage.js so the global
// self.linksblueStorage is available.

(function () {
  var KEY = 'linksblue.captures';
  var CAP = 200;

  async function getCaptures() {
    var v = await self.linksblueStorage.get(KEY);
    return Array.isArray(v) ? v : [];
  }

  async function appendCapture(payload) {
    var arr = await getCaptures();
    arr.push(payload);
    if (arr.length > CAP) arr = arr.slice(arr.length - CAP);
    await self.linksblueStorage.set(KEY, arr);
    return arr.length;
  }

  async function clearCaptures() {
    await self.linksblueStorage.set(KEY, []);
  }

  async function getStats() {
    var arr = await getCaptures();
    if (arr.length === 0) {
      return { total: 0, oldestAt: null, newestAt: null };
    }
    return {
      total: arr.length,
      oldestAt: arr[0].capturedAt || null,
      newestAt: arr[arr.length - 1].capturedAt || null,
    };
  }

  self.linksblueLogBuffer = {
    appendCapture: appendCapture,
    getCaptures: getCaptures,
    clearCaptures: clearCaptures,
    getStats: getStats,
  };
})();
