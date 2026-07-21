// Run `fn` after the browser completes a full frame. A fitBounds issued in
// the same commit that resized the map's container computes against the
// backend's STALE size: both MapKit and MapLibre learn of a resize from
// their own ResizeObserver, and RO callbacks run late in the frame — after
// React's effects. rAF #1 runs before this frame's RO callbacks; #2 lands
// in the next frame, after the backend has adopted the new size. Returns a
// cancel function for effect cleanup.
export function afterNextFrame(fn: () => void): () => void {
  let raf2 = 0;
  const raf1 = requestAnimationFrame(() => {
    raf2 = requestAnimationFrame(fn);
  });
  return () => {
    cancelAnimationFrame(raf1);
    cancelAnimationFrame(raf2);
  };
}
