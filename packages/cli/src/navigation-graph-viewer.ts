import type { NavigationFocusGraphV2 } from "@tvdoctor/core";

/** This is a review surface, not a second source of navigation evidence. */
const DISPLAY_LIMITS = { focus: 96, edges: 320, problems: 120 } as const;

function encodePayload(value: unknown): string {
  // The graph contains arbitrary page-derived text. Even inside a JSON script
  // element, an unescaped closing tag could execute attacker-controlled HTML.
  return JSON.stringify(value)
    .replace(/&/gu, "\\u0026")
    .replace(/</gu, "\\u003c")
    .replace(/>/gu, "\\u003e")
    .replace(/\u2028/gu, "\\u2028")
    .replace(/\u2029/gu, "\\u2029");
}

export function renderNavigationGraphViewer(
  graph: NavigationFocusGraphV2,
  inputMode: "remote" | "keyboard" = "remote",
): string {
  const nodes = graph.focusTargets.slice(0, DISPLAY_LIMITS.focus).map((target) => ({
    key: target.key,
    screen: target.screenKey,
    role: target.observation.status === "present" ? target.observation.element.role : null,
    name: target.observation.status === "present"
      ? (target.observation.element.name ?? target.observation.element.stableId ?? "Unnamed control")
      : target.observation.status === "missing" ? "No focus" : "Focus unobservable",
    observation: target.observation.status,
    confidence: target.confidence,
    path: target.shortestKnownPath,
  }));
  const keys = new Set(nodes.map((node) => node.key));
  const edges = graph.transitions
    .filter((edge) => keys.has(edge.fromFocusTargetKey) && edge.toFocusTargetKey !== null && keys.has(edge.toFocusTargetKey))
    .slice(0, DISPLAY_LIMITS.edges)
    .map((edge) => ({ from: edge.fromFocusTargetKey, to: edge.toFocusTargetKey, action: edge.action, outcome: edge.outcome }));
  const problems = graph.problems.slice(0, DISPLAY_LIMITS.problems).map((problem) => ({
    kind: problem.kind,
    issueId: problem.issueId,
    confidence: problem.evidenceClassification,
    source: problem.source.focusTargetKey,
    target: problem.target.focusTargetKey,
    actions: problem.reproductionPath,
  }));
  const payload = encodePayload({
    mode: inputMode,
    coverage: graph.coverage,
    frontier: graph.coverageSummary.frontier,
    totals: { screens: graph.screens.length, focus: graph.focusTargets.length, edges: graph.transitions.length, problems: graph.problems.length },
    omitted: {
      focus: Math.max(0, graph.focusTargets.length - nodes.length),
      edges: Math.max(0, graph.transitions.length - edges.length),
      problems: Math.max(0, graph.problems.length - problems.length),
    },
    nodes,
    edges,
    problems,
  });
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer"><title>TVDoctor — Navigation explorer</title>
<style>
:root{color-scheme:dark;font:15px/1.5 ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;background:#0a0e17;color:#edf2ff}
*{box-sizing:border-box}body{margin:0}a{color:#a2dfff}a:hover{color:#fff}button,input,select{font:inherit}button{cursor:pointer}button:focus-visible,input:focus-visible,select:focus-visible,a:focus-visible{outline:2px solid #77dbfc;outline-offset:3px}
.shell{max-width:1460px;margin:auto;padding:34px 30px 60px}.eyebrow{letter-spacing:.17em;text-transform:uppercase;color:#8fb8d5;font-size:11px;font-weight:750}.top{display:flex;justify-content:space-between;gap:16px;align-items:start}.top h1{font-size:clamp(27px,4vw,42px);letter-spacing:-.055em;line-height:1.08;margin:9px 0 10px}.top p{color:#a7b3c9;max-width:700px;margin:0}.nav{display:flex;gap:16px;flex-wrap:wrap;font-size:13px;padding-top:6px}.pills{display:flex;gap:9px;flex-wrap:wrap;margin:22px 0 24px}.pill{border:1px solid #2e3c52;border-radius:999px;padding:6px 11px;color:#bfcde2;font-size:12px}.pill.partial{color:#f8cc80;border-color:#82612d}
.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:23px}.metric{border:1px solid #27344a;border-radius:16px;background:#121c2c;padding:17px 20px}.metric strong{display:block;font-size:30px;line-height:1.2;letter-spacing:-.035em}.metric span{color:#9cabc0;font-size:12px}
.workspace{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:17px;align-items:start}.pane{min-width:0;background:#111a29;border:1px solid #27344a;border-radius:18px;overflow:hidden}.pane-head{padding:19px 20px;border-bottom:1px solid #27344a;display:flex;flex-wrap:wrap;justify-content:space-between;gap:11px;align-items:center}.pane-head h2,.right h2{font-size:16px;margin:0;letter-spacing:-.025em}.controls{display:flex;gap:8px;flex-wrap:wrap}input,select{min-width:0;background:#0a1320;color:#e4ebfa;border:1px solid #35465e;border-radius:9px;padding:9px 11px;font-size:12px}input{width:185px}select{width:155px}.graph-scroll{overflow:auto;max-height:650px;min-height:390px;padding:16px;background:radial-gradient(circle at 30% 10%,#152541 0,#101929 47%,#0d1725 100%)}svg{display:block;overflow:visible} .edge{stroke:#49647e;stroke-width:1.4;opacity:.55}.edge.active{stroke:#55d4ff;stroke-width:2.5;opacity:1}.node{cursor:pointer}.node rect{fill:#192b42;stroke:#42607b;stroke-width:1.4}.node text{fill:#edf2ff;font-family:ui-sans-serif,system-ui,sans-serif;pointer-events:none}.node .sub{fill:#9cb3ce;font-size:10px}.node.active rect{fill:#113653;stroke:#72dcff;stroke-width:2.5}.node.dim{opacity:.22}.empty{padding:65px 22px;text-align:center;color:#b2c0d3}.note{font-size:12px;color:#9facc3;padding:12px 20px;border-top:1px solid #27344a}
.right{padding:20px}.right h2{margin-bottom:16px}.kv{display:flex;justify-content:space-between;gap:10px;border-bottom:1px solid #29394d;padding:10px 0;font-size:12px}.kv span:first-child{color:#a0b2c9}.kv strong{text-align:right;max-width:70%;overflow-wrap:anywhere}.path{font-size:12px;color:#bed2e8;background:#0b1422;padding:11px;border-radius:10px;word-break:break-word;min-height:42px}.issues{margin-top:24px}.issue{width:100%;text-align:left;color:#dfedff;background:#162439;border:1px solid #31465f;padding:12px;border-radius:10px;margin:0 0 8px}.issue:hover{border-color:#73d4ef}.issue b{display:block;font-size:12px}.issue small{display:block;color:#a2b6cb;margin-top:3px}.legend{font-size:11px;color:#91a9c1}.muted{color:#a8b5c8}.key{font-size:12px;color:#d0e4ff;background:#1b324a;border:1px solid #345c7e;padding:3px 7px;border-radius:6px}footer{color:#8fa4bd;font-size:12px;margin-top:20px}
@media(max-width:930px){.workspace{grid-template-columns:1fr}.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.top{flex-direction:column}.graph-scroll{max-height:460px}}@media(max-width:500px){.shell{padding:20px 13px}.metrics{gap:8px}.metric{padding:12px}.metric strong{font-size:24px}.pane-head{padding:14px}.controls{width:100%}input{flex:1;width:auto}select{width:130px}}
</style></head><body>
<main class="shell"><header class="top"><div><div class="eyebrow">TVDOCTOR / LOCAL REPORT</div><h1>Navigation explorer</h1><p>Explore the focus states and transitions actually observed during this scan. Select any control to inspect its shortest known route and connected actions.</p></div><nav class="nav" aria-label="Report files"><a href="./report.html">Full report ↗</a><a href="./navigation-graph.json">Complete JSON ↗</a><a href="./navigation-graph.md">Markdown ↗</a></nav></header>
<div class="pills"><span class="pill" id="mode"></span><span class="pill" id="coverage"></span><span class="pill" id="frontier"></span></div>
<section class="metrics" aria-label="Observed metrics"><div class="metric"><strong id="metric-screens">—</strong><span>Observed screens</span></div><div class="metric"><strong id="metric-focus">—</strong><span>Focus targets</span></div><div class="metric"><strong id="metric-edges">—</strong><span>Observed edges</span></div><div class="metric"><strong id="metric-problems">—</strong><span>Issue annotations</span></div></section>
<div class="workspace"><section class="pane" aria-label="Interactive navigation map"><div class="pane-head"><h2>Focus map</h2><div class="controls"><input type="search" id="search" aria-label="Search controls" placeholder="Search control or screen"><select id="action" aria-label="Filter by action"><option value="">All actions</option></select></div></div><div class="graph-scroll" id="viewport"><svg id="map" role="img" aria-label="Observed focus states and directed transitions"></svg><p class="empty" id="empty" hidden>No observed focus targets match this filter.</p></div><div class="note" id="limits"></div></section>
<aside class="pane right"><h2>Selection</h2><p class="muted" id="intro">Choose a focus target or a reported issue to see its evidence.</p><div id="detail" hidden><div class="kv"><span>Control</span><strong id="detail-name"></strong></div><div class="kv"><span>Screen</span><strong id="detail-screen"></strong></div><div class="kv"><span>Role</span><strong id="detail-role"></strong></div><div class="kv"><span>Observation</span><strong id="detail-state"></strong></div><div class="kv"><span>Confidence</span><strong id="detail-confidence"></strong></div><p class="legend">Shortest observed root-relative path</p><div class="path" id="detail-path"></div><p class="legend" id="detail-connections"></p></div><div class="issues"><h2>Issue annotations</h2><p class="legend">Verified observations and review-only heuristics remain distinct.</p><div id="issues"></div></div></aside></div>
<footer>No inferred transitions are shown. Bounded/partial runs do not imply unvisited controls are safe. Only a subset is drawn for readability; the JSON file retains the full graph.</footer></main>
<script id="graph-data" type="application/json">${payload}</script><script>
'use strict';
const data=JSON.parse(document.getElementById('graph-data').textContent);
const $=id=>document.getElementById(id);const NS='http://www.w3.org/2000/svg';
const setText=(id,value)=>{$(id).textContent=String(value)};
setText('mode',data.mode==='keyboard'?'Keyboard · Tab / Shift+Tab':'Remote · D-pad');
setText('coverage','Coverage: '+data.coverage.toUpperCase());$('coverage').classList.toggle('partial',data.coverage!=='complete');
setText('frontier','Frontier: '+(data.frontier.status==='complete'?'known queue exhausted':data.frontier.reason));
for(const key of ['screens','focus','edges','problems'])setText('metric-'+key,data.totals[key]);
const omitted=[];for(const key of ['focus','edges','problems'])if(data.omitted[key]>0)omitted.push(data.omitted[key]+' '+key+' not drawn');
setText('limits',omitted.length?('Preview limited: '+omitted.join('; ')+'. See complete JSON.'):'All observed focus targets, edges and annotations fit within display limits.');
const actions=[...new Set(data.edges.map(edge=>edge.action))].sort();for(const action of actions){const option=document.createElement('option');option.value=action;option.textContent=action;$('action').append(option)}
const shapes=(tag,attrs={})=>{const el=document.createElementNS(NS,tag);for(const [key,value]of Object.entries(attrs))el.setAttribute(key,String(value));return el};
let selected=null;
function show(node){selected=node.key;$('intro').hidden=true;$('detail').hidden=false;setText('detail-name',node.name);setText('detail-screen',node.screen);setText('detail-role',node.role??'Unavailable');setText('detail-state',node.observation);setText('detail-confidence',node.confidence);setText('detail-path',node.path.length?node.path.join(' → '):'Root observation');const related=data.edges.filter(edge=>edge.from===node.key||edge.to===node.key);setText('detail-connections',related.length+' connected observed edge(s) within this preview');draw()}
function draw(){const query=$('search').value.trim().toLowerCase();const action=$('action').value;const filtered=data.nodes.filter(node=>(!query||[node.name,node.screen,node.role??''].some(value=>value.toLowerCase().includes(query)))&&(!action||data.edges.some(edge=>edge.action===action&&(edge.from===node.key||edge.to===node.key))));$('empty').hidden=filtered.length!==0;
const svg=$('map');svg.replaceChildren();if(filtered.length===0){svg.setAttribute('width','0');svg.setAttribute('height','0');return}const columns=Math.min(4,Math.max(1,Math.ceil(Math.sqrt(filtered.length))));const rows=Math.ceil(filtered.length/columns);const cw=242,ch=112;const width=columns*cw+32,height=rows*ch+24;svg.setAttribute('width',String(width));svg.setAttribute('height',String(height));svg.setAttribute('viewBox','0 0 '+width+' '+height);const locations=new Map();filtered.forEach((node,index)=>locations.set(node.key,{x:16+(index%columns)*cw,y:12+Math.floor(index/columns)*ch}));for(const edge of data.edges){if(action&&edge.action!==action)continue;const from=locations.get(edge.from),to=locations.get(edge.to);if(!from||!to||edge.from===edge.to)continue;const active=selected===edge.from||selected===edge.to;svg.append(shapes('line',{x1:from.x+104,y1:from.y+68,x2:to.x+104,y2:to.y+20,class:'edge'+(active?' active':'')}))}
for(const node of filtered){const pos=locations.get(node.key);const active=selected===node.key;const group=shapes('g',{class:'node'+(active?' active':''),transform:'translate('+pos.x+' '+pos.y+')',tabindex:'0',role:'button','aria-label':node.name+', '+node.role+', select focus state'});group.append(shapes('rect',{width:207,height:76,rx:12}));const name=shapes('text',{x:13,y:29,'font-size':13});name.textContent=node.name.length>25?node.name.slice(0,24)+'…':node.name;group.append(name);const detail=shapes('text',{x:13,y:51,class:'sub'});detail.textContent=(node.role??node.observation)+' · '+node.confidence;group.append(detail);group.addEventListener('click',()=>show(node));group.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();show(node)}});svg.append(group)}
}
for(const problem of data.problems){const button=document.createElement('button');button.type='button';button.className='issue';const kind=document.createElement('b');kind.textContent=problem.kind;const confidence=document.createElement('small');confidence.textContent=(problem.confidence==='heuristic'?'Review-only':'Observed')+' · '+problem.issueId;button.append(kind,confidence);button.addEventListener('click',()=>{const node=data.nodes.find(entry=>entry.key===problem.source)||data.nodes.find(entry=>entry.key===problem.target);if(node){$('search').value='';$('action').value='';show(node)}else setText('intro','Issue is outside the bounded graph preview. Open the full report.')});$('issues').append(button)}
if(data.problems.length===0){const note=document.createElement('p');note.className='muted';note.textContent='No evidence-backed issue annotations were generated.';$('issues').append(note)}
$('search').addEventListener('input',draw);$('action').addEventListener('change',draw);draw();
</script></body></html>\n`;
}
