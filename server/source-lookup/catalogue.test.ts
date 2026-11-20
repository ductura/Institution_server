import { describe, expect, it, vi } from "vitest";

import { createSourceLookup } from "./index.ts";

const DOI = { kind: "doi", value: "10.99999/demo(1)/dio" } as const;

describe("source catalogues", () => {
  it("maps a DOI record and sends only its identifier to the fixed catalogue", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        message: {
          title: ["Izmišljeni članak"],
          type: "journal-article",
          author: [{ family: "Izmišljenić", given: "Roko", orcid: "redacted" }],
          issued: { "date-parts": [[2025]] },
          "container-title": ["Izmišljeni časopis"],
        },
      }),
    );
    const lookup = createSourceLookup("operater@example.invalid", { fetcher });
    expect(await lookup(DOI)).toEqual({
      kind: "found",
      source: {
        title: "Izmišljeni članak",
        type: "article",
        authors: [{ name: "Roko Izmišljenić", given: "Roko", family: "Izmišljenić" }],
        year: 2025,
        journal: "Izmišljeni časopis",
      },
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.crossref.org/works/10.99999%2Fdemo(1)%2Fdio",
      {
        redirect: "error",
        signal: expect.any(AbortSignal),
        headers: { accept: "application/json", "user-agent": "Ductura (operater@example.invalid)" },
      },
    );
  });
});
