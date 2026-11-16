import type { CreditsView, ICredits } from "@brr/client";
import { useEffect, useState } from "react";

export type CreditsState =
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly view: CreditsView }
  | { readonly kind: "failed"; readonly message: string };

export function useCredits(credits: ICredits): CreditsState {
  const [state, setState] = useState<CreditsState>({ kind: "loading" });
  useEffect(() => {
    let current = true;
    credits.load().then(
      (view) => current && setState({ kind: "loaded", view }),
      (error: unknown) => current && setState({ kind: "failed", message: String(error) }),
    );
    return () => {
      current = false;
    };
  }, [credits]);
  return state;
}
