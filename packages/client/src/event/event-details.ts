import type { EventChange } from "@brr/domain";
import { decode, type Issue } from "@brr/schema/decode";
import { EventRecordV2, LABEL_MAX_LENGTH, LONG_TEXT_MAX_LENGTH } from "@brr/schema/world";
import { injectable } from "inversify";

export const EVENT_FIELDS = [
  "title",
  "author",
  "club",
  "event",
  "venue",
  "startDate",
  "endDate",
  "comment",
] as const;
export type EventField = (typeof EVENT_FIELDS)[number];
export type EventDraft = Readonly<Record<EventField, string>>;

export const EVENT_LABEL_MAX_LENGTH = LABEL_MAX_LENGTH;
export const EVENT_COMMENT_MAX_LENGTH = LONG_TEXT_MAX_LENGTH;

export interface EventFieldIssue {
  readonly field: EventField;
  readonly message: string;
}

export type EventEdit =
  | { readonly kind: "recorded" }
  | { readonly kind: "unchanged" }
  | { readonly kind: "refused" }
  | { readonly kind: "invalid"; readonly issues: ReadonlyArray<EventFieldIssue> };

export interface IEventDetails {
  subscribe(listener: () => void): () => void;
  event(): EventRecordV2 | null;
  issues(draft: EventDraft): ReadonlyArray<EventFieldIssue>;
  edit(draft: EventDraft): EventEdit;
  onEdit(listener: (change: EventChange) => void): () => void;
  restore(event: EventRecordV2 | null): void;
}

const ISSUE_ROOT = "event";
const RECORDED: EventEdit = { kind: "recorded" };
const UNCHANGED: EventEdit = { kind: "unchanged" };
const REFUSED: EventEdit = { kind: "refused" };

type EventRead =
  | { readonly ok: true; readonly value: EventRecordV2 | null }
  | { readonly ok: false; readonly issues: ReadonlyArray<EventFieldIssue> };

function isEventField(name: string): name is EventField {
  return (EVENT_FIELDS as ReadonlyArray<string>).includes(name);
}

function fieldIssue({ path, message }: Issue): EventFieldIssue {
  const field = path.slice(ISSUE_ROOT.length + 1);
  if (!path.startsWith(`${ISSUE_ROOT}.`) || !isEventField(field)) {
    throw new Error(`the event record has an issue outside its fields: ${path}: ${message}`);
  }
  return { field, message };
}

function filledFields(draft: EventDraft): Partial<Record<EventField, string>> {
  const filled: Partial<Record<EventField, string>> = {};
  for (const field of EVENT_FIELDS) {
    const text = draft[field].trim();
    if (text !== "") filled[field] = text;
  }
  return filled;
}

function readDraft(draft: EventDraft): EventRead {
  const filled = filledFields(draft);
  if (Object.keys(filled).length === 0) return { ok: true, value: null };
  const decoded = decode(EventRecordV2, filled, ISSUE_ROOT);
  return decoded.ok
    ? { ok: true, value: decoded.value }
    : { ok: false, issues: decoded.issues.map(fieldIssue) };
}

function sameEvent(a: EventRecordV2 | null, b: EventRecordV2 | null): boolean {
  if (a === null || b === null) return a === b;
  return EVENT_FIELDS.every((field) => a[field] === b[field]);
}

export function eventDraft(event: EventRecordV2 | null): EventDraft {
  return {
    title: event?.title ?? "",
    author: event?.author ?? "",
    club: event?.club ?? "",
    event: event?.event ?? "",
    venue: event?.venue ?? "",
    startDate: event?.startDate ?? "",
    endDate: event?.endDate ?? "",
    comment: event?.comment ?? "",
  };
}

@injectable()
export class EventDetailsService implements IEventDetails {
  private readonly listeners = new Set<() => void>();
  private readonly editListeners = new Set<(change: EventChange) => void>();
  private current: EventRecordV2 | null = null;

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  event(): EventRecordV2 | null {
    return this.current;
  }

  issues(draft: EventDraft): ReadonlyArray<EventFieldIssue> {
    const read = readDraft(draft);
    return read.ok ? [] : read.issues;
  }

  edit(draft: EventDraft): EventEdit {
    const read = readDraft(draft);
    if (!read.ok) return { kind: "invalid", issues: read.issues };
    const after = read.value;
    if (sameEvent(after, this.current)) return UNCHANGED;
    const change: EventChange = { before: this.current, after };
    for (const listener of this.editListeners) listener(change);
    return this.current === after ? RECORDED : REFUSED;
  }

  onEdit(listener: (change: EventChange) => void): () => void {
    this.editListeners.add(listener);
    return () => this.editListeners.delete(listener);
  }

  restore(event: EventRecordV2 | null): void {
    if (event === this.current) return;
    this.current = event;
    for (const listener of this.listeners) listener();
  }
}
