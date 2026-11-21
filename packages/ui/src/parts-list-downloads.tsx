import type { BomFiles } from "@brr/client";

interface Download {
  readonly label: string;
  readonly suffix: string;
  readonly type: string;
  readonly body: (files: BomFiles) => string;
}

const DOWNLOADS: ReadonlyArray<Download> = [
  {
    label: "Rebrickable CSV",
    suffix: "rebrickable.csv",
    type: "text/csv",
    body: (files) => files.rebrickableCsv,
  },
  {
    label: "BrickLink XML",
    suffix: "bricklink.xml",
    type: "application/xml",
    body: (files) => files.brickLinkXml,
  },
  { label: "Plain CSV", suffix: "parts.csv", type: "text/csv", body: (files) => files.plainCsv },
];

function save(files: BomFiles, stem: string, download: Download): void {
  const url = URL.createObjectURL(new Blob([download.body(files)], { type: download.type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${stem}.${download.suffix}`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function PartsListDownloads({
  title,
  files,
  stem,
}: {
  readonly title: string;
  readonly files: BomFiles;
  readonly stem: string;
}) {
  return (
    <div className="bom-downloads" role="group" aria-label={title}>
      <span>{title}:</span>
      {DOWNLOADS.map((download) => (
        <button key={download.suffix} type="button" onClick={() => save(files, stem, download)}>
          {download.label}
        </button>
      ))}
    </div>
  );
}
