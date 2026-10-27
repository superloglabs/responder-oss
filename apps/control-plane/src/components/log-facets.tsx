import { ExplorerFacets, type PrimaryFacetProps } from "./explorer-facets";
import type { ComponentProps } from "react";

type LogFacetsProps = Omit<ComponentProps<typeof ExplorerFacets>, "label" | "scopes"> & {
  services: Omit<PrimaryFacetProps, "title">;
  levels: Omit<PrimaryFacetProps, "title">;
};

export function LogFacets({ services, levels, ...props }: LogFacetsProps) {
  return (
    <ExplorerFacets
      {...props}
      label="Log filters"
      scopes={[
        { title: "Resource attributes", prefix: "resource.", primary: [{ title: "Service", ...services }] },
        { title: "Log attributes", prefix: "log.", primary: [{ title: "Level", ...levels }] },
      ]}
    />
  );
}
