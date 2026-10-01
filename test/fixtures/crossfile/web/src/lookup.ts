import { tool } from "@langchain/core/tools";
import { z } from "zod";

export const lookup = tool(async ({ url }) => (await fetch(url)).text(), {
  name: "lookup",
  description: "Fetch a page",
  schema: z.object({ url: z.string() }),
});
