import {
  ArrowDownToLine,
  ArrowRightToSquare,
  Check,
  ChevronRight,
  ClockArrowRotateLeft,
  Comments,
  Cpu,
  Cubes3,
  Database,
  FaceRobot,
  FileCode,
  FileText,
  Folder,
  FolderArrowUp,
  Layers,
  LayoutCellsLarge,
  ListCheck,
  Magnifier,
  Moon,
  Pencil,
  PlugConnection,
  PlugWire,
  Shield,
  SquareDashed,
  Sun,
  TrashBin,
  TriangleExclamation,
  Wrench,
  Xmark,
} from "@gravity-ui/icons";

export type IconName =
  | "overview"
  | "findings"
  | "inventory"
  | "redteam"
  | "history"
  | "folder"
  | "chevron"
  | "parent-folder"
  | "models"
  | "agents"
  | "tools"
  | "llm-calls"
  | "entry-points"
  | "mcp-servers"
  | "mcp-clients"
  | "data-stores"
  | "prompts"
  | "frameworks"
  | "source-files"
  | "checklist"
  | "sun"
  | "moon"
  | "scan"
  | "download"
  | "check"
  | "search"
  | "close"
  | "trash"
  | "edit";
const glyphs: Record<IconName, typeof Folder> = {
  overview: LayoutCellsLarge,
  findings: TriangleExclamation,
  inventory: Layers,
  redteam: Shield,
  history: ClockArrowRotateLeft,
  folder: Folder,
  chevron: ChevronRight,
  "parent-folder": FolderArrowUp,
  models: Cpu,
  agents: FaceRobot,
  tools: Wrench,
  "llm-calls": Comments,
  "entry-points": ArrowRightToSquare,
  "mcp-servers": PlugConnection,
  "mcp-clients": PlugWire,
  "data-stores": Database,
  prompts: FileText,
  frameworks: Cubes3,
  "source-files": FileCode,
  checklist: ListCheck,
  sun: Sun,
  moon: Moon,
  scan: SquareDashed,
  download: ArrowDownToLine,
  check: Check,
  search: Magnifier,
  close: Xmark,
  trash: TrashBin,
  edit: Pencil,
};
export function Icon({ name, className = "" }: { name: IconName; className?: string }) {
  const Glyph = glyphs[name];
  return (
    <Glyph
      className={`icon ${className}`}
      aria-hidden="true"
      focusable="false"
      width="16"
      height="16"
      fill="currentColor"
    />
  );
}
export function Mark() {
  return (
    <img className="brand-mark" src="/mark.svg" width="28" height="28" alt="" aria-hidden="true" />
  );
}
