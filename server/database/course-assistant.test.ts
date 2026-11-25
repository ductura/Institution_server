// The port of the assistant switch per course (SRV-ASIST-PREKIDAC) over a fake
// withActor: the SQL it sends, refusals mapped to their outcomes, malformed ids
// never sent, and every row it cannot vouch for thrown. All values are invented.
import { describe, expect, it } from "vitest";

import { createCourseAssistantPort } from "./course-assistant.ts";
import type { WithActor } from "./with-actor.ts";

const TOKEN = "izmisljeni-token";
const ID = "00000000-0000-4000-8000-0000000000c1";

function portOver(answer: (text: string, values: unknown[]) => unknown[] | Error) {
  const sent: [string, unknown[]][] = [];
  const withActor = (async (_token: string, fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      query: async (text: string, values: unknown[]) => {
        sent.push([text, values]);
        const rows = answer(text, values);
        if (rows instanceof Error) throw rows;
        return { rows };
      },
    })) as unknown as WithActor;
  return { port: createCourseAssistantPort(withActor), sent };
}
const refusal = (code: string) => Object.assign(new Error("izmisljeno"), { code });

describe("createCourseAssistantPort", () => {
  it("sets and reads the switch through its RPCs", async () => {
    const { port, sent } = portOver(() => [{ enabled: false }]);
    expect(await port.set(TOKEN, ID, false)).toEqual({ status: "read", enabled: false });
    expect(await port.read(TOKEN, ID)).toEqual({ status: "read", enabled: false });
    expect(sent.map(([text]) => text.match(/app\.\w+/u)![0])).toEqual([
      "app.course_assistant_switch",
      "app.course_assistant_switch_read",
    ]);
    expect(sent[0]![1]).toEqual([ID, false]);
  });

  it("a state other than the one sent is thrown, so the write rolls back", async () => {
    const { port } = portOver(() => [{ enabled: true }]);
    await expect(port.set(TOKEN, ID, false)).rejects.toThrow(/Unconfirmed/u);
  });

  it("reads the availability of a student", async () => {
    const { port } = portOver(() => [{ outcome: "found", available: true }]);
    expect(await port.available(TOKEN, ID)).toEqual({ status: "read", available: true });
    const off = portOver(() => [{ outcome: "found", available: false }]).port;
    expect(await off.available(TOKEN, ID)).toEqual({ status: "read", available: false });
    const none = portOver(() => [{ outcome: "not_found", available: null }]).port;
    expect(await none.available(TOKEN, ID)).toEqual({ status: "not_found" });
  });

  it.each([
    ["ZD401", "unauthorized"],
    ["ZD403", "not_found"],
    ["ZD422", "invalid_input"],
  ])("a refusal %s of the switch is %s", async (code, status) => {
    const { port } = portOver(() => refusal(code));
    expect(await port.set(TOKEN, ID, true)).toEqual({ status });
  });

  it("a session refused while reading the availability is unauthorized", async () => {
    const { port } = portOver(() => refusal("ZD401"));
    expect(await port.available(TOKEN, ID)).toEqual({ status: "unauthorized" });
  });

  it("an id that is not a lowercase uuid is never sent", async () => {
    const { port, sent } = portOver(() => [{ enabled: true }]);
    expect(await port.read(TOKEN, ID.toUpperCase())).toEqual({ status: "not_found" });
    expect(await port.set(TOKEN, "nije-uuid", true)).toEqual({ status: "not_found" });
    expect(await port.available(TOKEN, "")).toEqual({ status: "not_found" });
    expect(sent).toEqual([]);
  });

  it.each([
    ["no row", []],
    ["two rows", [{ enabled: true }, { enabled: true }]],
    ["not a boolean", [{ enabled: "true" }]],
  ])("a switch answer with %s is thrown", async (_name, rows) => {
    const { port } = portOver(() => rows);
    await expect(port.read(TOKEN, ID)).rejects.toThrow();
  });

  it.each([
    ["an unknown outcome", [{ outcome: "maybe", available: true }]],
    ["not_found with a value", [{ outcome: "not_found", available: false }]],
    ["found without a value", [{ outcome: "found", available: null }]],
  ])("an availability with %s is thrown", async (_name, rows) => {
    const { port } = portOver(() => rows);
    await expect(port.available(TOKEN, ID)).rejects.toThrow();
  });

  it("a ZD422 on the availability is a database it cannot vouch for", async () => {
    const { port } = portOver(() => refusal("ZD422"));
    await expect(port.available(TOKEN, ID)).rejects.toThrow();
  });

  // SRV-ASIST-BROJAC: the daily request count.
  it("reads the request count of a student through its RPC", async () => {
    const { port, sent } = portOver(() => [{ outcome: "found", limit: 20, used: 3 }]);
    expect(await port.requests(TOKEN, ID)).toEqual({ status: "read", limit: 20, used: 3 });
    expect(sent).toEqual([
      [
        expect.stringContaining(
          'request_limit AS "limit", used FROM app.my_assistant_requests($1::uuid)',
        ),
        [ID],
      ],
    ]);
    const free = portOver(() => [{ outcome: "found", limit: null, used: 0 }]).port;
    expect(await free.requests(TOKEN, ID)).toEqual({ status: "read", limit: null, used: 0 });
    const none = portOver(() => [{ outcome: "not_found", limit: null, used: null }]).port;
    expect(await none.requests(TOKEN, ID)).toEqual({ status: "not_found" });
  });

  it.each([
    ["ZD401", "unauthorized"],
    ["ZD403", "not_found"],
  ])("a refusal %s of the request count is %s", async (code, status) => {
    const { port } = portOver(() => refusal(code));
    expect(await port.requests(TOKEN, ID)).toEqual({ status });
  });

  it("a request count of a malformed id is never sent", async () => {
    const { port, sent } = portOver(() => [{ outcome: "found", limit: null, used: 0 }]);
    expect(await port.requests(TOKEN, "nije-uuid")).toEqual({ status: "not_found" });
    expect(sent).toEqual([]);
  });

  it.each([
    ["an unknown outcome", [{ outcome: "maybe", limit: 5, used: 1 }]],
    ["not_found with a value", [{ outcome: "not_found", limit: null, used: 0 }]],
    ["a limit of 0", [{ outcome: "found", limit: 0, used: 0 }]],
    ["a negative count", [{ outcome: "found", limit: 5, used: -1 }]],
    ["a count as text", [{ outcome: "found", limit: 5, used: "1" }]],
    ["no count", [{ outcome: "found", limit: 5, used: null }]],
    ["a fraction", [{ outcome: "found", limit: 5.5, used: 1 }]],
  ])("a request count with %s is thrown", async (_name, rows) => {
    const { port } = portOver(() => rows);
    await expect(port.requests(TOKEN, ID)).rejects.toThrow();
  });

  it("a ZD422 on the request count is a database it cannot vouch for", async () => {
    const { port } = portOver(() => refusal("ZD422"));
    await expect(port.requests(TOKEN, ID)).rejects.toThrow();
  });

  // SRV-ASIST-LIMIT-ADMIN: the administrator's request limit.
  it("reads the request limit of the institution through its RPC", async () => {
    const { port, sent } = portOver(() => [{ version: 3, limit: 20 }]);
    expect(await port.readLimit(TOKEN)).toEqual({ status: "read", version: 3, limit: 20 });
    expect(sent).toEqual([
      [expect.stringContaining('request_limit AS "limit" FROM assistant.read_request_limit()'), []],
    ]);
    const none = portOver(() => [{ version: 0, limit: null }]).port;
    expect(await none.readLimit(TOKEN)).toEqual({ status: "read", version: 0, limit: null });
  });

  it.each([5, null])("sets the request limit %s on the version seen", async (limit) => {
    const { port, sent } = portOver(() => [{ version: 4 }]);
    expect(await port.setLimit(TOKEN, 3, limit)).toEqual({ status: "read", version: 4, limit });
    expect(sent).toEqual([
      [
        expect.stringContaining("assistant.set_request_limit($1::integer, $2::integer)"),
        [3, limit],
      ],
    ]);
  });

  it.each([
    ["ZD401", "unauthorized"],
    ["ZD403", "forbidden"],
    ["ZD409", "conflict"],
    ["ZD422", "invalid_input"],
  ])("a refusal %s of setting the limit is %s", async (code, status) => {
    const { port } = portOver(() => refusal(code));
    expect(await port.setLimit(TOKEN, 0, 5)).toEqual({ status });
  });

  it.each([
    ["ZD401", "unauthorized"],
    ["ZD403", "forbidden"],
  ])("a refusal %s of reading the limit is %s", async (code, status) => {
    const { port } = portOver(() => refusal(code));
    expect(await port.readLimit(TOKEN)).toEqual({ status });
  });

  it.each(["ZD409", "ZD422"])(
    "a %s on reading the limit is a database it cannot vouch for",
    async (code) => {
      const { port } = portOver(() => refusal(code));
      await expect(port.readLimit(TOKEN)).rejects.toThrow();
    },
  );

  it.each([
    [-1, 5],
    [1.5, 5],
    [0, 0],
    [0, 2.5],
  ])("version %s and limit %s are never sent", async (version, limit) => {
    const { port, sent } = portOver(() => [{ version: 1 }]);
    expect(await port.setLimit(TOKEN, version, limit)).toEqual({ status: "invalid_input" });
    expect(sent).toEqual([]);
  });

  it.each([
    ["a limit of 0", [{ version: 1, limit: 0 }]],
    ["a negative version", [{ version: -1, limit: 5 }]],
    ["a version as text", [{ version: "1", limit: 5 }]],
    ["no row", []],
  ])("a request limit with %s is thrown", async (_name, rows) => {
    const { port } = portOver(() => rows);
    await expect(port.readLimit(TOKEN)).rejects.toThrow();
  });

  it("a set that answers version 0 is thrown", async () => {
    const { port } = portOver(() => [{ version: 0 }]);
    await expect(port.setLimit(TOKEN, 0, 5)).rejects.toThrow();
  });
  it("another error is thrown as it came", async () => {
    const { port } = portOver(() => new Error("izmisljeni kvar"));
    await expect(port.set(TOKEN, ID, true)).rejects.toThrow("izmisljeni kvar");
  });
});
