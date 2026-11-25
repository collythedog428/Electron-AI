// Spark, the animated helper. It responds with its face and body only: no text bubble.
// app.js sets the mood as things happen (sending, replies, errors, the mic and so on).
const Mascot = (() => {
  const root = document.getElementById("mascot");
  const LOADING_TASKS = ["pace", "juggle", "stretch", "read", "coffee", "paint", "hop", "wiggle"];
  const ANTICS = ["wink", "dance", "bounce", "wave"];
  let moodTimer = null;
  let sleepTimer = null;
  let taskTimer = null;
  let anticTimer = null;
  const SLEEP_AFTER_MS = 90 * 1000;

  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const pickTask = (exclude) => pick(LOADING_TASKS.filter((t) => t !== exclude));

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

  // Playful moves: a random one now and then while Spark is idle, and one on each click.
  function playAntic() {
    const current = root?.dataset.mood;
    if (current !== "idle" && current !== "sleepy" && current !== undefined) return;
    setMood(pick(ANTICS), { hold: 1800 });
  }

  function scheduleAntic() {
    clearTimeout(anticTimer);
    anticTimer = setTimeout(() => {
      if (root?.dataset.mood === "idle") playAntic();
      scheduleAntic();
    }, 14000 + Math.random() * 16000);
  }

  root?.addEventListener("click", playAntic);

  resetSleepTimer();
  scheduleAntic();
  return {
    set: (mood, options = {}) => setMood(mood, { hold: options.hold ?? 0 }),
    say: (_text, mood = "happy") => setMood(mood, { hold: 3500 }),
  };
})();
