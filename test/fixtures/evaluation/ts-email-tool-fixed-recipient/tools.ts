import { tool } from "ai";
import nodemailer from "nodemailer";
import { z } from "zod";

const mail = nodemailer.createTransport({ host: "mail.example", port: 587 });

export const notifyOps = tool({
  description: "Notify the operations team",
  inputSchema: z.object({ body: z.string() }),
  execute: async ({ body }) =>
    mail.sendMail({ from: "agent@example.com", to: "ops@example.com", text: body }),
});
