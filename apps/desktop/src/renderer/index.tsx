import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "react-aria-components";

// M2-01 shell. It shows only what is real: whether the core runs and what it reports. The core screens
// (onboarding, library, capture, import) are M2-02.

type CoreView =
  | { state: "starting" | "stopped" }
  | { state: "restarting"; attempt: number }
  | { state: "failed"; code: string; message: string }
  | { state: "ready"; coreVersion: string; schemaVersion: number; protocolVersion: number };

interface StatusResult {
  core: { version: string; pid: number; startedAt: string };
  protocol: { version: number };
  library: { schemaVersion: number; created: boolean };
  memory: { rssBytes: number };
}

interface CitsparkApi {
  status(): Promise<unknown>;
  request(method: string, payload?: unknown, mutation?: boolean): Promise<unknown>;
  restartCore(): Promise<unknown>;
  onStatus(listener: (s: unknown) => void): () => void;
}

const api = (window as unknown as { citspark: CitsparkApi }).citspark;

function asView(raw: unknown): CoreView {
  const s = raw as { state?: unknown } | null;
  switch (s?.state) {
    case "ready":
    case "starting":
    case "stopped":
    case "restarting":
    case "failed":
      return s as CoreView;
    default:
      return { state: "starting" };
  }
}

const LABELS: Record<CoreView["state"], string> = {
  starting: "Starting the core…",
  ready: "Core ready",
  restarting: "The core stopped unexpectedly. Restarting…",
  failed: "Core not running",
  stopped: "Core stopped",
};

function App() {
  const [view, setView] = useState<CoreView>({ state: "starting" });
  const [details, setDetails] = useState<StatusResult | undefined>();
  const [requestError, setRequestError] = useState<string | undefined>();

  useEffect(() => {
    const off = api.onStatus((s) => {
      setView(asView(s));
      setDetails(undefined);
    });
    void api.status().then((s) => setView(asView(s)));
    return off;
  }, []);

  const check = useCallback(async () => {
    setRequestError(undefined);
    const res = (await api.request("core.status")) as
      { ok: true; result: StatusResult } | { ok: false; error: { message: string } };
    if (res.ok) setDetails(res.result);
    else setRequestError(res.error.message);
  }, []);

  const retry = useCallback(() => {
    setView({ state: "starting" });
    void api.restartCore().then((s) => setView(asView(s)));
  }, []);

  return (
    <>
      <header>
        <h1>Citspark</h1>
        <p className="preview">
          Preview build: not usable yet. Capture, search, sync and client pairing are not wired into
          this app.
        </p>
      </header>
      <main>
        <section aria-labelledby="core-heading">
          <h2 id="core-heading">Core</h2>
          <div
            role="status"
            aria-label="Core status"
            data-core-state={view.state}
            className="status"
          >
            {LABELS[view.state]}
          </div>
          {view.state === "failed" && (
            <>
              <p role="alert" className="error">
                {view.message}
              </p>
              <Button onPress={retry}>Try again</Button>
            </>
          )}
          {view.state === "ready" && (
            <Button onPress={() => void check()}>Check core status</Button>
          )}
          {requestError && (
            <p role="alert" className="error">
              {requestError}
            </p>
          )}
          {view.state === "ready" && details && (
            <section aria-label="Core details" className="details">
              <dl>
                <dt>Core version</dt>
                <dd>{details.core.version}</dd>
                <dt>Core process</dt>
                <dd data-testid="core-pid">{details.core.pid}</dd>
                <dt>Protocol version</dt>
                <dd>{details.protocol.version}</dd>
                <dt>Library schema version</dt>
                <dd>{details.library.schemaVersion}</dd>
                <dt>Core memory (resident)</dt>
                <dd>{(details.memory.rssBytes / (1024 * 1024)).toFixed(0)} MB</dd>
              </dl>
            </section>
          )}
        </section>
      </main>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
