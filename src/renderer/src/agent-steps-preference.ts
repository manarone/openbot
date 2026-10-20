import { createSignal } from "solid-js";

const AGENT_STEPS_STORAGE_KEY = "openbot:agent-steps-expanded";

type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

/** The choice for this page after the browser did not save it. It wins over an older saved value. */
let unsavedPreference: boolean | undefined;

/**
 * Whether the steps of an agent's turn start open on this device and browser. They start closed
 * unless the user chose otherwise. Reading `window.localStorage` throws when the browser blocks
 * storage, so it is read inside the guard.
 */
export function readAgentStepsExpanded(storage?: PreferenceStorage): boolean {
  if (unsavedPreference !== undefined) return unsavedPreference;
  try {
    return (storage ?? window.localStorage).getItem(AGENT_STEPS_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function writeAgentStepsExpanded(expanded: boolean, storage?: PreferenceStorage): void {
  try {
    (storage ?? window.localStorage).setItem(AGENT_STEPS_STORAGE_KEY, String(expanded));
    unsavedPreference = undefined;
  } catch {
    // Blocked or full storage keeps the choice for this page only.
    unsavedPreference = expanded;
  }
}

const [agentStepsExpanded, setAgentStepsExpandedSignal] = createSignal(readAgentStepsExpanded());

function readStorageIntoSignal(event: StorageEvent): void {
  if (event.key !== null && event.key !== AGENT_STEPS_STORAGE_KEY) return;
  setAgentStepsExpandedSignal(readAgentStepsExpanded());
}

if (typeof window !== "undefined") {
  // One registration per page: addEventListener ignores the same listener twice, and HMR
  // disposal removes it when this module is replaced.
  window.addEventListener("storage", readStorageIntoSignal);
  import.meta.hot?.dispose(() => {
    window.removeEventListener("storage", readStorageIntoSignal);
  });
}

/** The shared reactive preference. A Settings change reaches every open conversation on this page. */
export function useAgentStepsExpanded(): () => boolean {
  return agentStepsExpanded;
}

export function setAgentStepsExpanded(expanded: boolean): void {
  writeAgentStepsExpanded(expanded);
  setAgentStepsExpandedSignal(expanded);
}
