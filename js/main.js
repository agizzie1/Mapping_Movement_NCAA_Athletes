function initContactToggle() {
  const button = document.getElementById('contact-toggle');
  const card = document.getElementById('contact-card');
  if (!button || !card) return;
  button.addEventListener('click', () => {
    card.classList.toggle('open');
  });
}

document.addEventListener('DOMContentLoaded', initContactToggle);
