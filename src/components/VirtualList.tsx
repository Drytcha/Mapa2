import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";

export interface VirtualWindow {
  startIndex: number;
  endIndex: number;
  paddingTop: number;
  paddingBottom: number;
}

/**
 * Wylicza okno widocznych wierszy (z buforem `overscan`) dla wirtualizowanej listy.
 */
export function computeVirtualWindow(
  itemCount: number,
  scrollTop: number,
  viewportHeight: number,
  itemStride: number,
  overscan = 8,
): VirtualWindow {
  if (itemCount <= 0 || itemStride <= 0) {
    return { startIndex: 0, endIndex: 0, paddingTop: 0, paddingBottom: 0 };
  }
  const safeScroll = Math.max(0, scrollTop);
  const safeViewport = Math.max(itemStride, viewportHeight);
  const rawStart = Math.floor(safeScroll / itemStride);
  const visibleCount = Math.ceil(safeViewport / itemStride);
  const startIndex = Math.max(0, rawStart - overscan);
  const endIndex = Math.min(itemCount, rawStart + visibleCount + overscan);
  const paddingTop = startIndex * itemStride;
  const paddingBottom = Math.max(0, (itemCount - endIndex) * itemStride);
  return { startIndex, endIndex, paddingTop, paddingBottom };
}

export interface VirtualListProps<T> {
  items: readonly T[];
  /** Szacowana wysokość pojedynczego wiersza w px (bez odstępu). */
  itemHeight: number;
  /** Odstęp pionowy między wierszami w px (domyślnie 0). */
  gap?: number;
  /** Liczba dodatkowych wierszy renderowanych nad i pod oknem widoku. */
  overscan?: number;
  /** Próg liczby elementów, poniżej którego wirtualizacja nie jest potrzebna. */
  virtualizeAbove?: number;
  /** Zewnętrzny kontener przewijania — gdy pominięty, lista używa własnego. */
  scrollParentRef?: RefObject<HTMLElement | null>;
  className?: string;
  listClassName?: string;
  getKey: (item: T, index: number) => string | number;
  renderItem: (item: T, index: number) => ReactNode;
}

/**
 * Lekka, bez-zależnościowa lista wirtualizowana do długich tabel kursów (2000+ wierszy)
 * oraz list brygad. Renderuje wyłącznie ~25–45 widocznych elementów, zachowując 60 FPS.
 */
export default function VirtualList<T>({
  items,
  itemHeight,
  gap = 0,
  overscan = 8,
  virtualizeAbove = 48,
  scrollParentRef,
  className,
  listClassName,
  getKey,
  renderItem,
}: VirtualListProps<T>) {
  const internalScrollRef = useRef<HTMLDivElement | null>(null);
  const listHostRef = useRef<HTMLDivElement | null>(null);
  const stride = Math.max(1, itemHeight + gap);
  const shouldVirtualize = items.length > virtualizeAbove;

  const [metrics, setMetrics] = useState<{ scrollTop: number; height: number }>(
    () => ({ scrollTop: 0, height: 640 }),
  );

  useEffect(() => {
    if (!shouldVirtualize || typeof window === "undefined") return;
    const scroller = scrollParentRef?.current ?? internalScrollRef.current;
    if (!scroller) return;

    let rafId = 0;
    const readMetrics = () => {
      rafId = 0;
      let relativeTop = scroller.scrollTop;
      if (scrollParentRef?.current && listHostRef.current) {
        const hostOffset =
          listHostRef.current.offsetTop - scroller.offsetTop;
        relativeTop = Math.max(0, scroller.scrollTop - Math.max(0, hostOffset));
      }
      const nextHeight = scroller.clientHeight || 640;
      setMetrics((prev) =>
        Math.abs(prev.scrollTop - relativeTop) < 4 &&
        Math.abs(prev.height - nextHeight) < 4
          ? prev
          : { scrollTop: relativeTop, height: nextHeight },
      );
    };

    const scheduleRead = () => {
      if (rafId) return;
      rafId = window.requestAnimationFrame(readMetrics);
    };

    readMetrics();
    scroller.addEventListener("scroll", scheduleRead, { passive: true });
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(scheduleRead);
      observer.observe(scroller);
    } else {
      window.addEventListener("resize", scheduleRead);
    }

    return () => {
      if (rafId) window.cancelAnimationFrame(rafId);
      scroller.removeEventListener("scroll", scheduleRead);
      if (observer) observer.disconnect();
      else window.removeEventListener("resize", scheduleRead);
    };
  }, [shouldVirtualize, scrollParentRef, items.length]);

  if (!shouldVirtualize) {
    const content = (
      <div className={listClassName} data-virtualized="false">
        {items.map((item, idx) => (
          <div key={getKey(item, idx)}>{renderItem(item, idx)}</div>
        ))}
      </div>
    );
    return scrollParentRef ? (
      content
    ) : (
      <div ref={internalScrollRef} className={className}>
        {content}
      </div>
    );
  }

  const win = computeVirtualWindow(
    items.length,
    metrics.scrollTop,
    metrics.height,
    stride,
    overscan,
  );
  const visible = items.slice(win.startIndex, win.endIndex);
  const style: CSSProperties = {
    paddingTop: win.paddingTop,
    paddingBottom: win.paddingBottom,
  };

  const inner = (
    <div
      ref={listHostRef}
      style={style}
      className={listClassName}
      data-virtualized="true"
      data-virtual-total={items.length}
      data-virtual-rendered={visible.length}
    >
      {visible.map((item, offset) => {
        const index = win.startIndex + offset;
        return (
          <div key={getKey(item, index)}>{renderItem(item, index)}</div>
        );
      })}
    </div>
  );

  if (scrollParentRef) {
    return inner;
  }

  return (
    <div ref={internalScrollRef} className={className}>
      {inner}
    </div>
  );
}
