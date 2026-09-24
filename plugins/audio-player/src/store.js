/**
 * Audio Player's larger data, in IndexedDB: the library (albums with their
 * covers, folders), the waveform cache and files opened from disk for the
 * current playlist. All of Audio Player's frames share one origin, so the
 * engine writes here and the views read the same database.
 *
 * Before frames these lived in the Atmos page's database (`samsara_db`,
 * keys `audio-player:*`, earlier unprefixed). copyFromPage() brings them
 * over once.
 */
import atmos from 'atmos-sdk';

const DB_NAME = 'audio-player';
const STORE = 'assets';
const COPIED = 'copied-from-page';

let dbPromise = null;
function openDb() {
  dbPromise ||= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { dbPromise = null; reject(request.error); };
  });
  return dbPromise;
}

async function run(mode, action) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const request = action(transaction.objectStore(STORE));
    transaction.oncomplete = () => resolve(request?.result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function load(key, fallback = null) {
  try { return (await run('readonly', store => store.get(key))) ?? fallback; }
  catch { return fallback; }
}

export async function saveValue(key, value) {
  try { await run('readwrite', store => store.put(value, key)); return true; }
  catch (error) { console.error(`[audio-player] could not save ${key}:`, error); return false; }
}

export const loadLibraryMeta = () => load('library-meta', { albums: {}, folders: [] });
export const saveLibraryMeta = (albums, folders) => saveValue('library-meta', { albums, folders });
export const loadWaveformCache = () => load('waveform-cache', {});
export const saveWaveformCache = value => saveValue('waveform-cache', value);
export const loadTracks = () => load('playlist', []);
export const saveTracks = files => saveValue('playlist', files);

/**
 * Once: copy what the in-page Audio Player kept in the Atmos page's
 * database. Its newer `audio-player:<name>` keys win over the older bare ones.
 */
export async function copyFromPage() {
  if (await load(COPIED, false)) return false;
  let copied = 0;
  try {
    const legacy = await atmos.legacy.readIndexedDB('samsara_db');
    const records = new Map(legacy?.stores?.assets || []);
    for (const name of ['library-meta', 'waveform-cache', 'playlist']) {
      const value = records.get(`audio-player:${name}`) ?? records.get(name);
      if (value === undefined || value === null) continue;
      if (await load(name, null) !== null) continue;
      if (await saveValue(name, value)) copied++;
    }
  } catch (error) {
    console.warn('[audio-player] nothing copied from the page:', error.message);
  }
  await saveValue(COPIED, true);
  return copied > 0;
}
