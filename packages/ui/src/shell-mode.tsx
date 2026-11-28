import {
  SHELL_MODES,
  commandSpec,
  shellModeOffered,
  type PlaySnapshot,
  type ShellMode,
} from "@brr/client";
import type { ReactNode } from "react";
import type { IconName } from "./icons/glyphs.ts";
import { Icon } from "./icons/icon.tsx";

const MODE_FACES: Readonly<Record<ShellMode, { readonly label: string; readonly icon: IconName }>> =
  {
    build: { label: "Build", icon: "baseplate" },
    plan: { label: "Plan", icon: "plan" },
    play: { label: "Play", icon: "play" },
  };

export function ShellModeSwitch({
  mode,
  play,
  onChoose,
}: {
  readonly mode: ShellMode;
  readonly play: PlaySnapshot;
  readonly onChoose: (mode: ShellMode) => void;
}) {
  return (
    <div className="mode-switch" role="group" aria-label="Mode">
      {SHELL_MODES.map((each) => {
        const command = `${each}-mode` as const;
        const face = MODE_FACES[each];
        return (
          <button
            key={each}
            type="button"
            className="tool-button"
            data-action={command}
            aria-pressed={each === mode}
            disabled={!shellModeOffered(each, play)}
            title={commandSpec(command).title}
            onClick={() => onChoose(each)}
          >
            <Icon name={face.icon} />
            {face.label}
          </button>
        );
      })}
    </div>
  );
}

export function ShellSection({
  modes,
  mode,
  children,
}: {
  readonly modes: ReadonlyArray<ShellMode>;
  readonly mode: ShellMode;
  readonly children: ReactNode;
}) {
  return (
    <div className="shell-section" hidden={!modes.includes(mode)}>
      {children}
    </div>
  );
}
