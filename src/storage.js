/**
 * Browser-local storage layer backed by OPFS (Origin Private File System) with
 * automatic fallback to IndexedDB when OPFS is unavailable.
 */

const DB_NAME = 'tinycore-webvm-db';
const DB_VERSION = 1;
const STORE_BLOBS = 'blobs';
const STORE_META = 'meta';
const OPFS_DIR_NAME = 'tinycore-webvm';

let cachedDbPromise = null;
let cachedOpfsDirPromise = null;

function openIdb() {
  if (cachedDbPromise) return cachedDbPromise;
  const { promise, resolve, reject } = Promise.withResolvers();
  cachedDbPromise = promise;

  const req = indexedDB.open(DB_NAME, DB_VERSION);
  req.onupgradeneeded = () => {
    const db = req.result;
    if (!db.objectStoreNames.contains(STORE_BLOBS)) {
      db.createObjectStore(STORE_BLOBS);
    }
    if (!db.objectStoreNames.contains(STORE_META)) {
      db.createObjectStore(STORE_META);
    }
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(new Error('Failed to open IndexedDB', { cause: req.error }));
  return promise;
}

async function idbGet(storeName, key) {
  const db = await openIdb();
  const { promise, resolve, reject } = Promise.withResolvers();
  const tx = db.transaction(storeName, 'readonly');
  const req = tx.objectStore(storeName).get(key);
  req.onsuccess = () => resolve(req.result ?? null);
  req.onerror = () => reject(new Error(`IndexedDB read failed for ${key}`, { cause: req.error }));
  return promise;
}

async function idbPut(storeName, key, value) {
  const db = await openIdb();
  const { promise, resolve, reject } = Promise.withResolvers();
  const tx = db.transaction(storeName, 'readwrite');
  const req = tx.objectStore(storeName).put(value, key);
  req.onsuccess = () => resolve();
  req.onerror = () => reject(new Error(`IndexedDB write failed for ${key}`, { cause: req.error }));
  return promise;
}

async function idbDelete(storeName, key) {
  const db = await openIdb();
  const { promise, resolve, reject } = Promise.withResolvers();
  const tx = db.transaction(storeName, 'readwrite');
  const req = tx.objectStore(storeName).delete(key);
  req.onsuccess = () => resolve();
  req.onerror = () => reject(new Error(`IndexedDB delete failed for ${key}`, { cause: req.error }));
  return promise;
}

async function getOpfsDir() {
  if (cachedOpfsDirPromise) return cachedOpfsDirPromise;
  cachedOpfsDirPromise = (async () => {
    if (!navigator.storage || typeof navigator.storage.getDirectory !== 'function') {
      return null;
    }
    try {
      const root = await navigator.storage.getDirectory();
      return await root.getDirectoryHandle(OPFS_DIR_NAME, { create: true });
    } catch {
      return null;
    }
  })();
  return cachedOpfsDirPromise;
}

async function yieldMainThread() {
  if (typeof scheduler !== 'undefined' && typeof scheduler.yield === 'function') {
    await scheduler.yield();
  } else {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

export async function getStorageCapabilities() {
  const opfsDir = await getOpfsDir();
  let persisted = false;
  let usage = 0;
  let quota = 0;

  if (navigator.storage) {
    if (typeof navigator.storage.persisted === 'function') {
      try {
        persisted = await navigator.storage.persisted();
      } catch {
        persisted = false;
      }
    }
    if (typeof navigator.storage.estimate === 'function') {
      try {
        const est = await navigator.storage.estimate();
        usage = est.usage ?? 0;
        quota = est.quota ?? 0;
      } catch {
        usage = 0;
        quota = 0;
      }
    }
  }

  return {
    backend: opfsDir ? 'OPFS' : 'IndexedDB',
    opfsSupported: Boolean(opfsDir),
    persisted,
    usage,
    quota,
  };
}

export async function requestPersistence() {
  if (navigator.storage && typeof navigator.storage.persist === 'function') {
    try {
      return await navigator.storage.persist();
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Write an ArrayBuffer (or Uint8Array) cleanly to OPFS in chunks (or IndexedDB fallback).
 */
export async function saveBinaryFile(name, data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const opfsDir = await getOpfsDir();

  if (opfsDir) {
    const handle = await opfsDir.getFileHandle(name, { create: true });
    if (typeof handle.createWritable === 'function') {
      const writable = await handle.createWritable();
      try {
        const chunkSize = 8 * 1024 * 1024;
        for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
          const end = Math.min(offset + chunkSize, bytes.byteLength);
          await writable.write(bytes.subarray(offset, end));
          if (end < bytes.byteLength) {
            await yieldMainThread();
          }
        }
        await writable.close();
        return 'OPFS';
      } catch (err) {
        await writable.abort().catch(() => {});
        throw new Error(`Failed saving ${name} to OPFS`, { cause: err });
      }
    }
  }

  // IndexedDB stores a cloned ArrayBuffer safely
  const bufferCopy = bytes.slice().buffer;
  await idbPut(STORE_BLOBS, name, bufferCopy);
  return 'IndexedDB';
}

export async function loadBinaryFile(name) {
  const opfsDir = await getOpfsDir();
  if (opfsDir) {
    try {
      const handle = await opfsDir.getFileHandle(name, { create: false });
      const file = await handle.getFile();
      return await file.arrayBuffer();
    } catch (err) {
      if (err && err.name !== 'NotFoundError') {
        throw new Error(`Failed reading ${name} from OPFS`, { cause: err });
      }
    }
  }

  const fromIdb = await idbGet(STORE_BLOBS, name);
  return fromIdb instanceof ArrayBuffer ? fromIdb : null;
}

export async function hasBinaryFile(name) {
  const opfsDir = await getOpfsDir();
  if (opfsDir) {
    try {
      const handle = await opfsDir.getFileHandle(name, { create: false });
      const file = await handle.getFile();
      return file.size;
    } catch {
      // fall through to IndexedDB check
    }
  }
  const fromIdb = await idbGet(STORE_BLOBS, name);
  return fromIdb instanceof ArrayBuffer ? fromIdb.byteLength : 0;
}

export async function deleteBinaryFile(name) {
  const opfsDir = await getOpfsDir();
  if (opfsDir) {
    await opfsDir.removeEntry(name).catch(() => {});
  }
  await idbDelete(STORE_BLOBS, name).catch(() => {});
}

export async function getMeta(key, defaultValue = null) {
  try {
    const val = await idbGet(STORE_META, key);
    return val === null ? defaultValue : val;
  } catch {
    return defaultValue;
  }
}

export async function setMeta(key, value) {
  await idbPut(STORE_META, key, value);
}

/**
 * Fetch a remote binary asset or read it from browser storage cache.
 */
export async function fetchAndCacheBinary(cacheKey, url, onProgress, signal) {
  const cached = await loadBinaryFile(cacheKey);
  if (cached) {
    onProgress?.({ loaded: cached.byteLength, total: cached.byteLength, fromCache: true });
    return cached;
  }

  const response = await fetch(url, {
    mode: 'cors',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    signal,
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while downloading ${url}`);
  }

  const total = Number(response.headers.get('content-length') || 0);
  if (!response.body) {
    const buf = await response.arrayBuffer();
    onProgress?.({ loaded: buf.byteLength, total: buf.byteLength, fromCache: false });
    await saveBinaryFile(cacheKey, buf);
    return buf;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress?.({ loaded, total: total || loaded, fromCache: false });
  }

  const merged = new Uint8Array(loaded);
  let pos = 0;
  for (const chunk of chunks) {
    merged.set(chunk, pos);
    pos += chunk.byteLength;
  }

  await saveBinaryFile(cacheKey, merged);
  return merged.buffer;
}
