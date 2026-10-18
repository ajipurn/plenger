import { z } from "zod";

export const taskCreate = z.object({
  projectId: z.string().uuid(),
  title: z.string().trim().min(1).max(200),
  estimateMinutes: z.number().int().positive().max(100_000).optional(),
  assigneeId: z.string().uuid().optional(),
});

export const taskUpdate = taskCreate.omit({ projectId: true }).partial().extend({
  done: z.boolean().optional(),
});

export type TaskCreate = z.infer<typeof taskCreate>;
export type TaskUpdate = z.infer<typeof taskUpdate>;
