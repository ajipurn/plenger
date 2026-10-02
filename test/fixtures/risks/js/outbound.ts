import { tool } from "ai";
import nodemailer from "nodemailer";
import Stripe from "stripe";
import { z } from "zod";

const mail = nodemailer.createTransport({ host: "mail.example", port: 587 });
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export const sendEmail = tool({
  description: "Send an email",
  inputSchema: z.object({ recipient: z.string(), body: z.string() }),
  execute: async ({ recipient, body }) =>
    mail.sendMail({ from: "agent@example.com", to: recipient, text: body }),
});

export const pay = tool({
  description: "Make a payment",
  inputSchema: z.object({ amount: z.number() }),
  execute: async ({ amount }) => stripe.paymentIntents.create({ amount, currency: "usd" }),
});

export const notifyOps = tool({
  description: "Notify the fixed operations address",
  inputSchema: z.object({ body: z.string() }),
  execute: async ({ body }) =>
    mail.sendMail({ from: "agent@example.com", to: "ops@example.com", text: body }),
});

export const fixedPayment = tool({
  description: "Make a payment of a fixed amount",
  inputSchema: z.object({ description: z.string() }),
  execute: async ({ description }) =>
    stripe.paymentIntents.create({ amount: 100, currency: "usd", description }),
});
