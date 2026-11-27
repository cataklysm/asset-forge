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

function v4ToNumber(address: string): number {
  return address.split('.').reduce((n, part) => n * 256 + Number(part), 0);
}

const REFUSED_V4_MASKS = REFUSED_V4.map(([network, bits]) => {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { network: (v4ToNumber(network) & mask) >>> 0, mask };
});

function isPublicV4Number(n: number): boolean {
  return !REFUSED_V4_MASKS.some(({ network, mask }) => ((n & mask) >>> 0) === network);
}

/** The eight 16-bit groups of a valid IPv6 literal (no zone id), an embedded dotted IPv4 tail included. */
function v6Groups(address: string): number[] {
  let text = address.toLowerCase();
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail) {
    const n = v4ToNumber(tail[1]!);
    text = `${text.slice(0, -tail[1]!.length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, rest] = text.split('::') as [string, string | undefined];
  const left = head === '' ? [] : head.split(':');
  const right = rest === undefined || rest === '' ? [] : rest.split(':');
  const fill = rest === undefined ? [] : new Array<string>(8 - left.length - right.length).fill('0');
  return [...left, ...fill, ...right].map((g) => parseInt(g, 16));
}

function isPublicV6(address: string): boolean {
  const g = v6Groups(address);
  const embedded = (hi: number, lo: number) => isPublicV4Number(((hi << 16) >>> 0) + lo);
  // ::ffff:0:0/96, IPv4-mapped
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
    return embedded(g[6]!, g[7]!);
  }
  // 64:ff9b::/96, NAT64
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    return embedded(g[6]!, g[7]!);
  }
  // 2002::/16, 6to4
  if (g[0] === 0x2002) return embedded(g[1]!, g[2]!);
  // 2001:db8::/32, documentation
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false;
  // Only global unicast 2000::/3 remains; this also refuses ::, ::1, fc00::/7, fe80::/10 and ff00::/8.
  return (g[0]! & 0xe000) === 0x2000;
}

/** True only for a globally routable unicast address. `address` is an IPv4 or IPv6 literal. */
export function isPublicAddress(address: string): boolean {
  if (address.includes('%')) return false;
  switch (net.isIP(address)) {
    case 4:
      return isPublicV4Number(v4ToNumber(address));
    case 6:
      return isPublicV6(address);
    default:
      return false;
  }
}
