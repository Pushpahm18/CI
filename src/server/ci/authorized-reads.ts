/**
 * Runs the authorization check and the reads a request needs AT THE SAME TIME, so a
 * request costs one Databricks round trip instead of two in a row.
 *
 * Authorization still decides everything: its result is awaited first, and if it
 * refuses (or fails) that error is thrown and whatever the reads returned or failed
 * with is thrown away unseen. The reads only fetch; nothing is written before the
 * caller has been authorized.
 */
export async function authorizedReads<A, R>(authorize: () => Promise<A>, reads: () => Promise<R>): Promise<[A, R]> {
  const pending = reads();
  pending.catch(() => {}); // an abandoned read must never become an unhandled rejection
  const authorized = await authorize();
  return [authorized, await pending];
}
