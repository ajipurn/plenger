import { tool } from "ai";
import nodemailer from "nodemailer";
import { z } from "zod";

const mail = nodemailer.createTransport({ host: "mail.example", port: 587 });

export const sendEmail = tool({
  description: "Send an email",
  inputSchema: z.object({ recipient: z.string(), body: z.string() }),
  execute: async ({ recipient, body }) =>
    mail.sendMail({ from: "agent@example.com", to: recipient, text: body }),
});
