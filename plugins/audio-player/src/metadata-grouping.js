/** Pure metadata normalisation and album-grouping helpers. */

const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF]/g;
const DISC_FOLDER = /^(?:(?:cd|disc|disk|lp|vinyl)[\s._-]*\d+(?:[\s._-]*(?:of|\/)[\s._-]*\d+)?|\d+\s*(?:'{2}|″|in(?:ch)?)\s*\d+|\(?(?:one|two|three|four|five|six)\)?)$/i;

export function cleanMetadataText(value, fallback = '') {
  if (value && typeof value === 'object') value = value.data ?? value.value ?? value.v ?? '';
  if (Array.isArray(value)) value = value.filter(Boolean).join('; ');
  const text = String(value ?? '')
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  return text || fallback;
}

export function normaliseMetadataText(value) {
  return cleanMetadataText(value).toLocaleLowerCase('und');
}

export function stripFeaturedArtists(value) {
  return cleanMetadataText(value)
    .replace(/\s*[;,]\s*.+$/, '')
    .replace(/\s+(?:feat|ft|featuring)\.?\s+.+$/i, '')
    .trim();
}

export function metadataNumber(value) {
  if (value && typeof value === 'object') {
    value = value.track ?? value.disk ?? value.disc ?? value.number ?? value.no
      ?? value.data ?? value.value ?? value.v ?? '';
  }
  const text = cleanMetadataText(value);
  const match = text.match(/\d+/);
  return match ? Number.parseInt(match[0], 10) || 0 : 0;
}

/** Normalise release metadata to YYYY or YYYY-MM so month-aware sorting can
 *  remain stable across common ID3/Vorbis date formats. */
export function metadataReleaseDate(value) {
  const text = cleanMetadataText(value);
  if (!text) return '';
  const numeric = text.match(/\b(\d{4})(?:[-/.](\d{1,2}))?/);
  if (numeric) {
    const year = Number.parseInt(numeric[1], 10);
    const month = Number.parseInt(numeric[2] || '', 10);
    if (month >= 1 && month <= 12) return `${year}-${String(month).padStart(2, '0')}`;
    if (/^\d{4}$/.test(text)) return String(year);
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return '';
  return `${parsed.getUTCFullYear()}-${String(parsed.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function metadataFlag(value) {
  if (value && typeof value === 'object') value = value.data ?? value.value ?? value.v;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return /^(?:1|true|yes|y)$/i.test(cleanMetadataText(value));
}

export function releaseScope(trackKey) {
  const parts = cleanMetadataText(trackKey).replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length > 1) parts.pop(); // filename
  if (parts.length && DISC_FOLDER.test(parts.at(-1))) parts.pop();
  return normaliseMetadataText(parts.join('/'));
}

export function albumKey(trackArtist, album, albumArtist, trackKey = '') {
  const artist = normaliseMetadataText(stripFeaturedArtists(albumArtist || trackArtist || 'Unknown Artist'));
  const title = normaliseMetadataText(album || 'Unknown Album');
  const scope = releaseScope(trackKey);
  return `${artist}|||${title}${scope ? `|||${scope}` : ''}`;
}

export function compareTracks(a, b) {
  return (a.disc || 0) - (b.disc || 0)
    || (a.num || 0) - (b.num || 0)
    || cleanMetadataText(a.title).localeCompare(cleanMetadataText(b.title), undefined, { numeric: true })
    || cleanMetadataText(a.key).localeCompare(cleanMetadataText(b.key), undefined, { numeric: true });
}

function albumTitlesLookRelated(a, b) {
  const words = value => normaliseMetadataText(value).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const left = words(a), right = words(b);
  if (left === right) return true;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  return shorter.length >= 10 && shorter.split(' ').length >= 2
    && (longer.startsWith(`${shorter} `) || longer.endsWith(` ${shorter}`));
}

function mergeAlbumKeys(albumMap, keys, { editionMerge = false } = {}) {
  if (keys.length < 2) return keys[0];
  keys.sort((a, b) => (albumMap[b].tracks?.length || 0) - (albumMap[a].tracks?.length || 0));
  const canonicalKey = keys[0];
  const canonical = albumMap[canonicalKey];
  const seenKeys = new Set((canonical.tracks || []).map(t => t.key));
  const seenTitles = new Set((canonical.tracks || []).map(t => normaliseMetadataText(t.title)).filter(Boolean));
  for (const key of keys.slice(1)) {
    const duplicate = albumMap[key];
    for (const track of duplicate.tracks || []) {
      const titleIdentity = normaliseMetadataText(track.title);
      // Within one physical release, identical titles can be legitimate
      // reprises or disc repeats. Across separate editions, however, a title
      // already present in the chosen edition represents the same recording.
      if (!seenKeys.has(track.key) && (!editionMerge || !titleIdentity || !seenTitles.has(titleIdentity))) {
        canonical.tracks.push(track);
        seenKeys.add(track.key);
        if (titleIdentity) seenTitles.add(titleIdentity);
      }
    }
    if (!canonical.cover && duplicate.cover) canonical.cover = duplicate.cover;
    if ((!canonical.releaseDate || duplicate.releaseDate?.length > canonical.releaseDate.length) && duplicate.releaseDate) {
      canonical.releaseDate = duplicate.releaseDate;
      canonical.year = duplicate.year;
    }
    if (cleanMetadataText(duplicate.album).length > cleanMetadataText(canonical.album).length) {
      canonical.album = duplicate.album;
    }
    delete albumMap[key];
  }
  return canonicalKey;
}

function finishAlbum(album) {
  const uniqueTracks = new Map();
  for (const track of album.tracks || []) {
    const identity = normaliseMetadataText(track.key);
    if (!uniqueTracks.has(identity)) uniqueTracks.set(identity, track);
  }
  album.tracks = [...uniqueTracks.values()];
  const bestDate = album.tracks.map(track => track.releaseDate).filter(Boolean).sort((a, b) => b.length - a.length)[0];
  if (bestDate) {
    album.releaseDate = bestDate;
    album.year = Number.parseInt(bestDate, 10);
  }

  const albumArtists = new Map();
  const trackArtists = new Set();
  let compilation = false;
  for (const track of album.tracks) {
    const albumArtist = cleanMetadataText(track.albumArtist);
    if (albumArtist) albumArtists.set(normaliseMetadataText(albumArtist), albumArtist);
    const artist = normaliseMetadataText(track.artist);
    if (artist) trackArtists.add(artist);
    compilation ||= Boolean(track.compilation);
  }
  if (albumArtists.size === 1) album.artist = [...albumArtists.values()][0];
  else if (compilation || trackArtists.size > 1) album.artist = 'Various Artists';
  album.tracks.sort(compareTracks);
}

/**
 * Merge only entries that describe the same album inside the same physical
 * release folder. This repairs inconsistent Album Artist tags without joining
 * unrelated releases that merely share a title.
 */
export function mergeSplitAlbums(albumMap) {
  Object.values(albumMap).forEach(finishAlbum);
  const groups = new Map();
  for (const [key, album] of Object.entries(albumMap)) {
    const scopes = new Set((album.tracks || []).map(t => releaseScope(t.key)).filter(Boolean));
    const scope = scopes.size === 1 ? [...scopes][0] : `mixed:${key}`;
    const groupKey = `${normaliseMetadataText(album.album || 'Unknown Album')}|||${scope}`;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(key);
  }

  for (const keys of groups.values()) {
    const canonicalKey = mergeAlbumKeys(albumMap, keys);
    if (canonicalKey) finishAlbum(albumMap[canonicalKey]);
  }

  // A few releases use a shortened album title on some files. Reconcile only
  // conservative prefix/suffix variants from the same folder and artist.
  const byScope = new Map();
  for (const [key, album] of Object.entries(albumMap)) {
    const scopes = new Set((album.tracks || []).map(t => releaseScope(t.key)).filter(Boolean));
    if (scopes.size !== 1) continue;
    const scope = [...scopes][0];
    if (!byScope.has(scope)) byScope.set(scope, []);
    byScope.get(scope).push(key);
  }
  for (const keys of byScope.values()) {
    const pending = new Set(keys);
    while (pending.size) {
      const seed = pending.values().next().value;
      pending.delete(seed);
      const related = [seed];
      for (const candidate of [...pending]) {
        const sameArtist = normaliseMetadataText(albumMap[seed].artist) === normaliseMetadataText(albumMap[candidate].artist);
        if (sameArtist && albumTitlesLookRelated(albumMap[seed].album, albumMap[candidate].album)) {
          related.push(candidate);
          pending.delete(candidate);
        }
      }
      const canonicalKey = mergeAlbumKeys(albumMap, related);
      if (canonicalKey) finishAlbum(albumMap[canonicalKey]);
    }
  }

  // Finally collapse separate physical editions into one library card when
  // their canonical artist and album title are identical. Keep the most
  // complete edition, then add only genuinely new track titles from the
  // others so CD/vinyl copies do not reintroduce duplicate rows.
  const editions = new Map();
  for (const [key, album] of Object.entries(albumMap)) {
    const identity = `${normaliseMetadataText(album.artist)}|||${normaliseMetadataText(album.album)}`;
    if (!editions.has(identity)) editions.set(identity, []);
    editions.get(identity).push(key);
  }
  for (const keys of editions.values()) {
    const canonicalKey = mergeAlbumKeys(albumMap, keys, { editionMerge: true });
    if (canonicalKey) finishAlbum(albumMap[canonicalKey]);
  }

  return albumMap;
}
