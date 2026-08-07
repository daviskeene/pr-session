/** Local filesystem helpers (author machine only — not Action-safe). */

export function homePath(...parts: string[]): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return [home, ...parts].join("/").replace(/\/+/g, "/");
}
