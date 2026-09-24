// Location's section of Settings → Appearance: the search results list.
// Rows and buttons use the Appearance page's shared classes (Core's index.html).
const style = document.createElement('style');
style.dataset.extensionStyle = import.meta.url;
style.textContent = `
.loc-search { display: flex; gap: 6px; width: 100%; }
.loc-search input {
  flex: 1; min-width: 0; padding: 4px 8px; border-radius: 5px;
  border: 1px solid rgba(var(--ink-rgb),.12); background: rgba(var(--ink-rgb),.05);
  color: rgb(var(--ink-rgb)); font: inherit; font-size: .68rem; outline: none;
}
.loc-search input::placeholder { color: rgba(var(--ink-rgb),.3); }
.loc-search input:focus { border-color: rgba(var(--ink-rgb),.3); }
.loc-results { display: flex; flex-direction: column; gap: 2px; padding: 0 14px; }
.loc-results:empty { display: none; }
.loc-result {
  display: flex; align-items: baseline; gap: 8px; width: 100%; padding: 6px 8px;
  border: 0; border-radius: 5px; background: transparent; cursor: pointer; text-align: left;
  font: inherit; color: inherit;
}
.loc-result:hover, .loc-result:focus-visible { background: rgba(var(--ink-rgb),.08); outline: none; }
.loc-result-name { font-size: .7rem; color: rgba(var(--ink-rgb),.85); }
.loc-result-sub { font-size: .62rem; color: rgba(var(--ink-rgb),.35); }
.loc-status { padding: 2px 14px 0; min-height: 0; }
.loc-status:empty { display: none; }
`;
document.head.appendChild(style);
