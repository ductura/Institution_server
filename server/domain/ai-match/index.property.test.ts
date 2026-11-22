import { fc, test } from "@fast-check/vitest";
import { expect } from "vitest";

import { compareAssistantResponses } from "./index.ts";

type Word = "biljka" | "zeleni" | "vrtlarstvo" | "kompostira" | "cvijet";

const words = fc.array(
  fc.constantFrom<Word>("biljka", "zeleni", "vrtlarstvo", "kompostira", "cvijet"),
  {
    minLength: 14,
    maxLength: 30,
  },
);

function bruteForceSpans(text: string, answers: string[]) {
  const coverage = Array.from({ length: text.length }, () => false);
  for (const match of text.matchAll(/[a-z]+/g)) {
    const from = match.index;
    for (const ending of text.matchAll(/[a-z]+/g)) {
      const to = ending.index + ending[0].length;
      if (to - from >= 60 && answers.some((answer) => answer.includes(text.slice(from, to)))) {
        coverage.fill(true, from, to);
      }
    }
  }
  const spans = [];
  let from = 0;
  for (let i = 0; i <= coverage.length; i++) {
    if (coverage[i] && !coverage[i - 1]) from = i;
    if (!coverage[i] && coverage[i - 1]) spans.push({ blockId: "demo-block", from, to: i });
  }
  return spans;
}

// Shrunk counterexample from seed 1290383480: the start state of a repeated
// word only held strings longer than the reply, so its match lived in an ancestor.
const repeatedWordRegression: [Word[], Word[], [number, number][]] = [
  Array.from({ length: 14 }, (): Word => "biljka"),
  [...Array.from({ length: 12 }, (): Word => "biljka"), "cvijet", "biljka"],
  [],
];

test.prop([words, words, fc.array(fc.tuple(fc.nat(29), fc.nat(29)), { maxLength: 4 })], {
  examples: [repeatedWordRegression],
})(
  "agrees with exhaustive word-boundary matching and each witness matches its own reply",
  (submitted, unrelated, intervals) => {
    const block = { blockId: "demo-block", text: submitted.join(" ") };
    const answers = [
      unrelated.join(" "),
      ...intervals.map(([from, to]) => submitted.slice(from, to).join(" ")),
    ];
    const responses = answers.map((text, index) => ({ messageId: `demo-message-${index}`, text }));
    const { aiMatch, witnesses } = compareAssistantResponses([block], responses);
    expect(aiMatch.spans).toEqual(bruteForceSpans(block.text, answers));
    expect(compareAssistantResponses([block], responses.toReversed()).aiMatch).toEqual(aiMatch);
    for (const { normalizedFrom, normalizedTo, messageId } of witnesses) {
      const response = responses.find((item) => item.messageId === messageId)!;
      expect(response.text).toContain(block.text.slice(normalizedFrom, normalizedTo));
    }
  },
);
