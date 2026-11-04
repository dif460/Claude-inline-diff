// A tiny canvas starfield just for visual noise.
const canvas = document.getElementById('sky');
const ctx = canvas.getContext('2d');

const stars = Array.from({ length: 320 }, () => ({
  x: Math.random() * canvas.width,
  y: Math.random() * canvas.height,
  r: Math.random() * 2.2 + 0.1,
  hue: 180 + Math.random() * 90,
  drift: (Math.random() - 0.5) * 0.3,
  twinkle: Math.random() * Math.PI * 2,
}));

function frame(t) {
  ctx.fillStyle = 'rgba(6, 9, 24, 0.35)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (const s of stars) {
    s.x = (s.x + s.drift + canvas.width) % canvas.width;
    const glow = (Math.sin(t / 700 + s.twinkle) + 1) / 2;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fillStyle = `hsla(${s.hue}, 70%, 82%, ${0.25 + glow * 0.75})`;
    ctx.fill();
  }
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
