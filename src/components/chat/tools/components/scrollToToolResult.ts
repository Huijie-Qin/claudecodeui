/** Keep tool-result navigation inside its own conversation, without URL navigation. */
export function scrollToToolResult(trigger: HTMLElement, resultId: string): void {
  const message = trigger.closest('.chat-message');
  // A subagent timeline can render the same tool ID as the main conversation.
  // Compare IDs directly so IDs containing CSS selector characters also work.
  const target = Array.from(message?.querySelectorAll<HTMLElement>('[id]') ?? [])
    .find((element) => element.id === resultId);
  const view = trigger.ownerDocument.defaultView;
  if (!target || !view) return;

  for (let container = target.parentElement; container; container = container.parentElement) {
    if (!/^(auto|scroll)$/.test(view.getComputedStyle(container).overflowY)) continue;

    // Native anchors and scrollIntoView can also scroll overflow-hidden layout
    // ancestors, clipping the conversation. Move only the message scrollport.
    container.scrollTo({
      top: Math.max(0, container.scrollTop + target.getBoundingClientRect().top
        - container.getBoundingClientRect().top - container.clientTop - 16),
      behavior: 'instant',
    });
    return;
  }
}
