import { z } from "zod";

export const filterSave = z.object({
  name: z.string().trim().min(1).max(80),
  view: z.enum(["time-entries", "tasks", "expenses"]),
  criteria: z
    .object({
      projectIds: z.array(z.string().uuid()).max(50),
      tagIds: z.array(z.string().uuid()).max(20),
      billable: z.boolean(),
      from: z.string().date(),
      to: z.string().date(),
    })
    .partial(),
  shared: z.boolean().default(false),
});

export type FilterSave = z.infer<typeof filterSave>;
