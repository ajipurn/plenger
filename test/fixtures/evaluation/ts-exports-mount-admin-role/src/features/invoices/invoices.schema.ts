import { z } from "zod";

export const invoiceDraft = z
  .object({
    clientId: z.string().uuid(),
    from: z.string().date(),
    to: z.string().date(),
    dueInDays: z.number().int().min(0).max(120).default(30),
  })
  .refine((draft) => draft.from <= draft.to, { message: "from must not be after to" });

export type InvoiceDraft = z.infer<typeof invoiceDraft>;
