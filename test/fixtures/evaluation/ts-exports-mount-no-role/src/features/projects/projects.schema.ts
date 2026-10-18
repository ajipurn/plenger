import { z } from "zod";

export const projectCreate = z.object({
  clientId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  code: z
    .string()
    .regex(/^[A-Z0-9]{2,10}$/)
    .optional(),
  billable: z.boolean().default(true),
  budgetMinutes: z.number().int().positive().max(1_000_000).optional(),
});

export const projectUpdate = projectCreate.omit({ clientId: true }).partial().extend({
  archived: z.boolean().optional(),
});

export type ProjectCreate = z.infer<typeof projectCreate>;
export type ProjectUpdate = z.infer<typeof projectUpdate>;
