import { describe, expect, it } from "vitest";
import { runDriverConformance } from "@tvdoctor/core";
import {
  FetchRokuWebDriverTransport,
  parseRokuSource,
  RokuTvDriver,
  type RokuWebDriverTransport,
} from "../src/index.js";

class FakeRokuTransport implements RokuWebDriverTransport {
  readonly calls: { method: string; path: string; body: unknown }[] = [];
  focused = "hero-watch";

  async request(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<unknown> {
    this.calls.push({ method, path, body });
    if (path === "/v1/session") return { sessionId: "roku-session", status: 0, value: {} };
    if (path.endsWith("/launch")) {
      this.focused = "hero-watch";
      return { sessionId: "roku-session", status: 0, value: null };
    }
    if (path.endsWith("/press")) {
      if ((body as { button?: string }).button === "right") this.focused = "hero-more";
      return { sessionId: "roku-session", status: 0, value: null };
    }
    if (path.endsWith("/current_app")) {
      return { sessionId: "roku-session", status: 0, value: [{ ID: "dev", Title: "Northstar Roku" }] };
    }
    if (path.endsWith("/element/active")) {
      return {
        sessionId: "roku-session",
        status: 0,
        value: {
          XMLName: { Local: "Button" },
          Attr: [
            { Name: { Local: "id" }, Value: this.focused },
            { Name: { Local: "text" }, Value: this.focused === "hero-watch" ? "Watch" : "More info" },
          ],
          Nodes: [],
        },
      };
    }
    if (path.endsWith("/source")) {
      const source = `<Scene id="home"><Button id="hero-watch" text="Watch" focusable="true" focused="${this.focused === "hero-watch" ? "true" : "false"}"/><Button id="hero-more" text="More info" focusable="true" focused="${this.focused === "hero-more" ? "true" : "false"}"/></Scene>`;
      return { sessionId: "roku-session", status: 0, value: Buffer.from(source).toString("base64") };
    }
    if (method === "DELETE") return { sessionId: "roku-session", status: 0, value: null };
    throw new Error(`Unexpected ${method} ${path}`);
  }
}

describe("RokuTvDriver", () => {
  it("maps the official WebDriver session, launch, focus, source, and remote primitives", async () => {
    const transport = new FakeRokuTransport();
    const driver = new RokuTvDriver({ deviceIp: "192.0.2.10", transport });
    expect([...(await driver.capabilities())]).toEqual(["remote-input", "ui-tree", "launch"]);

    await driver.launch({ id: "dev" });
    const before = await driver.snapshot();
    expect(before.location).toEqual({ status: "available", value: "dev · Northstar Roku" });
    expect(before.focusedElement).toMatchObject({ status: "available", value: { stableId: "hero-watch", name: "Watch" } });
    expect(before.uiTree).toMatchObject({ status: "available", value: [{ stableId: "home" }] });

    const pressed = await driver.press("RIGHT");
    expect(pressed.outcome).toBe("applied");
    const after = await driver.snapshot();
    expect(after.focusedElement).toMatchObject({ status: "available", value: { stableId: "hero-more", name: "More info" } });

    await driver.reset("relaunch");
    expect(transport.calls.filter((call) => call.path.endsWith("/launch"))).toHaveLength(2);
    await driver.close();
    expect(transport.calls.at(-1)).toMatchObject({ method: "DELETE", path: "/v1/session/roku-session" });
  });

  it("reports unsupported keys without sending them and rejects destructive reset", async () => {
    const transport = new FakeRokuTransport();
    const driver = new RokuTvDriver({ deviceIp: "192.0.2.10", transport });
    expect((await driver.press("TAB")).outcome).toBe("unsupported");
    expect(transport.calls).toHaveLength(0);
    await expect(driver.reset("clear-data")).rejects.toThrow(/clear-data/u);
  });

  it("parses bounded Roku source XML into a semantic hierarchy", () => {
    const source = Buffer.from('<Scene id="root"><Label name="headline" text="Hello" visible="true"/></Scene>').toString("base64");
    expect(parseRokuSource(source)).toEqual([
      expect.objectContaining({
        stableId: "root",
        role: "Scene",
        children: [expect.objectContaining({ stableId: "headline", role: "Label", name: "Hello", visible: true })],
      }),
    ]);
  });

  it("confines the default fetch transport to a local WebDriver service", () => {
    expect(() => new FetchRokuWebDriverTransport("https://example.com:8080")).toThrow(/local host/u);
    expect(() => new FetchRokuWebDriverTransport("http://user:pass@127.0.0.1:8080")).toThrow(/credentials/u);
    expect(() => new FetchRokuWebDriverTransport("http://127.0.0.1:8080")).not.toThrow();
  });

  it("passes the shared driver conformance gate against a safe fake Roku fixture", async () => {
    const driver = new RokuTvDriver({ deviceIp: "192.0.2.10", transport: new FakeRokuTransport() });
    const result = await runDriverConformance(driver, {
      app: { id: "dev" },
      resetStrategy: "relaunch",
      remoteKeys: ["RIGHT"],
      expectations: {
        requiredCapabilities: ["remote-input", "ui-tree", "launch"],
        initialSnapshot: {
          location: "dev · Northstar Roku",
          focusedElementStableId: "hero-watch",
          uiTree: "available",
        },
        afterResetSnapshot: {
          focusedElementStableId: "hero-watch",
          uiTree: "available",
        },
      },
    });
    expect(result.status).toBe("pass");
    expect(result.actionsAttempted).toBe(1);
    await driver.close();
  });
});
