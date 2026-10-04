const separators = /[\\/]/;

/** Split a POSIX or Windows path into its non-empty segments. */
export function pathSegments(path: string): string[] {
  return path.split(separators).filter(Boolean);
}

export function projectName(path: string): string {
  return pathSegments(path).at(-1) ?? "Project";
}
