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
})();
