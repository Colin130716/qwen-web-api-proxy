// browser-extension/src/lib/dom_helper.ts
// DOM automation utilities for Qwen chat page interaction.

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function findInputElement(maxWait = 10000): Promise<{ el: HTMLElement; selector: string } | null> {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const ta = document.querySelector<HTMLElement>("textarea.message-input-textarea");
    if (ta) return { el: ta, selector: "textarea.message-input-textarea" };
    const anyInput = document.querySelector<HTMLElement>(
      "textarea:not([disabled]):not([readonly]), [contenteditable='true']",
    );
    if (anyInput) {
      const tag = anyInput.tagName.toLowerCase();
      const sel = tag === "textarea" ? "textarea fallback" : "contenteditable fallback";
      return { el: anyInput, selector: sel };
    }
    await delay(300);
  }
  return null;
}

export function fillInput(el: HTMLElement, text: string): boolean {
  const tag = el.tagName.toLowerCase();
  console.debug("[QwenProxy] fillInput target:", tag, "class:", el.className?.slice(0, 80));
  el.focus();

  if (tag === "textarea" || tag === "input") {
    const inputEl = el as HTMLTextAreaElement;

    console.debug("[QwenProxy] fillInput: value before set =", JSON.stringify(inputEl.value).slice(0, 100));

    // Strategy 1: Clear then set (triggers React change detection)
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype, "value",
    )?.set;
    if (nativeSetter) {
      nativeSetter.call(inputEl, "");
      inputEl.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      nativeSetter.call(inputEl, text);
    } else {
      inputEl.value = "";
      inputEl.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      inputEl.value = text;
    }

    inputEl.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    inputEl.dispatchEvent(new Event("change", { bubbles: true }));

    try {
      inputEl.dispatchEvent(new InputEvent("beforeinput", {
        bubbles: true, cancelable: true, inputType: "insertText", data: text,
      }));
    } catch { /* ok */ }
    try {
      inputEl.dispatchEvent(new InputEvent("input", {
        bubbles: true, cancelable: true, inputType: "insertText", data: text,
      }));
    } catch { /* ok */ }

    console.debug("[QwenProxy] fillInput: value after set =", JSON.stringify(inputEl.value).slice(0, 100), "| length:", text.length);
    return true;
  } else if (el.getAttribute("contenteditable") === "true") {
    el.textContent = text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }
  return false;
}

export function clickSend(inputEl: HTMLElement): void {
  const tag = inputEl.tagName.toLowerCase();
  console.debug("[QwenProxy] clickSend on", tag);

  if (tag === "textarea" || tag === "input") {
    const textarea = inputEl as HTMLTextAreaElement;
    console.debug("[QwenProxy] clickSend: textarea value length =", textarea.value?.length);
    if (textarea.value?.length === 0) {
      console.warn("[QwenProxy] clickSend: textarea value is EMPTY — React state likely not updated!");
    }

    inputEl.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter", code: "Enter", keyCode: 13, which: 13,
      bubbles: true, cancelable: true, composed: true,
    }));
    inputEl.dispatchEvent(new KeyboardEvent("keypress", {
      key: "Enter", code: "Enter", keyCode: 13, which: 13,
      bubbles: true, cancelable: true,
    }));
    inputEl.dispatchEvent(new KeyboardEvent("keyup", {
      key: "Enter", code: "Enter", keyCode: 13, which: 13,
      bubbles: true, cancelable: true,
    }));

    console.debug("[QwenProxy] Dispatched Enter key sequence on input element");
    return;
  }

  const btn =
    document.querySelector<HTMLButtonElement>("button.send-button:not([disabled])") ||
    document.querySelector<HTMLButtonElement>(
      'button[aria-label*="send"], button[aria-label*="发送"], button[aria-label*="submit"]',
    );
  if (btn) {
    btn.click();
    console.debug("[QwenProxy] Clicked send button");
  }
}

export function simulateUserType(el: HTMLElement, text: string): boolean {
  try {
    el.focus();
    const tag = el.tagName.toLowerCase();
    if (tag !== "textarea" && tag !== "input") return false;
    const inputEl = el as HTMLTextAreaElement;
    el.focus();
    const success = document.execCommand("insertText", false, text);
    if (success) {
      console.debug("[QwenProxy] execCommand insertText succeeded, length:", text.length);
      return true;
    }
    return false;
  } catch (e) {
    console.debug("[QwenProxy] execCommand failed:", e);
    return false;
  }
}
