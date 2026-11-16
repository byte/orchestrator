import fs from "node:fs";
import path from "node:path";

/**
 * Remove a directory tree a worker may have made unreadable (`chmod 000`): when
 * a plain removal fails, give every directory back its owner's permissions
 * first, never following a symlink, and try once more.
 */
export function removeTree(directory) {
  try {
    fs.rmSync(directory, { recursive: true, force: true });
    return;
  } catch {
    // Fall through and restore permissions.
  }
  const restore = (target) => {
    let stat;
    try {
      stat = fs.lstatSync(target);
    } catch {
      return;
    }
    if (!stat.isDirectory()) {
      return;
    }
    try {
      fs.chmodSync(target, 0o700);
      for (const name of fs.readdirSync(target)) {
        restore(path.join(target, name));
      }
    } catch {
      // The final removal reports what is still in the way.
    }
  };
  restore(directory);
  fs.rmSync(directory, { recursive: true, force: true });
}

/** The file in a scratch directory naming the status file of the runner that owns it. */
export const SCRATCH_OWNER_FILE = ".orch-worker-owner";
