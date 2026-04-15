/**
 * IndexedDB-backed archive for generated documents and API usage history.
 * Used by the background service worker to avoid chrome.storage.local quotas.
 */

self.ArchiveDB = (function () {
  var DB_NAME = "jobAutofillArchive";
  var DB_VERSION = 1;
  var SUMMARY_KEY = "dashboard";

  var dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise(function (resolve, reject) {
      var request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = function (event) {
        var db = event.target.result;

        if (!db.objectStoreNames.contains("jobs")) {
          db.createObjectStore("jobs", { keyPath: "jobKey" });
        }

        if (!db.objectStoreNames.contains("documents")) {
          var docs = db.createObjectStore("documents", { keyPath: "id" });
          docs.createIndex("jobKey", "jobKey", { unique: false });
          docs.createIndex("docType", "docType", { unique: false });
          docs.createIndex("createdAt", "createdAt", { unique: false });
          docs.createIndex("jobKey_docType", ["jobKey", "docType"], { unique: false });
        }

        if (!db.objectStoreNames.contains("apiUsageEvents")) {
          var events = db.createObjectStore("apiUsageEvents", { keyPath: "id" });
          events.createIndex("timestamp", "timestamp", { unique: false });
          events.createIndex("operation", "operation", { unique: false });
          events.createIndex("jobKey", "jobKey", { unique: false });
        }

        if (!db.objectStoreNames.contains("apiUsageSummary")) {
          db.createObjectStore("apiUsageSummary", { keyPath: "key" });
        }

        if (!db.objectStoreNames.contains("meta")) {
          db.createObjectStore("meta", { keyPath: "key" });
        }
      };

      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error("Failed to open IndexedDB")); };
    });

    return dbPromise;
  }

  function waitRequest(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error("IndexedDB request failed")); };
    });
  }

  function withStores(storeNames, mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(storeNames, mode);
        var stores = {};
        for (var i = 0; i < storeNames.length; i++) {
          stores[storeNames[i]] = tx.objectStore(storeNames[i]);
        }

        var result;
        try {
          result = fn(stores, tx);
        } catch (err) {
          reject(err);
          return;
        }

        tx.oncomplete = function () { resolve(result); };
        tx.onerror = function () { reject(tx.error || new Error("IndexedDB transaction failed")); };
        tx.onabort = function () { reject(tx.error || new Error("IndexedDB transaction aborted")); };
      });
    });
  }

  function sortNewestFirst(a, b) {
    return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
  }

  function clone(obj) {
    return obj ? JSON.parse(JSON.stringify(obj)) : obj;
  }

  async function getMeta(key) {
    var record = await withStores(["meta"], "readonly", function (stores) {
      return waitRequest(stores.meta.get(key));
    });
    return record ? clone(record.value) : null;
  }

  async function setMeta(key, value) {
    return await withStores(["meta"], "readwrite", function (stores) {
      stores.meta.put({ key: key, value: clone(value) });
    });
  }

  async function getUsageSummary() {
    var summary = await withStores(["apiUsageSummary"], "readonly", function (stores) {
      return waitRequest(stores.apiUsageSummary.get(SUMMARY_KEY));
    });
    return summary ? clone(summary) : null;
  }

  async function setUsageSummary(summary) {
    return await withStores(["apiUsageSummary"], "readwrite", function (stores) {
      stores.apiUsageSummary.put(clone(summary));
    });
  }

  async function getAllUsageEvents() {
    var items = await withStores(["apiUsageEvents"], "readonly", function (stores) {
      return waitRequest(stores.apiUsageEvents.getAll());
    });
    items.sort(function (a, b) {
      return String(a.timestamp || "").localeCompare(String(b.timestamp || ""));
    });
    return items;
  }

  async function addUsageEvent(eventRecord) {
    return await withStores(["apiUsageEvents"], "readwrite", function (stores) {
      stores.apiUsageEvents.put(clone(eventRecord));
    });
  }

  async function upsertJob(jobKey, jobMeta, updatedAt) {
    return await withStores(["jobs"], "readwrite", function (stores) {
      var request = stores.jobs.get(jobKey);
      request.onsuccess = function () {
        var existing = request.result || { jobKey: jobKey };
        existing.jobMeta = jobMeta || existing.jobMeta || null;
        existing.updatedAt = updatedAt || new Date().toISOString();
        stores.jobs.put(existing);
      };
    });
  }

  async function saveJobDocument(jobKey, jobMeta, docType, doc) {
    var safeDoc = clone(doc);
    safeDoc.jobKey = jobKey;
    safeDoc.docType = docType;
    safeDoc.createdAt = safeDoc.createdAt || new Date().toISOString();

    return await withStores(["jobs", "documents"], "readwrite", function (stores) {
      stores.jobs.put({
        jobKey: jobKey,
        jobMeta: clone(jobMeta) || null,
        updatedAt: safeDoc.createdAt,
      });
      stores.documents.put(safeDoc);
    });
  }

  async function listDocumentsByJob(jobKey) {
    var docs = await withStores(["documents"], "readonly", function (stores) {
      return waitRequest(stores.documents.index("jobKey").getAll(jobKey));
    });
    docs.sort(sortNewestFirst);
    return docs;
  }

  async function getJob(jobKey) {
    return await withStores(["jobs"], "readonly", function (stores) {
      return waitRequest(stores.jobs.get(jobKey));
    });
  }

  async function getAllJobs() {
    var jobs = await withStores(["jobs"], "readonly", function (stores) {
      return waitRequest(stores.jobs.getAll());
    });
    jobs.sort(function (a, b) {
      return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
    });
    return jobs;
  }

  async function getDocument(id) {
    return await withStores(["documents"], "readonly", function (stores) {
      return waitRequest(stores.documents.get(id));
    });
  }

  async function deleteDocument(id) {
    return await withStores(["documents"], "readwrite", function (stores) {
      stores.documents.delete(id);
    });
  }

  async function listAllDocuments() {
    var docs = await withStores(["documents"], "readonly", function (stores) {
      return waitRequest(stores.documents.getAll());
    });
    docs.sort(sortNewestFirst);
    return docs;
  }

  async function clearStore(storeName) {
    return await withStores([storeName], "readwrite", function (stores) {
      stores[storeName].clear();
    });
  }

  return {
    SUMMARY_KEY: SUMMARY_KEY,
    openDb: openDb,
    getMeta: getMeta,
    setMeta: setMeta,
    getUsageSummary: getUsageSummary,
    setUsageSummary: setUsageSummary,
    getAllUsageEvents: getAllUsageEvents,
    addUsageEvent: addUsageEvent,
    upsertJob: upsertJob,
    saveJobDocument: saveJobDocument,
    listDocumentsByJob: listDocumentsByJob,
    getJob: getJob,
    getAllJobs: getAllJobs,
    getDocument: getDocument,
    deleteDocument: deleteDocument,
    listAllDocuments: listAllDocuments,
    clearStore: clearStore,
  };
})();
