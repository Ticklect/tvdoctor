import { describe, expect, it } from "vitest";
import { MAX_MEDIA_SESSION_DUMP_BYTES, parseMediaSessionDump } from "../src/media-session.js";

const TARGET = "org.example.tv";

describe("parseMediaSessionDump", () => {
  it("returns metadata only for the exact target package and prefers its active session", () => {
    const dump = `
Sessions Stack - have 3 sessions:
  MediaSessionRecord (pid=111, uid=10001, userId=0, package=org.example.tv.beta, tag=Other)
    active=true
    state=PlaybackState {state=3, position=12, speed=1.0}
  MediaSessionRecord (pid=222, uid=10002, userId=0, package=org.example.tv, tag=Idle)
    active=false
    state=PlaybackState {state=2, position=30, speed=0.0}
  MediaSessionRecord (pid=333, uid=10002, userId=0, package=org.example.tv, tag=Player)
    active=true
    state=PlaybackState {state=3, position=42, speed=1.0}
`;

    expect(parseMediaSessionDump(dump, TARGET)).toEqual({
      packageName: TARGET,
      active: true,
      playbackState: "playing",
    });
  });

  it("retains an inactive exact-package session without claiming playback ownership elsewhere", () => {
    const dump = `
  MediaSessionRecord (pid=222, uid=10002, userId=0, package=org.example.tv, tag=Player)
    active=false
    state=PlaybackState {state=2, position=42, speed=0.0}
`;

    expect(parseMediaSessionDump(dump, TARGET)).toEqual({
      packageName: TARGET,
      active: false,
      playbackState: "paused",
    });
  });

  it("returns null when only another package owns a session", () => {
    expect(parseMediaSessionDump(`
  MediaSessionRecord (pid=111, uid=10001, userId=0, package=org.example.tv.beta, tag=Other)
    active=true
    state=PlaybackState {state=3}
`, TARGET)).toBeNull();
  });

  it.each([
    ["redacted package", "MediaSessionRecord (package=<redacted>)\n  active=true\n  state=PlaybackState {state=3}"],
    ["missing active flag", "MediaSessionRecord (package=org.example.tv)\n  state=PlaybackState {state=3}"],
    ["malformed record", "package=org.example.tv active=true state=3"],
  ])("returns null for %s output", (_label, dump) => {
    expect(parseMediaSessionDump(dump, TARGET)).toBeNull();
  });

  it("normalises only allowlisted playback states", () => {
    expect(parseMediaSessionDump(`
  MediaSessionRecord (package=org.example.tv)
    active=true
    state=PlaybackState {state=999, position=0}
`, TARGET)).toEqual({ packageName: TARGET, active: true, playbackState: null });
  });

  it("enforces whole-dump and per-record bounds", () => {
    const oversized = `MediaSessionRecord (package=${TARGET})\n  active=true\n  state=PlaybackState {state=3}\n${"x".repeat(MAX_MEDIA_SESSION_DUMP_BYTES)}`;
    expect(parseMediaSessionDump(oversized, TARGET)).toBeNull();

    const oversizedRecord = `MediaSessionRecord (package=${TARGET})\n  active=true\n${"x".repeat(64 * 1024)}\nMediaSessionRecord (package=org.other.tv)\n  active=true`;
    expect(parseMediaSessionDump(oversizedRecord, TARGET)).toBeNull();
  });

  it("rejects an invalid target package", () => {
    expect(() => parseMediaSessionDump("", "org.example.tv|other")).toThrow(/package/u);
  });
});
