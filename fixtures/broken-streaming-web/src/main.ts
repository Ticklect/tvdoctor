import "./styles.css";

type Screen = "details" | "home" | "player" | "search";
type Overlay = "app-settings" | "caption-appearance" | "captions" | "none" | "player-settings" | "profile-trap";
type Direction = "down" | "left" | "right" | "up";

interface NavEdges {
  readonly down?: string;
  readonly left?: string;
  readonly right?: string;
  readonly up?: string;
}

interface ContentItem {
  readonly art: string;
  readonly eyebrow: string;
  readonly id: string;
  readonly progress: number;
  readonly summary: string;
  readonly title: string;
}

interface FixtureState {
  captionColourIndex: number;
  elapsedSeconds: number;
  overlay: Overlay;
  playing: boolean;
  searchQuery: string;
  searchSubmitted: boolean;
  selectedContentId: string;
  settingsPending: boolean;
  screen: Screen;
}

const appElement = document.querySelector<HTMLElement>("#app");

if (appElement === null) {
  throw new Error("Northstar fixture could not find #app");
}

const app: HTMLElement = appElement;

const catalogue: readonly ContentItem[] = [
  {
    art: "ember",
    eyebrow: "Northstar original · Film",
    id: "ember-line",
    progress: 62,
    summary: "A signal cartographer crosses a silent desert to trace a transmission that should not exist.",
    title: "The Ember Line",
  },
  {
    art: "tide",
    eyebrow: "Limited series · 6 episodes",
    id: "glass-tide",
    progress: 31,
    summary: "Marine engineers descend below a frozen shelf and find a current running against time.",
    title: "Glass Tide",
  },
  {
    art: "orchard",
    eyebrow: "Documentary · New",
    id: "night-orchard",
    progress: 18,
    summary: "A patient portrait of the growers who keep an impossible hillside orchard alive after dark.",
    title: "Night Orchard",
  },
  {
    art: "atlas",
    eyebrow: "Adventure · Film",
    id: "quiet-atlas",
    progress: 47,
    summary: "Two rival mapmakers follow a coastline that redraws itself with every sunrise.",
    title: "A Quiet Atlas",
  },
  {
    art: "relay",
    eyebrow: "Drama · Season 2",
    id: "last-relay",
    progress: 76,
    summary: "The final crew on a mountain relay station receives one last impossible request.",
    title: "The Last Relay",
  },
  {
    art: "moss",
    eyebrow: "Nature · 4K",
    id: "moss-country",
    progress: 8,
    summary: "An intimate expedition through miniature forests and the creatures hidden between raindrops.",
    title: "Moss Country",
  },
];

const state: FixtureState = {
  captionColourIndex: 0,
  elapsedSeconds: 582,
  overlay: "none",
  playing: false,
  searchQuery: "",
  searchSubmitted: false,
  selectedContentId: "ember-line",
  settingsPending: false,
  screen: "home",
};

const fixtureParameters = new URLSearchParams(window.location.search);

function boundedCarouselSize(value: string | null): number {
  if (value === null || !/^\d{1,3}$/u.test(value)) return 0;
  const parsed = Number.parseInt(value, 10);
  return parsed >= 3 && parsed <= 500 ? parsed : 0;
}

/** Opt-in M8 stress surface. The default 13-seed fixture remains unchanged. */
const stressCarouselSize = boundedCarouselSize(fixtureParameters.get("carouselSize"));
const baselineVariant = fixtureParameters.get("baselineVariant");
const useBaselineHarness = baselineVariant === "clean" || baselineVariant === "regressed";
const useBaselineRegression = baselineVariant === "regressed";

// Test-only route perturbation used to prove semantic traversal. It changes
// initial focus plus the visual/focus order at three journey junctions; screen
// semantics, actions, and seeded defects remain identical to the default fixture.
const useSemanticAlternateRoute = fixtureParameters.get("routeVariant") === "semantic-alternate";

const captionColours = ["Warm white", "Sunflower", "Cyan"] as const;
let settingsTimer: number | undefined;
let toastTimer: number | undefined;

function testRouteEdges(defaultEdges: NavEdges, semanticAlternateEdges: NavEdges): NavEdges {
  return useSemanticAlternateRoute ? semanticAlternateEdges : defaultEdges;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function tvAttributes(
  id: string,
  screen: string,
  navGroup: string,
  edges: NavEdges = {},
  remote = true,
): string {
  const directionAttributes: string[] = [];
  const entries: readonly (readonly [Direction, string | undefined])[] = [
    ["up", edges.up],
    ["right", edges.right],
    ["down", edges.down],
    ["left", edges.left],
  ];

  for (const [direction, target] of entries) {
    if (target !== undefined) {
      directionAttributes.push(`data-nav-${direction}="${escapeHtml(target)}"`);
    }
  }

  return [
    `data-tv-id="${escapeHtml(id)}"`,
    `data-screen="${escapeHtml(screen)}"`,
    `data-nav="${escapeHtml(navGroup)}"`,
    `data-remote="${String(remote)}"`,
    `tabindex="${remote ? "0" : "-1"}"`,
    ...directionAttributes,
  ].join(" ");
}

function selectedContent(): ContentItem {
  const selected = catalogue.find((item) => item.id === state.selectedContentId);
  const fallback = catalogue[0];
  if (selected !== undefined) {
    return selected;
  }
  if (fallback === undefined) {
    throw new Error("Northstar fixture catalogue must contain at least one title");
  }
  return fallback;
}

function primaryRail(active: "home" | "search"): string {
  const homeEdges = active === "home"
    ? { down: "home-nav-search", right: "hero-watch" }
    : { down: "home-nav-search", right: "search-query" };

  return `
    <nav class="rail" aria-label="Primary">
      <div class="brand" aria-label="Northstar">
        <span class="brand__mark" aria-hidden="true"></span>
        <span class="brand__word">Northstar</span>
      </div>
      <div class="rail__links">
        <button
          class="rail-link ${active === "home" ? "is-current" : ""}"
          ${tvAttributes("home-nav-home", state.screen, "primary", homeEdges)}
          data-action="go-home"
          aria-current="${active === "home" ? "page" : "false"}"
        ><span class="rail-link__glyph" aria-hidden="true">⌂</span><span>Home</span></button>
        <button
          class="rail-link ${active === "search" ? "is-current" : ""}"
          ${tvAttributes("home-nav-search", state.screen, "primary", { up: "home-nav-home", down: "home-nav-library", right: active === "search" ? "search-query" : "hero-watch" })}
          data-action="go-search"
          aria-current="${active === "search" ? "page" : "false"}"
        ><span class="rail-link__glyph" aria-hidden="true">⌕</span><span>Search</span></button>
        <button
          class="rail-link"
          ${tvAttributes("home-nav-library", state.screen, "primary", { up: "home-nav-search", down: "home-nav-settings", right: active === "home" ? "home-card-1" : "search-query" })}
          data-action="open-profile-trap"
        ><span class="rail-link__glyph" aria-hidden="true">▦</span><span>Profiles</span></button>
        <button
          class="rail-link"
          ${tvAttributes("home-nav-settings", state.screen, "primary", { up: "home-nav-library", down: "footer-privacy", right: active === "home" ? "home-card-1" : "search-query" })}
          data-action="open-app-settings"
        ><span class="rail-link__glyph" aria-hidden="true">⚙</span><span>Settings</span></button>
      </div>
      <div class="rail__signal"><span></span> Connected</div>
    </nav>
  `;
}

function poster(item: ContentItem, index: number, row: "continue" | "fresh"): string {
  const id = row === "continue" ? `home-card-${index + 1}` : `fresh-card-${index + 1}`;
  const previous = index === 0 ? "home-nav-home" : `${row === "continue" ? "home-card" : "fresh-card"}-${index}`;
  const next = `${row === "continue" ? "home-card" : "fresh-card"}-${index + 2}`;
  const isLast = index === 3;
  let edges: NavEdges;

  if (row === "continue") {
    edges = {
      down: `fresh-card-${index + 1}`,
      left: previous,
      right: index === 2 ? "footer-privacy" : isLast ? id : next,
      up: "hero-watch",
    };
  } else {
    const optionalDown = stressCarouselSize > 0
      ? `stress-card-${String(index + 1).padStart(3, "0")}`
      : useBaselineHarness
        ? "m10-probe-a"
        : undefined;
    edges = {
      ...(optionalDown === undefined ? {} : { down: optionalDown }),
      left: previous,
      right: isLast ? id : next,
      up: `home-card-${index + 1}`,
    };
  }

  const weakFocus = row === "continue" && index === 1;
  const defectAttribute = row === "continue" && index === 2
    ? 'data-defect-id="fixture-carousel-right-jump"'
    : weakFocus
      ? 'data-defect-id="fixture-card-focus-indicator-weak"'
      : "";

  return `
    <button
      class="poster ${weakFocus ? "poster--weak-focus" : ""}"
      ${tvAttributes(id, "home", row === "continue" ? "continue-row" : "fresh-row", edges)}
      ${defectAttribute}
      data-action="open-details"
      data-content-id="${item.id}"
      aria-label="Open ${escapeHtml(item.title)} details"
    >
      <span class="poster__art poster__art--${item.art}" aria-hidden="true">
        <span class="poster__orb"></span>
        <span class="poster__line"></span>
      </span>
      <span class="poster__meta">
        <strong>${escapeHtml(item.title)}</strong>
        <span>${escapeHtml(item.eyebrow)}</span>
      </span>
      ${row === "continue" ? `<span class="progress" aria-label="${item.progress} percent watched"><span style="width:${item.progress}%"></span></span>` : ""}
    </button>
  `;
}

function stressPoster(index: number): string {
  const ordinal = String(index + 1).padStart(3, "0");
  const id = `stress-card-${ordinal}`;
  const previous = index === 0
    ? "fresh-card-1"
    : `stress-card-${String(index).padStart(3, "0")}`;
  const next = index + 1 === stressCarouselSize
    ? id
    : `stress-card-${String(index + 2).padStart(3, "0")}`;
  const source = catalogue[index % catalogue.length];
  if (source === undefined) throw new Error("Northstar stress catalogue source is missing");
  return `
    <button
      class="poster stress-poster"
      ${tvAttributes(id, "home", "stress-carousel", {
        left: previous,
        right: next,
        up: `fresh-card-${String(index % 4 + 1)}`,
      })}
      data-action="open-details"
      data-content-id="${source.id}"
      aria-label="Open repeated carousel item ${ordinal} details"
    >
      <span class="poster__art poster__art--${source.art}" aria-hidden="true">
        <span class="poster__orb"></span>
        <span class="poster__line"></span>
      </span>
      <span class="poster__meta">
        <strong>Repeated signal ${ordinal}</strong>
        <span>Compression stress item</span>
      </span>
    </button>
  `;
}

function homeScreen(): string {
  const continueItems = catalogue.slice(0, 4).map((item, index) => poster(item, index, "continue")).join("");
  const freshItems = catalogue.slice(2, 6).map((item, index) => poster(item, index, "fresh")).join("");
  const stressItems = stressCarouselSize === 0
    ? ""
    : Array.from({ length: stressCarouselSize }, (_, index) => stressPoster(index)).join("");
  const stressShelf = stressCarouselSize === 0 ? "" : `
    <section class="shelf stress-shelf" aria-labelledby="stress-title" data-carousel-size="${String(stressCarouselSize)}">
      <div class="shelf__heading"><div><p class="kicker">M8 controlled benchmark</p><h2 id="stress-title">Repeated carousel</h2></div><span>${String(stressCarouselSize)} equivalent cards</span></div>
      <div class="poster-row stress-poster-row">${stressItems}</div>
    </section>
  `;
  const baselineHarness = !useBaselineHarness || stressCarouselSize > 0 ? "" : `
    <section class="shelf baseline-harness" aria-labelledby="baseline-harness-title">
      <div class="shelf__heading"><div><p class="kicker">M10 controlled comparison</p><h2 id="baseline-harness-title">Baseline probe</h2></div><span>${useBaselineRegression ? "regressed" : "clean"}</span></div>
      <div class="poster-row baseline-probe-row">
        <button
          class="poster baseline-probe"
          ${tvAttributes("m10-probe-a", "home", "baseline-probe", { left: "home-nav-home", right: "m10-probe-b", up: "fresh-card-1" })}
          data-action="m10-probe-a"
          aria-label="Run baseline focus probe"
        ><span class="poster__meta"><strong>Focus probe</strong><span>SELECT should retain focus</span></span></button>
        <button
          class="poster baseline-probe"
          ${tvAttributes("m10-probe-b", "home", "baseline-probe", { left: "m10-probe-a", right: "m10-probe-b", up: "fresh-card-2" })}
          data-action="m10-probe-b"
          aria-label="Baseline companion control"
        ><span class="poster__meta"><strong>Companion</strong><span>Stable comparison target</span></span></button>
      </div>
    </section>
  `;

  return `
    <div class="shell" data-screen="home">
      ${primaryRail("home")}
      <main class="home" data-screen="home" aria-label="Home">
        <section class="hero" aria-labelledby="hero-title">
          <div class="hero__wash" aria-hidden="true"><span></span><span></span><span></span></div>
          <div class="hero__content">
            <p class="eyebrow"><span>Northstar premiere</span> · New this week</p>
            <h1 id="hero-title">The Ember Line</h1>
            <p class="hero__summary">A signal cartographer crosses a silent desert to trace a transmission that should not exist.</p>
            <div class="hero__facts" aria-label="Content facts"><span>2026</span><span>1h 48m</span><span>UHD</span><span>12</span></div>
            <div class="hero__actions">
              <button
                class="button button--primary"
                ${tvAttributes("hero-watch", "home", "hero", { down: "home-card-1", left: "home-nav-home", right: "hero-watch" })}
                data-action="open-details"
                data-content-id="ember-line"
              ><span aria-hidden="true">▶</span> Explore film</button>
              <button
                class="button button--glass"
                ${tvAttributes("hero-more-info", "home", "pointer-only", {}, false)}
                data-action="show-more-info"
                data-defect-id="fixture-home-more-info-unreachable"
              >More info</button>
            </div>
          </div>
          <button
            class="preview-chip"
            ${tvAttributes("hero-preview-pointer", "home", "pointer-only", {}, false)}
            data-action="preview"
            aria-label="Play a pointer-only preview"
          ><span aria-hidden="true">◉</span> 30s preview</button>
        </section>

        <section class="shelf" aria-labelledby="continue-title">
          <div class="shelf__heading"><div><p class="kicker">Pick up where you left off</p><h2 id="continue-title">Continue watching</h2></div><span>4 stories</span></div>
          <div class="poster-row">${continueItems}</div>
        </section>

        <section class="shelf" aria-labelledby="fresh-title">
          <div class="shelf__heading"><div><p class="kicker">Curated tonight</p><h2 id="fresh-title">Fresh signals</h2></div><span>Made for this fixture</span></div>
          <div class="poster-row">${freshItems}</div>
        </section>

        ${stressShelf}
        ${baselineHarness}

        <footer class="footer">
          <span>Northstar is a fictional service. All titles and art are original placeholders.</span>
          <button
            class="footer__link"
            ${tvAttributes("footer-privacy", "home", "footer", { left: "home-card-3", up: "home-card-3" })}
            data-action="privacy"
          >Privacy</button>
        </footer>
      </main>
      ${renderOverlay()}
    </div>
  `;
}

function searchResult(item: ContentItem, index: number): string {
  const id = `search-result-${index + 1}`;
  const previous = index === 0 ? "search-key-clear" : `search-result-${index}`;
  const next = index === 2 ? id : `search-result-${index + 2}`;
  return `
    <button
      class="search-result"
      ${tvAttributes(id, "search", "search-results", { up: previous, down: next, left: "home-nav-search" })}
      data-action="open-details"
      data-content-id="${item.id}"
    >
      <span class="search-result__art poster__art--${item.art}" aria-hidden="true"></span>
      <span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.eyebrow)}</small></span>
      <span class="search-result__arrow" aria-hidden="true">→</span>
    </button>
  `;
}

function searchScreen(): string {
  const hasQuery = state.searchQuery.length > 0;
  const resultMarkup = hasQuery
    ? catalogue.slice(0, 3).map((item, index) => searchResult(item, index)).join("")
    : `<div class="search-empty"><span class="search-empty__star" aria-hidden="true">✦</span><h2>Find your next signal</h2><p>Use the on-screen keys or type a title with a connected keyboard.</p></div>`;
  const resultTarget = hasQuery ? "search-result-1" : "search-query";

  return `
    <div class="shell" data-screen="search">
      ${primaryRail("search")}
      <main class="search" data-screen="search" aria-labelledby="search-title">
        <header class="search__header">
          <p class="eyebrow"><span>Explore the catalogue</span></p>
          <h1 id="search-title">Search Northstar</h1>
          <div class="search-box">
            <label for="catalogue-query">Title, theme or collection</label>
            <div class="search-box__row">
              <input
                id="catalogue-query"
                type="text"
                value="${escapeHtml(state.searchQuery)}"
                placeholder="Build a query below"
                readonly
                ${tvAttributes("search-query", "search", "search-input", { down: "search-key-n", left: "home-nav-search" })}
                aria-describedby="search-help"
              />
              <button
                class="button button--primary search-submit"
                ${tvAttributes("search-submit", "search", "pointer-only", {}, false)}
                data-action="submit-search"
                data-defect-id="fixture-search-submit-pointer-only"
              >Search</button>
            </div>
            <p id="search-help">Remote: move down to the letter pad. Results update as you enter characters.</p>
          </div>
        </header>

        <div class="search__body">
          <section class="keypad" aria-label="On-screen search keyboard">
            <button class="key" ${tvAttributes("search-key-n", "search", "search-keypad", { up: "search-query", right: "search-key-o", down: "search-key-space", left: "home-nav-search" })} data-action="search-character" data-character="N">N</button>
            <button class="key" ${tvAttributes("search-key-o", "search", "search-keypad", { up: "search-query", right: "search-key-v", down: "search-key-delete", left: "search-key-n" })} data-action="search-character" data-character="O">O</button>
            <button class="key" ${tvAttributes("search-key-v", "search", "search-keypad", { up: "search-query", right: "search-key-a", down: "search-key-clear", left: "search-key-o" })} data-action="search-character" data-character="V">V</button>
            <button class="key" ${tvAttributes("search-key-a", "search", "search-keypad", { up: "search-query", down: "search-key-clear", left: "search-key-v" })} data-action="search-character" data-character="A">A</button>
            <button class="key key--wide" ${tvAttributes("search-key-space", "search", "search-keypad", { up: "search-key-n", right: "search-key-delete", down: resultTarget, left: "home-nav-search" })} data-action="search-character" data-character=" ">Space</button>
            <button class="key" ${tvAttributes("search-key-delete", "search", "search-keypad", { up: "search-key-o", right: "search-key-clear", down: resultTarget, left: "search-key-space" })} data-action="search-delete">⌫</button>
            <button class="key" ${tvAttributes("search-key-clear", "search", "search-keypad", { up: "search-key-v", down: resultTarget, left: "search-key-delete" })} data-action="search-clear">Clear</button>
          </section>
          <section class="results" aria-label="Search results">
            <div class="results__heading"><h2>${hasQuery ? `Results for “${escapeHtml(state.searchQuery)}”` : "Results"}</h2><span>${hasQuery ? "3 matches" : "Waiting for a query"}</span></div>
            ${resultMarkup}
            ${state.searchSubmitted ? '<p class="submitted-note">Pointer submit received. Live results were already current.</p>' : ""}
          </section>
        </div>
      </main>
      ${renderOverlay()}
    </div>
  `;
}

function detailsScreen(): string {
  const item = selectedContent();
  return `
    <main class="details" data-screen="details" aria-labelledby="details-title" data-defect-id="fixture-details-back-wrong-screen">
      <div class="details__art poster__art--${item.art}" aria-hidden="true"><span class="details__moon"></span><span class="details__ridge"></span></div>
      <div class="details__shade" aria-hidden="true"></div>
      <header class="details__top"><span class="brand brand--compact"><span class="brand__mark"></span><span class="brand__word">Northstar</span></span><span class="remote-hint">Esc / Backspace · Back</span></header>
      <section class="details__content">
        <p class="eyebrow"><span>${escapeHtml(item.eyebrow)}</span></p>
        <h1 id="details-title">${escapeHtml(item.title)}</h1>
        <div class="details__facts"><span>2026</span><span>UHD</span><span>5.1</span><span>12</span></div>
        <p>${escapeHtml(item.summary)}</p>
        <div class="details__actions">
          <button class="button button--primary" ${tvAttributes("details-play", "details", "details-actions", { right: "details-trailer", down: "details-episodes" })} data-action="play"><span aria-hidden="true">▶</span> Play</button>
          <button class="button button--glass" ${tvAttributes("details-trailer", "details", "details-actions", { left: "details-play", right: "details-watchlist", down: "details-episodes" })} data-action="trailer">Trailer</button>
          <button class="button button--glass" ${tvAttributes("details-watchlist", "details", "details-actions", { left: "details-trailer", down: "details-episodes" })} data-action="watchlist">＋ My list</button>
        </div>
        <button class="episode-card" ${tvAttributes("details-episodes", "details", "episodes", { up: "details-play" })} data-action="episode">
          <span class="episode-card__number">01</span><span><strong>Across the salt</strong><small>48 min · The first trace appears at dusk.</small></span><span aria-hidden="true">→</span>
        </button>
      </section>
    </main>
  `;
}

function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

function playerScreen(): string {
  const item = selectedContent();
  const progress = Math.min(100, (state.elapsedSeconds / 6480) * 100);
  const playPauseEdges = testRouteEdges(
    { left: "player-rewind", right: "player-forward" },
    { left: "player-rewind", right: "player-settings" },
  );
  const forwardEdges = testRouteEdges(
    { left: "player-play-pause", right: "player-captions" },
    { left: "player-settings", right: "player-captions" },
  );
  const captionsEdges = testRouteEdges(
    { left: "player-forward", right: "player-settings" },
    { left: "player-forward" },
  );
  const settingsEdges = testRouteEdges(
    { left: "player-captions", right: "player-settings" },
    { left: "player-play-pause", right: "player-forward" },
  );
  const rewindControl = `<button class="control" ${tvAttributes("player-rewind", "player", "player-controls", { right: "player-play-pause" })} data-action="rewind" data-defect-id="fixture-player-rewind-inverted"><span aria-hidden="true">↶</span><small>10s</small><b>Rewind</b></button>`;
  const playPauseControl = `<button class="control control--primary" ${tvAttributes("player-play-pause", "player", "player-controls", playPauseEdges)} data-action="toggle-play" aria-pressed="${String(state.playing)}"><span aria-hidden="true">${state.playing ? "Ⅱ" : "▶"}</span><b>${state.playing ? "Pause" : "Play"}</b></button>`;
  const forwardControl = `<button class="control" ${tvAttributes("player-forward", "player", "player-controls", forwardEdges)} data-action="forward"><span aria-hidden="true">↷</span><small>10s</small><b>Forward</b></button>`;
  const captionsControl = `<button class="control" ${tvAttributes("player-captions", "player", "player-controls", captionsEdges)} data-action="open-captions"><span aria-hidden="true">CC</span><b>Captions</b></button>`;
  const settingsControl = `<button class="control ${state.settingsPending ? "is-pending" : ""}" ${tvAttributes("player-settings", "player", "player-controls", settingsEdges)} data-action="open-player-settings" data-defect-id="fixture-player-settings-slow-open" aria-busy="${String(state.settingsPending)}"><span aria-hidden="true">⚙</span><b>${state.settingsPending ? "Opening…" : "Settings"}</b></button>`;
  const volumeControl = `<button class="control control--pointer" ${tvAttributes("player-volume-boost", "player", "pointer-only", {}, false)} data-action="volume-boost" data-defect-id="fixture-player-volume-pointer-only"><span aria-hidden="true">⌁</span><b>Boost dialogue</b></button>`;
  const transportControls = useSemanticAlternateRoute
    ? [rewindControl, playPauseControl, settingsControl, forwardControl, captionsControl, volumeControl]
    : [rewindControl, playPauseControl, forwardControl, captionsControl, settingsControl, volumeControl];

  return `
    <main class="player" data-screen="player" aria-label="Playing ${escapeHtml(item.title)}">
      <div class="player__scene player__scene--${item.art}" aria-hidden="true">
        <span class="player__planet"></span><span class="player__horizon"></span><span class="player__grain"></span>
      </div>
      <div class="player__top"><span class="brand brand--compact"><span class="brand__mark"></span><span class="brand__word">Northstar</span></span><span>Episode 1 · ${escapeHtml(item.title)}</span></div>
      <div class="player__caption-preview" style="--caption-colour:${state.captionColourIndex === 0 ? "#fff7df" : state.captionColourIndex === 1 ? "#ffe45c" : "#6ff7ff"}">There is another route beyond the ridge.</div>
      <section class="transport" aria-label="Player controls" data-screen="player">
        <div class="transport__timeline">
          <span class="transport__time" data-player-time>${formatTime(state.elapsedSeconds)}</span>
          <div class="transport__track" role="progressbar" aria-valuemin="0" aria-valuemax="6480" aria-valuenow="${state.elapsedSeconds}"><span data-player-progress style="width:${progress}%"></span></div>
          <span>1:48:00</span>
        </div>
        <div class="transport__row">
          ${transportControls.join("")}
        </div>
      </section>
      ${renderOverlay()}
    </main>
  `;
}

function renderOverlay(): string {
  if (state.overlay === "none") {
    return "";
  }

  if (state.overlay === "profile-trap") {
    return `
      <div class="modal-layer" data-screen="profile-picker" role="dialog" aria-modal="true" aria-labelledby="profile-title" data-defect-id="fixture-profile-focus-trap">
        <section class="profile-modal">
          <p class="kicker">Who is watching?</p><h2 id="profile-title">Choose a profile</h2>
          <div class="profile-grid">
            <button class="profile" ${tvAttributes("profile-primary", "profile-picker", "trapped", { up: "profile-primary", right: "profile-kids", down: "profile-primary", left: "profile-primary" })} data-action="profile-primary"><span class="profile__avatar profile__avatar--one">N</span><strong>Night owl</strong></button>
            <button class="profile" ${tvAttributes("profile-kids", "profile-picker", "trapped", { up: "profile-kids", right: "profile-kids", down: "profile-kids", left: "profile-primary" })} data-action="profile-kids"><span class="profile__avatar profile__avatar--two">K</span><strong>Little stars</strong></button>
          </div>
          <p class="profile-modal__warning">This deliberately broken picker cannot be escaped with the remote.</p>
          <button class="modal-close" ${tvAttributes("profile-close-pointer", "profile-picker", "pointer-only", {}, false)} data-action="close-profile" aria-label="Close profile picker with pointer">×</button>
        </section>
      </div>
    `;
  }

  if (state.overlay === "app-settings") {
    return `
      <div class="modal-layer modal-layer--soft" data-screen="app-settings" role="dialog" aria-modal="true" aria-labelledby="app-settings-title">
        <section class="app-settings">
          <p class="kicker">Northstar</p><h2 id="app-settings-title">App settings</h2>
          <button class="menu-row" ${tvAttributes("app-settings-appearance", "app-settings", "app-settings", { down: "app-settings-autoplay" })} data-action="setting"><span><strong>Appearance</strong><small>Midnight</small></span><span>›</span></button>
          <button class="menu-row" ${tvAttributes("app-settings-autoplay", "app-settings", "app-settings", { up: "app-settings-appearance", down: "app-settings-about" })} data-action="setting"><span><strong>Autoplay previews</strong><small>On</small></span><span>›</span></button>
          <button class="menu-row" ${tvAttributes("app-settings-about", "app-settings", "app-settings", { up: "app-settings-autoplay" })} data-action="setting"><span><strong>About this fixture</strong><small>Milestone 1</small></span><span>›</span></button>
          <p class="menu-hint">Esc / Backspace · Close</p>
        </section>
      </div>
    `;
  }

  if (state.overlay === "player-settings") {
    return `
      <div class="drawer-layer" data-screen="player-settings" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <aside class="drawer panel--clipped" data-tv-id="settings-panel" data-screen="player-settings" data-nav="settings-panel" data-defect-id="fixture-player-settings-clipped">
          <header><p class="kicker">While watching</p><h2 id="settings-title">Player settings</h2></header>
          <button class="menu-row" ${tvAttributes("settings-captions", "player-settings", "settings-menu", { down: "settings-audio" })} data-action="open-captions"><span><strong>Captions</strong><small>Off</small></span><span>›</span></button>
          <button class="menu-row" ${tvAttributes("settings-audio", "player-settings", "settings-menu", { up: "settings-captions", down: "settings-quality" })} data-action="setting"><span><strong>Audio</strong><small>English · 5.1</small></span><span>›</span></button>
          <button class="menu-row" ${tvAttributes("settings-quality", "player-settings", "settings-menu", { up: "settings-audio" })} data-action="setting"><span><strong>Picture quality</strong><small>Auto · UHD</small></span><span>›</span></button>
          <p class="menu-hint">Esc / Backspace · Back</p>
        </aside>
      </div>
    `;
  }

  if (state.overlay === "captions") {
    const captionsOffEdges = testRouteEdges(
      { down: "captions-english" },
      { down: "captions-appearance" },
    );
    const captionsEnglishEdges = testRouteEdges(
      { down: "captions-spanish", up: "captions-off" },
      { down: "captions-spanish", up: "captions-appearance" },
    );
    const captionsSpanishEdges = testRouteEdges(
      { down: "captions-appearance", up: "captions-english" },
      { up: "captions-english" },
    );
    const captionsAppearanceEdges = testRouteEdges(
      { up: "captions-spanish" },
      { down: "captions-english", up: "captions-off" },
    );
    const captionsOffControl = `<button class="menu-row is-selected" ${tvAttributes("captions-off", "captions", "captions-menu", captionsOffEdges)} data-action="captions-off" aria-pressed="true"><span><strong>Off</strong><small>Current selection</small></span><span>✓</span></button>`;
    const captionsEnglishControl = `<button class="menu-row" ${tvAttributes("captions-english", "captions", "captions-menu", captionsEnglishEdges)} data-action="captions-english" data-defect-id="fixture-caption-track-toggle-ignored" aria-pressed="false"><span><strong>English (CC)</strong><small>Closed captions</small></span><span></span></button>`;
    const captionsSpanishControl = `<button class="menu-row" ${tvAttributes("captions-spanish", "captions", "captions-menu", captionsSpanishEdges)} data-action="captions-spanish" aria-pressed="false"><span><strong>Español</strong><small>Subtitles</small></span><span></span></button>`;
    const captionsAppearanceControl = `<button class="menu-row menu-row--accent" ${tvAttributes("captions-appearance", "captions", "captions-menu", captionsAppearanceEdges)} data-action="open-caption-appearance"><span><strong>Appearance</strong><small>Font, colour and background</small></span><span>›</span></button>`;
    const captionControls = useSemanticAlternateRoute
      ? [captionsOffControl, captionsAppearanceControl, captionsEnglishControl, captionsSpanishControl]
      : [captionsOffControl, captionsEnglishControl, captionsSpanishControl, captionsAppearanceControl];

    return `
      <div class="drawer-layer" data-screen="captions" role="dialog" aria-modal="true" aria-labelledby="captions-title">
        <aside class="drawer drawer--nested">
          <header><p class="kicker">Player settings</p><h2 id="captions-title">Captions</h2></header>
          ${captionControls.join("")}
          <p class="menu-hint">Esc / Backspace · Back</p>
        </aside>
      </div>
    `;
  }

  return `
    <div class="drawer-layer" data-screen="caption-appearance" role="dialog" aria-modal="true" aria-labelledby="appearance-title">
      <aside class="drawer drawer--nested drawer--appearance">
        <header><p class="kicker">Captions</p><h2 id="appearance-title">Appearance</h2></header>
        <div class="caption-sample" style="--sample-colour:${state.captionColourIndex === 0 ? "#fff7df" : state.captionColourIndex === 1 ? "#ffe45c" : "#6ff7ff"}"><span>Caption preview</span></div>
        <button class="menu-row" ${tvAttributes("caption-font-size", "caption-appearance", "appearance-menu", { down: "caption-background-colour" })} data-action="caption-font-size"><span><strong>Font Size</strong><small>Medium</small></span><span>›</span></button>
        <button class="menu-row menu-row--unreachable" ${tvAttributes("caption-text-colour", "caption-appearance", "pointer-only", {}, false)} data-action="caption-text-colour" data-defect-id="fixture-caption-text-colour-remote-unreachable"><span><strong>Text Colour</strong><small>${captionColours[state.captionColourIndex]}</small></span><span class="colour-dot" style="--dot-colour:${state.captionColourIndex === 0 ? "#fff7df" : state.captionColourIndex === 1 ? "#ffe45c" : "#6ff7ff"}"></span></button>
        <button class="menu-row" ${tvAttributes("caption-background-colour", "caption-appearance", "appearance-menu", { up: "caption-font-size", down: "caption-edge-style" })} data-action="caption-background"><span><strong>Background Colour</strong><small>Black · 70%</small></span><span>›</span></button>
        <button class="menu-row" ${tvAttributes("caption-edge-style", "caption-appearance", "appearance-menu", { up: "caption-background-colour" })} data-action="caption-edge"><span><strong>Edge Style</strong><small>Soft shadow</small></span><span>›</span></button>
        <p class="menu-hint">Text Colour works with a pointer. Esc / Backspace · Back</p>
      </aside>
    </div>
  `;
}

function semanticScreen(): string {
  return state.overlay === "none" ? state.screen : state.overlay;
}

function render(focusId: string): void {
  document.body.dataset["screen"] = semanticScreen();

  switch (state.screen) {
    case "home":
      app.innerHTML = homeScreen();
      break;
    case "search":
      app.innerHTML = searchScreen();
      break;
    case "details":
      app.innerHTML = detailsScreen();
      break;
    case "player":
      app.innerHTML = playerScreen();
      break;
  }

  window.requestAnimationFrame(() => {
    focusById(focusId);
  });
}

function focusById(id: string): boolean {
  const candidates = app.querySelectorAll<HTMLElement>("[data-tv-id]");
  const target = Array.from(candidates).find((candidate) => candidate.dataset["tvId"] === id);
  if (target === undefined || target.dataset["remote"] !== "true" || target.hasAttribute("disabled")) {
    return false;
  }

  target.focus({ preventScroll: true });
  target.scrollIntoView({ behavior: "instant", block: "nearest", inline: "nearest" });
  return document.activeElement === target;
}

function showToast(message: string): void {
  let toast = document.querySelector<HTMLElement>("#fixture-toast");
  if (toast === null) {
    toast = document.createElement("div");
    toast.id = "fixture-toast";
    toast.className = "toast";
    toast.setAttribute("role", "status");
    document.body.append(toast);
  }

  toast.textContent = message;
  toast.classList.add("is-visible");
  if (toastTimer !== undefined) {
    window.clearTimeout(toastTimer);
  }
  toastTimer = window.setTimeout(() => toast?.classList.remove("is-visible"), 2_200);
}

function moveFocus(direction: Direction): void {
  const active = document.activeElement instanceof HTMLElement
    ? document.activeElement.closest<HTMLElement>("[data-tv-id]")
    : null;
  if (active === null) {
    return;
  }

  const targetId = active.getAttribute(`data-nav-${direction}`);
  if (targetId === null || !focusById(targetId)) {
    showToast(`No ${direction} destination from ${active.dataset["tvId"] ?? "current control"}`);
  }
}

function goTo(screen: Screen, focusId: string): void {
  state.screen = screen;
  state.overlay = "none";
  state.settingsPending = false;
  if (settingsTimer !== undefined) {
    window.clearTimeout(settingsTimer);
    settingsTimer = undefined;
  }
  render(focusId);
}

function handleBack(): void {
  if (state.overlay === "profile-trap") {
    showToast("Back was ignored by the seeded profile focus trap.");
    return;
  }
  if (state.overlay === "caption-appearance") {
    state.overlay = "captions";
    render("captions-appearance");
    return;
  }
  if (state.overlay === "captions") {
    state.overlay = "player-settings";
    render("settings-captions");
    return;
  }
  if (state.overlay === "player-settings") {
    state.overlay = "none";
    render("player-settings");
    return;
  }
  if (state.overlay === "app-settings") {
    state.overlay = "none";
    render("home-nav-settings");
    return;
  }

  switch (state.screen) {
    case "details":
      // Intentionally wrong: a details screen entered from Home should restore Home.
      goTo("search", "search-query");
      showToast("Seeded Back defect: Details returned to Search.");
      break;
    case "home":
      showToast("Already at the fixture start screen.");
      break;
    case "player":
      goTo("details", "details-play");
      break;
    case "search":
      goTo("home", "home-nav-home");
      break;
  }
}

function updatePlayerTime(): void {
  const time = app.querySelector<HTMLElement>("[data-player-time]");
  const progress = app.querySelector<HTMLElement>("[data-player-progress]");
  const progressbar = app.querySelector<HTMLElement>('[role="progressbar"][aria-valuenow]');
  if (time !== null) {
    time.textContent = formatTime(state.elapsedSeconds);
  }
  if (progress !== null) {
    progress.style.width = `${Math.min(100, (state.elapsedSeconds / 6480) * 100)}%`;
  }
  if (progressbar !== null) {
    progressbar.setAttribute("aria-valuenow", String(state.elapsedSeconds));
  }
}

function handleAction(action: string, source: HTMLElement): void {
  switch (action) {
    case "go-home":
      goTo("home", "home-nav-home");
      break;
    case "go-search":
      goTo("search", "search-query");
      break;
    case "open-profile-trap":
      state.overlay = "profile-trap";
      render("profile-primary");
      break;
    case "close-profile":
      state.overlay = "none";
      render("home-nav-library");
      break;
    case "open-app-settings":
      state.overlay = "app-settings";
      render("app-settings-appearance");
      break;
    case "open-details": {
      const contentId = source.dataset["contentId"];
      if (contentId !== undefined) {
        state.selectedContentId = contentId;
      }
      goTo("details", "details-play");
      break;
    }
    case "show-more-info":
      showToast("Pointer opened extra context. No D-pad path reaches this control.");
      break;
    case "preview":
      showToast("Pointer-only preview started for 30 seconds.");
      break;
    case "privacy":
      showToast("The carousel jumped all the way to Privacy.");
      break;
    case "m10-probe-a":
      if (useBaselineRegression) {
        source.blur();
        showToast("Controlled M10 regression removed remote focus.");
      } else {
        showToast("Controlled M10 probe retained remote focus.");
      }
      break;
    case "m10-probe-b":
      showToast("Controlled M10 companion remained focused.");
      break;
    case "play":
      state.playing = true;
      goTo("player", "player-play-pause");
      break;
    case "toggle-play":
      state.playing = !state.playing;
      render("player-play-pause");
      break;
    case "rewind":
      // Intentionally inverted for the player-control seed.
      state.elapsedSeconds = Math.min(6480, state.elapsedSeconds + 10);
      updatePlayerTime();
      showToast("Rewind selected — seeded defect advanced 10 seconds.");
      break;
    case "forward":
      state.elapsedSeconds = Math.min(6480, state.elapsedSeconds + 10);
      updatePlayerTime();
      showToast("Skipped forward 10 seconds.");
      break;
    case "open-player-settings":
      if (state.settingsPending) {
        return;
      }
      state.settingsPending = true;
      render("player-settings");
      settingsTimer = window.setTimeout(() => {
        state.settingsPending = false;
        state.overlay = "player-settings";
        settingsTimer = undefined;
        render("settings-captions");
      }, 1_350);
      break;
    case "open-captions":
      state.overlay = "captions";
      render("captions-off");
      break;
    case "open-caption-appearance":
      state.overlay = "caption-appearance";
      render("caption-font-size");
      break;
    case "captions-off":
      showToast("Captions remain off.");
      break;
    case "captions-english":
      // Deliberate caption menu failure: do not alter the selected track.
      showToast("English requested, but the seeded fixture left captions Off.");
      break;
    case "captions-spanish":
      showToast("Spanish track previewed without saving.");
      break;
    case "caption-text-colour":
      state.captionColourIndex = (state.captionColourIndex + 1) % captionColours.length;
      render("caption-font-size");
      showToast("Pointer changed Text Colour; the remote still cannot reach it.");
      break;
    case "caption-font-size":
    case "caption-background":
    case "caption-edge":
    case "setting":
      showToast("Setting previewed. No persistent account state was changed.");
      break;
    case "volume-boost":
      showToast("Pointer enabled dialogue boost. No remote edge reaches this control.");
      break;
    case "search-character": {
      const character = source.dataset["character"];
      if (character !== undefined && state.searchQuery.length < 16) {
        state.searchQuery += character;
      }
      render(source.dataset["tvId"] ?? "search-query");
      break;
    }
    case "search-delete":
      state.searchQuery = state.searchQuery.slice(0, -1);
      render("search-key-delete");
      break;
    case "search-clear":
      state.searchQuery = "";
      state.searchSubmitted = false;
      render("search-key-clear");
      break;
    case "submit-search":
      state.searchSubmitted = true;
      render("search-query");
      showToast("Pointer submitted the search.");
      break;
    case "episode":
    case "trailer":
    case "watchlist":
      showToast("Demo action completed locally.");
      break;
    case "profile-primary":
    case "profile-kids":
      showToast("Profile selected, but the seeded focus trap remains open.");
      break;
  }
}

app.addEventListener("click", (event) => {
  const target = event.target instanceof Element
    ? event.target.closest<HTMLElement>("[data-action]")
    : null;
  const action = target?.dataset["action"];
  if (target !== null && action !== undefined) {
    handleAction(action, target);
  }
});

window.addEventListener("keydown", (event) => {
  const directionByKey: Readonly<Record<string, Direction | undefined>> = {
    ArrowDown: "down",
    ArrowLeft: "left",
    ArrowRight: "right",
    ArrowUp: "up",
  };
  const direction = directionByKey[event.key];
  if (direction !== undefined) {
    event.preventDefault();
    moveFocus(direction);
    return;
  }

  if (event.key === "Enter") {
    event.preventDefault();
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.click();
    }
    return;
  }

  if (event.key === "Backspace" || event.key === "BrowserBack" || event.key === "Escape" || event.code === "BrowserBack") {
    event.preventDefault();
    handleBack();
  }
});

window.setInterval(() => {
  if (state.screen === "player" && state.playing) {
    state.elapsedSeconds = Math.min(6480, state.elapsedSeconds + 1);
    updatePlayerTime();
  }
}, 1_000);

render(useSemanticAlternateRoute ? "home-card-1" : "home-nav-home");

// Intentionally emitted once. The startup error is a fixture contract for future log capture.
console.error("[Northstar fixture] Seeded startup console error: catalogue sync failed intentionally.");
