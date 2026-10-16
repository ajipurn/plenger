import { tool } from "ai";
import { z } from "zod";

const HOSTS = new Set(["docs.example.com"]);

export const fetchDocs = tool({
  description: "Fetch a documentation page",
  inputSchema: z.object({ path: z.string() }),
  execute: async ({ path }) => {
    const url = new URL(path, "https://docs.example.com/");
    if (url.protocol !== "https:" || !HOSTS.has(url.hostname)) throw new Error("host not allowed");
    const response = await fetch(url, { redirect: "error" });
    return response.text();
  },
});
