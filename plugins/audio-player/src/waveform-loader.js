// Decoding belongs to playback, not the mounted canvas. Only the latest
// selection may publish a waveform; older fetches are cancelled when possible.
export function createWaveformLoader({ getContext, getCached, store, publish, fetchAudio = fetch }) {
  let revision = 0;
  let controller = null;
  let pending = null;

  async function load(file, key) {
    const request = ++revision;
    controller?.abort();
    controller = null;
    pending = null;
    publish(null, 1);
    if (!file) return;
    const cached = key && getCached(key);
    if (cached) {
      const data = new Float32Array(cached);
      publish(data, data.reduce((max, value) => Math.max(max, value), 0) || 1);
      return;
    }
    const context = getContext();
    if (!context) { pending = { file, key }; return; }
    const abort = new AbortController();
    controller = abort;
    try {
      let bytes;
      if (typeof file === 'string') {
        const response = await fetchAudio(file, { signal: abort.signal });
        if (!response.ok) throw new Error(`Audio request failed: ${response.status}`);
        bytes = await response.arrayBuffer();
      } else {
        bytes = await file.arrayBuffer();
      }
      if (request !== revision) return;
      const decoded = await context.decodeAudioData(bytes);
      if (request !== revision) return;
      const channel = decoded.getChannelData(0);
      const data = new Float32Array(500);
      for (let i = 0; i < data.length; i++) {
        const start = Math.floor(i * channel.length / data.length);
        const end = Math.floor((i + 1) * channel.length / data.length);
        let sum = 0;
        for (let j = start; j < end; j++) sum += Math.abs(channel[j]);
        data[i] = sum / Math.max(1, end - start);
      }
      if (key) store(key, data);
      publish(data, data.reduce((max, value) => Math.max(max, value), 0) || 1);
    } catch (error) {
      if (request === revision) publish(null, 1);
    } finally {
      if (controller === abort) controller = null;
    }
  }

  return {
    load,
    resume() {
      if (pending) return load(pending.file, pending.key);
    },
  };
}
