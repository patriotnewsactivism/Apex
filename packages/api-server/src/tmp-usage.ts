import { lstatSync, readdirSync } from 'fs';

/**
 * Measure the actual contents of a directory, not the filesystem that contains
 * it. statfs('/tmp') reports whole-filesystem usage and produced a false
 * ~900GB /health.tmpUsedMb on Railway even though /tmp itself held a few MB.
 *
 * The walk is bounded so a health/diagnostics call cannot become the outage
 * it is trying to diagnose. Symlinks are not followed.
 */
export function directoryUsageBytes(
  root: string,
  maxEntries = 25_000,
  stopAfterBytes = 2 * 1024 * 1024 * 1024,
): { bytes: number; truncated: boolean } {
  const stack = [root];
  let bytes = 0;
  let entries = 0;

  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) break;

    let children;
    try {
      children = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const child of children) {
      entries += 1;
      if (entries > maxEntries || bytes >= stopAfterBytes) {
        return { bytes, truncated: true };
      }

      const fullPath = `${dir}/${child.name}`;
      try {
        if (child.isSymbolicLink()) continue;
        if (child.isDirectory()) {
          stack.push(fullPath);
          continue;
        }
        if (child.isFile()) bytes += lstatSync(fullPath).size;
      } catch {
        // Files can disappear while caches rotate; measurement is best effort.
      }
    }
  }

  return { bytes, truncated: false };
}
