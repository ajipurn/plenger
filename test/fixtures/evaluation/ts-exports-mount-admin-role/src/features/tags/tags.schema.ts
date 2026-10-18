import { z } from "zod";

export const tagCreate = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[\p{L}\p{N} _-]+$/u),
  color: z
    .string()
    .regex(/^#[0-9a-f]{6}$/)
    .default("#6366f1"),
});

export const taskTags = z.object({ tagIds: z.array(z.string().uuid()).max(20) });

export type TagCreate = z.infer<typeof tagCreate>;
