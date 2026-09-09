// Keep selection in xterm so wide glyphs, soft wraps and terminal colors have
// one owner. Desktop drags use xterm's built-in forced-selection gesture.
// Touch adds a long press and handles through the public selection API.
import { clipboardWrite } from './clipboard.js';

export class LiveSelection {
  constructor({ term, pane, mouseTracking }) {
    this.term = term;
    this.pane = pane;
    this.screen = pane.querySelector('.xterm-screen');
    this.mouseTracking = mouseTracking;
    this.touchSelecting = false;
    this.synthetic = new WeakSet();
    this.abort = new AbortController();
    const listen = (el, name, fn, options = {}) => el.addEventListener(name, fn, { ...options, signal: this.abort.signal });
    this.menu = document.createElement('div');
    this.menu.className = 'selection-tools';
    this.menu.hidden = true;
    for (const [label, action] of [
      ['Copy', async () => {
        const ok = await clipboardWrite(term.getSelection());
        this.menu.firstChild.textContent = ok ? 'Copied' : 'Try again';
      }],
      ['Done', () => this.clear()],
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      listen(button, 'click', action);
      this.menu.appendChild(button);
    }
    pane.appendChild(this.menu);
    this.handles = ['start', 'end'].map(edge => {
      const handle = document.createElement('button');
      handle.type = 'button';
      handle.className = `selection-handle selection-${edge}`;
      handle.setAttribute('aria-label', `Move selection ${edge}`);
      handle.hidden = true;
      pane.appendChild(handle);
      listen(handle, 'pointerdown', e => {
        e.preventDefault();
        e.stopPropagation();
        const rect = this.screen.getBoundingClientRect();
        const point = edge === 'start' ? this.start : this.end;
        this.handleOffset = {
          x: e.clientX - (rect.left + (point.x - (edge === 'end' ? 1 : 0) + .5) * rect.width / term.cols),
          y: e.clientY - (rect.top + (point.y - term.buffer.active.viewportY + .5) * rect.height / term.rows),
        };
        handle.setPointerCapture(e.pointerId);
      });
      listen(handle, 'pointermove', e => {
        if (!handle.hasPointerCapture(e.pointerId)) return;
        e.preventDefault();
        this.extend(e.clientX - this.handleOffset.x, e.clientY - this.handleOffset.y, edge);
      });
      listen(handle, 'pointerup', e => {
        if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
      });
      return handle;
    });
    listen(pane, 'mousedown', e => this.mouseDown(e), { capture: true });
    listen(document, 'mousemove', e => this.mouseMove(e), { capture: true });
    listen(document, 'mouseup', e => this.mouseUp(e), { capture: true });
    listen(pane, 'contextmenu', e => {
      if (this.touchSelecting) e.preventDefault();
    });
    this.subscription = term.onSelectionChange(() => this.update());
    this.resizeSubscription = term.onResize(() => this.clear());
    this.renderSubscription = term.onRender(() => this.update());
  }

  emitMouse(type, event, force = false) {
    const copy = new MouseEvent(type, {
      bubbles: true, cancelable: true, view: window,
      clientX: event.clientX, clientY: event.clientY,
      button: event.button, buttons: type === 'mouseup' ? 0 : 1,
      detail: event.detail || 1,
      // macOS uses Option, other platforms use Shift for forced selection.
      shiftKey: force || event.shiftKey,
      altKey: (force && /Mac/.test(navigator.platform)) || event.altKey,
      ctrlKey: event.ctrlKey, metaKey: event.metaKey,
    });
    this.synthetic.add(copy);
    this.screen.dispatchEvent(copy);
  }

  mouseDown(e) {
    if (this.synthetic.has(e) || !this.screen.contains(e.target)) return;
    if (this.touchSelecting) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    // A short tap is still an application click. Dragging prevented touchmove's
    // default already, so only genuine taps generate compatibility mouse-down.
    if (e.sourceCapabilities?.firesTouchEvents || Date.now() - (this.lastTouch || 0) < 700) return;
    if (!this.mouseTracking() || e.button !== 0 || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
    // Delay only mouse-tracking clicks until we know click versus drag. A click
    // still reaches TUI menus; a drag becomes selection without a modifier.
    e.preventDefault();
    e.stopImmediatePropagation();
    this.pending = e;
  }

  mouseMove(e) {
    // Mouse-tracking TUIs treat hover as input, and xterm clears selection on
    // input. This also catches the compatibility mousemove generated when a
    // finger lifts, before its mousedown can be suppressed.
    if (this.screen.contains(e.target) && (this.touchSelecting ||
        (this.term.hasSelection() && !e.buttons) || e.sourceCapabilities?.firesTouchEvents)) {
      e.stopImmediatePropagation();
      return;
    }
    if (!this.pending || Math.hypot(e.clientX - this.pending.clientX, e.clientY - this.pending.clientY) < 4) return;
    const down = this.pending;
    this.pending = null;
    this.emitMouse('mousedown', down, true);
  }

  mouseUp(e) {
    if (this.synthetic.has(e) || !this.pending) return;
    const down = this.pending;
    this.pending = null;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.emitMouse('mousedown', down);
    this.emitMouse('mouseup', e);
  }

  point(clientX, clientY) {
    const r = this.screen.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(this.term.cols - 1, Math.floor((clientX - r.left) / (r.width / this.term.cols)))),
      y: this.term.buffer.active.viewportY + Math.max(0, Math.min(this.term.rows - 1, Math.floor((clientY - r.top) / (r.height / this.term.rows)))),
    };
  }

  touchStart(e) {
    this.cancelPress();
    this.lastTouch = Date.now();
    if (e.touches.length !== 1 || e.target.closest('.selection-tools, .selection-handle')) return false;
    // Mobile text editing belongs to the visible composer. Focusing xterm's
    // invisible textarea must not summon a second keyboard on a long press.
    this.term.textarea.readOnly = true;
    const t = e.touches[0];
    this.pressPoint = { x: t.clientX, y: t.clientY };
    this.pressTimer = setTimeout(() => {
      this.pressTimer = null;
      const { x, y } = this.point(t.clientX, t.clientY);
      const line = this.term.buffer.active.getLine(y);
      if (!line) return;
      const isWord = col => {
        const cell = line.getCell(col);
        return cell?.getWidth() === 0 || !/\s/.test(cell?.getChars() || ' ');
      };
      let start = x, end = x + 1;
      if (isWord(x)) {
        while (start > 0 && isWord(start - 1)) start--;
        while (end < this.term.cols && isWord(end)) end++;
      }
      this.touchSelecting = true;
      this.start = { x: start, y };
      this.end = { x: end, y };
      this.apply();
      this.menu.firstChild.textContent = 'Copy';
    }, 450);
    return true;
  }

  touchMove(e) {
    if (e.touches.length !== 1) { this.cancelPress(); return false; }
    if (e.target.closest('.selection-tools, .selection-handle')) return true;
    const t = e.touches[0];
    if (this.touchSelecting) {
      this.extend(t.clientX, t.clientY, 'end');
      return true;
    }
    if (this.pressPoint && Math.hypot(t.clientX - this.pressPoint.x, t.clientY - this.pressPoint.y) >= 8) this.cancelPress();
    return false;
  }

  cancelPress() { clearTimeout(this.pressTimer); this.pressTimer = null; }

  touchEnd(e) {
    const tap = this.pressTimer != null && e.type === 'touchend' && e.touches.length === 0;
    this.cancelPress();
    this.lastTouch = Date.now();
    if (tap) {
      const point = { clientX: this.pressPoint.x, clientY: this.pressPoint.y, button: 0 };
      this.emitMouse('mousedown', point);
      this.emitMouse('mouseup', point);
    }
    // A long press can outlast the compatibility-mouse suppression window.
    // Suppress its generated click, which otherwise clears xterm's selection.
    if ((tap || this.touchSelecting) && !e.target.closest('.selection-tools, .selection-handle')) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  extend(x, y, edge) {
    if (!this.start || !this.end) return;
    const p = this.point(x, y);
    const width = this.term.buffer.active.getLine(p.y)?.getCell(p.x)?.getWidth();
    if (edge === 'start' && width === 0) p.x = Math.max(0, p.x - 1);
    if (edge === 'end') p.x += width === 2 ? 2 : 1;
    const index = point => point.y * this.term.cols + point.x;
    if (edge === 'start' && index(p) < index(this.end)) this.start = p;
    if (edge === 'end' && index(p) > index(this.start)) this.end = p;
    this.apply();
  }

  apply() {
    this.term.select(this.start.x, this.start.y,
      (this.end.y - this.start.y) * this.term.cols + this.end.x - this.start.x);
    this.update();
  }

  update() {
    const visible = this.touchSelecting && this.term.hasSelection();
    this.menu.hidden = !visible;
    if (!visible) {
      this.handles.forEach(h => { h.hidden = true; });
      if (!this.term.hasSelection()) this.touchSelecting = false;
      return;
    }
    const r = this.screen.getBoundingClientRect(), p = this.pane.getBoundingClientRect();
    [this.start, this.end].forEach((point, i) => {
      const row = point.y - this.term.buffer.active.viewportY;
      this.handles[i].hidden = row < 0 || row >= this.term.rows;
      this.handles[i].style.left = `${Math.max(22, Math.min(p.width - 22, r.left - p.left + point.x * r.width / this.term.cols))}px`;
      this.handles[i].style.top = `${Math.min(p.height - 44, r.top - p.top + (row + 1) * r.height / this.term.rows)}px`;
    });
    // Short words near an edge otherwise put two 44px targets on top of each
    // other. Keep both handles reachable, including on the very first row.
    const [a, b] = this.handles.map(h => ({ x: parseFloat(h.style.left), y: parseFloat(h.style.top) }));
    if (Math.abs(a.x - b.x) < 44 && Math.abs(a.y - b.y) < 44) {
      if (a.y >= 44) this.handles[0].style.top = `${a.y - 44}px`;
      else this.handles[1].style.top = `${Math.min(p.height - 44, a.y + 44)}px`;
    }
  }

  clear() {
    this.cancelPress();
    this.touchSelecting = false;
    this.pending = null;
    this.term.clearSelection();
    this.update();
  }

  dispose() {
    this.cancelPress();
    this.abort.abort();
    this.subscription.dispose();
    this.resizeSubscription.dispose();
    this.renderSubscription.dispose();
    this.menu.remove();
    this.handles.forEach(h => h.remove());
  }
}
