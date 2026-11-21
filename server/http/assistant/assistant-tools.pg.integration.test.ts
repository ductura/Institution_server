// The AI route as the real caller of the tool loop (SRV-1207; Ductus
// docs/contracts/ai-tools-v1.md, "Testovi prije koda", row "ruta kroz
// sintetički adapter"): the HTTP route reads what the faculty setting permits
// for the session's institution, begin_request reserves the loop, the route
// calls begin_tool_step, the search guard and the synthetic port, and settles.
// The fixture institution of db/main/tests (Ana a student of Z1, Vesna its
// teacher). The faculty setting here is synthetic and turns the tools on for
// fak-a with one invented destination; the guard of the composition has no
// transport (OC-2), so the allowed step fails without any connection. The
// production composition reads config/faculties, where every flag is off.
import { readFileSync } from "node:fs";

import { expect, it, vi } from "vitest";

import { createTestDatabase } from "../../../test-support/database/index.ts";
import { createAssistantRequests, type WithActor } from "../../database/index.ts";
import { createSyntheticAssistant } from "../../external/assistant/index.ts";
import { facultyAiSettingsOf } from "../../external/assistant-tools/index.ts";
import { createDatabases, createLayers, startServer } from "../index.ts";

import {
  assignmentRulesFrom,
  assistantRouteToolsFor,
  createAssistantRoutes,
  parseAssistantProviderConfig,
} from "./index.ts";

const FIXTURES = new URL("../../../db/main/tests/fixtures/", import.meta.url);
const institution = readFileSync(new URL("institution.inc", FIXTURES), "utf8");
const ORIGIN = "https://ductura.example.invalid";
const ANA = "D".repeat(43);

it("drives begin_tool_step, the guard and the port from the route on the real RPCs", async () => {
  const db = await createTestDatabase("main", { authority: true });
  let running: Awaited<ReturnType<typeof startServer>> | undefined;
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  try {
    await db.exec(institution);
    const z1 = (await db.query<{ id: string }>("SELECT pg_temp.id('z1')::text AS id")).rows[0]!.id;
    const ask = async (actor: string, sql: string) =>
      (await db.query<{ v: string }>("SELECT pg_temp.ask($1, $2) AS v", [actor, sql])).rows[0]!.v;
    expect(
      await ask("iva", "SELECT outcome FROM assistant.publish_cost_config(0, 100, 100, 7)"),
    ).toBe("published");
    await db.exec(
      "SELECT assistant.publish_cost_cap(pg_temp.id('fak_a'), 1, 1000, 'day', 'Zahtjev 1/2026')",
    );
    await db.exec("SELECT assistant.publish_cost_cap(NULL, 0, 1000000, 'month', 'Zahtjev 2/2026')");
    // Z1 version 2 allows proofreading; the teacher turns web_search on.
    expect(
      await ask("vesna", `SELECT assistant.set_assignment_tools('${z1}', 0, '{web_search}')::text`),
    ).toBe("1");

    const withActor: WithActor = async (token, run) => {
      await db.query("SELECT set_config('app.session_token', $1, true)", [token]);
      await db.exec("SET LOCAL ROLE ductus_app");
      try {
        return await run({
          async query<Row>(text: string, values?: readonly unknown[]) {
            const { rows } = await db.query<Row>(text, [...(values ?? [])]);
            return { rows, rowCount: rows.length };
          },
        });
      } finally {
        await db.exec("RESET ROLE");
      }
    };
    const config = parseAssistantProviderConfig({
      configVersion: "test-1",
      provider: {
        providerId: "provider-test-a",
        modelId: "model-test-1",
        headquarters: "HR",
        modelDeveloperHeadquarters: "HR",
        processingCountries: ["HR"],
      },
    });
    if (!config.ok) throw new Error("test configuration not loaded");
    const settings = facultyAiSettingsOf([
      {
        format: "ductura-faculty-ai-v1",
        version: 1,
        faculty: "fak-a",
        aiSwitch: { transcription: false, tools: true },
        searchDestinations: [
          {
            id: "trazilica-a",
            endpoint: "https://trazilica-a.invalid/search",
            queryParameter: "q",
          },
        ],
      },
    ]);
    const port = createSyntheticAssistant([
      // Request 1: a look-alike name, then a valid search, then the answer.
      {
        branch: "tool_calls",
        calls: [{ name: "Web_search", args: { query: "x" } }],
        actualMicro: 1n,
      },
      {
        branch: "tool_calls",
        calls: [{ name: "web_search", args: { query: "zarezi" } }],
        actualMicro: 2n,
      },
      { branch: "success", actualMicro: 3n, text: "Izmišljeni odgovor o zarezima." },
      // Request 2: without end.
      { branch: "endless_tools", actualMicro: 1n },
      { branch: "endless_tools", actualMicro: 1n },
      { branch: "endless_tools", actualMicro: 1n },
      { branch: "endless_tools", actualMicro: 1n },
      // Request 3: an answer above the bound.
      { branch: "oversized_response", actualMicro: 2n },
    ]);
    running = await startServer({
      host: "127.0.0.1",
      port: 0,
      databases: createDatabases(),
      layers: createLayers({ expectedOrigin: ORIGIN }),
      routes: createAssistantRoutes({
        requests: createAssistantRequests(withActor),
        rules: assignmentRulesFrom(withActor),
        provider: { config: config.config, port },
        tools: assistantRouteToolsFor(withActor, settings),
      }),
    });
    const base = `http://127.0.0.1:${running.port}`;
    const post = async (key: string, paragraph: string): Promise<Record<string, unknown>> => {
      const got = await fetch(`${base}/api/v1/student/assistant/requests`, {
        method: "POST",
        headers: {
          origin: ORIGIN,
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
          cookie: `__Host-ductus_session=${ANA}`,
          "idempotency-key": key,
        },
        body: JSON.stringify({
          assignmentId: z1,
          conversationId: null,
          purposeCatalogVersion: 1,
          purposeKey: "proofreading",
          paragraph,
        }),
      });
      expect(got.status).toBe(200);
      return (await got.json()) as Record<string, unknown>;
    };
    const stateOf = async (requestId: unknown) =>
      (
        await db.query<{ v: string }>(
          `SELECT r.state || ':' || coalesce(r.reason, '-') || ':' || l.reserved_micro || ':' || coalesce(l.actual_micro::text, '-')
                  || ':' || coalesce((SELECT string_agg(s.step_no || '=' || coalesce(s.tool_name, '-') || '/' || s.outcome, ',' ORDER BY s.step_no)
                                        FROM assistant.tool_step s WHERE s.request_id = r.id), '') AS v
             FROM assistant.request r JOIN assistant.cost_ledger l ON l.request_id = r.id WHERE r.id = $1`,
          [requestId],
        )
      ).rows[0]!.v;

    const first = await post(
      "00000000-0000-4000-8000-000001207001",
      "Izmišljeni odlomak o zarezima.",
    );
    expect(first["outcome"]).toBe("completed");
    expect(first["response"]).toMatchObject({ text: "Izmišljeni odgovor o zarezima." });
    // Reserved 7 × (1 + 3), settled at 1 + 2 + 3; the look-alike name is
    // denied_not_in_set, the search failed (no transport), both took a step.
    expect(await stateOf(first["requestId"])).toBe(
      "completed:-:28:6:1=-/denied_not_in_set,2=web_search/failed",
    );
    const offered = port.calls.slice(0, 3);
    expect(offered.map((call) => call.tools.map((tool) => tool.name))).toEqual([
      ["web_search"],
      ["web_search"],
      ["web_search"],
    ]);
    expect(offered.map((call) => call.data.map((part) => `${part.kind}:${part.text}`))).toEqual([
      ["paragraph:Izmišljeni odlomak o zarezima."],
      ["paragraph:Izmišljeni odlomak o zarezima.", "tool_denied:denied_not_in_set"],
      [
        "paragraph:Izmišljeni odlomak o zarezima.",
        "tool_denied:denied_not_in_set",
        "tool_denied:failed",
      ],
    ]);
    expect(new Set(offered.map((call) => call.instructions)).size).toBe(1);

    const second = await post("00000000-0000-4000-8000-000001207002", "Drugi izmišljeni odlomak.");
    // The answer of the route stays in the closed set: provider_failed.
    expect(second["outcome"]).toBe("provider_failed");
    expect(await stateOf(second["requestId"])).toBe(
      "provider_failed:tool_step_limit:28:4:1=web_search/failed,2=web_search/failed,3=web_search/failed",
    );
    expect(port.calls).toHaveLength(7);

    const third = await post("00000000-0000-4000-8000-000001207003", "Treći izmišljeni odlomak.");
    expect(third["outcome"]).toBe("provider_failed");
    expect(await stateOf(third["requestId"])).toBe("provider_failed:response_too_large:28:2:");
    // No message was stored for the answer above the bound.
    expect(
      (
        await db.query<{ n: string }>(
          "SELECT count(*)::text AS n FROM assistant.message WHERE request_id = $1 AND role = 'provider_response'",
          [third["requestId"]],
        )
      ).rows[0]!.n,
    ).toBe("0");
    // The only fetch calls are the test's own requests to the route (S3-N1).
    expect(fetchSpy.mock.calls.every(([url]) => String(url).startsWith(base))).toBe(true);
  } finally {
    fetchSpy.mockRestore();
    await running?.close();
    await db.close();
  }
});
