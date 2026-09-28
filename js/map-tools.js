/* Native details supplies keyboard and expanded-state semantics without JS. */
(() => {
  const tools = document.getElementById("controls");
  const toggle = document.getElementById("map-tools-toggle");
  if (!tools || !toggle) return;
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && tools.open) {
      tools.open = false;
      toggle.focus();
      event.stopImmediatePropagation();
    }
  }, true);
  document.addEventListener("pointerdown", (event) => {
    if (tools.open && !tools.contains(event.target)) tools.open = false;
  });
  const coverage = document.getElementById('coverage-section');
  let loading = false, loaded = false;
  if (coverage) coverage.addEventListener('toggle', async () => {
    if (!coverage.open || loading || loaded) return;
    loading = true;
    const output = document.getElementById('coverage-report');
    output.textContent = 'Loading catalogue…';
    try {
      const response = await fetch('data/coverage.json');
      if (!response.ok) throw new Error('unavailable');
      const report = await response.json();
      output.textContent = `${report.indexed.toLocaleString()} indexed cameras. ${report.note}`;
      for (const source of report.sources) {
        const row = document.createElement('p');
        row.textContent = `${source.name}: ${source.indexed.toLocaleString()} indexed · ` +
          Object.entries(source.types).map(([type, count]) => `${count} ${type}`).join(' · ');
        if (source.page) {
          const url = new URL(source.page);
          if (url.protocol === 'https:' && !url.search && !url.username && !url.password) {
            const link = document.createElement('a');
            link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
            link.textContent = ' Source'; row.append(link);
          }
        }
        output.append(row);
      }
      loaded = true;
    } catch { output.textContent = 'Coverage report unavailable. Close and reopen to retry.'; }
    finally { loading = false; }
  });
})();
