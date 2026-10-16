import { type DOMElement, measureElement } from "ink";
import {
  createContext,
  type RefObject,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

/**
 * Rows the shell chrome below the transcript occupies (input row, status and any
 * overlay), measured from the laid-out tree.
 *
 * The full-screen viewport has to know how much height is left for the
 * transcript, but Ink lays the chrome out to its natural height only after
 * render. `AppView` measures its chrome box and publishes the result here;
 * `null` means "not measured yet", and the viewport falls back to a reserve.
 */
export const ChromeHeightContext = createContext<number | null>(null);

export function useChromeHeight(): number | null {
  return useContext(ChromeHeightContext);
}

/**
 * Measures a box after layout and re-renders only when its height changes.
 *
 * **The box handed to this hook must be `flexShrink={0}`.** `measureElement`
 * reports the height Yoga laid the node out to — not the height it needs — so a box
 * Yoga is allowed to compress reports the *compressed* number to whatever sizes
 * itself from this hook. With the full-screen frame pinned to the terminal's rows,
 * a shrinkable chrome was squeezed to zero while the band held the whole screen,
 * the band was then sized as `rows - 0`, and the input stayed clipped off the bottom
 * of the frame for the rest of the session (`AppView`'s chrome box, reported from
 * the machine as "nothing I type appears"). The band is the frame's one elastic box
 * precisely because nothing measures it; `frame-chrome-rows.test.tsx` weighs the
 * whole contract on a real Ink frame.
 *
 * The effect intentionally has no dependency array: any render can change the
 * chrome's height (an overlay opening, the input growing), and `measureElement`
 * is a cheap read of the already-computed layout. The equality guard keeps it
 * from re-rendering in a loop.
 */
export function useMeasuredChromeHeight(): {
  ref: RefObject<DOMElement | null>;
  rows: number | null;
} {
  const [rows, setRows] = useState<number | null>(null);
  const ref = useRef<DOMElement | null>(null);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const { height } = measureElement(node);
    setRows((prev) => (prev === height ? prev : height));
  });

  return { ref, rows };
}
