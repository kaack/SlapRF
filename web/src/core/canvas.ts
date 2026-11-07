export type DrawFn = (ctx: CanvasRenderingContext2D, width: number, height: number) => void;

/**
 * A HiDPI-aware canvas that tracks the size of its container and redraws on
 * every animation frame. Drawing happens in CSS pixels.
 */
export class CanvasSurface {
  private readonly container: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly observer: ResizeObserver;
  private readonly draw: DrawFn;
  private width = 0;
  private height = 0;
  private frame = 0;

  constructor(container: HTMLElement, draw: DrawFn) {
    this.container = container;
    this.draw = draw;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "surface-canvas";
    container.appendChild(this.canvas);

    const ctx = this.canvas.getContext("2d");
    if (!ctx) {
      throw new Error("CanvasSurface: 2D context unavailable");
    }
    this.ctx = ctx;

    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    this.resize();
    this.frame = requestAnimationFrame(this.tick);
  }

  private resize(): void {
    const rect = this.container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.width = Math.max(0, Math.floor(rect.width));
    this.height = Math.max(0, Math.floor(rect.height));
    this.canvas.width = Math.floor(this.width * dpr);
    this.canvas.height = Math.floor(this.height * dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private tick = (): void => {
    if (this.width > 0 && this.height > 0) {
      this.ctx.clearRect(0, 0, this.width, this.height);
      this.draw(this.ctx, this.width, this.height);
    }
    this.frame = requestAnimationFrame(this.tick);
  };

  public destroy(): void {
    cancelAnimationFrame(this.frame);
    this.observer.disconnect();
    this.canvas.remove();
  }
}
