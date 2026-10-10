import { useEffect, useRef } from 'react';

// Native scrolling stays untouched. Only the scrollbar paint changes while active.
export function useTransientScrollbar() {
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reveal = () => {
      element.dataset.scrolling = 'true';
      clearTimeout(timer);
      timer = setTimeout(() => {
        delete element.dataset.scrolling;
      }, 1200);
    };
    element.addEventListener('scroll', reveal, { passive: true });
    element.addEventListener('pointerenter', reveal, { passive: true });
    return () => {
      clearTimeout(timer);
      element.removeEventListener('scroll', reveal);
      element.removeEventListener('pointerenter', reveal);
      delete element.dataset.scrolling;
    };
  }, []);
  return ref;
}
