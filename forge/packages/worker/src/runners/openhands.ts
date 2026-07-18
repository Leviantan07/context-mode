/**
 * NOT IMPLEMENTED — placeholder so the `Runner` interface visibly has a
 * second implementer, per V1's "clean base that can evolve" goal.
 *
 * OpenHands has a materially different process model (typically Docker-based,
 * with its own event/action schema) from Claude Code's SDK. Wiring this up
 * for real needs its own research pass against OpenHands' actual API surface
 * — guessing at CLI flags or event shapes here would produce code that looks
 * done but silently doesn't work. Implement by mirroring claude-code.ts's
 * shape: translate whatever OpenHands emits into the same `RunnerEvent`
 * union so nothing downstream (DB persistence, LangSmith, SSE) needs to
 * change.
 */
import type { Runner, RunnerOptions } from "./types.js";

export const openHandsRunner: Runner = {
  name: "openhands",

  async run(_options: RunnerOptions): Promise<void> {
    throw new Error(
      "openHandsRunner is not implemented yet. See the comment at the top of " +
        "packages/worker/src/runners/openhands.ts before wiring it up.",
    );
  },
};
