/** The login window's title: `<profile name> – <current host>`, the name alone without a host. */
export function loginTitle(name: string, url: string): string {
  let host = '';
  try {
    host = new URL(url).host;
  } catch {
    // Keep the name alone.
  }
  return host === '' ? name : `${name} – ${host}`;
}

/** The login window goes to any http/https URL; the request filter keeps it to public hosts. */
export function loginNavigationAllowed(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.username === '' && parsed.password === '';
  } catch {
    return false;
  }
}
