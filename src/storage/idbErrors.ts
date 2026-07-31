/**
 * Classifying IndexedDB-layer failures, headless so both the storage
 * layer (db.ts's swap classifier) and the UI shell (idbHeal) share one
 * vocabulary.
 */

// Both spellings WebKit uses for a severed storage session. A quota
// error is a different problem with a different owner and must never
// match: healing on any failure would reload a full phone forever.
export const SEVERED_IDB =
  /database connection is closing|Indexed Database server lost/i;

/**
 * PouchDB wraps IDB errors as {name: "indexed_db_went_bad", message:
 * "unknown", reason: <the real text>} — the severed signature hides in
 * .reason, so read it too.
 */
export function describeRejection(reason: unknown): string {
  if (reason instanceof Error) {
    const nested = (reason as { reason?: unknown }).reason;
    const tail = typeof nested === "string" ? ` ${nested}` : "";
    return `${reason.name}: ${reason.message}${tail}`;
  }
  return String(reason);
}

/**
 * PouchDB's own guard for operations issued after destroy(): a plain
 * Error("database is destroyed"). Distinguishable by TYPE from a
 * Safari-severed session — a destroy is deliberate; severed is not.
 */
export function isDestroyedInstance(reason: unknown): boolean {
  return (
    reason instanceof Error && /database is destroyed/i.test(reason.message)
  );
}
