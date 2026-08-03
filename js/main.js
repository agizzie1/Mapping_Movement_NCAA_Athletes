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

document.addEventListener('DOMContentLoaded', initContactToggle);
document.addEventListener('DOMContentLoaded', initContextToggle);
document.addEventListener('DOMContentLoaded', initArtifactAutoHeight);
