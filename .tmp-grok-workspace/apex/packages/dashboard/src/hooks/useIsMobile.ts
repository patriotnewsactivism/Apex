import { useEffect, useState } from 'react';

/** The one place the phone breakpoint is defined. Matches the `max-width: 767px`
 * block in index.css — if these disagree, layout and styling disagree with them. */
export const MOBILE_BREAKPOINT_PX = 768;

const QUERY = `(max-width: ${MOBILE_BREAKPOINT_PX - 1}px)`;

/** True while the viewport is phone-sized.
 *
 * Was copy-pasted into App.tsx, MissionControl.tsx and QuickChat.tsx, each
 * listening to `resize`. That misses the case that matters most on a phone —
 * rotating the device fires `orientationchange`, and on iOS Safari the URL bar
 * collapsing fires `resize` constantly while scrolling, so the old version
 * re-rendered the whole tree on every scroll frame. A media query listener
 * fires only when the answer actually changes. */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia(QUERY).matches,
  );

  useEffect(() => {
    const mql = window.matchMedia(QUERY);
    const onChange = (event: MediaQueryListEvent) => setIsMobile(event.matches);
    // Re-sync on mount: the viewport can change between first render and effect.
    setIsMobile(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return isMobile;
}
