// lib/storage.js — Promise wrappers around chrome.storage.local.
//
// Loaded via importScripts() in background.js (classic service worker)
// and via <script src="lib/storage.js"> in options.html. The wrapper
// exposes one global, self.linksblueStorage, with three methods. No
// business logic — purely an async/await ergonomics layer.

(function () {
  self.linksblueStorage = {
    get: function (key) {
      return new Promise(function (resolve) {
        chrome.storage.local.get(key, function (result) {
          resolve(result ? result[key] : undefined);
        });
      });
    },
    set: function (key, value) {
      var obj = {};
      obj[key] = value;
      return new Promise(function (resolve) {
        chrome.storage.local.set(obj, function () { resolve(); });
      });
    },
    remove: function (key) {
      return new Promise(function (resolve) {
        chrome.storage.local.remove(key, function () { resolve(); });
      });
    },
  };

  // v0.2.0 helpers — last-snapshot tracking for client-side dedupe
  // (Prompt 05/06/2026-31). One snapshot per source_id under the key
  // "linksblue.snapshot.<source_id>". Stored shape:
  //   { message_count, last_capture_at, last_message_uuid }
  // Only metadata — never the full conversation JSON.
  self.linksblueStorage.getLastSnapshot = function (sourceId) {
    return self.linksblueStorage.get('linksblue.snapshot.' + sourceId);
  };
  self.linksblueStorage.setLastSnapshot = function (sourceId, snapshot) {
    return self.linksblueStorage.set('linksblue.snapshot.' + sourceId, snapshot);
  };
})();
