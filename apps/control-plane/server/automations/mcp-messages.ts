// Streamable HTTP servers answer with JSON or with a server-sent event stream
// that carries the JSON-RPC messages. Media types are case-insensitive, and
// SSE lines may end with CRLF, LF, or CR.
export function rpcMessages(text: string, contentType: string): unknown[] {
  if (!contentType.toLowerCase().includes("text/event-stream")) return [JSON.parse(text)];
  const lines = text.split(/\r\n|\r|\n/u);
  const messages: unknown[] = [];
  let data: string[] = [];
  for (const line of [...lines, ""]) {
    if (line === "") {
      if (data.length) messages.push(JSON.parse(data.join("\n")));
      data = [];
    } else if (line.startsWith("data:")) {
      data.push(line.slice(5).replace(/^ /u, ""));
    }
  }
  return messages;
}
