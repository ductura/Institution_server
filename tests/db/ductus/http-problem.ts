import { expect } from "vitest";

export async function expectHttpProblem(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  const requestId = response.headers.get("x-request-id");
  expect(requestId).toEqual(expect.any(String));
  expect(await response.json()).toEqual({
    error: code,
    code,
    messageKey: expect.any(String),
    status,
    requestId,
  });
}
