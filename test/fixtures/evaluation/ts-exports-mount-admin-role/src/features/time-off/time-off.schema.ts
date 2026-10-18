import { z } from "zod";

export const timeOffRequest = z
  .object({
    kind: z.enum(["vacation", "sick", "parental", "unpaid"]),
    from: z.string().date(),
    to: z.string().date(),
    note: z.string().trim().max(500).default(""),
  })
  .refine((request) => request.from <= request.to, { message: "from must not be after to" });

export const timeOffDecision = z.object({ approve: z.boolean() });

export type TimeOffRequest = z.infer<typeof timeOffRequest>;
