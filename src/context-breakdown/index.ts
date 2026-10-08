/**
 * pi-context-breakdown — Shows what's filling your context window.
 *
 * Displays a breakdown of context usage by category:
 * - System prompt (broken down: base, tools, context files, skills, sections)
 * - User messages
 * - Assistant messages
 * - Tool calls (arguments)
 * - Tool results
 * - Images
 */

import type {
  BeforeAgentStartEvent,
  ContextEvent,
  ExtensionAPI,
  ExtensionContext,
  NormalizedBuildSystemPromptOptions,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

interface Category {
  label: string;
  chars: number;
  tokens: number; // estimated
  count: number;
}

interface Breakdown {
  categories: Record<string, Category>;
  total: { chars: number; tokens: number };
  contextWindow: number;
  actualTokens: number | null;
  actualPercent: number | null;
  updatedAt: number;
}

// Rough token estimate: ~4 chars per token for English
function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

function formatPercent(value: number): string {
  return value < 10 ? value.toFixed(1) : Math.round(value).toString();
}

function renderBar(pct: number, width = 20): string {
  const filled = Math.min(width, Math.max(0, Math.round((pct / 100) * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

// Extract text content size from message content
function getContentSize(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;

  let size = 0;
  for (const part of content) {
    if (typeof part === "string") {
      size += part.length;
    } else if (part && typeof part === "object") {
      const p = part as Record<string, unknown>;
      if (p.type === "text" && typeof p.text === "string") {
        size += p.text.length;
      } else if (p.type === "image") {
        // Base64 images are large; URL images are small
        const source = p.source as Record<string, unknown> | undefined;
        if (source?.type === "base64" && typeof source.data === "string") {
          size += (source.data as string).length;
        } else {
          size += 100; // URL reference
        }
      } else if (p.type === "tool_use") {
        // Tool call arguments
        const input = p.input;
        size +=
          typeof input === "string"
            ? input.length
            : JSON.stringify(input ?? {}).length;
      } else if (p.type === "tool_result") {
        size += getContentSize(p.content);
      }
    }
  }
  return size;
}

// Break down system prompt into components
function analyzeSystemPrompt(
  opts: NormalizedBuildSystemPromptOptions | undefined,
  fullPrompt: string,
): Record<string, Category> {
  const cats: Record<string, Category> = {};

  if (!opts) {
    // Fallback: just show total
    cats.sysTotal = {
      label: "System",
      chars: fullPrompt.length,
      tokens: estimateTokens(fullPrompt.length),
      count: 1,
    };
    return cats;
  }

  // Base prompt (custom or default preamble) - estimate from full minus known parts
  let knownChars = 0;

  // Context files (AGENTS.md, README.md, etc.)
  if (opts.contextFiles.length > 0) {
    let contextChars = 0;
    for (const cf of opts.contextFiles) {
      contextChars += cf.content.length;
      // Add path overhead (XML tags, path display)
      contextChars += cf.path.length + 50;
    }
    cats.context = {
      label: "Context",
      chars: contextChars,
      tokens: estimateTokens(contextChars),
      count: opts.contextFiles.length,
    };
    knownChars += contextChars;
  }

  // Skills
  if (opts.skills.length > 0) {
    let skillChars = 0;
    for (const skill of opts.skills) {
      // Skills have name, description, filePath
      skillChars += (skill.name?.length ?? 0) + 20;
      skillChars += skill.description?.length ?? 0;
      skillChars += (skill.filePath?.length ?? 0) + 20;
    }
    // Skills section has header overhead
    skillChars += 100;
    cats.skills = {
      label: "Skills",
      chars: skillChars,
      tokens: estimateTokens(skillChars),
      count: opts.skills.length,
    };
    knownChars += skillChars;
  }

  // Tools (snippets + guidelines)
  if (opts.selectedTools.length > 0) {
    let toolChars = 0;
    for (const tool of opts.selectedTools) {
      const snippet = opts.toolSnippets[tool];
      if (snippet) toolChars += snippet.length + tool.length + 10;
      const guidelines = opts.toolGuidelines[tool];
      if (guidelines) {
        for (const g of guidelines) toolChars += g.length + 5;
      }
    }
    // Tool definitions add significant overhead (JSON schemas, descriptions)
    // This is a rough estimate - actual tool defs are larger
    toolChars += opts.selectedTools.length * 200;
    cats.tools = {
      label: "Tools",
      chars: toolChars,
      tokens: estimateTokens(toolChars),
      count: opts.selectedTools.length,
    };
    knownChars += toolChars;
  }

  // Custom sections
  const sectionKeys = Object.keys(opts.sections);
  if (sectionKeys.length > 0) {
    let sectionChars = 0;
    for (const key of sectionKeys) {
      sectionChars += opts.sections[key].length;
      sectionChars += key.length * 2 + 10; // XML tags
    }
    cats.sections = {
      label: "Sections",
      chars: sectionChars,
      tokens: estimateTokens(sectionChars),
      count: sectionKeys.length,
    };
    knownChars += sectionChars;
  }

  // Appended prompt (user config)
  if (opts.appendSystemPrompt.length > 0) {
    cats.append = {
      label: "Config",
      chars: opts.appendSystemPrompt.length,
      tokens: estimateTokens(opts.appendSystemPrompt.length),
      count: 1,
    };
    knownChars += opts.appendSystemPrompt.length;
  }

  // Guidelines
  if (opts.promptGuidelines.length > 0) {
    let guideChars = 0;
    for (const g of opts.promptGuidelines) guideChars += g.length + 5;
    cats.guidelines = {
      label: "Guidelines",
      chars: guideChars,
      tokens: estimateTokens(guideChars),
      count: opts.promptGuidelines.length,
    };
    knownChars += guideChars;
  }

  // Base prompt = total - known parts
  const baseChars = Math.max(0, fullPrompt.length - knownChars);
  if (baseChars > 0) {
    cats.base = {
      label: "Base",
      chars: baseChars,
      tokens: estimateTokens(baseChars),
      count: 1,
    };
  }

  return cats;
}

function analyzeMessages(
  messages: unknown[],
  systemCats: Record<string, Category>,
): Record<string, Category> {
  const cats: Record<string, Category> = { ...systemCats };

  // Message categories
  cats.user = { label: "User", chars: 0, tokens: 0, count: 0 };
  cats.assistant = { label: "Assistant", chars: 0, tokens: 0, count: 0 };
  cats.toolCall = { label: "Tool calls", chars: 0, tokens: 0, count: 0 };
  cats.toolResult = { label: "Tool results", chars: 0, tokens: 0, count: 0 };
  cats.image = { label: "Images", chars: 0, tokens: 0, count: 0 };
  cats.other = { label: "Other", chars: 0, tokens: 0, count: 0 };

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const m = msg as Record<string, unknown>;
    const role = m.role as string;
    const content = m.content;

    if (role === "user") {
      cats.user.chars += getContentSize(content);
      cats.user.count++;
      // Check for images in user content
      if (Array.isArray(content)) {
        for (const part of content) {
          if (
            part &&
            typeof part === "object" &&
            (part as Record<string, unknown>).type === "image"
          ) {
            cats.image.count++;
            const source = (part as Record<string, unknown>).source as
              | Record<string, unknown>
              | undefined;
            if (source?.type === "base64" && typeof source.data === "string") {
              cats.image.chars += (source.data as string).length;
              // Adjust user chars (don't double count)
              cats.user.chars -= (source.data as string).length;
            }
          }
        }
      }
    } else if (role === "assistant") {
      cats.assistant.chars += getContentSize(content);
      cats.assistant.count++;
      // Check for tool_use blocks
      if (Array.isArray(content)) {
        for (const part of content) {
          if (
            part &&
            typeof part === "object" &&
            (part as Record<string, unknown>).type === "tool_use"
          ) {
            cats.toolCall.count++;
            const input = (part as Record<string, unknown>).input;
            const inputSize =
              typeof input === "string"
                ? input.length
                : JSON.stringify(input ?? {}).length;
            cats.toolCall.chars += inputSize;
            // Adjust assistant chars
            cats.assistant.chars -= inputSize;
          }
        }
      }
    } else if (role === "tool" || role === "toolResult") {
      cats.toolResult.chars += getContentSize(content);
      cats.toolResult.count++;
    } else if (role === "compactionSummary" || role === "branchSummary") {
      // Summaries - add to a summary category
      const summarySize = getContentSize(m.summary ?? content);
      if (!cats.summary) {
        cats.summary = { label: "Summaries", chars: 0, tokens: 0, count: 0 };
      }
      cats.summary.chars += summarySize;
      cats.summary.count++;
    } else if (role === "bashExecution") {
      // Bash output is like a tool result
      const output = m.output;
      if (typeof output === "string") {
        cats.toolResult.chars += output.length;
        cats.toolResult.count++;
      }
    } else {
      cats.other.chars += getContentSize(content);
      cats.other.count++;
    }
  }

  // Calculate estimated tokens for message categories
  for (const key of [
    "user",
    "assistant",
    "toolCall",
    "toolResult",
    "image",
    "other",
    "summary",
  ]) {
    if (cats[key]) {
      cats[key].tokens = estimateTokens(cats[key].chars);
    }
  }

  return cats;
}

export default function contextBreakdown(pi: ExtensionAPI): void {
  let breakdown: Breakdown | undefined;
  let ctx: ExtensionContext | undefined;
  let repaint: (() => void) | undefined;
  let lastSystemOpts: NormalizedBuildSystemPromptOptions | undefined;

  // Capture system prompt options before each turn
  pi.on("before_agent_start", (event: BeforeAgentStartEvent) => {
    lastSystemOpts = event.systemPromptOptions;
  });

  pi.on("context", (event: ContextEvent, context) => {
    const systemPrompt = context.getSystemPrompt();
    const systemCats = analyzeSystemPrompt(lastSystemOpts, systemPrompt);
    const categories = analyzeMessages(event.messages, systemCats);
    const usage = context.getContextUsage();

    const totalChars = Object.values(categories).reduce(
      (sum, c) => sum + c.chars,
      0,
    );
    const totalTokens = Object.values(categories).reduce(
      (sum, c) => sum + c.tokens,
      0,
    );

    breakdown = {
      categories,
      total: { chars: totalChars, tokens: totalTokens },
      contextWindow: usage?.contextWindow ?? 200_000,
      actualTokens: usage?.tokens ?? null,
      actualPercent: usage?.percent ?? null,
      updatedAt: Date.now(),
    };

    repaint?.();
  });

  // Short labels for inline legend
  const shortLabels: Record<string, string> = {
    "Tool results": "Result",
    "Tool calls": "Call",
    Context: "Ctx",
    Skills: "Skill",
    Tools: "Tool",
    Assistant: "Asst",
    Images: "Img",
    Summaries: "Sum",
  };

  // ANSI colors for each category (order matters for visual distinction)
  const categoryColors: Record<string, string> = {
    toolResult: "\x1b[97m", // bright white
    assistant: "\x1b[96m", // cyan
    user: "\x1b[93m", // yellow
    toolCall: "\x1b[95m", // magenta
    context: "\x1b[92m", // green
    skills: "\x1b[94m", // blue
    tools: "\x1b[91m", // red
    base: "\x1b[90m", // gray
    sections: "\x1b[33m", // dark yellow
    append: "\x1b[35m", // dark magenta
    guidelines: "\x1b[36m", // dark cyan
    image: "\x1b[34m", // dark blue
    summary: "\x1b[32m", // dark green
    other: "\x1b[37m", // white
  };
  const reset = "\x1b[0m";
  const dim = "\x1b[2m";

  pi.on("session_start", (_event, context) => {
    if (context.mode !== "tui") return;
    ctx = context;

    context.ui.setWidget(
      "context-breakdown",
      (tui, _theme) => {
        repaint = () => tui.requestRender();
        return {
          render(width: number): string[] {
            if (width <= 0 || !breakdown) return [];
            const bd = breakdown;

            // Sort categories by size descending
            const sorted = Object.entries(bd.categories)
              .filter(([_, c]) => c.tokens > 0)
              .sort(([, a], [, b]) => b.tokens - a.tokens);

            // Build single stacked bar
            const barWidth = Math.min(40, Math.max(20, width - 50));
            const totalTokens = bd.actualTokens ?? bd.total.tokens;
            const pctUsed =
              bd.actualPercent ?? (bd.total.tokens / bd.contextWindow) * 100;

            // Calculate segment widths (proportional to percentage of used context)
            let bar = "";
            let usedWidth = 0;
            const legendParts: string[] = [];

            for (const [key, cat] of sorted) {
              const pctOfTotal = (cat.tokens / bd.total.tokens) * 100;
              if (pctOfTotal < 1) continue; // skip tiny segments

              const segmentWidth = Math.max(
                1,
                Math.round((pctOfTotal / 100) * barWidth * (pctUsed / 100)),
              );
              if (usedWidth + segmentWidth > barWidth) continue;

              const color = categoryColors[key] ?? "\x1b[37m";
              bar += color + "█".repeat(segmentWidth) + reset;
              usedWidth += segmentWidth;

              // Add to legend if significant
              if (pctOfTotal >= 3) {
                const label = shortLabels[cat.label] ?? cat.label;
                legendParts.push(`${color}${label}${reset}`);
              }
            }

            // Fill remaining with dim blocks
            const remaining = barWidth - usedWidth;
            if (remaining > 0) {
              bar += dim + "░".repeat(remaining) + reset;
            }

            // Compact single line: bar + totals + legend
            const totalsStr = `${formatTokens(totalTokens)}/${formatTokens(bd.contextWindow)} (${formatPercent(pctUsed)}%)`;
            const legendStr =
              legendParts.length > 0
                ? `  ${legendParts.join(`${dim}·${reset}`)}`
                : "";

            const line = `${bar} ${totalsStr}${legendStr}`;
            return [truncateToWidth(line, width)];
          },
          invalidate() {},
        };
      },
      { placement: "belowEditor" },
    );
  });

  pi.on("session_shutdown", () => {
    ctx?.ui.setWidget("context-breakdown", undefined);
    ctx = undefined;
    breakdown = undefined;
    repaint = undefined;
    lastSystemOpts = undefined;
  });

  // Register /context command for detailed view
  pi.registerCommand("context", {
    description: "Show detailed context breakdown",
    handler: async (_args, context) => {
      if (!breakdown) {
        context.ui.notify("No context data yet. Send a message first.", "info");
        return;
      }

      const lines: string[] = ["", "Context Breakdown", "─".repeat(50)];

      // Capture breakdown for closure
      const bd = breakdown;

      // Group: System prompt components
      const systemKeys = [
        "base",
        "context",
        "skills",
        "tools",
        "sections",
        "append",
        "guidelines",
      ];
      const systemCats = systemKeys
        .filter((k) => bd.categories[k]?.tokens > 0)
        .map((k) => bd.categories[k]);

      if (systemCats.length > 0) {
        lines.push("System prompt:");
        for (const cat of systemCats) {
          const pct = (cat.tokens / bd.total.tokens) * 100;
          const bar = renderBar(pct);
          lines.push(
            `  ${cat.label.padEnd(10)} ${bar} ${formatTokens(cat.tokens).padStart(6)} (${formatPercent(pct).padStart(4)}%)  [${cat.count}]`,
          );
        }
        lines.push("");
      }

      // Group: Messages
      const msgKeys = [
        "user",
        "assistant",
        "toolCall",
        "toolResult",
        "image",
        "summary",
        "other",
      ];
      const msgCats = msgKeys
        .filter((k) => bd.categories[k]?.tokens > 0)
        .map((k) => bd.categories[k]);

      if (msgCats.length > 0) {
        lines.push("Messages:");
        for (const cat of msgCats) {
          const pct = (cat.tokens / bd.total.tokens) * 100;
          const bar = renderBar(pct);
          lines.push(
            `  ${cat.label.padEnd(12)} ${bar} ${formatTokens(cat.tokens).padStart(6)} (${formatPercent(pct).padStart(4)}%)  [${cat.count}]`,
          );
        }
        lines.push("");
      }

      lines.push("─".repeat(50));
      if (bd.actualTokens !== null) {
        lines.push(`Actual tokens:    ${formatTokens(bd.actualTokens)}`);
        lines.push(`Estimated tokens: ${formatTokens(bd.total.tokens)}`);
        lines.push(`Context window:   ${formatTokens(bd.contextWindow)}`);
        lines.push(
          `Usage:            ${formatPercent(bd.actualPercent ?? 0)}%`,
        );
      } else {
        lines.push(`Estimated tokens: ${formatTokens(bd.total.tokens)}`);
        lines.push(`Context window:   ${formatTokens(bd.contextWindow)}`);
      }
      lines.push("");

      context.ui.notify(lines.join("\n"), "info");
    },
  });
}
