import { z } from "zod";

export const reportRange = z
  .object({
    from: z.string().date(),
    to: z.string().date(),
    clientId: z.string().uuid().optional(),
  })
  .refine((range) => range.from <= range.to, { message: "from must not be after to" });

export type ReportRange = z.infer<typeof reportRange>;
