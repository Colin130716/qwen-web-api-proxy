// browser-extension/src/lib/tool_calling.ts
// Tool definition injection & tool call parsing for Qwen direct API integration.

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ParsedToolCall {
  index: number;
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

function generateId(): string {
  return `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

/**
 * Format a single tool definition as a human-readable string for prompt injection.
 */
export function formatToolDef(tool: ToolDefinition): string {
  const fn = tool.function;
  let text = `## ${fn.name}\n`;
  text += `Description: ${fn.description}\n`;
  const props = (fn.parameters?.properties ?? {}) as Record<string, { type?: string; description?: string }>;
  const required = (fn.parameters?.required ?? []) as string[];
  const entries = Object.entries(props);
  if (entries.length > 0) {
    text += "Parameters:\n";
    for (const [key, prop] of entries) {
      const req = required.includes(key) ? " (required)" : "";
      text += `- ${key} (${prop.type || "string"})${req}: ${prop.description || ""}\n`;
    }
  }
  return text;
}

/**
 * Inject tool definitions into the system prompt of a messages array.
 * Returns a new messages array with tool definitions injected (shallow clone).
 * If no system message exists, prepends one.
 */
export function injectToolDefinitions(
  messages: { role: string; content: string }[],
  tools: ToolDefinition[],
): { role: string; content: string }[] {
  if (!tools || tools.length === 0) return messages;

  const toolPrompt =
    "\n\nYou have access to the following tools:\n\n" +
    tools.map((t) => formatToolDef(t)).join("\n\n") +
    "\n\nTo call a tool, respond with exactly this format (and nothing else):\n" +
    "<tool_call>\n{\"name\": \"<tool_name>\", \"arguments\": {<args>}}\n</tool_call>\n" +
    "After the tool result comes back, continue assisting the user.";

  const result = messages.map((m) => ({ ...m }));
  const sysMsg = result.find((m) => m.role === "system");
  if (sysMsg) {
    sysMsg.content += toolPrompt;
  } else {
    result.unshift({ role: "system", content: toolPrompt });
  }
  return result;
}

/**
 * Parse tool calls from a Qwen response text.
 * Extracts <tool_call> JSON blocks and returns them in OpenAI format.
 */
export function parseToolCalls(text: string): ParsedToolCall[] | null {
  const regex = /<tool_call>\s*({.*?})\s*<\/tool_call>/gs;
  const calls: ParsedToolCall[] = [];
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = regex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      calls.push({
        index,
        id: generateId(),
        type: "function",
        function: {
          name: parsed.name || "",
          arguments: JSON.stringify(parsed.arguments || {}),
        },
      });
      index++;
    } catch {
      // skip malformed tool call blocks
    }
  }
  return calls.length > 0 ? calls : null;
}

/**
 * Strip tool call and websearch markup from response text,
 * leaving only the natural language part.
 */
export function stripToolCalls(text: string): string {
  return text
    .replace(/<tool_call>\s*\{.*?\}\s*<\/tool_call>\s*/gs, "")
    .replace(/<websearch>.*?<\/websearch>\s*/gs, "")
    .trim();
}
