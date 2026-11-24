// Spark, the animated helper. It responds with its face and body only: no text bubble.
// app.js sets the mood as things happen (sending, replies, errors, the mic and so on).
const Mascot = (() => {
  const root = document.getElementById("mascot");
  const LOADING_TASKS = ["pace", "juggle", "stretch", "read", "coffee", "paint", "hop", "wiggle"];
  let moodTimer = null;
  let sleepTimer = null;
  let taskTimer = null;
  const SLEEP_AFTER_MS = 90 * 1000;

  const pickTask = (exclude) => {
    const pool = LOADING_TASKS.filter((t) => t !== exclude);
    return pool[Math.floor(Math.random() * pool.length)];
  };

  // While loading, Spark picks a random activity and changes to another every 5 to 9 seconds.
  function startLoadingTasks() {
    if (taskTimer) return;
    root.dataset.task = pickTask();
    const cycle = () => {
      root.dataset.task = pickTask(root.dataset.task);
      taskTimer = setTimeout(cycle, 5000 + Math.random() * 4000);
    };
    taskTimer = setTimeout(cycle, 5000 + Math.random() * 4000);
  }

  function stopLoadingTasks() {
    clearTimeout(taskTimer);
    taskTimer = null;
    delete root.dataset.task;
  }

  function setMood(mood, { hold = 0 } = {}) {
    if (!root) return;
    root.dataset.mood = mood;
    if (mood === "thinking") startLoadingTasks();
    else stopLoadingTasks();
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
