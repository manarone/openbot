import { Brain, Button, ChevronDown, Workflow } from "@openbot/ui";
import { createUniqueId, For, Show } from "solid-js";
import { useText } from "../../text";

/** One step of an agent's turn: a part of its thinking, or a tool step that the host reported. */
export interface AgentStep {
  id: string;
  kind: "thinking" | "tool";
  /** The text in the interface language. */
  text: string;
}

/** The steps of a turn, oldest first, as the open panel of the activity line or of a finished answer. */
export function AgentStepList(props: { id?: string; steps: readonly AgentStep[] }) {
  const { t } = useText();
  return (
    <ol id={props.id} class="agent-step-list" aria-label={t("chat.steps.list")}>
      <For each={props.steps} keyed={(step) => step.id}>
        {(step) => (
          <li class="agent-step" data-kind={step().kind}>
            <span
              class="agent-step-mark"
              role="img"
              aria-label={t(step().kind === "thinking" ? "chat.steps.thinking" : "chat.steps.tool")}
            >
              <Show when={step().kind === "thinking"} fallback={<Workflow aria-hidden="true" />}>
                <Brain aria-hidden="true" />
              </Show>
            </span>
            <span class="agent-step-text">{step().text}</span>
          </li>
        )}
      </For>
    </ol>
  );
}

/** The steps of a finished turn, above its answer. The caller keeps whether it is open. */
export function AgentStepsDisclosure(props: { steps: readonly AgentStep[]; open: boolean; onToggle: () => void }) {
  const { t } = useText();
  const panelId = createUniqueId();
  const open = () => props.open;
  return (
    <section class="agent-steps" data-open={open() ? "" : undefined}>
      <Button
        variant="ghost"
        size="sm"
        type="button"
        class="agent-steps-toggle"
        aria-expanded={open() ? "true" : "false"}
        aria-controls={open() ? panelId : undefined}
        data-cuelume-tap={open() ? "close" : "open"}
        onClick={() => props.onToggle()}
      >
        <span>{t("chat.steps.title", { count: props.steps.length })}</span>
        <ChevronDown class="agent-steps-chevron" aria-hidden="true" />
      </Button>
      <Show when={open()}>
        <AgentStepList id={panelId} steps={props.steps} />
      </Show>
    </section>
  );
}
