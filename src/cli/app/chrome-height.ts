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
