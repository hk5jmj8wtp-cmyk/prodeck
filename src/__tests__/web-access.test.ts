import { describe, expect, it } from "vitest";
import { browserBaseUrl, lanBrowserUrls } from "../lib/webAccess";

describe("browser access addresses", () => {
  it("uses the actual interface and Bonjour host without appending .local to an IP or domain", () => {
    const urls = lanBrowserUrls(["10.0.55.39", "Chad-Jones-MacBook-Pro-M3.local"], 8088);
    expect(urls).toEqual(["http://10.0.55.39:8088", "http://Chad-Jones-MacBook-Pro-M3.local:8088"]);
    expect(browserBaseUrl("", urls)).toBe("http://10.0.55.39:8088");
  });
  it("uses an explicit public URL for crew and kiosk links", () => {
    expect(browserBaseUrl(" https://booth.example.org/ ", ["http://10.0.55.39:8088"]))
      .toBe("https://booth.example.org");
  });
  it("does not fabricate a share link before network discovery or for an invalid port", () => {
    expect(browserBaseUrl("", [])).toBe("");
    expect(lanBrowserUrls(["10.0.55.39"], 0)).toEqual([]);
    expect(lanBrowserUrls(["10.0.55.39"], 65536)).toEqual([]);
  });
  it("brackets IPv6 addresses and uses the selected port", () => {
    expect(lanBrowserUrls(["fd00::1"], 8090)).toEqual(["http://[fd00::1]:8090"]);
  });
});
