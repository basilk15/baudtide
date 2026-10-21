import { invokeDesktop } from '../desktop';
import type { DesktopWatch, DesktopWatchSnapshot } from './desktopWatchRuntime';
import type { TelemetryDecoderProfile } from './telemetryDecoders';
import { diskWatchHistory, type StoredWatchEvent, type WatchHistoryStorage, type WatchHistorySummary } from './watchHistory';

export type WatchSnapshot = DesktopWatchSnapshot & { historyCount: number; unavailable?: boolean };
export const watchSnapshot = () => invokeDesktop<WatchSnapshot>('watch_snapshot');
export const putDesktopWatch = (watch: DesktopWatch) => invokeDesktop<string>('watch_put', { watch });
export const removeDesktopWatches = (ids: string[]) => invokeDesktop<void>('watch_remove', { ids });
export const setDesktopWatchDecoder = (identity: string, decoder?: TelemetryDecoderProfile) => invokeDesktop<void>('watch_decoder', { identity, decoder });

// Copy the old history in bounded, idempotent batches. The original IndexedDB
// remains untouched and a failed import can safely retry after another reload.
let migration: Promise<void> | undefined;
export function migrateWatchHistory() {
  if (!migration) migration = (async () => {
    const { through } = await diskWatchHistory.summary();
    let after = 0;
    while (after < through) {
      const page = await diskWatchHistory.page(after, through, 256);
      if (!page.length) break;
      await invokeDesktop('watch_history_import', { events: page.map((row) => row.event) });
      after = page[page.length - 1].sequence;
    }
  })().catch((error: unknown) => { migration = undefined; throw error; });
  return migration;
}

export const nativeWatchHistory: WatchHistoryStorage = {
  async append() { throw new Error('Desktop breaches are recorded by the watch monitor.'); },
  async summary() { await migrateWatchHistory(); return invokeDesktop<WatchHistorySummary>('watch_history_summary'); },
  async latest(limit) { await migrateWatchHistory(); return invokeDesktop<StoredWatchEvent[]>('watch_history_latest', { limit }); },
  async page(after, through, limit) { return invokeDesktop<StoredWatchEvent[]>('watch_history_page', { after, through, limit }); },
};
