'use strict';

/** This guide changes local presentation only. It has no backend or model calls. */
function createTabs(name, onChange) {
  const group = document.querySelector(`[data-tab-group="${name}"]`);
  if (!group) return null;
  const tabs = [...group.querySelectorAll('[role="tab"]')];
  let selected = Math.max(
    0,
    tabs.findIndex((tab) => tab.getAttribute('aria-selected') === 'true'),
  );
  function select(index, focus = false) {
    selected = Math.max(0, Math.min(tabs.length - 1, index));
    tabs.forEach((tab, position) => {
      const active = position === selected;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      const panel = document.getElementById(tab.getAttribute('aria-controls'));
      if (panel) panel.hidden = !active;
    });
    if (focus) tabs[selected].focus();
    onChange?.(selected, tabs.length);
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => select(index));
    tab.addEventListener('keydown', (event) => {
      let destination;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown')
        destination = (selected + 1) % tabs.length;
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
        destination = (selected - 1 + tabs.length) % tabs.length;
      else if (event.key === 'Home') destination = 0;
      else if (event.key === 'End') destination = tabs.length - 1;
      if (destination === undefined) return;
      event.preventDefault();
      select(destination, true);
    });
  });
  select(selected);
  return {
    select,
    get selected() {
      return selected;
    },
  };
}

createTabs('product', (index, total) => {
  const counter = document.getElementById('tour-counter');
  if (counter)
    counter.textContent = `${String(index + 1).padStart(2, '0')} / ${String(total).padStart(2, '0')}`;
});

const previous = document.getElementById('story-previous');
const next = document.getElementById('story-next');
const story = createTabs('story', (index, total) => {
  const counter = document.getElementById('story-counter');
  const fill = document.getElementById('story-progress-fill');
  if (counter) counter.textContent = `步骤 ${index + 1} / ${total}`;
  if (fill) fill.style.width = `${((index + 1) / total) * 100}%`;
  if (previous) previous.disabled = index === 0;
  if (next) next.disabled = index === total - 1;
});
previous?.addEventListener('click', () => story?.select(story.selected - 1));
next?.addEventListener('click', () => story?.select(story.selected + 1));

const imageDialog = document.getElementById('image-dialog');
const zoomImage = document.getElementById('zoom-image');
const zoomTitle = document.getElementById('image-dialog-title');
const closeImage = document.getElementById('close-image');
let imageTrigger = null;

document.querySelectorAll('[data-zoom]').forEach((button) => {
  const screenshot = button.querySelector('img');
  const fallback = button.querySelector('.capture-fallback');
  const hint = button.querySelector('.capture-zoom');
  if (!screenshot) return;
  const unavailable = () => {
    screenshot.hidden = true;
    if (fallback) fallback.hidden = false;
    if (hint) hint.hidden = true;
    button.disabled = true;
  };
  const available = () => {
    screenshot.hidden = false;
    if (fallback) fallback.hidden = true;
    if (hint) hint.hidden = false;
    button.disabled = false;
  };
  screenshot.addEventListener('error', unavailable);
  screenshot.addEventListener('load', available);
  if (screenshot.complete && screenshot.naturalWidth) available();
  else if (screenshot.complete && screenshot.loading !== 'lazy') unavailable();
  button.addEventListener('click', () => {
    if (!screenshot.naturalWidth || !imageDialog || !zoomImage || !zoomTitle) return;
    imageTrigger = button;
    zoomImage.src = screenshot.getAttribute('src');
    zoomImage.alt = screenshot.alt;
    zoomTitle.textContent = screenshot.alt;
    imageDialog.showModal();
    closeImage?.focus();
  });
});
closeImage?.addEventListener('click', () => imageDialog?.close());
imageDialog?.addEventListener('close', () => imageTrigger?.focus());
imageDialog?.addEventListener('click', (event) => {
  if (event.target !== imageDialog) return;
  const bounds = imageDialog.getBoundingClientRect();
  if (
    event.clientX < bounds.left ||
    event.clientX > bounds.right ||
    event.clientY < bounds.top ||
    event.clientY > bounds.bottom
  )
    imageDialog.close();
});
