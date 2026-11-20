import { describe, expect, it, vi } from "vitest";

import { createSourceLookup } from "./index.ts";

const DOI = { kind: "doi", value: "10.99999/demo(1)/dio" } as const;
const ISBN = { kind: "isbn", value: "9780000000422" } as const;

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

  it("maps Open Library fields and serves repeat ISBNs from the cache", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        [`ISBN:${ISBN.value}`]: { title: "Izmišljena knjiga", ["publish_date"]: "siječanj 2025." },
      }),
    );
    const lookup = createSourceLookup("operater@example.invalid", { fetcher });
    const result = await lookup(ISBN);
    expect(result).toMatchObject({
      kind: "found",
      source: { type: "book", title: "Izmišljena knjiga", year: 2025 },
    });
    expect(await lookup(ISBN)).toEqual(result);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      `https://openlibrary.org/api/books?bibkeys=ISBN%3A${ISBN.value}&format=json&jscmd=data`,
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it.each([
    [DOI, () => new Response(null, { status: 404 }), "missing"],
    [ISBN, () => Response.json({}), "missing"],
    [DOI, () => new Response("<html>"), "unavailable"],
    [DOI, () => Response.json({ message: {} }), "unavailable"],
    [ISBN, () => Response.json({ [`ISBN:${ISBN.value}`]: null }), "unavailable"],
    [ISBN, () => Response.json({ error: "offline" }), "unavailable"],
    [DOI, () => new Response(null, { status: 429 }), "unavailable"],
    [DOI, () => new Response(null, { status: 302 }), "unavailable"],
    [DOI, () => new Response("x".repeat(1024 * 1024 + 1)), "unavailable"],
  ] as const)("classifies the catalogue response for %j", async (identifier, response, kind) => {
    const lookup = createSourceLookup("operater@example.invalid", {
      fetcher: async () => response(),
    });
    expect(await lookup(identifier)).toEqual({ kind });
  });

  it("applies a deadline through body reading and reserves a slot before awaiting the provider", async () => {
    let now = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const body = new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
        },
      });
      return new Response(body);
    });
    const lookup = createSourceLookup("operater@example.invalid", {
      fetcher,
      now: () => now,
      timeoutMs: 25,
    });
    const pending = lookup(DOI);
    expect(await lookup(DOI)).toEqual({ kind: "limited", retryAfter: 1 });
    expect(await pending).toEqual({ kind: "timeout" });
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    now = 1000;
    await expect(lookup(DOI)).resolves.toEqual({ kind: "timeout" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
