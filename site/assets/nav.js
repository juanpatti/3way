// The Demos disclosure in the masthead: one button, two destinations, no dependencies.
// Click toggles it; Escape, a click elsewhere, or focus leaving the menu closes it.
(() => {
  const root = document.querySelector('.nav-demos');
  if (!root) return;
  const button = root.querySelector('.nav-demos__btn');
  const menu = root.querySelector('.nav-demos__menu');
  const set = (open) => {
    button.setAttribute('aria-expanded', String(open));
    menu.hidden = !open;
  };
  button.addEventListener('click', () => set(menu.hidden));
  document.addEventListener('click', (event) => {
    if (!root.contains(event.target)) set(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !menu.hidden) { set(false); button.focus(); }
  });
  root.addEventListener('focusout', (event) => {
    if (!root.contains(event.relatedTarget)) set(false);
  });
})();
