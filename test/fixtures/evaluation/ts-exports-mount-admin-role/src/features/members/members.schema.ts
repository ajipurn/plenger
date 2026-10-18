import { z } from "zod";
import { ROLES } from "../../auth/roles.ts";

export const roleChange = z.object({ role: z.enum(ROLES).exclude(["owner"]) });

export type RoleChange = z.infer<typeof roleChange>;
