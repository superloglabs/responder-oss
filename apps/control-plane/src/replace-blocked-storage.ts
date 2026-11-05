import { replaceBlockedStorage } from "./blocked-storage";

// main.tsx imports this module first. Imported modules run in order, so the
// storage is usable before any other module, or the page it renders, reads it.
replaceBlockedStorage(window);
