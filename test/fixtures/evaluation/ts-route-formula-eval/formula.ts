export function compute(formula: string): number {
  return Function(`"use strict"; return (${formula});`)() as number;
}
