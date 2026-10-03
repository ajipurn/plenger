export type IconName =
  | "overview"
  | "findings"
  | "inventory"
  | "redteam"
  | "history"
  | "folder"
  | "chevron"
  | "arrow"
  | "scan"
  | "download"
  | "check"
  | "search"
  | "close";
const glyphs: Record<IconName, typeof Folder> = {
  overview: LayoutCellsLarge,
  findings: TriangleExclamation,
  inventory: Layers,
  redteam: ShieldCheck,
  history: ClockArrowRotateLeft,
  folder: Folder,
  chevron: ArrowChevronRight,
  arrow: ArrowLeft,
  scan: SquareDashed,
  download: ArrowDownToLine,
  check: Check,
  search: Magnifier,
  close: Xmark,
};
export function Icon({ name, className = "" }: { name: IconName; className?: string }) {
  const Glyph = glyphs[name];
  return (
    <Glyph
      className={`icon ${className}`}
      aria-hidden="true"
      focusable="false"
      width="18"
      height="18"
      fill="currentColor"
    />
  );
}
export function Mark() {
  return (
    <svg className="brand-mark" viewBox="0 0 40 40" fill="none" aria-hidden="true">
      <rect width="40" height="40" rx="12" fill="currentColor" />
      <path
        d="M11 27V13l18 14V13M11 20h18"
        stroke="white"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

import {
  ArrowChevronRight,
  ArrowDownToLine,
  ArrowLeft,
  Check,
  ClockArrowRotateLeft,
  Folder,
  Layers,
  LayoutCellsLarge,
  Magnifier,
  ShieldCheck,
  SquareDashed,
  TriangleExclamation,
  Xmark,
} from "@gravity-ui/icons";
