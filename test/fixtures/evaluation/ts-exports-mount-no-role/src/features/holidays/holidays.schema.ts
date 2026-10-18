import { z } from "zod";

export const holidayCreate = z.object({
  date: z.string().date(),
  name: z.string().trim().min(1).max(80),
});

export const yearQuery = z.object({ year: z.coerce.number().int().min(2000).max(2100) });

export type HolidayCreate = z.infer<typeof holidayCreate>;
