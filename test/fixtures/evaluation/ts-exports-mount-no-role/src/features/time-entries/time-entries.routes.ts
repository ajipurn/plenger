import { Router } from "express";
import { session } from "../../auth/context.ts";
import { body, query } from "../../http/middleware/validate.ts";
import { entryCreate, entryRange, entryUpdate } from "./time-entries.schema.ts";
import { createEntry, deleteEntry, listOwnEntries, updateEntry } from "./time-entries.service.ts";

export const timeEntriesRouter = Router();

timeEntriesRouter.get("/", async (request, response) => {
  const { from, to } = query(entryRange, request);
  response.json(await listOwnEntries(session(response), from, to));
});

timeEntriesRouter.post("/", body(entryCreate), async (request, response) => {
  response.status(201).json(await createEntry(session(response), request.body));
});

timeEntriesRouter.patch("/:id", body(entryUpdate), async (request, response) => {
  response.json(await updateEntry(session(response), request.params.id, request.body));
});

timeEntriesRouter.delete("/:id", async (request, response) => {
  await deleteEntry(session(response), request.params.id);
  response.status(204).end();
});
