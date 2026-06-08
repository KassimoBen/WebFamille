let currentPhotoId = 0;
function openLightbox(photoId) {
  currentPhotoId = photoId;
  const el = document.querySelector(`[data-photo-id="${photoId}"]`);
  if (!el) return;
  const lb = document.getElementById('lightbox');
  const imgEl = document.getElementById('lightboxImg');
  const iframeEl = document.getElementById('lightboxVideo');
  const videoEl = document.getElementById('lightboxLocalVideo');
  const localVideo = el.dataset.localVideo;
  const ytVideo = el.dataset.video;
  imgEl.style.display = 'none'; iframeEl.style.display = 'none'; videoEl.style.display = 'none';
  iframeEl.src = ''; videoEl.pause ? videoEl.pause() : 0; videoEl.src = '';
  if (localVideo) {
    videoEl.style.display = 'block';
    videoEl.src = localVideo;
  } else if (ytVideo) {
    iframeEl.style.display = 'block';
    iframeEl.src = ytVideo;
  } else {
    const img = el.querySelector('img');
    imgEl.style.display = 'block';
    imgEl.src = img.src;
  }
  document.getElementById('commentPhotoId').value = photoId;
  document.getElementById('commentInput').value = '';
  document.getElementById('lightboxComments').innerHTML = '<div class="muted">Chargement...</div>';
  lb.classList.add('active');
  document.body.style.overflow = 'hidden';
  fetchComments(photoId);
}
function closeLightbox() {
  const videoEl = document.getElementById('lightboxLocalVideo');
  videoEl.pause ? videoEl.pause() : 0;
  document.getElementById('lightbox').classList.remove('active');
  document.body.style.overflow = '';
}
function fetchComments(photoId) {
  fetch('/api/comments/' + photoId)
    .then(r => r.json())
    .then(data => {
      const container = document.getElementById('lightboxComments');
      if (data.length === 0) { container.innerHTML = '<div class="muted">Aucun commentaire.</div>'; return }
      container.innerHTML = data.map(c =>
        `<div class="comment-item"><strong>${escapeHtml(c.nom_complet)}</strong> ${escapeHtml(c.contenu)} <span class="muted" style="font-size:11px">${c.created_at}</span></div>`
      ).join('');
    });
}
function submitComment(e) {
  e.preventDefault();
  const photoId = document.getElementById('commentPhotoId').value;
  const input = document.getElementById('commentInput');
  const contenu = input.value.trim();
  if (!contenu) return false;
  fetch('/api/comments/' + photoId, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contenu })
  }).then(r => {
    if (r.status === 200) {
      input.value = '';
      fetchComments(photoId);
    } else { alert('Erreur lors de l\'envoi.'); }
  });
  return false;
}
function escapeHtml(t) { return String(t).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;') }
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeLightbox(); closeAvatarLightbox() } });

function openAvatarLightbox(url) {
  const lb = document.getElementById('avatarLightbox');
  document.getElementById('avatarLightboxImg').src = url;
  lb.classList.add('active');
  document.body.style.overflow = 'hidden';
}
function closeAvatarLightbox() {
  document.getElementById('avatarLightbox').classList.remove('active');
  document.body.style.overflow = '';
}
