/** Return whether an unknown value is a plain record.
 * Rejects arrays on purpose: tolerant JSON/TOML readers use this before keyed
 * access, and a JSON array would otherwise pass `typeof === "object"` and leak
 * numeric indices as keys.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
