import { Component } from "../core/component";
import { esc } from "../core/format";
import { icons } from "../core/icons";
import { pushAppHash } from "../core/router";
import rawCatalog from "../data/tutorials.json";

export interface TutorialStepItem {
  id: string;
  startSec?: number;
  badge: string;
  caption: string;
  narration: string;
}

export interface TutorialVideoItem {
  id: string;
  title: string;
  category: string;
  categoryLabel: string;
  tryHash?: string;
  tryLabel?: string;
  summary: string;
  youtubeVideoId: string;
  durationSec: number;
  durationLabel: string;
  steps: TutorialStepItem[];
}

interface TutorialCatalogManifest {
  channel: {
    name: string;
    handle: string;
    url: string;
    tagline: string;
  };
  categories: Array<{ id: string; label: string }>;
  videos: TutorialVideoItem[];
}

const CATALOG = rawCatalog as TutorialCatalogManifest;

function formatStepTimestamp(sec = 0): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${String(rem).padStart(2, "0")}`;
}

export class TutorialsView extends Component {
  private activeCategory = "all";
  private searchQuery = "";
  private selectedVideoId: string = CATALOG.videos[0]?.id ?? "";
  private seekSec: number | null = null;
  private autoplayRequested = false;

  constructor(el: HTMLElement) {
    super(el);

    this.syncFromHash();

    this.listen(el, "click", (e) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;

      const catBtn = target.closest<HTMLButtonElement>("[data-tut-cat]");
      if (catBtn) {
        const nextCat = catBtn.dataset.tutCat || "all";
        if (this.activeCategory !== nextCat) {
          this.activeCategory = nextCat;
          this.ensureSelectionVisible();
          this.render();
        }
        return;
      }

      const cardBtn = target.closest<HTMLElement>("[data-tut-select]");
      if (cardBtn) {
        const vidId = cardBtn.dataset.tutSelect || "";
        if (vidId && vidId !== this.selectedVideoId) {
          this.selectedVideoId = vidId;
          this.seekSec = null;
          this.autoplayRequested = false;
          pushAppHash(`#/tutorials/${encodeURIComponent(vidId)}`);
          this.render();
        }
        return;
      }

      const stepBtn = target.closest<HTMLButtonElement>("[data-tut-seek]");
      if (stepBtn) {
        const sec = Math.max(0, Number(stepBtn.dataset.tutSeek ?? 0));
        this.seekSec = sec;
        this.autoplayRequested = true;
        this.refreshPlayerIframeDom();
        return;
      }

      const tryBtn = target.closest<HTMLElement>("[data-tut-try-hash]");
      if (tryBtn) {
        const dest = tryBtn.dataset.tutTryHash || "#/practice";
        pushAppHash(dest);
      }
    });

    this.listen(el, "input", (e) => {
      const target = e.target as HTMLElement | null;
      if (target instanceof HTMLInputElement && target.hasAttribute("data-tut-search")) {
        this.searchQuery = target.value;
        this.ensureSelectionVisible();
        this.refreshCatalogGridDom();
      }
    });

    this.render();
  }

  public override onActivate(): void {
    this.syncFromHash();
    this.render();
  }

  public override onDeactivate(): void {
    const iframe = this.el.querySelector<HTMLIFrameElement>("iframe[data-tut-iframe]");
    if (iframe?.contentWindow) {
      try {
        iframe.contentWindow.postMessage(
          JSON.stringify({ event: "command", func: "pauseVideo", args: [] }),
          "*"
        );
      } catch {
        // Ignore cross-origin postMessage restrictions
      }
    }
  }

  private syncFromHash(): void {
    if (typeof window === "undefined") return;
    const raw = (window.location.hash || "").replace(/^#\/?/, "");
    const parts = raw.split("/");
    if (parts[0] === "tutorials" && parts[1]) {
      const decoded = decodeURIComponent(parts[1]);
      if (CATALOG.videos.some((v) => v.id === decoded)) {
        this.selectedVideoId = decoded;
      }
    }
  }

  private filteredVideos(): TutorialVideoItem[] {
    const q = this.searchQuery.trim().toLowerCase();
    return CATALOG.videos.filter((v) => {
      if (this.activeCategory !== "all" && v.category !== this.activeCategory) {
        return false;
      }
      if (!q) return true;
      const hay = `${v.title} ${v.categoryLabel} ${v.summary} ${v.steps.map((s) => `${s.badge} ${s.caption} ${s.narration}`).join(" ")}`.toLowerCase();
      return hay.includes(q);
    });
  }

  private ensureSelectionVisible(): void {
    const list = this.filteredVideos();
    if (list.length > 0 && !list.some((v) => v.id === this.selectedVideoId)) {
      this.selectedVideoId = list[0].id;
      this.seekSec = null;
      this.autoplayRequested = false;
    }
  }

  private buildEmbedSrc(video: TutorialVideoItem): string {
    if (!video.youtubeVideoId) return "";
    const params = new URLSearchParams({
      rel: "0",
      modestbranding: "1",
      enablejsapi: "1",
    });
    if (this.seekSec !== null && this.seekSec > 0) {
      params.set("start", String(Math.floor(this.seekSec)));
    }
    if (this.autoplayRequested) {
      params.set("autoplay", "1");
    }
    return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(video.youtubeVideoId)}?${params.toString()}`;
  }

  private renderPlayerHtml(video: TutorialVideoItem | undefined): string {
    if (!video) {
      return `
        <div class="card tutorials-empty-card">
          <p class="note">No tutorials match your search filter.</p>
        </div>`;
    }

    const embedSrc = this.buildEmbedSrc(video);
    const mediaHtml = embedSrc
      ? `<div class="tutorials-video-frame-wrap">
          <iframe
            data-tut-iframe
            src="${esc(embedSrc)}"
            title="${esc(video.title)}"
            loading="lazy"
            referrerpolicy="strict-origin-when-cross-origin"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowfullscreen
          ></iframe>
        </div>`
      : `<div class="tutorials-video-placeholder" data-tut-placeholder>
          <div class="tutorials-video-placeholder-icon">${icons.video(28)}</div>
          <div class="tutorials-video-placeholder-copy">
            <strong>${esc(video.title)} (${esc(video.durationLabel)})</strong>
            <p class="note">Follow the ${video.steps.length}-step walkthrough below or watch on the official ${esc(CATALOG.channel.handle)} YouTube channel.</p>
          </div>
          <div class="tutorials-video-placeholder-actions">
            <a class="btn btn-armed btn-sm" href="${esc(CATALOG.channel.url)}" target="_blank" rel="noopener noreferrer">
              ${icons.video(14)}<span>Watch on YouTube (${esc(CATALOG.channel.handle)})</span>
            </a>
            ${
              video.tryHash
                ? `<button type="button" class="btn btn-ghost btn-sm" data-tut-try-hash="${esc(video.tryHash)}">
                    ${icons.arrowRight(14)}<span>${esc(video.tryLabel || "Open in App")}</span>
                  </button>`
                : ""
            }
          </div>
        </div>`;

    const stepsHtml = video.steps
      .map((st, idx) => {
        const ts = formatStepTimestamp(st.startSec ?? 0);
        return `
          <div class="tutorials-step-row">
            <div class="tutorials-step-num">${idx + 1}</div>
            <div class="tutorials-step-body">
              <div class="tutorials-step-top">
                <strong>${esc(st.caption)}</strong>
                ${
                  video.youtubeVideoId
                    ? `<button type="button" class="tutorials-step-ts mono" data-tut-seek="${st.startSec ?? 0}" title="Jump video to ${ts}">${icons.play(11)}<span>${ts}</span></button>`
                    : `<span class="tutorials-step-ts mono is-static">${ts}</span>`
                }
              </div>
              <p class="note">${esc(st.narration)}</p>
            </div>
          </div>`;
      })
      .join("");

    return `
      <section class="card tutorials-player-card" data-tut-player-card="${esc(video.id)}">
        <header class="tutorials-player-head">
          <div class="tutorials-player-meta">
            <span class="races-tpl-tag">${esc(video.categoryLabel)}</span>
            <span class="badge mono">${esc(video.durationLabel)} · &lt; 5 min</span>
          </div>
          <div class="tutorials-player-title-row">
            <h2>${esc(video.title)}</h2>
            <a
              class="btn btn-ghost btn-xs"
              href="${esc(video.youtubeVideoId ? `https://www.youtube.com/watch?v=${encodeURIComponent(video.youtubeVideoId)}` : CATALOG.channel.url)}"
              target="_blank"
              rel="noopener noreferrer"
            >
              ${icons.video(13)}<span>YouTube</span>
            </a>
          </div>
          <p class="note">${esc(video.summary)}</p>
        </header>
        <div data-tut-iframe-slot>${mediaHtml}</div>
        <div class="tutorials-steps-section">
          <div class="tutorials-steps-heading">Step-by-Step Walkthrough (${video.steps.length} steps)</div>
          <div class="tutorials-steps-list">${stepsHtml}</div>
        </div>
      </section>`;
  }

  private renderCatalogCardsHtml(videos: TutorialVideoItem[]): string {
    if (videos.length === 0) {
      return `<div class="note" style="padding:12px 4px">No tutorials match "${esc(this.searchQuery)}".</div>`;
    }
    return videos
      .map((v) => {
        const active = v.id === this.selectedVideoId;
        return `
          <button
            type="button"
            class="tutorials-catalog-card ${active ? "is-active" : ""}"
            data-tut-select="${esc(v.id)}"
            aria-pressed="${active ? "true" : "false"}"
          >
            <div class="tutorials-catalog-card-top">
              <span class="races-tpl-tag">${esc(v.categoryLabel)}</span>
              <span class="badge mono">${esc(v.durationLabel)}</span>
            </div>
            <strong class="tutorials-catalog-card-title">${esc(v.title)}</strong>
            <span class="note tutorials-catalog-card-desc">${esc(v.summary)}</span>
            <span class="tutorials-catalog-card-foot mono">${v.steps.length} steps</span>
          </button>`;
      })
      .join("");
  }

  private refreshPlayerIframeDom(): void {
    const slot = this.el.querySelector<HTMLElement>("[data-tut-iframe-slot]");
    const video = CATALOG.videos.find((v) => v.id === this.selectedVideoId);
    if (!slot || !video || !video.youtubeVideoId) return;
    const embedSrc = this.buildEmbedSrc(video);
    slot.innerHTML = `
      <div class="tutorials-video-frame-wrap">
        <iframe
          data-tut-iframe
          src="${esc(embedSrc)}"
          title="${esc(video.title)}"
          referrerpolicy="strict-origin-when-cross-origin"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowfullscreen
        ></iframe>
      </div>`;
  }

  private refreshCatalogGridDom(): void {
    const videos = this.filteredVideos();
    const listEl = this.el.querySelector<HTMLElement>("[data-tut-catalog-list]");
    const detailEl = this.el.querySelector<HTMLElement>("[data-tut-detail-host]");
    if (listEl) {
      listEl.innerHTML = this.renderCatalogCardsHtml(videos);
    }
    if (detailEl) {
      const selected = videos.find((v) => v.id === this.selectedVideoId) ?? videos[0];
      detailEl.innerHTML = this.renderPlayerHtml(selected);
    }
  }

  private render(): void {
    const videos = this.filteredVideos();
    const selected = videos.find((v) => v.id === this.selectedVideoId) ?? videos[0];

    const populatedCatIds = new Set(CATALOG.videos.map((v) => v.category));
    const visibleCategories = CATALOG.categories.filter(
      (c) => c.id === "all" || populatedCatIds.has(c.id)
    );
    const catPillsHtml = visibleCategories
      .map(
        (c) => `
        <button
          type="button"
          class="races-filter-pill ${this.activeCategory === c.id ? "is-active" : ""}"
          data-tut-cat="${esc(c.id)}"
        >${esc(c.label)}</button>`
      )
      .join("");

    this.el.innerHTML = `
      <div class="tutorials-page" data-tutorials-root>
        <div class="tutorials-toolbar card">
          <div class="tutorials-toolbar-left">
            <div class="races-preset-pills" role="tablist" aria-label="Tutorial categories">
              ${catPillsHtml}
            </div>
          </div>
          <div class="tutorials-toolbar-right">
            <input
              type="search"
              class="input input-sm tutorials-search-input"
              data-tut-search
              placeholder="Search tutorials..."
              value="${esc(this.searchQuery)}"
              aria-label="Search tutorials"
            />
            <a
              class="btn btn-ghost btn-sm"
              href="${esc(CATALOG.channel.url)}"
              target="_blank"
              rel="noopener noreferrer"
              title="Open official SlapRF YouTube channel"
            >
              ${icons.video(15)}<span>${esc(CATALOG.channel.handle)}</span>
            </a>
          </div>
        </div>

        <div class="tutorials-layout">
          <aside class="tutorials-catalog-col" aria-label="Video catalog" data-tut-catalog-list>
            ${this.renderCatalogCardsHtml(videos)}
          </aside>
          <div class="tutorials-detail-col" data-tut-detail-host>
            ${this.renderPlayerHtml(selected)}
          </div>
        </div>
      </div>`;
  }
}
