import fs from "node:fs";
import { Writable } from "node:stream";

/**
 * Drain a stream without unbounded disk or write-queue growth.
 *
 * `tail: true` keeps only the last `limitBytes`. Otherwise the head is kept,
 * and once that fills, the last `tailBytes` are held in memory and appended
 * after the truncation marker when the stream ends: failure diagnosis reads a
 * log's end, where the final error events are.
 */
export class BoundedLog extends Writable {
  constructor(file, { limitBytes = 8 * 1024 * 1024, tail = false, tailBytes = 64 * 1024 } = {}) {
    super();
    this.fd = fs.openSync(file, "w", 0o600);
    this.limitBytes = limitBytes;
    this.tail = tail;
    this.tailBytes = tailBytes;
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
          this.buffer = chunk.subarray(room).subarray(-this.tailBytes);
        }
      } else if (this.tailBytes > 0) {
        this.buffer = Buffer.concat([this.buffer, chunk.subarray(-this.tailBytes)]).subarray(-this.tailBytes);
      }
      callback();
    } catch (error) { callback(error); }
  }

  _final(callback) {
    try {
      if (!this.tail && this.truncated && this.tailBytes > 0 && this.buffer.length) {
        fs.writeSync(this.fd, this.buffer);
        this.retainedBytes += this.buffer.length;
      }
      fs.closeSync(this.fd);
      callback();
    } catch (error) { callback(error); }
  }
}
