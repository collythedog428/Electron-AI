// Animated helper ("Spark") that reacts to what's happening in the app.
// Moods are set from app.js. The character is pure SVG + CSS, so it costs almost nothing to run.
const MASCOT_LINES = {
  idle: [],
  thinking: ["Let me think…", "On it!", "Working on that…"],
  typing: [],
  happy: ["Nice one!", "Done!", "Got it ✨", "That went well!"],
  sad: ["Oops, that didn't work.", "Something went wrong there.", "Hmm, try again?"],
  listening: ["I'm listening…", "Go ahead, I'm all ears."],
  excited: ["New chat! Let's go!", "Fresh start!"],
  sleepy: ["zzz… still here when you need me."],
  wave: ["Hi there!", "Need a hand?"],
};

const Mascot = (() => {
  const root = document.getElementById("mascot");
  const bubble = document.getElementById("mascot-bubble");
  let moodTimer = null;
  let bubbleTimer = null;
  let sleepTimer = null;
  const SLEEP_AFTER_MS = 90 * 1000;

  const pick = (list) => list[Math.floor(Math.random() * list.length)];

  function showBubble(text) {
    if (!bubble) return;
    bubble.textContent = text;
    bubble.classList.add("show");
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => bubble.classList.remove("show"), 3800);
  }

  function setMood(mood, { line = true, hold = 0, text = null } = {}) {
    if (!root) return;
    root.dataset.mood = mood;
    const message = text ?? (line && MASCOT_LINES[mood]?.length ? pick(MASCOT_LINES[mood]) : null);
    if (message) showBubble(message);
    clearTimeout(moodTimer);
    if (hold) moodTimer = setTimeout(() => setMood("idle", { line: false }), hold);
    resetSleepTimer();
  }

  // Any activity wakes the helper; a long quiet spell makes it sleepy.
  function resetSleepTimer() {
    clearTimeout(sleepTimer);
    sleepTimer = setTimeout(() => {
      if (root?.dataset.mood === "idle") setMood("sleepy", { hold: 0 });
    }, SLEEP_AFTER_MS);
  }

  // Click or hover: a little wave and a hello.
  root?.addEventListener("click", () => setMood("wave", { hold: 2500 }));

  resetSleepTimer();
  return {
    set: setMood,
    say: (text, mood = "happy") => setMood(mood, { text, hold: 3500 }),
  };
})();
