(function() {
  var container = document.getElementById('heroSlideshow');
  if (!container) return;
  var slides = container.querySelectorAll('img');
  if (slides.length < 2) { slides[0].style.opacity = '1'; return; }
  var current = 0;
  slides[0].classList.add('active');
  setInterval(function() {
    slides[current].classList.remove('active');
    current = (current + 1) % slides.length;
    slides[current].classList.add('active');
  }, 4000);
})();
