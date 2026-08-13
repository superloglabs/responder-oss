import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { captureBrowserPageView } from "../browser-analytics";

export function BrowserAnalyticsPageviews() {
  const location = useLocation();

  useEffect(() => {
    const url = new URL(window.location.href);
    url.search = "";
    url.hash = "";
    void captureBrowserPageView(url.toString());
  }, [location.pathname]);

  return null;
}
