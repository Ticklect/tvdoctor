import type { FocusTarget } from "@tvdoctor/protocol";
import type { Page } from "playwright";
import { sanitiseObservedText } from "./security.js";
import type {
  WebDomNodeSnapshot,
  WebMediaElementSnapshot,
  WebPerformanceSnapshot,
  WebUiTreeMetadata,
  WebViewportSnapshot,
} from "./types.js";

export interface CapturedPageObservation {
  readonly focus: FocusTarget | null;
  readonly mediaElements: readonly WebMediaElementSnapshot[];
  readonly performance: WebPerformanceSnapshot;
  readonly uiTree: readonly WebDomNodeSnapshot[];
  readonly uiTreeMetadata: WebUiTreeMetadata;
  readonly viewport: WebViewportSnapshot;
}

export async function capturePageObservation(
  page: Page,
  maxNodeCount: number,
): Promise<CapturedPageObservation> {
  const observation = await page.evaluate((nodeLimit) => {
    interface Bounds {
      x: number;
      y: number;
      width: number;
      height: number;
    }

    interface DomNode {
      stableId: string | null;
      role: string | null;
      name: string | null;
      text: string | null;
      bounds: Bounds | null;
      visible: boolean;
      modal: boolean;
      focusable: boolean;
      focused: boolean;
      selectionState: "on" | "off" | "mixed" | null;
      valueNow: number | null;
      children: DomNode[];
      tagName: string;
      enabled: boolean;
      attributes: Record<string, string>;
    }

    const textLimit = 240;
    const boundedValue = (value: string | null): string | null => {
      if (value === null || value.length === 0) {
        return null;
      }
      return value.slice(0, textLimit);
    };

    const normaliseText = (value: string | null): string | null => {
      if (value === null) {
        return null;
      }
      const normalised = value.replace(/\s+/gu, " ").trim();
      return normalised.length === 0 ? null : normalised.slice(0, textLimit);
    };

    const boundsFor = (element: Element): Bounds | null => {
      const rectangle = element.getBoundingClientRect();
      if (rectangle.width === 0 && rectangle.height === 0) {
        return null;
      }
      return {
        x: rectangle.x,
        y: rectangle.y,
        width: rectangle.width,
        height: rectangle.height,
      };
    };

    const isVisible = (element: Element): boolean => {
      const styles = getComputedStyle(element);
      const rectangle = element.getBoundingClientRect();
      return styles.display !== "none"
        && styles.visibility !== "hidden"
        && Number.parseFloat(styles.opacity) !== 0
        && rectangle.width > 0
        && rectangle.height > 0;
    };

    const implicitRole = (element: Element): string | null => {
      const tagName = element.tagName.toLowerCase();
      if (tagName === "button") return "button";
      if (tagName === "nav") return "navigation";
      if (tagName === "main") return "main";
      if (tagName === "aside") return "complementary";
      if (tagName === "header") return "banner";
      if (tagName === "footer") return "contentinfo";
      if (/^h[1-6]$/u.test(tagName)) return "heading";
      if (tagName === "select") return "combobox";
      if (tagName === "textarea") return "textbox";
      if (tagName === "a" && element.hasAttribute("href")) return "link";
      if (tagName === "img") return "img";
      if (tagName === "option") return "option";
      if (tagName === "progress") return "progressbar";
      if (tagName === "input") {
        const type = element.getAttribute("type")?.toLowerCase() ?? "text";
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        if (type === "button" || type === "reset" || type === "submit") return "button";
        if (type === "range") return "slider";
        return "textbox";
      }
      return null;
    };

    const roleFor = (element: Element): string | null => boundedValue(
      element.getAttribute("role"),
    ) ?? implicitRole(element);

    const stableIdFor = (element: Element): string | null => boundedValue(
      element.getAttribute("data-tv-id") ?? element.id,
    );

    const nameFor = (element: Element, role: string | null): string | null => {
      const ariaLabel = normaliseText(element.getAttribute("aria-label"));
      if (ariaLabel !== null) {
        return ariaLabel;
      }

      const labelledBy = element.getAttribute("aria-labelledby");
      if (labelledBy !== null) {
        const labels = labelledBy.split(/\s+/u)
          .map((id) => document.getElementById(id)?.textContent ?? "")
          .join(" ");
        const labelledName = normaliseText(labels);
        if (labelledName !== null) {
          return labelledName;
        }
      }

      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
        const labelText = Array.from(element.labels ?? []).map((label) => label.textContent ?? "").join(" ");
        const labelledName = normaliseText(labelText);
        if (labelledName !== null) {
          return labelledName;
        }
        return normaliseText(element.getAttribute("placeholder") ?? element.getAttribute("title"));
      }

      if (element instanceof HTMLImageElement) {
        return normaliseText(element.alt);
      }

      const title = normaliseText(element.getAttribute("title"));
      if (title !== null) {
        return title;
      }

      const rolesNamedByContent = new Set([
        "button",
        "checkbox",
        "heading",
        "link",
        "menuitem",
        "option",
        "radio",
        "tab",
      ]);
      return role !== null && rolesNamedByContent.has(role)
        ? normaliseText(element.textContent)
        : null;
    };

    const directTextFor = (element: Element): string | null => normaliseText(
      Array.from(element.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent ?? "")
        .join(" "),
    );

    type SelectionState = "on" | "off" | "mixed";

    const selectionStateFor = (element: Element): SelectionState | null => {
      const states: SelectionState[] = [];
      let invalid = false;

      if (element instanceof HTMLInputElement) {
        const type = element.type.toLowerCase();
        if (type === "checkbox") {
          states.push(element.indeterminate ? "mixed" : element.checked ? "on" : "off");
        } else if (type === "radio") {
          states.push(element.checked ? "on" : "off");
        }
      } else if (element instanceof HTMLOptionElement) {
        states.push(element.selected ? "on" : "off");
      }

      const addAriaState = (name: string, allowMixed: boolean): void => {
        if (!element.hasAttribute(name)) return;
        const rawToken = element.getAttribute(name) ?? "";
        if (rawToken.length > 16) {
          invalid = true;
          return;
        }
        const token = rawToken.trim().toLowerCase();
        if (token === "true") {
          states.push("on");
        } else if (token === "false") {
          states.push("off");
        } else if (allowMixed && token === "mixed") {
          states.push("mixed");
        } else {
          invalid = true;
        }
      };

      addAriaState("aria-pressed", true);
      addAriaState("aria-checked", true);
      addAriaState("aria-selected", false);

      if (invalid || states.length === 0) return null;
      const first = states[0];
      return states.every((state) => state === first) ? first ?? null : null;
    };

    const strictFiniteNumber = (value: string | null): number | null => {
      if (value === null || value.length > 64) return null;
      const token = value.trim();
      if (token.length === 0
        || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(token)) {
        return null;
      }
      const parsed = Number(token);
      return Number.isFinite(parsed) ? (parsed === 0 ? 0 : parsed) : null;
    };

    const valueNowFor = (element: Element): number | null => {
      const values: number[] = [];
      let invalid = false;

      if (element.hasAttribute("aria-valuenow")) {
        const ariaValue = strictFiniteNumber(element.getAttribute("aria-valuenow"));
        if (ariaValue === null) invalid = true;
        else values.push(ariaValue);
      }

      if (element instanceof HTMLInputElement && element.type.toLowerCase() === "range") {
        if (Number.isFinite(element.valueAsNumber)) {
          values.push(element.valueAsNumber === 0 ? 0 : element.valueAsNumber);
        } else {
          invalid = true;
        }
      } else if (element instanceof HTMLProgressElement && element.hasAttribute("value")) {
        if (Number.isFinite(element.value)) {
          values.push(element.value === 0 ? 0 : element.value);
        } else {
          invalid = true;
        }
      }

      if (invalid || values.length === 0) return null;
      const first = values[0];
      return values.every((value) => value === first) ? first ?? null : null;
    };

    const allowedAttribute = (name: string): boolean => name === "disabled"
      || name === "tabindex"
      || name === "type"
      || name === "aria-busy"
      || name === "aria-current"
      || name === "aria-checked"
      || name === "aria-expanded"
      || name === "aria-modal"
      || name === "aria-pressed"
      || name === "aria-selected"
      || name === "aria-valuenow"
      || name === "data-action"
      || name === "data-nav"
      || name.startsWith("data-nav-")
      || name === "data-remote"
      || name === "data-screen"
      || name === "data-tv-id";

    const attributesFor = (element: Element): Record<string, string> => Object.fromEntries(
      Array.from(element.attributes)
        .filter((attribute) => allowedAttribute(attribute.name))
        .map((attribute) => [attribute.name, attribute.value.slice(0, textLimit)]),
    );

    const isEnabled = (element: Element): boolean => {
      if (element.getAttribute("aria-disabled")?.toLowerCase() === "true") return false;
      return !(element instanceof HTMLButtonElement
        || element instanceof HTMLInputElement
        || element instanceof HTMLSelectElement
        || element instanceof HTMLTextAreaElement)
        || !element.disabled;
    };

    const isModal = (element: Element, role: string | null): boolean => {
      if (role !== "dialog" && role !== "alertdialog") return false;
      if (element.getAttribute("aria-modal")?.toLowerCase() === "true") return true;
      try {
        return element.matches(":modal");
      } catch {
        return false;
      }
    };

    const semanticTags = new Set([
      "a",
      "aside",
      "button",
      "footer",
      "form",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "header",
      "img",
      "input",
      "li",
      "main",
      "nav",
      "ol",
      "option",
      "p",
      "progress",
      "section",
      "select",
      "textarea",
      "ul",
    ]);

    let capturedNodeCount = 0;
    let truncated = false;

    const visit = (element: Element): DomNode[] => {
      if (capturedNodeCount >= nodeLimit) {
        truncated = true;
        return [];
      }

      const role = roleFor(element);
      const tagName = element.tagName.toLowerCase();
      const stableId = stableIdFor(element);
      const focusable = element instanceof HTMLElement && element.tabIndex >= 0 && isEnabled(element);
      const include = element === document.body
        || stableId !== null
        || role !== null
        || semanticTags.has(tagName)
        || element.hasAttribute("data-screen");

      if (!include) {
        return Array.from(element.children).flatMap((child) => visit(child));
      }

      capturedNodeCount += 1;
      const node: DomNode = {
        stableId,
        role,
        name: nameFor(element, role),
        text: directTextFor(element),
        bounds: boundsFor(element),
        visible: isVisible(element),
        modal: isModal(element, role),
        focusable,
        focused: element === document.activeElement,
        selectionState: selectionStateFor(element),
        valueNow: valueNowFor(element),
        children: [],
        tagName,
        enabled: isEnabled(element),
        attributes: attributesFor(element),
      };
      node.children = Array.from(element.children).flatMap((child) => visit(child));
      return [node];
    };

    const activeElement = document.activeElement instanceof HTMLElement
      && document.activeElement !== document.body
      && document.activeElement !== document.documentElement
      ? document.activeElement
      : null;
    let focus: FocusTarget | null = null;
    if (activeElement !== null) {
      const role = roleFor(activeElement);
      const stableId = stableIdFor(activeElement);
      const candidate: {
        stableId?: string;
        role?: string;
        name?: string;
        bounds?: Bounds;
      } = {};
      const name = nameFor(activeElement, role);
      const bounds = boundsFor(activeElement);
      if (stableId !== null) candidate.stableId = stableId;
      if (role !== null) candidate.role = role;
      if (name !== null) candidate.name = name;
      if (bounds !== null) candidate.bounds = bounds;
      focus = candidate;
    }

    const mediaElements = Array.from(document.querySelectorAll<HTMLMediaElement>("audio, video")).map((media) => {
      const buffered: { startSeconds: number; endSeconds: number }[] = [];
      for (let index = 0; index < media.buffered.length; index += 1) {
        buffered.push({
          startSeconds: media.buffered.start(index),
          endSeconds: media.buffered.end(index),
        });
      }
      const source = media.currentSrc.length === 0 ? null : (() => {
        try {
          const url = new URL(media.currentSrc, document.baseURI);
          url.username = "";
          url.password = "";
          url.search = "";
          url.hash = "";
          return url.toString();
        } catch {
          return null;
        }
      })();
      return {
        stableId: stableIdFor(media),
        kind: media instanceof HTMLVideoElement ? "video" as const : "audio" as const,
        source,
        bounds: boundsFor(media),
        visible: isVisible(media),
        paused: media.paused,
        ended: media.ended,
        muted: media.muted,
        volume: media.volume,
        playbackRate: media.playbackRate,
        currentTimeSeconds: Number.isFinite(media.currentTime) ? media.currentTime : 0,
        durationSeconds: Number.isFinite(media.duration) ? media.duration : null,
        readyState: media.readyState,
        networkState: media.networkState,
        buffered,
      };
    });

    const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    const optionalDuration = (value: number): number | null => Number.isFinite(value) && value >= 0 ? value : null;

    return {
      focus,
      mediaElements,
      performance: {
        navigation: navigation === undefined ? null : {
          type: navigation.type,
          redirectCount: navigation.redirectCount,
          timeToFirstByteMs: optionalDuration(navigation.responseStart - navigation.requestStart),
          responseDownloadMs: optionalDuration(navigation.responseEnd - navigation.responseStart),
          domInteractiveMs: optionalDuration(navigation.domInteractive - navigation.startTime),
          domContentLoadedMs: optionalDuration(navigation.domContentLoadedEventEnd - navigation.startTime),
          loadEventMs: optionalDuration(navigation.loadEventEnd - navigation.startTime),
        },
        resourceCount: performance.getEntriesByType("resource").length,
      },
      uiTree: visit(document.body),
      uiTreeMetadata: {
        capturedNodeCount,
        maxNodeCount: nodeLimit,
        truncated,
      },
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        deviceScaleFactor: window.devicePixelRatio,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
      },
    };
  }, maxNodeCount);

  const sanitiseNullableText = (value: string | null): string | null => value === null
    ? null
    : sanitiseObservedText(value);
  const sanitiseNode = (node: WebDomNodeSnapshot): WebDomNodeSnapshot => ({
    ...node,
    stableId: sanitiseNullableText(node.stableId),
    role: sanitiseNullableText(node.role),
    name: sanitiseNullableText(node.name),
    text: sanitiseNullableText(node.text),
    attributes: Object.fromEntries(
      Object.entries(node.attributes).map(([name, value]) => [name, sanitiseObservedText(value)]),
    ),
    children: node.children.map((child) => sanitiseNode(child)),
  });

  return {
    ...observation,
    focus: observation.focus === null ? null : {
      ...observation.focus,
      ...(observation.focus.stableId === undefined
        ? {}
        : { stableId: sanitiseObservedText(observation.focus.stableId) }),
      ...(observation.focus.name === undefined
        ? {}
        : { name: sanitiseObservedText(observation.focus.name) }),
      ...(observation.focus.role === undefined
        ? {}
        : { role: sanitiseObservedText(observation.focus.role) }),
    },
    uiTree: observation.uiTree.map((node) => sanitiseNode(node)),
  };
}
