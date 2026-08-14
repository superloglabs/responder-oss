import { renderToString } from "react-dom/server";
import { StaticRouter } from "react-router-dom";
import { App } from "./app";
import { editionSeoMetadataForPath } from "./edition-metadata";

export { editionSeoMetadataForPath };

export function renderPublicRoute(pathname: string) {
  return renderToString(
    <StaticRouter location={pathname}>
      <App />
    </StaticRouter>,
  );
}
