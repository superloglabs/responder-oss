export function isSourceMapPath(pathname: string) {
  return pathname.toLowerCase().endsWith(".map");
}
