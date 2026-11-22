// Page-context (MAIN world) entry on https://x.com, run at document_start before X's scripts.
import { OBSERVATION_TAG } from "../shared/constants.ts";
import { installObserver } from "./observe.ts";

installObserver(window, (obs) => {
  window.postMessage({ tag: OBSERVATION_TAG, obs }, location.origin);
});
