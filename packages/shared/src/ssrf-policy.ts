/**
 * The SSRF policy table: addresses every outbound guard must refuse, and routable ones
 * they must allow.
 *
 * A dependency-free leaf so BOTH guards' tests can import the SAME table. The guards
 * themselves can't be shared - they need `node:net`, and this package is bundled into
 * the browser - so they are two implementations of one policy
 * (`apps/control-plane/src/outbound.ts` `isBlockedHost` and
 * `apps/agent-runtime/src/web-tools.ts` `isPrivateAddress`). That drifted once: the
 * IPv6 rewrite reached both, but three IPv4 special-use ranges reached only the
 * control-plane, so a hostname resolving to 224.0.0.1 was refused for an integration
 * and fetched by an agent. Each side asserts this table, so the next divergence fails a
 * test rather than shipping.
 */

/** Addresses both guards must REFUSE. */
export const BLOCKED_ADDRESSES = [
  // IPv4: private, loopback, link-local (incl. cloud metadata), CGNAT.
  "10.1.2.3",
  "127.0.0.1",
  "0.0.0.0",
  "192.168.1.1",
  "169.254.169.254",
  "172.16.0.1",
  "172.31.255.255",
  "100.64.0.1",
  // IPv4: the other IETF special-use ranges (the ones that drifted).
  "192.0.0.192",
  "198.18.0.1",
  "198.19.255.255",
  "224.0.0.1",
  "240.0.0.1",
  "255.255.255.255",
  // IPv6: loopback, unspecified, unique-local, link-local.
  "::1",
  "::",
  "fc00::1",
  "fd12:3456::1",
  "fe80::1",
  // Every spelling of an embedded IPv4 - the bypass class this table exists for.
  "::ffff:127.0.0.1",
  "::ffff:7f00:1",
  "::ffff:a9fe:a9fe",
  "::a9fe:a9fe", // IPv4-compatible ::169.254.169.254
  "0:0:0:0:0:0:a9fe:a9fe", // the same address, uncompressed
  "::7f00:1",
  "::ffff:0:7f00:1", // IPv4-translated
  "64:ff9b::a9fe:a9fe", // NAT64
  "2002:a9fe:a9fe::1", // 6to4
] as const;

/** Globally routable addresses both guards must ALLOW - a guard must not break real APIs. */
export const ALLOWED_ADDRESSES = [
  "8.8.8.8",
  "1.1.1.1",
  "203.0.113.1", // TEST-NET-3: documentation-only, but not locally routable
  // 192.0/16 is ordinary routable space apart from 192.0.0.0/24 - wordpress.com and
  // gravatar.com live here, and a two-octet check once refused them both.
  "192.0.78.17",
  "192.0.80.239",
  "192.0.2.1", // TEST-NET-1: documentation, like 203.0.113.0/24 above
  "2606:4700:4700::1111",
  "2001:4860:4860::8888",
] as const;
