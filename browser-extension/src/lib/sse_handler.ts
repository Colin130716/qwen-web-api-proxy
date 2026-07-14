// browser-extension/src/lib/sse_handler.ts
// SSE stream processing for Qwen chat/completions response.
// Handles thinking_summary and answer phase deltas, relayed via ws bridge.

import type { PendingRequest, SseEvent } from "./types";

/**
 * Parse SSE data lines in the pending buffer, forwarding reasoning and
 * content chunks to the bridge. Does NOT complete the request here —
 * callers must wait for the stream-end event and call handleCompletedResponse.
 *
 * When `isPolling` is true, data is buffered but not forwarded
 * (polling is the primary delivery path).
 */
export function processSSEBuffer(state: PendingRequest): void {
  if (!state) return;
  const lines = state.sseBuffer.split("\n");
  state.sseBuffer = lines.pop() || "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(":")) continue;
    if (!trimmed.startsWith("data: ")) continue;
    const raw = trimmed.slice(6);
    if (raw === "[DONE]") continue;

    let event: SseEvent;
    try {
      event = JSON.parse(raw) as SseEvent;
    } catch {
      console.debug("[SSE] Unparseable JSON:", raw.slice(0, 100));
      continue;
    }

    // Track latest usage from every event (used by handleCompletedResponse at stream end)
    if (event.usage) {
      state.lastUsage = event.usage;
    }

    const keys = Object.keys(event);
    if (keys.length > 0 && keys[0] !== "choices") {
      console.debug("[SSE] Non-standard event keys:", keys.join(","), "id:" + ((event as Record<string, unknown>).id as string | undefined)?.slice(0, 12));
    }

    if (event["response.created"]) continue;

    if (state.isPolling) {
      console.debug("[SSE] Polling active, skipping SSE delivery, event keys:", keys.join(","));
      continue;
    }

    const choice = event?.choices?.[0];
    if (!choice?.delta) continue;

    const delta = choice.delta;
    const phase = delta.phase;

    if (phase === "thinking_summary") {
      if (delta.extra?.summary_thought) {
        const st = delta.extra.summary_thought as { content?: string | string[] };
        if (st?.content) {
          state.thinkingContent += Array.isArray(st.content)
            ? st.content.join("\n")
            : String(st.content);
        }
      }
      if (delta.status === "finished") {
        state.thinkingFinished = true;
      }
    } else if (phase === "answer") {
      state.hasSentAnswer = true;
      if (state.thinkingFinished && !state.hasSentThinking && state.thinkingContent) {
        state.bridge.send({
          type: "reasoning",
          id: state.id,
          content: state.thinkingContent,
        });
        state.hasSentThinking = true;
      }
      const text = typeof delta.content === "string" ? delta.content : "";
      if (text) {
        state.bridge.send({
          type: "chunk",
          id: state.id,
          data: { content: text, done: false },
        });
      }
    } else if (phase === "image_gen_tool") {
      if (delta.status === "finished") {
        const extra = delta.extra as Record<string, unknown> | undefined;
        const imageList = extra?.image_list as Array<{ image?: string }> | undefined;
        if (imageList && imageList.length > 0) {
          for (const img of imageList) {
            if (img.image) {
              state.bridge.send({
                type: "chunk",
                id: state.id,
                data: { content: `\n\n![Generated Image](${img.image})\n\n`, done: false },
              });
            }
          }
        }
      }
    }
  }
}

export function handleCompletedResponse(state: PendingRequest): void {
  if (state.isPolling) {
    console.debug("[SSE] Polling active, ignoring SSE stream end");
    return;
  }

  const usage = state.lastUsage;
  const usageOut = {
    prompt_tokens: usage?.input_tokens || 0,
    completion_tokens: usage?.output_tokens || 0,
    total_tokens: usage?.total_tokens || 0,
  };

  if (state.hasSentAnswer) {
    if (!state.hasSentThinking && state.thinkingContent) {
      state.bridge.send({ type: "reasoning", id: state.id, content: state.thinkingContent });
    }
    state.bridge.send({ type: "done", id: state.id, usage: usageOut });
  } else if (state.thinkingContent) {
    state.bridge.send({ type: "reasoning", id: state.id, content: state.thinkingContent });
    state.bridge.send({ type: "done", id: state.id, usage: usageOut });
  }
}

/**
 * Fetch the last assistant message ID from an existing chat.
 * Used by /change to set parentId for multi-turn continuity.
 * Throws if the chat doesn't exist (HTTP error).
 */
export async function fetchLastAssistantId(chatId: string): Promise<string | null> {
  const resp = await fetch(`https://chat.qwen.ai/api/v2/chats/${chatId}`, { credentials: "include" });
  if (!resp.ok) throw new Error(`Chat not found (${resp.status})`);
  const body = await resp.json();
  const chat = body?.data?.chat || body?.chat;
  if (!chat?.history?.messages) return null;
  const msgArray: unknown[] = Array.isArray(chat.history.messages)
    ? chat.history.messages : Object.values(chat.history.messages);
  const assistantMsgs = msgArray.filter(
    (m: unknown) => (m as Record<string, unknown>)?.role === "assistant",
  );
  if (assistantMsgs.length === 0) return null;
  return (assistantMsgs[assistantMsgs.length - 1] as Record<string, unknown>)?.id as string | null;
}
