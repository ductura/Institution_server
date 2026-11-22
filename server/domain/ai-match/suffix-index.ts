const BLOCK_BOUNDARY = Symbol("block boundary");
type Token = string | typeof BLOCK_BOUNDARY;

type State = {
  maxLength: number;
  link: number;
  transitions: Map<Token, number>;
  matchedLength: number;
  messageId: string;
};

function state(maxLength: number, link: number, transitions = new Map<Token, number>()): State {
  return { maxLength, link, transitions, matchedLength: 0, messageId: "" };
}

/** Suffix automaton over reversed submitted blocks. Its size depends only on the work. */
export class SuffixIndex {
  private readonly states = [state(0, -1)];
  private last = 0;

  addBlock(points: readonly string[]): number[] {
    if (this.last !== 0) this.extend(BLOCK_BOUNDARY);
    const starts = new Array<number>(points.length);
    for (let i = points.length - 1; i >= 0; i--) starts[i] = this.extend(points[i]!);
    return starts;
  }

  private extend(point: Token): number {
    let previous = this.last;
    const current = this.states.length;
    const next = state(this.states[previous]!.maxLength + 1, 0);
    this.states.push(next);
    this.last = current;
    while (previous >= 0 && !this.states[previous]!.transitions.has(point)) {
      this.states[previous]!.transitions.set(point, current);
      previous = this.states[previous]!.link;
    }
    if (previous < 0) return current;

    const target = this.states[previous]!.transitions.get(point)!;
    const targetState = this.states[target]!;
    const maxLength = this.states[previous]!.maxLength + 1;
    if (maxLength === targetState.maxLength) {
      next.link = target;
      return current;
    }
    const clone = this.states.length;
    this.states.push(state(maxLength, targetState.link, new Map(targetState.transitions)));
    while (previous >= 0 && this.states[previous]!.transitions.get(point) === target) {
      this.states[previous]!.transitions.set(point, clone);
      previous = this.states[previous]!.link;
    }
    targetState.link = clone;
    next.link = clone;
    return current;
  }

  addResponse(points: readonly string[], messageId: string): void {
    let current = this.states[0]!;
    let length = 0;
    for (let i = points.length - 1; i >= 0; i--) {
      const point = points[i]!;
      let next = current.transitions.get(point);
      while (next === undefined && current.link >= 0) {
        current = this.states[current.link]!;
        length = current.maxLength;
        next = current.transitions.get(point);
      }
      if (next === undefined) continue;
      current = this.states[next]!;
      length++;
      if (length > current.matchedLength) {
        current.matchedLength = length;
        current.messageId = messageId;
      }
    }
  }

  finish(): void {
    // Counting sort by maxLength lets each state's best match reach its
    // shorter suffixes in one pass, including states not visited by a scan.
    const counts = new Int32Array(this.states[this.last]!.maxLength + 1);
    for (const { maxLength } of this.states) counts[maxLength] = counts[maxLength]! + 1;
    for (let i = 1; i < counts.length; i++) counts[i] = counts[i]! + counts[i - 1]!;
    const ordered = new Array<State>(this.states.length);
    for (const current of this.states) ordered[--counts[current.maxLength]!] = current;
    for (let i = ordered.length - 1; i > 0; i--) {
      const current = ordered[i]!;
      const suffix = this.states[current.link]!;
      const length = Math.min(current.matchedLength, suffix.maxLength);
      if (length > suffix.matchedLength) {
        suffix.matchedLength = length;
        suffix.messageId = current.messageId;
      }
    }
    // A start state can hold only strings longer than every match, while its
    // longest matched prefix lives in a suffix-link ancestor. Links are
    // shorter, so ascending order lets each state inherit the nearest match.
    for (let i = 1; i < ordered.length; i++) {
      const current = ordered[i]!;
      const suffix = this.states[current.link]!;
      if (current.matchedLength === 0 && suffix.matchedLength > 0) {
        current.matchedLength = suffix.matchedLength;
        current.messageId = suffix.messageId;
      }
    }
  }

  matchAt(start: number): { matchedLength: number; messageId: string } {
    return this.states[start]!;
  }
}
