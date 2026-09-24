/** Network hosts come from the OS; the editable booth name is only a label. */
export function lanBrowserUrls(hosts: string[], port: number): string[] {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return [];
  return hosts.filter(Boolean).map((host) =>
    `http://${host.includes(":") ? `[${host}]` : host}:${port}`,
  );
}

export function browserBaseUrl(publicUrl: string | undefined, lanUrls: string[]): string {
  return (publicUrl?.trim() || lanUrls[0] || "").replace(/\/+$/, "");
}
