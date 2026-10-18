import { z } from "zod";

export const exportRange = z.object({
  from: z.string().date(),
  to: z.string().date(),
});

export type ExportRange = z.infer<typeof exportRange>;
