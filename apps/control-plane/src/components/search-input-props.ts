// Props for search boxes inside popovers. Password managers such as 1Password
// otherwise treat them as form fields and open an inline menu that takes
// focus, which closes the popover.
export const searchInputProps = {
  autoComplete: "off",
  "data-1p-ignore": "true",
  "data-bwignore": "true",
  "data-form-type": "other",
  "data-lpignore": "true",
} as const;
