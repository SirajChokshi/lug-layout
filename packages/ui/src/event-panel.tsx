import {
  EVENT_COMMENT_MAX_LENGTH,
  EVENT_FIELDS,
  EVENT_LABEL_MAX_LENGTH,
  STUDS_PER_MODULE,
  eventDraft,
  sizeMeasures,
  type EventDraft,
  type EventField,
  type EventFieldIssue,
  type IEventDetails,
  type ILayoutSize,
  type SizeUnit,
} from "@brr/client";
import type { EventRecordV2 } from "@brr/schema/world";
import { useId, useState, useSyncExternalStore, type FormEvent } from "react";

type FieldInput = "text" | "date" | "comment";

interface FieldSpec {
  readonly field: EventField;
  readonly label: string;
  readonly input: FieldInput;
}

const FIELD_SPECS: Readonly<Record<EventField, FieldSpec>> = {
  title: { field: "title", label: "Title", input: "text" },
  author: { field: "author", label: "Author", input: "text" },
  club: { field: "club", label: "Club", input: "text" },
  event: { field: "event", label: "Event", input: "text" },
  venue: { field: "venue", label: "Venue", input: "text" },
  startDate: { field: "startDate", label: "Start date", input: "date" },
  endDate: { field: "endDate", label: "End date", input: "date" },
  comment: { field: "comment", label: "Comment", input: "comment" },
};

const UNIT_LABELS: Readonly<Record<SizeUnit, string>> = {
  studs: "Studs",
  modules: `Modules (${STUDS_PER_MODULE} studs)`,
  metres: "Metres",
  feet: "Feet",
};

interface Editing {
  readonly base: EventRecordV2 | null;
  readonly draft: EventDraft;
}

function useStoredEvent(events: IEventDetails): EventRecordV2 | null {
  return useSyncExternalStore(
    (listener) => events.subscribe(listener),
    () => events.event(),
  );
}

function sameDraft(a: EventDraft, b: EventDraft): boolean {
  return EVENT_FIELDS.every((field) => a[field] === b[field]);
}

function glance(event: EventRecordV2 | null): string {
  return event?.title ?? event?.event ?? "Not set";
}

function EventInput({
  spec,
  value,
  issue,
  disabled,
  onChange,
}: {
  readonly spec: FieldSpec;
  readonly value: string;
  readonly issue: EventFieldIssue | undefined;
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
}) {
  const issueId = useId();
  const shared = {
    value,
    disabled,
    "aria-invalid": issue !== undefined,
    "aria-describedby": issue ? issueId : undefined,
    "data-field": spec.field,
  };
  return (
    <div className={`event-field event-field-${spec.input}`}>
      <label>
        <span className="event-field-label">{spec.label}</span>
        {spec.input === "comment" ? (
          <textarea
            {...shared}
            rows={3}
            maxLength={EVENT_COMMENT_MAX_LENGTH}
            onChange={(event) => onChange(event.currentTarget.value)}
          />
        ) : (
          <input
            {...shared}
            type={spec.input}
            maxLength={EVENT_LABEL_MAX_LENGTH}
            onChange={(event) => onChange(event.currentTarget.value)}
          />
        )}
      </label>
      {issue && (
        <span id={issueId} className="event-field-issue" role="alert">
          {spec.label} {issue.message}.
        </span>
      )}
    </div>
  );
}

function EventForm({
  events,
  editable,
}: {
  readonly events: IEventDetails;
  readonly editable: boolean;
}) {
  const stored = useStoredEvent(events);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [refused, setRefused] = useState(false);
  const storedDraft = eventDraft(stored);
  const draft = editing !== null && editing.base === stored ? editing.draft : storedDraft;
  const changed = !sameDraft(draft, storedDraft);
  const issues = changed ? events.issues(draft) : [];
  const issueOf = (field: EventField) => issues.find((issue) => issue.field === field);

  const onChange = (field: EventField, value: string): void => {
    setRefused(false);
    setEditing({ base: stored, draft: { ...draft, [field]: value } });
  };
  const onApply = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const result = events.edit(draft);
    switch (result.kind) {
      case "recorded":
      case "unchanged":
        setEditing(null);
        return;
      case "refused":
        setRefused(true);
        return;
      case "invalid":
        return;
      default: {
        const unhandled: never = result;
        throw new Error(`unhandled event edit ${JSON.stringify(unhandled)}`);
      }
    }
  };

  return (
    <form className="event-form" aria-label="Event details" onSubmit={onApply}>
      {EVENT_FIELDS.map((field) => (
        <EventInput
          key={field}
          spec={FIELD_SPECS[field]}
          value={draft[field]}
          issue={issueOf(field)}
          disabled={!editable}
          onChange={(value) => onChange(field, value)}
        />
      ))}
      {refused && (
        <p className="event-refused" role="alert">
          The details weren't saved: this world is read-only here.
        </p>
      )}
      <div className="event-actions">
        <button type="button" disabled={!changed} onClick={() => setEditing(null)}>
          Reset
        </button>
        <button
          type="submit"
          className="event-apply"
          disabled={!editable || !changed || issues.length > 0}
        >
          Apply
        </button>
      </div>
    </form>
  );
}

function LayoutSizeTable({ meter }: { readonly meter: ILayoutSize }) {
  const size = useSyncExternalStore(
    (listener) => meter.subscribe(listener),
    () => meter.size(),
  );
  switch (size.kind) {
    case "empty":
      return (
        <p className="event-size-note" data-size="empty">
          Nothing placed yet.
        </p>
      );
    case "unmeasured":
      return (
        <p className="event-size-note" data-size="unmeasured">
          The size can't be measured: a placement has no readable box.
        </p>
      );
    case "measured":
      return (
        <table className="event-size" data-size="measured">
          <caption>Every placed model, baseplate and track piece, width × depth</caption>
          <tbody>
            {sizeMeasures(size.widthLdu, size.depthLdu).map(({ unit, width, depth }) => (
              <tr key={unit} data-unit={unit}>
                <th scope="row">{UNIT_LABELS[unit]}</th>
                <td>
                  {width} × {depth}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    default: {
      const unhandled: never = size;
      throw new Error(`unhandled layout size ${JSON.stringify(unhandled)}`);
    }
  }
}

export function EventPanel({
  events,
  size,
  editable,
}: {
  readonly events: IEventDetails;
  readonly size: ILayoutSize;
  readonly editable: boolean;
}) {
  const stored = useStoredEvent(events);
  const [open, setOpen] = useState(false);
  return (
    <details
      className="event-panel"
      aria-label="Event"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary title={open ? "Fold the event away" : "Event details and layout size"}>
        <h2>Event</h2>
        <span className="event-glance">{glance(stored)}</span>
      </summary>
      {open && (
        <>
          <EventForm events={events} editable={editable} />
          <h3>Size</h3>
          <LayoutSizeTable meter={size} />
        </>
      )}
    </details>
  );
}
