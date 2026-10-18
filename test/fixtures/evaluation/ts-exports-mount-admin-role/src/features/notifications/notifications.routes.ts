import { Router } from "express";
import { session } from "../../auth/context.ts";
import { body } from "../../http/middleware/validate.ts";
import { markRead, preferences } from "./notifications.schema.ts";
import { markAsRead, savePreferences, unread } from "./notifications.service.ts";

export const notificationsRouter = Router();

notificationsRouter.get("/", async (_request, response) => {
  response.json(await unread(session(response)));
});

notificationsRouter.post("/read", body(markRead), async (request, response) => {
  response.json(await markAsRead(session(response), request.body.ids));
});

notificationsRouter.put("/preferences", body(preferences), async (request, response) => {
  response.json(await savePreferences(session(response), request.body));
});
