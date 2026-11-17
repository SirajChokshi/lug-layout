import type { HeightLabel } from "@brr/client";

const NDC_TO_PERCENT = 50;

export function HeightLabels({ labels }: { readonly labels: ReadonlyArray<HeightLabel> }) {
  if (labels.length === 0) return null;
  return (
    <div className="height-labels" aria-label="Track heights" data-labels={labels.length}>
      {labels.map((label) => (
        <div
          key={label.id}
          className={`height-label height-label-${label.tone}`}
          aria-label={label.detail}
          style={{
            left: `${(label.ndcX + 1) * NDC_TO_PERCENT}%`,
            top: `${(1 - label.ndcY) * NDC_TO_PERCENT}%`,
          }}
        >
          {label.text}
        </div>
      ))}
    </div>
  );
}
