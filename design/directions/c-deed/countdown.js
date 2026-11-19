// Sample veto window: counts down from data-left seconds out of data-total. Real values come from WindowStarted.
for (const clock of document.querySelectorAll("[data-countdown]")) {
  const total = Number(clock.dataset.total);
  let left = Number(clock.dataset.left);
  const out = clock.querySelector("time");
  const track = document.querySelector(clock.dataset.track);
  const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  const paint = () => {
    out.textContent = fmt(left);
    out.setAttribute("datetime", `PT${Math.floor(left / 60)}M${left % 60}S`);
    if (track) track.style.setProperty("--elapsed", `${((total - left) / total) * 100}%`);
  };
  paint();
  if (!new URLSearchParams(location.search).has("still")) {
    const timer = setInterval(() => {
      left = Math.max(0, left - 1);
      paint();
      if (left === 0) clearInterval(timer);
    }, 1000);
  }
}
