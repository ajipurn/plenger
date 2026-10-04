/** Finding titles contain code identifiers delimited by backticks, not arbitrary Markdown. */
export function FindingTitle({ title }: { title: string }) {
  return [...title.matchAll(/`[^`]+`|[^`]+|`/g)].map(({ 0: part, index }) =>
    part.startsWith("`") && part.endsWith("`") ? (
      <code key={`${index}:${part}`}>{part.slice(1, -1)}</code>
    ) : (
      part
    ),
  );
}
