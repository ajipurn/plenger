import { z } from "zod";

export const workspaceUpdate = z
  .object({
    name: z.string().trim().min(1).max(120),
    currency: z.string().regex(/^[A-Z]{3}$/),
    weekStartsOn: z.number().int().min(0).max(6),
    timesheetApproval: z.boolean(),
  })
  .partial();

export type WorkspaceUpdate = z.infer<typeof workspaceUpdate>;
