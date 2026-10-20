import { markdownPreviewText } from "@openbot/contracts/markdown-preview-text";
import type { AgentMessage } from "@openbot/ui/data";
import type { AgentStep } from "@openbot/ui/features/conversation/AgentSteps";
import { createSignal } from "solid-js";

/**
 * A progress line that the host sent while a turn ran, in the host's source English.
 * `afterThinking` is how many thinking items the turn had when the line came, so the line keeps
 * its place among them.
 */
interface RecordedToolStep {
  text: string;
  afterThinking: number;
}

/** The turns whose progress lines stay. The oldest turn goes first. */
const RECORDED_TURN_LIMIT = 100;
/** The progress lines that one turn keeps. A longer turn keeps its first ones. */
const RECORDED_STEP_LIMIT = 200;

/**
 * The progress lines of recent turns, for this page only. The host sends them as events and does
 * not store them, so a turn read again after a restart shows its thinking and no tool steps.
 */
export function createTurnStepLog() {
  const [turns, setTurns] = createSignal<ReadonlyMap<string, readonly RecordedToolStep[]>>(new Map());
  return {
    record(turnId: string, text: string, afterThinking: number): void {
      setTurns((current) => {
        const steps = current.get(turnId) ?? [];
        const last = steps.at(-1);
        // A switch between chats gives the same line again. It is one step.
        if (last?.text === text && last.afterThinking === afterThinking) return current;
        if (steps.length >= RECORDED_STEP_LIMIT) return current;
        const next = new Map(current);
        next.delete(turnId);
        next.set(turnId, [...steps, { text, afterThinking }]);
        for (const oldest of next.keys()) {
          if (next.size <= RECORDED_TURN_LIMIT) break;
          next.delete(oldest);
        }
        return next;
      });
    },
    steps(turnId: string): readonly RecordedToolStep[] {
      return turns().get(turnId) ?? [];
    },
  };
}

export type TurnStepLog = ReturnType<typeof createTurnStepLog>;

/** The thinking items of a turn so far, empty ones included, so a recorded position stays valid. */
export function thinkingItemCount(thinking: AgentMessage | undefined): number {
  return thinking?.items?.length ?? 0;
}

/**
 * The steps of one turn, oldest first: each thinking item, with the progress lines that came after
 * it. `translate` reads a host line in the interface language. Empty thinking, such as reasoning
 * the provider keeps hidden, is not a step.
 */
export function turnSteps(
  turnId: string,
  thinking: AgentMessage | undefined,
  tools: readonly RecordedToolStep[],
  translate: (text: string) => string,
): AgentStep[] {
  const items = thinking?.items ?? [];
  const steps: AgentStep[] = [];
  let toolIndex = 0;
  const addToolsBefore = (position: number) => {
    while (toolIndex < tools.length && (tools[toolIndex]?.afterThinking ?? 0) <= position) {
      const tool = tools[toolIndex];
      if (tool) steps.push({ id: `${turnId}:tool:${toolIndex}`, kind: "tool", text: translate(tool.text) });
      toolIndex += 1;
    }
  };
  items.forEach((item, index) => {
    addToolsBefore(index);
    const text = markdownPreviewText(item);
    if (text) steps.push({ id: `${turnId}:thinking:${thinking?.itemIds?.[index] ?? index}`, kind: "thinking", text });
  });
  addToolsBefore(Number.POSITIVE_INFINITY);
  return steps;
}
