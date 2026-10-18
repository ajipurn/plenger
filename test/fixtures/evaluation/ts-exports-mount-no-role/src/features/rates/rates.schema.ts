import { z } from "zod";

export const rateSet = z.object({
  userId: z.string().uuid(),
  projectId: z.string().uuid().optional(),
  billableMinor: z.number().int().min(0).max(10_000_000),
  costMinor: z.number().int().min(0).max(10_000_000),
  effectiveFrom: z.string().date(),
});

export type RateSet = z.infer<typeof rateSet>;
