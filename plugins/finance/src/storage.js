import { saveAsset, loadAsset } from './host/persist.js';

const HISTORY_KEY = 'portfolio-tracker:chart-history';
const HIDDEN_KEY = 'portfolio-tracker:chart-hidden';
const CONNECTION_HISTORY_KEY = 'portfolio-tracker:connection-history-v1';
const CONNECTION_HISTORY_MANIFEST_KEY = 'portfolio-tracker:connection-history-v2';
const CONNECTION_HISTORY_CHUNK_PREFIX = 'portfolio-tracker:connection-history-chunk-v2:';

export const saveChartHistory = value => saveAsset(HISTORY_KEY, value);
export const saveChartHidden = value => saveAsset(HIDDEN_KEY, value);
export const saveConnectionHistoryManifest = value => saveAsset(CONNECTION_HISTORY_MANIFEST_KEY, value);
export const loadConnectionHistoryManifest = () => loadAsset(CONNECTION_HISTORY_MANIFEST_KEY, null);
export const saveConnectionHistoryChunk = (id, chunkIndex, value) =>
  saveAsset(`${CONNECTION_HISTORY_CHUNK_PREFIX}${encodeURIComponent(id)}:${chunkIndex}`, value);
export const loadConnectionHistoryChunk = (id, chunkIndex) =>
  loadAsset(`${CONNECTION_HISTORY_CHUNK_PREFIX}${encodeURIComponent(id)}:${chunkIndex}`, []);

async function loadMigrated(key, legacyKey) {
  const current = await loadAsset(key, null);
  if (current !== null) return current;
  const legacy = await loadAsset(legacyKey, []);
  if (legacy.length) await saveAsset(key, legacy);
  return legacy;
}

export const loadChartHistory = () => loadMigrated(HISTORY_KEY, 'chart-history');
export const loadChartHidden = () => loadMigrated(HIDDEN_KEY, 'chart-hidden');
export const loadConnectionHistory = () => loadAsset(CONNECTION_HISTORY_KEY, {
  version: 1,
  connections: {},
});
