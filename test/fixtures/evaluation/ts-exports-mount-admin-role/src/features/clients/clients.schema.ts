import { z } from "zod";

export const clientCreate = z.object({
  name: z.string().trim().min(1).max(120),
  contactEmail: z.string().trim().toLowerCase().email().max(254).optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
});

export const clientUpdate = clientCreate.partial().extend({ archived: z.boolean().optional() });

export type ClientCreate = z.infer<typeof clientCreate>;
export type ClientUpdate = z.infer<typeof clientUpdate>;
