// Queued jobs hold callbacks, not downloaded bytes. Aborted jobs that have
// not started are removed immediately; running jobs retain their slot until done.
export class WorkQueue {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.pending = [];
  }
  run(work, { signal } = {}) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason); return; }
      const job = { work, resolve, reject, signal };
      job.abort = () => {
        const index = this.pending.indexOf(job);
        if (index !== -1) {
          this.pending.splice(index, 1);
          reject(signal.reason);
        }
      };
      signal?.addEventListener('abort', job.abort, { once: true });
      this.pending.push(job);
      this.drain();
    });
  }
  drain() {
    while (this.active < this.limit && this.pending.length) {
      const job = this.pending.shift();
      job.signal?.removeEventListener('abort', job.abort);
      this.active++;
      Promise.resolve().then(() => {
        if (job.signal?.aborted) throw job.signal.reason;
        return job.work();
      }).then(job.resolve, job.reject).finally(() => {
        this.active--;
        this.drain();
      });
    }
  }
}
