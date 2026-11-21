// The closed shape of the faculty AI setting (OC-1, OC-2). All faculties,
// endpoints and destinations are invented.
import { describe, expect, it } from "vitest";

import {
  aiSwitchOf,
  FACULTY_AI_CONFIG_FORMAT,
  isSearchEndpoint,
  parseFacultyAiConfig,
  SEARCH_DESTINATIONS_MAX,
  serverPermittedTools,
} from "./faculty-ai-config.ts";

const DESTINATION = {
  id: "trazilica-a",
  endpoint: "https://trazilica-a.invalid/search",
  queryParameter: "q",
};

function setting(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: FACULTY_AI_CONFIG_FORMAT,
    version: 1,
    faculty: "izmisljeni-fakultet",
    aiSwitch: { transcription: false, tools: false },
    searchDestinations: [],
    ...overrides,
  };
}

describe("parseFacultyAiConfig", () => {
  it("accepts the pilot shape: both flags off, no destination", () => {
    const parsed = parseFacultyAiConfig(setting());
    expect(parsed).toEqual({
      ok: true,
      config: {
        format: FACULTY_AI_CONFIG_FORMAT,
        version: 1,
        faculty: "izmisljeni-fakultet",
        aiSwitch: { transcription: false, tools: false },
        searchDestinations: [],
      },
    });
    if (parsed.ok) expect(serverPermittedTools(parsed.config)).toEqual([]);
  });

  it("refuses every key outside the closed shape and every missing key", () => {
    expect(parseFacultyAiConfig(setting({ enabled: true }))).toEqual({
      ok: false,
      rule: "unknown_key",
    });
    const missing = setting();
    delete missing["searchDestinations"];
    expect(parseFacultyAiConfig(missing)).toEqual({ ok: false, rule: "unknown_key" });
    expect(parseFacultyAiConfig(setting({ aiSwitch: { tools: false } }))).toEqual({
      ok: false,
      rule: "switch",
    });
    expect(
      parseFacultyAiConfig(
        setting({ aiSwitch: { transcription: false, tools: false, web: true } }),
      ),
    ).toEqual({ ok: false, rule: "switch" });
  });

  it("a flag is a boolean, never a string or a number", () => {
    for (const tools of ["true", 1, null, "yes"])
      expect(parseFacultyAiConfig(setting({ aiSwitch: { transcription: false, tools } })).ok).toBe(
        false,
      );
  });

  it("checks the format, the version and the faculty slug", () => {
    expect(parseFacultyAiConfig(setting({ format: "ductura-faculty-ai-v2" })).ok).toBe(false);
    for (const version of [0, -1, 1.5, "1", null])
      expect(parseFacultyAiConfig(setting({ version })).ok).toBe(false);
    for (const faculty of ["F", "a", "fakultet/../x", "x".repeat(33)])
      expect(parseFacultyAiConfig(setting({ faculty })).ok).toBe(false);
    expect(parseFacultyAiConfig(null)).toEqual({ ok: false, rule: "not_object" });
    expect(parseFacultyAiConfig([setting()])).toEqual({ ok: false, rule: "not_object" });
  });

  it("a destination is a fixed https endpoint with a query parameter, ids distinct", () => {
    const parsed = parseFacultyAiConfig(
      setting({
        aiSwitch: { transcription: false, tools: true },
        searchDestinations: [DESTINATION],
      }),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(serverPermittedTools(parsed.config)).toEqual(["web_search"]);
    for (const bad of [
      [DESTINATION, DESTINATION],
      [{ ...DESTINATION, extra: 1 }],
      [{ ...DESTINATION, id: "Trazilica" }],
      [{ ...DESTINATION, queryParameter: "q&x=1" }],
      [{ ...DESTINATION, endpoint: "http://trazilica-a.invalid/search" }],
      Array.from({ length: SEARCH_DESTINATIONS_MAX + 1 }, (_, i) => ({
        ...DESTINATION,
        id: `d${i}`,
      })),
    ])
      expect(parseFacultyAiConfig(setting({ searchDestinations: bad })).ok).toBe(false);
  });

  it("the switch of no setting is off, and tools need both the flag and a destination", () => {
    expect(aiSwitchOf(null)).toEqual({ transcription: false, tools: false });
    const flagOnly = parseFacultyAiConfig(
      setting({ aiSwitch: { transcription: true, tools: true } }),
    );
    expect(flagOnly.ok && serverPermittedTools(flagOnly.config)).toEqual([]);
    const destinationOnly = parseFacultyAiConfig(setting({ searchDestinations: [DESTINATION] }));
    expect(destinationOnly.ok && serverPermittedTools(destinationOnly.config)).toEqual([]);
  });
});

describe("isSearchEndpoint (S3-N2)", () => {
  it("accepts only https to a host name, without user, port, query or fragment", () => {
    expect(isSearchEndpoint("https://trazilica-a.invalid/search")).toBe(true);
    for (const bad of [
      "http://trazilica-a.invalid/search",
      "https://korisnik@trazilica-a.invalid/search",
      "https://trazilica-a.invalid:8443/search",
      "https://trazilica-a.invalid/search?x=1",
      "https://trazilica-a.invalid/search#a",
      "https://127.0.0.1/search",
      "https://[::1]/search",
      "https://localhost/search",
      "https://TRAZILICA.invalid/search",
      "file:///etc/passwd",
      "https://trazilica-a.invalid/s earch",
      7,
    ])
      expect(isSearchEndpoint(bad)).toBe(false);
  });
});
