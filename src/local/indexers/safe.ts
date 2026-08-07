/** Best-effort helpers shared by local transcript indexers. */

export async function settleFileScan(
  label: string,
  file: string,
  scan: () => Promise<void>,
): Promise<void> {
  try {
    await scan();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`pr-session: skip ${label} ${file}: ${msg}\n`);
  }
}

export function settleStat(
  label: string,
  target: string,
  fn: () => boolean,
): boolean {
  try {
    return fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`pr-session: skip ${label} ${target}: ${msg}\n`);
    return false;
  }
}
