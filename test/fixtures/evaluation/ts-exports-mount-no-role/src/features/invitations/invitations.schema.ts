import { z } from "zod";

export const invitationCreate = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  role: z.enum(["member", "manager", "admin"]).default("member"),
});

export type InvitationCreate = z.infer<typeof invitationCreate>;
