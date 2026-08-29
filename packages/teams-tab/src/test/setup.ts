import '@testing-library/jest-dom/vitest';

// jsdom does not implement ResizeObserver; recharts' <ResponsiveContainer>
// needs one to measure its parent element.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver = ResizeObserverStub;
}

// jsdom does not implement matchMedia; some Teams-js internals probe it.
if (typeof window.matchMedia === 'undefined') {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

if (typeof navigator.clipboard === 'undefined') {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: async () => {} },
    configurable: true,
  });
}
