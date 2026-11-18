import { sourceText, type CreditsView, type ICredits } from "@brr/client";
import { CREDITS_HREF, LoadingOrError, SitePage } from "./site-chrome.tsx";
import { useCredits } from "./use-credits.ts";

interface AboutPageProps {
  readonly credits: ICredits;
  readonly disclaimer: string;
}

function BundleFacts({ view }: { readonly view: CreditsView }) {
  return (
    <dl className="facts">
      <dt>Parts</dt>
      <dd>LDraw parts library, {sourceText(view.ldrawSource)}</dd>
      <dt>Models</dt>
      <dd>
        {view.sets.length} LDraw Official Model Repository sets, {sourceText(view.omrSource)}
      </dd>
      <dt>Connectors</dt>
      {view.dataPackages.map((data) => (
        <dd key={data.attribution.join("\n")}>
          {data.name}, {data.licenses.join("; ")}: {data.attribution.join("; ")}
        </dd>
      ))}
      <dt>Asset bundle</dt>
      <dd>{view.builds.map((build) => `${build.lod} ${build.bundleVersion}`).join(", ")}</dd>
    </dl>
  );
}

export function AboutPage({ credits, disclaimer }: AboutPageProps) {
  const state = useCredits(credits);
  return (
    <SitePage title="About" disclaimer={disclaimer}>
      <p className="lead">
        Brick Railroad is a non-commercial browser sandbox for planning brick-built city and train
        layouts from real parts. It is in early development.
      </p>
      <h2>Where the parts and models come from</h2>
      <p>
        Every part is compiled from the LDraw parts library, and the starter sets are models from
        the LDraw Official Model Repository. The inputs are pinned by commit and SHA-256 and
        compiled into the asset bundle this site serves. Where parts snap together comes from the
        LDCad Shadow Library, shipped as its own connectivity package under its own license. Set
        names and some part colours come from Rebrickable database exports. The{" "}
        <a href={CREDITS_HREF}>credits page</a> names every author, license and source, and lets you
        download the same list as a text file.
      </p>
      <LoadingOrError state={state} />
      {state.kind === "loaded" && <BundleFacts view={state.view} />}
      <h2>Trademarks</h2>
      <p>{disclaimer}</p>
    </SitePage>
  );
}
