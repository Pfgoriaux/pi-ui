import {
  type ContextUsage,
  FooterComponent,
} from "@earendil-works/pi-coding-agent";
import { colorize, contextHealth } from "./display.ts";

export function colorContextLine(
  line: string,
  usage: ContextUsage | undefined,
): string {
  // Only the native context token. Leave CH%, costs, model, and all spacing intact.
  return line.replace(/(?:\d+(?:\.\d+)?%|\?)\/\d+(?:\.\d+)?[kM]?/, (text) =>
    colorize(text, contextHealth(usage)),
  );
}

// Pi exposes the native FooterComponent, but not a render-transform hook.
// Decorate its output rather than reimplementing its usage accounting/layout.
export function installContextColor(
  getUsage: () => ContextUsage | undefined,
): () => void {
  const prototype = FooterComponent.prototype;
  const original = prototype.render;
  let enabled = true;
  function render(this: FooterComponent, width: number): string[] {
    const lines = original.call(this, width);
    if (!enabled || !lines[1]) return lines;
    const result = [...lines];
    result[1] = colorContextLine(lines[1], getUsage());
    return result;
  }
  prototype.render = render;
  return () => {
    enabled = false;
    if (prototype.render === render) prototype.render = original;
  };
}
