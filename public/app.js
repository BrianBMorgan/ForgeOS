(function() {
  // Mobile nav toggle
  var toggle = document.getElementById('nav-toggle');
  var links = document.getElementById('nav-links');
  if (toggle && links) {
    toggle.addEventListener('click', function() {
      links.classList.toggle('open');
    });
    links.querySelectorAll('a').forEach(function(a) {
      a.addEventListener('click', function() {
        links.classList.remove('open');
      });
    });
  }

  // Scroll reveal
  var revealEls = document.querySelectorAll('.service-card, .about-text, .about-images, .contact-text, .contact-form');
  revealEls.forEach(function(el) { el.classList.add('reveal'); });

  function checkReveal() {
    revealEls.forEach(function(el) {
      var rect = el.getBoundingClientRect();
      if (rect.top < window.innerHeight - 60) {
        el.classList.add('visible');
      }
    });
  }
  window.addEventListener('scroll', checkReveal, { passive: true });
  checkReveal();

  // Contact form
  var form = document.getElementById('contact-form');
  var success = document.getElementById('form-success');
  if (form && success) {
    form.addEventListener('submit', function(e) {
      e.preventDefault();
      success.removeAttribute('hidden');
      form.reset();
      setTimeout(function() { success.setAttribute('hidden', ''); }, 5000);
    });
  }
})();
