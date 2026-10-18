import { z } from "zod";

export const weekParam = z.object({ week: z.string().date() });

export const review = z.object({
  decision: z.enum(["approved", "rejected"]),
  comment: z.string().trim().max(500).default(""),
});

export type Review = z.infer<typeof review>;
