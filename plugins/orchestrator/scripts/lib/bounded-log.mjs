import fs from "node:fs";
import { Writable } from "node:stream";

/** Drain a stream without unbounded disk or write-queue growth. */
export class BoundedLog extends Writable {
  constructor(file, { limitBytes = 8 * 1024 * 1024, tail = false } = {}) {
    super();
    this.fd = fs.openSync(file, "w", 0o600);
    this.limitBytes = limitBytes;
    this.tail = tail;
    this.observedBytes = 0;
    this.truncated = false;
    this.buffer = Buffer.alloc(0);
    this.retainedBytes = 0;
    this.marker = Buffer.from("\n[orchestrator: output truncated]\n");
  }

  _write(chunk, encoding, callback) {
    try {
      this.observedBytes += chunk.length;
      const capacity = this.limitBytes - this.marker.length;
      if (this.tail) {
        this.buffer = Buffer.concat([this.buffer, chunk.subarray(-capacity)]).subarray(-capacity);
        this.truncated ||= this.observedBytes > capacity;
        const retained = this.truncated ? Buffer.concat([this.marker, this.buffer]) : this.buffer;
        fs.writeSync(this.fd, retained, 0, retained.length, 0);
        fs.ftruncateSync(this.fd, retained.length);
        this.retainedBytes = retained.length;
      } else if (!this.truncated) {
        const room = capacity - this.retainedBytes;
        const kept = chunk.subarray(0, room);
        fs.writeSync(this.fd, kept);
        this.retainedBytes += kept.length;
        if (chunk.length > room) {
          fs.writeSync(this.fd, this.marker);
          this.retainedBytes += this.marker.length;
          this.truncated = true;
        }
      }
      callback();
    } catch (error) { callback(error); }
  }

  _final(callback) {
    fs.closeSync(this.fd);
    callback();
  }
}
