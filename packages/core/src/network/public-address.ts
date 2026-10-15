import ipaddr from "ipaddr.js";

const IPV4_COMPATIBLE_IPV6_RANGE = ipaddr.parseCIDR("::/96");
const GLOBAL_UNICAST_IPV6_RANGE = ipaddr.parseCIDR("2000::/3");

// True for an IP address on the public internet: not private, loopback,
// link-local, reserved, or an IPv6 form that embeds one of those.
export function addressIsPublic(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  const parsed = ipaddr.parse(address);
  if (
    parsed.kind() === "ipv6" &&
    (parsed.match(IPV4_COMPATIBLE_IPV6_RANGE) ||
      !parsed.match(GLOBAL_UNICAST_IPV6_RANGE))
  ) {
    return false;
  }
  return parsed.range() === "unicast";
}

export function localHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local")
  );
}
