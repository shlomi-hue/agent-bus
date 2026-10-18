export function scheduleAfterResponse(start: () => Promise<unknown>): void {
  const work = Promise.resolve()
    .then(start)
    .catch((error: unknown) => {
      console.error("background work failed", error instanceof Error ? error.name : "unknown");
    });
  void import("@vercel/functions")
    .then((mod) => {
      try {
        mod.waitUntil(work);
      } catch {
        /* Local runs have no request context. The promise is already running. */
      }
    })
    .catch(() => {
      /* The package is absent. The promise is already running. */
    });
}
