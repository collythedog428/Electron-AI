// Spark, the animated helper. It responds with its face and body only: no text bubble.
// app.js sets the mood as things happen (sending, replies, errors, the mic and so on).
const Mascot = (() => {
  const root = document.getElementById("mascot");
  let moodTimer = null;
  let sleepTimer = null;
  const SLEEP_AFTER_MS = 90 * 1000;

  function setMood(mood, { hold = 0 } = {}) {
    if (!root) return;
    root.dataset.mood = mood;
    clearTimeout(moodTimer);
    if (hold) moodTimer = setTimeout(() => setMood("idle"), hold);
    resetSleepTimer();
  }

  // Any activity wakes Spark; a long quiet spell makes it sleepy.
  function resetSleepTimer() {
    clearTimeout(sleepTimer);
    sleepTimer = setTimeout(() => {
      if (root?.dataset.mood === "idle") setMood("sleepy");
    }, SLEEP_AFTER_MS);
  }

  // Click: a little wave.
  root?.addEventListener("click", () => setMood("wave", { hold: 2500 }));

  resetSleepTimer();
  return {
    // The text argument is accepted for compatibility but no longer shown.
    set: (mood, options = {}) => setMood(mood, { hold: options.hold ?? 0 }),
    say: (_text, mood = "happy") => setMood(mood, { hold: 3500 }),
  };
})();
