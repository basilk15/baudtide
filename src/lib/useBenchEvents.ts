import { useEffect, useMemo, useRef, useState } from 'react';
import { isDesktopRuntime, listenDesktop } from './desktop';
import { listBenchEvents, type BenchEventPage } from './benchEvents';
import type { CaptureEvent } from './captureEvents';

export function useBenchEvents(paths: readonly string[], enabled: boolean) {
  const key = JSON.stringify([...new Set(paths)].sort());
  const [pages, setPages] = useState<Record<string, BenchEventPage>>({});
  const [error, setError] = useState('');
  const [loadingOlder, setLoadingOlder] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    if (!enabled || !isDesktopRuntime()) return;
    const selected: string[] = JSON.parse(key);
    setPages((old) => Object.keys(old).some((path) => !selected.includes(path))
      ? Object.fromEntries(Object.entries(old).filter(([path]) => selected.includes(path))) : old);
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const requests = new Map<string, number>();
    const refresh = async (path: string) => {
      const request = (requests.get(path) ?? 0) + 1; requests.set(path, request);
      try {
        const page = await listBenchEvents(path);
        if (generation.current === current && requests.get(path) === request) { setPages((old) => ({ ...old, [path]: page })); setError(''); }
      } catch (e) { if (generation.current === current) setError(e instanceof Error ? e.message : 'Could not load capture events.'); }
    };
    for (const path of selected) void refresh(path);
    const changed = (event: CaptureEvent) => {
      const path = event.capturePath;
      if (!path || !selected.includes(path) || timers.has(path)) return;
      timers.set(path, setTimeout(() => { timers.delete(path); void refresh(path); }, 250));
    };
    const unlisten = [listenDesktop<CaptureEvent>('log-event', changed), listenDesktop<CaptureEvent>('bench-event', changed)];
    return () => { ++generation.current; timers.forEach(clearTimeout); unlisten.forEach((stop) => stop()); };
  }, [key, enabled]);
  const loadOlder = async (path: string) => {
    const before = pages[path]?.nextBefore;
    if (!before || loadingOlder) return;
    const current = generation.current;
    setLoadingOlder(true);
    try {
      const page = await listBenchEvents(path, before);
      if (generation.current === current) setPages((old) => {
        // A fresh match may have refreshed the first page while this read was pending.
        if (old[path]?.nextBefore !== before) return old;
        return { ...old, [path]: { events: [...old[path].events, ...page.events], nextBefore: page.nextBefore } };
      });
    } catch (e) { if (generation.current === current) setError(e instanceof Error ? e.message : 'Could not load older events.'); }
    finally { setLoadingOlder(false); }
  };
  const events = useMemo(() => (JSON.parse(key) as string[]).flatMap((path) => pages[path]?.events ?? []), [key, pages]);
  return { events, pages, error, loadOlder, loadingOlder };
}
