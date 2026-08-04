function initContactToggle() {
  const button = document.getElementById('contact-toggle');
  const card = document.getElementById('contact-card');
  if (!button || !card) return;
  button.addEventListener('click', () => {
    card.classList.toggle('open');
  });
}

function initContextToggle() {
  const button = document.getElementById('context-toggle');
  const wrap = document.getElementById('context-wrap');
  if (!button || !wrap) return;
  button.addEventListener('click', () => {
    const expanded = wrap.classList.toggle('expanded');
    button.textContent = expanded ? 'Show less' : 'Show more';
    button.setAttribute('aria-expanded', expanded);
  });
}

// The artifact iframes are same-origin (GitHub Pages serves the site and
// artifact/ under the same host), so their own document is directly
// readable from here -- no postMessage needed. Polls the iframe's real
// content height and keeps the element in sync with it, so the page has
// one continuous scrollbar instead of a fixed-height box that wastes
// space or clips content into its own inner scrollbar.
//
// This polls rather than reacting to a single "load" event or a
// ResizeObserver for two reasons, both confirmed while building this:
// (1) the artifact fetches its own chart data asynchronously and keeps
// growing well after the iframe's "load" event already fired, so a
// one-shot measurement at load time captures a too-small height: and
// (2) a ResizeObserver watching the iframe's document from here doesn't
// reliably fire for pure scrollHeight/overflow growth (confirmed even
// for a same-document test) -- likely because layout/paint in a
// background or automated tab is throttled independently of scrollHeight
// actually changing. Polling sidesteps both: it just re-checks the real
// number on an interval and only touches the DOM when it actually moved.
function initArtifactAutoHeight() {
  const frames = document.querySelectorAll('iframe.artifact-frame');
  frames.forEach(iframe => {
    let lastHeight = null;
    setInterval(() => {
      const doc = iframe.contentDocument;
      if (!doc || !doc.documentElement) return;
      const height = doc.documentElement.scrollHeight;
      if (height !== lastHeight) {
        lastHeight = height;
        iframe.style.height = height + 'px';
      }
    }, 400);
  });
}

// Lets the FBS/FCS/combined-view mentions in the description (see
// .jump-link in football.html) jump straight to that panel inside the
// embedded artifact instead of leaving the reader to scroll and hunt for
// it. Same-origin iframe (see initArtifactAutoHeight above), so its
// document is directly reachable -- no postMessage needed here either.
function jumpToArtifactTarget(target) {
  const frame = document.querySelector('iframe.artifact-frame');
  const doc = frame && frame.contentDocument;
  if (!doc) return;

  const wantsSeparate = target === 'fbs' || target === 'fcs';
  const tabBtn = doc.querySelector(`.tab-btn[data-view="${wantsSeparate ? 'separate' : 'combined'}"]`);
  if (tabBtn && !tabBtn.classList.contains('active')) tabBtn.click();

  const panelId = target === 'fbs' ? 'panel-fbs' : target === 'fcs' ? 'panel-fcs' : 'panel-combined';
  const panel = doc.getElementById(panelId);
  if (!panel) return;

  // Both rects are viewport-relative -- the frame's own position on THIS
  // page, and the panel's position within the iframe's own layout
  // viewport (always starts at 0 since scrolling="no" keeps the iframe
  // exactly as tall as its content, never internally scrolled). Adding
  // them converts the panel's position into this page's own scroll
  // coordinates.
  const frameRect = frame.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  const targetY = window.scrollY + frameRect.top + panelRect.top - 24;
  window.scrollTo({ top: targetY, behavior: 'smooth' });

  // Restart the flash even if this same panel was just flashed a moment
  // ago (e.g. clicking FBS twice in a row).
  panel.classList.remove('jump-highlight');
  void panel.offsetWidth;
  panel.classList.add('jump-highlight');
}

function initJumpLinks() {
  document.querySelectorAll('.jump-link[data-jump]').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      jumpToArtifactTarget(link.dataset.jump);
    });
  });
}

document.addEventListener('DOMContentLoaded', initContactToggle);
document.addEventListener('DOMContentLoaded', initContextToggle);
document.addEventListener('DOMContentLoaded', initArtifactAutoHeight);
document.addEventListener('DOMContentLoaded', initJumpLinks);
