import { z } from "zod";
import { pageQuery } from "../../lib/pagination.ts";

export const auditQuery = pageQuery.extend({
  action: z
    .string()
    .regex(/^[a-z_]+\.[a-z_]+$/)
    .optional(),
});
