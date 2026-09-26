// Keep native controls responsive while collapsing expensive chart updates.
export function bindDragPreview(element, context, preview, commit, delay = 80) {
  let timer = null, pending = false, latest;
  let applied = element.value;
  const flush = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (!pending) return;
    pending = false;
    if (latest === applied) return;
    applied = latest;
    commit(latest);
  };
  context.listen(element, 'input', () => {
    latest = element.value;
    preview(latest);
    pending = true;
    if (timer === null) timer = setTimeout(flush, delay);
  });
  context.listen(element, 'change', () => {
    latest = element.value;
    preview(latest);
    pending = true;
    flush();
  });
  context.listen(element, 'blur', flush);
  context.onCleanup(flush);
}
