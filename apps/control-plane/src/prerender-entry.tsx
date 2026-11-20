import { renderToString } from "react-dom/server";
import { StaticRouter } from "react-router-dom";
import { Application } from "./application";
import { editionSeoMetadataForPath } from "./edition-metadata";
import { notFoundDocument, publicDocumentRoutes } from "./public-routes";

export { editionSeoMetadataForPath, notFoundDocument, publicDocumentRoutes };

export function renderPublicRoute(pathname: string) {
  return renderToString(
    <StaticRouter location={pathname}>
      <Application landingSearch="" />
    </StaticRouter>,
  );
}
