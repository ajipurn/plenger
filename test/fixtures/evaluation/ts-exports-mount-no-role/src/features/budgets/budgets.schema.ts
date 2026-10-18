import { z } from "zod";

export const budgetSet = z.object({
  projectId: z.string().uuid(),
  minutes: z.number().int().positive().max(10_000_000).optional(),
  amountMinor: z.number().int().positive().max(10_000_000_000).optional(),
  alertAt: z.number().min(0.1).max(1).default(0.8),
});

export type BudgetSet = z.infer<typeof budgetSet>;
