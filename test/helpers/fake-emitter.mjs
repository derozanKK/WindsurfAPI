// Minimal event emitter shared by the offline fakes in this directory. Test
// doubles for node streams need the same handful of methods the product uses
// (on/once/off/removeListener/emit/listenerCount), so "how many of the helper's
// own listeners are still attached" stays observable.
export class FakeEmitter {
  constructor() {
    this.listeners = new Map();
  }

  on(event, fn) {
    const list = this.listeners.get(event) || [];
    list.push(fn);
    this.listeners.set(event, list);
    return this;
  }

  once(event, fn) {
    const wrapper = (...args) => {
      this.removeListener(event, wrapper);
      fn(...args);
    };
    return this.on(event, wrapper);
  }

  off(event, fn) {
    return this.removeListener(event, fn);
  }

  removeListener(event, fn) {
    const list = this.listeners.get(event);
    if (list) {
      const at = list.indexOf(fn);
      if (at >= 0) list.splice(at, 1);
    }
    return this;
  }

  emit(event, ...args) {
    for (const fn of [...(this.listeners.get(event) || [])]) fn(...args);
    return this;
  }

  listenerCount(event) {
    return (this.listeners.get(event) || []).length;
  }
}
