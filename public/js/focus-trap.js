// ---------- Focus trap (accessibility) ----------
// Keeps Tab/Shift+Tab cycling inside the active modal instead of leaking
// focus out to the page behind it. One trap is active at a time.
// This module owns its own small piece of state (activeFocusTrap); it does
// not touch any other app state, so it's safe to import independently.

let activeFocusTrap = null;

function getFocusableEls(container) {
  const selector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return Array.from(container.querySelectorAll(selector)).filter(el => el.offsetParent !== null);
}

export function trapFocus(container, restoreEl) {
  activeFocusTrap = { container, restoreEl: restoreEl || document.activeElement };
  const focusable = getFocusableEls(container);
  if (focusable.length > 0) focusable[0].focus();
}

export function releaseFocusTrap() {
  if (activeFocusTrap && activeFocusTrap.restoreEl && document.body.contains(activeFocusTrap.restoreEl)) {
    activeFocusTrap.restoreEl.focus();
  }
  activeFocusTrap = null;
}

export function setupGlobalFocusTrapHandler() {
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || !activeFocusTrap) return;
    const focusable = getFocusableEls(activeFocusTrap.container);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    } else if (!activeFocusTrap.container.contains(document.activeElement)) {
      // Focus somehow escaped the trap (e.g. programmatic focus elsewhere) — pull it back in.
      e.preventDefault();
      first.focus();
    }
  });
}
