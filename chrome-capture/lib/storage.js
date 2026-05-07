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

  // v0.2.0 helpers — bearer token storage (Prompt 05/06/2026-31).
  // The token is stored ONLY in chrome.storage.local under the single
  // key "linksblue.token". Never logged, never sent in postMessage,
  // never written to the popup display in plain text. The options page
  // shows only the first 8 chars + "..." for verification.
  self.linksblueStorage.getToken = function () {
    return self.linksblueStorage.get('linksblue.token');
  };
  self.linksblueStorage.setToken = function (token) {
    return self.linksblueStorage.set('linksblue.token', token);
  };
  self.linksblueStorage.clearToken = function () {
    return self.linksblueStorage.remove('linksblue.token');
  };
})();
