import { z } from "zod";

export const commentCreate = z.object({
  body: z.string().trim().min(1).max(10_000),
});

export const commentEdit = commentCreate;

export type CommentCreate = z.infer<typeof commentCreate>;
