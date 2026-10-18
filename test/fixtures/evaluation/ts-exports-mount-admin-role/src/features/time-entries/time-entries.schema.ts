import { z } from "zod";

export const entryCreate = z.object({
  projectId: z.string().uuid(),
  taskId: z.string().uuid().optional(),
  date: z.string().date(),
  minutes: z.number().int().min(1).max(24 * 60),
  note: z.string().trim().max(500).default(""),
  billable: z.boolean().default(true),
});

export const entryUpdate = entryCreate.omit({ projectId: true }).partial();

export const entryRange = z.object({
  from: z.string().date(),
  to: z.string().date(),
});

export type EntryCreate = z.infer<typeof entryCreate>;
export type EntryUpdate = z.infer<typeof entryUpdate>;
