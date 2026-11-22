/* global document, window, location, history, URLSearchParams, setTimeout, requestAnimationFrame */
(() => {
  "use strict";
  const roots = ["knowledge", "inbox", "events", "explorer"];
  const aliases = { knowledge: "Atlas Docs", inbox: "Tandem Projects", events: "Fieldnotes Events", explorer: "Meridian Data" };
  const mainPart = location.pathname.split("/").filter(Boolean)[0] ?? "knowledge";
  const app = mainPart.replace(/-fixed$/u, "");
  const fixed = mainPart.endsWith("-fixed") || new URLSearchParams(location.search).get("fixed") === "1";
  const prefix = "/" + app + (fixed ? "-fixed" : "");
  const route = () => location.pathname.slice(prefix.length).replace(/^\/+/u, "");
  const isolatedBackState = app === "explorer" && (["back-state", "back-state/reports"].includes(route())
    || /^nested-history(?:\/projects(?:\/report)?)?$/u.test(route()));
  const root = document.getElementById("app");
  if (!roots.includes(app)) throw new Error("Unknown lab scenario");
  document.body.dataset.app = app;
  document.body.dataset.fixed = String(fixed);
  document.body.dataset.challenge = route();
  document.title = aliases[app] + " · Local reliability fixture";
  const nav = roots.map((name) => {
    const href = "/" + name + (fixed ? "-fixed" : "");
    if (isolatedBackState) return '<span class="lab-nav-label">' + aliases[name] + '</span>';
    return '<a href="' + href + '"' + (app === name ? ' aria-current="page"' : "") + ">" + aliases[name] + "</a>";
  }).join("");
  root.innerHTML = '<div class="shell" id="shell">' +
    '<aside class="rail"><div class="brand">FIELD<span>LAB</span> / 02</div>' +
    '<div class="rail-sub">CONTROLLED WEB RELIABILITY SUITE</div><nav aria-label="Local scenarios">' + nav +
    '</nav><div class="rail-note">All records are fictional. UI actions affect only in-memory demo state. No external requests or purchases.</div></aside>' +
    '<main class="main"><header class="header"><span class="breadcrumb">LAB / ' + aliases[app] +
    '</span><span class="header-right"><span class="pill">LOCAL</span>' +
    '<span class="pill ' + (fixed ? "" : "negative") + '">' + (fixed ? "REPAIRED" : "SEEDED FAULTS") +
    '</span></span></header><div class="variant"><span>' +
    (fixed ? "Fixed behaviour for reproducible comparison." : "Deliberately defective variant. Browser evidence is the ground truth.") +
    '</span>' + (isolatedBackState
      ? '<span>Dedicated safe navigation checkpoint</span>'
      : '<a href="/' + app + (fixed ? "" : "-fixed") + '">' +
        (fixed ? "Open broken variant" : "Open repaired variant") + ' ↗</a>') +
    '</div><div id="view"></div></main></div>' +
    '<div id="modal-layer" class="dialog-overlay" hidden><section id="current-dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" class="dialog">' +
    '<p class="eyebrow">Local simulated dialog</p><h2 id="dialog-title">Review details</h2><p id="dialog-copy">All information is fictional.</p>' +
    '<div class="dialog-actions"><button type="button" class="button" id="modal-secondary">Read details</button>' +
    '<button type="button" class="button dark" id="modal-close">Close dialog</button></div></section></div>';
  const shell = document.getElementById("shell");
  const view = document.getElementById("view");
  const modalLayer = document.getElementById("modal-layer");
  const modalClose = document.getElementById("modal-close");
  const modalSecondary = document.getElementById("modal-secondary");
  let openedFrom = null;
  let modalOpen = false;
  let challengeMenuExpanded = false;
  const htmlSafe = (raw) => String(raw).replace(/[&<>"']/gu, (key) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[key]);
  function showModal(title, details, trigger = null) {
    openedFrom = trigger ?? document.activeElement;
    document.getElementById("dialog-title").textContent = title;
    document.getElementById("dialog-copy").textContent = details;
    modalLayer.hidden = false;
    modalOpen = true;
    shell.inert = fixed;
    modalClose.focus();
  }
  function closeModal() {
    modalOpen = false;
    modalLayer.hidden = true;
    shell.inert = false;
    if (fixed && openedFrom?.isConnected) openedFrom.focus();
  }
  modalClose.addEventListener("click", closeModal);
  modalSecondary.addEventListener("click", () => { modalSecondary.textContent = "Details read"; });
  document.addEventListener("keydown", (event) => {
    if (!modalOpen) return;
    if (event.key === "Escape") { event.preventDefault(); closeModal(); return; }
    if (!fixed || event.key !== "Tab") return;
    if (!event.shiftKey && document.activeElement === modalClose) {
      event.preventDefault(); modalSecondary.focus();
    } else if (event.shiftKey && document.activeElement === modalSecondary) {
      event.preventDefault(); modalClose.focus();
    }
  });

  // Explicit, non-destructive SPA challenge. It uses only same-document History
  // routes, a semantic menu and a fixed 120ms optimistic view transition.
  // Neither the source scan nor its browser tests have to activate arbitrary
  // forms, destructive links, or cross-site navigation.
  function renderJourney() {
    const isInbox = app === "inbox";
    const choices = isInbox ? [["team", "Team inbox"], ["mine", "Assigned to me"]]
      : [["music", "Music events"], ["outdoor", "Outdoor events"]];
    const current = route().split("/")[1] ?? "overview";
    const currentTitle = choices.find(([id]) => id === current)?.[1] ?? "All activity";
    view.innerHTML = '<p class="eyebrow">' + (isInbox ? "Tandem / inbox routes" : "Fieldnotes / event routes") + '</p>' +
      '<h1>Workspace folders</h1><p class="lead">A bounded local optimistic SPA route challenge with same-document history and nested menu.</p>' +
      '<section class="panel padded" id="journey-surface"><div class="toolbar">' +
      '<div class="menu-holder"><button class="button" type="button" id="challenge-menu" aria-haspopup="menu" aria-controls="challenge-submenu" aria-expanded="' +
      challengeMenuExpanded + '">Browse folders</button><nav class="popup-menu" role="menu" id="challenge-submenu" ' +
      (challengeMenuExpanded ? "" : "hidden") + ' aria-label="Local workspace folders">' +
      choices.map(([id, name]) => '<a role="menuitem" data-journey-link href="' + prefix + '/journey/' + id + '">' +
        name + "</a>").join("") + '</nav></div></div>' +
      '<h2 id="journey-heading">' + currentTitle + '</h2>' +
      '<p id="journey-status" role="status" class="status">Route ready · ' + current + '</p>' +
      '<p class="muted">The displayed folder follows browser Back only when route restoration is correctly implemented.</p>' +
      '<div class="board"><div class="lane"><div class="ticket"><h3>Recent notes</h3><p>Local generated text only</p></div></div>' +
      '<div class="lane"><div class="ticket"><h3>Team updates</h3><p>Read-only synthetic workspace</p></div></div></div></section>';
    const menuButton = document.getElementById("challenge-menu");
    menuButton.addEventListener("click", () => {
      challengeMenuExpanded = !challengeMenuExpanded;
      document.getElementById("challenge-submenu").hidden = !challengeMenuExpanded;
      if (fixed || challengeMenuExpanded) menuButton.setAttribute("aria-expanded", String(challengeMenuExpanded));
    });
    view.querySelectorAll("[data-journey-link]").forEach((link) => link.addEventListener("click", (event) => {
      event.preventDefault();
      history.pushState({ labRoute: true }, "", link.href);
      document.getElementById("journey-status").textContent = "Loading selected folder…";
      setTimeout(() => {
        challengeMenuExpanded = false;
        if (route().startsWith("journey")) renderJourney();
      }, 120);
    }));
  }
  if (["inbox", "events"].includes(app) && route().startsWith("journey")) {
    renderJourney();
    if (fixed) window.addEventListener("popstate", () => {
      challengeMenuExpanded = false;
      renderJourney();
    });
    return;
  }

  // Browser Back checkpoint isolated from the explorer's separate menu and
  // modal bugs. The one visible anchor produces only History.pushState and an
  // asynchronous in-memory render. The repaired variant handles popstate;
  // the broken variant deliberately leaves the previous view on screen.
  if (app === "explorer" && ["back-state", "back-state/reports"].includes(route())) {
    let renderEpoch = 0;
    function renderBackState() {
      const report = route() === "back-state/reports";
      const state = report ? "reports" : "overview";
      view.innerHTML = '<p class="eyebrow">Meridian / history restoration checkpoint</p>' +
        '<h1 id="back-state-heading">' + (report ? "Review reports" : "Records overview") + '</h1>' +
        '<p class="lead">Inspect a safe same-document route and browser Back after a delayed local view update.</p>' +
        '<section class="panel padded" id="back-state-surface" data-view-state="' + state + '">' +
        '<nav aria-label="History checkpoint actions"><a id="back-state-link" href="' +
        prefix + (report ? "/back-state" : "/back-state/reports") + '" data-history-challenge>' +
        (report ? "Records overview" : "Review reports") + '</a></nav>' +
        '<p id="back-state-status" role="status" class="status">Ready · ' + state + '</p>' +
        '<p class="muted">Read-only local records. No submit, purchase, delete or external network actions.</p>' +
        '</section>';
      view.querySelector("[data-history-challenge]").addEventListener("click", (event) => {
        event.preventDefault();
        const anchor = event.currentTarget;
        history.pushState({ fixtureBackState: true }, "", anchor.href);
        const epoch = ++renderEpoch;
        document.getElementById("back-state-status").textContent = "Loading local section…";
        setTimeout(() => {
          if (epoch === renderEpoch) renderBackState();
        }, 140);
      });
    }
    renderBackState();
    if (fixed) window.addEventListener("popstate", () => {
      ++renderEpoch;
      document.getElementById("back-state-status").textContent = "Restoring local section…";
      setTimeout(renderBackState, 90);
    });
    return;
  }

  // Nested History API fixture: two genuine forward pushes, then browser Back
  // over nested routes. A delayed project restoration makes a second Back
  // before the callback finishes an explicit interrupted-restoration case.
  // No forms, external URLs, network requests, or destructive operations.
  if (app === "explorer" && /^nested-history(?:\/projects(?:\/report)?)?$/u.test(route())) {
    const nestedBase = prefix + "/nested-history";
    const screens = {
      overview: { title: "Workspaces overview", caption: "Recent teams and activity summaries.", next: "projects", link: "Open product team" },
      projects: { title: "Product team", caption: "Project planning and review information.", next: "report", link: "Open quarterly report" },
      report: { title: "Quarterly activity report", caption: "Read-only milestones and generated status.", next: "overview", link: "Workspace overview" },
    };
    let nestedEpoch = 0;
    const screenPath = (name) => nestedBase + (name === "overview" ? "" : name === "projects" ? "/projects" : "/projects/report");
    const routeScreen = () => route() === "nested-history/projects/report" ? "report"
      : route() === "nested-history/projects" ? "projects" : "overview";
    function renderNested(name) {
      const screen = screens[name];
      view.innerHTML = '<p class="eyebrow">Meridian / nested workspace history</p>' +
        '<h1 id="nested-heading">' + screen.title + '</h1>' +
        '<p class="lead">' + screen.caption + ' This checkpoint changes client-side history without network navigation.</p>' +
        '<section class="panel padded" id="nested-surface" data-view-state="' + name + '">' +
        '<nav aria-label="Nested workspace journey"><a id="nested-link" href="' +
        screenPath(screen.next) + '">' + screen.link + '</a></nav>' +
        '<p class="status" role="status" id="nested-status">Ready · ' + name + '</p>' +
        '<p class="muted">Synthetic team records · read only · no external calls or submissions</p>' +
        '<div class="board"><div class="lane"><div class="ticket"><h3>Current activity</h3>' +
        '<p>Generated local workspace summary</p></div></div>' +
        '<div class="lane"><div class="ticket"><h3>Review notes</h3>' +
        '<p>Planning notes and sample status only</p></div></div></div></section>';
      document.getElementById("nested-link").addEventListener("click", (event) => {
        event.preventDefault();
        history.pushState({ nestedFixture: true }, "", event.currentTarget.href);
        const epoch = ++nestedEpoch;
        document.getElementById("nested-status").textContent = "Loading local workspace…";
        setTimeout(() => { if (epoch === nestedEpoch) renderNested(routeScreen()); }, 140);
      });
    }
    renderNested(routeScreen());
    window.addEventListener("popstate", () => {
      const desired = routeScreen();
      const epoch = ++nestedEpoch;
      if (fixed) {
        document.getElementById("nested-status").textContent = "Restoring local workspace…";
        setTimeout(() => {
          if (epoch === nestedEpoch && routeScreen() === desired) renderNested(desired);
        }, desired === "projects" ? 680 : 90);
      } else if (desired === "projects") {
        // Seeded interruption bug: pending project restoration survives a
        // second browser Back and paints the now-incorrect project heading.
        setTimeout(() => { renderNested("projects"); }, 680);
      }
      // Broken root restoration does nothing, leaving the most recent view
      // rendered even when the browser URL has already returned to overview.
    });
    return;
  }

  let knowledgeExpanded = false;
  const articles = {
    "guide/start": ["Getting started", "Build your first knowledge base with clear pages, nested topics and deliberate navigation."],
    "guide/advanced": ["Advanced search", "Use structured tags and small collections to find relevant information quickly."],
    policy: ["Access guide", "Review permissions and follow the sample navigation workflow in this local workspace."],
  };
  function renderKnowledge() {
    const entry = location.hash.slice(1) || "guide/start";
    const article = articles[entry] ?? articles["guide/start"];
    view.innerHTML = '<p class="eyebrow">Atlas / knowledge workspace</p><h1>Answers with a home.</h1>' +
      '<p class="lead">Navigate nested documentation pages using hash routes, expand a topic tree and open keyboard-accessible reader help.</p>' +
      '<div class="two-col"><aside class="panel padded list-panel"><h2>Knowledge tree</h2><div class="tree">' +
      '<button type="button" id="knowledge-menu" aria-controls="knowledge-tree" aria-expanded="' + knowledgeExpanded + '">Open menu</button>' +
      '<nav class="tree-nested" id="knowledge-tree" aria-label="Knowledge topics"' + (knowledgeExpanded ? "" : " hidden") + '>' +
      '<a href="#guide/start" data-doc-link ' + (entry === "guide/start" ? 'aria-current="page"' : "") + '>Welcome guide</a>' +
      '<a href="#guide/advanced" data-doc-link ' + (entry === "guide/advanced" ? 'aria-current="page"' : "") + '>Advanced topics</a>' +
      '<a href="#policy" data-doc-link ' + (entry === "policy" ? 'aria-current="page"' : "") + '>Access guide</a></nav>' +
      '<button type="button" id="knowledge-help" aria-controls="current-dialog" aria-haspopup="dialog" aria-expanded="false">Open dialog</button>' +
      '</div></aside><article class="panel padded article" id="article">' +
      '<p class="eyebrow">Docs / ' + htmlSafe(entry) + '</p><h2 id="article-heading">' + article[0] + '</h2>' +
      '<p>' + article[1] + '</p><p>Each topic is addressable with a client-side hash. Use browser Back to revisit your reading path.</p>' +
      '<p class="meta">Local content · Revision 06</p><div class="callout">Try navigating to a nested topic using the left-hand tree.</div></article></div>';
    const menu = document.getElementById("knowledge-menu");
    menu.addEventListener("click", () => {
      knowledgeExpanded = !knowledgeExpanded;
      document.getElementById("knowledge-tree").hidden = !knowledgeExpanded;
      if (fixed || knowledgeExpanded) menu.setAttribute("aria-expanded", String(knowledgeExpanded));
    });
    const help = document.getElementById("knowledge-help");
    help.addEventListener("click", () => showModal("Reader help", "Use the tree to explore hash-routed articles.", help));
    if (route() === "dialog" && !modalOpen) showModal("Reader help", "Use the tree to explore hash-routed articles.", help);
  }

  const cards = [
    { id: 1, title: "Review the accessibility map", lane: "Incoming", owner: "Me", urgent: true },
    { id: 2, title: "Reconcile the weekly backlog", lane: "Incoming", owner: "Team", urgent: false },
    { id: 3, title: "Check tablet navigation", lane: "In progress", owner: "Me", urgent: true },
    { id: 4, title: "Summarise design feedback", lane: "In progress", owner: "Team", urgent: false },
    { id: 5, title: "Publish internal notes", lane: "Resolved", owner: "Me", urgent: false },
    { id: 6, title: "Verify project tags", lane: "Resolved", owner: "Team", urgent: false },
  ];
  let inboxFilter = "All";
  let filterGeneration = 0;
  function inboxCards() {
    const allowed = cards.filter((card) => inboxFilter === "All" ||
      (inboxFilter === "Mine" ? card.owner === "Me" : card.urgent));
    return ["Incoming", "In progress", "Resolved"].map((lane) =>
      '<section class="lane" aria-label="' + lane + '"><div class="lane-header"><span>' + lane + '</span><span>' +
      allowed.filter((card) => card.lane === lane).length + "</span></div>" +
      allowed.filter((card) => card.lane === lane).map((card) =>
        '<article class="ticket" data-card="' + card.id + '"><h3>' + htmlSafe(card.title) + '</h3><p>' +
        card.owner + " · " + lane + '</p><span class="ticket-flag">' +
        (card.urgent ? "PRIORITY" : "IN PROGRESS") + "</span></article>").join("") + "</section>").join("");
  }
  function renderInbox() {
    view.innerHTML = '<p class="eyebrow">Tandem / team inbox</p><h1>Keep work moving.</h1>' +
      '<p class="lead">A local issue board with delayed optimistic filter updates. All records stay in browser memory.</p>' +
      '<div class="inbox-summary"><article class="panel padded metric"><span>Open threads</span><strong>24</strong></article>' +
      '<article class="panel padded metric"><span>Response time</span><strong>2.3h</strong></article>' +
      '<article class="panel padded metric"><span>Resolved this week</span><strong>18</strong></article></div>' +
      '<div class="toolbar" id="inbox-toolbar"><div class="filters" role="group" aria-label="Inbox filters">' +
      ["All", "Mine", "Urgent"].map((name) =>
        '<button type="button" class="button ' + (name === inboxFilter ? "active" : "") +
        '" data-inbox-filter="' + name + '" aria-pressed="' + (name === inboxFilter) + '">' + name + "</button>").join("") +
      '</div><div class="spacer"></div><button type="button" id="inbox-dialog" class="button dark" aria-controls="current-dialog" aria-haspopup="dialog">Open dialog</button></div>' +
      '<div class="status" id="inbox-status" role="status">Showing ' + inboxFilter + ' threads</div>' +
      '<div class="board" id="inbox-board">' + inboxCards() + '</div>';
    view.querySelectorAll("[data-inbox-filter]").forEach((button) => {
      button.addEventListener("click", () => {
        inboxFilter = button.dataset.inboxFilter;
        const generation = ++filterGeneration;
        document.getElementById("inbox-status").textContent = "Applying " + inboxFilter + " filter…";
        const activeBefore = document.activeElement === button;
        setTimeout(() => {
          if (generation !== filterGeneration) return;
          if (!fixed) {
            // Seeded defect: replacing toolbar loses the focused control during optimistic completion.
            renderInbox();
          } else {
            document.getElementById("inbox-board").innerHTML = inboxCards();
            document.getElementById("inbox-status").textContent = "Showing " + inboxFilter + " threads";
            view.querySelectorAll("[data-inbox-filter]").forEach((item) => {
              item.setAttribute("aria-pressed", String(item.dataset.inboxFilter === inboxFilter));
              item.classList.toggle("active", item.dataset.inboxFilter === inboxFilter);
            });
            if (activeBefore) button.focus();
          }
        }, 180);
      });
    });
    const dialogButton = document.getElementById("inbox-dialog");
    dialogButton.addEventListener("click", () => showModal("Thread overview", "This simulated conversation has no reply or send action.", dialogButton));
    if (route() === "dialog" && !modalOpen) showModal("Thread overview", "This simulated conversation has no reply or send action.", dialogButton);
  }

  const events = [
    { name: "Botanical Night Walk", category: "Outdoor", where: "Bristol", icon: "✦" },
    { name: "Midnight Vinyl Rooms", category: "Music", where: "Manchester", icon: "♪" },
    { name: "Coastal Lantern Trail", category: "Outdoor", where: "Brighton", icon: "◈" },
    { name: "Electric Strings Live", category: "Music", where: "Leeds", icon: "♫" },
    { name: "Comedy Under the Stars", category: "Comedy", where: "York", icon: "◉" },
    { name: "Stand-Up Sessions", category: "Comedy", where: "London", icon: "✺" },
  ];
  let eventCategory = "All";
  let drawerCategory = "All";
  function renderEventCards() {
    return events.filter((entry) => eventCategory === "All" || entry.category === eventCategory)
      .map((entry) => '<article class="panel event-card"><div class="event-art" aria-hidden="true">' + entry.icon +
        '</div><div class="event-copy"><h3>' + entry.name + '</h3><span>' + entry.where + ' · ' + entry.category +
        ' · Local example</span><a href="#events-top" data-event-reference>Explore details</a></div></article>').join("");
  }
  function renderEvents() {
    view.innerHTML = '<p class="eyebrow">Fieldnotes / UK culture & nature</p><h1 id="events-top">Find your next story.</h1>' +
      '<p class="lead">A fictional event finder with client-side category updates, a sticky filter drawer and nested scrolling.</p>' +
      '<div class="toolbar"><div class="filters" role="group" aria-label="Event categories">' +
      ["All", "Outdoor", "Music", "Comedy"].map((name) =>
        '<button class="button ' + (name === eventCategory ? "active" : "") + '" type="button" data-event-filter="' + name +
        '" aria-pressed="' + (name === eventCategory) + '">' + name + "</button>").join("") +
      '</div><div class="spacer"></div><a href="#drawer" id="drawer-anchor">Filter options</a></div>' +
      '<div class="events-layout"><div><div class="event-grid" id="event-results">' + renderEventCards() + '</div>' +
      '<div class="tip">This catalogue does not sell tickets or collect personal information.</div></div>' +
      '<aside class="drawer" id="drawer"><div class="panel-top"><h2>Explore filters</h2></div>' +
      '<p class="muted">Scroll to discover all interests.</p>' +
      '<div class="drawer-scroll" id="drawer-scroll" tabindex="0" aria-label="Scrollable event category options">' +
      ["All", "Outdoor", "Music", "Comedy", "Architecture", "Museums"].map((name) =>
        '<label><input type="radio" name="event-interest" value="' + name + '"' +
        (name === drawerCategory ? " checked" : "") + '><span>' + name + "</span></label>").join("") +
      '</div><div class="drawer-action" id="drawer-action"><button type="button" id="apply-events" class="button dark">Apply filters</button></div></aside></div>';
    view.querySelectorAll("[data-event-filter]").forEach((button) => button.addEventListener("click", () => {
      eventCategory = button.dataset.eventFilter;
      renderEvents();
    }));
    view.querySelectorAll('input[name="event-interest"]').forEach((radio) => radio.addEventListener("change", () => {
      drawerCategory = radio.value;
    }));
    document.getElementById("apply-events").addEventListener("click", () => {
      eventCategory = ["All", "Outdoor", "Music", "Comedy"].includes(drawerCategory) ? drawerCategory : "All";
      renderEvents();
    });
    if (route() === "scroll-end" || route() === "scroll-clean") {
      // Makes a nested scroll checkpoint directly scannable without a query
      // string, arbitrary user actions or cross-site network requests.
      requestAnimationFrame(() => {
        const scroller = document.getElementById("drawer-scroll");
        if (scroller) {
          scroller.scrollTop = scroller.scrollHeight;
          scroller.scrollIntoView({ block: "start", behavior: "instant" });
        }
      });
    }
  }

  const collections = {
    overview: ["Records overview", "Recent activity and organisation totals."],
    reports: ["Review reports", "Recent reports across departments."],
    teams: ["Team directory", "Synthetic owner metadata for demonstration."],
  };
  let explorerMenu = false;
  let explorerRendered = 0;
  const entries = [
    ["R-2048", "Project overview", "Operations", "Ready"],
    ["R-2049", "Weekly reporting", "Finance", "Review"],
    ["R-2050", "Design inventory", "Product", "Ready"],
    ["R-2051", "Data quality", "Operations", "Review"],
    ["R-2052", "Access map", "People", "Ready"],
  ];
  function explorerSection() {
    const active = ["reports", "teams"].includes(route()) ? route() : "overview";
    return collections[active];
  }
  function renderExplorer() {
    const [title, description] = explorerSection();
    explorerRendered += 1;
    view.innerHTML = '<p class="eyebrow">Meridian / administration explorer</p><h1 id="explorer-heading">' + title + '</h1>' +
      '<p class="lead">' + description + ' Client-side History API routes have deterministic forward and Back behaviour.</p>' +
      '<nav class="toolbar" aria-label="Explorer sections"><a href="' + prefix + '" data-explorer-link class="button">Overview</a>' +
      '<div class="menu-holder"><button type="button" class="button" id="explorer-menu" aria-haspopup="menu" aria-controls="explorer-submenu" aria-expanded="' + explorerMenu + '">Open menu</button>' +
      '<div id="explorer-submenu" role="menu" class="popup-menu" ' + (explorerMenu ? "" : "hidden") + '>' +
      '<a role="menuitem" data-explorer-link href="' + prefix + '/reports">Review reports</a>' +
      '<a role="menuitem" data-explorer-link href="' + prefix + '/teams">Team directory</a></div></div>' +
      '<button type="button" id="explorer-dialog" class="button" aria-controls="current-dialog" aria-haspopup="dialog">Open dialog</button>' +
      '</nav><section class="panel padded"><div class="toolbar"><h2>Data explorer</h2><span class="spacer"></span><span class="pill">Read only</span></div>' +
      '<div class="table-scroller"><table class="data-table"><thead><tr><th>Identifier</th><th>Dataset</th><th>Team</th><th>Status</th></tr></thead><tbody>' +
      entries.map((row) => "<tr>" + row.map((cell) => "<td>" + htmlSafe(cell) + "</td>").join("") + "</tr>").join("") +
      '</tbody></table></div></section><div class="tip">Unsafe route canary for the scanner: <a href="/explorer/delete" id="unsafe-route">Delete records</a> is a blocked local GET route. No destructive handler exists.</div>' +
      '<p class="status" id="render-number">Client view revision ' + explorerRendered + "</p>";
    const toggle = document.getElementById("explorer-menu");
    toggle.addEventListener("click", () => {
      explorerMenu = !explorerMenu;
      document.getElementById("explorer-submenu").hidden = !explorerMenu;
      if (fixed || explorerMenu) toggle.setAttribute("aria-expanded", String(explorerMenu));
    });
    view.querySelectorAll("[data-explorer-link]").forEach((link) => link.addEventListener("click", (event) => {
      event.preventDefault();
      history.pushState({ local: true }, "", link.href);
      explorerMenu = false;
      renderExplorer();
    }));
    const modalButton = document.getElementById("explorer-dialog");
    modalButton.addEventListener("click", () => showModal("Dataset details", "Metadata is fictional and read-only.", modalButton));
    if (route() === "dialog" && !modalOpen) showModal("Dataset details", "Metadata is fictional and read-only.", modalButton);
  }
  if (app === "knowledge") {
    renderKnowledge();
    window.addEventListener("hashchange", renderKnowledge);
  }
  if (app === "inbox") renderInbox();
  if (app === "events") renderEvents();
  if (app === "explorer") {
    renderExplorer();
    if (fixed) window.addEventListener("popstate", renderExplorer);
    // In the broken variant, the browser URL changes on Back but the rendered heading stays stale.
  }
})();
