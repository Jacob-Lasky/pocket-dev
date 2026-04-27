// pocket-dev View mode renderer
// Takes ANSI-bearing text (typically from xterm.js's serialize addon) and
// renders it as styled HTML into a content element with sticky-bottom scroll.

const STICKY_BOTTOM_THRESHOLD_PX = 50;

export class ViewRenderer {
  constructor({ scrollEl, contentEl, ansiUp }) {
    this.scrollEl = scrollEl;
    this.contentEl = contentEl;
    this.ansiUp = ansiUp;
  }

  isAtBottom() {
    const { scrollTop, scrollHeight, clientHeight } = this.scrollEl;
    return scrollHeight - (scrollTop + clientHeight) <= STICKY_BOTTOM_THRESHOLD_PX;
  }

  scrollToBottom() {
    this.scrollEl.scrollTop = this.scrollEl.scrollHeight - this.scrollEl.clientHeight;
  }

  update(text) {
    const wasAtBottom = this.isAtBottom();
    this.contentEl.innerHTML = this.ansiUp.ansi_to_html(text);
    if (wasAtBottom) this.scrollToBottom();
  }
}
