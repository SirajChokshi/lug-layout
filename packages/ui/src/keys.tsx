import {
  chordKeys,
  chordText,
  commandSpec,
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
