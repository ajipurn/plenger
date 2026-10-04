import type { PartialOptions } from "overlayscrollbars";

export const verticalScrollbars: PartialOptions = {
  overflow: { x: "hidden", y: "scroll" },
  scrollbars: { theme: "os-theme-plenger", autoHide: "never", clickScroll: false },
};

export const horizontalScrollbars: PartialOptions = {
  ...verticalScrollbars,
  overflow: { x: "scroll", y: "hidden" },
};
