// Remember rendered source, rather than comparing hydrated avatar markup.
const rendered = new WeakMap();
const key = node => node.nodeType === 1
  ? `${node.tagName}:${node.dataset.roomId || node.dataset.id || node.classList[0] || ''}`
  : `#${node.nodeType}`;

function reconcile(parent, desired) {
  const available = [...parent.childNodes];
  for (const [index, incoming] of [...desired.childNodes].entries()) {
    const match = available.find(node => key(node) === key(incoming));
    const signature = incoming.nodeType === 1 ? incoming.outerHTML : incoming.textContent;
    if (!match) {
      parent.insertBefore(incoming, parent.childNodes[index] || null);
      remember(incoming);
      continue;
    }
    available.splice(available.indexOf(match), 1);
    if (parent.childNodes[index] !== match) parent.insertBefore(match, parent.childNodes[index] || null);
    if (rendered.get(match) === signature) continue;
    if (match.nodeType === 1) {
      for (const attr of [...match.attributes]) {
        if (!incoming.hasAttribute(attr.name)) match.removeAttribute(attr.name);
      }
      for (const attr of [...incoming.attributes]) match.setAttribute(attr.name, attr.value);
      reconcile(match, incoming);
    } else {
      match.textContent = incoming.textContent;
    }
    rendered.set(match, signature);
  }
  for (const node of available) node.remove();
}

function remember(node) {
  rendered.set(node, node.nodeType === 1 ? node.outerHTML : node.textContent);
  for (const child of node.childNodes) remember(child);
}

/** Key room rows and rail buttons by identity; preserve unchanged DOM and scroll. */
export function reconcileMarkup(container, html) {
  const template = container.ownerDocument.createElement('template');
  template.innerHTML = html;
  reconcile(container, template.content);
}
