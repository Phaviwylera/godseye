/* Shared, accessible list for map contacts (aircraft, vessels, camera clusters). */
const Contacts = (() => {
  const panel = document.getElementById('contacts-panel');
  const title = document.getElementById('contacts-title');
  const list = document.getElementById('contacts-list');
  document.getElementById('contacts-close').addEventListener('click', close);
  function close() { panel.classList.add('hidden'); list.replaceChildren(); }
  function open(heading, rows, onSelect) {
    title.textContent = heading;
    const fragment = document.createDocumentFragment();
    rows.slice(0, 100).forEach((row, index) => {
      const item = document.createElement('button');
      item.type = 'button'; item.className = 'contact-row';
      const name = document.createElement('strong'); name.textContent = row.label;
      const detail = document.createElement('small'); detail.textContent = row.detail || '';
      item.append(name, detail);
      item.addEventListener('click', () => { onSelect(row, index); close(); });
      fragment.append(item);
    });
    if (rows.length > 100) {
      const more = document.createElement('div'); more.className = 'contact-note';
      more.textContent = `Showing 100 of ${rows.length}. Zoom closer for more.`;
      fragment.append(more);
    }
    if (!rows.length) {
      const empty = document.createElement('div'); empty.className = 'contact-note';
      empty.textContent = 'No contacts in the current sample. Move the map and try again.';
      fragment.append(empty);
    }
    list.replaceChildren(fragment);
    panel.classList.remove('hidden');
    document.getElementById('contacts-close').focus({ preventScroll: true });
  }
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !panel.classList.contains('hidden')) close(); });
  return { open, close };
})();
