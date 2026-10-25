"use client";
// The demo starting in this browser (stage 8). The first visit waits a few
// seconds while the sandbox's worker opens the database, loads Python and
// starts the engine; this bar shows the worker's own steps as they come, and
// goes once the demo is ready. The page is there meanwhile: what needs no
// figure (the records, the sessions) reads at once, and the rest fills in.
// If the browser cannot run the demo, or the worker fails, it says so and
// what to do. A tab whose worker belongs to another deploy reloads once.
import { Icon } from "design/icon";
import { useEffect, useSyncExternalStore } from "react";
import { copy } from "../../content/copy.ts";
import { useSandbox } from "../../data/provider.tsx";
import type { Sandbox, SandboxStatus as Status } from "../../data/sandbox.ts";

const STARTING: Status = { state: "starting", step: null, done: 0, of: 0 };
const RELOADED = "sandbox-reloaded-for-build";

export function SandboxStatus() {
  const sandbox = useSandbox();
  if (sandbox === null) return null;
  return <Bar sandbox={sandbox} />;
}

function Bar({ sandbox }: { readonly sandbox: Sandbox }) {
  const status = useSyncExternalStore(sandbox.subscribe, sandbox.status, () => STARTING);
  const words = copy.sandbox;

  // Another deploy's worker: reload once to meet it; if the same comes back, say so.
  const otherBuild = status.state === "other-build" ? status.info.build : null;
  let reloadedOnce = false;
  try {
    reloadedOnce = otherBuild !== null && window.sessionStorage.getItem(RELOADED) === otherBuild;
  } catch {
    reloadedOnce = otherBuild !== null;
  }
  useEffect(() => {
    if (otherBuild === null || reloadedOnce) return;
    try {
      window.sessionStorage.setItem(RELOADED, otherBuild);
    } catch {
      return;
    }
    window.location.reload();
  }, [otherBuild, reloadedOnce]);

  if (status.state === "ready" || (status.state === "other-build" && !reloadedOnce)) return null;

  if (status.state === "starting") {
    return (
      <div className="sandbox-bar" role="status" aria-live="polite" data-sandbox="starting">
        <div className="wrap sandbox-bar-row">
          <Icon name="hourglass-medium" size={18} />
          <p className="m-0 grid gap-[0.1rem]">
            <b>{words.starting}</b>
            <span className="text-md text-ink-2">{status.step ?? words.firstVisit}</span>
          </p>
          {status.of > 0 ? (
            <span className="sandbox-meter">
              <progress max={status.of} value={status.done} aria-label={words.starting} />
              <span className="num text-sm text-ink-2">{words.step(status.done, status.of)}</span>
            </span>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="sandbox-bar is-failed" role="alert" data-sandbox="failed">
      <div className="wrap sandbox-bar-row">
        <Icon name="warning-circle" size={20} />
        <div className="grid gap-[0.2rem]">
          <p className="m-0"><b>{words.failedTitle}</b></p>
          <p className="m-0">
            {status.state === "other-build" ? words.otherBuild : status.browser ? words.missing(status.reason) : words.worker(status.reason)}
          </p>
          {status.state === "other-build" ? null : <p className="m-0 text-md text-ink-2">{words.advice}</p>}
        </div>
        <button type="button" className="btn" onClick={() => window.location.reload()}>
          <Icon name="arrows-clockwise" size={16} />
          {words.reload}
        </button>
      </div>
    </div>
  );
}
