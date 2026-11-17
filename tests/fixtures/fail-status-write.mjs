// Preloaded into the worker wrapper (NODE_OPTIONS=--import) to make its second
// status write fail the way a full disk would: the write that records the
// Codex child it has just started.
import fs from "node:fs";

const original = fs.writeFileSync;
let writes = 0;
fs.writeFileSync = function (target, ...rest) {
  if (/status\.json\.\d+\.tmp$/.test(String(target))) {
    writes += 1;
    if (writes === 2) {
      const error = new Error("ENOSPC: no space left on device");
      error.code = "ENOSPC";
      throw error;
    }
  }
  return original.call(this, target, ...rest);
};
