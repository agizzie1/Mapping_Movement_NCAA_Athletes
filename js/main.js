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

document.addEventListener('DOMContentLoaded', initContactToggle);
document.addEventListener('DOMContentLoaded', initContextToggle);
