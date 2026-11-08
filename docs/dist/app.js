(()=>{var HTML_ESCAPES={"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"};function esc(value){return value.replace(/[&<>"']/g,c=>HTML_ESCAPES[c])}function fmtTime(sec,digits=3){return sec>0&&Number.isFinite(sec)?sec.toFixed(digits):"\u2014"}function fmtDelta(sec,digits=3){return Number.isFinite(sec)?Math.abs(sec)<5e-4?"\xB10.000":`${sec>0?"+":"\u2212"}${Math.abs(sec).toFixed(digits)}`:"\u2014"}function fmtAgo(sec){return Number.isFinite(sec)?sec<60?`${Math.round(sec)}s ago`:sec<3600?`${Math.floor(sec/60)}m ago`:`${Math.floor(sec/3600)}h ago`:"not flown yet"}function fmtRaceClock(sec){let s=Math.max(0,sec),minutes=Math.floor(s/60),rest=s-minutes*60;return`${String(minutes).padStart(2,"0")}:${rest.toFixed(1).padStart(4,"0")}`}var activePopover=null,activeSelect=null,cleanupListeners=null,upgradedSelects=new WeakMap;function closeCustomSelect(){if(cleanupListeners&&(cleanupListeners(),cleanupListeners=null),activePopover&&(activePopover.remove(),activePopover=null),activeSelect){activeSelect.classList.remove("is-custom-open");let state=upgradedSelects.get(activeSelect);state&&(state.trigger.classList.remove("is-custom-select-open"),state.trigger.setAttribute("aria-expanded","false")),activeSelect=null}}function positionPopover(anchorEl,popover){let rect=anchorEl.getBoundingClientRect(),vw=window.innerWidth,vh=window.innerHeight,margin=10,minW=Math.min(vw-margin*2,Math.max(rect.width,220)),maxW=vw-margin*2;popover.style.minWidth=`${Math.round(minW)}px`,popover.style.maxWidth=`${Math.round(maxW)}px`;let popRect=popover.getBoundingClientRect(),popW=Math.min(maxW,Math.max(minW,popRect.width||minW)),left=rect.left;left+popW>vw-margin&&(left=Math.max(margin,vw-margin-popW)),left=Math.max(margin,left);let spaceBelow=vh-rect.bottom-margin,spaceAbove=rect.top-margin,openAbove=spaceBelow<200&&spaceAbove>spaceBelow,availH=Math.max(140,Math.min(320,openAbove?spaceAbove-6:spaceBelow-6));popover.style.maxHeight=`${Math.round(availH)}px`,popover.style.left=`${Math.round(left)}px`,openAbove?(popover.style.top="auto",popover.style.bottom=`${Math.round(vh-rect.top+6)}px`):(popover.style.bottom="auto",popover.style.top=`${Math.round(rect.bottom+6)}px`)}function openCustomSelect(selectEl){if(selectEl.disabled)return;if(activeSelect===selectEl){closeCustomSelect();return}closeCustomSelect();let state=upgradedSelects.get(selectEl),anchorEl=state?state.trigger:selectEl;activeSelect=selectEl,selectEl.classList.add("is-custom-open"),state&&(state.trigger.classList.add("is-custom-select-open"),state.trigger.setAttribute("aria-expanded","true"));let popover=document.createElement("div");popover.className="custom-select-popover",popover.setAttribute("role","listbox");let renderOption=(opt,idx)=>{let isSelected=opt.selected||opt.value===selectEl.value,isDisabled=opt.disabled;return`
      <button
        type="button"
        role="option"
        class="custom-select-option ${isSelected?"is-selected":""}"
        data-opt-index="${idx}"
        aria-selected="${isSelected}"
        ${isDisabled?"disabled":""}
      >
        <span class="custom-select-opt-text">${esc(opt.textContent??opt.label)}</span>
        <span class="custom-select-opt-check" aria-hidden="true">${isSelected?"\u2713":""}</span>
      </button>`},allOptions=Array.from(selectEl.options),html="";for(let child of Array.from(selectEl.children))if(child instanceof HTMLOptGroupElement){let groupOpts=Array.from(child.children).filter(c=>c instanceof HTMLOptionElement);if(groupOpts.length===0)continue;html+=`
        <div class="custom-select-group">
          <div class="custom-select-group-label">${esc(child.label)}</div>
          ${groupOpts.map(opt=>renderOption(opt,allOptions.indexOf(opt))).join("")}
        </div>`}else child instanceof HTMLOptionElement&&(html+=renderOption(child,allOptions.indexOf(child)));popover.innerHTML=html,document.body.appendChild(popover),activePopover=popover,positionPopover(anchorEl,popover);let selectedEl=popover.querySelector(".custom-select-option.is-selected");selectedEl&&selectedEl.scrollIntoView({block:"nearest"}),popover.addEventListener("click",e=>{let btn=e.target.closest("[data-opt-index]");if(!btn||btn.disabled)return;let idx=Number(btn.dataset.optIndex),opt=selectEl.options[idx];if(!opt)return;let changed=selectEl.selectedIndex!==idx||selectEl.value!==opt.value;selectEl.selectedIndex=idx,selectEl.value=opt.value,state?.sync(),closeCustomSelect(),changed&&(selectEl.dispatchEvent(new Event("input",{bubbles:!0})),selectEl.dispatchEvent(new Event("change",{bubbles:!0})))});let onDocPointerDown=e=>{let t=e.target;t&&(popover.contains(t)||anchorEl.contains(t)||selectEl.contains(t)||closeCustomSelect())},onKeyDown=e=>{e.key==="Escape"&&(e.preventDefault(),closeCustomSelect())},onReposition=e=>{if(!(e.type==="scroll"&&e.target instanceof Node&&popover.contains(e.target))){if(!document.body.contains(selectEl)){closeCustomSelect();return}positionPopover(anchorEl,popover)}};window.addEventListener("pointerdown",onDocPointerDown,!0),window.addEventListener("keydown",onKeyDown,!0),window.addEventListener("resize",onReposition,{passive:!0}),window.addEventListener("scroll",onReposition,!0),cleanupListeners=()=>{window.removeEventListener("pointerdown",onDocPointerDown,!0),window.removeEventListener("keydown",onKeyDown,!0),window.removeEventListener("resize",onReposition),window.removeEventListener("scroll",onReposition,!0)}}function upgradeSelectElement(selectEl){let existing=upgradedSelects.get(selectEl);if(existing){existing.sync();return}let parent=selectEl.parentElement;if(!parent)return;let wrapper=document.createElement("div");wrapper.className="custom-select-wrap",selectEl.classList.contains("flasher-ssid-select")&&wrapper.classList.add("flasher-ssid-select"),selectEl.classList.contains("gate-puck-select")&&wrapper.classList.add("gate-puck-select");let trigger=document.createElement("button");trigger.type="button",trigger.className="input custom-select-trigger",trigger.setAttribute("aria-haspopup","listbox"),trigger.setAttribute("aria-expanded","false");let labelSpan=document.createElement("span");labelSpan.className="custom-select-trigger-label";let caretSpan=document.createElement("span");caretSpan.className="custom-select-trigger-caret",caretSpan.setAttribute("aria-hidden","true"),trigger.appendChild(labelSpan),trigger.appendChild(caretSpan),parent.insertBefore(wrapper,selectEl),wrapper.appendChild(selectEl),wrapper.appendChild(trigger),selectEl.classList.add("is-custom-upgraded"),selectEl.tabIndex=-1;let sync=()=>{let selectedOpt=selectEl.selectedOptions[0]??selectEl.options[selectEl.selectedIndex];labelSpan.textContent=selectedOpt?selectedOpt.textContent??selectedOpt.label:"",trigger.disabled=selectEl.disabled,trigger.title=selectEl.title||"",trigger.classList.toggle("mono",selectEl.classList.contains("mono")),trigger.classList.toggle("input-warn",selectEl.classList.contains("input-warn")),selectEl.getAttribute("aria-label")&&trigger.setAttribute("aria-label",selectEl.getAttribute("aria-label"))};trigger.addEventListener("click",e=>{e.preventDefault(),e.stopPropagation(),openCustomSelect(selectEl)}),selectEl.addEventListener("change",sync),new MutationObserver(sync).observe(selectEl,{childList:!0,subtree:!0,attributes:!0,attributeFilter:["disabled","class","title","value"]});let state={wrapper,trigger,labelSpan,sync};upgradedSelects.set(selectEl,state),sync()}function installCustomSelects(){let scanning=!1,scan=(root=document)=>{if(!scanning){scanning=!0;try{root.querySelectorAll("select.input").forEach(sel=>{upgradeSelectElement(sel)})}finally{scanning=!1}}};scan(document),new MutationObserver(mutations=>{if(scanning)return;let shouldScan=!1;for(let m of mutations){for(let node of Array.from(m.addedNodes))if(node instanceof HTMLElement&&!node.classList.contains("custom-select-wrap")&&!node.classList.contains("custom-select-trigger")&&!node.classList.contains("custom-select-popover")){shouldScan=!0;break}if(shouldScan)break}shouldScan&&scan(document)}).observe(document.body,{childList:!0,subtree:!0})}var svg=(body,size=16)=>`<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`,icons={slaprf:s=>svg('<g transform="translate(0.6 -1.1)"><path d="M18.21 16.30A8.2 8.2 0 1 1 13.30 5.79" stroke-width="2.15"/><circle cx="10.5" cy="13.5" r="1.8" fill="currentColor" stroke="none"/><path d="M10.5 13.5L15.2 9.8" stroke-width="2.15"/><path d="M15.77 7.22A8.2 8.2 0 0 1 18.70 13.50" stroke-width="2.15"/><path d="M17.64 4.36A11.6 11.6 0 0 1 22.09 13.90" stroke-width="2.15" opacity="0.65"/></g>',s),gate:s=>svg('<path d="M4 20V5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5V20"/><path d="M8 20V8h8v12"/>',s),flag:s=>svg('<path d="M4 22V4"/><path d="M4 4h12l-2 4 2 4H4"/>',s),pilot:s=>svg('<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',s),signal:s=>svg('<path d="M3 12h4l3-8 4 16 3-8h4"/>',s),signalOff:s=>svg('<path d="M3 12h4l3-8 .9 3.6"/><path d="M13.1 16.4 14 20l3-8h4"/><path d="m2 2 20 20"/>',s),sliders:s=>svg('<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',s),zap:s=>svg('<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',s),zapOff:s=>svg('<path d="M12.4 6.8 13 2l-2.4 3.2"/><path d="M18.6 12.9 20 11h-5.3"/><path d="M8 8.7 4 14h7l-1 8 5-6.7"/><path d="m2 2 20 20"/>',s),reset:s=>svg('<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>',s),play:s=>svg('<path d="M7 4l13 8-13 8z"/>',s),pause:s=>svg('<path d="M9 5v14M15 5v14"/>',s),timer:s=>svg('<path d="M10 2h4"/><path d="M12 14l3-3"/><circle cx="12" cy="14" r="8"/>',s),timerOff:s=>svg('<path d="M10 2h4"/><path d="M4.6 11a8 8 0 0 0 1.7 8.7 8 8 0 0 0 8.7 1.7"/><path d="M7.4 7.4a8 8 0 0 1 10.3 1 8 8 0 0 1 .9 10.2"/><path d="m2 2 20 20"/>',s),arrowRight:s=>svg('<path d="M5 12h14M13 6l6 6-6 6"/>',s),chevronLeft:s=>svg('<path d="M15 6l-6 6 6 6"/>',s),chevronRight:s=>svg('<path d="M9 6l6 6-6 6"/>',s),pin:s=>svg('<path d="M8 3h8"/><path d="M9 3v5l-3 3v2h12v-2l-3-3V3"/><path d="M12 13v8"/>',s),target:s=>svg('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',s),speaker:s=>svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>',s),speakerOff:s=>svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m16 9 6 6M22 9l-6 6"/>',s),stop:s=>svg('<rect x="6" y="6" width="12" height="12" rx="1.5"/>',s),checkered:s=>svg('<path d="M4 22V4"/><path d="M4 4h16v10H4"/><path d="M8 4v10M12 4v10M16 4v10M4 9h16" stroke-width="1.2"/>',s),trendDown:s=>svg('<path d="m3 7 7 7 4-4 7 7"/><path d="M15 17h6v-6"/>',s),trendUp:s=>svg('<path d="m3 17 7-7 4 4 7-7"/><path d="M15 7h6v6"/>',s),chart:s=>svg('<path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 5-6"/>',s),compare:s=>svg('<path d="M8 20V10M16 20V4M4 20h16"/>',s),eye:s=>svg('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',s),eyeOff:s=>svg('<path d="M10.6 5.1A10.7 10.7 0 0 1 12 5c6.5 0 10 7 10 7a16.5 16.5 0 0 1-3.2 4.3"/><path d="M6.6 6.7C3.8 8.5 2 12 2 12s3.5 7 10 7a10.4 10.4 0 0 0 5.4-1.5"/><path d="M14.1 14.1a3 3 0 0 1-4.2-4.2"/><path d="m2 2 20 20"/>',s),pencil:s=>svg('<path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>',s),plug:s=>svg('<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>',s),close:s=>svg('<path d="M18 6 6 18M6 6l12 12"/>',s),menu:s=>svg('<path d="M4 6h16M4 12h16M4 18h16"/>',s)};var ROUTES=[{id:"live",label:"Practice",title:"Practice",subtitle:"Live standings, lap times, and section splits",icon:()=>icons.flag(20)},{id:"pilot",label:"Analytics",title:"Analytics",subtitle:"Pick laps and see where time was won and lost",icon:()=>icons.chart(20)},{id:"sim",label:"Simulator",title:"Simulator",subtitle:"Simulated pilots, 6S flight packs, crashes, track recovery walks, and XIAO gate timers",icon:()=>icons.zap(20),simOnly:!0},{id:"setup",label:"Settings",title:"Settings",subtitle:"Pilots, timing rules, announcer, gates and LiveTime",icon:()=>icons.sliders(20)}];function parseHash(hash){let id=hash.replace(/^#\/?/,"").split("/")[0];return ROUTES.some(r=>r.id===id)?id:"live"}var Router=class{current=parseHash(location.hash);listeners=new Set;constructor(){window.addEventListener("hashchange",()=>{let next=parseHash(location.hash);next!==this.current&&(this.current=next,this.listeners.forEach(fn=>fn(next)))})}get route(){return this.current}meta(id=this.current){return ROUTES.find(r=>r.id===id)}navigate(id){location.hash=`#/${id}`}subscribe(fn){return this.listeners.add(fn),()=>this.listeners.delete(fn)}};var SCROLLABLE_SELECTOR=".table-scroll",managedTables=new WeakMap;function updateShell(state){let{viewport,leftBtn,rightBtn,shell}=state,maxScroll=viewport.scrollWidth-viewport.clientWidth,canScrollLeft=viewport.scrollLeft>4,canScrollRight=maxScroll-viewport.scrollLeft>4;shell.classList.toggle("has-overflow",maxScroll>4),leftBtn.classList.toggle("is-visible",canScrollLeft),rightBtn.classList.toggle("is-visible",canScrollRight)}function enhanceElement(el,ro){if(managedTables.has(el)){managedTables.get(el).update();return}if(el.closest(".table-scroll-shell"))return;let parent=el.parentElement;if(!parent)return;let shell=document.createElement("div");shell.className="table-scroll-shell";let viewport=el;parent.insertBefore(shell,el),shell.appendChild(el),viewport.classList.add("table-scroll-viewport");let leftBtn=document.createElement("button");leftBtn.type="button",leftBtn.className="table-edge-nav is-left",leftBtn.setAttribute("aria-label","Scroll table left"),leftBtn.title="Scroll left",leftBtn.innerHTML='<span class="table-edge-arrow">\u2039</span>';let rightBtn=document.createElement("button");rightBtn.type="button",rightBtn.className="table-edge-nav is-right",rightBtn.setAttribute("aria-label","Scroll table right"),rightBtn.title="Scroll right",rightBtn.innerHTML='<span class="table-edge-arrow">\u203A</span>',shell.appendChild(leftBtn),shell.appendChild(rightBtn);let state={shell,viewport,leftBtn,rightBtn,update:()=>updateShell(state)},scrollStep=dir=>{let step=Math.max(160,Math.round(viewport.clientWidth*.65));viewport.scrollBy({left:dir*step,behavior:"smooth"})};leftBtn.addEventListener("click",e=>{e.preventDefault(),e.stopPropagation(),scrollStep(-1)}),rightBtn.addEventListener("click",e=>{e.preventDefault(),e.stopPropagation(),scrollStep(1)}),viewport.addEventListener("scroll",state.update,{passive:!0}),ro.observe(viewport);let innerTable=viewport.firstElementChild;innerTable instanceof HTMLElement&&ro.observe(innerTable),managedTables.set(el,state),requestAnimationFrame(state.update)}var installed=!1;function installTableScrollIndicators(){if(installed)return;installed=!0;let ro=new ResizeObserver(entries=>{for(let entry of entries){let shell=entry.target.closest(".table-scroll-shell");if(!shell)continue;let vp=shell.querySelector(".table-scroll-viewport"),leftBtn=shell.querySelector(".table-edge-nav.is-left"),rightBtn=shell.querySelector(".table-edge-nav.is-right");vp&&leftBtn&&rightBtn&&updateShell({shell,viewport:vp,leftBtn,rightBtn,update:()=>{}})}}),scanning=!1,scan=(root=document)=>{if(!scanning){scanning=!0;try{root.querySelectorAll(SCROLLABLE_SELECTOR).forEach(m=>enhanceElement(m,ro))}finally{scanning=!1}}};scan(document),new MutationObserver(mutations=>{if(scanning)return;let shouldScan=!1;for(let m of mutations){for(let node of Array.from(m.addedNodes))if(node instanceof HTMLElement&&!node.classList.contains("table-scroll-shell")&&!node.classList.contains("table-edge-nav")){shouldScan=!0;break}if(shouldScan)break}shouldScan&&scan(document)}).observe(document.body,{childList:!0,subtree:!0}),window.addEventListener("resize",()=>scan(document),{passive:!0})}var wakeLockEnabled=!0,sentinel=null,requesting=!1,listenersInstalled=!1;async function acquireWakeLock(){if(!wakeLockEnabled||requesting||document.visibilityState!=="visible"||sentinel&&!sentinel.released)return;let nav=navigator;if(!(!nav.wakeLock||typeof nav.wakeLock.request!="function")){requesting=!0;try{sentinel=await nav.wakeLock.request("screen"),sentinel.addEventListener("release",()=>{wakeLockEnabled&&document.visibilityState==="visible"&&acquireWakeLock()})}catch{}finally{requesting=!1}}}async function releaseWakeLock(){let current=sentinel;if(sentinel=null,current&&!current.released)try{await current.release()}catch{}}function setWakeLockEnabled(enabled){wakeLockEnabled=enabled,enabled?acquireWakeLock():releaseWakeLock()}function installWakeLock(){if(listenersInstalled)return;listenersInstalled=!0,acquireWakeLock(),document.addEventListener("visibilitychange",()=>{wakeLockEnabled&&document.visibilityState==="visible"&&acquireWakeLock()});let onUserGesture=()=>{wakeLockEnabled&&(!sentinel||sentinel.released)&&acquireWakeLock()};window.addEventListener("pointerdown",onUserGesture,{passive:!0}),window.addEventListener("touchstart",onUserGesture,{passive:!0}),window.addEventListener("keydown",onUserGesture,{passive:!0})}var Component=class{el;disposers=[];children=[];constructor(el){this.el=el}onDispose(fn){this.disposers.push(fn)}listen(target,type,handler){target.addEventListener(type,handler),this.onDispose(()=>target.removeEventListener(type,handler))}adopt(child){return this.children.push(child),child}slot(name){let node=this.el.querySelector(`[data-slot="${name}"]`);if(!node)throw new Error(`${this.constructor.name}: missing slot "${name}"`);return node}destroy(){for(;this.children.length>0;)this.children.pop().destroy();for(;this.disposers.length>0;)this.disposers.pop()();this.el.replaceChildren()}};function lapsFor(store,slotIndex){return store.laps.filter(l=>l.slotIndex===slotIndex)}function bestLapOf(laps){return laps.reduce((best,l)=>best===0||l.lapTimeSec<best?l.lapTimeSec:best,0)}function fastestLap(store){let fastest;for(let lap of store.laps)(!fastest||lap.lapTimeSec<fastest.lapTimeSec)&&(fastest=lap);return fastest}function mean(values){return values.length===0?0:values.reduce((s,v)=>s+v,0)/values.length}function median(values){if(values.length===0)return 0;let sorted=[...values].sort((a,b)=>a-b),mid=Math.floor(sorted.length/2);return sorted.length%2?sorted[mid]:(sorted[mid-1]+sorted[mid])/2}function currentSectorIndex(store,slotIndex){let last=store.lastCrossingFor(slotIndex);return last?store.pucks.findIndex(p=>p.puckId===last.puckId):-1}function secondsSinceSeen(store,slotIndex){let last=store.lastCrossingFor(slotIndex);return!last||store.latestTimestampUs===0?1/0:Math.max(0,(store.latestTimestampUs-last.timestampUs)/1e6)}var TIMER_COLORS=["#d4ff3a","#38bdf8","#f472b6","#fb923c","#a78bfa","#2dd4bf","#facc15","#f87171","#4ade80","#60a5fa","#e879f9","#ffffff"];function timerColor(store,hardwareTimerId){if(!hardwareTimerId||hardwareTimerId<=0)return"#64748b";let detected=store.detectedPucks.find(d=>d.puckId===hardwareTimerId);if(detected?.color?.trim())return detected.color.trim();let nodeWithTimer=store.pucks.find(p=>(p.assignedPuckId??p.puckId)===hardwareTimerId);return nodeWithTimer?.color?.trim()?nodeWithTimer.color.trim():TIMER_COLORS[(hardwareTimerId-1)%TIMER_COLORS.length]}function gateColor(store,puckId){let position=store.pucks.findIndex(p2=>p2.puckId===puckId);if(position<0)return TIMER_COLORS[0];let p=store.pucks[position],assignedId=p.assignedPuckId??0;return assignedId>0?timerColor(store,assignedId):p.color?.trim()||"#64748b"}function gateLabel(store,puckId){let position=store.pucks.findIndex(p2=>p2.puckId===puckId);if(position<0)return"Unknown gate";let p=store.pucks[position];return p.name.trim()||p.puckLabel?.trim()||`Gate ${position+1}`}function sectionLabel(store,fromPuckId,toPuckId){return`${gateLabel(store,fromPuckId)} \u2192 ${gateLabel(store,toPuckId)}`}function sectionShort(store,fromPuckId){let position=store.pucks.findIndex(p=>p.puckId===fromPuckId);return position<0?"S?":`S${position+1}`}function enterThresholdAt(store,puckId,slotIndex){let pos=store.pilots.findIndex(p=>p.slotIndex===slotIndex),pilot=store.pilots[pos],override=store.puck(puckId)?.enterThresholds?.[pos]??0;return override!==0?{dbm:override,calibrated:!0}:{dbm:pilot?.enterThreshold??-58,calibrated:!1}}var ON_TRACK_WINDOW_SEC=20;var PilotPicker=class extends Component{store;opts;constructor(el,store,opts){super(el),this.store=store,this.opts={value:opts?.value??(()=>store.selectedPilot),onSelect:opts?.onSelect??(slot=>slot!==null&&store.selectPilot(slot)),includeAll:opts?.includeAll??!1},el.classList.add("pilot-picker"),el.setAttribute("role","tablist"),el.setAttribute("aria-label","Pilot");let handleSelect=e=>{let chip=e.target.closest("[data-pilot]");if(!chip)return;let v=chip.dataset.pilot;this.opts.onSelect(v==="all"?null:Number(v))};this.listen(el,"pointerdown",e=>{e.button===0&&handleSelect(e)}),this.listen(el,"click",handleSelect),this.onDispose(store.subscribe(["config","selection","laps"],()=>this.render())),this.render()}render(){let selected=this.opts.value(),all=this.opts.includeAll?`<button class="pilot-chip pilot-chip-all ${selected===null?"is-active":""}" role="tab"
           aria-selected="${selected===null}" data-pilot="all">
           <span class="pilot-chip-name">All</span>
         </button>`:"",pilots=this.store.enabledPilots.map(p=>{let active=p.slotIndex===selected,laps=lapsFor(this.store,p.slotIndex).length;return`
          <button class="pilot-chip ${active?"is-active":""}" role="tab" aria-selected="${active}" data-pilot="${p.slotIndex}" style="--c:${p.color}">
            <span class="dot"></span>
            <span class="pilot-chip-name">${esc(p.callsign)}</span>
            <span class="pilot-chip-time mono">${laps} laps</span>
          </button>`}).join("");this.el.innerHTML=all+pilots}};var ROLLING_WINDOW=5;function practiceStats(store,pilot){let laps=lapsFor(store,pilot.slotIndex),times=laps.map(l=>l.lapTimeSec),recent=times.slice(-ROLLING_WINDOW),previous=times.slice(-ROLLING_WINDOW*2,-ROLLING_WINDOW),seen=secondsSinceSeen(store,pilot.slotIndex);return{pilot,laps,lastLap:times.length?times[times.length-1]:0,bestLap:bestLapOf(laps),rollingAvg:mean(recent),trend:recent.length===ROLLING_WINDOW&&previous.length===ROLLING_WINDOW?mean(recent)-mean(previous):NaN,onTrack:seen<=ON_TRACK_WINDOW_SEC,secondsSinceSeen:seen}}function rollingAverages(laps,window2=ROLLING_WINDOW){return laps.map((_,i)=>mean(laps.slice(Math.max(0,i-window2+1),i+1).map(l=>l.lapTimeSec)))}var sectionKey=(fromPuckId,toPuckId)=>`${fromPuckId}>${toPuckId}`;function resolveComparison(store,slotIndex){let laps=lapsFor(store,slotIndex);if(laps.length<2)return null;let{lapId,reference}=store.comparison,lap=lapId!==null&&laps.find(l=>l.lapId===lapId)||laps[laps.length-1],lapIdx=laps.indexOf(lap),others=laps.filter(l=>l.lapId!==lap.lapId),ref,refLabel="";if(typeof reference=="number"?(ref=others.find(l=>l.lapId===reference),ref&&(refLabel=`Lap ${ref.lapNumber}`)):reference==="previous"&&lapIdx>0&&(ref=laps[lapIdx-1],refLabel=`Lap ${ref.lapNumber} (previous)`),!ref){ref=others.reduce((b,l)=>l.lapTimeSec<b.lapTimeSec?l:b,others[0]);let lapIsBest=lap.lapTimeSec<=ref.lapTimeSec;refLabel=`Lap ${ref.lapNumber} (${lapIsBest?"next best":"best"})`}let pucks=store.pucks,courseKeys=new Set(pucks.map((p,i)=>sectionKey(p.puckId,pucks[(i+1)%pucks.length].puckId))),refByKey=new Map(ref.sectors.map(s=>[sectionKey(s.fromPuckId,s.toPuckId),s])),sections=[];for(let s of lap.sectors){let key=sectionKey(s.fromPuckId,s.toPuckId);if(!courseKeys.has(key))continue;let r=refByKey.get(key);r&&sections.push({key,fromPuckId:s.fromPuckId,toPuckId:s.toPuckId,lapSec:s.splitSeconds,refSec:r.splitSeconds,delta:s.splitSeconds-r.splitSeconds,lapExitMph:s.exitSpeedMph,refExitMph:r.exitSpeedMph})}return{lap,ref,refLabel,sections,totalDelta:lap.lapTimeSec-ref.lapTimeSec,incomplete:sections.length<Math.max(lap.sectors.length,ref.sectors.length)}}function decisiveSection(cmp){let sign=cmp.totalDelta>=0?1:-1;return cmp.sections.reduce((best,s)=>s.delta*sign>(best?best.delta*sign:0)?s:best,void 0)}function sectionConsistency(store,slotIndex){let pucks=store.pucks;if(pucks.length===0)return[];let groups=new Map;for(let i=0;i<pucks.length;i++){let from=pucks[i].puckId,to=pucks[(i+1)%pucks.length].puckId;from!==to&&groups.set(sectionKey(from,to),{from,to,times:[],exits:[],bestExit:0,best:1/0})}for(let lap of lapsFor(store,slotIndex))for(let s of lap.sectors){let g=groups.get(sectionKey(s.fromPuckId,s.toPuckId));g&&(g.times.push(s.splitSeconds),g.exits.push(s.exitSpeedMph),s.splitSeconds<g.best&&(g.best=s.splitSeconds,g.bestExit=s.exitSpeedMph))}return[...groups.entries()].filter(([,g])=>g.times.length>0).map(([key,g])=>{let typical=median(g.times);return{key,fromPuckId:g.from,toPuckId:g.to,samples:g.times.length,best:g.best,typical,givenAway:typical-g.best,typicalExitMph:median(g.exits),bestExitMph:g.bestExit}})}function bestPossibleLap(store,slotIndex){let sections=sectionConsistency(store,slotIndex);return sections.length===store.pucks.length&&sections.length>0?sections.reduce((s,c)=>s+c.best,0):0}function sectionRecords(store){let pucks=store.pucks,records=pucks.map((p,i)=>{let to=pucks[(i+1)%pucks.length];return{key:sectionKey(p.puckId,to.puckId),fromPuckId:p.puckId,toPuckId:to.puckId,bests:new Map,recordSlot:null,recordSec:0}}),byKey=new Map(records.map(r=>[r.key,r]));for(let lap of store.laps)for(let s of lap.sectors){let r=byKey.get(sectionKey(s.fromPuckId,s.toPuckId));if(!r)continue;let cur=r.bests.get(lap.slotIndex);(!cur||s.splitSeconds<cur.sec)&&r.bests.set(lap.slotIndex,{sec:s.splitSeconds,exitMph:s.exitSpeedMph})}for(let r of records)for(let[slot,b]of r.bests)(r.recordSlot===null||b.sec<r.recordSec)&&(r.recordSlot=slot,r.recordSec=b.sec);return records}function currentLap(store,slotIndex){let pucks=store.pucks,sfIdx=pucks.findIndex(p=>p.role==="START_FINISH");if(sfIdx<0)return null;let sfId=pucks[sfIdx].puckId,mine=store.crossings.filter(c=>c.slotIndex===slotIndex),startIdx=-1;for(let i=mine.length-1;i>=0;i--)if(mine[i].puckId===sfId){startIdx=i;break}if(startIdx<0)return null;let start=mine[startIdx],now=store.latestTimestampUs,elapsedSec=(now-start.timestampUs)/1e6;if(elapsedSec>store.rules.maxLapSec)return null;let order=[...pucks.slice(sfIdx),...pucks.slice(0,sfIdx)],best=new Map(sectionConsistency(store,slotIndex).map(s=>[s.key,s.best])),sections=order.map((p,i)=>{let to=order[(i+1)%order.length],key=sectionKey(p.puckId,to.puckId);return{key,fromPuckId:p.puckId,toPuckId:to.puckId,state:"pending",splitSec:0,bestSec:best.get(key)??0,delta:NaN}}),indexOfGate=puckId=>order.findIndex(p=>p.puckId===puckId),prev=start,deltaSoFar=0;for(let c of mine.slice(startIdx+1)){let split=(c.timestampUs-prev.timestampUs)/1e6,from=indexOfGate(prev.puckId),to=indexOfGate(c.puckId);if(from>=0&&to===(from+1)%order.length){let s=sections[from];s.state="done",s.splitSec=split,s.bestSec>0&&(s.delta=split-s.bestSec,deltaSoFar+=s.delta)}else if(from>=0&&to>from)for(let i=from;i<to;i++)sections[i].state="missed";prev=c}let cur=sections.find(s=>s.fromPuckId===prev.puckId&&s.state==="pending");return cur&&(cur.state="current",cur.splitSec=(now-prev.timestampUs)/1e6),{lapNumber:lapsFor(store,slotIndex).length+1,elapsedSec,sections,deltaSoFar}}var FILTER_LABELS={COOLDOWN:"Cool-down",TOO_SOON:"Too soon",ECHO:"Echo",MIN_LAP:"Min lap",LAP_TOO_LONG:"Lap too long"},SPLIT_CLASS={OVERALL_BEST:"split-purple",PERSONAL_BEST:"split-good",NORMAL:"split-neutral",OFF_PACE:"split-bad"};function renderStatTiles(tiles){return tiles.map(t=>`
      <div class="stat">
        <div class="stat-label">${esc(t.label)}</div>
        <div class="stat-value ${t.mono===!1?"":"mono"} ${t.tone?`tone-${t.tone}`:""}">${esc(t.value)}</div>
        ${t.sub?`<div class="stat-sub ${t.subTone?`tone-${t.subTone}`:""}">${esc(t.sub)}</div>`:""}
      </div>`).join("")}function renderEmpty(title,body){return`
    <div class="empty">
      <div class="empty-title">${esc(title)}</div>
      <div class="empty-body">${esc(body)}</div>
    </div>`}function renderSparkline(values,width=120,height=32){if(values.length<2)return`<svg class="spark" width="${width}" height="${height}"></svg>`;let lo=Math.min(...values),hi=Math.max(...values),span=Math.max(.001,hi-lo),pts=values.map((v,i)=>({x:i/(values.length-1)*(width-4)+2,y:height-3-(hi-v)/span*(height-6)})),n=pts.length,d=`M ${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;if(n===2)d+=` L ${pts[1].x.toFixed(1)},${pts[1].y.toFixed(1)}`;else{let dx=pts.slice(0,-1).map((p,i)=>pts[i+1].x-p.x),m=dx.map((w,i)=>w!==0?(pts[i+1].y-pts[i].y)/w:0),t=new Array(n);t[0]=m[0],t[n-1]=m[n-2];for(let i=1;i<n-1;i++)t[i]=m[i-1]*m[i]<=0?0:(m[i-1]+m[i])/2;for(let i=0;i<n-1;i++){let seg=dx[i]/3,c1x=pts[i].x+seg,c1y=pts[i].y+t[i]*seg,c2x=pts[i+1].x-seg,c2y=pts[i+1].y-t[i+1]*seg;d+=` C ${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${pts[i+1].x.toFixed(1)},${pts[i+1].y.toFixed(1)}`}}let last=pts[n-1];return`
    <svg class="spark" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true">
      <path d="${d}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="2.5" fill="currentColor"/>
    </svg>`}function renderSectionCapsuleIcon(c1,c2){return`<span class="sec-bicolor-capsule" style="--c1:${c1};--c2:${c2}" aria-hidden="true"></span>`}function sectionIdBadge(store,fromPuckId,toPuckId){let c1=gateColor(store,fromPuckId),resolvedTo=toPuckId;if(!resolvedTo&&store.pucks.length>0){let idx=store.pucks.findIndex(p=>p.puckId===fromPuckId);idx>=0&&(resolvedTo=store.pucks[(idx+1)%store.pucks.length].puckId)}let c2=resolvedTo?gateColor(store,resolvedTo):c1;return`<span class="sec-id-badge" style="--c1:${c1};--c2:${c2}">${renderSectionCapsuleIcon(c1,c2)}<span>${esc(sectionShort(store,fromPuckId))}</span></span>`}function subtleRoute(store,fromPuckId,toPuckId){return`<span class="sec-route-subtle">${esc(gateLabel(store,fromPuckId))} <span class="muted">\u2192</span> ${esc(gateLabel(store,toPuckId))}</span>`}function routeLabel(store,fromPuckId,toPuckId){return`<span class="sec-cell">${sectionIdBadge(store,fromPuckId,toPuckId)}${subtleRoute(store,fromPuckId,toPuckId)}</span>`}var CanvasSurface=class{container;canvas;ctx;observer;draw;width=0;height=0;frame=0;constructor(container,draw){this.container=container,this.draw=draw,this.canvas=document.createElement("canvas"),this.canvas.className="surface-canvas",container.appendChild(this.canvas);let ctx=this.canvas.getContext("2d");if(!ctx)throw new Error("CanvasSurface: 2D context unavailable");this.ctx=ctx,this.observer=new ResizeObserver(()=>this.resize()),this.observer.observe(container),this.resize(),this.frame=requestAnimationFrame(this.tick)}resize(){let rect=this.container.getBoundingClientRect(),dpr=window.devicePixelRatio||1;this.width=Math.max(0,Math.floor(rect.width)),this.height=Math.max(0,Math.floor(rect.height)),this.canvas.width=Math.floor(this.width*dpr),this.canvas.height=Math.floor(this.height*dpr),this.canvas.style.width=`${this.width}px`,this.canvas.style.height=`${this.height}px`,this.ctx.setTransform(dpr,0,0,dpr,0,0)}tick=()=>{this.width>0&&this.height>0&&(this.ctx.clearRect(0,0,this.width,this.height),this.draw(this.ctx,this.width,this.height)),this.frame=requestAnimationFrame(this.tick)};destroy(){cancelAnimationFrame(this.frame),this.observer.disconnect(),this.canvas.remove()}};var theme={surface:"#111317",grid:"rgba(255, 255, 255, 0.045)",gridStrong:"rgba(255, 255, 255, 0.09)",text:"#ecedef",text2:"#a3a8b3",text3:"#6c7280",accent:"#d4ff3a",good:"#34d399",bad:"#f87171",track:"#1b1e24",trackEdge:"#2a2e36",fontSans:'"Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',fontMono:'"JetBrains Mono", ui-monospace, "SF Mono", Consolas, monospace'};function font(weight,size,mono=!1){return`${weight} ${size}px ${mono?theme.fontMono:theme.fontSans}`}function withAlpha(hex,alpha){let n=parseInt(hex.slice(1),16);return`rgba(${n>>16&255}, ${n>>8&255}, ${n&255}, ${alpha})`}var OUTLIER_FACTOR=1.35,WINDOW_SEC_DESKTOP=480,WINDOW_SEC_MOBILE=180,HOVER_DOT_HIT_PX=16;function fmtSessionClock(sec){let total=Math.max(0,Math.round(sec)),m=Math.floor(total/60),s=total%60;return`${m}:${s<10?"0":""}${s}`}function chooseTimeTickStep(spanSec){let candidates=[5,10,15,30,60,120,180,300,600];for(let step of candidates)if(spanSec/step<=10)return step;return 600}function traceMonotoneSpline(ctx,pts){let n=pts.length;if(n===0||(ctx.moveTo(pts[0].x,pts[0].y),n===1))return;if(n===2){ctx.lineTo(pts[1].x,pts[1].y);return}let dx=new Array(n-1),dy=new Array(n-1),m=new Array(n-1);for(let i=0;i<n-1;i++)dx[i]=pts[i+1].x-pts[i].x,dy[i]=pts[i+1].y-pts[i].y,m[i]=dx[i]!==0?dy[i]/dx[i]:0;let tangents=new Array(n);tangents[0]=m[0],tangents[n-1]=m[n-2];for(let i=1;i<n-1;i++)m[i-1]*m[i]<=0?tangents[i]=0:tangents[i]=(m[i-1]+m[i])/2;for(let i=0;i<n-1;i++)if(m[i]===0)tangents[i]=0,tangents[i+1]=0;else{let a=tangents[i]/m[i],b=tangents[i+1]/m[i],h=Math.hypot(a,b);if(h>3){let scale=3/h;tangents[i]=scale*a*m[i],tangents[i+1]=scale*b*m[i]}}for(let i=0;i<n-1;i++){let segDx=dx[i]/3;ctx.bezierCurveTo(pts[i].x+segDx,pts[i].y+tangents[i]*segDx,pts[i+1].x-segDx,pts[i+1].y-tangents[i+1]*segDx,pts[i+1].x,pts[i+1].y)}}var ProgressionChart=class extends Component{store;surface;slotIndex;hiddenSlots=new Set;metric={kind:"lap"};series=[];minTimeSec=0;maxTimeSec=0;endTimeSec=null;drag=null;thumbHovered=!1;hoverPos=null;hoveredDot=!1;plotGeom={padL:52,plotW:1,h:1,w:600};windowSec(){return this.plotGeom.w>0&&this.plotGeom.w<=560?WINDOW_SEC_MOBILE:WINDOW_SEC_DESKTOP}constructor(el,store,opts={}){super(el),this.store=store,this.slotIndex=opts.slotIndex,this.surface=new CanvasSurface(el,(ctx,w,h)=>this.draw(ctx,w,h)),this.onDispose(()=>this.surface.destroy()),this.listen(el,"pointerdown",e=>{let winSec=this.windowSec(),totalSpan=this.maxTimeSec-this.minTimeSec,rect=el.getBoundingClientRect(),x=e.clientX-rect.left,y=e.clientY-rect.top;if(this.hoverPos={x,y},e.pointerType==="mouse"&&e.button!==0||totalSpan<=winSec)return;let effectiveEnd=this.effectiveEndTimeSec();if(y>=this.plotGeom.h-24&&x>=this.plotGeom.padL&&x<=this.plotGeom.padL+this.plotGeom.plotW){let plotW=Math.max(1,this.plotGeom.plotW),thumbW=Math.max(28,winSec/totalSpan*plotW),maxStart=Math.max(1,totalSpan-winSec),startSec=Math.max(this.minTimeSec,effectiveEnd-winSec),thumbX=this.plotGeom.padL+(startSec-this.minTimeSec)/maxStart*(plotW-thumbW);if(x<thumbX||x>thumbX+thumbW){let ratio=Math.max(0,Math.min(1,(x-this.plotGeom.padL-thumbW/2)/Math.max(1,plotW-thumbW))),jumpedEnd=this.minTimeSec+winSec+ratio*(totalSpan-winSec);this.setEndTimeSec(jumpedEnd)}this.drag={startX:e.clientX,startEndSec:this.effectiveEndTimeSec(),mode:"thumb"}}else this.drag={startX:e.clientX,startEndSec:effectiveEnd,mode:"pan"};el.setPointerCapture(e.pointerId),el.style.cursor="grabbing"}),this.listen(el,"pointermove",e=>{let rect=el.getBoundingClientRect(),x=e.clientX-rect.left,y=e.clientY-rect.top;this.hoverPos={x,y};let winSec=this.windowSec(),totalSpan=this.maxTimeSec-this.minTimeSec;if(!this.drag){if(totalSpan>winSec){let overTrack=y>=this.plotGeom.h-24&&x>=this.plotGeom.padL&&x<=this.plotGeom.padL+this.plotGeom.plotW,overThumb=!1;if(overTrack){let plotW2=Math.max(1,this.plotGeom.plotW),thumbW=Math.max(28,winSec/totalSpan*plotW2),maxStart=Math.max(1,totalSpan-winSec),startSec=Math.max(this.minTimeSec,this.effectiveEndTimeSec()-winSec),thumbX=this.plotGeom.padL+(startSec-this.minTimeSec)/maxStart*(plotW2-thumbW);overThumb=x>=thumbX&&x<=thumbX+thumbW}this.thumbHovered=overTrack,el.style.cursor=overThumb?"grab":overTrack||this.hoveredDot?"pointer":"grab"}else this.thumbHovered=!1,el.style.cursor=this.hoveredDot?"pointer":"";return}let dx=e.clientX-this.drag.startX,plotW=Math.max(1,this.plotGeom.plotW),nextEnd;if(this.drag.mode==="thumb"){let thumbW=Math.max(28,winSec/totalSpan*plotW),travel=Math.max(1,plotW-thumbW),deltaSec=dx/travel*(totalSpan-winSec);nextEnd=this.drag.startEndSec+deltaSec}else{let deltaSec=-(dx/plotW)*winSec;nextEnd=this.drag.startEndSec+deltaSec}this.setEndTimeSec(nextEnd)}),this.listen(el,"pointerleave",()=>{this.hoverPos=null,this.hoveredDot=!1,this.drag||(this.thumbHovered=!1,el.style.cursor="")});let endDrag=e=>{this.drag&&(this.drag=null,el.hasPointerCapture(e.pointerId)&&el.releasePointerCapture(e.pointerId),el.style.cursor=this.maxTimeSec-this.minTimeSec>this.windowSec()?"grab":"")};this.listen(el,"pointerup",endDrag),this.listen(el,"pointercancel",endDrag),this.listen(el,"wheel",e=>{let winSec=this.windowSec();if(this.maxTimeSec-this.minTimeSec<=winSec)return;e.preventDefault();let rawDelta=Math.abs(e.deltaX)>Math.abs(e.deltaY)?e.deltaX:e.deltaY;if(rawDelta===0)return;let step=Math.sign(rawDelta)*Math.max(15,Math.round(winSec*.1));this.setEndTimeSec(this.effectiveEndTimeSec()+step)},{passive:!1}),this.listen(el,"dblclick",()=>{this.endTimeSec!==null&&(this.endTimeSec=null)}),this.onDispose(store.subscribe(["laps","config","selection"],()=>{this.refresh()})),this.refresh()}setMetric(metric){this.metric=metric,this.refresh()}setHiddenSlots(hidden){this.hiddenSlots=new Set(hidden),this.refresh()}effectiveEndTimeSec(){let winSec=this.windowSec();return this.maxTimeSec-this.minTimeSec<=winSec||this.endTimeSec===null?this.maxTimeSec:Math.min(this.maxTimeSec,Math.max(this.minTimeSec+winSec,this.endTimeSec))}setEndTimeSec(next){let winSec=this.windowSec(),clamped=Math.min(this.maxTimeSec,Math.max(this.minTimeSec+winSec,next));this.endTimeSec=clamped>=this.maxTimeSec-2?null:clamped}valueOf(lap){if(this.metric.kind==="lap")return lap.lapTimeSec;let{sectorIndex,fromPuckId,toPuckId}=this.metric,byPair=lap.sectors.find(s=>s.fromPuckId===fromPuckId&&s.toPuckId===toPuckId);return byPair?byPair.splitSeconds:lap.sectors.find(s=>s.sectorIndex===sectorIndex)?.splitSeconds}refresh(){let only=this.slotIndex?.(),fallbackSec=0;this.series=this.store.enabledPilots.filter(pilot=>(only===void 0||pilot.slotIndex===only)&&(only!==void 0||!this.hiddenSlots.has(pilot.slotIndex))).map(pilot=>(fallbackSec=0,{pilot,points:lapsFor(this.store,pilot.slotIndex).flatMap((lap,i)=>{fallbackSec+=lap.lapTimeSec;let t=this.valueOf(lap),atSec=lap.completedAtUs&&lap.completedAtUs>0?lap.completedAtUs/1e6:fallbackSec;return t!==void 0&&t>0?[{lap:lap.lapNumber||i+1,atSec,lapTimeSec:lap.lapTimeSec,t}]:[]})})).filter(s=>s.points.length>0);let allAtSec=this.series.flatMap(s=>s.points.map(p=>p.atSec));if(allAtSec.length>0){let rawMin=Math.min(...allAtSec);this.minTimeSec=rawMin<45?0:Math.floor(rawMin/15)*15,this.maxTimeSec=Math.max(...allAtSec)}else this.minTimeSec=0,this.maxTimeSec=0;this.maxTimeSec-this.minTimeSec<=this.windowSec()&&(this.endTimeSec=null)}draw(ctx,w,h){if(this.plotGeom.w=w,this.series.length===0){ctx.fillStyle=theme.text3,ctx.font=font(500,12),ctx.textAlign="center";let anyLapsExist=this.slotIndex===void 0&&this.hiddenSlots.size>0&&this.store.enabledPilots.some(p=>lapsFor(this.store,p.slotIndex).length>0);ctx.fillText(anyLapsExist?"All pilots hidden \u2014 click a pilot in the legend below to plot their laps":this.metric.kind==="lap"?"Lap times appear here as pilots complete laps":"No times for this section yet",w/2,h/2),ctx.textAlign="left";return}let winSec=this.windowSec(),totalSpan=this.maxTimeSec-this.minTimeSec,scrollable=totalSpan>winSec,endSec=this.effectiveEndTimeSec(),startSec=scrollable?Math.max(this.minTimeSec,endSec-winSec):this.minTimeSec,visibleSeries=this.series.map(s=>({pilot:s.pilot,points:s.points.filter(p=>p.atSec>=startSec-30&&p.atSec<=endSec+30)})).filter(s=>s.points.length>0),allSessionTimes=this.series.flatMap(s=>s.points.map(p=>p.t)),inWindowTimes=this.series.flatMap(s=>s.points.filter(p=>p.atSec>=startSec&&p.atSec<=endSec).map(p=>p.t)),scaleTimes=inWindowTimes.length>0?inWindowTimes:allSessionTimes,fast=Math.min(...scaleTimes),slow=Math.min(Math.max(...scaleTimes),median(scaleTimes)*OUTLIER_FACTOR),pad=Math.max(.02,(slow-fast)*.12),lo=fast-pad,hi=slow+pad,padL=52,padR=16,padT=12,padB=scrollable?40:28,plotW=w-padL-padR,plotH=h-padT-padB;this.plotGeom={padL,plotW,h,w};let spanSec=Math.max(10,endSec-startSec),xOf=atSec=>padL+(endSec<=startSec?plotW/2:(atSec-startSec)/spanSec*plotW),yOf=t=>padT+(Math.min(t,hi)-lo)/(hi-lo||1)*plotH,decimals=hi-lo<.3?3:hi-lo<1.5?2:1;ctx.font=font(500,10.5,!0);for(let i=0;i<=3;i++){let t=lo+(hi-lo)*i/3,y=Math.round(yOf(t))+.5;ctx.strokeStyle=theme.grid,ctx.beginPath(),ctx.moveTo(padL,y),ctx.lineTo(w-padR,y),ctx.stroke(),ctx.fillStyle=theme.text3,ctx.textAlign="right",ctx.fillText(`${t.toFixed(decimals)}s`,padL-8,y+3.5)}let tickStep=chooseTimeTickStep(spanSec),firstTick=Math.ceil(startSec/tickStep)*tickStep;ctx.textAlign="center",ctx.fillStyle=theme.text3;for(let tSec=firstTick;tSec<=endSec;tSec+=tickStep){let x=xOf(tSec);x>=padL+14&&x<=w-padR-14&&ctx.fillText(fmtSessionClock(tSec),x,h-(scrollable?21:9))}if(ctx.textAlign="left",ctx.fillStyle=theme.text3,ctx.font=font(500,10.5),ctx.fillText("faster \u2191",padL+6,padT+10),scrollable){ctx.textAlign="right",ctx.fillStyle=this.endTimeSec!==null?theme.accent:theme.text3,ctx.font=font(500,10.5);let winMin=Math.round(winSec/60),statusText=this.endTimeSec!==null?`${fmtSessionClock(startSec)}\u2013${fmtSessionClock(endSec)} of ${fmtSessionClock(this.maxTimeSec)} \xB7 double-tap for latest`:`Last ${winMin}m (${fmtSessionClock(startSec)}\u2013${fmtSessionClock(endSec)}) \xB7 swipe or scroll`;ctx.fillText(statusText,w-padR,padT+10),ctx.textAlign="left"}if(this.series.length===1){let best=Math.min(...this.series[0].points.map(p=>p.t)),y=Math.round(Math.max(padT,Math.min(padT+plotH,yOf(best))))+.5;ctx.save(),ctx.setLineDash([4,4]),ctx.strokeStyle=withAlpha(theme.good,.6),ctx.beginPath(),ctx.moveTo(padL,y),ctx.lineTo(w-padR,y),ctx.stroke(),ctx.restore(),ctx.fillStyle=theme.good,ctx.font=font(600,10.5),ctx.textAlign="right",ctx.fillText(`best ${best.toFixed(3)}s`,w-padR-4,Math.max(padT+22,y-5)),ctx.textAlign="left"}let closestHover=null,closestDist=HOVER_DOT_HIT_PX;for(let s of visibleSeries){let screenPts=s.points.map(p=>({lap:p.lap,atSec:p.atSec,lapTimeSec:p.lapTimeSec,t:p.t,x:xOf(p.atSec),y:yOf(p.t),clipped:p.t>hi})),stints=[];for(let pt of screenPts){let currentStint=stints[stints.length-1];if(!currentStint||currentStint.length===0){stints.push([pt]);continue}let prev=currentStint[currentStint.length-1],gapSec=pt.atSec-prev.atSec,maxContinuousGap=Math.max(22,pt.lapTimeSec*1.65);gapSec>maxContinuousGap?stints.push([pt]):currentStint.push(pt)}ctx.save(),ctx.beginPath(),ctx.rect(padL-2,padT-4,plotW+4,plotH+8),ctx.clip(),ctx.strokeStyle=s.pilot.color,ctx.lineWidth=2,ctx.lineCap="round",ctx.lineJoin="round";for(let stint of stints)stint.length<2||(ctx.beginPath(),traceMonotoneSpline(ctx,stint),ctx.stroke());ctx.restore();for(let p of screenPts)if(!(p.x<padL-2||p.x>padL+plotW+2)){if(!this.drag&&this.hoverPos){let d=Math.hypot(this.hoverPos.x-p.x,this.hoverPos.y-p.y);d<=closestDist&&(closestDist=d,closestHover={pilot:s.pilot,...p})}ctx.beginPath(),ctx.arc(p.x,p.y,p.clipped?2.2:3,0,Math.PI*2),ctx.fillStyle=p.clipped?withAlpha(s.pilot.color,.45):s.pilot.color,ctx.fill()}}if(this.hoveredDot=closestHover!==null,closestHover&&this.drawHoverTooltip(ctx,w,padL,padT,plotW,plotH,closestHover),scrollable){let trackY=h-10,trackH=6;ctx.fillStyle="rgba(255, 255, 255, 0.08)",ctx.beginPath(),ctx.roundRect(padL,trackY,plotW,trackH,3),ctx.fill();let thumbW=Math.max(28,winSec/totalSpan*plotW),maxStart=Math.max(1,totalSpan-winSec),thumbX=padL+(startSec-this.minTimeSec)/maxStart*(plotW-thumbW);ctx.fillStyle=this.drag?.mode==="thumb"||this.thumbHovered?theme.accent:"rgba(255, 255, 255, 0.32)",ctx.beginPath(),ctx.roundRect(thumbX,trackY,thumbW,trackH,3),ctx.fill()}}drawHoverTooltip(ctx,w,padL,padT,plotW,plotH,hp){ctx.save(),ctx.strokeStyle=withAlpha(hp.pilot.color,.35),ctx.lineWidth=5,ctx.beginPath(),ctx.arc(hp.x,hp.y,6,0,Math.PI*2),ctx.stroke(),ctx.fillStyle=hp.pilot.color,ctx.strokeStyle=theme.surface,ctx.lineWidth=1.75,ctx.beginPath(),ctx.arc(hp.x,hp.y,4.5,0,Math.PI*2),ctx.fill(),ctx.stroke();let titleText=`${hp.pilot.callsign} \xB7 Lap ${hp.lap} (${fmtSessionClock(hp.atSec)})`,timeText=`${hp.t.toFixed(3)}s${hp.clipped?" (clipped)":""}`;ctx.font=font(600,11.5);let titleW=ctx.measureText(titleText).width;ctx.font=font(700,12.5,!0);let timeW=ctx.measureText(timeText).width,boxW=Math.max(titleW+28,timeW+24),boxH=44,bx=hp.x-boxW/2;bx=Math.max(padL+4,Math.min(w-16-boxW,bx));let by=hp.y-boxH-12;by<padT+4&&(by=Math.min(padT+plotH-boxH-4,hp.y+12)),ctx.fillStyle=withAlpha(theme.surface,.96),ctx.strokeStyle=withAlpha(hp.pilot.color,.7),ctx.lineWidth=1.25,ctx.beginPath(),ctx.roundRect(bx,by,boxW,boxH,7),ctx.fill(),ctx.stroke(),ctx.fillStyle=hp.pilot.color,ctx.beginPath(),ctx.arc(bx+12,by+15,3.5,0,Math.PI*2),ctx.fill(),ctx.fillStyle=theme.text2,ctx.font=font(600,11.5),ctx.textAlign="left",ctx.fillText(titleText,bx+20,by+18.5),ctx.fillStyle=theme.text,ctx.font=font(700,12.5,!0),ctx.fillText(timeText,bx+10,by+35.5),ctx.restore()}};var LapTimesCard=class extends Component{store;slotIndex;chart;hiddenSlots=new Set;view={kind:"lap"};renderedTabsSig="";constructor(el,store,opts={}){super(el),this.store=store,this.slotIndex=opts.slotIndex,el.innerHTML=`
      <header class="card-head">
        <div><h2>Lap times</h2><p data-slot="subtitle"></p></div>
      </header>
      <div class="canvas-host canvas-host-lg" data-slot="chart"></div>
      <div class="chart-legend" data-slot="legend"></div>
      <div class="channel-legend" data-slot="views" role="tablist" aria-label="Show"></div>`,this.chart=this.adopt(new ProgressionChart(this.slot("chart"),store,{slotIndex:this.slotIndex}));let handleSelect=e=>{let btn=e.target.closest("[data-view]");btn&&(this.view=btn.dataset.view==="lap"?{kind:"lap"}:{kind:"section",sectorIndex:Number(btn.dataset.sector),fromPuckId:Number(btn.dataset.from),toPuckId:Number(btn.dataset.to)},this.chart.setMetric(this.view),this.render())};this.listen(this.slot("views"),"pointerdown",e=>{e.button===0&&handleSelect(e)}),this.listen(this.slot("views"),"click",handleSelect),this.listen(this.slot("legend"),"click",e=>{let btn=e.target.closest("[data-legend-slot]");if(!btn)return;let slot=Number(btn.dataset.legendSlot);Number.isFinite(slot)&&(this.hiddenSlots.has(slot)?this.hiddenSlots.delete(slot):this.hiddenSlots.add(slot),this.chart.setHiddenSlots(this.hiddenSlots),this.render())}),this.onDispose(store.subscribe(["laps","config","selection"],()=>this.render())),this.render()}sections(){let pucks=this.store.pucks;return pucks.length===0?[]:pucks.map((p,i)=>({sectorIndex:i+1,from:p.puckId,to:pucks[(i+1)%pucks.length].puckId}))}render(){let sections=this.sections(),v=this.view;if(v.kind==="section"){let byPair=sections.find(s=>s.from===v.fromPuckId&&s.to===v.toPuckId),byIdx=sections.find(s=>s.sectorIndex===v.sectorIndex),match=byPair??byIdx;match?(match.from!==v.fromPuckId||match.to!==v.toPuckId||match.sectorIndex!==v.sectorIndex)&&(this.view={kind:"section",sectorIndex:match.sectorIndex,fromPuckId:match.from,toPuckId:match.to},this.chart.setMetric(this.view)):(this.view={kind:"lap"},this.chart.setMetric(this.view))}let view=this.view,isActive=(from,to)=>view.kind==="section"&&view.fromPuckId===from&&view.toPuckId===to,tabsSig=sections.map(({sectorIndex,from,to})=>`${sectorIndex}:${from}>${to}:${gateColor(this.store,from)}>${gateColor(this.store,to)}:${sectionShort(this.store,from)}:${sectionLabel(this.store,from,to)}`).join("|"),viewsHost=this.slot("views");if(tabsSig!==this.renderedTabsSig){this.renderedTabsSig=tabsSig;let wholeActive=view.kind==="lap";viewsHost.innerHTML=`<button type="button" role="tab" data-view="lap" class="channel channel-all ${wholeActive?"is-focus":"is-dim"}" aria-selected="${wholeActive}" title="Show whole lap times">
          <span class="dot channel-all-dot"></span>
          <span class="channel-name">Whole lap</span>
          <span class="channel-dbm mono">${sections.length} ${sections.length===1?"section":"sections"}</span>
        </button>`+sections.map(({sectorIndex,from,to})=>{let active=isActive(from,to),dim=!wholeActive&&!active,route=sectionLabel(this.store,from,to);return`<button type="button" role="tab" data-view="section" data-sector="${sectorIndex}" data-from="${from}" data-to="${to}" class="channel ${active?"is-focus":""} ${dim?"is-dim":""}"
                      aria-selected="${active}" title="${esc(route)}">
                      ${renderSectionCapsuleIcon(gateColor(this.store,from),gateColor(this.store,to))}
                      <span class="channel-name">${sectionShort(this.store,from)}</span>
                      <span class="channel-dbm mono">${esc(route)}</span>
                    </button>`}).join("")}else{let wholeActive=view.kind==="lap";viewsHost.querySelectorAll("button[data-view]").forEach(btn=>{let active=btn.dataset.view==="lap"?wholeActive:isActive(Number(btn.dataset.from),Number(btn.dataset.to)),dim=btn.dataset.view==="lap"?!wholeActive:!wholeActive&&!active;btn.classList.toggle("is-focus",active),btn.classList.toggle("is-dim",dim),btn.setAttribute("aria-selected",String(active))})}let single=this.slotIndex!==void 0;this.slot("subtitle").textContent=view.kind==="lap"?single?"Session timeline \xB7 dashed line is their best \xB7 gaps show pit swaps and recovery breaks":"Session timeline \xB7 pilots flying at the same time align \xB7 gaps show pit swaps and breaks":`${sectionShort(this.store,view.fromPuckId)} (${sectionLabel(this.store,view.fromPuckId,view.toPuckId)}) \xB7 ${single?"their":"each pilot's"} time on this stretch across the session timeline`,this.slot("legend").innerHTML=single?"":this.store.enabledPilots.filter(p=>lapsFor(this.store,p.slotIndex).length>0).map(p=>{let hidden=this.hiddenSlots.has(p.slotIndex);return`<button type="button" class="chart-legend-item ${hidden?"is-hidden":""}" data-legend-slot="${p.slotIndex}" aria-pressed="${!hidden}" title="${hidden?`Click to show ${esc(p.callsign)} on chart`:`Click to hide ${esc(p.callsign)} from chart`}">
              <i style="--c:${p.color}"></i>
              <span>${esc(p.callsign)}</span>
            </button>`}).join("")}};var SPARK_LAPS=12,IDLE_REFRESH_MS=5e3,LiveStandings=class extends Component{store;onSelect;constructor(el,store,onSelect){super(el),this.store=store,this.onSelect=onSelect,el.addEventListener("click",this.handleClick),this.onDispose(()=>el.removeEventListener("click",this.handleClick)),this.onDispose(store.subscribe(["laps","crossings","config"],()=>this.render()));let timer=window.setInterval(()=>this.render(),IDLE_REFRESH_MS);this.onDispose(()=>window.clearInterval(timer)),this.render()}handleClick=e=>{let row=e.target.closest("[data-pilot]");row&&this.onSelect(Number(row.dataset.pilot))};render(){let rows=this.store.enabledPilots.map(p=>practiceStats(this.store,p));if(rows.length===0){this.el.innerHTML=renderEmpty("No pilots enabled","Enable pilot slots in System.");return}rows.sort((a,b)=>a.bestLap>0&&b.bestLap>0?a.bestLap-b.bestLap:a.bestLap>0!=b.bestLap>0?a.bestLap>0?-1:1:a.pilot.slotIndex-b.pilot.slotIndex);let sessionBest=rows[0].bestLap,bodyHtml=rows.map((r,i)=>this.renderRow(r,i+1,sessionBest)).join(""),existingBody=this.el.querySelector("table.table-standings tbody");if(existingBody){existingBody.innerHTML=bodyHtml;return}this.el.innerHTML=`
      <div class="table-scroll">
        <table class="table table-standings">
          <thead>
            <tr>
              <th class="col-pos">#</th>
              <th>Pilot</th>
              <th class="num">Laps</th>
              <th class="num">Last</th>
              <th class="num">Best</th>
              <th class="num col-avg">Avg 5</th>
              <th class="num col-gap">Gap</th>
              <th class="col-spark">Recent laps</th>
              <th class="col-progress">On track</th>
            </tr>
          </thead>
          <tbody>${bodyHtml}</tbody>
        </table>
      </div>`}renderRow(s,rank,sessionBest){let{pilot}=s,sector=s.onTrack?currentSectorIndex(this.store,pilot.slotIndex):-1,pucks=this.store.pucks,segments=pucks.map((p,i)=>{let nextPuck=pucks[(i+1)%pucks.length],c1=gateColor(this.store,p.puckId),c2=nextPuck?gateColor(this.store,nextPuck.puckId):c1;return`<span class="seg ${i<sector?"is-done":i===sector?"is-live":""}" style="--c1:${c1};--c2:${c2}"></span>`}).join(""),statusTitle=s.onTrack?"On track":s.laps.length?`Idle \xB7 ${fmtAgo(s.secondsSinceSeen)}`:"Not flown",gap=s.bestLap>0&&sessionBest>0?s.bestLap===sessionBest?'<span class="tone-accent">fastest</span>':fmtDelta(s.bestLap-sessionBest):"";return`
      <tr class="row-link ${s.onTrack?"":"is-idle"}" data-pilot="${pilot.slotIndex}">
        <td class="col-pos"><span class="pos ${rank===1&&s.bestLap>0?"is-leader":""}">${rank}</span></td>
        <td>
          <div class="pilot-cell">
            <span class="pilot-swatch" style="--c:${pilot.color}"></span>
            <div>
              <div class="pilot-name">
                <span>${esc(pilot.callsign)}</span>
                <span class="pilot-live-dot ${s.onTrack?"is-live":""}" title="${statusTitle}"></span>
              </div>
              <div class="pilot-meta">${pilot.channel>0?`R${pilot.channel} \xB7 ${pilot.frequencyMhz} MHz`:'<span class="tone-warn">No channel assigned</span>'}</div>
            </div>
          </div>
        </td>
        <td class="num mono">${s.laps.length}</td>
        <td class="num mono">${fmtTime(s.lastLap)}</td>
        <td class="num mono strong">${fmtTime(s.bestLap)}</td>
        <td class="num mono col-avg">${fmtTime(s.rollingAvg)}</td>
        <td class="num mono muted col-gap">${gap}</td>
        <td class="spark-cell col-spark" style="color:${pilot.color}">${renderSparkline(s.laps.slice(-SPARK_LAPS).map(l=>l.lapTimeSec),96,26)}</td>
        <td class="col-progress">
          <div class="sector-progress">
            <div class="segments">${segments}</div>
            <span class="sector-tag">${sector>=0?`S${sector+1}`:"\u2014"}</span>
          </div>
        </td>
      </tr>`}};var SectionRecords=class extends Component{store;constructor(el,store){super(el),this.store=store,this.onDispose(store.subscribe(["laps","config"],()=>this.render())),this.render()}render(){let records=sectionRecords(this.store),pilots=this.store.enabledPilots.filter(p=>records.some(r=>r.bests.has(p.slotIndex)));if(pilots.length===0){this.el.innerHTML=renderEmpty("No sections flown yet","Section records appear after the first full lap.");return}let head=records.map(r=>`<th class="num" title="${esc(sectionLabel(this.store,r.fromPuckId,r.toPuckId))}">${sectionIdBadge(this.store,r.fromPuckId,r.toPuckId)}</th>`).join(""),rows=pilots.map(p=>{let cells=records.map(r=>{let b=r.bests.get(p.slotIndex);return b?p.slotIndex===r.recordSlot?`<td class="num"><span class="split split-purple">${b.sec.toFixed(3)}</span></td>`:`<td class="num mono muted" title="${b.sec.toFixed(3)}s">${fmtDelta(b.sec-r.recordSec)}</td>`:'<td class="num muted">\u2014</td>'}).join("");return`
          <tr>
            <td>
              <div class="pilot-cell">
                <span class="pilot-swatch" style="--c:${p.color}"></span>
                <div class="pilot-name">${esc(p.callsign)}</div>
              </div>
            </td>
            ${cells}
          </tr>`}).join("");this.el.innerHTML=`
      <div class="table-scroll">
        <table class="table table-compact">
          <thead><tr><th>Pilot</th>${head}</tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div class="legend-row"><span><i class="split-purple"></i>Section record</span><span>Others: gap to the record</span></div>`}};var AllPilotsPanel=class extends Component{store;constructor(el,store,follow){super(el),this.store=store,el.innerHTML=`
      <div class="stat-row" data-slot="stats"></div>
      <section class="card card-flush">
        <header class="card-head"><div><h2>Pilots</h2><p>Ranked by best lap \xB7 click a pilot to follow their current lap</p></div></header>
        <div data-slot="standings"></div>
      </section>
      <section class="card" data-slot="laptimes"></section>
      <section class="card card-flush">
        <header class="card-head"><div><h2>Section records</h2><p>Each pilot's best on every stretch of track \u2014 who is quick where</p></div></header>
        <div data-slot="records"></div>
      </section>`,this.adopt(new LiveStandings(this.slot("standings"),store,follow)),this.adopt(new LapTimesCard(this.slot("laptimes"),store)),this.adopt(new SectionRecords(this.slot("records"),store)),this.onDispose(store.subscribe(["laps","crossings","config","status"],()=>this.renderStats())),this.renderStats()}renderStats(){let s=this.store,flying=s.enabledPilots.filter(p=>practiceStats(s,p).onTrack).length,fastest=fastestLap(s),online=s.pucks.filter(p=>p.online).length;this.slot("stats").innerHTML=renderStatTiles([{label:"Flying now",value:String(flying),sub:`${s.enabledPilots.length} pilots enabled`},{label:"Laps this session",value:String(s.laps.length),sub:s.raceArmed?"Timing on":"Timing paused"},{label:"Session best",value:fmtTime(fastest?.lapTimeSec??0),sub:fastest?`${fastest.callsign} \xB7 lap ${fastest.lapNumber}`:"No laps yet",tone:fastest?"accent":void 0},{label:"Gates online",value:`${online}/${s.pucks.length}`,sub:s.pucks.length?`Lowest battery ${s.pucks.reduce((m,p)=>Math.min(m,p.batteryPct),100)}%`:"No gates",tone:online<s.pucks.length?"bad":void 0}])}};var VISIBLE_LAPS=20,PilotLaps=class extends Component{store;constructor(el,store){super(el),this.store=store,this.onDispose(store.subscribe(["laps","selection","config"],()=>this.render())),this.render()}render(){let pilot=this.store.pilot(this.store.selectedPilot);if(!pilot){this.el.innerHTML=renderEmpty("No pilot selected","Pick a pilot above.");return}let laps=lapsFor(this.store,pilot.slotIndex);if(laps.length===0){this.el.innerHTML=renderEmpty("No laps yet",`${pilot.callsign}'s laps appear here as they complete them.`);return}let pucks=this.store.pucks,cols=pucks.map((p,i)=>({from:p.puckId,to:pucks[(i+1)%pucks.length].puckId})),head=cols.map(c=>`<th class="num" title="${esc(sectionLabel(this.store,c.from,c.to))}"><span class="th-pilot"><span class="dot" style="--c:${gateColor(this.store,c.from)}"></span>${sectionShort(this.store,c.from)}</span></th>`).join(""),rows=[...laps].reverse().slice(0,VISIBLE_LAPS).map(lap=>this.renderLap(lap,cols)).join("");this.el.innerHTML=`
      <div class="table-scroll table-scroll-y">
        <table class="table table-compact">
          <thead><tr><th>Lap</th>${head}<th class="num">Lap time</th><th class="num">vs best</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div class="legend-row">
        <span><i class="split-purple"></i>Track record</span>
        <span><i class="split-good"></i>Own best</span>
        <span><i class="split-bad"></i>&gt;10% off own best</span>
      </div>`}renderLap(lap,cols){let byKey=new Map(lap.sectors.map(s=>[sectionKey(s.fromPuckId,s.toPuckId),s])),cells=cols.map(c=>{let s=byKey.get(sectionKey(c.from,c.to));return s?`<td class="num"><span class="split ${SPLIT_CLASS[s.badge]}">${s.splitSeconds.toFixed(3)}</span></td>`:'<td class="num muted" title="Gate missed">\u2014</td>'}).join(""),vs=lap.isBestLap&&lap.lapNumber>1?'<span class="badge badge-good">PB</span>':lap.deltaToBest>0?fmtDelta(lap.deltaToBest):"best";return`
      <tr>
        <td class="mono">${lap.lapNumber}</td>
        ${cells}
        <td class="num mono strong ${lap.isBestLap?"tone-good":""}">${fmtTime(lap.lapTimeSec)}</td>
        <td class="num mono muted">${vs}</td>
      </tr>`}};var MIN_PEAK_RISE_DB=12,PEAK_SEPARATION_US=4e5,THRESHOLD_FRACTION=.55,WEAK_PASS_MARGIN_DB=4,MIN_FLOOR_MARGIN_DB=8,NOISE_MARGIN_DB=3,PASS_PROMINENCE=.5,MIN_PASSES=2;function percentile(sorted,p){return sorted[Math.min(sorted.length-1,Math.max(0,Math.floor(p*(sorted.length-1))))]}function suggestThreshold(frames,slotPos){let values=frames.map(f=>f.rssi[slotPos]).filter(v=>typeof v=="number");if(values.length<100)return{ok:!1,reason:"not enough signal recorded yet"};let sorted=[...values].sort((a,b)=>a-b),floor=percentile(sorted,.2),peaks=[],lastPeakTs=-1/0;for(let i=0;i<frames.length;i++){let v=frames[i].rssi[slotPos];if(v===void 0||v<floor+MIN_PEAK_RISE_DB)continue;let ts=frames[i].timestampUs;if(ts-lastPeakTs<PEAK_SEPARATION_US)continue;let isMax=!0;for(let j=i-1;j>=0&&ts-frames[j].timestampUs<=PEAK_SEPARATION_US;j--)if((frames[j].rssi[slotPos]??-1/0)>v){isMax=!1;break}for(let j=i+1;isMax&&j<frames.length&&frames[j].timestampUs-ts<=PEAK_SEPARATION_US;j++)(frames[j].rssi[slotPos]??-1/0)>v&&(isMax=!1);isMax&&(peaks.push(v),lastPeakTs=ts)}if(peaks.length<MIN_PASSES)return{ok:!1,reason:peaks.length?"only one pass seen":"no passes seen"};let strong=percentile([...peaks].sort((a,b)=>a-b),.9),passes=peaks.filter(p=>p>=floor+PASS_PROMINENCE*(strong-floor));if(passes.length<MIN_PASSES)return{ok:!1,reason:"not enough clear passes"};let noiseCeiling=percentile(sorted,.9),peak=median(passes),weak=percentile([...passes].sort((a,b)=>a-b),.25),enter=floor+THRESHOLD_FRACTION*(peak-floor);return enter=Math.min(enter,weak-WEAK_PASS_MARGIN_DB),enter=Math.max(enter,floor+MIN_FLOOR_MARGIN_DB,noiseCeiling+NOISE_MARGIN_DB),{ok:!0,enterDbm:Math.round(enter),floorDbm:Math.round(floor),peakDbm:Math.round(peak),passes:passes.length}}var HISTORY_SECONDS=120,HISTORY_SAMPLES=HISTORY_SECONDS*50,HISTORY_TRIM_SLACK=250,MAX_CROSSINGS=1500,MAX_FILTERED=500,MAX_LAPS=5e3,DEFAULT_RULES={minLapSec:5,maxLapSec:120,gateCooldownSec:2,minSectionSec:.5,echoWindowSec:3},AppStore=class{_pilots=[];_pucks=[];_detectedPucks=[];_laps=[];_crossings=[];_filtered=[];_summaries=[];_rules=DEFAULT_RULES;_simulatorRunning=!1;_simState=null;_raceArmed=!0;_liveTime={listenAddr:":5403",connectedClients:0,detectionsSent:0,statusFramesSent:0,lastRfSetupSync:"",raceArmedByHost:!0};_latestTimestampUs=0;_selectedPilot=1;_liveFocus=null;_comparison={lapId:null,reference:"best"};simHistory=new Map;realHistory=new Map;lastCrossingBySlot=new Map;listeners=new Map;lapListeners=new Set;startGateListeners=new Set;get activeHistory(){return this._simulatorRunning?this.simHistory:this.realHistory}onLapRecorded(fn){return this.lapListeners.add(fn),()=>this.lapListeners.delete(fn)}onStartGateDetected(fn){return this.startGateListeners.add(fn),()=>this.startGateListeners.delete(fn)}subscribe(topics,fn){for(let topic of topics){let set=this.listeners.get(topic);set||(set=new Set,this.listeners.set(topic,set)),set.add(fn)}return()=>topics.forEach(t=>this.listeners.get(t)?.delete(fn))}emit(...topics){let fired=new Set;for(let topic of topics)this.listeners.get(topic)?.forEach(fn=>{if(!fired.has(fn)){fired.add(fn);try{fn()}catch(err){console.error(`[AppStore] subscriber error on ${topic}:`,err)}}})}get pilots(){return this._pilots}get enabledPilots(){return this._pilots.filter(p=>p.enabled)}get pucks(){return this._pucks}get detectedPucks(){return this._detectedPucks}get laps(){return this._laps}get crossings(){return this._crossings}get filtered(){return this._filtered}get summaries(){return this._summaries}get rules(){return this._rules}get simulatorRunning(){return this._simulatorRunning}get simState(){return this._simState}get raceArmed(){return this._raceArmed}get liveTime(){return this._liveTime}get latestTimestampUs(){return this._latestTimestampUs}get selectedPilot(){return this._selectedPilot}get liveFocus(){return this._liveFocus}get comparison(){return this._comparison}pilot(slotIndex){return this._pilots.find(p=>p.slotIndex===slotIndex)}puck(puckId){return this._pucks.find(p=>p.puckId===puckId)}summaryFor(slotIndex){return this._summaries.find(s=>s.slotIndex===slotIndex)}lastCrossingFor(slotIndex){return this.lastCrossingBySlot.get(slotIndex)}historyFor(puckId){return this.activeHistory.get(puckId)??[]}hydrate(state){let modeChanged=this._simulatorRunning!==state.simulatorRunning;this._pilots=state.pilots??[],this.setPucks(state.pucks??[]),this._detectedPucks=state.detectedPucks??[],this._laps=state.laps??[],this._crossings=state.crossings??[],this._filtered=state.filtered??[],this._summaries=state.summaries??[],this._rules=state.rules??DEFAULT_RULES,this._simulatorRunning=state.simulatorRunning,this._simState=state.simState??null,this._raceArmed=state.raceArmed,this._liveTime=state.liveTimeStatus,modeChanged&&(this._comparison={lapId:null,reference:"best"}),this.lastCrossingBySlot.clear();let maxTs=state.serverTimestampUs??0;for(let ev of this._crossings)this.lastCrossingBySlot.set(ev.slotIndex,ev),ev.timestampUs>maxTs&&(maxTs=ev.timestampUs);for(let lap of this._laps)lap.completedAtUs>maxTs&&(maxTs=lap.completedAtUs);for(let frames of this.activeHistory.values()){let last=frames[frames.length-1];last&&last.timestampUs>maxTs&&(maxTs=last.timestampUs)}this._latestTimestampUs=maxTs,this.ensureValidSelection(),this.emit("config","laps","crossings","status","selection","rules")}applyStatus(status){let before=this._pucks.map(p=>p.puckId).join(",");this.setPucks(status.pucks??[]),status.detectedPucks&&(this._detectedPucks=status.detectedPucks),status.serverTimestampUs&&status.serverTimestampUs>this._latestTimestampUs&&(this._latestTimestampUs=status.serverTimestampUs),this._simulatorRunning=status.simulatorRunning,status.simState!==void 0?this._simState=status.simState:status.simulatorRunning||(this._simState=null),this._raceArmed=status.raceArmed,this._liveTime=status.liveTimeStatus,before!==this._pucks.map(p=>p.puckId).join(",")?(this.ensureValidSelection(),this.emit("status","config")):this.emit("status")}applyConfig(pilots,pucks){this._pilots=pilots,this.setPucks(pucks),this.ensureValidSelection(),this.emit("config")}applyRules(rules){this._rules=rules,this.emit("rules")}ingestTelemetry(frame){let hist=this.activeHistory,buf=hist.get(frame.puckId);buf||(buf=[],hist.set(frame.puckId,buf)),buf.push(frame),buf.length>HISTORY_SAMPLES+HISTORY_TRIM_SLACK&&buf.splice(0,buf.length-HISTORY_SAMPLES),frame.timestampUs>this._latestTimestampUs&&(this._latestTimestampUs=frame.timestampUs);let puck=this.puck(frame.puckId);puck&&(puck.lastRssi=frame.rssi)}ingestCrossing(ev){this._crossings.push(ev),this._crossings.length>MAX_CROSSINGS&&this._crossings.shift(),ev.timestampUs>this._latestTimestampUs&&(this._latestTimestampUs=ev.timestampUs),this.lastCrossingBySlot.set(ev.slotIndex,ev),this.emit("crossings"),ev.startedLap&&this.startGateListeners.forEach(fn=>fn(ev))}ingestFiltered(f){this._filtered.push(f),this._filtered.length>MAX_FILTERED&&this._filtered.shift(),f.timestampUs>this._latestTimestampUs&&(this._latestTimestampUs=f.timestampUs),this.emit("crossings")}ingestLap(lap,summaries){this._laps.push(lap),this._laps.length>MAX_LAPS&&this._laps.shift(),lap.completedAtUs>this._latestTimestampUs&&(this._latestTimestampUs=lap.completedAtUs),this._summaries=summaries,this.emit("laps"),this.lapListeners.forEach(fn=>fn(lap))}selectPilot(slotIndex){slotIndex!==this._selectedPilot&&(this._selectedPilot=slotIndex,this._comparison={lapId:null,reference:"best"},this.emit("selection"))}setComparison(next){this._comparison={...this._comparison,...next},this.emit("selection")}setLiveFocus(slotIndex){slotIndex!==null&&this.selectPilot(slotIndex),slotIndex!==this._liveFocus&&(this._liveFocus=slotIndex,this.emit("selection"))}setPucks(pucks){this._pucks=[...pucks].sort((a,b)=>a.trackOrder-b.trackOrder)}ensureValidSelection(){let enabled=this.enabledPilots;enabled.length>0&&!enabled.some(p=>p.slotIndex===this._selectedPilot)&&(this._selectedPilot=enabled[0].slotIndex),this._liveFocus!==null&&!enabled.some(p=>p.slotIndex===this._liveFocus)&&(this._liveFocus=null)}};var DBM_MIN=-95,DBM_MAX=-20,WINDOWS_SEC=[5,10,30,60],MIN_WINDOW_US=1e6,MAX_WINDOW_US=6e7,LEGEND_REFRESH_MS=150,MARKER_HIT_PX=7,TAG_H=18,TAG_GAP=4,LINE_HIT_PX=5,TAG_GUTTER=84;var PAD={l:46,r:16+TAG_GUTTER,t:34,b:26},PilotRssiChart=class _PilotRssiChart extends Component{store;api;windowUs=5e6;endUs=null;refUs=0;hoverX=null;hoverY=null;drag=null;tagDrag=null;pending=new Map;tags=[];undo=null;calibMessage="";focus=null;plot={x:PAD.l,w:1,h:1};get padR(){return this.focus===null?16:PAD.r}get shownPucks(){return this.focus===null?this.store.pucks:this.store.pucks.filter(p=>p.puckId===this.focus)}constructor(el,store,api){super(el),this.store=store,this.api=api,el.innerHTML=`
      <div class="scope-toolbar">
        <div class="scope-transport" role="group" aria-label="Signal playback and pass navigation">
          <button class="btn btn-sm btn-ghost scope-step-btn" type="button" data-act="prev" title="Previous pass (\u2190)">
            ${icons.chevronLeft(16)}<span class="scope-step-text-full">Prev pass</span><span class="scope-step-text-short">Prev</span>
          </button>
          <button class="btn btn-sm scope-live-btn" type="button" data-act="live"></button>
          <button class="btn btn-sm btn-ghost scope-step-btn" type="button" data-act="next" title="Next pass (\u2192)">
            <span class="scope-step-text-full">Next pass</span><span class="scope-step-text-short">Next</span>${icons.chevronRight(16)}
          </button>
        </div>
        <span class="scope-hint" data-slot="hint"></span>
        <div class="segmented scope-windows" data-slot="windows" role="group" aria-label="Time window">
          ${WINDOWS_SEC.map(s=>`<button type="button" data-window="${s}">${s}s</button>`).join("")}
        </div>
      </div>
      <div class="canvas-host canvas-host-md scope-canvas" data-slot="chart" tabindex="0"
           aria-label="Signal chart. Space pauses, arrow keys jump between passes."></div>
      <div class="channel-legend" data-slot="legend"></div>
      <div class="scope-calib" data-slot="calib"></div>`;let host=this.slot("chart"),surface=new CanvasSurface(host,(ctx,w,h)=>this.draw(ctx,w,h));this.onDispose(()=>surface.destroy()),this.listen(el,"click",e=>{let btn=e.target.closest("[data-act], [data-window], [data-calib], [data-focus]");btn&&(btn.dataset.focus?(this.focus=btn.dataset.focus==="all"?null:Number(btn.dataset.focus),this.calibMessage="",this.renderControls(),this.renderCalib(),this.renderLegend()):btn.dataset.window?this.setWindow(Number(btn.dataset.window)*1e6):btn.dataset.calib==="auto"?this.autoCalibrate():btn.dataset.calib==="reset"?this.resetToDefault():btn.dataset.calib==="undo"?this.undoLast():btn.dataset.act==="live"?this.toggleLive():btn.dataset.act&&this.jump(btn.dataset.act==="prev"?-1:1))}),this.listen(host,"keydown",e=>{if(e.key===" ")this.toggleLive();else if(e.key==="ArrowLeft")this.jump(-1);else if(e.key==="ArrowRight")this.jump(1);else return;e.preventDefault()}),this.listen(host,"pointerdown",e=>{try{host.setPointerCapture(e.pointerId)}catch{}let r=host.getBoundingClientRect(),grabbed=this.tagAt(e.clientX-r.left,e.clientY-r.top);if(grabbed!==null){this.tagDrag={puckId:grabbed,dbm:this.thresholdOf(grabbed).dbm};return}this.drag={x:e.clientX,endUs:this.viewEnd()},host.classList.add("is-dragging")}),this.listen(host,"pointermove",e=>{let r=host.getBoundingClientRect();if(this.hoverX=e.clientX-r.left,this.hoverY=e.clientY-r.top,this.tagDrag){this.tagDrag.dbm=Math.round(this.dbmAt(this.hoverY));return}if(!this.drag){host.classList.toggle("is-over-tag",this.tagAt(this.hoverX,this.hoverY)!==null);return}let dx=e.clientX-this.drag.x;Math.abs(dx)<2&&this.endUs===null||(this.pauseAt(this.drag.endUs-dx/this.plot.w*this.windowUs),this.renderControls())});let endDrag=()=>{if(this.tagDrag){let{puckId,dbm}=this.tagDrag;this.tagDrag=null,dbm!==this.thresholdOf(puckId).dbm&&this.saveManual(puckId,dbm)}this.drag=null,host.classList.remove("is-dragging")};this.listen(host,"pointerup",endDrag),this.listen(host,"pointercancel",endDrag),this.listen(host,"pointerleave",()=>{this.hoverX=null,this.hoverY=null});let onWheel=e=>{e.preventDefault(),this.zoom(e.deltaY>0?1.25:.8,e.clientX-host.getBoundingClientRect().left)};host.addEventListener("wheel",onWheel,{passive:!1}),this.onDispose(()=>host.removeEventListener("wheel",onWheel));let timer=window.setInterval(()=>{this.slot("legend").matches(":hover")||this.renderLegend()},LEGEND_REFRESH_MS);this.onDispose(()=>window.clearInterval(timer)),this.onDispose(store.subscribe(["selection"],()=>{this.undo=null,this.calibMessage="",this.renderControls(),this.renderCalib()})),this.onDispose(store.subscribe(["config"],()=>{this.focus!==null&&!store.puck(this.focus)&&(this.focus=null),this.renderCalib()})),this.renderControls(),this.renderCalib(),this.renderLegend()}get latest(){return this.store.latestTimestampUs}get earliest(){let firsts=this.store.pucks.map(p=>this.store.historyFor(p.puckId)[0]?.timestampUs??1/0),e=Math.min(...firsts);return Number.isFinite(e)?e:this.latest}viewEnd(){return this.endUs??this.latest}clampEnd(end){return Math.min(this.latest,Math.max(this.earliest+this.windowUs,end))}timeAt(x){return this.viewEnd()-this.windowUs*(1-(x-this.plot.x)/this.plot.w)}yOf(dbm){return PAD.t+this.plot.h*(1-(Math.max(DBM_MIN,Math.min(DBM_MAX,dbm))-DBM_MIN)/(DBM_MAX-DBM_MIN))}dbmAt(y){let v=DBM_MIN+(1-(y-PAD.t)/this.plot.h)*(DBM_MAX-DBM_MIN);return Math.max(DBM_MIN,Math.min(DBM_MAX,v))}setWindow(us){let center=this.viewEnd()-this.windowUs/2;this.windowUs=us,this.endUs!==null&&(this.endUs=this.clampEnd(center+us/2)),this.renderControls()}zoom(factor,x){let anchor=this.timeAt(x),frac=Math.min(1,Math.max(0,(x-this.plot.x)/this.plot.w)),next=Math.min(MAX_WINDOW_US,Math.max(MIN_WINDOW_US,this.windowUs*factor));this.windowUs=next,this.endUs!==null&&(this.endUs=this.clampEnd(anchor+(1-frac)*next)),this.renderControls()}toggleLive(){this.endUs===null?this.pauseAt(this.latest):this.endUs=null,this.renderControls()}pauseAt(end){this.endUs===null&&(this.refUs=this.latest),this.endUs=this.clampEnd(end)}get ref(){return this.endUs===null?this.latest:this.refUs}jump(dir){let center=this.viewEnd()-this.windowUs/2,passes=this.focusedPasses(this.earliest,this.latest),target=dir<0?[...passes].reverse().find(p=>p.ts<center-5e4):passes.find(p=>p.ts>center+5e4);target&&(this.pauseAt(target.ts+this.windowUs/2),this.renderControls())}thresholdOf(puckId){if(this.tagDrag?.puckId===puckId)return{dbm:this.tagDrag.dbm,calibrated:!0};let pending=this.pending.get(puckId);return pending!==void 0?{dbm:pending,calibrated:pending!==0}:enterThresholdAt(this.store,puckId,this.store.selectedPilot)}tagAt(x,y){for(let t of this.tags)if(x>=t.x&&x<=t.x+t.w&&y>=t.y&&y<=t.y+TAG_H)return t.puckId;if(x<PAD.l||x>PAD.l+this.plot.w)return null;let best=null;for(let t of this.tags)Math.abs(y-t.lineY)<=LINE_HIT_PX&&(!best||Math.abs(y-t.lineY)<Math.abs(y-best.lineY))&&(best=t);return best?.puckId??null}currentOverrides(){let slotIndex=this.store.selectedPilot,pos=this.store.pilots.findIndex(p=>p.slotIndex===slotIndex);return this.store.pucks.map(p=>({puckId:p.puckId,slotIndex,enterDbm:p.enterThresholds?.[pos]??0}))}async apply(updates,message){let before=this.currentOverrides().filter(o=>updates.some(u=>u.puckId===o.puckId));updates.forEach(u=>this.pending.set(u.puckId,u.enterDbm===0?this.pilotDefault():u.enterDbm));try{await this.api.setGateThresholds(updates),this.undo=before,this.calibMessage=message}catch{this.calibMessage="Couldn't save the thresholds \u2014 is the timer still running?"}finally{updates.forEach(u=>this.pending.delete(u.puckId)),this.renderCalib()}}pilotDefault(){return this.store.pilot(this.store.selectedPilot)?.enterThreshold??-58}saveManual(puckId,dbm){return this.apply([{puckId,slotIndex:this.store.selectedPilot,enterDbm:dbm}],`${gateLabel(this.store,puckId)} set to ${dbm} dBm.`)}async autoCalibrate(){let pilot=this.store.pilot(this.store.selectedPilot);if(!pilot)return;let pos=this.store.pilots.indexOf(pilot),updates=[],done=[],skipped=[];for(let puck of this.shownPucks){let result=suggestThreshold(this.store.historyFor(puck.puckId),pos),name=gateLabel(this.store,puck.puckId);result.ok?(updates.push({puckId:puck.puckId,slotIndex:pilot.slotIndex,enterDbm:result.enterDbm}),done.push(`${name} ${result.enterDbm}`)):skipped.push(`${name}: ${result.reason}`)}if(updates.length===0){this.calibMessage=`Couldn't calibrate yet \u2014 ${skipped[0]??"no signal"}. Let ${pilot.callsign} fly a few laps with this page open, then try again.`,this.renderCalib();return}let minutes=Math.round(HISTORY_SECONDS/60);await this.apply(updates,`Calibrated from the last ${minutes} min: ${done.join(" \xB7 ")} dBm.${skipped.length?` Skipped ${skipped.join(", ")}.`:""}`)}resetToDefault(){let slotIndex=this.store.selectedPilot,who=this.store.pilot(slotIndex)?.callsign??"the pilot",message=this.focus===null?`Every gate is back on ${who}'s own threshold (${this.pilotDefault()} dBm).`:`${gateLabel(this.store,this.focus)} is back on ${who}'s own threshold (${this.pilotDefault()} dBm).`;return this.apply(this.shownPucks.map(p=>({puckId:p.puckId,slotIndex,enterDbm:0})),message)}async undoLast(){let previous=this.undo;previous&&(this.undo=null,await this.api.setGateThresholds(previous).catch(()=>{}),this.undo=null,this.calibMessage="Undone.",this.renderCalib())}colorOf(puckId){return gateColor(this.store,puckId)}passes(from,to){let slot=this.store.selectedPilot,timed=this.store.crossings.filter(c=>c.slotIndex===slot&&c.timestampUs>=from&&c.timestampUs<=to).map(c=>({ts:c.timestampUs,puckId:c.puckId,counted:!0,title:`${gateLabel(this.store,c.puckId)} \xB7 ${c.estimatedSpeedMph.toFixed(0)} mph`,detail:`Timed \xB7 peak ${c.peakRssiDbm.toFixed(0)} dBm`})),rejected=this.store.filtered.filter(f=>f.slotIndex===slot&&f.timestampUs>=from&&f.timestampUs<=to).map(f=>({ts:f.timestampUs,puckId:f.puckId,counted:!1,title:`${gateLabel(this.store,f.puckId)} \xB7 not counted (${FILTER_LABELS[f.reason]})`,detail:f.detail}));return[...timed,...rejected].sort((a,b)=>a.ts-b.ts)}focusedPasses(from,to){let all=this.passes(from,to);return this.focus===null?all:all.filter(p=>p.puckId===this.focus)}static firstAtOrAfter(frames,ts){let lo=0,hi=frames.length;for(;lo<hi;){let mid=lo+hi>>1;frames[mid].timestampUs<ts?lo=mid+1:hi=mid}return lo}rssiAt(puckId,slot,ts){let frames=this.store.historyFor(puckId);if(frames.length===0)return;let i=Math.min(frames.length-1,_PilotRssiChart.firstAtOrAfter(frames,ts));return frames[i].rssi[slot]}draw(ctx,w,h){let pilot=this.store.pilot(this.store.selectedPilot);if(!pilot)return;let slot=this.store.pilots.indexOf(pilot),plotW=w-PAD.l-this.padR,plotH=h-PAD.t-PAD.b;this.plot={x:PAD.l,w:plotW,h:plotH},this.endUs!==null&&(this.endUs=this.clampEnd(this.endUs));let end=this.viewEnd(),start=end-this.windowUs,xOf=ts=>PAD.l+plotW*((ts-start)/this.windowUs),yOf=dbm=>this.yOf(dbm);if(this.drawGrid(ctx,w,h,start,end,xOf,yOf),this.latest>0){ctx.save(),ctx.beginPath(),ctx.rect(PAD.l,PAD.t-4,plotW,plotH+8),ctx.clip(),ctx.lineJoin="round",ctx.lineWidth=1.6;for(let puck of this.shownPucks){let frames=this.store.historyFor(puck.puckId),from=Math.max(0,_PilotRssiChart.firstAtOrAfter(frames,start)-1),to=Math.min(frames.length-1,_PilotRssiChart.firstAtOrAfter(frames,end));if(to-from<1)continue;let step=Math.max(1,Math.floor((to-from)/plotW));ctx.strokeStyle=this.colorOf(puck.puckId),ctx.beginPath();let first=Math.max(0,from-from%step);for(let i=first;i<=to;i+=step){let x=xOf(frames[i].timestampUs),y=yOf(frames[i].rssi[slot]??DBM_MIN);i===first?ctx.moveTo(x,y):ctx.lineTo(x,y)}ctx.stroke()}ctx.restore()}if(this.focus!==null&&this.drawThresholds(ctx,w,plotW),this.latest===0)return;ctx.font=font(600,10.5);let rows=this.labelRows(ctx,xOf,end),passes=this.focusedPasses(start,end),hovered=null;passes.forEach(p=>{let x=xOf(p.ts),color=p.counted?this.colorOf(p.puckId):theme.bad;ctx.save(),ctx.strokeStyle=withAlpha(color,p.counted?.7:.9),ctx.lineWidth=p.counted?1:1.5,ctx.setLineDash(p.counted?[2,3]:[5,3]),ctx.beginPath(),ctx.moveTo(x,PAD.t),ctx.lineTo(x,PAD.t+plotH),ctx.stroke(),ctx.restore(),ctx.fillStyle=color,ctx.font=font(600,10.5),ctx.fillText(this.labelOf(p),x+5,PAD.t-18+(rows.get(_PilotRssiChart.keyOf(p))??0)*12),this.hoverX!==null&&Math.abs(this.hoverX-x)<=MARKER_HIT_PX&&(hovered=p)}),!this.tagDrag&&this.hoverX!==null&&this.hoverX>=PAD.l&&this.hoverX<=PAD.l+plotW&&this.drawCursor(ctx,h,plotH,this.hoverX,hovered)}drawThresholds(ctx,w,plotW){ctx.font=font(700,10.5);let items=this.shownPucks.map(p=>{let t=this.thresholdOf(p.puckId),name=gateLabel(this.store,p.puckId),text=`${name.length>8?`${name.slice(0,7)}\u2026`:name} ${t.dbm.toFixed(0)}`;return{puckId:p.puckId,...t,text,lineY:this.yOf(t.dbm),width:ctx.measureText(text).width+14}}),colW=Math.max(...items.map(i=>i.width),40)+TAG_GAP,columns=[],placed=[];for(let item of[...items].sort((a,b)=>a.lineY-b.lineY)){let top=item.lineY-TAG_H/2,col=0;for(;columns[col]?.some(o=>Math.abs(o.top-top)<TAG_H+2);)col++;(columns[col]??=[]).push({top}),placed.push({puckId:item.puckId,x:w-16-item.width-col*colW,y:top,w:item.width,lineY:item.lineY})}this.tags=placed;let active=this.tagDrag?.puckId??(this.hoverX!==null&&this.hoverY!==null?this.tagAt(this.hoverX,this.hoverY):null);for(let item of items){let color=this.colorOf(item.puckId),box=placed.find(b=>b.puckId===item.puckId),isActive=active===item.puckId;ctx.save(),ctx.strokeStyle=withAlpha(color,isActive?.95:.45),ctx.lineWidth=isActive?1.5:1,ctx.setLineDash([6,4]),ctx.beginPath(),ctx.moveTo(PAD.l,item.lineY),ctx.lineTo(Math.max(PAD.l+plotW,box.x),item.lineY),ctx.stroke(),ctx.restore(),ctx.beginPath(),ctx.roundRect(box.x,box.y,box.w,TAG_H,5),item.calibrated?(ctx.fillStyle=color,ctx.fill()):(ctx.fillStyle=theme.surface,ctx.fill(),ctx.strokeStyle=color,ctx.lineWidth=1,ctx.stroke()),isActive&&(ctx.strokeStyle=theme.text,ctx.lineWidth=1.5,ctx.stroke()),ctx.fillStyle=item.calibrated?"#0b0d10":color,ctx.font=font(700,10.5),ctx.textAlign="left",ctx.fillText(item.text,box.x+7,box.y+12.5)}}labelOf(p){return p.counted?p.title:`\u2715 ${p.title}`}labelRows(ctx,xOf,end){let rows=new Map,rowEnd=[-1/0,-1/0];for(let p of this.focusedPasses(this.earliest,end)){let x=xOf(p.ts)+5,width=ctx.measureText(this.labelOf(p)).width,row=x>rowEnd[0]+6?0:x>rowEnd[1]+6?1:0;rowEnd[row]=x+width,rows.set(_PilotRssiChart.keyOf(p),row)}return rows}static keyOf(p){return`${p.ts}:${p.puckId}:${p.counted?1:0}`}drawGrid(ctx,w,h,start,end,xOf,yOf){ctx.font=font(500,10.5,!0),ctx.lineWidth=1;for(let level of[-90,-75,-60,-45,-30]){let y=Math.round(yOf(level))+.5;ctx.strokeStyle=theme.grid,ctx.beginPath(),ctx.moveTo(PAD.l,y),ctx.lineTo(w-this.padR,y),ctx.stroke(),ctx.fillStyle=theme.text3,ctx.textAlign="right",ctx.fillText(`${level}`,PAD.l-10,y+3.5)}let ref=this.ref,stepUs=(this.windowUs<=6e6?1:this.windowUs<=12e6?2:this.windowUs<=35e6?5:10)*1e6;ctx.textAlign="center",ctx.fillStyle=theme.text3;for(let t=ref-Math.floor((ref-start)/stepUs)*stepUs;t<=end+1;t+=stepUs){let ago=Math.round((ref-t)/1e6);ctx.fillText(ago===0?this.endUs===null?"now":"paused":`\u2212${ago}s`,xOf(t),h-8)}ctx.textAlign="left"}drawCursor(ctx,h,plotH,x,hovered){ctx.save(),ctx.strokeStyle=withAlpha(theme.text,.25),ctx.beginPath(),ctx.moveTo(x+.5,PAD.t),ctx.lineTo(x+.5,PAD.t+plotH),ctx.stroke(),ctx.restore();let ago=(this.ref-this.timeAt(x))/1e6,label=ago<.05?"now":`\u2212${ago.toFixed(2)}s`;ctx.font=font(600,10.5,!0);let lw=ctx.measureText(label).width+10;if(ctx.fillStyle=theme.surface,ctx.fillRect(x-lw/2,h-20,lw,16),ctx.fillStyle=theme.text,ctx.textAlign="center",ctx.fillText(label,x,h-8),ctx.textAlign="left",!hovered)return;let lines=[hovered.title,hovered.detail];ctx.font=font(500,11.5);let boxW=Math.max(...lines.map(l=>ctx.measureText(l).width))+20,boxH=42,bx=Math.min(x+10,PAD.l+this.plot.w-boxW),by=PAD.t+8;ctx.fillStyle=withAlpha(theme.surface,.95),ctx.strokeStyle=hovered.counted?theme.gridStrong:withAlpha(theme.bad,.6),ctx.beginPath(),ctx.roundRect(bx,by,boxW,boxH,6),ctx.fill(),ctx.stroke(),ctx.fillStyle=hovered.counted?theme.text:theme.bad,ctx.font=font(600,11.5),ctx.fillText(lines[0],bx+10,by+17),ctx.fillStyle=theme.text2,ctx.font=font(500,11.5),ctx.fillText(lines[1],bx+10,by+33)}renderControls(){let live=this.endUs===null,btn=this.el.querySelector('[data-act="live"]');btn.className=`btn btn-sm scope-live-btn ${live?"btn-armed":"btn-ghost"}`,btn.title=live?"Following live signal stream \u2014 click to pause (Space)":"Stream paused \u2014 click to resume live stream (Space)",btn.setAttribute("aria-label",btn.title),btn.setAttribute("aria-pressed",String(live)),btn.innerHTML=`<span class="status-dot ${live?"is-up":""}"></span><span>Live</span>`;let gateScope=this.focus===null?"all gates":gateLabel(this.store,this.focus),prevBtn=this.el.querySelector('[data-act="prev"]'),nextBtn=this.el.querySelector('[data-act="next"]');prevBtn&&(prevBtn.title=`Previous pass at ${gateScope} (\u2190)`),nextBtn&&(nextBtn.title=`Next pass at ${gateScope} (\u2192)`),this.slot("windows").querySelectorAll("[data-window]").forEach(b=>b.classList.toggle("is-active",Number(b.dataset.window)*1e6===Math.round(this.windowUs))),this.slot("hint").textContent=live?"Live \xB7 drag to scroll back, wheel to zoom":"Paused \xB7 drag to scroll, wheel to zoom"}renderCalib(){let pilot=this.store.pilot(this.store.selectedPilot);if(!pilot)return;let minutes=Math.round(HISTORY_SECONDS/60),text,actions;if(this.focus===null){let anyCalibrated=this.store.pucks.some(p=>enterThresholdAt(this.store,p.puckId,pilot.slotIndex).calibrated);text=this.calibMessage||"Select a gate above to view or drag its threshold, or auto-calibrate all gates.",actions=`
        <div class="scope-calib-actions">
          ${this.undo?`<button class="btn btn-sm btn-ghost" type="button" data-calib="undo">${icons.reset(15)}<span>Undo</span></button>`:""}
          ${anyCalibrated?`<button class="btn btn-sm btn-ghost" type="button" data-calib="reset" title="Use ${esc(pilot.callsign)}'s own threshold at every gate">${icons.reset(15)}<span>Reset all</span></button>`:""}
          <button class="btn btn-sm btn-ghost" type="button" data-calib="auto" title="Set each gate's threshold from the last ${minutes} minutes of signal">${icons.target(16)}<span>Auto-calibrate all</span></button>
        </div>`}else{let name=gateLabel(this.store,this.focus),t=enterThresholdAt(this.store,this.focus,pilot.slotIndex);text=this.calibMessage||`${name}: ${t.dbm.toFixed(0)} dBm ${t.calibrated?"(calibrated)":`(${pilot.callsign}'s default)`} \xB7 drag line to adjust`,actions=`
        <div class="scope-calib-actions">
          ${this.undo?`<button class="btn btn-sm btn-ghost" type="button" data-calib="undo">${icons.reset(15)}<span>Undo</span></button>`:""}
          ${t.calibrated?`<button class="btn btn-sm btn-ghost" type="button" data-calib="reset" title="Use ${esc(pilot.callsign)}'s own threshold at ${esc(name)}">${icons.reset(15)}<span>Reset</span></button>`:""}
          <button class="btn btn-sm btn-ghost" type="button" data-calib="auto" title="Set ${esc(name)}'s threshold from the last ${minutes} minutes of signal">${icons.target(16)}<span>Auto-calibrate</span></button>
        </div>`}this.slot("calib").innerHTML=`
      <span class="scope-calib-text">${esc(text)}</span>
      ${actions}`}renderLegend(){let pilot=this.store.pilot(this.store.selectedPilot);if(!pilot)return;let slot=this.store.pilots.indexOf(pilot),at=this.hoverX!==null&&this.hoverX>=this.plot.x&&this.hoverX<=this.plot.x+this.plot.w?this.timeAt(this.hoverX):this.viewEnd(),allChip=`
      <button type="button" class="channel channel-all ${this.focus===null?"is-focus":"is-dim"}"
              data-focus="all" title="Show all gates (${this.store.pucks.length})">
        <span class="dot channel-all-dot"></span>
        <span class="channel-name">All gates</span>
        <span class="channel-dbm mono">${this.store.pucks.length} gates</span>
      </button>`,gateChips=this.store.pucks.map(p=>{let dbm=this.rssiAt(p.puckId,slot,at)??DBM_MIN,hot=dbm>=this.thresholdOf(p.puckId).dbm,dim=this.focus!==null&&this.focus!==p.puckId;return`
          <button type="button" class="channel ${hot?"is-hot":""} ${dim?"is-dim":""} ${this.focus===p.puckId?"is-focus":""}"
                  data-focus="${this.focus===p.puckId?"all":p.puckId}" title="${this.focus===p.puckId?"Show all gates":"Show only this gate"}">
            <span class="dot" style="--c:${this.colorOf(p.puckId)}"></span>
            <span class="channel-name">${esc(gateLabel(this.store,p.puckId))}</span>
            <span class="channel-dbm mono">${dbm.toFixed(0)} dBm</span>
          </button>`}).join("");this.slot("legend").innerHTML=allChip+gateChips}};var CLOCK_REFRESH_MS=100,NEGLIGIBLE_SEC=.01,PilotPanel=class extends Component{store;constructor(el,store,api){super(el),this.store=store,el.innerHTML=`
      <div class="stat-row" data-slot="stats"></div>
      <section class="card">
        <header class="card-head"><div><h2>Signal at each gate</h2><p>This pilot's 5.8 GHz signal as every gate sees it \xB7 pick one gate to see and adjust its threshold \xB7 red pass lines didn't count \u2014 hover for why</p></div></header>
        <div data-slot="rssi"></div>
      </section>
      <section class="card" data-slot="laptimes"></section>
      <section class="card card-flush">
        <header class="card-head"><div><h2>Laps</h2><p>Completed laps, newest first \xB7 each section against the pilot's own best</p></div></header>
        <div data-slot="laps"></div>
      </section>`,this.adopt(new PilotRssiChart(this.slot("rssi"),store,api)),this.adopt(new LapTimesCard(this.slot("laptimes"),store,{slotIndex:()=>store.selectedPilot})),this.adopt(new PilotLaps(this.slot("laps"),store));let timer=window.setInterval(()=>this.renderStats(),CLOCK_REFRESH_MS);this.onDispose(()=>window.clearInterval(timer)),this.renderStats()}renderStats(){let pilot=this.store.pilot(this.store.selectedPilot);if(!pilot){this.slot("stats").innerHTML="";return}let s=practiceStats(this.store,pilot);this.slot("stats").innerHTML=renderStatTiles([this.lapInProgressTile(pilot.slotIndex,s.laps.length,s.secondsSinceSeen),{label:"Last lap",value:fmtTime(s.lastLap),sub:s.lastLap>0&&s.bestLap>0?s.lastLap===s.bestLap?"Personal best":`${fmtDelta(s.lastLap-s.bestLap)} vs best`:"\u2014"},{label:"Best lap",value:fmtTime(s.bestLap),sub:`${s.laps.length} laps this session`,tone:s.bestLap>0?"accent":void 0},{label:"Average, last 5",value:fmtTime(s.rollingAvg),sub:Number.isFinite(s.trend)?`${fmtDelta(s.trend)} vs the 5 before`:"Trend after 10 laps",tone:Number.isFinite(s.trend)?s.trend<0?"good":"bad":void 0}])}lapInProgressTile(slotIndex,lapsFlown,secondsSinceSeen2){let live=currentLap(this.store,slotIndex);if(!live)return{label:"Lap in progress",value:"\u2014",sub:Number.isFinite(secondsSinceSeen2)?`Not on a lap \xB7 last seen ${fmtAgo(secondsSinceSeen2)}`:lapsFlown?"Not on a lap":"Not flown yet"};let anyDone=live.sections.some(x=>x.state==="done"&&x.bestSec>0),d=live.deltaSoFar;return{label:`Lap ${live.lapNumber} in progress`,value:fmtRaceClock(live.elapsedSec),sub:anyDone?`${fmtDelta(d)} vs own best sections`:"First section\u2026",subTone:!anyDone||Math.abs(d)<NEGLIGIBLE_SEC?void 0:d>0?"bad":"good"}}};var LiveView=class extends Component{store;api;panel=null;shownFocus=void 0;constructor(el,store,api){super(el),this.store=store,this.api=api,el.innerHTML=`
      <div class="picker-row">
        <div data-slot="picker"></div>
      </div>
      <div class="view-stack" data-slot="panel"></div>`,this.adopt(new PilotPicker(this.slot("picker"),store,{includeAll:!0,value:()=>store.liveFocus,onSelect:slot=>store.setLiveFocus(slot)})),this.onDispose(()=>this.panel?.destroy()),this.onDispose(store.subscribe(["selection","config"],()=>this.showPanel())),this.showPanel()}showPanel(){let focus=this.store.liveFocus,mode=focus===null?null:0,shownMode=this.shownFocus===void 0?void 0:this.shownFocus===null?null:0;if(this.shownFocus=focus,mode===shownMode)return;this.panel?.destroy();let host=this.slot("panel");this.panel=focus===null?new AllPilotsPanel(host,this.store,slot=>this.store.setLiveFocus(slot)):new PilotPanel(host,this.store,this.api)}};var NEGLIGIBLE_SEC2=.01,NOTABLE_MPH=3,LapComparison=class extends Component{store;constructor(el,store){super(el),this.store=store,this.onDispose(store.subscribe(["laps","selection","config"],()=>this.render())),this.render()}render(){let cmp=resolveComparison(this.store,this.store.selectedPilot);if(!cmp){this.el.innerHTML=renderEmpty("Fly at least two laps","Then click a bar above to see where that lap gained or lost time.");return}let maxAbs=Math.max(NEGLIGIBLE_SEC2,...cmp.sections.map(s=>Math.abs(s.delta)));this.el.innerHTML=`
      <div class="table-scroll">
        <table class="table cmp-table">
          <thead>
            <tr>
              <th>Section</th>
              <th class="num">Lap ${cmp.lap.lapNumber}</th>
              <th class="num">Lap ${cmp.ref.lapNumber}</th>
              <th class="col-delta">Gained / lost</th>
              <th class="num">Exit speed</th>
            </tr>
          </thead>
          <tbody>${cmp.sections.map(s=>this.renderRow(s,maxAbs)).join("")}</tbody>
          <tfoot>
            <tr>
              <td>Full lap</td>
              <td class="num mono strong">${fmtTime(cmp.lap.lapTimeSec)}</td>
              <td class="num mono muted">${fmtTime(cmp.ref.lapTimeSec)}</td>
              <td class="col-delta"><span class="mono strong ${toneOf(cmp.totalDelta)}">${fmtDelta(cmp.totalDelta)}</span></td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>
      ${this.renderAnalysis(cmp)}`}sectionName(s){return`${sectionShort(this.store,s.fromPuckId)} \xB7 ${sectionLabel(this.store,s.fromPuckId,s.toPuckId)}`}renderAnalysis(cmp){let{lap,ref,refLabel,totalDelta}=cmp,isEven=Math.abs(totalDelta)<NEGLIGIBLE_SEC2,isFaster=totalDelta<0,refTime=fmtTime(ref.lapTimeSec),refText=refLabel.endsWith(")")?refLabel.replace(/\)$/,`, ${refTime})`):`${refLabel} (${refTime})`,lead=isEven?`Lap ${lap.lapNumber} (${fmtTime(lap.lapTimeSec)}) matched ${esc(refText)}.`:`Lap ${lap.lapNumber} (${fmtTime(lap.lapTimeSec)}) was <strong>${Math.abs(totalDelta).toFixed(3)}s ${isFaster?"faster":"slower"}</strong> than ${esc(refText)}.`,points=[],key=isEven?void 0:decisiveSection(cmp);if(key&&Math.abs(key.delta)>=NEGLIGIBLE_SEC2){points.push(`${isFaster?"Most of the gain came in":"Most of the time was lost in"} <strong>${esc(this.sectionName(key))}</strong> (${fmtDelta(key.delta)}s).`);let mph=key.lapExitMph-key.refExitMph;Math.abs(mph)>=NOTABLE_MPH&&points.push(`You exited that section <strong>${Math.abs(mph).toFixed(0)} mph ${mph<0?"slower":"faster"}</strong> (${key.lapExitMph.toFixed(0)} vs ${key.refExitMph.toFixed(0)} mph)${mph<0&&!isFaster?" \u2014 carrying less speed out of it cost time into the next one too":""}.`)}let counter=cmp.sections.filter(s=>(isFaster?s.delta>0:s.delta<0)&&Math.abs(s.delta)>=NEGLIGIBLE_SEC2).sort((a,b)=>Math.abs(b.delta)-Math.abs(a.delta))[0];return!isEven&&counter&&points.push(isFaster?`It wasn't faster everywhere: <strong>${esc(this.sectionName(counter))}</strong> was ${Math.abs(counter.delta).toFixed(3)}s slower.`:`You did gain time in <strong>${esc(this.sectionName(counter))}</strong> (${fmtDelta(counter.delta)}s).`),cmp.incomplete&&points.push("Some sections couldn't be compared because a gate was missed on one of the laps."),`
      <div class="lap-analysis">
        <p class="rec-lead">${lead}</p>
        ${points.length?`<ul class="rec-list">${points.map(p=>`<li>${p}</li>`).join("")}</ul>`:""}
      </div>`}renderRow(s,maxAbs){let width=Math.min(50,Math.abs(s.delta)/maxAbs*50),side=s.delta>0?"loss":"gain",mph=s.lapExitMph-s.refExitMph;return`
      <tr>
        <td>
          ${this.route(s)}
        </td>
        <td class="num mono">${s.lapSec.toFixed(3)}</td>
        <td class="num mono muted">${s.refSec.toFixed(3)}</td>
        <td class="col-delta">
          <div class="delta-cell">
            <div class="diverge"><span class="diverge-bar is-${side}" style="width:${width.toFixed(1)}%"></span></div>
            <span class="mono ${toneOf(s.delta)}">${fmtDelta(s.delta)}</span>
          </div>
        </td>
        <td class="num mono">
          ${s.lapExitMph.toFixed(0)}<small> vs ${s.refExitMph.toFixed(0)}</small>
          ${Math.abs(mph)>=NOTABLE_MPH?`<span class="${mph<0?"tone-bad":"tone-good"}">${mph>0?"+":"\u2212"}${Math.abs(mph).toFixed(0)}</span>`:""}
        </td>
      </tr>`}route(s){return routeLabel(this.store,s.fromPuckId,s.toPuckId)}};function toneOf(delta){return Math.abs(delta)<NEGLIGIBLE_SEC2?"muted":delta>0?"tone-bad":"tone-good"}var CHART_W=1e3,CHART_H=150,WINDOW_LAPS_DESKTOP=50,WINDOW_LAPS_MOBILE=16,OUTLIER_FACTOR2=1.35,LapPicker=class extends Component{store;hoveredLapId=null;activeSlot="review";followLatest=!0;savedScrollLeft=0;lastPilotSlot=null;sbDrag=null;chartPan=null;suppressClick=!1;wasMobileWindow=!1;chartGeom=null;windowLaps(){return window.innerWidth<=680?WINDOW_LAPS_MOBILE:WINDOW_LAPS_DESKTOP}constructor(el,store){super(el),this.store=store,this.wasMobileWindow=window.innerWidth<=680;let handleAction=e=>{if(this.suppressClick){this.suppressClick=!1;return}let target=e.target;if(target.closest("[data-scroll-latest]")){this.followLatest=!0,this.scrollToLatest(),this.syncLatestButton();return}let pickSlotBtn=target.closest("[data-pick-slot]");if(pickSlotBtn){let slot=pickSlotBtn.dataset.pickSlot;this.activeSlot=slot==="ref"?"ref":"review",this.render();return}let refPreset=target.closest("[data-ref]");if(refPreset){this.setRefPreset(refPreset.dataset.ref);return}let bar=target.closest("[data-lap]");bar&&this.onBarClick(Number(bar.dataset.lap))};this.listen(el,"pointerdown",e=>{if(e.pointerType==="mouse"&&e.button!==0)return;let target=e.target,sbTrack=target.closest("[data-sb-track]");if(sbTrack){e.preventDefault();let scroller=this.el.querySelector(".lap-picker-scroll");if(!scroller)return;let maxScroll=Math.max(0,scroller.scrollWidth-scroller.clientWidth);if(maxScroll<=0)return;let rect=sbTrack.getBoundingClientRect(),thumb=sbTrack.querySelector("[data-sb-thumb]"),thumbW=thumb?thumb.getBoundingClientRect().width:32,travel=Math.max(1,rect.width-thumbW);if(!target.closest("[data-sb-thumb]")){let clickRatio=Math.max(0,Math.min(1,(e.clientX-rect.left-thumbW/2)/travel));scroller.scrollLeft=clickRatio*maxScroll,this.onScroll(scroller)}this.sbDrag={startX:e.clientX,startScrollLeft:scroller.scrollLeft},sbTrack.classList.add("is-dragging");try{el.setPointerCapture(e.pointerId)}catch{}return}if(e.pointerType==="mouse"){let scrollArea=target.closest(".lap-picker-scroll.is-scrollable");if(scrollArea){this.chartPan={startX:e.clientX,startScrollLeft:scrollArea.scrollLeft,moved:!1};return}handleAction(e)}}),this.listen(el,"click",handleAction),this.listen(el,"pointermove",e=>{if(this.sbDrag){let scroller=this.el.querySelector(".lap-picker-scroll"),sbTrack=this.el.querySelector("[data-sb-track]"),thumb=this.el.querySelector("[data-sb-thumb]");if(scroller&&sbTrack&&thumb){let maxScroll=Math.max(1,scroller.scrollWidth-scroller.clientWidth),travel=Math.max(1,sbTrack.clientWidth-thumb.offsetWidth),dx=e.clientX-this.sbDrag.startX;scroller.scrollLeft=Math.max(0,Math.min(maxScroll,this.sbDrag.startScrollLeft+dx/travel*maxScroll)),this.onScroll(scroller)}return}if(this.chartPan){let dx=e.clientX-this.chartPan.startX;if(!this.chartPan.moved&&Math.abs(dx)>5){this.chartPan.moved=!0,this.suppressClick=!0;try{el.setPointerCapture(e.pointerId)}catch{}}if(this.chartPan.moved){let scroller=this.el.querySelector(".lap-picker-scroll");scroller&&(scroller.scrollLeft=this.chartPan.startScrollLeft-dx,this.onScroll(scroller));return}}let track=this.el.querySelector(".lap-picker-track");if(!track)return;let laps=lapsFor(this.store,this.store.selectedPilot);if(laps.length===0)return;let r=track.getBoundingClientRect();if(r.width<=0)return;let relX=Math.max(0,Math.min(.9999,(e.clientX-r.left)/r.width)),idx=Math.floor(relX*laps.length),lapId=laps[idx]?.lapId??null;lapId!==this.hoveredLapId&&(this.hoveredLapId=lapId,this.syncHoveredPin())});let endDrag=e=>{if(this.sbDrag&&(this.sbDrag=null,this.el.querySelector("[data-sb-track]")?.classList.remove("is-dragging")),this.chartPan){let wasClick=!this.chartPan.moved;this.chartPan=null,wasClick&&handleAction(e)}el.hasPointerCapture(e.pointerId)&&el.releasePointerCapture(e.pointerId)};this.listen(el,"pointerup",endDrag),this.listen(el,"pointercancel",endDrag),this.listen(el,"pointerleave",()=>{this.hoveredLapId!==null&&(this.hoveredLapId=null,this.syncHoveredPin())}),this.listen(el,"dblclick",e=>{let scroller=this.el.querySelector(".lap-picker-scroll");!scroller||scroller.scrollWidth<=scroller.clientWidth+2||e.target.closest("[data-set-ref], [data-ref]")||(this.followLatest=!0,this.scrollToLatest(),this.syncLatestButton(),this.syncScrollbar())}),this.listen(el,"wheel",e=>{let scroller=this.el.querySelector(".lap-picker-scroll");if(!scroller||scroller.scrollWidth<=scroller.clientWidth+2)return;let delta=Math.abs(e.deltaX)>Math.abs(e.deltaY)?e.deltaX:e.deltaY;delta!==0&&(e.preventDefault(),scroller.scrollLeft+=delta,this.onScroll(scroller))},{passive:!1}),this.onDispose(store.subscribe(["laps","selection","config"],()=>this.render()));let onResize=()=>{let isMobile=window.innerWidth<=680;isMobile!==this.wasMobileWindow&&(this.wasMobileWindow=isMobile,this.render())};window.addEventListener("resize",onResize,{passive:!0}),this.onDispose(()=>window.removeEventListener("resize",onResize)),this.render()}onScroll(scroller){this.savedScrollLeft=scroller.scrollLeft;let maxScroll=Math.max(0,scroller.scrollWidth-scroller.clientWidth);this.followLatest=scroller.scrollLeft>=maxScroll-8,this.syncLatestButton(),this.syncScrollbar(),this.syncHoveredPin()}scrollToLatest(){let scroller=this.el.querySelector(".lap-picker-scroll");scroller&&(scroller.scrollLeft=Math.max(0,scroller.scrollWidth-scroller.clientWidth),this.savedScrollLeft=scroller.scrollLeft,this.syncScrollbar())}syncScrollbar(){let scroller=this.el.querySelector(".lap-picker-scroll"),thumb=this.el.querySelector("[data-sb-thumb]");if(!scroller||!thumb)return;let maxScroll=Math.max(0,scroller.scrollWidth-scroller.clientWidth);if(maxScroll<=0)return;let ratio=scroller.clientWidth/scroller.scrollWidth,thumbPct=Math.max(6,Math.min(100,ratio*100)),leftPct=Math.max(0,Math.min(1,scroller.scrollLeft/maxScroll))*(100-thumbPct);thumb.style.width=`${thumbPct.toFixed(2)}%`,thumb.style.left=`${leftPct.toFixed(2)}%`}syncLatestButton(){let btn=this.el.querySelector("[data-scroll-latest]");btn&&(btn.style.display=this.followLatest?"none":"")}syncHoveredPin(){this.el.querySelectorAll(".bar-hit[data-lap]").forEach(g=>{g.classList.toggle("is-hovered",Number(g.dataset.lap)===this.hoveredLapId)});let label=this.el.querySelector("[data-hover-time]"),geom=this.chartGeom,idx=geom&&this.hoveredLapId!==null?geom.laps.findIndex(l=>l.lapId===this.hoveredLapId):-1;if(!label||!geom||idx<0||geom.labelled.has(this.hoveredLapId)){label&&(label.hidden=!0);return}label.textContent=fmtTime(geom.laps[idx].lapTimeSec),label.className=`bar-time is-hover ${geom.edgeClass(idx)}`,label.style.left=`${geom.xPct[idx].toFixed(2)}%`,label.style.top=`${geom.barTopPct[idx].toFixed(2)}%`,label.hidden=!1}onBarClick(lapId){let laps=lapsFor(this.store,this.store.selectedPilot),currentReviewId=resolveComparison(this.store,this.store.selectedPilot)?.lap.lapId??laps[laps.length-1]?.lapId;if(this.activeSlot==="ref"&&laps.length>=2&&lapId!==currentReviewId){this.activeSlot="review",this.store.setComparison({reference:lapId});return}this.activeSlot="review";let ref=this.store.comparison.reference;this.store.setComparison(ref===lapId?{lapId,reference:"best"}:{lapId})}setRefPreset(choice){if(choice==="custom"){this.activeSlot="ref",this.render();return}this.activeSlot="review",this.store.setComparison({reference:choice==="previous"?"previous":"best"})}render(){this.lastPilotSlot!==this.store.selectedPilot&&(this.lastPilotSlot=this.store.selectedPilot,this.activeSlot="review",this.followLatest=!0,this.savedScrollLeft=0);let prevScroller=this.el.querySelector(".lap-picker-scroll");prevScroller&&prevScroller.scrollWidth>prevScroller.clientWidth+2&&this.onScroll(prevScroller);let laps=lapsFor(this.store,this.store.selectedPilot),cmp=resolveComparison(this.store,this.store.selectedPilot),head=this.renderHead(laps.length,cmp?.ref);if(laps.length===0){this.chartGeom=null,this.el.innerHTML=head+renderEmpty("No laps yet","Each completed lap shows up here as a bar.");return}let reviewId=cmp?.lap.lapId??laps[laps.length-1].lapId,refId=cmp?.ref.lapId??-1;this.el.innerHTML=head+this.renderChart(laps,reviewId,refId);let nextScroller=this.el.querySelector(".lap-picker-scroll");nextScroller&&(nextScroller.addEventListener("scroll",()=>this.onScroll(nextScroller),{passive:!0}),this.followLatest?this.scrollToLatest():(nextScroller.scrollLeft=this.savedScrollLeft,this.syncScrollbar()),this.syncLatestButton()),this.syncHoveredPin()}renderHead(lapCount,refLap){let winLaps=this.windowLaps(),scrollable=lapCount>winLaps,canCompare=lapCount>=2,refMode=this.store.comparison.reference,picking=this.activeSlot==="ref",customActive=picking||typeof refMode=="number",customLabel=picking?"Click a bar\u2026":typeof refMode=="number"&&refLap?`Lap ${refLap.lapNumber}`:"Pick a lap",btn=(key,label,active,extra="")=>`<button type="button" data-ref="${key}" class="${active?"is-active":""} ${extra}" ${canCompare?"":"disabled"}>${label}</button>`;return`
      <header class="card-head">
        <div>
          <h2>Lap stats</h2>
          <p>Click any bar to inspect that lap, then choose what to compare it against.</p>
        </div>
        <div class="cmp-with">
          ${scrollable?`<button type="button" class="btn btn-sm btn-ghost" data-scroll-latest style="${this.followLatest?"display:none":""}">Latest ${winLaps} \u2192</button>`:""}
          <span>Compare against</span>
          <div class="segmented">
            ${btn("best","Personal best",refMode==="best"&&!customActive)}
            ${btn("previous","Previous lap",refMode==="previous"&&!customActive)}
            ${btn("custom",customLabel,customActive,"is-ref-chip")}
          </div>
        </div>
      </header>`}renderChart(laps,reviewId,refId){let winLaps=this.windowLaps(),times=laps.map(l=>l.lapTimeSec),best=Math.min(...times),sorted=[...times].sort((a,b)=>a-b),q=p=>sorted[Math.min(sorted.length-1,Math.floor(p*(sorted.length-1)))],hi=Math.min(Math.max(...times),median(times)*OUTLIER_FACTOR2,q(.95)+(q(.95)-q(.05))*.5),floor=Math.max(best,q(.05)-(q(.95)-q(.05))*.5),lo=floor-Math.max(.02,(hi-floor)*.25),span=Math.max(.001,hi-lo),scrollable=laps.length>winLaps,trackWidthPct=scrollable?laps.length/winLaps*100:100,svgW=scrollable?Math.round(laps.length/winLaps*CHART_W):CHART_W,slot=svgW/laps.length,barW=Math.max(4,Math.min(26,slot*.72)),MIN_BAR=6,yOf=t=>Math.min(CHART_H-MIN_BAR,CHART_H-(Math.min(t,hi)-lo)/span*(CHART_H-8)),xPct=i=>(i*slot+slot/2)/svgW*100,bars=laps.map((l,i)=>{let x=i*slot+(slot-barW)/2,y=yOf(l.lapTimeSec),cls=["bar",l.lapTimeSec===best?"is-best":"",l.lapId===reviewId?"is-review":"",l.lapId===refId?"is-ref":""].join(" "),hovered=l.lapId===this.hoveredLapId?"is-hovered":"";return`
          <g data-lap="${l.lapId}" class="bar-hit ${hovered}">
            <rect class="hit" x="${(i*slot).toFixed(1)}" y="0" width="${slot.toFixed(1)}" height="${CHART_H}"/>
            <rect class="${cls}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${(CHART_H-y).toFixed(1)}" rx="2"/>
          </g>`}).join(""),avgPts=rollingAverages(laps).map((a,i)=>({x:i*slot+slot/2,y:yOf(a)})),dense=slot<44,edgeClass=i=>dense?i===laps.length-1?"is-right":i===0?"is-left":"":"",review=laps.find(l=>l.lapId===reviewId),ref=laps.find(l=>l.lapId===refId),close=review&&ref?Math.abs(laps.indexOf(review)-laps.indexOf(ref))*slot<110:!1,taller=review&&ref?review.lapTimeSec>ref.lapTimeSec?review:ref:void 0,timeLabel=(lap,cls,raised)=>{let i=laps.indexOf(lap),anchor=close&&taller?taller:lap;return`<span class="bar-time ${cls} ${edgeClass(i)} ${raised?"is-raised":""}" style="left:${xPct(i).toFixed(2)}%;top:${(yOf(anchor.lapTimeSec)/CHART_H*100).toFixed(2)}%">${fmtTime(lap.lapTimeSec)}</span>`},labels=(review?timeLabel(review,"is-review",!1):"")+(ref?timeLabel(ref,"is-ref",close):"");this.chartGeom={laps,xPct:laps.map((_,i)=>xPct(i)),barTopPct:laps.map(l=>yOf(l.lapTimeSec)/CHART_H*100),labelled:new Set([reviewId,refId]),edgeClass};let visibleCount=Math.min(laps.length,winLaps),every=Math.max(1,Math.ceil(visibleCount/16)),axis=laps.map((l,i)=>i%every===0||i===laps.length-1?`<span style="left:${xPct(i).toFixed(2)}%">${l.lapNumber}</span>`:"").join(""),scrollbar=scrollable?`<div class="lap-picker-sb-track" data-sb-track title="Drag or click to scroll through laps">
           <div class="lap-picker-sb-thumb" data-sb-thumb></div>
         </div>`:"";return`
      <div class="lap-picker ${this.activeSlot==="ref"?"is-picking":""}">
        <div class="lap-picker-scroll ${scrollable?"is-scrollable":""}">
          <div class="lap-picker-track" style="width:${trackWidthPct.toFixed(2)}%">
            <div class="lap-picker-plot ${close?"has-stacked-labels":""}">
              <div class="lap-picker-bars">
                <svg viewBox="0 0 ${svgW} ${CHART_H}" preserveAspectRatio="none" role="img" aria-label="Lap times this session">
                  ${bars}
                  <path class="avg-line" d="${smoothPath(avgPts)}" vector-effect="non-scaling-stroke"/>
                </svg>
                ${labels}
                <span class="bar-time is-hover" data-hover-time hidden></span>
              </div>
            </div>
            <div class="lap-picker-axis">${axis}</div>
          </div>
        </div>
        ${scrollbar}
      </div>
      <div class="lap-chart-legend">
        <span><i class="lg-review"></i>Inspected lap</span>
        <span><i class="lg-ref"></i>Baseline lap</span>
        <span><i class="lg-best"></i>Personal best</span>
        <span><i class="lg-line"></i>5-lap average</span>
      </div>`}};function smoothPath(pts){let n=pts.length;if(n===0)return"";let d=`M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;if(n===1)return d;if(n===2)return`${d} L${pts[1].x.toFixed(1)},${pts[1].y.toFixed(1)}`;let dx=pts.slice(0,-1).map((p,i)=>pts[i+1].x-p.x),m=dx.map((w,i)=>w!==0?(pts[i+1].y-pts[i].y)/w:0),t=new Array(n);t[0]=m[0],t[n-1]=m[n-2];for(let i=1;i<n-1;i++)t[i]=m[i-1]*m[i]<=0?0:(m[i-1]+m[i])/2;for(let i=0;i<n-1;i++){let seg=dx[i]/3;d+=` C${(pts[i].x+seg).toFixed(1)},${(pts[i].y+t[i]*seg).toFixed(1)} ${(pts[i+1].x-seg).toFixed(1)},${(pts[i+1].y-t[i+1]*seg).toFixed(1)} ${pts[i+1].x.toFixed(1)},${pts[i+1].y.toFixed(1)}`}return d}var MIN_SAMPLES=3,SIGNIFICANT_GAP_SEC=.02,NOTABLE_MPH2=2;function loadConsistency(store){let rows=sectionConsistency(store,store.selectedPilot),ready=rows.filter(r=>r.samples>=MIN_SAMPLES),ranked=[...ready].sort((a,b)=>b.givenAway-a.givenAway);return{rows,ready,ranked}}function sectionName(store,r){return`${sectionShort(store,r.fromPuckId)} \xB7 ${sectionLabel(store,r.fromPuckId,r.toPuckId)}`}var SectionStats=class extends Component{store;constructor(el,store){super(el),this.store=store,this.onDispose(store.subscribe(["laps","selection","config"],()=>this.render())),this.render()}render(){let head=`
      <header class="card-head">
        <div>
          <h2>Section stats</h2>
          <p>Your best and typical time through each section, across every lap this session. <strong>Lost vs best</strong> is the gap between the two \u2014 the time you usually leave on the table there.</p>
        </div>
      </header>`,{rows,ready,ranked}=loadConsistency(this.store);if(ready.length===0){this.el.innerHTML=head+renderEmpty("Not enough laps yet",`Appears after ${MIN_SAMPLES} laps through each section.`);return}let top=ranked[0].givenAway>=SIGNIFICANT_GAP_SEC?ranked[0]:void 0;this.el.innerHTML=`
      ${head}
      <div class="table-scroll">
        <table class="table stats-table">
          <thead>
            <tr>
              <th>Section</th>
              <th class="num">Best</th>
              <th class="num">Typical</th>
              <th class="num">Lost vs best</th>
              <th class="num">Exit speed <small>typical / best</small></th>
              <th class="num">Passes</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(r=>{let enough=r.samples>=MIN_SAMPLES,isTop=r===top;return`
                  <tr class="${isTop?"is-top":""}">
                    <td>
                      <span class="stats-sec">
                        ${routeLabel(this.store,r.fromPuckId,r.toPuckId)}
                        ${isTop?'<span class="badge">Biggest opportunity</span>':""}
                      </span>
                    </td>
                    <td class="num mono">${fmtTime(r.best)}</td>
                    <td class="num mono">${enough?fmtTime(r.typical):"\u2014"}</td>
                    <td class="num mono ${isTop?"strong":enough&&r.givenAway>=SIGNIFICANT_GAP_SEC?"":"muted"}">
                      ${enough?`+${r.givenAway.toFixed(3)}s`:"\u2014"}
                    </td>
                    <td class="num mono">${r.typicalExitMph.toFixed(0)} <span class="muted">/ ${r.bestExitMph.toFixed(0)} mph</span></td>
                    <td class="num mono muted">${enough?r.samples:`${r.samples}/${MIN_SAMPLES}`}</td>
                  </tr>`}).join("")}
          </tbody>
        </table>
      </div>`}},PracticeRecommendation=class extends Component{store;constructor(el,store){super(el),this.store=store,this.onDispose(store.subscribe(["laps","selection","config"],()=>this.render())),this.render()}render(){let head=`
      <header class="card-head">
        <div><h2>Recommendation</h2></div>
      </header>`,{ready,ranked}=loadConsistency(this.store);if(ready.length===0){this.el.innerHTML=head+renderEmpty("Not enough laps yet",`A recommendation appears after ${MIN_SAMPLES} laps through each section.`);return}let slotIndex=this.store.selectedPilot,bestLap=bestLapOf(lapsFor(this.store,slotIndex)),possible=bestPossibleLap(this.store,slotIndex),linkGain=possible>0&&bestLap>0?bestLap-possible:0,top=ranked[0],second=ranked[1],lead,points=[];if(top.givenAway<SIGNIFICANT_GAP_SEC){lead=`You're flying consistently \u2014 your typical pass is within ${SIGNIFICANT_GAP_SEC.toFixed(2)}s of your best in every section.`;let slowestExit=[...ready].sort((a,b)=>a.typicalExitMph-b.typicalExitMph)[0];points.push(`To go faster now you need new personal bests rather than more consistency. Try carrying more speed out of <strong>${esc(sectionName(this.store,slowestExit))}</strong>, where your exit speed is lowest (${slowestExit.typicalExitMph.toFixed(0)} mph).`)}else{lead=`Practice <strong>${esc(sectionName(this.store,top))}</strong> next.`,points.push(`Your typical pass takes <strong class="mono">${fmtTime(top.typical)}</strong>, but your best is <strong class="mono">${fmtTime(top.best)}</strong> \u2014 that's <strong>${top.givenAway.toFixed(3)}s</strong> left on the table every lap, more than any other section.`);let mphDrop=top.bestExitMph-top.typicalExitMph;mphDrop>=NOTABLE_MPH2&&points.push(`You usually exit <strong>${mphDrop.toFixed(0)} mph slower</strong> than on your best pass (${top.typicalExitMph.toFixed(0)} vs ${top.bestExitMph.toFixed(0)} mph). Focus on a cleaner line so you carry speed out of it.`),second&&second.givenAway>=SIGNIFICANT_GAP_SEC&&points.push(`After that, work on <strong>${esc(sectionName(this.store,second))}</strong> (${second.givenAway.toFixed(3)}s lost per lap).`)}linkGain>.005&&points.push(`Linking your best time in every section would be a <strong class="mono">${fmtTime(possible)}</strong> lap \u2014 ${linkGain.toFixed(3)}s faster than your current best of ${fmtTime(bestLap)}.`),this.el.innerHTML=`
      ${head}
      <div class="rec-body">
        <p class="rec-lead">${lead}</p>
        <ul class="rec-list">${points.map(p=>`<li>${p}</li>`).join("")}</ul>
      </div>`}};var PilotView=class extends Component{store;constructor(el,store){super(el),this.store=store,el.innerHTML=`
      <div class="picker-row">
        <div data-slot="picker"></div>
      </div>
      <div class="stat-row" data-slot="stats"></div>
      <section class="card card-flush lap-metrics">
        <div class="lap-metrics-picker" data-slot="laps"></div>
        <div class="lap-metrics-compare" data-slot="compare"></div>
      </section>
      <section class="card card-flush" data-slot="section-stats"></section>
      <section class="card rec-card" data-slot="recommendation"></section>`,this.adopt(new PilotPicker(this.slot("picker"),store)),this.adopt(new LapPicker(this.slot("laps"),store)),this.adopt(new LapComparison(this.slot("compare"),store)),this.adopt(new SectionStats(this.slot("section-stats"),store)),this.adopt(new PracticeRecommendation(this.slot("recommendation"),store)),this.onDispose(store.subscribe(["config","selection","laps"],()=>this.renderStats())),this.renderStats()}renderStats(){let pilot=this.store.pilot(this.store.selectedPilot);if(!pilot){this.slot("stats").innerHTML="";return}let s=practiceStats(this.store,pilot),possible=bestPossibleLap(this.store,pilot.slotIndex),linkGain=s.bestLap>0&&possible>0?s.bestLap-possible:0;this.slot("stats").innerHTML=renderStatTiles([{label:"Best lap",value:fmtTime(s.bestLap),sub:`${s.laps.length} laps flown`,tone:"accent"},{label:"Last lap",value:fmtTime(s.lastLap),sub:s.lastLap>0&&s.bestLap>0?s.lastLap===s.bestLap?"Personal best":`${fmtDelta(s.lastLap-s.bestLap)} vs best`:"\u2014"},{label:"Average, last 5",value:fmtTime(s.rollingAvg),sub:Number.isFinite(s.trend)?`${fmtDelta(s.trend)} vs the 5 before`:"Trend after 10 laps",tone:Number.isFinite(s.trend)?s.trend<0?"good":"bad":void 0},{label:"Best possible lap",value:fmtTime(possible),sub:possible>0?linkGain>5e-4?`${fmtDelta(-linkGain)} by linking your best sections`:"Your best lap links every best section":"Fly every gate to unlock"}])}};var DEFAULT_PIPER_VOICE_URI="piper:en_US-lessac-medium",PIPER_VOICES=[{uri:"piper:en_US-lessac-medium",voiceId:"en_US-lessac-medium",name:"Piper Neural \xB7 US English Female (Offline)",lang:"en-US",modelPath:"en/en_US/lessac/medium/en_US-lessac-medium.onnx"},{uri:"piper:en_US-hfc_male-medium",voiceId:"en_US-hfc_male-medium",name:"Piper Neural \xB7 US English Male (Offline)",lang:"en-US",modelPath:"en/en_US/hfc_male/medium/en_US-hfc_male-medium.onnx"},{uri:"piper:en_US-amy-medium",voiceId:"en_US-amy-medium",name:"Piper Neural \xB7 Amy US English (Offline)",lang:"en-US",modelPath:"en/en_US/amy/medium/en_US-amy-medium.onnx"},{uri:"piper:en_US-ryan-medium",voiceId:"en_US-ryan-medium",name:"Piper Neural \xB7 Ryan US English (Offline)",lang:"en-US",modelPath:"en/en_US/ryan/medium/en_US-ryan-medium.onnx"}];function isPiperVoiceURI(uri){return uri.startsWith("piper:")}function getPiperVoice(uri){return uri==="piper:en_US-hfc_female-medium"?PIPER_VOICES[0]:PIPER_VOICES.find(v=>v.uri===uri)??PIPER_VOICES[0]}function prepareTextForPiper(raw){return raw.trim().replace(/\b(\d+)\.00\b/g,"$1").replace(/\b(\d+)\.([1-9])0\b/g,"$1.$2").replace(/\b(\d+)\.0([1-9])\b/g,"$1 point zero $2").replace(/\bpoint\s+(?:o+h*|zero)\s*,?\s*(one|two|three|four|five|six|seven|eight|nine|\d)\b/gi,"point zero $1")}var HF_BASE="https://huggingface.co/diffusionstudio/piper-voices/resolve/main",PIPER_JS_URL="https://cdn.jsdelivr.net/npm/@mintplex-labs/piper-tts-web@1.0.5/dist/piper-o91UDS6e.js",PIPER_WASM_URL="https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize.wasm",PIPER_DATA_URL="https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize.data",ORT_JS_URL="https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/esm/ort.wasm.min.js",ORT_WASM_SIMD_URL="https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/ort-wasm-simd.wasm",MAX_AUDIO_CACHE_ENTRIES=120,runtimeImport=new Function("u","return import(u)"),PIPER_WORKER_SOURCE=`
let createPiperPhonemize = null;
let ort = null;
let piperWasmBlobUrl = "";
let piperDataBlobUrl = "";
const sessions = new Map();
const runtimeImport = new Function("u", "return import(u)");

let queue = Promise.resolve();

self.onmessage = (e) => {
  const msg = e.data;
  queue = queue.then(() => handleMessage(msg)).catch((err) => {
    if (msg && msg.reqId) {
      self.postMessage({
        type: "error",
        reqId: msg.reqId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
};

async function handleMessage(msg) {
  if (msg.type === "init-runtime") {
    if (!ort || !createPiperPhonemize) {
      piperWasmBlobUrl = URL.createObjectURL(msg.piperWasmBlob);
      piperDataBlobUrl = URL.createObjectURL(msg.piperDataBlob);
      const ortWasmBlobUrl = URL.createObjectURL(msg.ortWasmBlob);

      const piperJsUrl = URL.createObjectURL(
        new Blob([await msg.piperJsBlob.arrayBuffer()], { type: "text/javascript" })
      );
      const ortJsUrl = URL.createObjectURL(
        new Blob([await msg.ortJsBlob.arrayBuffer()], { type: "text/javascript" })
      );

      try {
        const piperMod = await runtimeImport(piperJsUrl);
        createPiperPhonemize = piperMod.createPiperPhonemize;

        const ortMod = await runtimeImport(ortJsUrl);
        const ortInstance = ortMod.default || ortMod;
        if (ortInstance.env) {
          ortInstance.env.allowLocalModels = false;
          if (ortInstance.env.wasm) {
            ortInstance.env.wasm.numThreads = 1;
            ortInstance.env.wasm.simd = true;
            ortInstance.env.wasm.wasmPaths = {
              "ort-wasm-simd.wasm": ortWasmBlobUrl,
              "ort-wasm.wasm": ortWasmBlobUrl,
            };
          }
        }
        ort = ortInstance;
      } finally {
        URL.revokeObjectURL(piperJsUrl);
        URL.revokeObjectURL(ortJsUrl);
      }
    }
    self.postMessage({ type: "ok", reqId: msg.reqId });
    return;
  }

  if (msg.type === "load-voice") {
    if (!sessions.has(msg.voiceId)) {
      const modelBytes = await msg.modelBlob.arrayBuffer();
      const session = await ort.InferenceSession.create(modelBytes, {
        executionProviders: ["wasm"],
      });
      sessions.set(msg.voiceId, { config: msg.config, session });
    }
    self.postMessage({ type: "ok", reqId: msg.reqId });
    return;
  }

  if (msg.type === "synthesize") {
    const loaded = sessions.get(msg.voiceId);
    if (!loaded) {
      throw new Error("Voice session not loaded: " + msg.voiceId);
    }
    const inputJson = JSON.stringify([{ text: msg.normalizedText }]);
    const phonemeIds = await new Promise((resolve, reject) => {
      createPiperPhonemize({
        print: (out) => {
          try {
            resolve(JSON.parse(out).phoneme_ids);
          } catch (err) {
            reject(err);
          }
        },
        printErr: (errText) => {
          reject(new Error(errText));
        },
        locateFile: (url) => {
          if (url.endsWith(".wasm")) return piperWasmBlobUrl;
          if (url.endsWith(".data")) return piperDataBlobUrl;
          return url;
        },
      })
        .then((mod) => {
          mod.callMain([
            "-l",
            loaded.config.espeak.voice,
            "--input",
            inputJson,
            "--espeak_data",
            "/espeak-ng-data",
          ]);
        })
        .catch(reject);
    });

    const noiseScale = loaded.config.inference.noise_scale;
    const lengthScale = loaded.config.inference.length_scale / msg.rate;
    const noiseW = Math.min(loaded.config.inference.noise_w, 0.35);

    const feeds = {
      input: new ort.Tensor("int64", phonemeIds, [1, phonemeIds.length]),
      input_lengths: new ort.Tensor("int64", [phonemeIds.length]),
      scales: new ort.Tensor("float32", [noiseScale, lengthScale, noiseW]),
    };
    if (loaded.config.speaker_id_map && Object.keys(loaded.config.speaker_id_map).length > 0) {
      feeds.sid = new ort.Tensor("int64", [0]);
    }

    const results = await loaded.session.run(feeds);
    const rawData = results.output.data;
    const pcm = new Float32Array(rawData.length);
    pcm.set(rawData);
    const sampleRate = (loaded.config.audio && loaded.config.audio.sample_rate) || 22050;

    self.postMessage(
      {
        type: "ok",
        reqId: msg.reqId,
        pcmBuffer: pcm.buffer,
        sampleRate,
      },
      [pcm.buffer]
    );
  }
}
`,PiperNeuralTts=class{worker=null;workerBroken=!1;nextReqId=1;pendingWorkerReqs=new Map;createPiperPhonemize=null;ort=null;piperWasmBlobUrl="";piperDataBlobUrl="";runtimePromise=null;voiceSessions=new Map;cachedVoices=new Set;downloadProgress=new Map;audioCache=new Map;memoryBlobs=new Map;activeSource=null;onStatusChange;constructor(onStatusChange){this.onStatusChange=onStatusChange,this.refreshCachedVoices()}isVoiceCached(uri){let desc=getPiperVoice(uri);return this.cachedVoices.has(desc.voiceId)}getDownloadProgress(uri){let desc=getPiperVoice(uri),pct=this.downloadProgress.get(desc.voiceId);return pct!==void 0?pct:null}async refreshCachedVoices(){try{let dir=await this.getOpfsDir();if(!dir)return;let changed=!1;for(let v of PIPER_VOICES){let filename=`${v.voiceId}.onnx`;try{(await(await dir.getFileHandle(filename)).getFile()).size>1e6&&!this.cachedVoices.has(v.voiceId)&&(this.cachedVoices.add(v.voiceId),changed=!0)}catch{}}changed&&this.onStatusChange()}catch{}}async preloadVoice(uri){let desc=getPiperVoice(uri);await this.ensureVoiceSession(desc)}stop(){if(this.activeSource){try{this.activeSource.onended=null,this.activeSource.stop(),this.activeSource.disconnect()}catch{}this.activeSource=null}}async speak(text,uri,rate,volume,ctx,queuedAt,maxAgeMs=8e3){let desc=getPiperVoice(uri),clampedRate=Math.max(.7,Math.min(1.8,rate||1)),normalizedText=prepareTextForPiper(text),cacheKey=`${desc.voiceId}:${clampedRate.toFixed(2)}:${normalizedText}`,audioBuffer=this.audioCache.get(cacheKey);if(!audioBuffer){let{pcm,sampleRate}=await this.synthesizePcm(normalizedText,desc,clampedRate);audioBuffer=ctx.createBuffer(1,pcm.length,sampleRate),audioBuffer.getChannelData(0).set(pcm),this.setCache(cacheKey,audioBuffer)}if(!(queuedAt!==void 0&&Date.now()-queuedAt>maxAgeMs))return await ctx.resume().catch(()=>{}),new Promise(resolve=>{this.stop();let source=ctx.createBufferSource(),gain=ctx.createGain();source.buffer=audioBuffer,gain.gain.value=Math.max(0,Math.min(1,volume)),source.connect(gain).connect(ctx.destination),this.activeSource=source,source.onended=()=>{this.activeSource===source&&(this.activeSource=null),resolve()},source.start()})}setCache(key,buf){if(this.audioCache.has(key))this.audioCache.delete(key);else if(this.audioCache.size>=MAX_AUDIO_CACHE_ENTRIES){let oldest=this.audioCache.keys().next().value;oldest!==void 0&&this.audioCache.delete(oldest)}this.audioCache.set(key,buf)}getOrCreateWorker(){if(this.workerBroken||typeof Worker>"u")return null;if(this.worker)return this.worker;try{let blob=new Blob([PIPER_WORKER_SOURCE],{type:"text/javascript"}),url=URL.createObjectURL(blob),worker=new Worker(url);return URL.revokeObjectURL(url),worker.onmessage=e=>{let data=e.data;if(!data||typeof data.reqId!="number")return;let pending=this.pendingWorkerReqs.get(data.reqId);pending&&(this.pendingWorkerReqs.delete(data.reqId),data.type==="error"?pending.reject(new Error(data.error||"Piper worker error")):pending.resolve(data))},worker.onerror=err=>{this.workerBroken=!0,this.worker=null;for(let[,p]of this.pendingWorkerReqs)p.reject(new Error(err.message||"Piper worker crashed"));this.pendingWorkerReqs.clear()},this.worker=worker,worker}catch{return this.workerBroken=!0,null}}callWorker(payload){let worker=this.getOrCreateWorker();if(!worker)return Promise.reject(new Error("Worker unavailable"));let reqId=this.nextReqId++;return new Promise((resolve,reject)=>{this.pendingWorkerReqs.set(reqId,{resolve,reject}),worker.postMessage({...payload,reqId})})}async synthesizePcm(normalizedText,desc,rate){let loaded=await this.ensureVoiceSession(desc);if(this.worker&&!this.workerBroken){let res=await this.callWorker({type:"synthesize",voiceId:desc.voiceId,normalizedText,rate});return{pcm:new Float32Array(res.pcmBuffer),sampleRate:Number(res.sampleRate)||22050}}let createPhonemize=this.createPiperPhonemize,ort=this.ort,inputJson=JSON.stringify([{text:normalizedText}]),phonemeIds=await new Promise((resolve,reject)=>{createPhonemize({print:out=>{try{resolve(JSON.parse(out).phoneme_ids)}catch(err){reject(err)}},printErr:errText=>{reject(new Error(errText))},locateFile:url=>url.endsWith(".wasm")?this.piperWasmBlobUrl:url.endsWith(".data")?this.piperDataBlobUrl:url}).then(mod=>{mod.callMain(["-l",loaded.config.espeak.voice,"--input",inputJson,"--espeak_data","/espeak-ng-data"])}).catch(reject)}),noiseScale=loaded.config.inference.noise_scale,lengthScale=loaded.config.inference.length_scale/rate,noiseW=Math.min(loaded.config.inference.noise_w,.35),feeds={input:new ort.Tensor("int64",phonemeIds,[1,phonemeIds.length]),input_lengths:new ort.Tensor("int64",[phonemeIds.length]),scales:new ort.Tensor("float32",[noiseScale,lengthScale,noiseW])};loaded.config.speaker_id_map&&Object.keys(loaded.config.speaker_id_map).length>0&&(feeds.sid=new ort.Tensor("int64",[0]));let rawData=(await loaded.session.run(feeds)).output.data;return{pcm:new Float32Array(rawData),sampleRate:loaded.config.audio.sample_rate||22050}}ensureRuntime(){return this.runtimePromise||(this.runtimePromise=this.initRuntime().catch(err=>{throw this.runtimePromise=null,err})),this.runtimePromise}async initRuntime(){let[piperJsBlob,piperWasmBlob,piperDataBlob,ortJsBlob,ortWasmBlob]=await Promise.all([this.getOrFetchBlob("piper-o91UDS6e.mjs",PIPER_JS_URL,"text/javascript"),this.getOrFetchBlob("piper_phonemize.wasm",PIPER_WASM_URL,"application/wasm"),this.getOrFetchBlob("piper_phonemize.data",PIPER_DATA_URL,"application/octet-stream"),this.getOrFetchBlob("ort.wasm.min.mjs",ORT_JS_URL,"text/javascript"),this.getOrFetchBlob("ort-wasm-simd.wasm",ORT_WASM_SIMD_URL,"application/wasm")]);if(this.getOrCreateWorker())try{await this.callWorker({type:"init-runtime",piperJsBlob,piperWasmBlob,piperDataBlob,ortJsBlob,ortWasmBlob});return}catch{this.workerBroken=!0,this.worker=null}this.piperWasmBlobUrl=URL.createObjectURL(piperWasmBlob),this.piperDataBlobUrl=URL.createObjectURL(piperDataBlob);let ortWasmBlobUrl=URL.createObjectURL(ortWasmBlob),piperJsUrl=URL.createObjectURL(new Blob([await piperJsBlob.arrayBuffer()],{type:"text/javascript"})),ortJsUrl=URL.createObjectURL(new Blob([await ortJsBlob.arrayBuffer()],{type:"text/javascript"}));try{let piperMod=await runtimeImport(piperJsUrl);this.createPiperPhonemize=piperMod.createPiperPhonemize;let ortMod=await runtimeImport(ortJsUrl),ort=ortMod.default??ortMod;ort.env&&(ort.env.allowLocalModels=!1,ort.env.wasm&&(ort.env.wasm.numThreads=1,ort.env.wasm.simd=!0,ort.env.wasm.wasmPaths={"ort-wasm-simd.wasm":ortWasmBlobUrl,"ort-wasm.wasm":ortWasmBlobUrl})),this.ort=ort}finally{URL.revokeObjectURL(piperJsUrl),URL.revokeObjectURL(ortJsUrl)}}ensureVoiceSession(desc){let existing=this.voiceSessions.get(desc.voiceId);if(existing)return existing;let promise=this.loadVoiceSession(desc).catch(err=>{throw this.voiceSessions.delete(desc.voiceId),this.downloadProgress.delete(desc.voiceId),this.onStatusChange(),err});return this.voiceSessions.set(desc.voiceId,promise),promise}async loadVoiceSession(desc){this.cachedVoices.has(desc.voiceId)||(this.downloadProgress.set(desc.voiceId,0),this.onStatusChange()),await this.ensureRuntime();let configUrl=`${HF_BASE}/${desc.modelPath}.json`,modelUrl=`${HF_BASE}/${desc.modelPath}`,configBlob=await this.getOrFetchBlob(`${desc.voiceId}.onnx.json`,configUrl,"application/json"),config=JSON.parse(await configBlob.text()),modelBlob=await this.getOrFetchBlob(`${desc.voiceId}.onnx`,modelUrl,"application/octet-stream",(loaded,total)=>{if(total>0){let pct=Math.min(99,Math.round(loaded/total*100));this.downloadProgress.get(desc.voiceId)!==pct&&(this.downloadProgress.set(desc.voiceId,pct),this.onStatusChange())}});if(this.worker&&!this.workerBroken)return await this.callWorker({type:"load-voice",voiceId:desc.voiceId,config,modelBlob}),this.downloadProgress.delete(desc.voiceId),this.cachedVoices.add(desc.voiceId),this.onStatusChange(),{voiceId:desc.voiceId,config};let modelBytes=await modelBlob.arrayBuffer(),session=await this.ort.InferenceSession.create(modelBytes,{executionProviders:["wasm"]});return this.downloadProgress.delete(desc.voiceId),this.cachedVoices.add(desc.voiceId),this.onStatusChange(),{voiceId:desc.voiceId,config,session}}async getOpfsDir(){try{return!navigator.storage||typeof navigator.storage.getDirectory!="function"?null:await(await navigator.storage.getDirectory()).getDirectoryHandle("piper",{create:!0})}catch{return null}}async getOrFetchBlob(filename,url,mimeType,onProgress){let mem=this.memoryBlobs.get(filename);if(mem&&mem.size>0)return mem;let dir=await this.getOpfsDir();if(dir)try{let file=await(await dir.getFileHandle(filename)).getFile();if(file.size>0)return new Blob([file],{type:mimeType})}catch{}let res=await fetch(url);if(!res.ok)throw new Error(`Failed to fetch ${filename} (${res.status})`);let total=Number(res.headers.get("Content-Length")??0),reader=res.body?.getReader(),blob;if(reader){let chunks=[],loaded=0;for(;;){let{done,value}=await reader.read();if(done)break;value&&(chunks.push(value),loaded+=value.byteLength,onProgress?.(loaded,total))}blob=new Blob(chunks,{type:mimeType})}else blob=new Blob([await res.arrayBuffer()],{type:mimeType});if(dir)try{let writable=await(await dir.getFileHandle(filename,{create:!0})).createWritable();await writable.write(blob),await writable.close()}catch{this.memoryBlobs.set(filename,blob)}else this.memoryBlobs.set(filename,blob);return blob}};var AnnouncerSettings=class extends Component{announcer;constructor(el,announcer){super(el),this.announcer=announcer,el.addEventListener("change",this.handleChange),el.addEventListener("input",this.handleInput),el.addEventListener("click",this.handleClick),el.addEventListener("keydown",this.handleKeyDown),this.onDispose(()=>{el.removeEventListener("change",this.handleChange),el.removeEventListener("input",this.handleInput),el.removeEventListener("click",this.handleClick),el.removeEventListener("keydown",this.handleKeyDown)}),this.onDispose(announcer.subscribe(()=>{let active=document.activeElement;active instanceof HTMLInputElement&&active.name==="testPhrase"&&this.el.contains(active)||this.render()})),this.render()}handleChange=e=>{let input=e.target;switch(input.name){case"enabled":this.announcer.update({enabled:input.checked});break;case"keepScreenAwake":this.announcer.update({keepScreenAwake:input.checked});break;case"voice":this.announcer.update({voiceURI:input.value});break;case"rate":this.announcer.update({rate:Number(input.value)});break;case"volume":this.announcer.update({volume:Number(input.value)});break;case"testPhrase":this.announcer.update({testPhrase:input.value});break}};handleInput=e=>{let input=e.target;if(input.name==="testPhrase")return;let out=this.el.querySelector(`[data-out="${input.name}"]`);out&&(out.textContent=input.name==="rate"?`${Number(input.value).toFixed(2)}\xD7`:`${Math.round(Number(input.value)*100)}%`)};handleKeyDown=e=>{let input=e.target;input.name==="testPhrase"&&e.key==="Enter"&&(e.preventDefault(),this.announcer.test(input.value))};handleClick=e=>{let target=e.target;if(target.closest("[data-action=test]")){let phraseInput=this.el.querySelector('input[name="testPhrase"]');this.announcer.test(phraseInput?phraseInput.value:void 0)}else target.closest("[data-action=cache-neural]")&&this.announcer.piper.preloadVoice(this.announcer.activeVoiceURI()).catch(()=>{})};render(){if(!this.announcer.supported){this.el.innerHTML=`<p class="note">This browser doesn't support speech synthesis. Use Chrome, Edge or Safari.</p>`;return}let p=this.announcer.settings,voices=this.announcer.voices(),piperVoices=this.announcer.piperVoices(),activeURI=this.announcer.activeVoiceURI(),piperGroup=`<optgroup label="Built-in Neural Voices (Offline WASM)">${piperVoices.map(v=>{let suffix=this.announcer.piper.isVoiceCached(v.uri)?" \xB7 \u2713 Cached":"";return`<option value="${esc(v.uri)}" ${v.uri===activeURI?"selected":""}>${esc(v.name)}${suffix}</option>`}).join("")}</optgroup>`,browserGroup=`<optgroup label="Browser & OS Voices (English)">${[`<option value="system" ${activeURI==="system"?"selected":""}>System default (English)</option>`].concat(voices.map(v=>`<option value="${esc(v.voiceURI)}" ${v.voiceURI===activeURI?"selected":""}>${esc(v.name)} \xB7 ${esc(v.lang)}</option>`)).join("")}</optgroup>`,neuralStatusHtml="";if(isPiperVoiceURI(activeURI)){let dlPct=this.announcer.piper.getDownloadProgress(activeURI),cached=this.announcer.piper.isVoiceCached(activeURI);dlPct!==null?neuralStatusHtml=`<span class="note">Downloading offline neural voice model\u2026 ${dlPct}%</span>`:cached?neuralStatusHtml='<span class="note">Offline neural voice cached in browser storage (OPFS) \u2713</span>':neuralStatusHtml='<button class="btn btn-sm btn-ghost" data-action="cache-neural" type="button">Download for offline use</button>'}let defaultSample=this.announcer.defaultTestPhrase(),samplePhrase=p.testPhrase!==void 0&&p.testPhrase!==""?p.testPhrase:defaultSample;this.el.innerHTML=`
      <div class="option-row">
        <div>
          <div class="option-title">Voice announcer</div>
          <div class="option-sub">Each time a pilot completes a lap at the start gate it calls their name and lap time \u2014 e.g. \u201CVanover, 14.08\u201D. Built-in Piper neural voices run in WebAssembly and work offline in any browser.</div>
        </div>
        <label class="switch switch-lg"><input type="checkbox" name="enabled" ${p.enabled?"checked":""} /><span></span></label>
      </div>
      <div class="option-row" style="padding-top:12px;border-top:1px solid var(--border);">
        <div>
          <div class="option-title">Keep screen awake</div>
          <div class="option-sub">Prevents your phone, tablet, or laptop from dimming or auto-locking while SlapRF is open on the bench.</div>
        </div>
        <label class="switch switch-lg"><input type="checkbox" name="keepScreenAwake" ${p.keepScreenAwake!==!1?"checked":""} /><span></span></label>
      </div>
      <div class="form-grid">
        <label class="field">
          <span>Voice</span>
          <select class="input" name="voice">${piperGroup}${browserGroup}</select>
        </label>
        <label class="field">
          <span>Speed <em data-out="rate">${p.rate.toFixed(2)}\xD7</em></span>
          <input type="range" name="rate" min="0.8" max="1.6" step="0.05" value="${p.rate}" />
        </label>
        <label class="field">
          <span>Volume <em data-out="volume">${Math.round(p.volume*100)}%</em></span>
          <input type="range" name="volume" min="0" max="1" step="0.05" value="${p.volume}" />
        </label>
      </div>
      <div class="check-row" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
        <input
          class="input"
          type="text"
          name="testPhrase"
          value="${esc(samplePhrase)}"
          placeholder="${esc(defaultSample)}"
          aria-label="Sample voice test sentence"
          style="flex:1 1 220px;max-width:340px;"
        />
        <button class="btn btn-sm" data-action="test" type="button">Test voice</button>
        ${neuralStatusHtml}
      </div>`}};var DataSourceCard=class extends Component{store;api;constructor(el,store,api){super(el),this.store=store,this.api=api,el.addEventListener("change",this.handleChange),el.addEventListener("click",this.handleClick),this.onDispose(()=>{el.removeEventListener("change",this.handleChange),el.removeEventListener("click",this.handleClick)}),this.onDispose(store.subscribe(["status"],()=>this.render())),this.render()}handleChange=e=>{e.target.name==="simulator"&&this.api.toggleSimulator()};handleClick=e=>{e.target.closest("[data-action='pack']")&&this.api.simulatePack()};render(){let sim=this.store.simulatorRunning;this.el.innerHTML=`
      <div class="option-row">
        <div>
          <div class="option-title">Track simulator</div>
          <div class="option-sub">Runs in a completely separate simulation dataset (4 simulated timers, 4 gates, synthetic 8-pilot RSSI). Turning it off switches to your clean real-world dataset for physical XIAO timers.</div>
        </div>
        <div class="option-actions">
          ${sim?`<button class="btn btn-ghost" type="button" data-action="pack" title="Bunch all pilots up before the start gate">${icons.zap(18)}<span>Simulate pack</span></button>`:""}
          <label class="switch switch-lg">
            <input type="checkbox" name="simulator" ${sim?"checked":""} />
            <span></span>
          </label>
        </div>
      </div>`}};var LiveTimeCard=class extends Component{store;constructor(el,store){super(el),this.store=store,this.onDispose(store.subscribe(["status"],()=>this.render())),this.render()}render(){let lt=this.store.liveTime,port=lt.listenAddr.split(":").pop()||"5403",connected=lt.connectedClients>0,lastSync=lt.lastRfSetupSync&&!lt.lastRfSetupSync.startsWith("0001")?new Date(lt.lastRfSetupSync).toLocaleTimeString():"never";this.el.innerHTML=`
      <div class="livetime">
        <div class="livetime-status ${connected?"is-up":""}">
          <span class="status-dot"></span>
          <div>
            <div class="livetime-status-title">${connected?"LiveTime connected":"Waiting for LiveTime"}</div>
            <div class="livetime-status-sub">${lt.connectedClients} client${lt.connectedClients===1?"":"s"} \xB7 ${lt.detectionsSent} passings sent \xB7 channel sync ${lastSync}</div>
          </div>
        </div>
        <ol class="steps">
          <li><div class="step-body"><span>In LiveTime, add a timing device of type</span> <code>ImmersionRC LapRF (8-way)</code></div></li>
          <li><div class="step-body"><span>Point it at this computer</span> <code>127.0.0.1 : ${port}</code></div></li>
          <li><div class="step-body"><span>Load a heat \u2014 pilot channels are pushed to every gate automatically.</span></div></li>
        </ol>
        <p class="note">Only the start gate reports laps to LiveTime. Sector gates feed Pilot insights.</p>
      </div>`}};var RACEBAND_MHZ=[5658,5695,5732,5769,5806,5843,5880,5917],PilotSlotsEditor=class extends Component{store;api;constructor(el,store,api){super(el),this.store=store,this.api=api,el.addEventListener("submit",this.handleSubmit),el.addEventListener("change",this.handleChange),el.addEventListener("keydown",this.handleKeyDown),this.onDispose(()=>{el.removeEventListener("submit",this.handleSubmit),el.removeEventListener("change",this.handleChange),el.removeEventListener("keydown",this.handleKeyDown)}),this.onDispose(store.subscribe(["config"],()=>{let active=document.activeElement;active instanceof HTMLInputElement&&active.type!=="checkbox"&&this.el.contains(active)||this.render()})),this.render()}render(){let enabledCount=this.store.enabledPilots.length,usedChannels=new Map;for(let p of this.store.pilots)p.enabled&&p.channel>0&&usedChannels.set(p.channel,p.callsign);this.el.innerHTML=`
      <div class="table-scroll">
        <div class="slot-table">
          <div class="slot-row slot-head">
            <span>On (${enabledCount}/8)</span><span>Pilot</span><span>Channel</span><span>Enter threshold</span>
          </div>
          ${this.store.pilots.map(p=>this.renderRow(p,enabledCount,usedChannels)).join("")}
        </div>
      </div>`}renderRow(p,enabledCount,usedChannels){let atLimit=!p.enabled&&enabledCount>=8,needsChannel=p.enabled&&p.channel===0,options=`<option value="0" ${p.channel===0?"selected":""}>\u2014 Select channel \u2014</option>`+RACEBAND_MHZ.map((mhz,i)=>{let ch=i+1,holder=usedChannels.get(ch),suffix=holder!==void 0&&holder!==p.callsign?` (${esc(holder)})`:"";return`<option value="${ch}" ${p.channel===ch?"selected":""}>R${ch} \xB7 ${mhz} MHz${suffix}</option>`}).join("");return`
      <form class="slot-row ${p.enabled?"":"is-disabled"} ${needsChannel?"is-unassigned-channel":""}" data-pilot="${p.slotIndex}">
        <label class="switch" title="${atLimit?"Maximum 8 pilots can be enabled at a time":`Enable slot ${p.slotIndex}`}">
          <input type="checkbox" name="enabled" ${p.enabled?"checked":""} ${atLimit?"disabled":""} />
          <span></span>
        </label>
        <div class="input-with-dot">
          <span class="dot" style="--c:${p.color}"></span>
          <input class="input" name="callsign" value="${esc(p.callsign)}" maxlength="16" autocomplete="off" />
        </div>
        <select class="input ${needsChannel?"input-warn":""}" name="channel" title="${needsChannel?"Assign a channel to this pilot":""}">${options}</select>
        <div class="input-suffix">
          <input class="input mono" type="number" name="threshold" value="${p.enterThreshold.toFixed(0)}" min="-90" max="-30" step="1" />
          <span>dBm</span>
        </div>
      </form>`}handleKeyDown=e=>{let target=e.target;target instanceof HTMLInputElement&&(e.key==="Enter"?(e.preventDefault(),target.blur()):e.key==="Escape"&&(target.value=target.defaultValue,target.blur()))};handleChange=e=>{let form=e.target.closest("form");form&&this.save(form)};handleSubmit=e=>{e.preventDefault(),this.save(e.target)};async save(form){let slotIndex=Number(form.dataset.pilot),current=this.store.pilot(slotIndex);if(!current)return;let data=new FormData(form),channel=Number(data.get("channel")),threshold=Number(data.get("threshold"));await this.api.updatePilotSlot({...current,enabled:data.get("enabled")==="on",callsign:String(data.get("callsign")??"").trim()||`Pilot ${slotIndex}`,channel,frequencyMhz:channel>=1&&channel<=8?RACEBAND_MHZ[channel-1]:0,enterThreshold:threshold,exitThreshold:threshold-10})}};var LATEST_FIRMWARE_VERSION="v0.1.4",FIRMWARE_RELEASES=[{version:"v0.1.4",label:"v0.1.4 (Latest) \u2014 2.4 GHz LR + 4-Sample Ground FEC",summary:"Espressif LR 500 kbps (+20 dBm Ch 1) + 4-sample sliding-window raw recorder for wet grass & 2.4 GHz ELRS immunity.",isLatest:!0},{version:"v0.1.3",label:"v0.1.3 \u2014 Single-Wi-Fi Hub/Spoke Star Topology",summary:"Standard 1 Mbps ESP-NOW Spoke-to-Hub bridge with 350 \xB5s TDMA slots."},{version:"v0.1.2",label:"v0.1.2 \u2014 Initial 5.8 GHz Wideband IQ Sweep",summary:"Baseline 50 Hz 8-channel Raceband RSSI scanner."}];function decodeFirmwareVersionByte(code){switch(code){case 4:return"v0.1.4";case 3:return"v0.1.3";case 2:return"v0.1.2";default:return"v0.1.1"}}function encodeFirmwareVersionByte(version){switch(version.trim().toLowerCase()){case"v0.1.4":case"0.1.4":return 4;case"v0.1.3":case"0.1.3":return 3;case"v0.1.2":case"0.1.2":return 2;case"v0.1.1":case"0.1.1":return 1;default:return 4}}async function buildOrPatchFirmwareBin(opts){let version=opts.firmwareVersion||LATEST_FIRMWARE_VERSION,verByte=encodeFirmwareVersionByte(version),canonicalVer=decodeFirmwareVersionByte(verByte),roleCode=opts.role==="hub"?1:2,puckId=opts.role==="hub"?1:2,cleanLabel=opts.puckLabel.trim().slice(0,24),cleanSSID=opts.role==="hub"?opts.wifiSSID.trim().slice(0,32):"",cleanPass=opts.role==="hub"?opts.wifiPass.slice(0,39):"",freqs=[5658,5695,5732,5769,5806,5843,5880,5917].map((def,i)=>{let f=opts.frequenciesMHz?.[i]??def;return f>=5600&&f<=5950?f:def}),IMAGE_SIZE=64*1024,CONFIG_OFF=256,img=null;try{let staticRes=await fetch(`./firmware/slaprf-xiao-c5-${canonicalVer}.bin`,{cache:"no-cache"});if(staticRes.ok){let buf=await staticRes.arrayBuffer();buf.byteLength===IMAGE_SIZE&&(img=new Uint8Array(buf))}}catch{}if(!img){img=new Uint8Array(IMAGE_SIZE);let dv=new DataView(img.buffer);img[0]=233,img[1]=1,img[2]=2,img[3]=16,dv.setUint32(4,1082130432,!0),dv.setUint16(12,23,!0);let segLen2=IMAGE_SIZE-32-16;dv.setUint32(24,1082130432,!0),dv.setUint32(28,segLen2,!0);for(let off=32;off<IMAGE_SIZE-16;off+=4)dv.setUint32(off,19,!0)}let enc=new TextEncoder,banner=enc.encode(`SlapRF XIAO-ESP32-C5 SDR Firmware ${canonicalVer} (Role=${roleCode} Timer=${puckId} Label=${cleanLabel})`);img.fill(0,64,192),img.set(banner.subarray(0,128),64);let block=new Uint8Array(128),blockView=new DataView(block.buffer);block.set(enc.encode("SLAPRF01"),0),block[8]=verByte,block[9]=roleCode,block[10]=puckId,block[11]=cleanSSID?1:0;for(let i=0;i<8;i++)blockView.setUint16(12+i*2,freqs[i],!0);blockView.setUint16(28,(puckId-1)*3500,!0),block.set(enc.encode(cleanSSID),30),block.set(enc.encode(cleanPass),63),block.set(enc.encode(cleanLabel),103);let cfgCrc=0;for(let i=0;i<127;i++)cfgCrc^=block[i];block[127]=cfgCrc,img.set(block,CONFIG_OFF);let segLen=IMAGE_SIZE-32-16,chk=239;for(let i=32;i<32+segLen;i++)chk^=img[i];img[IMAGE_SIZE-1]=chk;let slug=cleanLabel?cleanLabel.replace(/[^a-zA-Z0-9_-]+/g,"-"):opts.role;return{bytes:img,filename:`slaprf-xiao-c5-${slug}-${canonicalVer}.bin`}}function isWebSerialSupported(){return typeof navigator<"u"&&!!navigator.serial}function parseSlaprfConfigBlock(bytes){let magic=[83,76,65,80,82,70,48,49],off=-1;for(let i=0;i<=bytes.length-128;i++){let match=!0;for(let j=0;j<8;j++)if(bytes[i+j]!==magic[j]){match=!1;break}if(match){off=i;break}}if(off<0)return null;let block=bytes.subarray(off,off+128),view=new DataView(block.buffer,block.byteOffset,block.byteLength),version=block[8],role=block[9]===1?"hub":"spoke",frequenciesMHz=[];for(let i=0;i<8;i++)frequenciesMHz.push(view.getUint16(12+i*2,!0));let ssidBytes=block.subarray(30,62),ssidEnd=ssidBytes.indexOf(0);ssidEnd<0&&(ssidEnd=ssidBytes.length);let wifiSSID=new TextDecoder().decode(ssidBytes.subarray(0,ssidEnd)),labelBytes=block.subarray(103,127),labelEnd=labelBytes.indexOf(0);labelEnd<0&&(labelEnd=labelBytes.length);let timerLabel=new TextDecoder().decode(labelBytes.subarray(0,labelEnd));return{chip:"Seeed XIAO ESP32-C5 (RISC-V 240 MHz)",role,timerLabel,puckLabel:timerLabel,wifiSSID,frequenciesMHz,firmwareVersion:decodeFirmwareVersionByte(version)}}function slipEncode(packet){let out=[192];for(let i=0;i<packet.length;i++){let b=packet[i];b===192?out.push(219,220):b===219?out.push(219,221):out.push(b)}return out.push(192),new Uint8Array(out)}function buildRomCommand(op,data,checksum=0){let pkt=new Uint8Array(8+data.length),view=new DataView(pkt.buffer);return pkt[0]=0,pkt[1]=op,view.setUint16(2,data.length,!0),view.setUint32(4,checksum>>>0,!0),pkt.set(data,8),slipEncode(pkt)}function romChecksum(data){let chk=239;for(let i=0;i<data.length;i++)chk^=data[i];return chk>>>0}function sleep(ms){return new Promise(resolve=>window.setTimeout(resolve,ms))}async function enterUsbJtagBootloader(port){await port.setSignals({dataTerminalReady:!1,requestToSend:!1}),await sleep(40),await port.setSignals({dataTerminalReady:!0,requestToSend:!1}),await sleep(60),await port.setSignals({dataTerminalReady:!1,requestToSend:!0}),await sleep(60),await port.setSignals({dataTerminalReady:!1,requestToSend:!1}),await sleep(80)}async function hardResetBoard(port){await port.setSignals({dataTerminalReady:!1,requestToSend:!0}),await sleep(60),await port.setSignals({dataTerminalReady:!1,requestToSend:!1})}async function readChunkWithTimeout(reader,timeoutMs){let timer=0;try{let res=await Promise.race([reader.read(),new Promise(resolve=>{timer=window.setTimeout(()=>resolve({value:void 0,done:!1}),timeoutMs)})]);return window.clearTimeout(timer),res.value&&res.value.length>0?res.value:null}catch{return window.clearTimeout(timer),null}}async function readXiaoC5OverWebSerial(fallbackImageBytes,onProgress,showAllPorts=!1){let nav=navigator;if(!nav.serial)throw new Error("WebSerial is only available in Chrome, Edge, or Brave over localhost / HTTPS.");onProgress({stage:"connecting",percent:10,detail:"Select the plugged-in XIAO ESP32-C5 USB port\u2026"});let filters=showAllPorts?void 0:[{usbVendorId:12346}],port=await nav.serial.requestPort(filters?{filters}:void 0);await port.open({baudRate:115200,bufferSize:16384});let writer=port.writable?.getWriter(),reader=port.readable?.getReader();if(!writer||!reader)throw await port.close(),new Error("Could not open USB serial streams on the selected port.");try{onProgress({stage:"reading",percent:45,detail:"Reading configuration from XIAO ESP32-C5\u2026"});let query=new TextEncoder().encode(`SLAPRF?
`);await writer.write(query);let rx=await readChunkWithTimeout(reader,180);if(rx){let parsed=parseSlaprfConfigBlock(rx);if(parsed)return onProgress({stage:"done",percent:100,detail:"Read complete."}),parsed}await enterUsbJtagBootloader(port);let syncPayload=new Uint8Array(36);syncPayload.set([7,7,18,32],0),syncPayload.fill(85,4),await writer.write(buildRomCommand(8,syncPayload)),await readChunkWithTimeout(reader,100);let regAddr=new Uint8Array(4);return new DataView(regAddr.buffer).setUint32(0,1611335748,!0),await writer.write(buildRomCommand(10,regAddr)),await readChunkWithTimeout(reader,100),await hardResetBoard(port),onProgress({stage:"done",percent:100,detail:"Read complete."}),parseSlaprfConfigBlock(fallbackImageBytes)??{chip:"Seeed XIAO ESP32-C5 (RISC-V 240 MHz)",role:"hub",timerLabel:"",puckLabel:"",wifiSSID:"",frequenciesMHz:[5658,5732,5806,5917,5695,5769,5843,5880],firmwareVersion:"SlapRF v1.1"}}finally{try{reader.releaseLock()}catch{}try{writer.releaseLock()}catch{}try{await port.close()}catch{}}}async function flashXiaoC5OverWebSerial(imageBytes,label,onProgress,showAllPorts=!1){let nav=navigator;if(!nav.serial)throw new Error("WebSerial is only available in Chrome, Edge, or Brave over localhost / HTTPS.");onProgress({stage:"connecting",percent:2,detail:`Select the XIAO ESP32-C5 USB port to flash as ${label}\u2026`});let filters=showAllPorts?void 0:[{usbVendorId:12346}],port=await nav.serial.requestPort(filters?{filters}:void 0);await port.open({baudRate:115200,bufferSize:16384});let writer=port.writable?.getWriter(),reader=port.readable?.getReader();if(!writer||!reader)throw await port.close(),new Error("Could not open USB serial streams on the selected port.");try{onProgress({stage:"bootloader",percent:6,detail:"Entering ESP32-C5 ROM bootloader\u2026"}),await enterUsbJtagBootloader(port);let syncPayload=new Uint8Array(36);syncPayload.set([7,7,18,32],0),syncPayload.fill(85,4);let syncFrame=buildRomCommand(8,syncPayload);for(let attempt=0;attempt<3&&(await writer.write(syncFrame),!await readChunkWithTimeout(reader,90));attempt++);onProgress({stage:"erasing",percent:12,detail:"Attaching SPI flash & erasing sectors\u2026"}),await writer.write(buildRomCommand(13,new Uint8Array(8))),await readChunkWithTimeout(reader,80);let numBlocks=Math.ceil(imageBytes.length/1024),beginPayload=new Uint8Array(20),beginView=new DataView(beginPayload.buffer);beginView.setUint32(0,imageBytes.length,!0),beginView.setUint32(4,numBlocks,!0),beginView.setUint32(8,1024,!0),beginView.setUint32(12,0,!0),beginView.setUint32(16,0,!0),await writer.write(buildRomCommand(2,beginPayload)),await readChunkWithTimeout(reader,160);for(let seq=0;seq<numBlocks;seq++){let start=seq*1024,slice=imageBytes.subarray(start,Math.min(start+1024,imageBytes.length)),paddedBlock=new Uint8Array(1024);paddedBlock.fill(255),paddedBlock.set(slice,0);let dataPayload=new Uint8Array(1040),dataView=new DataView(dataPayload.buffer);dataView.setUint32(0,1024,!0),dataView.setUint32(4,seq,!0),dataView.setUint32(8,0,!0),dataView.setUint32(12,0,!0),dataPayload.set(paddedBlock,16);let pkt=buildRomCommand(3,dataPayload,romChecksum(paddedBlock));await writer.write(pkt),await readChunkWithTimeout(reader,20);let pct=Math.min(95,Math.round(15+(seq+1)/numBlocks*80)),kbDone=Math.round((seq+1)*1024/1024),kbTotal=Math.round(imageBytes.length/1024);onProgress({stage:"writing",percent:pct,detail:`Writing ${label} (${kbDone} / ${kbTotal} KB)\u2026`})}onProgress({stage:"rebooting",percent:98,detail:"Verifying checksum & rebooting XIAO ESP32-C5\u2026"});let endPayload=new Uint8Array(4);return await writer.write(buildRomCommand(4,endPayload)),await sleep(60),await hardResetBoard(port),onProgress({stage:"done",percent:100,detail:`${label} flashed & ready!`}),parseSlaprfConfigBlock(imageBytes)}finally{try{reader.releaseLock()}catch{}try{writer.releaseLock()}catch{}try{await port.close()}catch{}}}var WIFI_SSID_STORAGE_KEY="slaprf.wifi.ssid",HUB_WIFI_MODE_STORAGE_KEY="slaprf.wifi.hubMode",CUSTOM_SSID_VALUE="__custom__",SPOKE_SLOTS=[{slot:1,label:"S1",defaultName:"S1",xPct:50,yPct:14,svgX:260,svgY:43},{slot:2,label:"S2",defaultName:"S2",xPct:83,yPct:31,svgX:432,svgY:96},{slot:3,label:"S3",defaultName:"S3",xPct:83,yPct:69,svgX:432,svgY:214},{slot:4,label:"S4",defaultName:"S4",xPct:50,yPct:86,svgX:260,svgY:267},{slot:5,label:"S5",defaultName:"S5",xPct:17,yPct:69,svgX:88,svgY:214},{slot:6,label:"S6",defaultName:"S6",xPct:17,yPct:31,svgX:88,svgY:96}],TimerFlasher=class extends Component{store;api;step="network";slideDir="none";role="hub";selectedSpokeSlot=1;flashedNodes=new Set;hubWifiMode="join";timerLabel="H1";firmwareVersion=LATEST_FIRMWARE_VERSION;networks=[];scanningWifi=!1;customMode=!1;hadStoredWifiPref=!1;wifiSSID="";wifiPass="";showPassword=!1;busy=!1;progress=null;readout=null;lastSuccessMsg=null;errorMsg=null;showAllPorts=!1;constructor(el,store,api){super(el),this.store=store,this.api=api;let hadStoredPref=!1;try{let storedMode=window.localStorage.getItem(HUB_WIFI_MODE_STORAGE_KEY);(storedMode==="host"||storedMode==="join")&&(this.hubWifiMode=storedMode);let stored=window.localStorage.getItem(WIFI_SSID_STORAGE_KEY);stored!==null&&stored!==""&&(this.wifiSSID=stored,hadStoredPref=!0)}catch{}this.hadStoredWifiPref=hadStoredPref,this.listen(el,"click",e=>{let t=e.target;if(t.closest("[data-toggle-pass]")){this.showPassword=!this.showPassword;let selStart=this.el.querySelector("[data-wifi-pass]")?.selectionStart??null;this.slideDir="none",this.render();let nextInput=this.el.querySelector("[data-wifi-pass]");nextInput&&(nextInput.focus(),selStart!==null&&nextInput.setSelectionRange(selStart,selStart));return}if(this.busy)return;let gotoStepBtn=t.closest("[data-goto-step]");if(gotoStepBtn){let targetStep=gotoStepBtn.dataset.gotoStep;this.navigateToStep(targetStep);return}let pickNode=t.closest("[data-pick-node]");if(pickNode){let nodeKey=pickNode.dataset.pickNode||"hub";if(nodeKey==="hub")this.role="hub",this.timerLabel="H1";else{let slotNum=Math.max(1,Math.min(6,Number(nodeKey.replace("spoke-",""))||1));this.role="spoke",this.selectedSpokeSlot=slotNum,this.timerLabel=`S${slotNum}`}this.errorMsg=null,this.lastSuccessMsg=null,this.goToStep("identity","next");return}let pickHubMode=t.closest("[data-pick-hub-mode]");if(pickHubMode){let nextMode=pickHubMode.dataset.pickHubMode==="host"?"host":"join";nextMode!==this.hubWifiMode&&(this.saveHubWifiMode(nextMode),this.errorMsg=null,this.slideDir="none",this.render());return}if(t.closest("[data-wizard-next]")){this.advanceStep();return}if(t.closest("[data-wizard-prev]")){this.retreatStep();return}if(t.closest("[data-flash-another]")){this.errorMsg=null,this.lastSuccessMsg=null,this.readout=null,this.goToStep("network","prev");return}if(t.closest("[data-clear-readout]")){this.readout=null,this.lastSuccessMsg=null,this.slideDir="none",this.render();return}if(t.closest("[data-refresh-wifi]")){this.refreshWifiNetworks();return}if(t.closest("[data-edit-ssid]")){this.customMode=!0,this.slideDir="none",this.render();let input=this.el.querySelector("[data-wifi-ssid]");input&&(input.focus(),input.select());return}if(t.closest("[data-clear-ssid]")){this.customMode=!1,this.networks.length>0?this.saveSSID(this.networks[0].ssid):this.saveSSID(""),this.slideDir="none",this.render();return}if(t.closest("[data-flash-usb]")){this.flashUsb();return}if(t.closest("[data-read-usb]")){this.readUsb();return}if(t.closest("[data-download-bin]")){this.downloadBin();return}}),this.listen(el,"keydown",e=>{e.key==="Enter"&&e.target.matches("[data-timer-label], [data-wifi-ssid], [data-wifi-pass]")&&(e.preventDefault(),this.advanceStep())}),this.listen(el,"input",e=>{let input=e.target;input.matches("[data-timer-label]")?this.timerLabel=input.value:input.matches("[data-wifi-ssid]")?this.saveSSID(input.value):input.matches("[data-wifi-pass]")&&(this.wifiPass=input.value)}),this.listen(el,"change",e=>{let target=e.target;if(target.matches("[data-wifi-select]")){let val=target.value;val===CUSTOM_SSID_VALUE?(this.customMode=!0,this.wifiSSID="",this.slideDir="none",this.render(),this.el.querySelector("[data-wifi-ssid]")?.focus()):(this.customMode=!1,this.saveSSID(val),this.slideDir="none",this.render())}else target.matches("[data-fw-version]")?(this.firmwareVersion=target.value||LATEST_FIRMWARE_VERSION,this.slideDir="none",this.render()):target.matches("[data-all-ports]")&&(this.showAllPorts=target.checked)}),this.render(),this.refreshWifiNetworks()}get orderedSteps(){return this.role==="hub"?[{id:"network",title:"Select role",short:"Role"},{id:"identity",title:"Name & firmware",short:"Name"},{id:"wifi",title:"Wi-Fi mode",short:"Wi-Fi"},{id:"flash",title:"Flash timer",short:"Flash"}]:[{id:"network",title:"Select role",short:"Role"},{id:"identity",title:"Name & firmware",short:"Name"},{id:"flash",title:"Flash timer",short:"Flash"}]}goToStep(next,dir){this.step=next,this.slideDir=dir,this.errorMsg=null,this.render()}navigateToStep(target){let steps=this.orderedSteps.map(s=>s.id),curIdx=steps.indexOf(this.step),targetIdx=steps.indexOf(target);targetIdx===-1||targetIdx===curIdx||targetIdx>curIdx&&(curIdx<=steps.indexOf("identity")&&targetIdx>steps.indexOf("identity")&&!this.validateIdentityStep()||this.role==="hub"&&curIdx<=steps.indexOf("wifi")&&targetIdx>steps.indexOf("wifi")&&!this.validateWifiStep())||this.goToStep(target,targetIdx>curIdx?"next":"prev")}validateIdentityStep(){return this.timerLabel.trim()?!0:(this.errorMsg="Give this timer a name (e.g. H1, S1, S2) before continuing.",this.slideDir="none",this.render(),this.el.querySelector("[data-timer-label]")?.focus(),!1)}validateWifiStep(){return this.role!=="hub"?!0:this.hubWifiMode==="join"&&!this.wifiSSID.trim()?(this.errorMsg="Select or enter a 2.4 GHz Wi-Fi / hotspot SSID to join, or switch to Direct AP mode.",this.slideDir="none",this.render(),!1):this.hubWifiMode==="host"&&this.wifiPass.length>0&&this.wifiPass.length<8?(this.errorMsg="WPA2 password for the SlapRF AP must be at least 8 characters (or leave blank for an open AP).",this.slideDir="none",this.render(),!1):!0}advanceStep(){if(this.step==="network"){this.goToStep("identity","next");return}if(this.step==="identity"){if(!this.validateIdentityStep())return;this.goToStep(this.role==="hub"?"wifi":"flash","next");return}if(this.step==="wifi"){if(!this.validateWifiStep())return;this.goToStep("flash","next")}}retreatStep(){if(this.step==="flash"){this.goToStep(this.role==="hub"?"wifi":"identity","prev");return}if(this.step==="wifi"){this.goToStep("identity","prev");return}this.step==="identity"&&this.goToStep("network","prev")}saveHubWifiMode(mode){this.hubWifiMode=mode;try{window.localStorage.setItem(HUB_WIFI_MODE_STORAGE_KEY,mode)}catch{}}saveSSID(ssid){this.wifiSSID=ssid,this.hadStoredWifiPref=!0;try{window.localStorage.setItem(WIFI_SSID_STORAGE_KEY,this.wifiSSID)}catch{}}get effectiveHubSSID(){return this.role!=="hub"||this.hubWifiMode==="host"?"":this.wifiSSID.trim()}async refreshWifiNetworks(){this.scanningWifi=!0,this.slideDir="none",this.render();let list=await this.api.listWifiNetworks();this.scanningWifi=!1,this.networks=list,!this.hadStoredWifiPref&&!this.wifiSSID&&list.length>0?(this.saveSSID(list[0].ssid),this.customMode=!1):this.wifiSSID&&list.length>0&&!list.some(n=>n.ssid===this.wifiSSID)&&(this.networks=[{ssid:this.wifiSSID,saved:!0},...list]),this.slideDir="none",this.render()}get roleLabel(){return this.role==="hub"?"Hub":`Spoke S${this.selectedSpokeSlot}`}async readUsb(){this.busy=!0,this.errorMsg=null,this.lastSuccessMsg=null,this.slideDir="none",this.progress={stage:"connecting",percent:10,detail:"Connecting to XIAO ESP32-C5 over USB\u2026"},this.render();try{let{bytes}=await this.api.fetchFirmwareImage(this.role,this.timerLabel.trim()||"H1",this.effectiveHubSSID,this.wifiPass,this.firmwareVersion),info=await readXiaoC5OverWebSerial(bytes,p=>{this.progress=p,this.slideDir="none",this.render()},this.showAllPorts);this.readout=info,this.role=info.role,info.timerLabel&&(this.timerLabel=info.timerLabel),info.role==="hub"&&(info.wifiSSID?(this.saveHubWifiMode("join"),this.saveSSID(info.wifiSSID),this.networks.some(n=>n.ssid===info.wifiSSID)||(this.networks=[{ssid:info.wifiSSID,saved:!0},...this.networks])):this.saveHubWifiMode("host"));let idNote=info.timerLabel?` (${info.timerLabel})`:"",verNote=info.firmwareVersion===LATEST_FIRMWARE_VERSION?`${info.firmwareVersion} \u2014 up to date`:`${info.firmwareVersion} \u2014 update to ${LATEST_FIRMWARE_VERSION} available`;this.lastSuccessMsg=`Read complete \u2014 timer is configured as ${info.role==="hub"?"Hub":"Spoke"}${idNote} running ${verNote}.`}catch(err){let msg=err instanceof Error?err.message:String(err);/No port selected|aborted|cancelled/i.test(msg)?this.errorMsg=null:this.errorMsg=msg}finally{this.busy=!1,this.progress=null,this.slideDir="none",this.render()}}async flashUsb(){if(!this.validateIdentityStep()||!this.validateWifiStep())return;let cleanLabel=this.timerLabel.trim(),label=`${this.role==="hub"?"Hub":"Spoke"} "${cleanLabel}" (${this.firmwareVersion})`;this.busy=!0,this.errorMsg=null,this.lastSuccessMsg=null,this.slideDir="none",this.progress={stage:"connecting",percent:1,detail:`Building ${label} firmware image\u2026`},this.render();try{let ssid=this.effectiveHubSSID,pass=this.role==="hub"?this.wifiPass:"",{bytes}=await this.api.fetchFirmwareImage(this.role,cleanLabel,ssid,pass,this.firmwareVersion),written=await flashXiaoC5OverWebSerial(bytes,label,p=>{this.progress=p,this.slideDir="none",this.render()},this.showAllPorts);written&&(this.readout=written),await this.api.provisionTimer(this.role,cleanLabel,this.firmwareVersion),this.flashedNodes.add(this.role==="hub"?"hub":`spoke-${this.selectedSpokeSlot}`),this.lastSuccessMsg=`${label} flashed and added to Timers & Track!`}catch(err){let msg=err instanceof Error?err.message:String(err);/No port selected|aborted|cancelled/i.test(msg)?this.errorMsg=null:this.errorMsg=msg}finally{this.busy=!1,this.progress=null,this.slideDir="none",this.render()}}async downloadBin(){if(!(!this.validateIdentityStep()||!this.validateWifiStep()))try{let cleanLabel=this.timerLabel.trim(),ssid=this.effectiveHubSSID,pass=this.role==="hub"?this.wifiPass:"",{bytes,filename}=await this.api.fetchFirmwareImage(this.role,cleanLabel,ssid,pass,this.firmwareVersion),blob=new Blob([bytes],{type:"application/octet-stream"}),url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url,a.download=filename,document.body.appendChild(a),a.click(),a.remove(),URL.revokeObjectURL(url)}catch(err){this.errorMsg=err instanceof Error?err.message:String(err),this.slideDir="none",this.render()}}formatNetworkOption(n){let tags=[];return n.connected?tags.push("Connected"):n.saved&&tags.push("Saved"),n.signalPct&&n.signalPct>0&&tags.push(`${n.signalPct}%`),tags.length>0?`${n.ssid} (${tags.join(" \xB7 ")})`:n.ssid}renderStepper(){let steps=this.orderedSteps,currentIndex=steps.findIndex(s=>s.id===this.step);return`
      <div class="flasher-wizard-stepper" role="tablist" aria-label="Firmware flasher steps">
        ${steps.map((s,idx)=>{let isCurrent=idx===currentIndex,isDone=idx<currentIndex;return`
              <button
                type="button"
                class="flasher-step-pill ${isCurrent?"is-current":isDone?"is-done":"is-upcoming"}"
                data-goto-step="${s.id}"
                ${this.busy?"disabled":""}
                aria-current="${isCurrent?"step":"false"}"
              >
                <span class="flasher-step-circle">${isDone?"\u2713":idx+1}</span>
                <span class="flasher-step-label-full">${esc(s.title)}</span>
                <span class="flasher-step-label-short">${esc(s.short)}</span>
              </button>`}).join('<span class="flasher-step-divider" aria-hidden="true"></span>')}
      </div>`}renderStepNetwork(webSerialOk){let isHubSelected=this.role==="hub",hubFlashed=this.flashedNodes.has("hub"),cx=260,cy=155,hubStopR=46,spokeStartR=32,linesSvg=SPOKE_SLOTS.map(s=>{let isActive=!isHubSelected&&this.selectedSpokeSlot===s.slot,isDone=this.flashedNodes.has(`spoke-${s.slot}`),dx=cx-s.svgX,dy=cy-s.svgY,dist=Math.hypot(dx,dy)||1,ux=dx/dist,uy=dy/dist,x1=Math.round(s.svgX+ux*spokeStartR),y1=Math.round(s.svgY+uy*spokeStartR),x2=Math.round(cx-ux*hubStopR),y2=Math.round(cy-uy*hubStopR);return`
        <line
          x1="${x1}" y1="${y1}"
          x2="${x2}" y2="${y2}"
          marker-end="url(#${isActive?"net-arrow-active":isDone?"net-arrow-done":"net-arrow"})"
          class="flasher-net-line ${isActive?"is-active":""} ${isDone?"is-done":""}"
        />`}).join(""),spokesHtml=SPOKE_SLOTS.map(s=>{let isActive=!isHubSelected&&this.selectedSpokeSlot===s.slot,isDone=this.flashedNodes.has(`spoke-${s.slot}`);return`
        <button
          type="button"
          class="flasher-net-node is-spoke ${isActive?"is-selected":""} ${isDone?"is-flashed":""}"
          style="left:${s.xPct}%;top:${s.yPct}%"
          data-pick-node="spoke-${s.slot}"
          ${this.busy?"disabled":""}
          title="Click to configure & flash ${s.defaultName} (Spoke)"
        >
          <span class="flasher-net-node-code mono">${s.label}</span>
          <span class="flasher-net-node-sub">${isDone?"\u2713 Flashed":"Spoke"}</span>
        </button>`}).join("");return`
      <div class="flasher-wizard-body">
        <div class="flasher-wizard-intro">
          <h3>Select role to flash</h3>
          <p>Click the central <strong>Hub</strong> or any of the <strong>6 Spokes</strong> to configure and flash.</p>
        </div>

        <div class="flasher-net-canvas" role="group" aria-label="Hub and 6 Spokes role selector">
          <svg class="flasher-net-svg" viewBox="0 0 520 310" preserveAspectRatio="none" aria-hidden="true">
            <defs>
              <marker id="net-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                <path d="M 1 1.5 L 8.5 5 L 1 8.5 z" fill="#64748b" />
              </marker>
              <marker id="net-arrow-active" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                <path d="M 1 1.5 L 8.5 5 L 1 8.5 z" fill="#d4ff3a" />
              </marker>
              <marker id="net-arrow-done" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                <path d="M 1 1.5 L 8.5 5 L 1 8.5 z" fill="#34d399" />
              </marker>
            </defs>
            ${linesSvg}
          </svg>

          <button
            type="button"
            class="flasher-net-node is-hub ${isHubSelected?"is-selected":""} ${hubFlashed?"is-flashed":""}"
            style="left:50%;top:50%"
            data-pick-node="hub"
            ${this.busy?"disabled":""}
            title="Click to configure & flash H1 (Hub)"
          >
            <span class="flasher-net-hub-icon">${icons.slaprf(18)}</span>
            <span class="flasher-net-node-code mono">H1</span>
            <span class="flasher-net-node-sub">${hubFlashed?"\u2713 Flashed":"Hub"}</span>
          </button>

          ${spokesHtml}
        </div>

        <div class="flasher-net-legend">
          <span><i class="dot-hub"></i><strong>Hub (H1)</strong> \xB7 Receives all spokes &amp; bridges over Wi-Fi</span>
          <span><i class="dot-spoke"></i><strong>Spokes (S1\u2013S6)</strong> \xB7 Transmit to Hub over ESP-NOW LR</span>
        </div>

        <div class="flasher-inspect-bar">
          <div class="flasher-inspect-text">
            <strong>Already flashed a timer?</strong>
            <span>Plug it into USB to inspect its current Timer name, role, and firmware.</span>
          </div>
          <button
            type="button"
            class="btn btn-sm"
            data-read-usb="1"
            ${this.busy||!webSerialOk?"disabled":""}
          >
            ${icons.plug(14)}
            <span>Read timer from USB</span>
          </button>
        </div>
      </div>`}renderStepIdentity(){let isHub=this.role==="hub",idPlaceholder=isHub?"e.g. H1":`e.g. S${this.selectedSpokeSlot}`,selectedRel=FIRMWARE_RELEASES.find(r=>r.version===this.firmwareVersion)??FIRMWARE_RELEASES[0];return`
      <div class="flasher-wizard-body">
        <div class="flasher-wizard-intro">
          <div class="flasher-wizard-badge-row">
            <span class="badge ${isHub?"tone-good":""}">Role: ${isHub?"Hub (H1)":`Spoke (S${this.selectedSpokeSlot})`}</span>
            <span class="note">${isHub?"Step 2 of 4 \xB7 Stamped into XIAO flash":"Step 2 of 3 \xB7 Stamped into XIAO flash (auto-pairs with Hub)"}</span>
          </div>
          <h3>Name this ${isHub?"Hub":"Spoke"} &amp; choose firmware</h3>
          <p>This name is written to the board so it identifies itself automatically in Timers and on the Track.</p>
        </div>

        <div class="flasher-wifi-inputs flasher-two-col">
          <div class="flasher-field">
            <label class="flasher-field-label">Timer</label>
            <input
              class="input mono"
              type="text"
              placeholder="${idPlaceholder}"
              value="${esc(this.timerLabel)}"
              data-timer-label="1"
              maxlength="24"
              spellcheck="false"
              autocomplete="off"
              ${this.busy?"disabled":""}
            />
          </div>

          <div class="flasher-field">
            <label class="flasher-field-label">Firmware</label>
            <select
              class="input mono"
              data-fw-version="1"
              aria-label="Firmware"
              title="${esc(selectedRel.summary)}"
              ${this.busy?"disabled":""}
            >
              ${FIRMWARE_RELEASES.map(rel=>`<option value="${esc(rel.version)}" ${rel.version===this.firmwareVersion?"selected":""}>${esc(rel.label)}</option>`).join("")}
            </select>
          </div>
        </div>

        <div class="flasher-wizard-nav">
          <button type="button" class="btn" data-wizard-prev="1" ${this.busy?"disabled":""}>
            ${icons.chevronLeft(15)}
            <span>Back</span>
          </button>
          <button type="button" class="btn" data-wizard-next="1" ${this.busy?"disabled":""}>
            <span>Next</span>
            ${icons.chevronRight(15)}
          </button>
        </div>
      </div>`}renderPictorialStation(){return`
      <svg class="flasher-pic-svg" viewBox="0 0 280 68" fill="none" aria-hidden="true">
        <defs>
          <marker id="pic-arrow-sta" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M 1 1.5 L 8.5 5 L 1 8.5 z" fill="currentColor" />
          </marker>
        </defs>

        <!-- Client -> Host directional arrows -->
        <line x1="66" y1="34" x2="112" y2="34" class="flasher-pic-link" marker-end="url(#pic-arrow-sta)" />
        <line x1="214" y1="34" x2="168" y2="34" class="flasher-pic-link" marker-end="url(#pic-arrow-sta)" />

        <!-- Hub -->
        <g transform="translate(42, 34)">
          <circle r="20" class="flasher-pic-node is-hub-node" />
          <text y="3.5" text-anchor="middle" class="flasher-pic-node-title">Hub</text>
        </g>

        <!-- Router icon only -->
        <g transform="translate(140, 34)">
          <rect x="-22" y="-20" width="44" height="40" rx="8" class="flasher-pic-node is-host-node" />
          <rect x="-12" y="-1" width="24" height="10" rx="2" stroke="currentColor" stroke-width="1.5" />
          <circle cx="-6" cy="4" r="1.2" fill="currentColor" />
          <circle cx="0" cy="4" r="1.2" fill="currentColor" />
          <line x1="-6" y1="-1" x2="-9" y2="-10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
          <line x1="6" y1="-1" x2="9" y2="-10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        </g>

        <!-- Laptop icon only -->
        <g transform="translate(238, 34)">
          <rect x="-22" y="-20" width="44" height="40" rx="8" class="flasher-pic-node" />
          <rect x="-11" y="-8" width="22" height="13" rx="1.5" stroke="currentColor" stroke-width="1.5" />
          <path d="M-15 8 H15" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        </g>
      </svg>`}renderPictorialAp(){return`
      <svg class="flasher-pic-svg" viewBox="0 0 280 68" fill="none" aria-hidden="true">
        <defs>
          <marker id="pic-arrow-ap" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M 1 1.5 L 8.5 5 L 1 8.5 z" fill="currentColor" />
          </marker>
        </defs>

        <!-- Client (Laptop) -> Host (Hub) directional arrow -->
        <line x1="186" y1="34" x2="94" y2="34" class="flasher-pic-link" marker-end="url(#pic-arrow-ap)" />

        <!-- Hub -->
        <g transform="translate(68, 34)">
          <circle r="20" class="flasher-pic-node is-hub-node is-host-node" />
          <text y="3.5" text-anchor="middle" class="flasher-pic-node-title">Hub</text>
        </g>

        <!-- Laptop icon only -->
        <g transform="translate(212, 34)">
          <rect x="-22" y="-20" width="44" height="40" rx="8" class="flasher-pic-node" />
          <rect x="-11" y="-8" width="22" height="13" rx="1.5" stroke="currentColor" stroke-width="1.5" />
          <path d="M-15 8 H15" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        </g>
      </svg>`}renderStepWifi(){let isHostApMode=this.hubWifiMode==="host",useCustom=this.customMode;return`
      <div class="flasher-wizard-body">
        <div class="flasher-wizard-intro">
          <div class="flasher-wizard-badge-row">
            <span class="badge tone-good">Role: Hub \xB7 ${esc(this.timerLabel.trim()||"H1")}</span>
            <span class="note">Step 3 of 4 \xB7 2.4 GHz Wi-Fi only (5.8 GHz is disabled to protect FPV video)</span>
          </div>
          <h3>How should the Hub connect to your computer?</h3>
        </div>

        <div class="flasher-pictorial-grid" role="radiogroup" aria-label="Hub 2.4 GHz Wi-Fi mode">
          <button
            type="button"
            role="radio"
            aria-checked="${!isHostApMode}"
            class="flasher-pictorial-card ${isHostApMode?"":"is-active"}"
            data-pick-hub-mode="join"
            ${this.busy?"disabled":""}
          >
            <div class="flasher-pictorial-head">
              <span class="flasher-pictorial-title">Hub Connects to Router / Hotspot</span>
              <span class="badge ${isHostApMode?"":"tone-good"}">Station Mode</span>
            </div>
            <div class="flasher-pictorial-art">
              ${this.renderPictorialStation()}
            </div>
            <p class="flasher-pictorial-desc">
              Hub joins your phone hotspot or field router. Best when your laptop stays on internet Wi-Fi.
            </p>
          </button>

          <button
            type="button"
            role="radio"
            aria-checked="${isHostApMode}"
            class="flasher-pictorial-card ${isHostApMode?"is-active":""}"
            data-pick-hub-mode="host"
            ${this.busy?"disabled":""}
          >
            <div class="flasher-pictorial-head">
              <span class="flasher-pictorial-title">Hub Acts as Hotspot</span>
              <span class="badge ${isHostApMode?"tone-good":""}">Direct AP \xB7 Ch 1</span>
            </div>
            <div class="flasher-pictorial-art">
              ${this.renderPictorialAp()}
            </div>
            <p class="flasher-pictorial-desc">
              Hub broadcasts its own <strong>"SlapRF"</strong> Wi-Fi (<code>192.168.4.1</code>). Connect your laptop directly to it.
            </p>
          </button>
        </div>

        <div class="flasher-wifi-panel">
          <div class="flasher-wifi-inputs flasher-two-col">
            <div class="flasher-field">
              <label class="flasher-field-label">${isHostApMode?"2.4 GHz Hub hotspot SSID":"2.4 GHz Wi-Fi / hotspot SSID"}</label>
              ${isHostApMode?`<input
                      class="input mono"
                      type="text"
                      value="SlapRF \xB7 Ch 1 \xB7 192.168.4.1"
                      readonly
                      disabled
                      aria-label="Broadcast hotspot network"
                    />`:useCustom?`<div class="flasher-pass-wrap has-two-actions">
                        <input
                          class="input flasher-pass-input"
                          type="text"
                          placeholder="Type 2.4 GHz Wi-Fi / hotspot SSID"
                          value="${esc(this.wifiSSID)}"
                          data-wifi-ssid="1"
                          maxlength="32"
                          spellcheck="false"
                          autocomplete="off"
                          ${this.busy?"disabled":""}
                        />
                        <div class="flasher-inline-actions">
                          <button
                            type="button"
                            class="flasher-pass-toggle"
                            data-clear-ssid="1"
                            ${this.busy?"disabled":""}
                            aria-label="Return to scanned Wi-Fi network list"
                            title="Return to scanned Wi-Fi network list"
                          >
                            ${icons.close(14)}
                          </button>
                          <button
                            type="button"
                            class="flasher-pass-toggle"
                            data-refresh-wifi="1"
                            ${this.busy||this.scanningWifi?"disabled":""}
                            aria-label="Rescan nearby 2.4 GHz Wi-Fi networks"
                            title="Rescan nearby 2.4 GHz Wi-Fi networks"
                          >
                            ${icons.reset(14)}
                          </button>
                        </div>
                      </div>`:`<div class="flasher-pass-wrap has-two-actions">
                        <select
                          class="input flasher-ssid-select"
                          data-wifi-select="1"
                          aria-label="2.4 GHz Wi-Fi network to join"
                          ${this.busy?"disabled":""}
                        >
                          ${this.networks.length===0?`<option value="" disabled ${this.wifiSSID?"":"selected"}>No networks scanned</option>`:""}
                          ${this.networks.map(n=>`<option value="${esc(n.ssid)}" ${n.ssid===this.wifiSSID?"selected":""}>${esc(this.formatNetworkOption(n))}</option>`).join("")}
                          <option value="${CUSTOM_SSID_VALUE}">Type custom SSID\u2026</option>
                        </select>
                        <div class="flasher-inline-actions">
                          <button
                            type="button"
                            class="flasher-pass-toggle"
                            data-edit-ssid="1"
                            ${this.busy?"disabled":""}
                            aria-label="Type custom Wi-Fi / hotspot name"
                            title="Type custom Wi-Fi / hotspot name"
                          >
                            ${icons.pencil(14)}
                          </button>
                          <button
                            type="button"
                            class="flasher-pass-toggle"
                            data-refresh-wifi="1"
                            ${this.busy||this.scanningWifi?"disabled":""}
                            aria-label="Rescan nearby 2.4 GHz Wi-Fi networks"
                            title="Rescan nearby 2.4 GHz Wi-Fi networks"
                          >
                            ${icons.reset(14)}
                          </button>
                        </div>
                      </div>`}
            </div>

            <div class="flasher-field">
              <label class="flasher-field-label">${isHostApMode?"Hotspot password (optional)":"Wi-Fi / hotspot password"}</label>
              <div class="flasher-pass-wrap">
                <input
                  class="input flasher-pass-input"
                  type="${this.showPassword?"text":"password"}"
                  placeholder="${isHostApMode?"Blank = open hotspot (or 8+ chars WPA2)":"Wi-Fi / hotspot password"}"
                  value="${esc(this.wifiPass)}"
                  data-wifi-pass="1"
                  maxlength="39"
                  spellcheck="false"
                  autocomplete="off"
                  ${this.busy?"disabled":""}
                />
                <button
                  type="button"
                  class="flasher-pass-toggle"
                  data-toggle-pass="1"
                  aria-label="${this.showPassword?"Hide password":"Show password"}"
                  title="${this.showPassword?"Hide password":"Show password"}"
                >
                  ${this.showPassword?icons.eyeOff(15):icons.eye(15)}
                </button>
              </div>
            </div>
          </div>
        </div>

        <div class="flasher-wizard-nav">
          <button type="button" class="btn" data-wizard-prev="1" ${this.busy?"disabled":""}>
            ${icons.chevronLeft(15)}
            <span>Back</span>
          </button>
          <button type="button" class="btn" data-wizard-next="1" ${this.busy?"disabled":""}>
            <span>Next</span>
            ${icons.chevronRight(15)}
          </button>
        </div>
      </div>`}renderStepFlash(webSerialOk){let isHub=this.role==="hub",cleanLabel=this.timerLabel.trim()||(isHub?"H1":`S${this.selectedSpokeSlot}`),wifiSummary=isHub?this.hubWifiMode==="host"?`Hub Hotspot "SlapRF" (${this.wifiPass?"WPA2":"Open AP"})`:`Join "${this.wifiSSID.trim()||"(unset)"}" (Station Mode)`:"2.4 GHz ESP-NOW LR \u2192 Hub H1",pct=this.progress?this.progress.percent:this.lastSuccessMsg?100:0,statusText=this.progress?this.progress.detail:this.lastSuccessMsg?`\u2713 ${this.lastSuccessMsg}`:`Ready to flash ${cleanLabel} (${this.firmwareVersion}) over USB-C`;return`
      <div class="flasher-wizard-body">
        <div class="flasher-wizard-intro">
          <h3>Ready to flash ${esc(cleanLabel)}</h3>
          <p>Plug your <strong>Seeed Studio XIAO ESP32-C5</strong> into USB-C and click <strong>Flash to USB</strong>.</p>
        </div>

        <div class="flasher-receipt">
          <div class="flasher-receipt-item">
            <span class="note">Role</span>
            <div class="flasher-receipt-val">
              <span class="badge ${isHub?"tone-good":""}">${isHub?"Hub":"Spoke"}</span>
            </div>
          </div>

          <div class="flasher-receipt-item">
            <span class="note">Timer &amp; Firmware</span>
            <div class="flasher-receipt-val mono">
              <span>${esc(cleanLabel)} \xB7 ${esc(this.firmwareVersion)}</span>
            </div>
          </div>

          <div class="flasher-receipt-item">
            <span class="note">${isHub?"Wi-Fi Connection":"Radio Link"}</span>
            <div class="flasher-receipt-val mono">
              <span>${esc(wifiSummary)}</span>
            </div>
          </div>
        </div>

        <div class="flasher-progress ${this.busy?"is-flashing":""} ${this.lastSuccessMsg&&!this.busy?"is-complete":""}">
          <div class="flasher-progress-top">
            <span class="flasher-progress-status">${esc(statusText)}</span>
            <span class="mono flasher-progress-pct">${pct}%</span>
          </div>
          <div class="meter flasher-meter">
            <span class="meter-fill ${this.lastSuccessMsg&&!this.busy?"tone-good":""}" style="width:${pct}%"></span>
          </div>
          <div class="flasher-progress-foot">
            <label class="flasher-port-toggle">
              <input
                type="checkbox"
                data-all-ports="1"
                ${this.showAllPorts?"checked":""}
                ${this.busy?"disabled":""}
              />
              <span>Show all USB serial ports</span>
            </label>
            <div class="flasher-progress-foot-actions">
              ${this.lastSuccessMsg&&!this.busy?'<button type="button" class="btn btn-sm" data-flash-another="1">Select another role \u2192</button>':""}
              <button
                type="button"
                class="btn btn-sm btn-ghost"
                data-download-bin="1"
                ${this.busy?"disabled":""}
                title="Download the pre-configured .bin image"
              >
                <span>Download .bin</span>
              </button>
            </div>
          </div>
        </div>

        ${webSerialOk?"":'<p class="note">Direct USB reading and flashing requires Chrome, Edge, or Brave.</p>'}

        <div class="flasher-wizard-nav">
          <button
            type="button"
            class="btn"
            data-wizard-prev="1"
            ${this.busy?"disabled":""}
          >
            ${icons.chevronLeft(15)}
            <span>Back</span>
          </button>

          <button
            type="button"
            class="btn flasher-btn-flash"
            data-flash-usb="1"
            ${this.busy||!webSerialOk?"disabled":""}
          >
            <span class="flasher-zap-icon">${icons.zap(15)}</span>
            <span>${this.busy?`Flashing ${esc(cleanLabel)}\u2026 (${pct}%)`:`Flash ${esc(cleanLabel)} to USB`}</span>
          </button>
        </div>
      </div>`}renderReadoutCard(){return this.readout?`
      <div class="flasher-readout">
        <div class="flasher-readout-head">
          <span class="flasher-queue-label">Connected timer readout</span>
          <div class="flasher-readout-head-right">
            <span class="mono note">
              ${esc(this.readout.firmwareVersion)}
              ${this.readout.firmwareVersion===LATEST_FIRMWARE_VERSION?'<span class="badge tone-good">Latest</span>':`<span class="badge tone-warn">Update \u2192 ${LATEST_FIRMWARE_VERSION}</span>`}
              \xB7 ${esc(this.readout.chip)}
            </span>
            <button type="button" class="btn btn-sm btn-ghost" data-clear-readout="1" title="Dismiss readout">
              ${icons.close(13)}
            </button>
          </div>
        </div>
        <div class="flasher-readout-grid">
          <div>
            <span class="note">Timer</span>
            <div class="mono">${esc(this.readout.timerLabel||"(unnamed)")}</div>
          </div>
          <div>
            <span class="note">Role</span>
            <div class="mono">${this.readout.role==="hub"?"Hub":"Spoke"}</div>
          </div>
          <div>
            <span class="note">Firmware</span>
            <div class="mono">${esc(this.readout.firmwareVersion)}</div>
          </div>
          <div>
            <span class="note">2.4 GHz link</span>
            <div class="mono">${this.readout.role==="hub"?esc(this.readout.wifiSSID?`Join "${this.readout.wifiSSID}" (2.4 GHz)`:'Host "SlapRF" 2.4 GHz AP (Ch 1)'):"2.4 GHz ESP-NOW LR \u2192 Hub"}</div>
          </div>
          <div>
            <span class="note">5.8 GHz channels</span>
            <div class="mono">${this.readout.frequenciesMHz.join(" \xB7 ")} MHz</div>
          </div>
        </div>
      </div>`:""}render(){let webSerialOk=isWebSerialSupported(),animClass=this.slideDir==="next"?"is-slide-next":this.slideDir==="prev"?"is-slide-prev":"",stepContent="";switch(this.step){case"network":stepContent=this.renderStepNetwork(webSerialOk);break;case"identity":stepContent=this.renderStepIdentity();break;case"wifi":stepContent=this.renderStepWifi();break;case"flash":stepContent=this.renderStepFlash(webSerialOk);break}this.el.innerHTML=`
      <div class="flasher flasher-wizard">
        ${this.renderStepper()}

        <div class="flasher-wizard-viewport">
          <div class="flasher-wizard-stage ${animClass}">
            ${stepContent}
          </div>
        </div>

        ${this.step!=="flash"&&this.progress?`
          <div class="flasher-progress">
            <div class="flasher-progress-top">
              <span>${esc(this.progress.detail)}</span>
              <span class="mono">${this.progress.percent}%</span>
            </div>
            <div class="meter flasher-meter">
              <span class="meter-fill tone-good" style="width:${this.progress.percent}%"></span>
            </div>
          </div>`:""}

        ${this.step!=="flash"&&this.lastSuccessMsg&&!this.busy?`<div class="flasher-banner is-ok">\u2713 ${esc(this.lastSuccessMsg)}</div>`:""}

        ${this.errorMsg&&!this.busy?`<div class="flasher-banner is-err">${esc(this.errorMsg)}</div>`:""}

        ${this.renderReadoutCard()}
      </div>`}};var TimersList=class extends Component{store;api;colorPickerTimerId=null;constructor(el,store,api){super(el),this.store=store,this.api=api,this.listen(el,"keydown",e=>{e.key==="Escape"&&this.colorPickerTimerId!==null&&(this.colorPickerTimerId=null,this.render())}),this.listen(el,"click",e=>{let target=e.target,pickColorBtn=target.closest("[data-pick-puck-color]");if(pickColorBtn){let timerId=Number(pickColorBtn.dataset.forPuck),color=pickColorBtn.dataset.pickPuckColor??"";this.colorPickerTimerId=null,this.api.updateTimerColor(timerId,color);return}let toggleSwatch=target.closest("[data-toggle-puck-color]");if(toggleSwatch){let timerId=Number(toggleSwatch.dataset.togglePuckColor);this.colorPickerTimerId=this.colorPickerTimerId===timerId?null:timerId,this.render()}});let onDocClick=e=>{if(this.colorPickerTimerId===null)return;let target=e.target;(!target||!this.el.contains(target)||!target.closest(".gate-color-wrap"))&&(this.colorPickerTimerId=null,this.render())};document.addEventListener("mousedown",onDocClick),this.onDispose(()=>document.removeEventListener("mousedown",onDocClick)),this.onDispose(store.subscribe(["config","status"],()=>this.render())),this.render()}get allTimers(){return(this.store.detectedPucks.length>0?[...this.store.detectedPucks]:this.store.pucks.filter(p=>(p.assignedPuckId??p.puckId)>0).map(p=>({puckId:p.assignedPuckId??p.puckId,puckLabel:p.puckLabel??"",color:p.color,isHub:(p.assignedPuckId??p.puckId)===1,firmwareVersion:p.firmwareVersion??LATEST_FIRMWARE_VERSION,batteryMv:p.batteryMv,batteryPct:p.batteryPct,noiseFloorDbm:p.noiseFloorDbm,online:p.online,lastSeenAt:p.lastSeenAt}))).sort((a,b)=>a.puckId-b.puckId)}formatTitle(d){return d.puckLabel&&d.puckLabel.trim()!==""?`T${d.puckId} \xB7 ${d.puckLabel.trim()}`:`T${d.puckId}`}render(){let timers=this.allTimers;if(timers.length===0){this.el.innerHTML=renderEmpty("No timers detected yet","Power on your Hub timer (or start the simulator below) and discovered timers will appear here.");return}this.el.innerHTML=`
      <div class="table-scroll">
        <div class="slot-table puck-table">
          <div class="puck-table-row puck-table-head">
            <span>Timer</span>
            <span>Status</span>
            <span>Role</span>
            <span>Firmware</span>
            <span>Noise floor</span>
            <span>Battery</span>
          </div>
          ${timers.map(d=>this.renderRow(d)).join("")}
        </div>
      </div>`}renderRow(d){let title=this.formatTitle(d),tone=d.batteryPct<=20?"bad":d.batteryPct<=40?"warn":"good",color=timerColor(this.store,d.puckId),isPickerOpen=this.colorPickerTimerId===d.puckId,fwVer=d.firmwareVersion||LATEST_FIRMWARE_VERSION,isLatestFw=fwVer===LATEST_FIRMWARE_VERSION,popoverHtml=isPickerOpen?`
        <div class="gate-color-popover" role="listbox" aria-label="Choose color for Timer ${d.puckId}">
          <div class="gate-color-popover-grid">
            ${TIMER_COLORS.map(c=>{let selected=c.toLowerCase()===color.toLowerCase();return`
                <button
                  type="button"
                  class="gate-color-option ${selected?"is-selected":""}"
                  style="--c:${c}"
                  data-pick-puck-color="${c}"
                  data-for-puck="${d.puckId}"
                  title="${c}"
                  aria-label="Select color ${c}"
                  aria-selected="${selected}"
                ></button>`}).join("")}
          </div>
        </div>`:"";return`
      <div class="puck-table-row ${isPickerOpen?"is-picker-open":""} ${d.online?"":"is-offline"}">
        <div class="detected-puck-id">
          <div class="gate-color-wrap">
            <button
              type="button"
              class="gate-color-swatch ${isPickerOpen?"is-open":""}"
              data-toggle-puck-color="${d.puckId}"
              style="--c:${color}"
              title="Choose timer color"
              aria-label="Choose Timer ${d.puckId} color"
              aria-expanded="${isPickerOpen}"
            ></button>
            ${popoverHtml}
          </div>
          <strong class="mono">${esc(title)}</strong>
        </div>

        <div>
          <span class="puck-status-pill ${d.online?"is-online":"is-offline"}">
            <span class="status-dot ${d.online?"is-up":""}"></span>
            <span>${d.online?"Online":"Offline"}</span>
          </span>
        </div>

        <div>
          <span class="detected-role-pill ${d.isHub?"is-hub":""}">${d.isHub?"Hub":"Spoke"}</span>
        </div>

        <div class="puck-fw-cell">
          <span class="mono">${esc(fwVer)}</span>
          ${isLatestFw?'<span class="badge tone-good">Latest</span>':`<span class="badge tone-warn" title="Flash ${LATEST_FIRMWARE_VERSION} over USB below">Update \u2192 ${LATEST_FIRMWARE_VERSION}</span>`}
        </div>

        <div class="mono muted">${d.online?`${d.noiseFloorDbm.toFixed(0)} dBm`:"\u2014"}</div>

        <div class="puck-battery-cell">
          <div class="meter puck-battery-meter"><span class="meter-fill tone-${tone}" style="width:${d.batteryPct}%"></span></div>
          <span class="mono puck-battery-text">${d.batteryPct}% \xB7 ${(d.batteryMv/1e3).toFixed(2)} V</span>
        </div>
      </div>`}};var RULES=[{key:"minLapSec",label:"Minimum lap time (seconds)",help:"Shortest valid time before the same gate can count a pilot again.",step:.5,min:1,max:120,reason:"MIN_LAP",perGate:!0},{key:"maxLapSec",label:"Maximum lap time (seconds)",help:"Laps longer than this are discarded (crashes, landings, or pack swaps).",step:5,min:10,max:900,reason:"LAP_TOO_LONG",perGate:!1},{key:"gateCooldownSec",label:"Gate cool-down (seconds)",help:"Time a gate ignores a pilot right after counting them.",step:.1,min:.2,max:15,reason:"COOLDOWN",perGate:!0},{key:"minSectionSec",label:"Minimum section time (seconds)",help:"Shortest valid transit time from the previous gate.",step:.1,min:.1,max:15,reason:"TOO_SOON",perGate:!0},{key:"echoWindowSec",label:"Previous-gate echo window (seconds)",help:"Ignores repeat triggers at the gate a pilot just left (0 disables).",step:.5,min:0,max:15,reason:"ECHO",perGate:!0}],DEFAULT_RULES2={minLapSec:5,maxLapSec:120,gateCooldownSec:2,minSectionSec:.5,echoWindowSec:3},TimingRulesEditor=class extends Component{store;api;scope=null;constructor(el,store,api){super(el),this.store=store,this.api=api,this.listen(el,"change",()=>{let form=this.el.querySelector("form.rules");form&&this.save(form)}),this.listen(el,"keydown",e=>{let target=e.target;target instanceof HTMLInputElement&&(e.key==="Enter"?(e.preventDefault(),target.blur()):e.key==="Escape"&&(target.value=target.defaultValue,target.blur()))}),this.listen(el,"submit",e=>{e.preventDefault(),this.save(e.target)}),this.listen(el,"click",e=>{let target=e.target,toggleBtn=target.closest("[data-override-toggle]");if(toggleBtn){let key=toggleBtn.dataset.overrideToggle,row=toggleBtn.closest(".rule-row"),input=row?.querySelector(`input[name="${key}"]`),form=this.el.querySelector("form.rules");if(row&&input&&form){let nextOn=input.disabled;input.disabled=!nextOn,row.classList.toggle("is-overridden",nextOn),nextOn?(input.focus(),input.select()):input.value=String(this.store.rules[key]),this.syncToggleBtn(toggleBtn,nextOn,this.store.rules[key]),this.save(form)}return}let scope=target.closest("[data-scope]");if(scope){this.scope=scope.dataset.scope==="all"?null:Number(scope.dataset.scope),this.render();return}let action=target.closest("[data-action]")?.dataset.action;action==="defaults"&&this.api.updateRules(DEFAULT_RULES2),action==="clear"&&this.scope!==null&&this.api.setGateRules(this.scope,{})}),this.onDispose(store.subscribe(["rules","config"],()=>{this.scope!==null&&!store.puck(this.scope)&&(this.scope=null);let active=document.activeElement;active instanceof HTMLInputElement&&this.el.contains(active)||this.render()})),this.onDispose(store.subscribe(["crossings"],()=>this.renderCounts())),this.render()}overridesOf(p){return p?.ruleOverrides??{}}render(){let r=this.store.rules,gate=this.scope===null?void 0:this.store.puck(this.scope),overrides=this.overridesOf(gate),scopes=[`<button type="button" class="channel channel-all ${this.scope===null?"is-focus":"is-dim"}" data-scope="all" title="Global rules for all gates">
        <span class="dot channel-all-dot"></span>
        <span class="channel-name">All gates</span>
        <span class="channel-dbm mono">Global</span>
      </button>`,...this.store.pucks.map(p=>{let n=Object.keys(this.overridesOf(p)).length,on=this.scope===p.puckId,dim=this.scope!==null&&!on;return`<button type="button" class="channel ${on?"is-focus":""} ${dim?"is-dim":""}" data-scope="${p.puckId}"
                  title="${n?`${n} rule${n>1?"s":""} overridden at this gate`:"Uses the global rules"}">
                  <span class="dot" style="--c:${gateColor(this.store,p.puckId)}"></span>
                  <span class="channel-name">${esc(gateLabel(this.store,p.puckId))}</span>
                  <span class="channel-dbm mono">${n?`<span class="seg-count">${n} custom</span>`:"Default"}</span>
                </button>`})].join(""),rows=RULES.map(spec=>{if(gate)return this.renderGateRow(spec,r,overrides);let overrideNote=this.renderOverrideNote(spec);return`
        <div class="rule-row">
          <div class="rule-text">
            <div class="rule-label">${spec.label}</div>
            <div class="rule-help">${spec.help}</div>
            ${overrideNote}
          </div>
          <span class="rule-count" data-count="${spec.reason}"></span>
          <div class="rule-input">
            <input class="input mono" type="number" name="${spec.key}" value="${r[spec.key]}" step="${spec.step}" min="${spec.min}" max="${spec.max}" />
          </div>
          ${overrideNote?`<div class="rule-mobile-note">${overrideNote}</div>`:""}
        </div>`}).join(""),foot=gate?`<p class="note">Edited rules apply only to ${esc(gateLabel(this.store,gate.puckId))}.</p>
         ${Object.keys(overrides).length?'<button class="btn btn-ghost btn-sm" type="button" data-action="clear">Use all-gate rules</button>':""}`:`<p class="note">Applies to new detections.</p>
         <button class="btn btn-ghost btn-sm" type="button" data-action="defaults">Restore defaults</button>`;this.el.innerHTML=`
      <div class="rules-scope">
        <span class="rules-scope-label">Applies to</span>
        <div class="channel-legend rules-scope-grid" role="tablist" aria-label="Rules for">${scopes}</div>
      </div>
      <form class="rules">
        ${rows}
        <div class="rules-foot">${foot}</div>
      </form>`,this.renderCounts()}renderGateRow(spec,r,overrides){if(!spec.perGate)return`
        <div class="rule-row is-global-only">
          <div class="rule-text">
            <div class="rule-label">${spec.label}</div>
            <div class="rule-help">Applies to the whole lap, so it's set under All gates.</div>
          </div>
          <span class="rule-count"></span>
          <div class="rule-input">
            <input class="input mono" type="number" value="${r[spec.key]}" disabled />
          </div>
        </div>`;let key=spec.key,own=overrides[key],on=own!==void 0,title=on?`Revert to All gates default (${r[key]} s)`:`Edit to override at this gate (inherits ${r[key]} s)`;return`
      <div class="rule-row ${on?"is-overridden":""}">
        <div class="rule-text">
          <div class="rule-label">${spec.label}</div>
          <div class="rule-help">${spec.help}</div>
        </div>
        <span class="rule-count" data-count="${spec.reason}"></span>
        <div class="flasher-pass-wrap rule-input has-inline-action">
          <input class="input mono flasher-pass-input" type="number" name="${key}" value="${on?own:r[key]}" step="${spec.step}" min="${spec.min}" max="${spec.max}" ${on?"":"disabled"} />
          <button
            class="flasher-pass-toggle rule-inline-btn ${on?"is-active":""}"
            type="button"
            data-override-toggle="${key}"
            title="${title}"
            aria-label="${title}"
            aria-pressed="${on}"
          >
            ${on?icons.reset(14):icons.pencil(14)}
          </button>
        </div>
      </div>`}syncToggleBtn(btn,on,globalVal){let title=on?`Revert to All gates default (${globalVal} s)`:`Edit to override at this gate (inherits ${globalVal} s)`;btn.className=`flasher-pass-toggle rule-inline-btn ${on?"is-active":""}`,btn.title=title,btn.setAttribute("aria-label",title),btn.setAttribute("aria-pressed",String(on)),btn.innerHTML=on?icons.reset(14):icons.pencil(14)}renderOverrideNote(spec){if(!spec.perGate)return"";let key=spec.key,list=this.store.pucks.filter(p=>this.overridesOf(p)[key]!==void 0).map(p=>`${esc(gateLabel(this.store,p.puckId))} ${this.overridesOf(p)[key]} s`);return list.length?`<div class="rule-override-note">Overridden at ${list.join(", ")}</div>`:""}renderCounts(){let counts=new Map;for(let f of this.store.filtered)this.scope!==null&&f.puckId!==this.scope||counts.set(f.reason,(counts.get(f.reason)??0)+1);let where=this.scope===null?"":" here";this.el.querySelectorAll("[data-count]").forEach(node=>{let reason=node.dataset.count,n=counts.get(reason)??0;node.textContent=n?`${n} ${FILTER_LABELS[reason].toLowerCase()}${where} this session`:""})}async save(form){let data=new FormData(form);if(this.scope===null){let next={...this.store.rules};for(let spec of RULES)next[spec.key]=Number(data.get(spec.key));await this.api.updateRules(next);return}let overrides={};for(let spec of RULES){if(!spec.perGate)continue;let v=data.get(spec.key);v!==null&&v!==""&&(overrides[spec.key]=Number(v))}await this.api.setGateRules(this.scope,overrides)}};var TrackEditor=class extends Component{store;api;selectedNodeId=null;isDragging=!1;constructor(el,store,api){super(el),this.store=store,this.api=api,this.listen(el,"keydown",e=>{let input=e.target;input.matches("[data-gate-name]")&&(e.key==="Enter"&&input.blur(),e.key==="Escape"&&(input.value=input.defaultValue,this.syncNodeNamePreview(Number(input.dataset.gateName),input.value),input.blur()))}),this.listen(el,"input",e=>{let input=e.target;input.matches("[data-gate-name]")&&this.syncNodeNamePreview(Number(input.dataset.gateName),input.value)}),this.listen(el,"focusout",e=>{let input=e.target;input.matches("[data-gate-name]")&&this.renameNode(input)}),this.listen(el,"click",e=>{let makeStartBtn=e.target.closest("[data-make-start]");makeStartBtn&&(e.stopPropagation(),this.makeStart(Number(makeStartBtn.dataset.makeStart)))}),this.listen(el,"pointerdown",e=>{if(e.button!==0)return;let target=e.target;if(target.closest("[data-make-start]"))return;let trayTimerEl=target.closest(".unassigned-puck-token[data-puck-id]");if(trayTimerEl){this.beginTrayTimerDrag(e,trayTimerEl);return}let nodeEl=target.closest(".gate-node-circle, .gate-node-name, .gate-node-top")?.closest(".gate-line-item[data-gate]");nodeEl&&this.beginTrackNodeInteraction(e,nodeEl)}),this.onDispose(store.subscribe(["config","status"],()=>{let active=document.activeElement;!((active instanceof HTMLInputElement||active instanceof HTMLSelectElement)&&this.el.contains(active))&&!this.isDragging&&this.render()})),this.render()}get orderedNodes(){return[...this.store.pucks].sort((a,b)=>a.trackOrder-b.trackOrder)}get detectedTimers(){return this.store.detectedPucks.length>0?[...this.store.detectedPucks].sort((a,b)=>a.puckId-b.puckId):this.store.pucks.filter(p=>(p.assignedPuckId??p.puckId)>0).map(p=>({puckId:p.assignedPuckId??p.puckId,puckLabel:p.puckLabel??"",color:p.color,isHub:(p.assignedPuckId??p.puckId)===1,batteryMv:p.batteryMv,batteryPct:p.batteryPct,noiseFloorDbm:p.noiseFloorDbm,online:p.online,lastSeenAt:p.lastSeenAt})).sort((a,b)=>a.puckId-b.puckId)}formatTimerShortCode(timerId){return timerId>0?`T${timerId}`:"\u2014"}ensureSelectedNode(nodes){if(nodes.length===0)return this.selectedNodeId=null,null;let found=nodes.find(n=>n.puckId===this.selectedNodeId);return found||(this.selectedNodeId=nodes[0].puckId,nodes[0])}render(){let nodes=this.orderedNodes,detected=this.detectedTimers,selectedNode=this.ensureSelectedNode(nodes),selectedIndex=selectedNode?nodes.findIndex(n=>n.puckId===selectedNode.puckId):-1,assignedTimerIds=new Set(nodes.map(n=>n.assignedPuckId??0).filter(id=>id>0)),unassignedTimers=detected.filter(d=>!assignedTimerIds.has(d.puckId));this.el.innerHTML=`
      <div class="gate-track-stage">
        <div class="gate-track-header">
          <span class="gate-track-caption">
            Drag timers onto the line to add gates \xB7 drag along the line to reorder \xB7 drag into Unassigned timers to remove
          </span>
        </div>

        <div class="gate-track-scroll" data-track-dropzone>
          <div class="gate-track-line ${nodes.length===0?"is-empty-line":""}" data-track-line role="list" aria-label="Course gate order">
            ${nodes.length===0?this.renderEmptyTimelinePlaceholder():nodes.map((n,idx)=>this.renderTrackNode(n,idx,nodes,detected,selectedNode!==null&&n.puckId===selectedNode.puckId)).join("")}
          </div>
        </div>

        ${this.renderUnassignedTray(unassignedTimers)}
      </div>

      ${selectedNode?this.renderInspector(selectedNode,selectedIndex,detected):""}
    `}renderEmptyTimelinePlaceholder(){return`
      <div class="gate-line-item is-empty-placeholder" data-empty-placeholder role="listitem">
        <div class="gate-line-track-seg is-before is-dashed-seg"></div>
        <div class="gate-line-track-seg is-after is-dashed-seg"></div>
        <div class="gate-node-top">
          <span class="gate-node-order mono">#1</span>
        </div>
        <div class="gate-node-circle is-unassigned is-empty-slot-circle">
          <span class="gate-node-empty-label" data-empty-circle-label>Drop<br/>timer</span>
        </div>
        <div class="gate-node-name is-empty-slot-caption" data-empty-slot-name>Drag a timer onto the line to create Gate #1</div>
        <span class="gate-node-start-btn is-placeholder-flag" aria-hidden="true">${icons.checkered(13)}</span>
      </div>`}renderTrackNode(node,index,allNodes,detected,isSelected){let total=allNodes.length,isStart=node.role==="START_FINISH",assignedId=node.assignedPuckId??0,hasTimer=assignedId>0,tiedTimer=detected.find(d=>d.puckId===assignedId),shortCode=this.formatTimerShortCode(assignedId),roleSub=hasTimer?tiedTimer?.isHub||assignedId===1?"HUB":"SPK":"EMPTY",color=hasTimer?timerColor(this.store,assignedId):"#64748b",lastAssignedId=allNodes[(total-1+total)%total]?.assignedPuckId??0,lastColor=lastAssignedId>0?timerColor(this.store,lastAssignedId):"#64748b",nextAssignedId=allNodes[(index+1)%total]?.assignedPuckId??0,nextColor=nextAssignedId>0?timerColor(this.store,nextAssignedId):"#64748b",displayName=node.name.trim()||`Gate ${index+1}`,isOnline=tiedTimer?tiedTimer.online:node.online,sectionTag=`S${index+1}`,wrapSectionTag=`S${total}`;return`
      <div
        class="gate-line-item ${isSelected?"is-selected":""} ${isStart?"is-start":""} ${hasTimer?"has-puck":"is-empty-gate"}"
        data-gate="${node.puckId}"
        data-assigned-puck="${assignedId}"
        data-puck-color="${color}"
        style="--c:${color}"
        role="listitem"
      >
        <div class="gate-line-track-seg is-before"></div>
        <div class="gate-line-track-seg is-after"></div>

        <span
          class="gate-line-sec-pill is-leading sec-id-badge mono"
          style="--c1:${lastColor};--c2:${color}"
          title="Section ${wrapSectionTag} (wrapping from #${total} into #1)"
        >
          ${renderSectionCapsuleIcon(lastColor,color)}
          <span class="sec-pill-text">${wrapSectionTag}</span>
        </span>

        <span
          class="gate-line-sec-pill is-trailing sec-id-badge mono"
          style="--c1:${color};--c2:${nextColor}"
          title="Section ${sectionTag}"
        >
          ${renderSectionCapsuleIcon(color,nextColor)}
          <span class="sec-pill-text">${sectionTag}</span>
        </span>

        <div class="gate-node-top">
          <span class="gate-node-order mono">#${index+1}</span>
        </div>

        <button
          type="button"
          class="gate-node-circle ${hasTimer?"is-filled":"is-unassigned"}"
          aria-pressed="${isSelected}"
          aria-label="Gate ${index+1}: ${esc(displayName)} (${hasTimer?shortCode:"Unassigned"})"
          title="Click to inspect \xB7 Drag left/right to reorder \xB7 Drag down to Unassigned timers to remove gate"
        >
          ${hasTimer?`
                <span class="gate-node-puck-code mono">${esc(shortCode)}</span>
                <span class="gate-node-puck-meta">
                  <span class="gate-node-status-dot ${isOnline?"is-online":""}"></span>
                  <span>${roleSub}</span>
                </span>`:`
                <span class="gate-node-empty-label">Empty</span>`}
        </button>

        <div class="gate-node-name" data-node-name="${node.puckId}">${esc(displayName)}</div>

        <button
          type="button"
          class="gate-node-start-btn ${isStart?"is-active":""}"
          data-make-start="${node.puckId}"
          aria-pressed="${isStart}"
          title="${isStart?"Start gate":"Set as start gate"}"
          aria-label="${isStart?`Gate ${index+1} is the start gate`:`Set Gate ${index+1} as start gate`}"
        >${icons.checkered(13)}</button>
      </div>`}renderUnassignedTray(unassigned){return`
      <div class="gate-unassigned-tray" data-unassigned-tray>
        <div class="gate-unassigned-label">
          <span class="gate-unassigned-title">Unassigned timers</span>
          <span class="gate-unassigned-hint">
            ${unassigned.length>0?"Drag a timer onto the track line above to create a gate at that spot":"All timers are on the track \xB7 drag a timer off the line into this box to remove its gate"}
          </span>
        </div>
        <div class="gate-unassigned-list">
          ${unassigned.length>0?unassigned.map(d=>this.renderTrayTimer(d)).join(""):'<span class="gate-unassigned-empty-chip">Drop a timer here to remove its gate from the track</span>'}
        </div>
      </div>`}renderTrayTimer(d){let color=timerColor(this.store,d.puckId),roleSub=d.isHub?"HUB":"SPK",label=d.puckLabel?.trim()?` \xB7 ${d.puckLabel.trim()}`:"";return`
      <div
        class="unassigned-puck-token"
        data-puck-id="${d.puckId}"
        style="--c:${color}"
        title="P${d.puckId}${esc(label)} (${roleSub}) \xB7 Drag onto the track line above to create a gate"
      >
        <span class="unassigned-puck-dot" style="--c:${color}">
          <span class="mono">P${d.puckId}</span>
        </span>
        <div class="unassigned-puck-info">
          <span class="unassigned-puck-name mono">P${d.puckId}${esc(label)}</span>
          <span class="unassigned-puck-sub">
            <span class="gate-node-status-dot ${d.online?"is-online":""}"></span>
            ${d.isHub?"Hub":"Spoke"} \xB7 ${d.online?`${d.batteryPct}%`:"Offline"}
          </span>
        </div>
      </div>`}renderInspector(node,index,detected){let isStart=node.role==="START_FINISH",assignedId=node.assignedPuckId??0,hasTimer=assignedId>0,tiedTimer=detected.find(d=>d.puckId===assignedId),defaultPlaceholder=`Gate ${index+1}`,color=hasTimer?timerColor(this.store,assignedId):"#64748b",timerSummaryHtml=hasTimer?`
        <div class="gate-inspector-puck-box">
          <span class="gate-inspector-dot" style="--c:${color}"></span>
          <strong class="mono">T${assignedId}${tiedTimer?.puckLabel?.trim()?` \xB7 ${esc(tiedTimer.puckLabel.trim())}`:""}</strong>
          <span class="detected-role-pill ${tiedTimer?.isHub||assignedId===1?"is-hub":""}">
            ${tiedTimer?.isHub||assignedId===1?"Hub":"Spoke"}
          </span>
          <span class="muted mono">${tiedTimer?tiedTimer.online?`${tiedTimer.batteryPct}%`:"Offline":""}</span>
        </div>`:`
        <div class="gate-inspector-puck-box is-empty">
          <span class="muted">No timer assigned</span>
        </div>`;return`
      <div class="gate-inspector" style="--c:${color}">
        <div class="gate-inspector-head">
          <div class="gate-inspector-title">
            <span class="gate-inspector-step mono">#${index+1}</span>
            ${hasTimer?`<span class="gate-inspector-dot" style="--c:${color}"></span>`:""}
            <strong>${esc(node.name.trim()||`Gate ${index+1}`)}</strong>
            ${isStart?`<span class="badge badge-accent gate-inspector-start-badge">${icons.checkered(12)} Start gate</span>`:'<span class="badge">Split gate</span>'}
          </div>
        </div>

        <div class="gate-inspector-grid is-two-col">
          <label class="field">
            <span class="field-label">Gate name</span>
            <input
              class="input gate-name-field"
              data-gate-name="${node.puckId}"
              value="${esc(node.name)}"
              placeholder="${esc(defaultPlaceholder)}"
              maxlength="40"
              spellcheck="false"
              autocomplete="off"
            />
          </label>

          <div class="field">
            <span class="field-label">Timer at this gate</span>
            ${timerSummaryHtml}
          </div>
        </div>
      </div>`}syncNodeNamePreview(nodeId,rawName){let idx=this.orderedNodes.findIndex(n=>n.puckId===nodeId),display=rawName.trim()||`Gate ${idx>=0?idx+1:nodeId}`,nodeLabel=this.el.querySelector(`[data-node-name="${nodeId}"]`);nodeLabel&&(nodeLabel.textContent=display);let titleStrong=this.el.querySelector(".gate-inspector-title strong");titleStrong&&this.selectedNodeId===nodeId&&(titleStrong.textContent=display)}async removeTrackNode(nodeId){this.isDragging=!0;try{await this.api.removeTrackNode(nodeId),this.selectedNodeId===nodeId&&(this.selectedNodeId=this.orderedNodes[0]?.puckId??null)}finally{this.isDragging=!1,this.render()}}async renameNode(input){let node=this.store.puck(Number(input.dataset.gateName));if(!node)return;let name=input.value.trim();name!==node.name.trim()&&(input.defaultValue=name,await this.save(node,{name}))}async makeStart(nodeId){let node=this.store.puck(nodeId);!node||node.role==="START_FINISH"||await this.save(node,{role:"START_FINISH"})}createInsertionPreviewSlot(timerId,color){let slot=document.createElement("div");return slot.className="gate-line-item is-drop-slot is-insert-preview",slot.dataset.puckColor=color,slot.style.setProperty("--c",color),slot.innerHTML=`
      <div class="gate-line-track-seg is-before"></div>
      <div class="gate-line-track-seg is-after"></div>
      <span class="gate-line-sec-pill is-leading sec-id-badge mono" style="--c1:${color};--c2:${color}">
        ${renderSectionCapsuleIcon(color,color)}
        <span class="sec-pill-text">S1</span>
      </span>
      <span class="gate-line-sec-pill is-trailing sec-id-badge mono" style="--c1:${color};--c2:${color}">
        ${renderSectionCapsuleIcon(color,color)}
        <span class="sec-pill-text">S1</span>
      </span>
      <div class="gate-node-top">
        <span class="gate-node-order mono">#1</span>
      </div>
      <div class="gate-node-circle is-unassigned is-landing-preview" style="--c:${color}">
        <span class="gate-node-empty-label mono">T${timerId}</span>
      </div>
      <div class="gate-node-name">New gate</div>
      <span class="gate-node-start-btn is-placeholder-flag" aria-hidden="true">${icons.checkered(13)}</span>
    `,slot}isPointerDirectlyOnTrackLine(lineEl,x,y,currentlyOver){let lineRect=lineEl.getBoundingClientRect();if(x<lineRect.left-12||x>lineRect.right+12)return!1;let firstCircle=lineEl.querySelector(".gate-node-circle"),lineCenterY=firstCircle?firstCircle.getBoundingClientRect().top+firstCircle.getBoundingClientRect().height/2:lineRect.top+54,threshold=currentlyOver?64:48;return Math.abs(y-lineCenterY)<=threshold}beginTrayTimerDrag(downEvent,tokenEl){downEvent.pointerType==="touch"&&downEvent.preventDefault();try{tokenEl.setPointerCapture(downEvent.pointerId)}catch{}let timerId=Number(tokenEl.dataset.puckId),color=timerColor(this.store,timerId),startX=downEvent.clientX,startY=downEvent.clientY,lineEl=this.el.querySelector("[data-track-line]"),emptyPlaceholder=this.el.querySelector("[data-empty-placeholder]"),started=!1,floatingEl=null,previewSlot=null,insertIndex=null,isOverLine=!1,blockTouchScroll=te=>{te.cancelable&&te.preventDefault()};window.addEventListener("touchmove",blockTouchScroll,{passive:!1});let setEmptyPlaceholderPreview=active=>{if(!emptyPlaceholder)return;let circle=emptyPlaceholder.querySelector(".gate-node-circle"),label=emptyPlaceholder.querySelector("[data-empty-circle-label]"),nameEl=emptyPlaceholder.querySelector("[data-empty-slot-name]");active?(emptyPlaceholder.classList.add("is-insert-preview"),emptyPlaceholder.style.setProperty("--c",color),circle&&(circle.classList.add("is-landing-preview"),circle.style.setProperty("--c",color)),label&&(label.textContent=`T${timerId}`),nameEl&&(nameEl.textContent="New gate")):(emptyPlaceholder.classList.remove("is-insert-preview"),emptyPlaceholder.style.removeProperty("--c"),circle&&(circle.classList.remove("is-landing-preview"),circle.style.removeProperty("--c")),label&&(label.innerHTML="Drop<br/>timer"),nameEl&&(nameEl.textContent="Drag a timer onto the line to create Gate #1"))},startDrag=(clientX,clientY)=>{started=!0,this.isDragging=!0,document.body.classList.add("is-gate-dragging"),tokenEl.classList.add("is-dragging-source");let ghost=document.createElement("div");ghost.className="gate-node-circle is-filled gate-node-floating",ghost.style.setProperty("--c",color),ghost.style.width="58px",ghost.style.height="58px",ghost.style.transform=`translate3d(${clientX-29}px, ${clientY-29}px, 0) scale(1.06)`,ghost.innerHTML=`<span class="gate-node-puck-code mono">${esc(this.formatTimerShortCode(timerId))}</span>`,document.body.appendChild(ghost),floatingEl=ghost},onMove=ev=>{let dx=ev.clientX-startX,dy=ev.clientY-startY;if(!started){if(Math.hypot(dx,dy)<4)return;startDrag(ev.clientX,ev.clientY)}if(!floatingEl||!lineEl)return;ev.cancelable&&ev.preventDefault(),floatingEl.style.transform=`translate3d(${ev.clientX-29}px, ${ev.clientY-29}px, 0) scale(1.06)`;let overTimeline=this.isPointerDirectlyOnTrackLine(lineEl,ev.clientX,ev.clientY,isOverLine);if(isOverLine=overTimeline,emptyPlaceholder){setEmptyPlaceholderPreview(overTimeline),insertIndex=overTimeline?0:null;return}if(!overTimeline){previewSlot&&(previewSlot.remove(),previewSlot=null,this.syncLinePositionsInPlace()),insertIndex=null;return}previewSlot||(previewSlot=this.createInsertionPreviewSlot(timerId,color));let realNodes=[...lineEl.querySelectorAll(".gate-line-item[data-gate]")],targetIdx=realNodes.length;for(let i=0;i<realNodes.length;i++){let r=realNodes[i].getBoundingClientRect();if(ev.clientX<r.left+r.width/2){targetIdx=i;break}}insertIndex=targetIdx;let refNode=realNodes[targetIdx]??null;(previewSlot.parentElement!==lineEl||previewSlot.nextElementSibling!==refNode)&&(lineEl.insertBefore(previewSlot,refNode),this.syncLinePositionsInPlace())},onEnd=async()=>{window.removeEventListener("pointermove",onMove),window.removeEventListener("pointerup",onEnd),window.removeEventListener("pointercancel",onEnd),window.removeEventListener("touchmove",blockTouchScroll);try{tokenEl.hasPointerCapture(downEvent.pointerId)&&tokenEl.releasePointerCapture(downEvent.pointerId)}catch{}document.body.classList.remove("is-gate-dragging"),floatingEl&&(floatingEl.remove(),floatingEl=null);let targetSlot=emptyPlaceholder??previewSlot;if(started&&insertIndex!==null&&targetSlot){let previewCircle=targetSlot.querySelector(".gate-node-circle");previewCircle&&(previewCircle.className="gate-node-circle is-filled",previewCircle.style.setProperty("--c",color),previewCircle.innerHTML=`<span class="gate-node-puck-code mono">T${timerId}</span>`),targetSlot.classList.remove("is-drop-slot","is-insert-preview","is-empty-placeholder"),tokenEl.style.display="none";try{let beforeIds=new Set(this.store.pucks.map(p=>p.puckId));await this.api.addTrackNode("",timerId,insertIndex);let created=this.store.pucks.find(p=>!beforeIds.has(p.puckId));created&&(this.selectedNodeId=created.puckId)}finally{this.isDragging=!1,this.render()}}else tokenEl.classList.remove("is-dragging-source"),emptyPlaceholder&&setEmptyPlaceholderPreview(!1),previewSlot&&(previewSlot.remove(),previewSlot=null),this.isDragging=!1,started&&this.render()};window.addEventListener("pointermove",onMove),window.addEventListener("pointerup",onEnd),window.addEventListener("pointercancel",onEnd)}beginTrackNodeInteraction(downEvent,item){try{item.setPointerCapture(downEvent.pointerId)}catch{}let nodeId=Number(item.dataset.gate),circle=item.querySelector(".gate-node-circle")??item,trayEl=this.el.querySelector("[data-unassigned-tray]"),startX=downEvent.clientX,startY=downEvent.clientY,initialCircleRect=circle.getBoundingClientRect(),started=!1,floatingEl=null,overUnassignTray=!1,blockTouchScroll=te=>{te.cancelable&&te.preventDefault()};window.addEventListener("touchmove",blockTouchScroll,{passive:!1});let halfW=initialCircleRect.width/2,halfH=initialCircleRect.height/2,startDrag=(clientX,clientY)=>{started=!0,this.isDragging=!0,this.selectedNodeId=nodeId,document.body.classList.add("is-gate-dragging");let clone=circle.cloneNode(!0);clone.classList.add("gate-node-floating"),clone.style.setProperty("--c",item.style.getPropertyValue("--c")),clone.style.width=`${initialCircleRect.width}px`,clone.style.height=`${initialCircleRect.height}px`,clone.style.transform=`translate3d(${clientX-halfW}px, ${clientY-halfH}px, 0) scale(1.06)`,document.body.appendChild(clone),floatingEl=clone,item.classList.add("is-drop-slot")},onMove=ev=>{let dx=ev.clientX-startX,dy=ev.clientY-startY;if(!started){if(Math.hypot(dx,dy)<5)return;startDrag(ev.clientX,ev.clientY)}if(!floatingEl)return;if(ev.cancelable&&ev.preventDefault(),floatingEl.style.transform=`translate3d(${ev.clientX-halfW}px, ${ev.clientY-halfH}px, 0) scale(1.06)`,trayEl){let tr=trayEl.getBoundingClientRect(),insideTray=ev.clientX>=tr.left&&ev.clientX<=tr.right&&ev.clientY>=tr.top-8&&ev.clientY<=tr.bottom+8;if(overUnassignTray!==insideTray&&(overUnassignTray=insideTray,trayEl.classList.toggle("is-drop-active",overUnassignTray)),overUnassignTray)return}let parent=item.parentElement;if(!parent)return;let lineCenterY=initialCircleRect.top+halfH;if(Math.abs(ev.clientY-lineCenterY)>64)return;let centerX=ev.clientX,items=[...parent.querySelectorAll(".gate-line-item[data-gate]")],currentIdx=items.indexOf(item);for(let i=0;i<items.length;i++){let other=items[i];if(other===item)continue;let r=other.getBoundingClientRect(),mid=r.left+r.width/2;if(currentIdx<i&&centerX>mid){parent.insertBefore(item,other.nextElementSibling),this.syncLinePositionsInPlace();break}if(currentIdx>i&&centerX<mid){parent.insertBefore(item,other),this.syncLinePositionsInPlace();break}}},onEnd=()=>{window.removeEventListener("pointermove",onMove),window.removeEventListener("pointerup",onEnd),window.removeEventListener("pointercancel",onEnd),window.removeEventListener("touchmove",blockTouchScroll);try{item.hasPointerCapture(downEvent.pointerId)&&item.releasePointerCapture(downEvent.pointerId)}catch{}document.body.classList.remove("is-gate-dragging"),trayEl?.classList.remove("is-drop-active"),floatingEl&&(floatingEl.remove(),floatingEl=null),started?overUnassignTray?this.removeTrackNode(nodeId):(item.classList.remove("is-drop-slot"),this.commitDragOrder(nodeId)):(this.isDragging=!1,this.selectedNodeId!==nodeId&&(this.selectedNodeId=nodeId,this.render()))};window.addEventListener("pointermove",onMove),window.addEventListener("pointerup",onEnd),window.addEventListener("pointercancel",onEnd)}syncLinePositionsInPlace(){let items=[...this.el.querySelectorAll(".gate-line-item")],total=items.length;if(total===0)return;let lastColor=items[total-1]?.dataset.puckColor||"#64748b";items.forEach((item,idx)=>{let orderEl=item.querySelector(".gate-node-order");orderEl&&(orderEl.textContent=`#${idx+1}`);let c1=item.dataset.puckColor||"#64748b",c2=items[(idx+1)%total]?.dataset.puckColor||"#64748b",leadPill=item.querySelector(".gate-line-sec-pill.is-leading");if(leadPill){leadPill.style.setProperty("--c1",lastColor),leadPill.style.setProperty("--c2",c1);let leadCap=leadPill.querySelector(".sec-bicolor-capsule");leadCap&&(leadCap.style.setProperty("--c1",lastColor),leadCap.style.setProperty("--c2",c1));let leadText=leadPill.querySelector(".sec-pill-text")??leadPill;leadText.textContent=`S${total}`}let trailPill=item.querySelector(".gate-line-sec-pill.is-trailing");if(trailPill){trailPill.style.setProperty("--c1",c1),trailPill.style.setProperty("--c2",c2);let capsule=trailPill.querySelector(".sec-bicolor-capsule");capsule&&(capsule.style.setProperty("--c1",c1),capsule.style.setProperty("--c2",c2));let textEl=trailPill.querySelector(".sec-pill-text")??trailPill;textEl.textContent=`S${idx+1}`}})}async commitDragOrder(dragId){this.isDragging=!0;try{let newIndex=[...this.el.querySelectorAll(".gate-line-item[data-gate]")].findIndex(r=>Number(r.dataset.gate)===dragId),oldIndex=this.orderedNodes.findIndex(n=>n.puckId===dragId),node=this.store.puck(dragId);node&&newIndex>=0&&newIndex!==oldIndex&&await this.save(node,{trackOrder:newIndex})}finally{this.isDragging=!1,this.render()}}async save(node,change){await this.api.updateTrackNode({puckId:node.puckId,name:change.name??node.name,color:change.color??node.color,role:change.role??node.role,trackOrder:change.trackOrder,assignedPuckId:change.assignedPuckId})}};var SetupView=class extends Component{constructor(el,store,api,announcer){super(el),el.innerHTML=`
      <div class="settings">
        <section class="settings-section">
          <div class="settings-intro">
            <h2>Pilots &amp; channels</h2>
            <p>Eight timing slots, matching LiveTime. Channels are overwritten whenever LiveTime loads a heat.</p>
          </div>
          <div class="card card-flush" data-slot="pilots"></div>
        </section>

        <section class="settings-section">
          <div class="settings-intro">
            <h2>Timing rules</h2>
            <p>Filters out false passes and stray signals. Set rules for all gates, or pick a single gate to customize it.</p>
          </div>
          <div class="card card-flush" data-slot="rules"></div>
        </section>

        <section class="settings-section">
          <div class="settings-intro">
            <h2>Announcer</h2>
            <p>Spoken lap times at the start gate. Uses the voices built into this computer \u2014 no internet needed.</p>
          </div>
          <div class="card" data-slot="announcer"></div>
        </section>

        <section class="settings-section">
          <div class="settings-intro">
            <h2>MultiGP LiveTime</h2>
            <p>This app emulates an ImmersionRC LapRF 8-way timer, so LiveTime connects without plugins.</p>
          </div>
          <div class="card" data-slot="livetime"></div>
        </section>

        <section class="settings-section">
          <div class="settings-intro">
            <h2>Flasher</h2>
            <p>Plug each Seeed XIAO ESP32-C5 into this computer over USB and flash or read it directly from the browser \u2014 no compiler, drivers, or command line needed.</p>
          </div>
          <div class="card" data-slot="flasher"></div>
        </section>

        <section class="settings-section">
          <div class="settings-intro">
            <h2>Timers</h2>
            <p>Physical XIAO ESP32-C5 timers discovered over Wi-Fi / ESP-NOW or USB, showing their color, flashed ID, online status, role, RF noise floor, and battery health.</p>
          </div>
          <div class="card card-flush" data-slot="timers"></div>
        </section>

        <section class="settings-section">
          <div class="settings-intro">
            <h2>Track</h2>
            <p>Drag timers onto the track timeline in the order pilots fly them. Each stretch between two timers defines a section (S1, S2, S3\u2026), and clicking a node lets you name the gate or mark it as the start gate.</p>
          </div>
          <div class="card card-flush" data-slot="track"></div>
        </section>

        <section class="settings-section">
          <div class="settings-intro">
            <h2>Data source</h2>
            <p>Use the simulator to rehearse a race day before the hardware arrives.</p>
          </div>
          <div class="card" data-slot="source"></div>
        </section>
      </div>`,this.adopt(new PilotSlotsEditor(this.slot("pilots"),store,api)),this.adopt(new TimingRulesEditor(this.slot("rules"),store,api)),this.adopt(new AnnouncerSettings(this.slot("announcer"),announcer)),this.adopt(new LiveTimeCard(this.slot("livetime"),store)),this.adopt(new TimerFlasher(this.slot("flasher"),store,api)),this.adopt(new TimersList(this.slot("timers"),store,api)),this.adopt(new TrackEditor(this.slot("track"),store,api)),this.adopt(new DataSourceCard(this.slot("source"),store,api))}};function statusMeta(p){let remainingSec=p.stateRemainingSec,sec=remainingSec>0?` \xB7 ${Math.ceil(remainingSec)}s`:"";switch(p.status){case"FLYING":return{label:"Flying",badgeClass:"sim-status-flying",hint:"On track racing through gates"};case"AVOIDING":return{label:"Flying High",badgeClass:"sim-status-avoiding",hint:"Hovering or circling high above the course while a person is on the track \u2014 avoids flying through gates"};case"LANDING":return{label:`Landing${sec}`,badgeClass:"sim-status-pit",hint:"Heading back to the pit area and descending to land (5s) before disarming"};case"CRASHED_VTX_ON":return{label:`Crashed \xB7 VTX On${sec}`,badgeClass:"sim-status-crashed-vtx",hint:"Step 1: Down on track near gate with 5.8 GHz VTX still transmitting while pilot assesses crash"};case"TURTLE_RECOVERY":return{label:`Turtling${sec}`,badgeClass:"sim-status-crashed-wait",hint:"Step 2: Spinning motors in Turtle Mode (Crash Flip) trying to flip the inverted quad upright"};case"TURTLE_FAILED":return{label:`Turtle Failed${sec}`,badgeClass:"sim-status-crashed-vtx",hint:"Step 3: Turtle flip failed (prop stuck in grass/netting) \u2014 pilot disarms and switches VTX to Pit Mode"};case"CRASHED_WAITING_RECOVERY":return{label:"Wait for Lull",badgeClass:"sim-status-crashed-wait",hint:"Step 4: Quad stays crashed on the field (Pit Mode) until no pilots are flying \u2014 or click Walk recover to force an immediate track walk"};case"WALKING_RECOVERY":return{label:`Walking Out${sec}`,badgeClass:"sim-status-crashed-wait",hint:"Step 5: Pilot is walking or riding a Onewheel out onto the track to retrieve the crashed quad and return to the bench (30\u201360s)"};case"PIT_SWAP":return p.batteryPct===100?{label:`Arming${sec}`,badgeClass:"sim-status-pit",hint:"Fresh 100% 6S pack plugged in on launch pad \u2014 arming and taking off when track is clear"}:{label:`Pack Swap${sec}`,badgeClass:"sim-status-pit",hint:"Retrieving quad, unplugging spent LiPo, strapping fresh 6S pack at bench, and walking back to launch pad (30\u201360s)"};case"LAUNCH_HOLD":return{label:`Launch Hold${sec}`,badgeClass:"sim-status-charging",hint:"Ready on launch pad with 100% LiPo plugged in \u2014 holding launch with VTX off (to prevent VTX overheating) so crashed pilot can recover"};case"CHARGING_WAIT":return{label:`Charging${sec}`,badgeClass:"sim-status-charging",hint:"All 3 6S packs are depleted \u2014 waiting at the pit bench until a battery finishes charging to 100%"};case"PILOT_BREAK":return{label:`On Break${sec}`,badgeClass:"sim-status-paused",hint:"Pilot decided to take a breather at the bench while batteries charge on the field charger"};case"PAUSED":return{label:"Paused",badgeClass:"sim-status-paused",hint:"Parked on pit bench with VTX off until launched"}}}function formatDroneTagText(p){let sec=p.stateRemainingSec>0?` ${Math.ceil(p.stateRemainingSec)}s`:"";switch(p.status){case"AVOIDING":return"HIGH";case"LANDING":return`LAND${sec}`;case"CRASHED_VTX_ON":return`CRASH${sec}`;case"TURTLE_RECOVERY":return`TURTLE${sec}`;case"TURTLE_FAILED":return"TURTLE FAIL";case"CRASHED_WAITING_RECOVERY":return"WAIT LULL";case"WALKING_RECOVERY":return`WALK${sec}`;default:return""}}function isPilotInPits(status){return status==="PIT_SWAP"||status==="LAUNCH_HOLD"||status==="CHARGING_WAIT"||status==="PILOT_BREAK"||status==="PAUSED"}function formatPilotVtxText(p){return p.vtxActive?"TX ON (25mW)":p.status==="LAUNCH_HOLD"?"Off (VTX Cool)":"Pit / Off"}function formatPackStateChip(pack){switch(pack.state){case"IN_QUAD":return{html:`<span>PLG</span>${icons.plug(10)}`,cls:"is-in-quad"};case"READY":return{html:"<span>READY</span>",cls:"is-ready"};case"CHARGING":return{html:`<span>CHG</span>${icons.zap(10)}`,cls:"is-charging"}}}function formatPackTone(pack){return pack.state==="CHARGING"?"warn":pack.pct<=20?"bad":pack.pct<=45?"warn":"good"}function renderPilotPacksHtml(p){return(p.packs&&p.packs.length===3?p.packs:[{packIndex:1,pct:p.batteryPct,volts:p.batteryVolts,state:"IN_QUAD"},{packIndex:2,pct:100,volts:25.2,state:"READY"},{packIndex:3,pct:64,volts:23.7,state:"CHARGING"}]).map(pk=>{let chip=formatPackStateChip(pk),tone=formatPackTone(pk);return`
        <div class="sim-pack-slot ${pk.state==="IN_QUAD"?"is-active-pack":""}" data-pilot-pack-slot="${p.slotIndex}-${pk.packIndex}">
          <div class="sim-pack-head">
            <span class="sim-pack-title">Pack #${pk.packIndex}</span>
            <span class="sim-pack-chip ${chip.cls}" data-pilot-pack-chip="${p.slotIndex}-${pk.packIndex}">${chip.html}</span>
          </div>
          <div class="sim-pack-val mono" data-pilot-pack-val="${p.slotIndex}-${pk.packIndex}">
            <strong>${pk.pct}%</strong> \xB7 ${pk.volts.toFixed(1)}V
          </div>
          <div class="meter sim-pack-meter">
            <span class="meter-fill tone-${tone}" data-pilot-pack-bar="${p.slotIndex}-${pk.packIndex}" style="width:${Math.max(4,pk.pct)}%"></span>
          </div>
        </div>`}).join("")}var SimView=class extends Component{store;api;pollTimer=null;rafId=null;motionBySlot=new Map;lastCourseStructSig="";lastPilotsStructSig="";lastTimersSig="";addRole="spoke";addLabel="";addFwVersion=LATEST_FIRMWARE_VERSION;errorMsg="";constructor(el,store,api){super(el),this.store=store,this.api=api;let fwOptions=FIRMWARE_RELEASES.map(fw=>`<option value="${esc(fw.version)}" ${fw.version===this.addFwVersion?"selected":""}>${esc(fw.label)}</option>`).join("");el.innerHTML=`
      <div class="settings sim-settings">
        <section class="settings-section">
          <div class="settings-intro">
            <h2>Course &amp; pit lane</h2>
            <p>Live view of pilots moving through the track sections and pit bench. When someone walks onto the track to recover a quad, airborne pilots either return to the bench or fly high until the track is cleared.</p>
          </div>
          <div class="card card-flush" data-slot="course"></div>
        </section>

        <section class="settings-section">
          <div class="settings-intro">
            <h2>Pilots &amp; flight packs</h2>
            <p>Each pilot drains their 6S pack, lands in the pit area, unplugs the spent LiPo, walks back to the bench to strap on a fresh pack, sets the quad on the launch pad, plugs in, and takes off (30\u201360s turnaround).</p>
          </div>
          <div class="sim-pilots-column" data-slot="pilots"></div>
        </section>

        <section class="settings-section">
          <div class="settings-intro">
            <h2>Simulated timers</h2>
            <p>Virtual XIAO ESP32-C5 timers feeding the simulation engine. Power individual timers off to test offline gate behavior, delete timers, or provision new ones (up to 6).</p>
          </div>
          <div class="card card-flush">
            <div data-slot="timers-table"></div>
            <div class="sim-timer-add-bar">
              <div class="sim-timer-add-fields">
                <label class="sim-inline-field">
                  <span>Role</span>
                  <select class="input" data-field="timer-role">
                    <option value="spoke" selected>Spoke \xB7 Sector Timer</option>
                    <option value="hub">Hub \xB7 Start Bridge</option>
                  </select>
                </label>
                <label class="sim-inline-field">
                  <span>Timer ID / name</span>
                  <input type="text" class="input mono" data-field="timer-label" placeholder="e.g. T5 Tunnel Exit" value="" />
                </label>
                <label class="sim-inline-field">
                  <span>Firmware version</span>
                  <select class="input mono" data-field="timer-fw">
                    ${fwOptions}
                  </select>
                </label>
              </div>
              <button class="btn btn-armed" data-action="timer-add" data-slot="timer-add-btn">
                + Add simulated timer
              </button>
            </div>
          </div>
        </section>
      </div>`,el.addEventListener("click",this.handleClick),el.addEventListener("input",this.handleInput),el.addEventListener("change",this.handleChange),this.onDispose(()=>{el.removeEventListener("click",this.handleClick),el.removeEventListener("input",this.handleInput),el.removeEventListener("change",this.handleChange),this.pollTimer!==null&&window.clearInterval(this.pollTimer),this.rafId!==null&&window.cancelAnimationFrame(this.rafId)}),this.onDispose(store.subscribe(["status","config"],()=>this.render())),this.pollTimer=window.setInterval(()=>{!document.hidden&&this.store.simulatorRunning&&this.api.pollStatusNow()},250),this.render(),this.startSmoothAnimationLoop()}startSmoothAnimationLoop(){let tick=nowMs=>{this.updateDronePositionsSmoothly(nowMs),this.rafId=window.requestAnimationFrame(tick)};this.rafId=window.requestAnimationFrame(tick)}syncMotionFromSnapshot(pilots){let nowMs=performance.now(),activeSlots=new Set;for(let p of pilots){if(!p.enabled||p.channel<=0)continue;activeSlots.add(p.slotIndex);let baseRate=p.status==="FLYING"||p.status==="AVOIDING"||p.status==="LANDING"?p.speedMph*.44704/360:0,existing=this.motionBySlot.get(p.slotIndex);if(!existing||existing.status!==p.status){this.motionBySlot.set(p.slotIndex,{progress:p.trackProgress,speedProgPerSec:baseRate,status:p.status,lastTickMs:nowMs});continue}let err=p.trackProgress-existing.progress;err>.5&&(err-=1),err<-.5&&(err+=1),Math.abs(err)>.12||baseRate===0?(existing.progress=p.trackProgress,existing.speedProgPerSec=baseRate):existing.speedProgPerSec=Math.max(.01,baseRate+err*1.35),existing.status=p.status,existing.lastTickMs=nowMs}for(let slot of this.motionBySlot.keys())activeSlots.has(slot)||this.motionBySlot.delete(slot)}updateDronePositionsSmoothly(nowMs){let gateZeroOffset=.5/Math.max(1,this.store.pucks.length);this.motionBySlot.forEach((m,slotIndex)=>{let dtSec=Math.min(.08,Math.max(0,(nowMs-m.lastTickMs)/1e3));m.lastTickMs=nowMs,(m.status==="FLYING"||m.status==="AVOIDING"||m.status==="LANDING")&&(m.progress=(m.progress+m.speedProgPerSec*dtSec)%1,m.progress<0&&(m.progress+=1));let token=this.el.querySelector(`[data-drone-token="${slotIndex}"]`);if(token){let visualPct=(m.progress+gateZeroOffset)%1*100;token.style.left=`${visualPct.toFixed(2)}%`}})}handleInput=e=>{let target=e.target;target.dataset.field==="timer-label"&&(this.addLabel=target.value)};handleChange=e=>{let target=e.target;target.dataset.field==="timer-role"?this.addRole=target.value==="hub"?"hub":"spoke":target.dataset.field==="timer-fw"&&(this.addFwVersion=target.value)};handleClick=e=>{let btn=e.target.closest("[data-action]");if(!btn)return;switch(btn.dataset.action){case"toggle-walker":{let active=this.store.simState?.trackWalkerActive??!1;this.api.setTrackWalker(!active);break}case"pack-burst":this.api.simulatePack();break;case"launch-all":{let pilots=this.store.simState?.pilots??[];(async()=>{for(let p of pilots)p.enabled&&p.channel>0&&await this.api.simPilotAction(p.slotIndex,"refill-launch")})();break}case"pilot-cmd":{let slotIndex=Number(btn.dataset.slot),cmd=btn.dataset.cmd;Number.isFinite(slotIndex)&&cmd&&this.api.simPilotAction(slotIndex,cmd);break}case"timer-power":{let puckId=Number(btn.dataset.puckId);Number.isFinite(puckId)&&(this.errorMsg="",this.api.simTimerAction({action:"toggle-power",puckId}));break}case"timer-delete":{let puckId=Number(btn.dataset.puckId);Number.isFinite(puckId)&&(this.errorMsg="",this.api.simTimerAction({action:"delete",puckId}).catch(err=>{this.errorMsg=err instanceof Error?err.message:String(err),this.lastTimersSig="",this.renderTimers(this.store.simState)}));break}case"timer-add":{this.errorMsg="";let label=this.addLabel.trim();this.api.simTimerAction({action:"add",role:this.addRole,label,firmwareVersion:this.addFwVersion}).then(()=>{this.addLabel="";let input=this.el.querySelector('input[data-field="timer-label"]');input&&(input.value=""),this.lastTimersSig="",this.renderTimers(this.store.simState)}).catch(err=>{this.errorMsg=err instanceof Error?err.message:String(err),this.lastTimersSig="",this.renderTimers(this.store.simState)});break}}};render(){let simState=this.store.simState;this.syncMotionFromSnapshot(simState?.pilots??[]),this.renderCourse(simState),this.renderPilots(simState),this.renderTimers(simState)}get orderedNodes(){return[...this.store.pucks].sort((a,b)=>a.trackOrder-b.trackOrder)}renderCourse(simState){let walkerActive=simState?.trackWalkerActive??!1,walkerSec=simState?.trackWalkerSecLeft??0,pilots=(simState?.pilots??[]).filter(p=>p.enabled&&p.channel>0),nodes=this.orderedNodes,timersById=new Map((simState?.timers??[]).map(t=>[t.puckId,t])),onTrackPilots=pilots.filter(p=>!isPilotInPits(p.status)),pitPilots=pilots.filter(p=>isPilotInPits(p.status)),structSig=[walkerActive?"W1":"W0",nodes.map(n=>{let t=timersById.get(n.assignedPuckId);return`${n.puckId}:${n.assignedPuckId}:${n.name}:${n.role}:${t?.poweredOn?1:0}:${t?.color??""}`}).join(","),pilots.map(p=>`${p.slotIndex}:${p.callsign}:${p.color}:${p.status}`).join(",")].join("|");if(structSig!==this.lastCourseStructSig){this.lastCourseStructSig=structSig;let gateZeroOffset=.5/Math.max(1,nodes.length),nodesHtml=nodes.map((node,index)=>{let total=nodes.length,isStart=node.role==="START_FINISH",assignedId=node.assignedPuckId??0,hasTimer=assignedId>0,tiedTimer=timersById.get(assignedId),powered=tiedTimer?tiedTimer.poweredOn:!1,shortCode=hasTimer?`T${assignedId}`:"\u2014",roleSub=hasTimer?tiedTimer?.isHub||assignedId===1?"HUB":"SPK":"EMPTY",color=hasTimer?timerColor(this.store,assignedId):"#64748b",lastAssignedId=nodes[(total-1+total)%total]?.assignedPuckId??0,lastColor=lastAssignedId>0?timerColor(this.store,lastAssignedId):"#64748b",nextAssignedId=nodes[(index+1)%total]?.assignedPuckId??0,nextColor=nextAssignedId>0?timerColor(this.store,nextAssignedId):"#64748b",displayName=node.name.trim()||`Gate ${index+1}`,sectionTag=`S${index+1}`,wrapSectionTag=`S${total}`;return`
            <div
              class="gate-line-item sim-gate-node ${isStart?"is-start":""} ${hasTimer&&powered?"has-puck":"is-empty-gate"}"
              style="--c:${color}"
            >
              <div class="gate-line-track-seg is-before ${powered?"":"is-dashed-seg"}"></div>
              <div class="gate-line-track-seg is-after ${powered?"":"is-dashed-seg"}"></div>

              <span
                class="gate-line-sec-pill is-leading sec-id-badge mono"
                style="--c1:${lastColor};--c2:${color}"
              >
                ${renderSectionCapsuleIcon(lastColor,color)}
                <span class="sec-pill-text">${wrapSectionTag}</span>
              </span>

              <span
                class="gate-line-sec-pill is-trailing sec-id-badge mono"
                style="--c1:${color};--c2:${nextColor}"
              >
                ${renderSectionCapsuleIcon(color,nextColor)}
                <span class="sec-pill-text">${sectionTag}</span>
              </span>

              <div class="gate-node-top">
                <span class="gate-node-order mono">#${index+1}</span>
              </div>

              <div class="gate-node-circle ${hasTimer&&powered?"":"is-unassigned"}">
                <span class="gate-node-puck-code mono">${esc(shortCode)}</span>
                <span class="gate-node-puck-meta">
                  <span class="gate-node-status-dot ${powered?"is-online":""}"></span>
                  <span>${powered?roleSub:"OFF"}</span>
                </span>
              </div>

              <div class="gate-node-name">${esc(displayName)}</div>
              <span
                class="gate-node-start-btn ${isStart?"is-active":"is-placeholder-flag"}"
                ${isStart?'title="Start / Finish gate" aria-label="Start / Finish gate"':'aria-hidden="true"'}
              >${icons.checkered(13)}</span>
            </div>`}).join(""),dronesHtml=onTrackPilots.map(p=>{let m=this.motionBySlot.get(p.slotIndex),visualPct=((m?m.progress:p.trackProgress)+gateZeroOffset)%1*100,isAvoiding=p.status==="AVOIDING",isCrashedVtx=p.status==="CRASHED_VTX_ON"||p.status==="TURTLE_FAILED",isCrashedWait=p.status==="TURTLE_RECOVERY"||p.status==="CRASHED_WAITING_RECOVERY"||p.status==="WALKING_RECOVERY",tagText=formatDroneTagText(p);return`
            <div
              class="sim-drone-token ${isAvoiding?"is-avoiding":""} ${isCrashedVtx?"is-crashed-vtx":""} ${isCrashedWait?"is-crashed-wait":""}"
              data-drone-token="${p.slotIndex}"
              style="left:${visualPct.toFixed(2)}%;--c:${esc(p.color)}"
            >
              <span class="sim-drone-dot"></span>
              <span class="sim-drone-callsign">${esc(p.callsign)}</span>
              ${tagText?`<span class="sim-drone-tag ${isCrashedVtx?"is-bad":isCrashedWait?"is-warn":""}" data-drone-tag="${p.slotIndex}">${esc(tagText)}</span>`:""}
            </div>`}).join(""),pitTokensHtml=pitPilots.length>0?pitPilots.map(p=>`
              <div class="sim-pit-pill" style="--c:${esc(p.color)}">
                <span class="sim-drone-dot"></span>
                <span class="sim-drone-callsign">${esc(p.callsign)}</span>
              </div>`).join(""):'<span class="gate-unassigned-empty-chip">All active pilots are currently out on the track</span>';this.slot("course").innerHTML=`
        <div class="gate-track-stage sim-course-stage">
          <div class="gate-track-header sim-course-toolbar">
            <span class="gate-track-caption" data-course-caption>
              ${walkerActive?`\u26A0 Person on track (${Math.ceil(walkerSec)}s left) \u2014 airborne pilots land or circle high above the gates`:`60 fps live course timeline \xB7 drones cross #1 \u2192 #${nodes.length} and wrap around ${nodes.length>0?`S${nodes.length}`:"the loop"}`}
            </span>
            <div class="sim-course-actions">
              <button class="btn btn-sm ${walkerActive?"btn-danger-active":"btn-ghost"}" data-action="toggle-walker" ${walkerActive?"":"disabled"} title="End track walk recovery early and resume racing">
                ${icons.pilot(14)}
                <span>Clear track</span>
              </button>
              <button class="btn btn-sm btn-ghost" data-action="pack-burst" title="Bunch airborne pilots 150 ms apart approaching Gate #1">
                ${icons.zap(14)}<span>Pack burst</span>
              </button>
              <button class="btn btn-sm btn-ghost" data-action="launch-all" title="Refill all 6S batteries to 100% and launch all enabled pilots">
                ${icons.play(14)}<span>Refill &amp; launch all</span>
              </button>
            </div>
          </div>

          <div class="gate-track-scroll sim-track-scroll">
            <div class="sim-altitude-lane-label ${walkerActive?"is-walker-active":""}">
              <span data-corridor-label>${walkerActive?`ACTIVE FLIGHT CORRIDOR \xB7 PERSON ON TRACK (${Math.ceil(walkerSec)}s)`:"ACTIVE FLIGHT CORRIDOR"}</span>
            </div>
            <div class="sim-flight-corridor ${walkerActive?"is-walker-active":""}">
              <div class="sim-drone-track-layer">
                ${dronesHtml}
              </div>
            </div>

            <div class="gate-track-line sim-gate-track-line" role="list" aria-label="Simulated course gates">
              ${nodesHtml}
            </div>
          </div>

          <div class="sim-altitude-lane-label sim-pit-lane-label">
            <span data-pit-lane-label>PIT BENCH &amp; BATTERY SWAP LANE (${pitPilots.length})</span>
          </div>
          <div class="gate-unassigned-tray sim-pit-tray">
            <div class="gate-unassigned-list sim-pit-list">
              ${pitTokensHtml}
            </div>
          </div>
        </div>`}else{let corridorLabel=this.el.querySelector("[data-corridor-label]");corridorLabel&&walkerActive&&(corridorLabel.textContent=`ACTIVE FLIGHT CORRIDOR \xB7 PERSON ON TRACK (${Math.ceil(walkerSec)}s)`);let caption=this.el.querySelector("[data-course-caption]");caption&&walkerActive&&(caption.textContent=`\u26A0 Person on track (${Math.ceil(walkerSec)}s left) \u2014 airborne pilots land or circle high above the gates`);let pitLabel=this.el.querySelector("[data-pit-lane-label]");pitLabel&&(pitLabel.textContent=`PIT BENCH & BATTERY SWAP LANE (${pitPilots.length})`);for(let p of onTrackPilots){let tag=this.el.querySelector(`[data-drone-tag="${p.slotIndex}"]`);tag&&(tag.textContent=formatDroneTagText(p))}}}renderPilots(simState){let activePilots=(simState?.pilots??[]).filter(p=>p.enabled),structSig=activePilots.map(p=>`${p.slotIndex}:${p.callsign}:${p.color}:${p.channel}`).join("|");if(structSig!==this.lastPilotsStructSig){this.lastPilotsStructSig=structSig;let cards=activePilots.map(p=>{let meta=statusMeta(p),chBadge=p.channel>0?`R${p.channel} \xB7 ${p.frequencyMhz} MHz`:"No channel",isCrashed=p.status==="CRASHED_VTX_ON"||p.status==="TURTLE_RECOVERY"||p.status==="TURTLE_FAILED"||p.status==="CRASHED_WAITING_RECOVERY"||p.status==="WALKING_RECOVERY",isParked=isPilotInPits(p.status),isFlying=p.status==="FLYING"||p.status==="AVOIDING",isTurtleBusy=p.status==="TURTLE_RECOVERY"||p.status==="WALKING_RECOVERY",isWalkingOut=p.status==="WALKING_RECOVERY",canSwap=p.status!=="PIT_SWAP"&&p.status!=="CHARGING_WAIT"&&p.status!=="LANDING"&&!isCrashed;return`
            <div class="card sim-pilot-card ${isCrashed?"is-crashed":""}" data-pilot-card="${p.slotIndex}">
              <div class="sim-pilot-head">
                <div class="sim-pilot-id">
                  <span class="dot" style="--c:${esc(p.color)}"></span>
                  <span class="sim-pilot-name">${esc(p.callsign)}</span>
                  <span class="badge mono">${esc(chBadge)}</span>
                </div>
                <span class="sim-status-badge ${meta.badgeClass}" data-pilot-badge="${p.slotIndex}" title="${esc(meta.hint)}">${esc(meta.label)}</span>
              </div>

              <div class="sim-pilot-metrics">
                <div class="sim-packs-grid">
                  ${renderPilotPacksHtml(p)}
                </div>

                <div class="sim-telemetry-grid">
                  <div>
                    <div class="sim-stat-k">Speed</div>
                    <div class="sim-stat-v mono" data-pilot-speed="${p.slotIndex}">${p.speedMph.toFixed(0)} <span class="unit">mph</span></div>
                  </div>
                  <div>
                    <div class="sim-stat-k">Altitude</div>
                    <div class="sim-stat-v mono" data-pilot-alt="${p.slotIndex}">${p.altitudeMeters.toFixed(1)} <span class="unit">m</span></div>
                  </div>
                  <div>
                    <div class="sim-stat-k">5.8 GHz VTX</div>
                    <div class="sim-stat-v ${p.vtxActive?"tone-good":"muted"}" data-pilot-vtx="${p.slotIndex}">${formatPilotVtxText(p)}</div>
                  </div>
                  <div>
                    <div class="sim-stat-k">Nearest Gate</div>
                    <div class="sim-stat-v" data-pilot-loc="${p.slotIndex}">${p.status==="LANDING"?"Landing pad":p.status==="LAUNCH_HOLD"?"Launch pad":isParked?"Pit bench":esc(p.nearestGateLabel)}</div>
                  </div>
                  <div>
                    <div class="sim-stat-k">Packs / Crashes</div>
                    <div class="sim-stat-v mono" data-pilot-packs="${p.slotIndex}">#${p.packsFlown} \xB7 ${p.crashesCount} cr</div>
                  </div>
                </div>
              </div>

              <div class="sim-pilot-controls">
                <button class="btn btn-sm sim-ctrl-btn btn-ghost" data-action="pilot-cmd" data-slot="${p.slotIndex}" data-cmd="launch" data-pilot-btn="${p.slotIndex}-launch" ${isParked?"":"disabled"} title="Launch immediately with the battery currently attached to the quad (or best bench pack if unplugged)">
                  ${icons.play(12)}<span>Launch</span>
                </button>
                <button class="btn btn-sm sim-ctrl-btn btn-ghost" data-action="pilot-cmd" data-slot="${p.slotIndex}" data-cmd="pit" data-pilot-btn="${p.slotIndex}-pit" ${canSwap?"":"disabled"} title="Bring pilot into the pit bench to swap to a fresh 6S battery pack (30\u201360s)">
                  ${icons.reset(12)}<span>Swap pack</span>
                </button>
                <button class="btn btn-sm sim-ctrl-btn btn-ghost" data-action="pilot-cmd" data-slot="${p.slotIndex}" data-cmd="break" data-pilot-btn="${p.slotIndex}-break" ${isFlying?"":"disabled"} title="Land in the pits and rest at the bench while batteries charge">
                  ${icons.pause(12)}<span>Land</span>
                </button>
                <button class="btn btn-sm sim-ctrl-btn btn-ghost" data-action="pilot-cmd" data-slot="${p.slotIndex}" data-cmd="crash" data-pilot-btn="${p.slotIndex}-crash" ${isFlying?"":"disabled"} title="Force a mid-track crash near the closest gate (VTX stays on briefly)">
                  ${icons.zapOff(12)}<span>Force crash</span>
                </button>
                <button class="btn btn-sm sim-ctrl-btn btn-ghost" data-action="pilot-cmd" data-slot="${p.slotIndex}" data-cmd="recover" data-pilot-btn="${p.slotIndex}-recover" ${isCrashed&&!isTurtleBusy?"":"disabled"} title="Attempt Turtle Mode recovery (spins motors for 3.5s to flip upright and resume flying)">
                  ${icons.play(12)}<span>Turtle flip</span>
                </button>
                <button class="btn btn-sm sim-ctrl-btn btn-ghost" data-action="pilot-cmd" data-slot="${p.slotIndex}" data-cmd="walk-recover" data-pilot-btn="${p.slotIndex}-walk-recover" ${isCrashed&&!isWalkingOut?"":"disabled"} title="Force immediate track walk to retrieve the crashed quad \u2014 other drones will either land at the bench or fly high until clear">
                  ${icons.pilot(12)}<span>Walk recover</span>
                </button>
              </div>
            </div>`}).join("");this.slot("pilots").innerHTML=`
        <div class="sim-pilots-grid">
          ${cards||'<div class="card empty-note">No enabled pilots \u2014 enable pilots on the System tab to simulate their flights.</div>'}
        </div>`;return}for(let p of activePilots){let meta=statusMeta(p),isCrashed=p.status==="CRASHED_VTX_ON"||p.status==="TURTLE_RECOVERY"||p.status==="TURTLE_FAILED"||p.status==="CRASHED_WAITING_RECOVERY"||p.status==="WALKING_RECOVERY",isParked=isPilotInPits(p.status),isFlying=p.status==="FLYING"||p.status==="AVOIDING",isTurtleBusy=p.status==="TURTLE_RECOVERY"||p.status==="WALKING_RECOVERY",isWalkingOut=p.status==="WALKING_RECOVERY",canSwap=p.status!=="PIT_SWAP"&&p.status!=="CHARGING_WAIT"&&p.status!=="LANDING"&&!isCrashed,cardEl=this.el.querySelector(`[data-pilot-card="${p.slotIndex}"]`);cardEl&&(cardEl.className=`card sim-pilot-card ${isCrashed?"is-crashed":""}`);let badge=this.el.querySelector(`[data-pilot-badge="${p.slotIndex}"]`);badge&&(badge.textContent=meta.label,badge.className=`sim-status-badge ${meta.badgeClass}`,badge.title=meta.hint);for(let pk of p.packs??[]){let chip=formatPackStateChip(pk),tone=formatPackTone(pk),slotEl=this.el.querySelector(`[data-pilot-pack-slot="${p.slotIndex}-${pk.packIndex}"]`);slotEl&&(slotEl.className=`sim-pack-slot ${pk.state==="IN_QUAD"?"is-active-pack":""}`);let chipEl=this.el.querySelector(`[data-pilot-pack-chip="${p.slotIndex}-${pk.packIndex}"]`);chipEl&&(chipEl.innerHTML=chip.html,chipEl.className=`sim-pack-chip ${chip.cls}`);let valEl=this.el.querySelector(`[data-pilot-pack-val="${p.slotIndex}-${pk.packIndex}"]`);valEl&&(valEl.innerHTML=`<strong>${pk.pct}%</strong> \xB7 ${pk.volts.toFixed(1)}V`);let barEl=this.el.querySelector(`[data-pilot-pack-bar="${p.slotIndex}-${pk.packIndex}"]`);barEl&&(barEl.className=`meter-fill tone-${tone}`,barEl.style.width=`${Math.max(4,pk.pct)}%`)}let speedEl=this.el.querySelector(`[data-pilot-speed="${p.slotIndex}"]`);speedEl&&(speedEl.innerHTML=`${p.speedMph.toFixed(0)} <span class="unit">mph</span>`);let altEl=this.el.querySelector(`[data-pilot-alt="${p.slotIndex}"]`);altEl&&(altEl.innerHTML=`${p.altitudeMeters.toFixed(1)} <span class="unit">m</span>`);let vtxEl=this.el.querySelector(`[data-pilot-vtx="${p.slotIndex}"]`);vtxEl&&(vtxEl.textContent=formatPilotVtxText(p),vtxEl.className=`sim-stat-v ${p.vtxActive?"tone-good":"muted"}`);let locEl=this.el.querySelector(`[data-pilot-loc="${p.slotIndex}"]`);locEl&&(locEl.textContent=p.status==="LANDING"?"Landing pad":p.status==="LAUNCH_HOLD"?"Launch pad":isParked?"Pit bench":p.nearestGateLabel);let packsEl=this.el.querySelector(`[data-pilot-packs="${p.slotIndex}"]`);packsEl&&(packsEl.textContent=`#${p.packsFlown} \xB7 ${p.crashesCount} cr`);let launchBtn=this.el.querySelector(`[data-pilot-btn="${p.slotIndex}-launch"]`);launchBtn&&(launchBtn.disabled=!isParked);let pitBtn=this.el.querySelector(`[data-pilot-btn="${p.slotIndex}-pit"]`);pitBtn&&(pitBtn.disabled=!canSwap);let breakBtn=this.el.querySelector(`[data-pilot-btn="${p.slotIndex}-break"]`);breakBtn&&(breakBtn.disabled=!isFlying);let crashBtn=this.el.querySelector(`[data-pilot-btn="${p.slotIndex}-crash"]`);crashBtn&&(crashBtn.disabled=!isFlying);let recoverBtn=this.el.querySelector(`[data-pilot-btn="${p.slotIndex}-recover"]`);recoverBtn&&(recoverBtn.disabled=!isCrashed||isTurtleBusy);let walkBtn=this.el.querySelector(`[data-pilot-btn="${p.slotIndex}-walk-recover"]`);walkBtn&&(walkBtn.disabled=!isCrashed||isWalkingOut)}}renderTimers(simState){let timers=simState?.timers??[],canAdd=timers.length<6,sig=timers.map(t=>`${t.puckId}:${t.puckLabel}:${t.color}:${t.isHub?1:0}:${t.firmwareVersion}:${t.poweredOn?1:0}:${t.assignedGateName}`).join("|")+`|err:${this.errorMsg}`;if(sig===this.lastTimersSig)return;this.lastTimersSig=sig;let addBtn=this.slot("timer-add-btn");addBtn&&(addBtn.disabled=!canAdd);let rows=timers.map(t=>{let title=t.puckLabel?`T${t.puckId} \xB7 ${t.puckLabel}`:`T${t.puckId}`,color=timerColor(this.store,t.puckId),isLatestFw=t.firmwareVersion===LATEST_FIRMWARE_VERSION;return`
          <div class="puck-table-row sim-puck-table-row ${t.poweredOn?"":"is-offline"}">
            <div class="detected-puck-id">
              <span class="gate-color-swatch" style="--c:${esc(color)};cursor:default"></span>
              <strong class="mono">${esc(title)}</strong>
            </div>

            <div>
              <span class="puck-status-pill ${t.poweredOn?"is-online":"is-offline"}">
                <span class="status-dot ${t.poweredOn?"is-up":""}"></span>
                <span>${t.poweredOn?"Powered on":"Powered off"}</span>
              </span>
            </div>

            <div>
              <span class="detected-role-pill ${t.isHub?"is-hub":""}">${t.isHub?"Hub":"Spoke"}</span>
            </div>

            <div class="puck-fw-cell">
              <span class="mono">${esc(t.firmwareVersion)}</span>
              ${isLatestFw?'<span class="badge tone-good">Latest</span>':`<span class="badge tone-warn">Update \u2192 ${LATEST_FIRMWARE_VERSION}</span>`}
            </div>

            <div>
              ${t.assignedGateName?`<span>${esc(t.assignedGateName)}</span>`:'<span class="muted">Unassigned</span>'}
            </div>

            <div class="sim-timer-row-actions">
              <button class="btn btn-sm ${t.poweredOn?"btn-ghost":"btn-armed"}" data-action="timer-power" data-puck-id="${t.puckId}">
                ${t.poweredOn?"Turn off":"Turn on"}
              </button>
              <button class="btn btn-sm btn-ghost sim-btn-delete" data-action="timer-delete" data-puck-id="${t.puckId}" title="Delete simulated timer T${t.puckId}">
                Delete
              </button>
            </div>
          </div>`}).join("");this.slot("timers-table").innerHTML=`
      ${this.errorMsg?`<div class="sim-error-note">${esc(this.errorMsg)}</div>`:""}
      <div class="table-scroll">
        <div class="slot-table puck-table">
          <div class="puck-table-row sim-puck-table-row puck-table-head">
            <span>Timer</span>
            <span>Power</span>
            <span>Role</span>
            <span>Firmware</span>
            <span>Assigned gate</span>
            <span class="num">Actions</span>
          </div>
          ${rows}
        </div>
      </div>`}};var Sidebar=class extends Component{store;constructor(el,store,router){super(el),this.store=store,el.innerHTML=`
      <div class="brand">
        <div class="brand-mark">${icons.slaprf(25)}</div>
        <div>
          <div class="brand-name">SlapRF</div>
          <div class="brand-sub">XIAO ESP32-C5 \xB7 5.8 GHz</div>
        </div>
      </div>
      <nav class="nav nav-flat">
        ${ROUTES.map(r=>`<a class="nav-item" href="#/${r.id}" data-route="${r.id}" ${r.simOnly?'data-sim-only="1"':""}>${r.icon()}<span>${r.label}</span></a>`).join("")}
      </nav>`,this.highlight(router.route),this.onDispose(router.subscribe(route=>this.highlight(route))),this.onDispose(store.subscribe(["status"],()=>{this.syncSimNav()})),this.syncSimNav()}syncSimNav(){let simOn=this.store.simulatorRunning;this.el.querySelectorAll("[data-sim-only]").forEach(a=>{a.style.display=simOn?"":"none"})}highlight(route){this.el.querySelectorAll("[data-route]").forEach(a=>{let active=a.dataset.route===route;a.classList.toggle("is-active",active),active?a.setAttribute("aria-current","page"):a.removeAttribute("aria-current")})}};var TopBar=class extends Component{store;api;router;announcer;lastSig="";resetFlashActive=!1;resetFlashTimer=null;menuOpen=!1;constructor(el,store,api,router,announcer){super(el),this.store=store,this.api=api,this.router=router,this.announcer=announcer,el.addEventListener("click",this.handleClick),document.addEventListener("pointerdown",this.handleOutsidePointer,!0),document.addEventListener("keydown",this.handleKeyDown),this.onDispose(()=>{el.removeEventListener("click",this.handleClick),document.removeEventListener("pointerdown",this.handleOutsidePointer,!0),document.removeEventListener("keydown",this.handleKeyDown),this.resetFlashTimer!==null&&window.clearTimeout(this.resetFlashTimer)}),this.onDispose(router.subscribe(()=>{this.menuOpen=!1,this.render()})),this.onDispose(store.subscribe(["status"],()=>this.render())),this.onDispose(announcer.subscribe(()=>this.render())),this.render()}handleOutsidePointer=e=>{if(!this.menuOpen)return;let t=e.target;t&&this.el.contains(t)||(this.menuOpen=!1,this.render())};handleKeyDown=e=>{e.key==="Escape"&&this.menuOpen&&(this.menuOpen=!1,this.render())};handleClick=e=>{let target=e.target;if(target.closest("[data-nav-item]")){this.menuOpen=!1,this.render();return}switch(target.closest("[data-action]")?.dataset.action){case"menu":this.menuOpen=!this.menuOpen,this.render();break;case"sim":this.api.toggleSimulator();break;case"announcer":this.announcer.update({enabled:!this.announcer.settings.enabled});break;case"arm":if(this.store.liveTime.connectedClients>0)return;this.api.toggleArmed();break;case"pack":this.api.simulatePack();break;case"reset":confirm("Clear all laps for this session?")&&(this.flashResetButton(),this.api.resetSession());break}};flashResetButton(){this.resetFlashActive=!0,this.render(),this.resetFlashTimer!==null&&window.clearTimeout(this.resetFlashTimer),this.resetFlashTimer=window.setTimeout(()=>{this.resetFlashTimer=null,this.resetFlashActive=!1,this.render()},350)}render(){let meta=this.router.meta(),{liveTime,raceArmed,simulatorRunning:sim}=this.store,ltConnected=liveTime.connectedClients>0,voiceOn=this.announcer.settings.enabled,sig=`${meta.id}:${sim?1:0}:${raceArmed?1:0}:${voiceOn?1:0}:${ltConnected?1:0}:${this.resetFlashActive?1:0}:${this.menuOpen?1:0}`;if(sig===this.lastSig)return;this.lastSig=sig;let simBtn=`
      <button class="btn ${sim?"btn-armed":"btn-ghost"}" data-action="sim" title="${sim?"Switch to real-world hardware dataset":"Switch to simulated track dataset"}" aria-label="${sim?"Switch to real-world hardware dataset":"Switch to simulated track dataset"}">
        ${sim?icons.zap(19):icons.zapOff(19)}<span class="topbar-btn-label">${sim?"Simulation on":"Simulation off"}</span>
      </button>`,resetBtn=`
      <button class="btn ${this.resetFlashActive?"btn-armed":"btn-ghost"}" data-action="reset" title="Clear session laps" aria-label="Clear session laps">
        ${icons.reset(19)}<span class="topbar-btn-label">Reset laps</span>
      </button>`,actions=simBtn;if(meta.id==="live"||meta.id==="sim"){let armTitle=ltConnected?`Timing is controlled by MultiGP LiveTime (${raceArmed?"currently armed":"currently disarmed"})`:`${raceArmed?"Pause":"Resume"} lap timing`;actions+=`
        <button class="btn ${voiceOn?"btn-armed":"btn-ghost"}" data-action="announcer" title="${voiceOn?"Mute":"Enable"} lap-time callouts" aria-label="${voiceOn?"Mute":"Enable"} lap-time callouts">
          ${voiceOn?icons.speaker(19):icons.speakerOff(19)}<span class="topbar-btn-label">Announcer</span>
        </button>
        <button class="btn ${raceArmed?"btn-armed":"btn-ghost"}" data-action="arm" ${ltConnected?"disabled":""} title="${armTitle}" aria-label="${armTitle}">
          ${raceArmed?icons.timer(19):icons.timerOff(19)}<span class="topbar-btn-label">${raceArmed?"Timing on":"Timing off"}</span>
        </button>
        ${resetBtn}`}else meta.id==="pilot"&&(actions+=resetBtn);let navItems=ROUTES.filter(r=>!r.simOnly||sim).map(r=>{let active=r.id===meta.id;return`<a class="nav-item ${active?"is-active":""}" href="#/${r.id}" data-nav-item="${r.id}" ${active?'aria-current="page"':""}>${r.icon()}<span>${r.label}</span></a>`}).join("");this.el.innerHTML=`
      <div class="topbar-left">
        <div class="topbar-menu-wrap">
          <button class="btn btn-ghost topbar-menu-btn ${this.menuOpen?"is-open":""}" data-action="menu" type="button" aria-label="Open navigation menu" aria-expanded="${this.menuOpen?"true":"false"}">
            ${this.menuOpen?icons.close(20):icons.menu(20)}
          </button>
          ${this.menuOpen?`<div class="topbar-nav-popover" role="menu" aria-label="Main navigation">
                  <div class="brand">
                    <div class="brand-mark">${icons.slaprf(25)}</div>
                    <div>
                      <div class="brand-name">SlapRF</div>
                      <div class="brand-sub">XIAO ESP32-C5 \xB7 5.8 GHz</div>
                    </div>
                  </div>
                  <nav class="nav">${navItems}</nav>
                </div>`:""}
        </div>
        <div class="topbar-title">
          <h1>${meta.title}</h1>
          <p>${meta.subtitle}</p>
        </div>
      </div>
      <div class="topbar-actions">${actions}</div>`}};var AppShell=class extends Component{store;api;router;announcer;view=null;constructor(el,store,api,router,announcer){super(el),this.store=store,this.api=api,this.router=router,this.announcer=announcer,el.innerHTML=`
      <aside class="sidebar" data-slot="sidebar"></aside>
      <div class="main">
        <header class="topbar" data-slot="topbar"></header>
        <main class="outlet" data-slot="outlet"></main>
      </div>`,this.adopt(new Sidebar(this.slot("sidebar"),store,router)),this.adopt(new TopBar(this.slot("topbar"),store,api,router,announcer)),this.onDispose(router.subscribe(route=>this.show(route))),this.onDispose(store.subscribe(["status"],()=>{!this.store.simulatorRunning&&this.router.route==="sim"&&this.router.navigate("live")})),this.onDispose(()=>this.view?.destroy()),this.show(router.route)}show(route){if(route==="sim"&&!this.store.simulatorRunning){this.router.navigate("live");return}this.view?.destroy();let outlet=this.slot("outlet");outlet.replaceChildren();let host=document.createElement("div");host.className=`view view-${route}`,outlet.appendChild(host),this.view=this.createView(route,host),window.scrollTo({top:0})}createView(route,host){switch(route){case"live":return new LiveView(host,this.store,this.api);case"pilot":return new PilotView(host,this.store);case"sim":return new SimView(host,this.store,this.api);case"setup":return new SetupView(host,this.store,this.api,this.announcer)}}};var STORAGE_KEY="gate-timer.announcer",PREFERRED_DEFAULT_VOICE="Google US English",DEFAULT_PREFS={enabled:!1,keepScreenAwake:!0,voiceURI:PREFERRED_DEFAULT_VOICE,rate:1,volume:1,testPhrase:""},STALE_AFTER_MS=8e3,AFTER_CANCEL_MS=120,BETWEEN_CALLOUTS_MS=80,KEEP_AWAKE_GAIN=1e-4,IDLE_EASTER_EGG_QUIPS=["I am a member!","Who crashed now...?","Is the track clear?","The geese don't even flinch anymore.","Those geese have more track time than we do."],IDLE_MIN_MS=3*6e4,IDLE_MAX_MS=7*6e4;function spokenName(callsign){let s=callsign.trim();return!s||s!==s.toUpperCase()?s:s.charAt(0).toUpperCase()+s.slice(1).toLowerCase()}function lapCallout(callsign,lapTimeSec){let formatted=lapTimeSec.toFixed(2).replace(/\.?0+$/,"");return`${spokenName(callsign)}, ${formatted}`}var Announcer=class{piper;store;prefs;listeners=new Set;queue=[];current=null;neuralSpeaking=!1;utteranceToken=0;holdUntil=0;holdTimer=0;idleTimer=0;quipSpokenInCurrentLull=!1;lastQuipIdx=-1;lastSimMode=null;lastRaceArmed=null;keepAwake=null;constructor(store){if(this.store=store,this.prefs=loadPrefs(),setWakeLockEnabled(this.prefs.keepScreenAwake!==!1),this.piper=new PiperNeuralTts(()=>this.notify()),store.onLapRecorded(lap=>this.onLap(lap)),store.onStartGateDetected(ev=>this.onStartPass(ev)),store.subscribe(["crossings"],()=>{this.quipSpokenInCurrentLull=!1,this.resetIdleTimer()}),store.subscribe(["status"],()=>{let simChanged=this.lastSimMode!==null&&this.lastSimMode!==this.store.simulatorRunning,armedChanged=this.lastRaceArmed!==null&&this.lastRaceArmed!==this.store.raceArmed;simChanged&&this.clear(),this.lastSimMode=this.store.simulatorRunning,this.lastRaceArmed=this.store.raceArmed,(simChanged||armedChanged)&&this.resetIdleTimer()}),"speechSynthesis"in window){speechSynthesis.addEventListener("voiceschanged",()=>this.notify()),speechSynthesis.getVoices();let polls=0,pollId=window.setInterval(()=>{polls++,(speechSynthesis.getVoices().some(v=>!v.localService)||polls>=10)&&(window.clearInterval(pollId),this.notify())},300)}}get supported(){return!0}get settings(){return this.prefs}voices(){if(!("speechSynthesis"in window))return[];let all=speechSynthesis.getVoices(),english=all.filter(v=>/^en(?:[-_]|$)/i.test(v.lang));return english.length>0?english:all}piperVoices(){return PIPER_VOICES}activeVoiceURI(){if(isPiperVoiceURI(this.prefs.voiceURI))return getPiperVoice(this.prefs.voiceURI).uri;let list=this.voices();if(this.prefs.voiceURI==="system"&&list.length>0)return"system";let targetURI=this.prefs.voiceURI||PREFERRED_DEFAULT_VOICE,match=list.find(v=>v.voiceURI===targetURI)??list.find(v=>v.name.toLowerCase()===targetURI.toLowerCase()),online=typeof navigator>"u"?!0:navigator.onLine!==!1;return match&&(match.localService||online)?match.voiceURI:DEFAULT_PIPER_VOICE_URI}resolveVoice(){let list=this.voices();if(list.length!==0){if(this.prefs.voiceURI&&this.prefs.voiceURI!=="system"){let targetURI=this.prefs.voiceURI,match=list.find(v=>v.voiceURI===targetURI)??list.find(v=>v.name.toLowerCase()===targetURI.toLowerCase()),online=typeof navigator>"u"?!0:navigator.onLine!==!1;if(match&&(match.localService||online))return match}return list.find(v=>v.default&&/^en/i.test(v.lang))??list.find(v=>v.localService&&/^en[-_]US/i.test(v.lang))??list.find(v=>/^en/i.test(v.lang))??list[0]}}update(next){let wasEnabled=this.prefs.enabled;this.prefs={...this.prefs,...next},localStorage.setItem(STORAGE_KEY,JSON.stringify(this.prefs)),next.keepScreenAwake!==void 0&&setWakeLockEnabled(this.prefs.keepScreenAwake!==!1);let activeURI=this.activeVoiceURI();isPiperVoiceURI(activeURI)&&(this.prefs.enabled||next.voiceURI!==void 0)&&this.piper.preloadVoice(activeURI).catch(()=>{}),!wasEnabled&&this.prefs.enabled&&(this.wakeAudio(),this.say("Announcer on")),wasEnabled&&!this.prefs.enabled&&this.say("Announcer off",!0,!0),this.resetIdleTimer(),this.notify()}subscribe(fn){return this.listeners.add(fn),()=>this.listeners.delete(fn)}defaultTestPhrase(){let pilot=this.store.enabledPilots[0];return lapCallout(pilot?.callsign??"Vanover",14.08)}test(customPhrase){this.wakeAudio(),customPhrase!==void 0&&(this.prefs={...this.prefs,testPhrase:customPhrase},localStorage.setItem(STORAGE_KEY,JSON.stringify(this.prefs)));let raw=(customPhrase??this.prefs.testPhrase??"").trim();this.say(raw||this.defaultTestPhrase(),!0,!0)}onLap(lap){let callsign=this.store.pilot(lap.slotIndex)?.callsign??lap.callsign;this.say(lapCallout(callsign,lap.lapTimeSec),!1,!1,lap.slotIndex)}onStartPass(ev){let callsign=this.store.pilot(ev.slotIndex)?.callsign??ev.callsign;this.say(spokenName(callsign),!1,!1,ev.slotIndex)}say(text,interrupt=!1,force=!1,slotIndex){!this.prefs.enabled&&!force||!this.supported||(interrupt&&this.clear(),slotIndex!==void 0&&(this.queue=this.queue.filter(item=>item.slotIndex!==slotIndex)),this.queue.push({text,queuedAt:Date.now(),slotIndex}),this.resetIdleTimer(),this.pump())}resetIdleTimer(){if(window.clearTimeout(this.idleTimer),this.idleTimer=0,!this.prefs.enabled||!this.store.raceArmed||!this.supported||this.quipSpokenInCurrentLull)return;let delayMs=IDLE_MIN_MS+Math.floor(Math.random()*(IDLE_MAX_MS-IDLE_MIN_MS));this.idleTimer=window.setTimeout(()=>this.speakIdleQuip(),delayMs)}speakIdleQuip(){if(this.idleTimer=0,!this.prefs.enabled||!this.store.raceArmed||!this.supported||this.quipSpokenInCurrentLull)return;this.quipSpokenInCurrentLull=!0;let idx=Math.floor(Math.random()*IDLE_EASTER_EGG_QUIPS.length);IDLE_EASTER_EGG_QUIPS.length>1&&idx===this.lastQuipIdx&&(idx=(idx+1)%IDLE_EASTER_EGG_QUIPS.length),this.lastQuipIdx=idx,this.say(IDLE_EASTER_EGG_QUIPS[idx])}clear(){this.queue=[],this.current=null,this.neuralSpeaking=!1,this.utteranceToken++,this.piper.stop(),"speechSynthesis"in window&&(speechSynthesis.speaking||speechSynthesis.pending)&&(speechSynthesis.cancel(),this.holdUntil=Date.now()+AFTER_CANCEL_MS)}pump(){if(this.current||this.neuralSpeaking)return;let wait=this.holdUntil-Date.now();if(wait>0){window.clearTimeout(this.holdTimer),this.holdTimer=window.setTimeout(()=>this.pump(),wait);return}let next=this.queue.shift();for(;next&&Date.now()-next.queuedAt>STALE_AFTER_MS;)next=this.queue.shift();if(!next)return;this.wakeAudio();let activeURI=this.activeVoiceURI();if(isPiperVoiceURI(activeURI)&&this.keepAwake){let token=++this.utteranceToken;this.neuralSpeaking=!0;let finishNeural=()=>{if(this.utteranceToken===token){if(this.neuralSpeaking=!1,!this.prefs.enabled&&this.queue.length===0){this.sleepAudio();return}this.holdUntil=Date.now()+BETWEEN_CALLOUTS_MS,this.pump()}};this.piper.speak(next.text,activeURI,this.prefs.rate,this.prefs.volume,this.keepAwake,next.queuedAt,STALE_AFTER_MS).then(finishNeural).catch(()=>{this.utteranceToken===token&&(this.neuralSpeaking=!1,Date.now()-next.queuedAt<=STALE_AFTER_MS?this.speakBrowserUtterance(next.text):this.pump())});return}this.speakBrowserUtterance(next.text)}speakBrowserUtterance(text){if(!("speechSynthesis"in window))return;let cleaned=text.replace(/\b(\d+)\.00\b/g,"$1").replace(/\b(\d+)\.([1-9])0\b/g,"$1.$2"),utterance=new SpeechSynthesisUtterance(cleaned),voice=this.resolveVoice();voice&&(utterance.voice=voice,voice.lang&&(utterance.lang=voice.lang)),utterance.rate=this.prefs.rate,utterance.volume=this.prefs.volume;let done=()=>{if(this.current===utterance){if(this.current=null,!this.prefs.enabled&&this.queue.length===0){this.sleepAudio();return}this.holdUntil=Date.now()+BETWEEN_CALLOUTS_MS,this.pump()}};utterance.onend=done,utterance.onerror=done,this.current=utterance,speechSynthesis.speak(utterance)}notify(){this.listeners.forEach(fn=>fn())}wakeAudio(){let Ctx=window.AudioContext??window.webkitAudioContext;if(Ctx){if(!this.keepAwake){let ctx=new Ctx,tone=ctx.createOscillator(),gain=ctx.createGain();tone.frequency.value=440,gain.gain.value=KEEP_AWAKE_GAIN,tone.connect(gain).connect(ctx.destination),tone.start(),this.keepAwake=ctx}this.keepAwake.resume()}}sleepAudio(){this.keepAwake?.suspend()}};function loadPrefs(){try{let raw=localStorage.getItem(STORAGE_KEY);return raw?{...DEFAULT_PREFS,...JSON.parse(raw),enabled:!1}:{...DEFAULT_PREFS}}catch{return{...DEFAULT_PREFS}}}var RECONNECT_MS=1500,RACEBAND_MHZ2=[5658,5695,5732,5769,5806,5843,5880,5917],PILOT_COLORS=["#ef4444","#3b82f6","#10b981","#f59e0b","#a855f7","#06b6d4","#ec4899","#84cc16"],GATE_COLORS=["#d4ff3a","#38bdf8","#f472b6","#fb923c","#a78bfa","#2dd4bf","#facc15","#f87171"],HttpRealTransport=class{source=null;onEnvelope=null;reconnectTimer=null;backendAvailable=!0;fallbackPilots=[1,3,5,8,0,0,0,0].map((ch,i)=>({slotIndex:i+1,callsign:`Pilot ${i+1}`,enabled:i<4,band:1,channel:ch,frequencyMhz:ch>0?RACEBAND_MHZ2[ch-1]:0,enterThreshold:-58,exitThreshold:-68,attenuationGain:52,color:PILOT_COLORS[i]}));fallbackPucks=[];fallbackRules={minLapSec:5,maxLapSec:120,gateCooldownSec:2,minSectionSec:.5,echoWindowSec:3};fallbackArmed=!0;async request(method,url,body){try{let res=await fetch(url,{method,headers:body?{"Content-Type":"application/json"}:void 0,body:body?JSON.stringify(body):void 0});if(!res.ok)throw new Error(`${method} ${url} failed: ${res.status}`);let data=await res.json();if((url==="/api/state"||url==="/api/status")&&data&&data.simulatorRunning===!0){let switched=await fetch("/api/sim/toggle",{method:"POST"});if(switched.ok){let stateData=await switched.json();return this.backendAvailable=!0,stateData}}return this.backendAvailable=!0,data}catch{return this.backendAvailable=!1,this.handleOfflineFallback(method,url,body)}}async fetchFirmwareImage(role,puckLabel,wifiSSID,wifiPass,firmwareVersion="v0.1.4"){let params=new URLSearchParams({role,version:firmwareVersion});puckLabel.trim()&&params.set("label",puckLabel.trim()),role==="hub"&&wifiSSID.trim()&&(params.set("ssid",wifiSSID.trim()),params.set("pass",wifiPass));let res=await fetch(`/api/firmware/xiao-c5.bin?${params.toString()}`,{cache:"no-store"});if(!res.ok)throw new Error(`Firmware build failed: ${res.status}`);let buf=await res.arrayBuffer(),sha256=res.headers.get("X-SlapRF-SHA256")??"",slug=puckLabel.trim()?puckLabel.trim().replace(/[^a-zA-Z0-9_-]+/g,"-"):role;return{bytes:new Uint8Array(buf),sha256,filename:`slaprf-xiao-c5-${slug}-${firmwareVersion}.bin`}}connectStream(onEnvelope){this.onEnvelope=onEnvelope,this.openEventSource()}openEventSource(){if(this.source?.close(),!this.onEnvelope)return;let es=new EventSource("/api/stream");this.source=es,es.onmessage=evt=>{if(this.onEnvelope)try{this.onEnvelope(JSON.parse(evt.data))}catch(err){console.error("[HttpRealTransport] stream parse error:",err)}},es.onerror=()=>{es.close(),!(!this.onEnvelope||!this.backendAvailable)&&(this.reconnectTimer=window.setTimeout(()=>{this.onEnvelope&&this.openEventSource()},RECONNECT_MS))}}disconnectStream(){this.onEnvelope=null,this.reconnectTimer!==null&&(window.clearTimeout(this.reconnectTimer),this.reconnectTimer=null),this.source?.close(),this.source=null}handleOfflineFallback(_method,url,body){if(url==="/api/timing/toggle-arm")return this.fallbackArmed=!this.fallbackArmed,this.offlineStatus();if(url==="/api/status")return this.offlineStatus();if(url==="/api/rules")return body&&(this.fallbackRules={...this.fallbackRules,...body}),{...this.fallbackRules};if(url==="/api/pilots/update"&&body){let upd=body,idx=this.fallbackPilots.findIndex(p=>p.slotIndex===upd.slotIndex);if(idx>=0){let wasEnabled=this.fallbackPilots[idx].enabled,next={...this.fallbackPilots[idx],...upd};if(next.frequencyMhz=next.channel>=1&&next.channel<=8?RACEBAND_MHZ2[next.channel-1]:0,next.enabled){let otherEnabled=this.fallbackPilots.filter((p,i)=>i!==idx&&p.enabled);otherEnabled.length>=8?next.enabled=!1:next.channel>0&&otherEnabled.some(p=>p.channel===next.channel)&&(wasEnabled?this.fallbackPilots.forEach((p,i)=>{i!==idx&&p.enabled&&p.channel===next.channel&&(p.channel=0,p.frequencyMhz=0)}):(next.channel=0,next.frequencyMhz=0))}this.fallbackPilots[idx]=next}}else if(url==="/api/thresholds"&&Array.isArray(body))for(let u of body){let puck=this.fallbackPucks.find(p=>p.puckId===u.puckId),pos=this.fallbackPilots.findIndex(p=>p.slotIndex===u.slotIndex);puck&&pos>=0&&(puck.enterThresholds[pos]=u.enterDbm)}else if((url==="/api/gates/rules"||url==="/api/track/rules")&&body){let b=body,puck=this.fallbackPucks.find(p=>p.puckId===b.puckId);puck&&(puck.ruleOverrides={...b.overrides})}else if((url==="/api/track/update"||url==="/api/gates/update")&&body){let u=body,puck=this.fallbackPucks.find(p=>p.puckId===u.puckId);puck&&(u.name!==void 0&&(puck.name=u.name),u.role==="START_FINISH"&&this.fallbackPucks.forEach(p=>p.role=p.puckId===puck.puckId?"START_FINISH":"SECTOR_GATE"))}else if(url==="/api/track/add"||url==="/api/gates/add"){let b=body??{},nextId=this.fallbackPucks.length+1;nextId<=6&&this.fallbackPucks.push({puckId:nextId,assignedPuckId:b.assignedPuckId??0,puckLabel:"",name:b.name??"",color:GATE_COLORS[(nextId-1)%GATE_COLORS.length],role:this.fallbackPucks.length===0?"START_FINISH":"SECTOR_GATE",trackOrder:this.fallbackPucks.length,mapX:.5,mapY:.5,batteryMv:0,batteryPct:0,noiseFloorDbm:-92,lastRssi:[-92,-92,-92,-92,-92,-92,-92,-92],enterThresholds:[0,0,0,0,0,0,0,0],ruleOverrides:{},online:!1,lastSeenAt:"",framesRxCount:0})}else if((url==="/api/track/remove"||url==="/api/gates/remove")&&body){let b=body;this.fallbackPucks=this.fallbackPucks.filter(p=>p.puckId!==b.puckId)}else if(url==="/api/wifi/networks")return{networks:[]};return this.offlineState()}offlineStatus(){return{serverTimestampUs:0,pucks:this.fallbackPucks.map(p=>({...p})),detectedPucks:[],simulatorRunning:!1,raceArmed:this.fallbackArmed,liveTimeStatus:{listenAddr:":5403",connectedClients:0,detectionsSent:0,statusFramesSent:0,lastRfSetupSync:"",raceArmedByHost:this.fallbackArmed}}}offlineState(){return{...this.offlineStatus(),pilots:this.fallbackPilots.map(p=>({...p})),laps:[],crossings:[],filtered:[],summaries:[],rules:{...this.fallbackRules}}}};var WasmSimTransport=class{readyPromise=null;streamCallback=null;ensureReady(){return window.slaprfWasm?Promise.resolve(window.slaprfWasm):this.readyPromise?this.readyPromise:(this.readyPromise=this.bootWasm().catch(err=>{throw this.readyPromise=null,err}),this.readyPromise)}async bootWasm(){window.__slaprfBootStatus?.("Loading WebAssembly runtime\u2026",18),window.Go||await new Promise((resolve,reject)=>{let script=document.createElement("script");script.src="./wasm/wasm_exec.js?v=44",script.onload=()=>resolve(),script.onerror=()=>reject(new Error("Failed to load ./wasm/wasm_exec.js")),document.head.appendChild(script)}),window.__slaprfBootStatus?.("Downloading SlapRF 5.8 GHz timing engine\u2026",28);let go=new window.Go,wasmUrl="./wasm/slaprf.wasm?v=44",response=await fetch(wasmUrl);if(!response.ok)throw new Error(`Failed to fetch ${wasmUrl} (${response.status})`);let contentLength=Number(response.headers.get("Content-Length")??0),expectedTotal=contentLength>0?contentLength:8224489,wasmBuffer;if(response.body&&typeof response.body.getReader=="function"){let reader=response.body.getReader(),chunks=[],loaded=0;for(;;){let{done,value}=await reader.read();if(done)break;if(value){chunks.push(value),loaded+=value.byteLength;let dlRatio=Math.min(1,loaded/expectedTotal),pct=Math.round(28+dlRatio*48),mb=(loaded/(1024*1024)).toFixed(1);window.__slaprfBootStatus?.(`Downloading 5.8 GHz timing engine (${mb} MB)\u2026`,pct)}}let combined=new Uint8Array(loaded),offset=0;for(let c of chunks)combined.set(c,offset),offset+=c.byteLength;wasmBuffer=combined.buffer}else wasmBuffer=await response.arrayBuffer();window.__slaprfBootStatus?.("Compiling WebAssembly & pre-warming track simulator\u2026",82),await new Promise(r=>requestAnimationFrame(r));let instance=(await WebAssembly.instantiate(wasmBuffer,go.importObject)).instance,readyWait=new Promise(resolve=>{window.__slaprfWasmOnReady=bridge=>resolve(bridge)});if(go.run(instance),window.slaprfWasm||await Promise.race([readyWait,(async()=>{for(let i=0;i<600&&!window.slaprfWasm;i++)await new Promise(r=>setTimeout(r,25))})()]),!window.slaprfWasm)throw new Error("slaprfWasm failed to initialize");return window.__slaprfBootStatus?.("Hydrating track state\u2026",95),this.streamCallback&&this.bindStream(window.slaprfWasm,this.streamCallback),window.slaprfWasm}bindStream(wasm,onEnvelope){wasm.setRunning(!0),wasm.onStream(raw=>{try{onEnvelope(JSON.parse(raw))}catch(err){console.error("[WasmSimTransport] stream parse error:",err)}})}async request(method,url,body){let wasm=await this.ensureReady();wasm.setRunning(!0);let res=wasm.request(method,url,body!==void 0?JSON.stringify(body):"");if(res.status<200||res.status>=300)throw new Error(`WASM ${method} ${url} failed (${res.status}): ${res.body}`);return JSON.parse(res.body)}async fetchFirmwareImage(role,puckLabel,wifiSSID,wifiPass,firmwareVersion="v0.1.4"){let wasm=await this.ensureReady(),params=new URLSearchParams({role,version:firmwareVersion});puckLabel.trim()&&params.set("label",puckLabel.trim()),role==="hub"&&wifiSSID.trim()&&(params.set("ssid",wifiSSID.trim()),params.set("pass",wifiPass));let res=wasm.fetchBytes(`/api/firmware/xiao-c5.bin?${params.toString()}`);if(res.status<200||res.status>=300)throw new Error(`WASM firmware build failed: ${res.status}`);let slug=puckLabel.trim()?puckLabel.trim().replace(/[^a-zA-Z0-9_-]+/g,"-"):role;return{bytes:res.bytes,sha256:res.sha256??"",filename:`slaprf-xiao-c5-${slug}-${firmwareVersion}.bin`}}connectStream(onEnvelope){this.streamCallback=onEnvelope,this.ensureReady().then(wasm=>{this.streamCallback===onEnvelope&&this.bindStream(wasm,onEnvelope)})}disconnectStream(){this.streamCallback=null,window.slaprfWasm&&(window.slaprfWasm.onStream(null),window.slaprfWasm.setRunning(!1))}};var STATUS_POLL_MS=2e3,ApiClient=class{store;wasmTransport=new WasmSimTransport;httpTransport=new HttpRealTransport;simMode=!0;constructor(store){this.store=store}get transport(){return this.simMode?this.wasmTransport:this.httpTransport}async initialize(){window.addEventListener("pagehide",()=>this.transport.disconnectStream()),window.addEventListener("beforeunload",()=>this.transport.disconnectStream()),document.addEventListener("visibilitychange",()=>{document.hidden||(this.connectStream(),this.refresh().catch(()=>{}))}),await this.refresh(),this.connectStream(),window.setInterval(()=>{this.pollStatus()},STATUS_POLL_MS)}async refresh(){this.store.hydrate(await this.transport.request("GET","/api/state"))}async toggleSimulator(){this.transport.disconnectStream(),this.simMode=!this.simMode,this.connectStream(),await this.refresh()}async toggleArmed(){this.store.applyStatus(await this.transport.request("POST","/api/timing/toggle-arm"))}async simulatePack(){this.store.hydrate(await this.transport.request("POST","/api/sim/pack-burst"))}async simPilotAction(slotIndex,action){this.store.hydrate(await this.transport.request("POST","/api/sim/pilot-action",{slotIndex,action}))}async setTrackWalker(active){this.store.hydrate(await this.transport.request("POST","/api/sim/track-walker",{active}))}async simTimerAction(payload){this.store.hydrate(await this.transport.request("POST","/api/sim/timer-action",payload))}async pollStatusNow(){await this.pollStatus()}async resetSession(){this.store.hydrate(await this.transport.request("POST","/api/session/reset"))}async updatePilotSlot(slot){this.store.hydrate(await this.transport.request("POST","/api/pilots/update",slot))}async updateTrackNode(update){this.store.hydrate(await this.transport.request("POST","/api/track/update",update))}async updateGate(update){await this.updateTrackNode(update)}async addTrackNode(name="",assignedPuckId=0,trackOrder){this.store.hydrate(await this.transport.request("POST","/api/track/add",{name,assignedPuckId,...trackOrder!==void 0?{trackOrder}:{}}))}async addGate(name="",assignedPuckId=0,trackOrder){await this.addTrackNode(name,assignedPuckId,trackOrder)}async removeTrackNode(puckId){this.store.hydrate(await this.transport.request("POST","/api/track/remove",{puckId}))}async removeGate(puckId){await this.removeTrackNode(puckId)}async updateTimerColor(puckId,color){this.store.hydrate(await this.transport.request("POST","/api/timers/color",{puckId,color}))}async updatePuckColor(puckId,color){await this.updateTimerColor(puckId,color)}async provisionTimer(role,puckLabel,firmwareVersion=LATEST_FIRMWARE_VERSION){this.store.hydrate(await this.transport.request("POST","/api/timers/provision",{role,puckLabel,firmwareVersion}))}async provisionGate(role,puckLabel,firmwareVersion=LATEST_FIRMWARE_VERSION){await this.provisionTimer(role,puckLabel,firmwareVersion)}async fetchFirmwareImage(role,puckLabel="",wifiSSID="",wifiPass="",firmwareVersion=LATEST_FIRMWARE_VERSION){try{return await this.transport.fetchFirmwareImage(role,puckLabel,wifiSSID,wifiPass,firmwareVersion)}catch{let freqs=this.store.pilots.slice(0,8).map(p=>p.frequencyMhz),built=await buildOrPatchFirmwareBin({role,puckLabel,wifiSSID,wifiPass,firmwareVersion,frequenciesMHz:freqs});return{bytes:built.bytes,sha256:"",filename:built.filename}}}async ingestTelemetryFrame(frame){await this.httpTransport.request("POST","/api/ingest/frame",frame)}async listWifiNetworks(){try{return(await this.httpTransport.request("GET","/api/wifi/networks")).networks??[]}catch{return[]}}async setGateThresholds(updates){this.store.hydrate(await this.transport.request("POST","/api/thresholds",updates))}async setGateRules(puckId,overrides){this.store.hydrate(await this.transport.request("POST","/api/gates/rules",{puckId,overrides}))}async updateRules(rules){this.store.applyRules(await this.transport.request("POST","/api/rules",rules))}async pollStatus(){try{this.store.applyStatus(await this.transport.request("GET","/api/status"))}catch{}}connectStream(){this.transport.connectStream(msg=>{switch(msg.type){case"telemetry":this.store.ingestTelemetry(msg.payload);break;case"crossing":this.store.ingestCrossing(msg.payload);break;case"filtered":this.store.ingestFiltered(msg.payload);break;case"lap":{let p=msg.payload;this.store.ingestLap(p.lap,p.summaries);break}case"config":{let c=msg.payload;this.store.applyConfig(c.pilots,c.pucks);break}}})}};var MIN_BOOT_LOADER_MS=2200;function sleep2(ms){return new Promise(resolve=>window.setTimeout(resolve,ms))}function setBootStatus(detail,pct){let statusEl=document.getElementById("slaprf-boot-status");if(statusEl&&(statusEl.textContent=detail),pct!==void 0){let fillEl=document.getElementById("slaprf-boot-fill");fillEl&&(fillEl.style.width=`${Math.max(5,Math.min(100,pct))}%`)}}function dismissBootLoader(){let loader=document.getElementById("slaprf-boot-loader");loader&&(loader.classList.add("is-ready"),window.setTimeout(()=>loader.remove(),550))}async function bootstrap(){let bootStartMs=performance.now();window.__slaprfBootStatus=setBootStatus;let root=document.getElementById("app");if(!root)throw new Error("Missing #app root element");setBootStatus("Initializing UI components\u2026",18),installCustomSelects(),installTableScrollIndicators(),installWakeLock();let store=new AppStore,api=new ApiClient(store),router=new Router,announcer=new Announcer(store);new AppShell(root,store,api,router,announcer),await api.initialize();let elapsedMs=performance.now()-bootStartMs,remainingMs=Math.max(0,MIN_BOOT_LOADER_MS-elapsedMs);if(remainingMs>0){let stepMs=remainingMs/3;setBootStatus("Calibrating 5.8 GHz Raceband R1\u2013R8 channels\u2026",86),await sleep2(stepMs),setBootStatus("Synchronizing Hub + Spoke gate telemetry\u2026",94),await sleep2(stepMs),setBootStatus("Track armed \xB7 Ready",100),await sleep2(stepMs)}else setBootStatus("Track armed \xB7 Ready",100),await sleep2(260);dismissBootLoader()}document.addEventListener("DOMContentLoaded",()=>{bootstrap().catch(err=>{console.error("Gate Timer failed to start:",err),setBootStatus(`Startup error: ${err instanceof Error?err.message:String(err)}`,100),window.setTimeout(()=>dismissBootLoader(),1500)})});})();
