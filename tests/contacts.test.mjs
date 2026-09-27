import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function element() {
  const handlers = new Map();
  const classes = new Set(['hidden']);
  return {
    children: [], textContent: '',
    classList: {
      add: key => classes.add(key), remove: key => classes.delete(key),
      contains: key => classes.has(key),
    },
    addEventListener: (name, cb) => handlers.set(name, cb),
    dispatch: (name, event) => handlers.get(name)?.(event),
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children.flatMap(child => child?.fragment || [child]); },
    focus() { this.focused = true; },
  };
}

test('contact panel shows safe text, selects the requested contact, and closes on Escape', () => {
  const nodes = Object.fromEntries(['contacts-panel', 'contacts-title', 'contacts-list', 'contacts-close']
    .map(id => [id, element()]));
  const document = {
    getElementById: id => nodes[id], createElement: () => element(),
    createDocumentFragment: () => ({ fragment: [], append(child) { this.fragment.push(child); } }),
    addEventListener(name, cb) { this[name] = cb; },
  };
  const context = vm.createContext({ document });
  vm.runInContext(readFileSync(new URL('../js/contacts.js', import.meta.url), 'utf8'), context);
  const contacts = vm.runInContext('Contacts', context);
  let picked;
  contacts.open('16 CAMERAS', [{ label: '<script>camera</script>', detail: 'London', id: 'cam-1' }], row => { picked = row.id; });
  assert.equal(nodes['contacts-panel'].classList.contains('hidden'), false);
  assert.equal(nodes['contacts-title'].textContent, '16 CAMERAS');
  const row = nodes['contacts-list'].children[0];
  assert.equal(row.children[0].textContent, '<script>camera</script>');
  assert.equal(row.children[1].textContent, 'London');
  row.dispatch('click');
  assert.equal(picked, 'cam-1');
  assert.equal(nodes['contacts-panel'].classList.contains('hidden'), true);
  contacts.open('VESSELS', [], () => {});
  assert.match(nodes['contacts-list'].children[0].textContent, /No contacts/);
  document.keydown({ key: 'Escape' });
  assert.equal(nodes['contacts-panel'].classList.contains('hidden'), true);
});
