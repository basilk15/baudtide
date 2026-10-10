import { useEffect, type RefObject } from 'react';

/** Ease coarse wheel steps on one visible page; leave continuous gestures native. */
export function useSmoothWheelScroll(pageRef: RefObject<HTMLElement | null>, enabled: boolean) {
  useEffect(() => {
    const scroller = pageRef.current?.closest<HTMLElement>('.signaldeck-main');
    if (!enabled || !scroller) return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frame: number | undefined;
    let destination = scroller.scrollTop;
    let lastTime = 0;
    let expectedPosition = scroller.scrollTop;
    let position = scroller.scrollTop;
    let velocity = 0;

    const stop = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
      velocity = 0;
    };
    const animate = (time: number) => {
      // A scrollbar, keyboard, or native gesture can take over at any moment.
      if (Math.abs(scroller.scrollTop - expectedPosition) > 2) { stop(); return; }
      const elapsed = Math.min(time - lastTime, 40) / 1000;
      lastTime = time;
      // Critically damped motion eases into a step and carries velocity across
      // a wheel burst without overshooting or resetting the animation.
      const displacement = position - destination;
      const decay = Math.exp(-26 * elapsed);
      const step = (velocity + 26 * displacement) * elapsed;
      position = destination + (displacement + step) * decay;
      velocity = (velocity - 26 * step) * decay;
      scroller.scrollTop = position;
      expectedPosition = scroller.scrollTop;
      if (Math.abs(destination - position) < .5 && Math.abs(velocity) < 8) {
        scroller.scrollTop = destination;
        stop();
      } else frame = requestAnimationFrame(animate);
    };
    const onWheel = (event: WheelEvent) => {
      const coarse = event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL
        || (Number.isInteger(event.deltaY) && Math.abs(event.deltaY) >= 80);
      if (event.defaultPrevented || !event.cancelable || reducedMotion.matches || !coarse
        || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.deltaX || !event.deltaY) {
        stop(); return;
      }
      // Let a dropdown, signal rail, or watch history consume its own scroll.
      for (let node = event.target instanceof Element ? event.target : null; node && node !== scroller; node = node.parentElement) {
        if (node.matches('input, textarea, select, [contenteditable="true"]')) { stop(); return; }
        if (!(node instanceof HTMLElement) || node.scrollHeight <= node.clientHeight) continue;
        if (!/^(auto|scroll)$/.test(getComputedStyle(node).overflowY)) continue;
        if ((event.deltaY < 0 && node.scrollTop > 0)
          || (event.deltaY > 0 && node.scrollTop < node.scrollHeight - node.clientHeight - 1)) { stop(); return; }
      }
      const delta = event.deltaY * (event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? scroller.clientHeight : 1);
      const current = scroller.scrollTop;
      const reversing = frame !== undefined && Math.sign(delta) !== Math.sign(destination - position);
      if (reversing) { destination = current; position = current; velocity = 0; }
      const next = Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight,
        (frame === undefined ? current : destination) + delta));
      if (next === current && frame === undefined) return;
      event.preventDefault();
      destination = next;
      if (frame === undefined) {
        expectedPosition = current;
        position = current;
        velocity = 0;
        lastTime = performance.now();
        frame = requestAnimationFrame(animate);
      }
    };
    scroller.addEventListener('wheel', onWheel, { passive: false });
    scroller.addEventListener('pointerdown', stop, { passive: true });
    scroller.addEventListener('touchstart', stop, { passive: true });
    scroller.addEventListener('keydown', stop);
    reducedMotion.addEventListener('change', stop);
    return () => {
      stop();
      scroller.removeEventListener('wheel', onWheel);
      scroller.removeEventListener('pointerdown', stop);
      scroller.removeEventListener('touchstart', stop);
      scroller.removeEventListener('keydown', stop);
      reducedMotion.removeEventListener('change', stop);
    };
  }, [enabled, pageRef]);
}
