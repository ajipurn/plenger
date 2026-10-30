// CWE families: weaknesses close enough that two reports of one effect name the same issue.
// The duplicate check across origins and the evaluation's labeled-weakness count share them.

const WEAKNESS_FAMILIES: readonly (readonly number[])[] = [
  [77, 78, 88],
  // Path traversal with its named relative (23 to 35) and absolute (36 to 40) variants.
  [22, ...Array.from({ length: 18 }, (_, index) => 23 + index), 59, 73],
  [89, 564, 943],
  [94, 95, 96, 1336, 1426],
  [74, 1427],
  [269, 284, 285, 287, 306, 566, 639, 862, 863],
  [441, 918],
  [502],
  [200, 201, 256, 259, 312, 321, 359, 522, 532, 798],
  [494, 829, 1104, 1357],
  [311, 319],
  [400, 770, 834, 835],
];

/** The number of a `CWE-<n>` id; NaN for anything else. */
export function cweNumber(value: string): number {
  return Number(/^CWE-(\d+)$/.exec(value)?.[1] ?? Number.NaN);
}

/** Whether two CWE ids name the same weakness, directly or within its family. */
export function sameWeakness(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const [first, second] = [cweNumber(a), cweNumber(b)];
  if (Number.isNaN(first) || Number.isNaN(second)) return false;
  return (
    first === second ||
    WEAKNESS_FAMILIES.some((family) => family.includes(first) && family.includes(second))
  );
}
