import {
  chordKeys,
  chordText,
  commandSpec,
  isHotbarCommand,
  keyPlatform,
  type CommandId,
  type KeyChord,
} from "@brr/client";

export const PLATFORM = keyPlatform(navigator.userAgent);

export function Chord({ chord }: { readonly chord: KeyChord }) {
  return (
    <span className="chord">
      {chordKeys(chord, PLATFORM).map((key) => (
        <kbd key={key}>{key}</kbd>
      ))}
    </span>
  );
}

export function CommandKeys({ id }: { readonly id: CommandId }) {
  const { keys } = commandSpec(id);
  const first = keys[0];
  const last = keys.at(-1);
  if (isHotbarCommand(id) && first && last) {
    return (
      <span className="command-keys">
        <Chord chord={first} />
        <span className="chord-or">to</span>
        <Chord chord={last} />
      </span>
    );
  }
  return (
    <span className="command-keys">
      {keys.map((chord, index) => (
        <span key={chordText(chord, PLATFORM)}>
          {index > 0 && <span className="chord-or">or</span>}
          <Chord chord={chord} />
        </span>
      ))}
    </span>
  );
}

export function shortcutText(id: CommandId): string {
  const [first] = commandSpec(id).keys;
  return first ? chordText(first, PLATFORM) : "";
}

export function FirstChord({ id }: { readonly id: CommandId }) {
  const [first] = commandSpec(id).keys;
  return first ? <Chord chord={first} /> : null;
}
