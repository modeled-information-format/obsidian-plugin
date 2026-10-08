// Obsidian augments HTMLElement with helpers (createEl, createDiv, empty,
// setText, ...). This installs equivalents on happy-dom's elements so the
// plugin's panels can be rendered in tests.

import { Window } from "happy-dom";

export function installDom(): Window {
  const win = new Window();
  const g = globalThis as Record<string, unknown>;
  g.window = win;
  g.document = win.document;
  g.HTMLElement = win.HTMLElement;
  g.Node = win.Node;
  g.Event = win.Event;
  const proto = win.HTMLElement.prototype as unknown as Record<string, unknown>;
  type Opts = { cls?: string | string[]; text?: string; attr?: Record<string, string>; value?: string; type?: string; href?: string; placeholder?: string };
  function createEl(this: HTMLElement, tag: string, o: Opts | string = {}) {
    const opts: Opts = typeof o === "string" ? { cls: o } : o;
    const el = win.document.createElement(tag) as unknown as HTMLElement;
    if (opts.cls) el.className = Array.isArray(opts.cls) ? opts.cls.join(" ") : opts.cls;
    if (opts.text !== undefined) el.textContent = opts.text;
    for (const [k, v] of Object.entries(opts.attr ?? {})) el.setAttribute(k, v);
    for (const k of ["value", "type", "href", "placeholder"] as const) if (opts[k] !== undefined) el.setAttribute(k, opts[k]!);
    if (opts.value !== undefined) (el as unknown as { value: string }).value = opts.value;
    this.appendChild(el);
    return el;
  }
  proto.createEl = createEl;
  // Obsidian defines createSvg on every Element (SVG children included).
  (win.Element.prototype as unknown as Record<string, unknown>).createSvg = function (this: Element, tag: string, o: Opts | string = {}) {
    const opts: Opts = typeof o === "string" ? { cls: o } : o;
    const el = win.document.createElementNS("http://www.w3.org/2000/svg", tag) as unknown as Element;
    // As Obsidian: each cls entry goes to classList.add, which rejects a
    // space-separated string (createEl splits on spaces; createSvg does not).
    if (opts.cls) {
      for (const c of Array.isArray(opts.cls) ? opts.cls : [opts.cls]) {
        if (/\s/.test(c)) throw new Error(`Failed to execute 'add' on 'DOMTokenList': The token provided ('${c}') contains HTML space characters, which are not valid in tokens.`);
        el.classList.add(c);
      }
    }
    for (const [k, v] of Object.entries(opts.attr ?? {})) el.setAttribute(k, v);
    this.appendChild(el as never);
    return el;
  };
  proto.createDiv = function (this: HTMLElement, o?: Opts | string) {
    return createEl.call(this, "div", o);
  };
  proto.createSpan = function (this: HTMLElement, o?: Opts | string) {
    return createEl.call(this, "span", o);
  };
  proto.empty = function (this: HTMLElement) {
    this.innerHTML = "";
  };
  proto.setText = function (this: HTMLElement, t: string) {
    this.textContent = t;
  };
  proto.appendText = function (this: HTMLElement, t: string) {
    this.appendChild(win.document.createTextNode(t) as unknown as Node);
  };
  proto.setAttr = function (this: HTMLElement, k: string, v: string) {
    this.setAttribute(k, v);
  };
  proto.addClass = function (this: HTMLElement, ...c: string[]) {
    this.classList.add(...c);
  };
  proto.hide = function (this: HTMLElement) {
    this.style.display = "none";
  };
  proto.show = function (this: HTMLElement) {
    this.style.display = "";
  };
  return win;
}
