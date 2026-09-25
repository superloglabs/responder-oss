// Props for search boxes inside popovers. They ask password managers not to
// offer to fill the field; not every version honors them, so popovers also
// ignore focus that moves into a password manager menu.
export const searchInputProps = {
  autoComplete: "off",
  "data-1p-ignore": "true",
  "data-bwignore": "true",
  "data-form-type": "other",
  "data-lpignore": "true",
} as const;
