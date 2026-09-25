import { createContext } from "react";

/**
 * Opens the consent preferences dialog. It is null where no consent manager is
 * mounted, such as during static prerendering.
 */
export const OpenConsentPreferences = createContext<(() => void) | null>(null);
