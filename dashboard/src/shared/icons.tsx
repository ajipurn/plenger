import {
  ArrowDownToLine,
  ArrowRight,
  ArrowRightArrowLeft,
  ArrowRightToSquare,
  Check,
  ChevronRight,
  ChevronsExpandVertical,
  CircleExclamation,
  CircleInfo,
  CircleXmark,
  Clock,
  ClockArrowRotateLeft,
  Comments,
  Cpu,
  Cubes3,
  Database,
  FaceRobot,
  FileCode,
  FileText,
  Fingerprint,
  Flag,
  Folder,
  FolderArrowUp,
  Gear,
  Layers,
  LayoutCellsLarge,
  ListCheck,
  Magnifier,
  Moon,
  Pause,
  Pencil,
  Play,
  PlugConnection,
  PlugWire,
  Plus,
  Shield,
  Stop,
  Sun,
  TrashBin,
  Wrench,
  Xmark,
} from "@gravity-ui/icons";

export type IconName =
  | "overview"
  | "findings"
  | "inventory"
  | "redteam"
  | "history"
  | "settings"
  | "providers"
  | "folder"
  | "chevron"
  | "selector"
  | "clock"
  | "info"
  | "alert"
  | "error"
  | "arrow-right"
  | "gate"
  | "compare"
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
  | "edit"
  | "plus"
  | "pause"
  | "play"
  | "stop";
const glyphs: Record<IconName, typeof Folder> = {
  overview: LayoutCellsLarge,
  findings: Fingerprint,
  inventory: Layers,
  redteam: Shield,
  history: ClockArrowRotateLeft,
  settings: Gear,
  providers: PlugConnection,
  folder: Folder,
  chevron: ChevronRight,
  selector: ChevronsExpandVertical,
  clock: Clock,
  info: CircleInfo,
  alert: CircleExclamation,
  error: CircleXmark,
  "arrow-right": ArrowRight,
  gate: Flag,
  compare: ArrowRightArrowLeft,
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
  scan: Magnifier,
  download: ArrowDownToLine,
  check: Check,
  search: Magnifier,
  close: Xmark,
  trash: TrashBin,
  edit: Pencil,
  plus: Plus,
  pause: Pause,
  play: Play,
  stop: Stop,
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
    <img className="brand-mark" src="/logo.svg" width="24" height="24" alt="" aria-hidden="true" />
  );
}
