import type { AgentEvent, ConversationMessage, TeamRealtimeEvent } from "@openbot/contracts/ipc";
import { markdownPreviewText } from "@openbot/contracts/markdown-preview-text";
import { cleanAgentMessageText } from "@openbot/team-client/agent-message-text";
import type { AgentMessage } from "@openbot/ui/data";
import type { AgentStep } from "@openbot/ui/features/conversation/AgentSteps";
import { createSignal } from "solid-js";

/**
 * What a running turn sent, in the order the events came: a progress line in the host's source
 * English, or the first event of one of the turn's messages. A thinking item is such a message, so
 * the order tells which thinking came before each progress line.
 */
type RecordedTurnEvent = { kind: "tool"; text: string } | { kind: "message"; messageId: string };

/** The turns whose events stay. The oldest turn goes first. */
const RECORDED_TURN_LIMIT = 100;
/** The progress lines that one turn keeps. A longer turn keeps its first ones. */
const RECORDED_STEP_LIMIT = 200;
/** The messages that one turn keeps the place of. A turn has few; this only bounds a broken one. */
const RECORDED_MESSAGE_LIMIT = 400;

/** The map with `turnId` set to `value` as its newest turn, and the oldest turns over the limit removed. */
function withNewestTurn<T>(current: ReadonlyMap<string, T>, turnId: string, value: T): ReadonlyMap<string, T> {
  const next = new Map(current);
  next.delete(turnId);
  next.set(turnId, value);
  for (const oldest of next.keys()) {
    if (next.size <= RECORDED_TURN_LIMIT) break;
    next.delete(oldest);
  }
  return next;
}

/**
 * The events of recent turns, for this page only. The host sends progress lines as events and does
 * not store them, so a turn read again after a restart shows its thinking and no tool steps. The
 * event handler of the app records each event once, for every agent, before any view applies it,
 * so the steps of an agent that works while the user reads another chat keep their order too.
 *
 * It also keeps the turns whose steps the user opened or closed. Other turns follow the Settings
 * default. The conversation view mounts again when the user comes back to the chat, so the choice
 * is kept here and not in the view.
 */
export function createTurnStepLog() {
  const [turns, setTurns] = createSignal<ReadonlyMap<string, readonly RecordedTurnEvent[]>>(new Map());
  const [openChoices, setOpenChoices] = createSignal<ReadonlyMap<string, boolean>>(new Map());
  return {
    recordProgress(turnId: string, text: string): void {
      setTurns((current) => {
        const events = current.get(turnId) ?? [];
        if (events.filter((event) => event.kind === "tool").length >= RECORDED_STEP_LIMIT) return current;
        return withNewestTurn(current, turnId, [...events, { kind: "tool", text }]);
      });
    },
    /** Keeps the place of a message of the turn. Only its first event counts. */
    recordMessage(turnId: string, messageId: string): void {
      setTurns((current) => {
        const events = current.get(turnId) ?? [];
        if (events.some((event) => event.kind === "message" && event.messageId === messageId)) return current;
        if (events.length >= RECORDED_STEP_LIMIT + RECORDED_MESSAGE_LIMIT) return current;
        return withNewestTurn(current, turnId, [...events, { kind: "message", messageId }]);
      });
    },
    events(turnId: string): readonly RecordedTurnEvent[] {
      return turns().get(turnId) ?? [];
    },
    /** The user's choice for the steps of a turn, or undefined when the user made none. */
    openChoice(turnId: string): boolean | undefined {
      return openChoices().get(turnId);
    },
    chooseOpen(turnId: string, open: boolean): void {
      setOpenChoices((current) => withNewestTurn(current, turnId, open));
    },
  };
}

export type TurnStepLog = ReturnType<typeof createTurnStepLog>;

/** Keeps the place of each commentary message of the running turn in a snapshot or a page. */
function recordRunningCommentary(
  log: TurnStepLog,
  conversation: { activeTurnId: string | null; messages: readonly ConversationMessage[] },
): void {
  const turnId = conversation.activeTurnId;
  if (!turnId) return;
  for (const message of conversation.messages) {
    if (message.turnId === turnId && message.author === "assistant" && message.itemType === "commentary") {
      log.recordMessage(turnId, message.id);
    }
  }
}

/**
 * Records what an agent event says about the steps of a running turn. The desktop event bridge
 * and the web workspace call it for each event of the host, for every agent.
 */
export function recordTurnStepEvent(log: TurnStepLog, event: AgentEvent | TeamRealtimeEvent): void {
  switch (event.type) {
    case "turn-progress":
      log.recordProgress(event.turnId, cleanAgentMessageText(event.detail));
      return;
    case "conversation-delta":
      log.recordMessage(event.turnId, event.messageId);
      return;
    case "conversation":
      recordRunningCommentary(log, event.snapshot);
      return;
    case "conversation-page":
      recordRunningCommentary(log, event.page);
      return;
    default:
      return;
  }
}

/**
 * The steps of one turn, oldest first: each thinking item, with the progress lines that came after
 * it. A progress line follows the last thinking item whose first event came before it. A thinking
 * item with no recorded event, such as one read after a restart, keeps its place in the list.
 * `translate` reads a host line in the interface language. Empty thinking, such as reasoning the
 * provider keeps hidden, is not a step.
 */
export function turnSteps(
  turnId: string,
  thinking: AgentMessage | undefined,
  events: readonly RecordedTurnEvent[],
  translate: (text: string) => string,
): AgentStep[] {
  const items = thinking?.items ?? [];
  const itemIndex = new Map((thinking?.itemIds ?? []).map((id, index) => [id, index]));
  const tools: Array<{ text: string; afterThinking: number }> = [];
  let afterThinking = 0;
  for (const event of events) {
    if (event.kind === "tool") {
      tools.push({ text: event.text, afterThinking });
      continue;
    }
    const index = itemIndex.get(event.messageId);
    if (index !== undefined) afterThinking = Math.max(afterThinking, index + 1);
  }
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
