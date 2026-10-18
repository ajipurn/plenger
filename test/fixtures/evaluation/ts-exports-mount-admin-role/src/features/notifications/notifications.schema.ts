import { z } from "zod";

export const markRead = z.object({ ids: z.array(z.string().uuid()).min(1).max(100) });

export const preferences = z.object({
  email: z.boolean(),
  digest: z.enum(["never", "daily", "weekly"]),
});

export type Preferences = z.infer<typeof preferences>;
