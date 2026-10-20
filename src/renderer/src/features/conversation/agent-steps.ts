import type { ConversationMessage } from "@openbot/contracts/ipc";
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
 * not store them, so a turn read again after a restart shows its thinking and no tool steps. The
 * event handler of the app records each event once, for every agent, so the steps of an agent
 * that works while the user reads another chat are kept too.
 *
 * It also keeps the turns whose steps the user opened or closed. Other turns follow the
 * Settings default. The conversation view mounts again when the user comes back to the chat, so
 * the choice is kept here and not in the view.
 */
export function createTurnStepLog() {
  const [turns, setTurns] = createSignal<ReadonlyMap<string, readonly RecordedToolStep[]>>(new Map());
  const [openChoices, setOpenChoices] = createSignal<ReadonlyMap<string, boolean>>(new Map());
  return {
    record(turnId: string, text: string, afterThinking: number): void {
      setTurns((current) => {
        const steps = current.get(turnId) ?? [];
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
    /** The user's choice for the steps of a turn, or undefined when the user made none. */
    openChoice(turnId: string): boolean | undefined {
      return openChoices().get(turnId);
    },
    chooseOpen(turnId: string, open: boolean): void {
      setOpenChoices((current) => {
        const next = new Map(current);
        next.delete(turnId);
        next.set(turnId, open);
        for (const oldest of next.keys()) {
          if (next.size <= RECORDED_TURN_LIMIT) break;
          next.delete(oldest);
        }
        return next;
      });
    },
  };
}

export type TurnStepLog = ReturnType<typeof createTurnStepLog>;

/**
 * The thinking items of a turn so far in the chat rows, empty ones included, so a recorded
 * position stays valid.
 */
export function thinkingItemCount(rows: readonly AgentMessage[] | undefined, turnId: string): number {
  return rows?.find((row) => row.kind === "thinking" && row.turnId === turnId)?.items?.length ?? 0;
}

/** The same count from the host's messages: each commentary item of the turn is one thinking item. */
export function hostThinkingItemCount(messages: readonly ConversationMessage[] | undefined, turnId: string): number {
  return (
    messages?.filter(
      (message) => message.turnId === turnId && message.author === "assistant" && message.itemType === "commentary",
    ).length ?? 0
  );
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
