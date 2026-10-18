import { z } from "zod";
import { config } from "../config.ts";

export const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(config.maxPageSize).default(25),
  cursor: z.string().uuid().optional(),
});

export type PageQuery = z.infer<typeof pageQuery>;

export function page<T extends { id: string }>(rows: T[], limit: number) {
  const items = rows.slice(0, limit);
  return { items, next: rows.length > limit ? (items.at(-1)?.id ?? null) : null };
}

/** Prisma arguments that fetch one extra row to learn whether a next page exists. */
export function window(query: PageQuery) {
  return {
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    orderBy: { id: "asc" as const },
  };
}
