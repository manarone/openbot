import type { AgentEvent, ConversationMessage, TeamRealtimeEvent } from "@openbot/contracts/ipc";
import { markdownPreviewText } from "@openbot/contracts/markdown-preview-text";
import { cleanAgentMessageText } from "@openbot/team-client/agent-message-text";
import type { AgentMessage } from "@openbot/ui/data";
import type { AgentStep } from "@openbot/ui/features/conversation/AgentSteps";
import { createSignal } from "solid-js";

/**
 * What a running turn sent: a progress line in the host's source English, or the first event of one
 * of the turn's messages. A thinking item is such a message, so the order tells which thinking came
 * before each progress line. `order` is the place: the count of recorded events when it came, or a
 * place between two of them for a message that only a later page read showed.
 */
type RecordedTurnEvent = { order: number } & ({ kind: "tool"; text: string } | { kind: "message"; messageId: string });

/** The turns whose events stay. The oldest turn goes first. */
const RECORDED_TURN_LIMIT = 100;
/** The progress lines that one turn keeps. A longer turn keeps its first ones. */
const RECORDED_STEP_LIMIT = 200;
/** The messages that one turn keeps the place of. A turn has few; this only bounds a broken one. */
const RECORDED_MESSAGE_LIMIT = 400;

/**
 * The events of one turn, by `order`. `observed` is the latest place at which a page read showed
 * the turn: a message that a later read shows first was made after it.
 */
interface RecordedTurn {
  events: readonly RecordedTurnEvent[];
  observed?: number;
}

const EMPTY_TURN: RecordedTurn = { events: [] };

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

/** The events with `added` in their place by `order`. Equal places keep the order they came in. */
function withEvents(events: readonly RecordedTurnEvent[], added: readonly RecordedTurnEvent[]): RecordedTurnEvent[] {
  return [...events, ...added].sort((left, right) => left.order - right.order);
}

/**
 * The events of recent turns, for this page only. The host sends progress lines as events and does
 * not store them, so a turn read again after a restart shows its thinking and no tool steps. The
 * event handler of the app records each event once, for every agent, before any view applies it,
 * so the steps of an agent that works while the user reads another chat keep their order too.
 *
 * A remote host, and the host of the web client, sends no message for a thinking item that has no
 * deltas, such as Claude's text between tool calls. It sends an invalidation, and the client reads
 * a page, which can come after the next progress lines. A message of the running turn that a page
 * shows first goes at the place where the read started, which is just after the invalidation, or
 * at the end when the caller does not know when the read started. A message of a finished turn,
 * such as a chat opened after its agent stopped, goes just after the place of the previous read
 * that showed the turn, or before all its events when no read did. Places are counts, not indexes,
 * so reads that overlap do not move each other's places.
 *
 * It also keeps the turns whose steps the user opened or closed. Other turns follow the Settings
 * default. The conversation view mounts again when the user comes back to the chat, so the choice
 * is kept here and not in the view.
 */
export function createTurnStepLog() {
  const [turns, setTurns] = createSignal<ReadonlyMap<string, RecordedTurn>>(new Map());
  const [openChoices, setOpenChoices] = createSignal<ReadonlyMap<string, boolean>>(new Map());
  /** The count of recorded events. It is the place of the next event, and is never read reactively. */
  let recorded = 0;
  const seen = (turn: RecordedTurn, messageId: string) =>
    turn.events.some((event) => event.kind === "message" && event.messageId === messageId);
  return {
    recordProgress(turnId: string, text: string): void {
      const order = ++recorded;
      setTurns((current) => {
        const turn = current.get(turnId) ?? EMPTY_TURN;
        if (turn.events.filter((event) => event.kind === "tool").length >= RECORDED_STEP_LIMIT) return current;
        return withNewestTurn(current, turnId, { ...turn, events: [...turn.events, { order, kind: "tool", text }] });
      });
    },
    /** Keeps the place of a message of the turn that the host sent as it was made. Only its first event counts. */
    recordMessage(turnId: string, messageId: string): void {
      const order = ++recorded;
      setTurns((current) => {
        const turn = current.get(turnId) ?? EMPTY_TURN;
        if (seen(turn, messageId) || turn.events.length >= RECORDED_STEP_LIMIT + RECORDED_MESSAGE_LIMIT) return current;
        return withNewestTurn(current, turnId, {
          ...turn,
          events: [...turn.events, { order, kind: "message", messageId }],
        });
      });
    },
    /** The place where a read starts, to give to `recordPage` when the page comes. */
    mark(): number {
      return recorded;
    },
    /**
     * Keeps the place of the messages of a page read, as the comment of `createTurnStepLog` says.
     * `turnIds` are the turns that the page shows. `readStart` is the result of `mark()` when the
     * read started, where the caller knows it. A page of older history does not `observe` its
     * turns: their newest messages can be after it.
     */
    recordPage(
      turnIds: ReadonlySet<string>,
      messages: ReadonlyArray<{ turnId: string; messageId: string }>,
      runningTurnId: string | null,
      readStart?: number,
      observes = true,
    ): void {
      const now = readStart ?? ++recorded;
      setTurns((current) => {
        let next = current;
        for (const turnId of turnIds) {
          const running = turnId === runningTurnId;
          const turn = next.get(turnId) ?? (running ? EMPTY_TURN : undefined);
          if (!turn) continue;
          const after = running ? now : (turn.observed ?? (turn.events[0]?.order ?? now) - 1);
          const room = Math.max(0, RECORDED_STEP_LIMIT + RECORDED_MESSAGE_LIMIT - turn.events.length);
          const added = messages
            .filter((message) => message.turnId === turnId && !seen(turn, message.messageId))
            .slice(0, room)
            // Between `after` and the next event, in the order of the page.
            .map(
              (message, index, list): RecordedTurnEvent => ({
                order: after + (index + 1) / (list.length + 1),
                kind: "message",
                messageId: message.messageId,
              }),
            );
          const events = withEvents(turn.events, added);
          const observed = observes ? Math.max(turn.observed ?? Number.NEGATIVE_INFINITY, now) : turn.observed;
          next = withNewestTurn(next, turnId, observed === undefined ? { events } : { events, observed });
        }
        return next;
      });
    },
    events(turnId: string): readonly RecordedTurnEvent[] {
      return turns().get(turnId)?.events ?? [];
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

function isCommentary(message: ConversationMessage): message is ConversationMessage & { turnId: string } {
  return message.turnId !== undefined && message.author === "assistant" && message.itemType === "commentary";
}

/** Keeps the place of each commentary message of the running turn in a snapshot, which the host sends as it changes. */
function recordRunningCommentary(
  log: TurnStepLog,
  conversation: { activeTurnId: string | null; messages: readonly ConversationMessage[] },
): void {
  const turnId = conversation.activeTurnId;
  if (!turnId) return;
  for (const message of conversation.messages) {
    if (isCommentary(message) && message.turnId === turnId) log.recordMessage(turnId, message.id);
  }
}

/**
 * Keeps the place of the commentary messages in a page that the client read. `read` is where the
 * caller knows it: `log.mark()` from when the read started, and whether it read older history. A
 * page shows the turns that it has messages of. The latest page also shows the running turn with
 * none yet; an older page does not, because the turn's newest messages are not in it.
 */
export function recordTurnStepPage(
  log: TurnStepLog,
  page: { activeTurnId: string | null; messages: readonly ConversationMessage[] },
  read?: { start: number; older: boolean },
): void {
  const turnIds = new Set(page.messages.flatMap((message) => (message.turnId ? [message.turnId] : [])));
  const latest = read?.older !== true;
  if (latest && page.activeTurnId) turnIds.add(page.activeTurnId);
  log.recordPage(
    turnIds,
    page.messages.filter(isCommentary).map((message) => ({ turnId: message.turnId, messageId: message.id })),
    latest ? page.activeTurnId : null,
    read?.start,
    latest,
  );
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
      recordTurnStepPage(log, event.page);
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
