import {
  licenseText,
  setTitle,
  sourceText,
  type CreditsView,
  type ICredits,
  type LicenseGroup,
} from "@brr/client";
import { LoadingOrError, SitePage } from "./site-chrome.tsx";
import { useCredits } from "./use-credits.ts";

const CREDITS_FILE_NAME = "CREDITS.txt";
const integer = new Intl.NumberFormat("en-US");

function counted(count: number, singular: string, plural: string): string {
  return `${integer.format(count)} ${count === 1 ? singular : plural}`;
}

interface CreditsPageProps {
  readonly credits: ICredits;
  readonly disclaimer: string;
}

function downloadCreditsText(credits: ICredits, view: CreditsView): void {
  const blob = new Blob([credits.exportText(view)], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = CREDITS_FILE_NAME;
  link.click();
  URL.revokeObjectURL(url);
}

function CountsTable({ view }: { readonly view: CreditsView }) {
  const { counts } = view;
  return (
    <table
      id="credit-counts"
      className="counts"
      data-bundle-part-files={counts.bundlePartFiles}
      data-credited-part-files={counts.creditedPartFiles}
      data-credited-ldraw-files={counts.creditedLdrawFiles}
      data-bundled-omr-models={counts.bundledOmrModels}
      data-credited-omr-models={counts.creditedOmrModels}
    >
      <thead>
        <tr>
          <th />
          <th>In the bundle</th>
          <th>Credited</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <th>Compiled LDraw part files (all levels of detail)</th>
          <td>{integer.format(counts.bundlePartFiles)}</td>
          <td>{integer.format(counts.creditedPartFiles)}</td>
        </tr>
        <tr>
          <th>OMR models</th>
          <td>{integer.format(counts.bundledOmrModels)}</td>
          <td>{integer.format(counts.creditedOmrModels)}</td>
        </tr>
        <tr>
          <th>LDraw files credited, including sub-files, primitives and LDConfig.ldr</th>
          <td />
          <td>{integer.format(counts.creditedLdrawFiles)}</td>
        </tr>
      </tbody>
    </table>
  );
}

function LicenseSection({ group }: { readonly group: LicenseGroup }) {
  const license = licenseText(group.license);
  return (
    <section className="license-group" data-license={license}>
      <h3>
        {license}{" "}
        <span className="muted">
          {counted(group.files.length, "file", "files")},{" "}
          {counted(group.authors.length, "author", "authors")}
        </span>
      </h3>
      <ul className="authors">
        {group.authors.map((author) => (
          <li key={author.name} data-credit-author={author.name}>
            {author.name} <span className="muted">{integer.format(author.files)}</span>
          </li>
        ))}
      </ul>
      <details>
        <summary>
          {group.files.length === 1
            ? "The file"
            : `All ${counted(group.files.length, "file", "files")}`}
        </summary>
        <table className="files">
          <tbody>
            {group.files.map((file) => (
              <tr key={file.path} data-credit-file={file.path}>
                <td>
                  <code>{file.path}</code>
                </td>
                <td>{file.title}</td>
                <td>{file.author}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}

function Credits({ credits, view }: { readonly credits: ICredits; readonly view: CreditsView }) {
  return (
    <>
      <p className="lead">
        Everything below is read from the asset bundle manifests this site serves (
        {view.builds.map((build) => `${build.lod} ${build.bundleVersion}`).join(", ")}).{" "}
        <button type="button" onClick={() => downloadCreditsText(credits, view)}>
          Download {CREDITS_FILE_NAME}
        </button>
      </p>
      <CountsTable view={view} />

      <h2>LDraw parts library</h2>
      <p>
        Parts come from the <a href="https://www.ldraw.org/">LDraw</a> parts library, fetched from{" "}
        {sourceText(view.ldrawSource)}. LDraw parts are copyright their authors and are
        redistributed under the license named in each file's <code>!LICENSE</code> header.
      </p>
      <ul className="modified">
        {view.builds.map((build) => (
          <li key={build.lod}>
            <strong>{build.lod}:</strong> {build.modified}
          </li>
        ))}
      </ul>
      {view.licenses.map((group) => (
        <LicenseSection key={licenseText(group.license)} group={group} />
      ))}

      <h2>LDraw Official Model Repository models</h2>
      <p>
        Models from the <a href="https://library.ldraw.org/omr">LDraw OMR</a>, fetched from{" "}
        {sourceText(view.omrSource)}. Each is flattened into part instances at bake time.
      </p>
      <table className="sets">
        <thead>
          <tr>
            <th>Set</th>
            <th>Authors</th>
            <th>License</th>
            <th>Submodels</th>
            <th>Part instances</th>
            <th>Inline part copies replaced by the official part</th>
            <th>Modified from OMR</th>
          </tr>
        </thead>
        <tbody>
          {view.sets.map((set) => (
            <tr key={set.name} data-credit-set={set.name}>
              <td>
                <a href={set.source}>{setTitle(set)}</a>
              </td>
              <td>{set.authors.join("; ")}</td>
              <td>{set.licenses.join("; ")}</td>
              <td>{integer.format(set.sections)}</td>
              <td>{integer.format(set.instances)}</td>
              <td>{integer.format(set.inlinePartsResolved)}</td>
              <td>
                {set.errata.map((erratum) => (
                  <details key={erratum.line} className="erratum">
                    <summary>
                      Line {erratum.line}: <code>{erratum.from}</code> → <code>{erratum.to}</code>
                    </summary>
                    {erratum.summary}
                  </details>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {view.generated.length > 0 && (
        <>
          <h2>Generated scenes</h2>
          <ul>
            {view.generated.map((scene) => (
              <li key={scene.name}>
                <code>{scene.name}</code>: {scene.authors.join("; ")}. {scene.source}
              </li>
            ))}
          </ul>
        </>
      )}

      <h2>Set and colour data</h2>
      <ul className="data-sources">
        {view.dataSources.map((data) => (
          <li key={data.source}>
            {data.source}
            <div className="muted">Used for: {data.usedFor.join(", ")}</div>
          </li>
        ))}
      </ul>
    </>
  );
}

export function CreditsPage({ credits, disclaimer }: CreditsPageProps) {
  const state = useCredits(credits);
  return (
    <SitePage title="Credits" disclaimer={disclaimer}>
      <LoadingOrError state={state} />
      {state.kind === "loaded" && <Credits credits={credits} view={state.view} />}
    </SitePage>
  );
}
