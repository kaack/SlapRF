/**
 * Minimal component base: owns a host element, tracks child components and
 * teardown callbacks so views can be mounted/unmounted without leaking
 * subscriptions, intervals or animation frames.
 */
export abstract class Component {
  protected readonly el: HTMLElement;
  private readonly disposers: Array<() => void> = [];
  private readonly children: Component[] = [];

  constructor(el: HTMLElement) {
    this.el = el;
  }

  /** Register a teardown callback that runs when the component is destroyed. */
  protected onDispose(fn: () => void): void {
    this.disposers.push(fn);
  }

  /** Attach a DOM event listener that is automatically removed on destroy(). */
  protected listen<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    handler: (ev: HTMLElementEventMap[K]) => void,
  ): void {
    target.addEventListener(type, handler);
    this.onDispose(() => target.removeEventListener(type, handler));
  }

  /** Track a child component so it is destroyed together with this one. */
  protected adopt<T extends Component>(child: T): T {
    this.children.push(child);
    return child;
  }

  /** Resolve an element marked with `data-slot="<name>"` inside this component. */
  protected slot(name: string): HTMLElement {
    const node = this.el.querySelector<HTMLElement>(`[data-slot="${name}"]`);
    if (!node) {
      throw new Error(`${this.constructor.name}: missing slot "${name}"`);
    }
    return node;
  }

  public destroy(): void {
    while (this.children.length > 0) {
      this.children.pop()!.destroy();
    }
    while (this.disposers.length > 0) {
      this.disposers.pop()!();
    }
    this.el.replaceChildren();
  }
}
