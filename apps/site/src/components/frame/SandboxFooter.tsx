"use client";
// The foot of every page in the demo's sandbox (stage 8): one line on where
// the data stays and where the full system and its source are, in the same
// words as the console's (design's SANDBOX), and the panel about the sandbox:
// where the data is, how to start over, what it cannot do, what in it is
// simulated and what is the real thing. Start over asks once, then the demo
// goes back to its first data in every tab: the worker tells each tab, and
// each reloads.
import { SANDBOX, SOURCE_URL } from "design";
import { Icon } from "design/icon";
import { useId, useState } from "react";
import { useSandbox } from "../../data/provider.tsx";

export function SandboxFooter() {
  const sandbox = useSandbox();
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  const [starting, setStarting] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const panel = useId();
  if (sandbox === null) return null;
  const about = SANDBOX.about;

  const startOver = async () => {
    setStarting(true);
    setFailed(null);
    try {
      const reply = await sandbox.command("reset");
      // The worker's reset message reloads every tab; this one too, should it come first.
      if (reply.status !== 200) setFailed(reply.body);
    } catch (error) {
      setFailed(error instanceof Error ? error.message : String(error));
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="sandbox-foot">
      <p className="m-0">
        {SANDBOX.line.before}
        <a href={SOURCE_URL} rel="noopener">{SANDBOX.line.link}</a>
        {SANDBOX.line.after}
      </p>
      <p className="m-0">
        <button type="button" className="btn btn-quiet" aria-expanded={open} aria-controls={panel} onClick={() => setOpen((was) => !was)}>
          <Icon name="info" size={16} />
          {about.title}
        </button>
      </p>
      <section id={panel} className="sandbox-about" hidden={!open} aria-label={about.title}>
        <dl>
          {[about.where, about.reset, about.limits, about.simulated, about.real].map((part) => (
            <div key={part.title}>
              <dt>{part.title}</dt>
              <dd>{part.text}</dd>
            </div>
          ))}
        </dl>
        {asking ? (
          <div className="sandbox-confirm" role="group" aria-label={about.startOver}>
            <p className="m-0">{about.confirm}</p>
            <div className="flex flex-wrap gap-3">
              <button type="button" className="btn btn-primary" aria-disabled={starting} onClick={() => starting || void startOver()}>
                <Icon name="arrow-counter-clockwise" size={16} />
                {starting ? about.startingOver : about.confirmAction}
              </button>
              <button type="button" className="btn" onClick={() => setAsking(false)}>{about.keep}</button>
            </div>
            {failed ? <p className="m-0 text-md" role="alert">{failed}</p> : null}
          </div>
        ) : (
          <p className="m-0">
            <button type="button" className="btn" onClick={() => setAsking(true)}>
              <Icon name="arrow-counter-clockwise" size={16} />
              {about.startOver}
            </button>
          </p>
        )}
      </section>
    </div>
  );
}
