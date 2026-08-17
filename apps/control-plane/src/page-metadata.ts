export interface SeoMetaTag {
  attribute: "name" | "property";
  content: string;
  key: string;
}

export interface SeoMetadata {
  canonicalUrl: string;
  description: string;
  jsonLd: Record<string, unknown> | Record<string, unknown>[];
  meta: SeoMetaTag[];
  title: string;
}
