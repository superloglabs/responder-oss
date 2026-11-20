import type { SeoMetadata } from "./page-metadata";

export function editionSeoMetadataForPath(
  pathname: string,
): SeoMetadata | undefined {
  void pathname;
  return undefined;
}

// Public pages the edition adds. The build writes each one as a complete HTML
// document, and the hosting layer serves those documents by path.
export const editionPublicDocumentPathnames: readonly string[] = [];
