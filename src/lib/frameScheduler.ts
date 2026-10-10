type FrameClock = {
  request: (callback: FrameRequestCallback) => number;
  cancel: (id: number) => void;
};

/** Coalesce observer notifications into one paint, reading the latest state. */
export function frameScheduler(paint: () => void, clock: FrameClock = {
  request: (callback) => requestAnimationFrame(callback), cancel: (id) => cancelAnimationFrame(id),
}) {
  let pending: number | undefined;
  return {
    schedule() {
      if (pending !== undefined) return;
      pending = clock.request(() => { pending = undefined; paint(); });
    },
    cancel() {
      if (pending !== undefined) clock.cancel(pending);
      pending = undefined;
    },
  };
}
