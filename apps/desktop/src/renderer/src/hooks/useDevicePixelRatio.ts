import { useEffect, useState } from 'react';

// The device pixel ratio, kept current when the window moves to another monitor or the scaling changes.

/**
 * The window's device pixel ratio.
 *
 * @returns the ratio; 1 when the window reports none
 */
function currentRatio(): number {
  return window.devicePixelRatio || 1;
}

/**
 * The device pixel ratio as state: a resolution media query for the current ratio reports when it stops matching,
 * and the hook then reads the new ratio and watches that one.
 *
 * @returns the current device pixel ratio
 */
export function useDevicePixelRatio(): number {
  const [ratio, setRatio] = useState(currentRatio);
  useEffect(() => {
    // The ratio may have changed between the render and this effect.
    if (currentRatio() !== ratio) {
      setRatio(currentRatio());
      return;
    }
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(`(resolution: ${ratio}dppx)`);
    const changed = () => setRatio(currentRatio());
    query.addEventListener('change', changed);
    return () => query.removeEventListener('change', changed);
  }, [ratio]);
  return ratio;
}
