/** Search scheduling helpers shared by the repository pane. The native backend keeps at most one in-flight search per
 * session: a newer search (or `repository_cancel_search`) rejects the older one with `{ code: 'cancelled' }`. */

/** True for the rejection the backend sends to a search that was superseded or cancelled. It is not a failure. */
export function isCancelledSearch(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'cancelled';
}
