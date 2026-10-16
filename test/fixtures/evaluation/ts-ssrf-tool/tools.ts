import { tool } from "ai";
import { z } from "zod";

export const fetchPage = tool({
  description: "Fetch a web page for the user",
  inputSchema: z.object({ url: z.string() }),
  execute: async ({ url }) => {
    const response = await fetch(url);
    return response.text();
  },
});
