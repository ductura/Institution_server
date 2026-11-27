// F4-MEN-R10-SRV on the dev fake server: each demo notification keeps its own read time.
import { describe, expect, it } from "vitest";

import { createState } from "./index.ts";
import { DEMO_MESSAGE_SLOT_NOTIFICATION_ID, DEMO_NOTIFICATION_ID } from "./notification-routes.ts";
import { send, signIn } from "./testing.ts";

const ORIGIN = { origin: "http://127.0.0.1:4010", "sec-fetch-site": "same-origin" };
const LIST = "/api/v1/notifications/messages-and-slots";

describe("notifications.read.post", () => {
  it("marks the message notification read without marking the inbox one, and refuses others", async () => {
    const state = createState();
    const student = { ...(await signIn(state, "student")), ...ORIGIN };
    const teacher = { ...(await signIn(state, "nastavnik")), ...ORIGIN };
    const read = (id: string, headers = student) =>
      send(state, `/api/v1/notifications/${id}/read`, { method: "POST", headers });

    expect((await read(DEMO_MESSAGE_SLOT_NOTIFICATION_ID, teacher)).status).toBe(404);
    expect((await read(DEMO_MESSAGE_SLOT_NOTIFICATION_ID)).status).toBe(204);
    const list = (await send(state, LIST, { headers: student })).json as {
      notifications: { readAt: string | null }[];
    };
    expect(list.notifications[0]?.readAt).not.toBeNull();
    const inbox = (await send(state, "/api/v1/notifications", { headers: student })).json as {
      notifications: { readAt: string | null }[];
    };
    expect(inbox.notifications[0]?.readAt).toBeNull();
    expect((await read(DEMO_NOTIFICATION_ID)).status).toBe(204);
    expect((await read("00000000-0000-4000-8000-0000000000ff")).status).toBe(404);
  });
});
