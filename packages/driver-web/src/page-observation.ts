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
  readonly timings: PageObservationTimings;
  readonly viewport: WebViewportSnapshot;
}

export interface PageObservationTimings {
  /** Time spent inside Chromium, including DOM enumeration and analysis. */
  readonly browserEvaluationMs: number;
  readonly domEnumerationMs: number;
  /** Semantic roles, names, state, geometry, and UI-tree construction. */
  readonly semanticAnalysisMs: number;
  /** Focus, media, and navigation-performance observations before tree walk. */
  readonly auxiliaryObservationMs: number;
  /** Structured-clone transfer plus Node-side recursive text sanitisation. */
  readonly transportAndSanitisationMs: number;
  /** Approximate Playwright call setup and structured-clone transfer. */
  readonly browserRoundTripAndQueueingMs: number;
}

export interface PageObservationWorkLimits {
  readonly maxDepth: number;
  readonly maxScannedNodeCount: number;
  readonly maxTextChars: number;
}

export async function capturePageObservation(
  page: Page,
  maxNodeCount: number,
  workLimits: PageObservationWorkLimits = {
    maxDepth: 128,
    maxScannedNodeCount: 20_000,
    maxTextChars: 512_000,
  },
): Promise<CapturedPageObservation> {
  const captureStartedAtMs = performance.now();
  const observation = await page.evaluate(({ nodeLimit, limits }) => {
    const evaluationStartedAtMs = performance.now();
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

    type TruncationReason = "captured-nodes" | "depth" | "scanned-nodes" | "text";

    const textLimit = 240;
    const textInspectionLimit = textLimit * 4;
    const truncationReasons = new Set<TruncationReason>();
    let capturedNodeCount = 0;
    let scannedNodeCount = 0;
    let textCharsRead = 0;
    let textNodesScanned = 0;

    const consumeTextPrefix = (value: string, maximum: number): string => {
      const remaining = Math.max(0, limits.maxTextChars - textCharsRead);
      const inspectedLength = Math.min(value.length, maximum, remaining);
      if (inspectedLength < Math.min(value.length, maximum)) {
        truncationReasons.add("text");
      }
      textCharsRead += inspectedLength;
      return value.slice(0, inspectedLength);
    };

    const boundedValue = (value: string | null | undefined): string | null => {
      if (typeof value !== "string" || value.length === 0) {
        return null;
      }
      const bounded = consumeTextPrefix(value, textLimit);
      return bounded.length === 0 ? null : bounded;
    };

    const normaliseText = (value: string | null): string | null => {
      if (value === null) {
        return null;
      }
      const normalised = consumeTextPrefix(value, textInspectionLimit).replace(/\s+/gu, " ").trim();
      return normalised.length === 0 ? null : normalised.slice(0, textLimit);
    };

    const textFromSubtree = (root: Node, directOnly = false): string | null => {
      const pieces: string[] = [];
      let normalisedLength = 0;
      const stack: { readonly node: Node; readonly depth: number }[] = [];
      const initialCount = Math.min(
        root.childNodes.length,
        Math.max(0, limits.maxScannedNodeCount - textNodesScanned),
      );
      if (initialCount < root.childNodes.length) truncationReasons.add("text");
      for (let index = initialCount - 1; index >= 0; index -= 1) {
        const child = root.childNodes.item(index);
        if (child !== null) stack.push({ node: child, depth: 1 });
      }

      while (stack.length > 0 && normalisedLength < textLimit) {
        if (textNodesScanned >= limits.maxScannedNodeCount || textCharsRead >= limits.maxTextChars) {
          truncationReasons.add("text");
          break;
        }
        const current = stack.pop();
        if (current === undefined) break;
        textNodesScanned += 1;
        if (current.node.nodeType === Node.TEXT_NODE) {
          const piece = normaliseText(current.node.nodeValue);
          if (piece !== null) {
            pieces.push(piece);
            normalisedLength += piece.length + 1;
          }
          continue;
        }
        if (directOnly || current.depth >= limits.maxDepth) {
          if (!directOnly && current.node.hasChildNodes()) truncationReasons.add("text");
          continue;
        }
        const remainingNodeWork = Math.max(
          0,
          limits.maxScannedNodeCount - textNodesScanned - stack.length,
        );
        const childCount = Math.min(current.node.childNodes.length, remainingNodeWork);
        if (childCount < current.node.childNodes.length) truncationReasons.add("text");
        for (let index = childCount - 1; index >= 0; index -= 1) {
          const child = current.node.childNodes.item(index);
          if (child !== null) stack.push({ node: child, depth: current.depth + 1 });
        }
      }
      const normalised = pieces.join(" ").replace(/\s+/gu, " ").trim();
      return normalised.length === 0 ? null : normalised.slice(0, textLimit);
    };

    const boundsFor = (element: Element): Bounds | null => {
      const rectangle = measuredRectangle(element);
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

    const measuredRectangles = new WeakMap<Element, DOMRect>();
    const measureOnce = (element: Element): DOMRect => {
      let rectangle = measuredRectangles.get(element);
      if (rectangle === undefined) {
        rectangle = element.getBoundingClientRect();
        measuredRectangles.set(element, rectangle);
      }
      return rectangle;
    };

    const isVisible = (element: Element): boolean => {
      const styles = getComputedStyle(element);
      const rectangle = measuredRectangle(element);
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

    function measuredRectangle(element: Element): DOMRect {
      return measureOnce(element);
    }

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
        const labels = boundedValue(labelledBy)?.split(/\s+/u) ?? [];
        const labelledName = normaliseText(labels
          .map((id) => {
            const label = element.ownerDocument.getElementById(id);
            return label === null ? "" : textFromSubtree(label) ?? "";
          })
          .join(" "));
        if (labelledName !== null) {
          return labelledName;
        }
      }

      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
        const labelText = Array.from(element.labels ?? []).map((label) => textFromSubtree(label) ?? "").join(" ");
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
        ? textFromSubtree(element)
        : null;
    };

    const directTextFor = (element: Element): string | null => textFromSubtree(element, true);

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
        .map((attribute) => [attribute.name, consumeTextPrefix(attribute.value, textLimit)]),
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

    const frameBoundaryFor = (element: Element): "same-origin" | "cross-origin" | null => {
      if (!(element instanceof HTMLIFrameElement)) return null;
      try {
        return element.contentDocument !== null && element.contentDocument.defaultView !== null
          ? "same-origin"
          : "cross-origin";
      } catch {
        return "cross-origin";
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

    const auxiliaryStartedAtMs = performance.now();
    let deepActiveElement: Element = document.activeElement ?? document.documentElement;
    for (let depth = 0; depth < limits.maxDepth; depth += 1) {
      let nestedActive: Element | null = null;
      if (deepActiveElement instanceof HTMLIFrameElement) {
        try {
          nestedActive = deepActiveElement.contentDocument?.activeElement ?? null;
        } catch {
          nestedActive = null;
        }
      } else if (deepActiveElement.shadowRoot !== null) {
        nestedActive = deepActiveElement.shadowRoot.activeElement;
      }
      if (nestedActive === null
        || nestedActive === nestedActive.ownerDocument.body
        || nestedActive === nestedActive.ownerDocument.documentElement) {
        break;
      }
      deepActiveElement = nestedActive;
      if (depth === limits.maxDepth - 1) truncationReasons.add("depth");
    }
    const activeElement = deepActiveElement !== deepActiveElement.ownerDocument.body
      && deepActiveElement !== deepActiveElement.ownerDocument.documentElement
      ? deepActiveElement
      : null;

    const childElementsFor = (element: Element, maximum: number): readonly Element[] => {
      const collections: HTMLCollection[] = [];
      if (element instanceof HTMLIFrameElement && frameBoundaryFor(element) === "same-origin") {
        const frameChildren = element.contentDocument?.body?.children;
        if (frameChildren === undefined) return [];
        collections.push(frameChildren);
      } else {
        if (element.shadowRoot !== null) collections.push(element.shadowRoot.children);
        collections.push(element.children);
      }
      const children: Element[] = [];
      let totalChildren = 0;
      for (const collection of collections) {
        totalChildren += collection.length;
        for (let index = 0; index < collection.length && children.length < maximum; index += 1) {
          const child = collection.item(index);
          if (child !== null) children.push(child);
        }
      }
      if (children.length < totalChildren) truncationReasons.add("scanned-nodes");
      return children;
    };

    interface PendingElement {
      readonly element: Element;
      readonly output: DomNode[];
      readonly depth: number;
    }

    const observedMediaElements: HTMLMediaElement[] = [];
    const uiTree: DomNode[] = [];
    const pendingElements: PendingElement[] = [{ element: document.documentElement, output: uiTree, depth: 0 }];

    const domEnumerationStartedAtMs = performance.now();
    const semanticAnalysisStartedAtMs = performance.now();
    while (pendingElements.length > 0) {
      if (scannedNodeCount >= limits.maxScannedNodeCount) {
        truncationReasons.add("scanned-nodes");
        break;
      }
      const pending = pendingElements.pop();
      if (pending === undefined) break;
      if (pending.depth > limits.maxDepth) {
        truncationReasons.add("depth");
        continue;
      }
      scannedNodeCount += 1;

      const { element } = pending;
      if (element instanceof HTMLMediaElement) observedMediaElements.push(element);
      const role = roleFor(element);
      const tagName = element.tagName.toLowerCase();
      const stableId = stableIdFor(element);
      const frameBoundary = frameBoundaryFor(element);
      const include = element === document.body
        || stableId !== null
        || role !== null
        || frameBoundary !== null
        || semanticTags.has(tagName)
        || element.hasAttribute("data-screen");

      let childOutput = pending.output;
      if (include) {
        if (capturedNodeCount >= nodeLimit) {
          truncationReasons.add("captured-nodes");
          break;
        }
        capturedNodeCount += 1;
        const focused = element === document.activeElement || element === deepActiveElement;
        // Roving-focus TV interfaces intentionally keep the active control at
        // tabindex=-1 and move focus programmatically with the D-pad. Preserve
        // sequential tab semantics for inactive controls while reporting the
        // currently focused, enabled control as TV/programmatically focusable.
        const visible = isVisible(element);
        const enabled = isEnabled(element);
        const focusable = "tabIndex" in element
          && typeof element.tabIndex === "number"
          && (element.tabIndex >= 0 || (focused && visible))
          && enabled;
        const node: DomNode = {
          stableId,
          role,
          name: nameFor(element, role),
          text: directTextFor(element),
          bounds: boundsFor(element),
          visible,
          modal: isModal(element, role),
          focusable,
          focused,
          selectionState: selectionStateFor(element),
          valueNow: valueNowFor(element),
          children: [],
          tagName,
          enabled,
          attributes: attributesFor(element),
        };
        if (frameBoundary !== null) node.attributes["data-tv-frame"] = frameBoundary;
        pending.output.push(node);
        childOutput = node.children;
      }

      const remainingScanCapacity = Math.max(
        0,
        limits.maxScannedNodeCount - scannedNodeCount - pendingElements.length,
      );
      const children = childElementsFor(element, remainingScanCapacity);
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index];
        if (child !== undefined) {
          pendingElements.push({ element: child, output: childOutput, depth: pending.depth + 1 });
        }
      }
    }
    const domEnumerationMs = performance.now() - domEnumerationStartedAtMs;
    const semanticAnalysisMs = performance.now() - semanticAnalysisStartedAtMs;

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

    const mediaElements = observedMediaElements.map((media) => {
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
      uiTree,
      uiTreeMetadata: {
        capturedNodeCount,
        domElementCount: scannedNodeCount,
        maxDepth: limits.maxDepth,
        maxNodeCount: nodeLimit,
        maxScannedNodeCount: limits.maxScannedNodeCount,
        maxTextChars: limits.maxTextChars,
        scannedNodeCount,
        textCharsRead,
        textNodesScanned,
        truncationReasons: Array.from(truncationReasons),
        truncated: truncationReasons.size > 0,
      },
      timings: {
        browserEvaluationMs: performance.now() - evaluationStartedAtMs,
        domEnumerationMs,
        semanticAnalysisMs,
        auxiliaryObservationMs: Math.max(0, domEnumerationStartedAtMs - auxiliaryStartedAtMs),
      },
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        deviceScaleFactor: window.devicePixelRatio,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
      },
    };
  }, { nodeLimit: maxNodeCount, limits: workLimits }) as Omit<CapturedPageObservation, "timings"> & {
    readonly timings: {
      readonly browserEvaluationMs: number;
      readonly domEnumerationMs: number;
      readonly semanticAnalysisMs: number;
      readonly auxiliaryObservationMs: number;
    };
  };
  const browserEvaluationEndedAtMs = performance.now();

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

  const result = {
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
  const transportAndSanitisationMs = Math.max(0, performance.now() - browserEvaluationEndedAtMs);
  return {
    ...result,
    timings: {
      ...observation.timings,
      transportAndSanitisationMs,
      browserRoundTripAndQueueingMs: Math.max(
        0,
        browserEvaluationEndedAtMs - captureStartedAtMs - observation.timings.browserEvaluationMs,
      ),
    },
  };
}
