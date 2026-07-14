// browser-extension/src/lib/poller.ts
// Polling fallback: periodically fetches GET /api/v2/chats/<chatId> to
// retrieve the assistant response when the direct SSE stream fails.

import type { PendingRequest, ChatAssistantMessage } from "./types";
import { WsBridge } from "./ws_bridge";
import { delay } from "./dom_helper";

/**
 * Poll the Qwen chat API for a response, sending incremental deltas
 * to the WS bridge until the response is complete.
 *
 * @param requestId - The execute request id for correlation.
 * @param bridge - The WS bridge to send deltas to.
 * @param chatId - The Qwen chat session ID to poll.
 * @param getPending - Getter for the current pending request (checked for cancellation).
 */
export async function pollChatForResponse(
  requestId: string,
  bridge: WsBridge,
  chatId: string,
  getPending: () => PendingRequest | null,
  onClear: () => void,
): Promise<void> {
  console.debug("[Poll] Starting poll for chatId:", chatId, "requestId:", requestId);

  let baselineId: string | undefined;
  let baselineDone = false;
  let baselineHasContent = false;
  try {
    const br = await fetch(`https://chat.qwen.ai/api/v2/chats/${chatId}`, { credentials: "include" });
    if (br.ok) {
      const bb = await br.json();
      const bc = bb?.data?.chat || bb?.chat;
      if (bc?.history?.messages) {
        const bm: unknown[] = Array.isArray(bc.history.messages) ? bc.history.messages : Object.values(bc.history.messages);
        const am = bm.filter((m: unknown) => (m as Record<string, unknown>).role === "assistant") as ChatAssistantMessage[];
        if (am.length > 0) {
          const last = am[am.length - 1];
          baselineId = last.id;
          baselineDone = !!(last.done === true || last.status === "done" || last.status === "finished");
          baselineHasContent = !!(last.content_list && Array.isArray(last.content_list) && last.content_list.length > 0);
        }
      }
    }
    console.debug("[Poll] Baseline id:", baselineId?.slice(0, 12), "done:", baselineDone, "hasContent:", baselineHasContent);
  } catch {
    console.debug("[Poll] Baseline fetch failed");
  }

  const maxAttempts = 75;
  let attempts = 0;
  let sentThinking = false;
  let sentAnswer = false;
  let lastSentLength = 0;
  let lastThinkingLength = 0;

  while (attempts < maxAttempts) {
    attempts++;

    if (!getPending() || getPending()?.id !== requestId) {
      console.debug("[Poll] pendingRequest cleared, stopping poll");
      return;
    }

    try {
      const resp = await fetch(`https://chat.qwen.ai/api/v2/chats/${chatId}`, { credentials: "include" });
      if (!resp.ok) {
        console.debug(`[Poll] HTTP ${resp.status}, retry ${attempts}/${maxAttempts}`);
        await delay(2000);
        continue;
      }

      const body = await resp.json();
      const chat = body?.data?.chat || body?.chat;
      if (!chat?.history?.messages) {
        await delay(2000);
        continue;
      }

      const msgArray: unknown[] = Array.isArray(chat.history.messages)
        ? chat.history.messages : Object.values(chat.history.messages);
      const assistantMsgs = msgArray.filter(
        (m: unknown) => (m as Record<string, unknown>).role === "assistant",
      ) as ChatAssistantMessage[];
      if (assistantMsgs.length === 0) {
        await delay(2000);
        continue;
      }

      const lastAssistant = assistantMsgs[assistantMsgs.length - 1];
      const isNew = lastAssistant.id !== baselineId;
      const isDone = lastAssistant.done === true
        || lastAssistant.status === "done"
        || lastAssistant.status === "finished";
      const hasContent = !!(lastAssistant.content_list && Array.isArray(lastAssistant.content_list) && lastAssistant.content_list.length > 0);

      if (!isNew && !isDone && hasContent === baselineHasContent) {
        await delay(2000);
        continue;
      }

      if (!hasContent) {
        await delay(2000);
        continue;
      }

      const contentList = lastAssistant.content_list || [];
      const thinkingEntry = contentList.find((c) => c.phase === "thinking_summary");
      let thinkingContent = "";
      if (thinkingEntry?.extra?.summary_thought?.content) {
        const thoughts = thinkingEntry.extra.summary_thought.content;
        thinkingContent = Array.isArray(thoughts) ? thoughts.join("\n") : String(thoughts);
      }

      const answerEntry = contentList.find((c) => c.phase === "answer");
      const answerContent = answerEntry?.content || "";

      if (thinkingContent) {
        const newThinking = thinkingContent.slice(lastThinkingLength);
        if (newThinking) {
          bridge.send({ type: "reasoning", id: requestId, content: newThinking });
        }
        lastThinkingLength = thinkingContent.length;
        sentThinking = true;
      }

      if (answerContent) {
        const newContent = answerContent.slice(lastSentLength);
        if (newContent) {
          bridge.send({ type: "chunk", id: requestId, data: { content: newContent, done: false } });
        }
        lastSentLength = answerContent.length;
        sentAnswer = true;
      }

      if (isDone) {
        console.debug("[Poll] Response complete");
        if (thinkingContent) {
          const remainingThinking = thinkingContent.slice(lastThinkingLength);
          if (remainingThinking) {
            bridge.send({ type: "reasoning", id: requestId, content: remainingThinking });
          }
        }
        if (answerContent) {
          const remainingAnswer = answerContent.slice(lastSentLength);
          if (remainingAnswer) {
            bridge.send({ type: "chunk", id: requestId, data: { content: remainingAnswer, done: false } });
          }
        }
        bridge.send({
          type: "done",
          id: requestId,
          usage: {
            prompt_tokens: lastAssistant.usage?.input_tokens || 0,
            completion_tokens: lastAssistant.usage?.output_tokens || 0,
            total_tokens: (lastAssistant.usage?.input_tokens || 0) + (lastAssistant.usage?.output_tokens || 0),
          },
        });
        onClear();
        return;
      }
    } catch (err: unknown) {
      console.debug("[Poll] Fetch error:", (err as Error)?.message);
    }

    await delay(2000);
  }

  console.warn("[Poll] Max attempts reached, timing out");
  if (getPending()?.id === requestId) {
    bridge.send({ type: "error", id: requestId, error: { message: "Poll timed out" } });
    onClear();
  }
}
