import type { IStarterWorlds, StarterWorldView, WelcomeView } from "@brr/client";
import { useEffect, useRef } from "react";
import { shortcutText } from "./keys.tsx";

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function plural(count: number, one: string, many: string): string {
  return `${integer.format(count)} ${count === 1 ? one : many}`;
}

function contentsText(starter: StarterWorldView): string {
  const placements = plural(starter.placements, "placement", "placements");
  return starter.track > 0
    ? `${placements} · ${plural(starter.track, "track piece", "track pieces")}`
    : placements;
}

function StarterButton({
  starters,
  starter,
  view,
}: {
  readonly starters: IStarterWorlds;
  readonly starter: StarterWorldView;
  readonly view: WelcomeView;
}) {
  const opening = view.opening === starter.id;
  return (
    <li>
      <button
        type="button"
        className="starter"
        data-starter={starter.id}
        disabled={view.opening !== null}
        aria-busy={opening}
        onClick={() => void starters.open(starter.id)}
      >
        <strong className="starter-name">{starter.name}</strong>
        <span className="starter-summary">{starter.summary}</span>
        <span className="starter-meta">{opening ? "Opening…" : contentsText(starter)}</span>
      </button>
    </li>
  );
}

export function WelcomeCard({
  starters,
  view,
}: {
  readonly starters: IStarterWorlds;
  readonly view: WelcomeView;
}) {
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => dialog.current?.focus(), []);
  const reading = view.shelf === "unread" || view.shelf === "reading";
  return (
    <div
      className="overlay"
      onPointerDown={(event) => event.target === event.currentTarget && starters.dismiss()}
    >
      <section
        ref={dialog}
        className="welcome"
        role="dialog"
        aria-modal="true"
        aria-labelledby="welcome-title"
        tabIndex={-1}
        data-shelf={view.shelf}
        data-opening={view.opening ?? ""}
      >
        <h2 id="welcome-title">Start a layout</h2>
        <p className="welcome-intro">
          Open a starter world and have a train running in under a minute. Each one opens as a new
          world of your own, built from real parts, so you can change anything in it.
        </p>
        {reading && <p className="welcome-note">Loading the starter worlds…</p>}
        <ul className="starter-list">
          {view.starters.map((starter) => (
            <StarterButton key={starter.id} starters={starters} starter={starter} view={view} />
          ))}
        </ul>
        {view.error !== null && (
          <p className="error" role="alert">
            {view.error}
          </p>
        )}
        <button
          type="button"
          className="overlay-close welcome-empty"
          data-action="start-empty"
          onClick={() => starters.dismiss()}
        >
          Start with an empty table <kbd>{shortcutText("select-tool")}</kbd>
        </button>
      </section>
    </div>
  );
}
