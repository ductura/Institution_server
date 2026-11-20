// The multipart reader of student.source-proofs.post (SRV-1102): the
// boundary of the content type and the parts of a body, as a browser's
// FormData writes them, and the broken bodies it refuses. Invented values only.
import { describe, expect, it } from "vitest";

import { boundaryOf, parseMultipart } from "./multipart.ts";

const B = "----izmisljenaGranica0001";
const part = (head: string, value: string | Buffer) =>
  Buffer.concat([
    Buffer.from(`--${B}\r\n${head}\r\n\r\n`),
    Buffer.from(value),
    Buffer.from("\r\n"),
  ]);
const end = Buffer.from(`--${B}--\r\n`);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0x0d, 0x0a, 0x2d, 0x2d, 0xff, 0xd9]);

describe("boundaryOf", () => {
  it.each([
    [`multipart/form-data; boundary=${B}`, B],
    [`Multipart/Form-Data;boundary="a b'c"`, "a b'c"],
    ["multipart/form-data; boundary=x", "x"],
  ])("reads %j", (type, boundary) => {
    expect(boundaryOf(type)).toBe(boundary);
  });

  it.each([
    "application/json",
    "multipart/form-data",
    "multipart/mixed; boundary=x",
    `multipart/form-data; boundary=${"x".repeat(71)}`,
    'multipart/form-data; boundary="ends with space "',
    "multipart/form-data; boundary=a;b",
  ])("refuses %j", (type) => {
    expect(boundaryOf(type)).toBeUndefined();
  });
});

describe("parseMultipart", () => {
  it("reads text and file parts, bytes untouched (CR LF and dashes inside the file stay)", () => {
    const body = Buffer.concat([
      part('Content-Disposition: form-data; name="page"', "14"),
      part('Content-Disposition: form-data; name="note"', "Izmišljena\r\nbilješka"),
      part(
        'Content-Disposition: form-data; name="image"; filename="blob"\r\nContent-Type: image/jpeg',
        JPEG,
      ),
      end,
    ]);
    const parts = parseMultipart(body, B)!;
    expect([...parts.keys()]).toEqual(["page", "note", "image"]);
    expect(parts.get("page")).toEqual({ file: false, bytes: Buffer.from("14") });
    expect(parts.get("note")!.bytes.toString("utf8")).toBe("Izmišljena\r\nbilješka");
    expect(parts.get("image")!.file).toBe(true);
    expect(parts.get("image")!.bytes.equals(JPEG)).toBe(true);
  });

  it("accepts a closing delimiter without the last line break", () => {
    const body = Buffer.concat([
      part('Content-Disposition: form-data; name="page"', "1"),
      end.subarray(0, -2),
    ]);
    expect(parseMultipart(body, B)?.get("page")?.bytes.toString()).toBe("1");
  });

  it.each([
    [
      "no closing delimiter",
      Buffer.concat([part('Content-Disposition: form-data; name="page"', "1")]),
    ],
    [
      "a preamble",
      Buffer.concat([
        Buffer.from("uvod\r\n"),
        part('Content-Disposition: form-data; name="page"', "1"),
        end,
      ]),
    ],
    [
      "text after the end",
      Buffer.concat([
        part('Content-Disposition: form-data; name="page"', "1"),
        end,
        Buffer.from("x"),
      ]),
    ],
    ["a part without a name", Buffer.concat([part("Content-Disposition: form-data", "1"), end])],
    [
      "a part with an empty name",
      Buffer.concat([part('Content-Disposition: form-data; name=""', "1"), end]),
    ],
    ["a part without a disposition", Buffer.concat([part("Content-Type: text/plain", "1"), end])],
    [
      "a repeated name",
      Buffer.concat([
        part('Content-Disposition: form-data; name="page"', "1"),
        part('Content-Disposition: form-data; name="page"', "2"),
        end,
      ]),
    ],
    [
      "a part without its blank line",
      Buffer.concat([
        Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="page"\r\n1\r\n`),
        end,
      ]),
    ],
    [
      "another boundary",
      Buffer.concat([part('Content-Disposition: form-data; name="page"', "1"), end])
        .toString()
        .replaceAll(B, "druga"),
    ],
    ["an empty body", ""],
  ])("refuses %s", (_, body) => {
    expect(parseMultipart(Buffer.from(body), B)).toBeNull();
  });

  it("tells a file part from a field whose value merely mentions filename", () => {
    const body = Buffer.concat([
      part('Content-Disposition: form-data; name="note"', 'filename="x"'),
      end,
    ]);
    expect(parseMultipart(body, B)?.get("note")?.file).toBe(false);
  });
});
