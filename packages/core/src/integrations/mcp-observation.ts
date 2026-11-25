// Names that say a tool changes something. A tool that does not declare
// itself read-only is left out when its name says it writes.
const writeVerb = /(?:^|[_.\-\s])(?:create|update|delete|remove|edit|add|set|put|patch|post|write|mute|unmute|resolve|unresolve|assign|unassign|archive|unarchive|cancel|trigger|restart|redeploy|deploy|rollback|scale|enable|disable|install|uninstall|invite|link|unlink|merge|close|reopen|acknowledge|ack|snooze|silence|start|stop|pause|resume|apply|import|upload|send|notify|execute_sql|apply_migration)(?:$|[_.\-\s])/iu;

// A tool an observer may call: it declares itself read-only, or declares nothing
// and its name does not say it writes. A tool declared destructive or not
// read-only is never allowed.
export function isObservationTool(tool: { annotations?: unknown; name: string }): boolean {
  const annotations = tool.annotations && typeof tool.annotations === "object"
    ? tool.annotations as { destructiveHint?: unknown; readOnlyHint?: unknown }
    : undefined;
  if (annotations?.destructiveHint === true) return false;
  if (annotations?.readOnlyHint === true) return true;
  if (annotations?.readOnlyHint === false) return false;
  // camelCase names, such as createMonitor, are split into words first.
  const words = tool.name.replace(/([a-z0-9])([A-Z])/gu, "$1_$2");
  return !writeVerb.test(words);
}

// A tool that declares itself read-only and not destructive. Servers whose
// tool names are not known, such as custom MCP servers, are held to this:
// a name like refund_order or run_script does not say it writes.
export function isDeclaredReadOnlyTool(tool: { annotations?: unknown }): boolean {
  const annotations = tool.annotations && typeof tool.annotations === "object"
    ? tool.annotations as { destructiveHint?: unknown; readOnlyHint?: unknown }
    : undefined;
  return annotations?.readOnlyHint === true && annotations.destructiveHint !== true;
}
