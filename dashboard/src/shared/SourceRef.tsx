import type { Location } from "../../../src/inventory/model.ts";

export function SourceRef({
  location,
  includeColumn = false,
}: {
  location: Location;
  includeColumn?: boolean;
}) {
  const filenameStart = location.path.lastIndexOf("/") + 1;
  return (
    <code className="source-ref">
      {location.path.slice(0, filenameStart)}
      <span className="source-file-position">
        {location.path.slice(filenameStart)}:{location.line}
        {includeColumn && `:${location.column}`}
      </span>
    </code>
  );
}
