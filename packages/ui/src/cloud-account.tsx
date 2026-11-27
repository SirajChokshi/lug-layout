import type {
  AccountWorld,
  CloudView,
  EditorSnapshot,
  ICloudWorlds,
  IEditor,
  WorldVersion,
} from "@brr/client";
import { useCallback, useEffect, useState, useSyncExternalStore, type FormEvent } from "react";

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const savedAt = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });
const NO_SUBSCRIPTION = (): (() => void) => () => undefined;

export function useCloudView(cloud: ICloudWorlds | null): CloudView | null {
  return useSyncExternalStore(
    cloud === null ? NO_SUBSCRIPTION : (listener) => cloud.subscribe(listener),
    () => cloud?.view() ?? null,
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function syncText(view: CloudView): string {
  const waiting = view.waiting > 0 ? ` · ${integer.format(view.waiting)} waiting` : "";
  switch (view.sync) {
    case "syncing":
      return "Syncing…";
    case "offline":
      return `Offline${waiting}`;
    case "failed":
      return `Sync failed${waiting}`;
    case "idle":
      return view.waiting > 0 ? `${integer.format(view.waiting)} waiting to sync` : "Synced";
    default: {
      const unhandled: never = view.sync;
      throw new Error(`unhandled ${String(unhandled)}`);
    }
  }
}

function SignInForm({ cloud, view }: { readonly cloud: ICloudWorlds; readonly view: CloudView }) {
  const [email, setEmail] = useState("");
  const sending = view.signIn === "sending";
  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void cloud.sendSignInLink(email);
  };
  return (
    <form className="world-new" onSubmit={onSubmit}>
      <input
        type="email"
        value={email}
        placeholder="you@example.com"
        aria-label="Email address for a sign-in link"
        disabled={sending}
        onChange={(event) => setEmail(event.currentTarget.value)}
      />
      <button type="submit" disabled={sending || email.trim() === ""}>
        {sending ? "Sending…" : "Email link"}
      </button>
    </form>
  );
}

function AccountWorldRow({
  cloud,
  editor,
  item,
  disabled,
}: {
  readonly cloud: ICloudWorlds;
  readonly editor: IEditor;
  readonly item: AccountWorld;
  readonly disabled: boolean;
}) {
  const onDelete = (): void => {
    if (window.confirm(`Delete "${item.name}" and all its versions from your account?`)) {
      void cloud.deleteAccountWorld(item.id);
    }
  };
  return (
    <li className="world-row" data-account-world={item.id}>
      <span className="world-row-name">
        {item.name} <span>({savedAt.format(item.savedAt)})</span>
      </span>
      <button type="button" disabled={disabled} onClick={() => void editor.openWorld(item.id)}>
        Open
      </button>
      <button type="button" onClick={onDelete}>
        Delete
      </button>
    </li>
  );
}

function VersionList({
  cloud,
  editor,
  worldId,
  name,
  view,
  disabled,
}: {
  readonly cloud: ICloudWorlds;
  readonly editor: IEditor;
  readonly worldId: string;
  readonly name: string;
  readonly view: CloudView;
  readonly disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<ReadonlyArray<WorldVersion> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(
    () =>
      cloud.versions(worldId).then(
        (listed) => {
          setVersions(listed);
          setError(null);
        },
        (failure: unknown) => setError(errorText(failure)),
      ),
    [cloud, worldId],
  );
  useEffect(() => {
    if (open && view.sync === "idle") void load();
  }, [open, view.sync, load]);
  const onRestore = (version: WorldVersion): void => {
    if (
      window.confirm(
        `Restore "${name}" to version ${version.version}? The current state is kept as a version first.`,
      )
    ) {
      void editor.restoreVersion(version.version).then(load);
    }
  };
  return (
    <details className="cloud-versions" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Versions</summary>
      {versions !== null && versions.length === 0 && (
        <p className="world-note">No versions yet: this world syncs after its next edit.</p>
      )}
      {versions !== null && versions.length > 0 && (
        <ul className="world-list">
          {versions.map((version) => (
            <li className="world-row" key={version.version} data-version={version.version}>
              <span className="world-row-name">
                v{version.version}{" "}
                <span>
                  {savedAt.format(version.savedAt)} ·{" "}
                  {integer.format(version.placements + version.track)} pieces
                  {version.onThisDevice ? " · this device" : ""}
                </span>
              </span>
              <button type="button" disabled={disabled} onClick={() => onRestore(version)}>
                Restore
              </button>
            </li>
          ))}
        </ul>
      )}
      {error !== null && <p className="error">{error}</p>}
    </details>
  );
}

export function CloudAccount({
  cloud,
  view,
  editor,
  snapshot,
}: {
  readonly cloud: ICloudWorlds;
  readonly view: CloudView;
  readonly editor: IEditor;
  readonly snapshot: EditorSnapshot;
}) {
  const { world } = snapshot;
  const ready = snapshot.status === "ready" && world !== null && snapshot.storageError === null;
  const signedIn = view.signIn === "signed-in";
  return (
    <section
      className="cloud-account"
      aria-label="Account"
      data-sign-in={view.signIn}
      data-sync={view.sync}
    >
      {signedIn ? (
        <>
          <p className="cloud-status">
            <strong>{view.email}</strong>
            <span>{syncText(view)}</span>
          </p>
          <div className="world-actions">
            <button
              type="button"
              disabled={view.sync === "syncing"}
              onClick={() => void cloud.syncNow()}
            >
              Sync now
            </button>
            <button type="button" onClick={() => void cloud.signOut()}>
              Sign out
            </button>
          </div>
          {view.accountWorlds.length > 0 && (
            <>
              <p className="world-note">In your account, not on this device:</p>
              <ul className="world-list">
                {view.accountWorlds.map((item) => (
                  <AccountWorldRow
                    key={item.id}
                    cloud={cloud}
                    editor={editor}
                    item={item}
                    disabled={!ready}
                  />
                ))}
              </ul>
            </>
          )}
          {world !== null && world.id !== null && (
            <VersionList
              key={world.id}
              cloud={cloud}
              editor={editor}
              worldId={world.id}
              name={world.name}
              view={view}
              disabled={!ready || snapshot.readOnly}
            />
          )}
        </>
      ) : (
        <>
          <p className="world-note">
            {view.signIn === "link-sent"
              ? `A sign-in link is on its way to ${view.email ?? ""}. Open it in this browser within 15 minutes.`
              : view.signIn === "signing-in"
                ? "Signing in…"
                : "Sign in to keep your worlds and their versions in your account and open them on any device."}
          </p>
          {view.signIn !== "signing-in" && (
            <div className="world-actions">
              <SignInForm cloud={cloud} view={view} />
            </div>
          )}
        </>
      )}
      {view.sync === "failed" && view.syncError !== null && (
        <p className="error">{view.syncError}</p>
      )}
      {view.notice !== null && <p className="world-warning">{view.notice}</p>}
      {view.error !== null && <p className="error">{view.error}</p>}
    </section>
  );
}
