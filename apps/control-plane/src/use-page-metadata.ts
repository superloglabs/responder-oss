import { useEffect } from "react";
import type { SeoMetadata } from "./page-metadata";

const ownedSelector = "[data-responder-seo]";
const shellTitle = "Responder";

function removeOwnedMetadata() {
  document.head.querySelectorAll(ownedSelector).forEach((element) => element.remove());
}

function resetPageMetadata() {
  removeOwnedMetadata();
  document.title = shellTitle;
}

export function usePageMetadata(metadata: SeoMetadata | undefined) {
  useEffect(() => {
    resetPageMetadata();
    if (!metadata) return;

    document.title = metadata.title;

    for (const tag of metadata.meta) {
      Array.from(document.head.querySelectorAll("meta"))
        .find(
          (element) =>
            !element.matches(ownedSelector) &&
            element.getAttribute(tag.attribute) === tag.key,
        )
        ?.remove();
      const element = document.createElement("meta");
      element.dataset.responderSeo = "";
      element.setAttribute(tag.attribute, tag.key);
      element.content = tag.content;
      document.head.append(element);
    }

    const canonical = document.createElement("link");
    canonical.dataset.responderSeo = "";
    canonical.href = metadata.canonicalUrl;
    canonical.rel = "canonical";
    document.head.append(canonical);

    const structuredData = document.createElement("script");
    structuredData.dataset.responderSeo = "";
    structuredData.type = "application/ld+json";
    structuredData.text = JSON.stringify(metadata.jsonLd);
    document.head.append(structuredData);

    return resetPageMetadata;
  }, [metadata]);
}
