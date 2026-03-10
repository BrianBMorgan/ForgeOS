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
  var submitBtn = form ? form.querySelector('button[type="submit"]') : null;

  if (form && success) {
    form.addEventListener('submit', function(e) {
      e.preventDefault();

      var name = (form.querySelector('#name').value || '').trim();
      var email = (form.querySelector('#email').value || '').trim();
      var message = (form.querySelector('#message').value || '').trim();

      if (!name || !email || !message) {
        return;
      }

      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Sending...';
      }

      success.setAttribute('hidden', '');
      success.style.color = '#4ade80';
      success.textContent = '';

      fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, email: email, message: message })
      })
      .then(function(res) { return res.json(); })
      .then(function(data) {
        if (data.ok) {
          success.textContent = 'Thanks! We\u2019ll be in touch soon.';
          success.style.color = '#4ade80';
          success.removeAttribute('hidden');
          form.reset();
          setTimeout(function() { success.setAttribute('hidden', ''); }, 5000);
        } else {
          success.textContent = data.error || 'Something went wrong. Please try again.';
          success.style.color = '#E94560';
          success.removeAttribute('hidden');
        }
      })
      .catch(function() {
        success.textContent = 'Something went wrong. Please try again.';
        success.style.color = '#E94560';
        success.removeAttribute('hidden');
      })
      .finally(function() {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Send Message';
        }
      });
    });
  }
})();
