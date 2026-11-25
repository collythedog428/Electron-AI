// Spark, the animated helper. It responds with its face and body only: no text bubble.
// app.js sets the mood as things happen. The same mood drives every copy of Spark on screen
// (the chat header and the Voice console).
const Mascot = (() => {
  const headerSpark = document.getElementById("mascot");
  const allSparks = () => ["mascot", "voice-spark"].map((id) => document.getElementById(id)).filter(Boolean);
  const LOADING_TASKS = ["pace", "juggle", "stretch", "read", "coffee", "paint", "hop", "wiggle"];
  const ANTICS = ["wink", "dance", "bounce", "wave"];
  let moodTimer = null;
  let sleepTimer = null;
  let taskTimer = null;
  let anticTimer = null;
  const SLEEP_AFTER_MS = 90 * 1000;

  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const pickTask = (exclude) => pick(LOADING_TASKS.filter((t) => t !== exclude));
  const currentMood = () => headerSpark?.dataset.mood;

  // While loading, Spark picks a random activity and changes to another every 5 to 9 seconds.
  function startLoadingTasks() {
    if (taskTimer) return;
    const cycle = () => {
      const task = pickTask(headerSpark?.dataset.task);
      allSparks().forEach((el) => (el.dataset.task = task));
      taskTimer = setTimeout(cycle, 5000 + Math.random() * 4000);
    };
    cycle();
  }

  function stopLoadingTasks() {
    clearTimeout(taskTimer);
    taskTimer = null;
    allSparks().forEach((el) => delete el.dataset.task);
  }

  function setMood(mood, { hold = 0 } = {}) {
    if (!headerSpark) return;
    allSparks().forEach((el) => (el.dataset.mood = mood));
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
      if (currentMood() === "idle") setMood("sleepy");
    }, SLEEP_AFTER_MS);
  }

  // Playful moves: a random one now and then while Spark is idle, and one on each click.
  function playAntic() {
    const mood = currentMood();
    if (mood !== "idle" && mood !== "sleepy" && mood !== undefined) return;
    setMood(pick(ANTICS), { hold: 1800 });
  }

  function scheduleAntic() {
    clearTimeout(anticTimer);
    anticTimer = setTimeout(() => {
      if (currentMood() === "idle") playAntic();
      scheduleAntic();
    }, 14000 + Math.random() * 16000);
  }

  // Clicks on either copy of Spark play a move.
  document.addEventListener("click", (e) => {
    if (e.target.closest?.("#mascot, #voice-spark")) playAntic();
  });

  resetSleepTimer();
  scheduleAntic();
  return {
    set: (mood, options = {}) => setMood(mood, { hold: options.hold ?? 0 }),
    say: (_text, mood = "happy") => setMood(mood, { hold: 3500 }),
  };
})();
