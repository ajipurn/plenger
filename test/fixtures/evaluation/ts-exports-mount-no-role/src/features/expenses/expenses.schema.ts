import { z } from "zod";

export const expenseCreate = z.object({
  projectId: z.string().uuid(),
  date: z.string().date(),
  amountMinor: z.number().int().positive().max(100_000_000),
  currency: z.string().regex(/^[A-Z]{3}$/),
  category: z.enum(["travel", "software", "hardware", "meals", "other"]),
  description: z.string().trim().min(1).max(500),
  billable: z.boolean().default(false),
});

export type ExpenseCreate = z.infer<typeof expenseCreate>;
