// A very small stand-in for the DOM: just enough for el() and the helpers that build elements.
class FakeNode {
  constructor(tag) {
    this.tag = tag;
    this.attrs = {};
    this.children = [];
    this.dataset = {};
    this.className = '';
    this.textContent = '';
    this.listeners = {};
  }

  setAttribute(key, value) { this.attrs[key] = value; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  append(...kids) { this.children.push(...kids); }
  replaceChildren(...kids) { this.children = kids; }
}

export const fakeDoc = () => ({
  createElement: (tag) => new FakeNode(tag),
  createTextNode: (text) => ({ text })
});
