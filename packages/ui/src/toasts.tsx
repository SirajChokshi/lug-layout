import type { INotices, Notice } from "@brr/client";
import { useEffect, useSyncExternalStore } from "react";

const NOTE_SHOWN_MS = 8000;

function NoticeToast({ notice, notices }: { readonly notice: Notice; readonly notices: INotices }) {
  const { id, tone } = notice;
  useEffect(() => {
    if (tone !== "note") return undefined;
    const timer = window.setTimeout(() => notices.dismiss(id), NOTE_SHOWN_MS);
    return () => window.clearTimeout(timer);
  }, [notices, id, tone]);
  return (
    <div
      className="toast"
      data-tone={tone}
      role={tone === "warn" || tone === "error" ? "alert" : "status"}
    >
      <p>{notice.text}</p>
      <button
        type="button"
        className="toast-dismiss"
        aria-label="Dismiss"
        title="Dismiss"
        onClick={() => notices.dismiss(id)}
      >
        ×
      </button>
    </div>
  );
}

export function Toasts({ notices }: { readonly notices: INotices }) {
  const shown = useSyncExternalStore(
    (listener) => notices.subscribe(listener),
    () => notices.notices(),
  );
  if (shown.length === 0) return null;
  return (
    <section className="toasts" aria-label="Notices">
      {shown.map((notice) => (
        <NoticeToast key={notice.id} notice={notice} notices={notices} />
      ))}
    </section>
  );
}
