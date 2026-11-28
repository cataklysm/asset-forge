import net from 'node:net';

/** IPv4 ranges that are not globally routable unicast, as [network, prefix length]. */
const REFUSED_V4: readonly (readonly [string, number])[] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4], // includes the broadcast address
];

/**
 * A dotted IPv4 literal as a 32-bit number.
 *
 * @param address four decimal parts
 * @returns the address as an unsigned number
 */
function ipv4ToNumber(address: string): number {
  return address.split('.').reduce((value, part) => value * 256 + Number(part), 0);
}

/** `REFUSED_V4` as network numbers and masks. */
const REFUSED_V4_MASKS = REFUSED_V4.map(([network, bits]) => {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { network: (ipv4ToNumber(network) & mask) >>> 0, mask };
});

/**
 * Whether an IPv4 address lies outside every refused range.
 *
 * @param value the address as a number
 * @returns true for a globally routable unicast address
 */
function isPublicIpv4Number(value: number): boolean {
  return !REFUSED_V4_MASKS.some(({ network, mask }) => (value & mask) >>> 0 === network);
}

/**
 * The eight 16-bit groups of a valid IPv6 literal (no zone id), an embedded dotted IPv4 tail included.
 *
 * @param address the literal
 * @returns the groups
 */
function ipv6Groups(address: string): number[] {
  let text = address.toLowerCase();
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail) {
    const value = ipv4ToNumber(tail[1]!);
    text = `${text.slice(0, -tail[1]!.length)}${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`;
  }
  const [head, rest] = text.split('::') as [string, string | undefined];
  const left = head === '' ? [] : head.split(':');
  const right = rest === undefined || rest === '' ? [] : rest.split(':');
  const fill = rest === undefined ? [] : new Array<string>(8 - left.length - right.length).fill('0');
  return [...left, ...fill, ...right].map((group) => parseInt(group, 16));
}

/**
 * Whether an IPv6 address is global unicast; an embedded IPv4 address is judged by the IPv4 ranges.
 *
 * @param address a valid IPv6 literal without a zone id
 * @returns true for a globally routable unicast address
 */
function isPublicIpv6(address: string): boolean {
  const groups = ipv6Groups(address);
  const embedded = (high: number, low: number) => isPublicIpv4Number(((high << 16) >>> 0) + low);
  // ::ffff:0:0/96, IPv4-mapped
  if (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0xffff
  ) {
    return embedded(groups[6]!, groups[7]!);
  }
  // 64:ff9b::/96, NAT64
  if (
    groups[0] === 0x64 &&
    groups[1] === 0xff9b &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0
  ) {
    return embedded(groups[6]!, groups[7]!);
  }
  // 2002::/16, 6to4
  if (groups[0] === 0x2002) return embedded(groups[1]!, groups[2]!);
  // 2001:db8::/32, documentation
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return false;
  // Only global unicast 2000::/3 remains; this also refuses ::, ::1, fc00::/7, fe80::/10 and ff00::/8.
  return (groups[0]! & 0xe000) === 0x2000;
}

/**
 * True only for a globally routable unicast address. `address` is an IPv4 or IPv6 literal.
 *
 * @param address the literal; one with a zone id is refused
 * @returns true for a globally routable unicast address
 */
export function isPublicAddress(address: string): boolean {
  if (address.includes('%')) return false;
  switch (net.isIP(address)) {
    case 4:
      return isPublicIpv4Number(ipv4ToNumber(address));
    case 6:
      return isPublicIpv6(address);
    default:
      return false;
  }
}
