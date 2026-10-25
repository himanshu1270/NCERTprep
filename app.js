import { flattenBank, loadQuestionBank, refreshQuestionBank } from "./question-bank.js";

const PRACTICE_LENGTHS = [30, 60, 90];
const TEST_SETTINGS = {
  chapter: { target: 15, seconds: 10 * 60 },
  mock: { target: 30, seconds: 30 * 60 },
  "practice-30": { target: 30, seconds: 30 * 60 },
  "practice-60": { target: 60, seconds: 60 * 60 },
  "practice-90": { target: 90, seconds: 90 * 60 },
  exam: { target: 120, seconds: 120 * 60 },
  pyq: { target: 30, seconds: 30 * 60 }
};
let questions = [];
let questionBank = null;
let bankStatus = "loading";
let bankMessage = "Loading question bank…";
let bankSyncPromise = null;
let practiceSelection = "overview";
let practiceSubject = null;

const KEY_PROFILE = "exam-practice-profile";
const KEY_HISTORY = "exam-practice-history";
const KEY_ACTIVE = "exam-practice-active";
const app = document.querySelector("#app");
let activeTest = loadJson(KEY_ACTIVE, null);
let currentTab = "home";
let selectedResult = null;
let reviewIndex = 0;
let showPalette = false;
let toastTimeout;
let timerInterval;

function loadJson(key, fallback) {
  const raw = localStorage.getItem(key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw);
  } catch (error) {
    console.error(`Unable to read saved ${key}.`, error);
    return fallback;
  }
}

function saveJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function profile() {
  return loadJson(KEY_PROFILE, { name: "Learner" });
}

function history() {
  const items = loadJson(KEY_HISTORY, []);
  return Array.isArray(items) ? items : [];
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

function formatDuration(seconds) {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  const remaining = safe % 60;
  return `${minutes}:${String(remaining).padStart(2, "0")}`;
}

function normalizeMode(mode) {
  if (mode === "mock") return "practice-30";
  if (mode === "practice") return "practice-30";
  return mode;
}

function modeLabel(mode) {
  const normalized = normalizeMode(mode);
  const labels = {
    chapter: "Chapter practice",
    "practice-30": "Practice mode · 30 questions",
    "practice-60": "Practice mode · 60 questions",
    "practice-90": "Practice mode · 90 questions",
    exam: "Exam simulation",
    pyq: "PYQ papers"
  };
  return labels[normalized] || "Practice mode";
}

function questionTarget(mode) {
  const normalized = normalizeMode(mode);
  return TEST_SETTINGS[normalized]?.target ?? TEST_SETTINGS.chapter.target;
}

function eligibleQuestions(mode, chapterId = null, subject = null) {
  const normalized = normalizeMode(mode);
  return questions.filter(question => {
    if (normalized === "chapter") return question.chapterId === chapterId;
    if (normalized === "exam") return true;
    if (normalized === "pyq") return question.source?.type === "previous_year" || (question.source?.exam && question.source?.year);
    if (subject) return question.subject === subject;
    return true;
  });
}

function questionCount(mode, chapterId = null, subject = null) {
  return Math.min(questionTarget(mode), eligibleQuestions(mode, chapterId, subject).length);
}

function durationFor(mode) {
  const normalized = normalizeMode(mode);
  return TEST_SETTINGS[normalized]?.seconds ?? TEST_SETTINGS.chapter.seconds;
}

function chapterEntries() {
  return questionBank?.catalog.chapters.filter(chapter => chapter.published) || [];
}

function chapterById(chapterId) {
  return chapterEntries().find(chapter => chapter.id === chapterId);
}

function completedHistory() {
  return history().filter(item => item.status === "completed");
}

function scorePercent(item) {
  return item.max ? Math.max(0, Math.round(item.score / item.max * 100)) : 0;
}

function bestPercent() {
  return completedHistory().reduce((best, item) => Math.max(best, scorePercent(item)), 0);
}

function safeInitial(name) {
  return (name.trim()[0] || "L").toUpperCase();
}

function isProfilePhotoData(value) {
  return typeof value === "string" && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(value);
}

function shuffle(items) {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

function testStart(mode, chapterId = null, requestedLength = null, subject = null) {
  const normalizedMode = mode === "practice" && PRACTICE_LENGTHS.includes(requestedLength)
    ? `practice-${requestedLength}`
    : normalizeMode(mode);
  const pool = eligibleQuestions(normalizedMode, chapterId, subject);
  const requested = requestedLength ?? questionTarget(normalizedMode);
  const count = Math.min(requested, pool.length);
  if (!count) {
    showToast("No downloaded questions are available for this practice session.");
    return;
  }
  if (count < requested) {
    showToast(`Only ${count} eligible questions are available in the current bank. This test uses the available set.`);
  }
  const selected = shuffle(pool).slice(0, count);
  const snapshots = Object.fromEntries(selected.map(question => [question.id, { ...question, options: [...question.options] }]));
  const ids = selected.map(question => question.id);
  activeTest = {
    id: Date.now(),
    mode: normalizedMode,
    chapterId,
    chapterTitle: chapterById(chapterId)?.title || null,
    subject: chapterById(chapterId)?.subject || subject || null,
    ids,
    snapshots,
    index: 0,
    answers: {},
    marked: [],
    visited: [ids[0]],
    deadline: Date.now() + durationFor(normalizedMode) * 1000,
    startedAt: Date.now(),
    testLength: requested,
    category: normalizedMode === "chapter" ? "chapter practice" : normalizedMode === "exam" ? "exam simulation" : normalizedMode.startsWith("practice") ? "practice mode" : "PYQ papers"
  };
  currentTab = "test";
  selectedResult = null;
  showPalette = false;
  saveJson(KEY_ACTIVE, activeTest);
  render();
}

function getQuestion(id) {
  return activeTest?.snapshots?.[id] || questions.find(question => question.id === id);
}

function currentQuestion() {
  return getQuestion(activeTest.ids[activeTest.index]);
}

function persistTest() {
  saveJson(KEY_ACTIVE, activeTest);
}

function chooseAnswer(index) {
  activeTest.answers[currentQuestion().id] = index;
  persistTest();
  render();
}

function visitQuestion(index) {
  activeTest.index = index;
  const id = activeTest.ids[index];
  if (!activeTest.visited.includes(id)) activeTest.visited.push(id);
  persistTest();
  showPalette = false;
  render();
}

function moveQuestion(amount) {
  const nextIndex = activeTest.index + amount;
  if (nextIndex < 0) return;
  if (nextIndex >= activeTest.ids.length) {
    openSubmitDialog();
    return;
  }
  visitQuestion(nextIndex);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function toggleMarked() {
  const id = currentQuestion().id;
  activeTest.marked = activeTest.marked.includes(id)
    ? activeTest.marked.filter(markedId => markedId !== id)
    : [...activeTest.marked, id];
  persistTest();
  render();
}

function openSubmitDialog() {
  const answered = Object.keys(activeTest.answers).length;
  app.insertAdjacentHTML("beforeend", `
    <div class="modal-overlay" data-modal-backdrop>
      <section class="modal" role="dialog" aria-modal="true" aria-labelledby="submit-title">
        <h2 id="submit-title">Submit your test?</h2>
        <p>You've answered ${answered} of ${activeTest.ids.length} questions. You can still go back and review your responses.</p>
        <button class="button button-primary button-full" data-action="finish-test">Submit and see results</button>
        <button class="button button-full" data-action="close-modal">Go back to test</button>
      </section>
    </div>`);
}

function finishTest() {
  if (!activeTest) return;
  const correct = activeTest.ids.filter(id => activeTest.answers[id] === getQuestion(id).answer).length;
  const answered = Object.keys(activeTest.answers).length;
  const wrong = answered - correct;
  const completedAt = new Date().toISOString();
  const record = {
    id: activeTest.id,
    mode: activeTest.mode,
    category: activeTest.category,
    testLength: activeTest.testLength,
    questionCount: activeTest.ids.length,
    chapterId: activeTest.chapterId,
    chapterTitle: activeTest.chapterTitle,
    subject: activeTest.subject,
    startedAt: new Date(activeTest.startedAt).toISOString(),
    completedAt,
    ids: activeTest.ids,
    visited: [...activeTest.visited],
    answers: activeTest.answers,
    questionSnapshots: activeTest.ids.map(id => ({ ...activeTest.snapshots[id], options: [...activeTest.snapshots[id].options] })),
    responses: activeTest.ids.map(id => ({
      questionId: id,
      selectedAnswer: activeTest.answers[id] ?? null,
      correct: activeTest.answers[id] === activeTest.snapshots[id].answer
    })),
    correct,
    wrong,
    answered,
    accuracy: answered ? correct / answered * 100 : 0,
    skipped: activeTest.ids.length - answered,
    score: correct * 3 - wrong,
    max: activeTest.ids.length * 3,
    status: "completed",
    date: new Date().toISOString(),
    duration: Math.max(0, Math.floor((Date.now() - activeTest.startedAt) / 1000))
  };
  saveJson(KEY_HISTORY, [record, ...history()].slice(0, 100));
  localStorage.removeItem(KEY_ACTIVE);
  activeTest = null;
  selectedResult = record.id;
  currentTab = "progress";
  showPalette = false;
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function abortTest() {
  localStorage.removeItem(KEY_ACTIVE);
  activeTest = null;
  showPalette = false;
  currentTab = "home";
  render();
}

function showToast(message) {
  const oldToast = document.querySelector(".toast");
  if (oldToast) oldToast.remove();
  clearTimeout(toastTimeout);
  app.insertAdjacentHTML("beforeend", `<div class="toast" role="status">${escapeHtml(message)}</div>`);
  toastTimeout = setTimeout(() => document.querySelector(".toast")?.remove(), 2400);
}

function navBar() {
  const tabs = [
    ["home", "⌂", "Home"],
    ["practice", "✎", "Practice"],
    ["progress", "▥", "Progress"],
    ["profile", "◉", "Profile"]
  ];
  return `<nav class="tabbar" aria-label="Main navigation"><div class="tabbar-inner">
    ${tabs.map(([id, icon, label]) => `<button class="tab-button ${currentTab === id ? "active" : ""}" data-action="tab" data-tab="${id}" aria-current="${currentTab === id ? "page" : "false"}"><span class="tab-icon" aria-hidden="true">${icon}</span><span>${label}</span></button>`).join("")}
  </div></nav>`;
}

function homePage() {
  const name = profile().name || "Learner";
  const completed = completedHistory();
  const practiceDays = new Set(completed.map(item => new Date(item.date).toLocaleDateString())).size;
  const recent = history().slice(0, 3);
  const recentCount = questionCount("mock");
  return `<div class="page">
    <header class="hero">
      <div class="hero-top">
        <div><p class="eyebrow">Your study space</p><h1>Hi, ${escapeHtml(name)} 👋</h1><p class="hero-copy">A little practice goes a long way.</p></div>
        <button class="avatar-button" data-action="tab" data-tab="profile" aria-label="Open profile">${escapeHtml(safeInitial(name))}</button>
      </div>
      <div class="hero-progress">
        <div><strong>${completed.length}</strong><span>tests completed</span></div>
        <div><strong>${bestPercent()}%</strong><span>personal best</span></div>
        <div class="streak"><strong>✨ ${practiceDays}</strong><span>practice days</span></div>
      </div>
    </header>
    <div class="hero-grid">
      <section>
        <div class="section-heading"><h2>Quick start</h2></div>
        <article class="card primary-card">
          <div class="card-content"><p class="eyebrow">Recommended</p><h3>Build your exam confidence</h3><p>Choose a chapter, run a timed practice set, or jump into an exam simulation.</p>
            <div class="pill-row"><span class="pill">${recentCount} practice questions available</span><span class="pill">${formatDuration(durationFor("practice-30"))}</span></div>
            <button class="button button-light" data-action="practice-mode-picker" ${recentCount ? "" : "disabled"}>Start a practice test <span aria-hidden="true">→</span></button>
          </div><span class="card-icon" aria-hidden="true">📝</span>
        </article>
        <div class="section-heading"><h2>Your progress</h2><button data-action="tab" data-tab="progress">View all</button></div>
        <div class="stats-grid">
          <article class="card stat-card"><span class="stat-icon">🎯</span><span>Best result</span><strong>${bestPercent()}%</strong></article>
          <article class="card stat-card"><span class="stat-icon">📚</span><span>Questions loaded</span><strong>${questions.length}</strong></article>
        </div>
      </section>
      <section>
        <div class="section-heading"><h2>Practice modes</h2><button data-action="tab" data-tab="practice">Explore</button></div>
        ${modeCards()}
        <div class="section-heading"><h2>Recent activity</h2></div>
        <div class="card">${recent.length ? recent.map(recentRow).join("") : `<div class="empty-state"><span class="empty-icon">🌱</span>Your first test is waiting. Start with a quick practice session.</div>`}</div>
      </section>
    </div>
  </div>${navBar()}`;
}

function modeCards() {
  return `<div class="mode-list">
    <article class="card mode-card"><span class="mode-icon">📖</span><div class="mode-copy"><strong>Chapter practice</strong><span>Subject → chapter → full chapter</span></div><button class="arrow-button" data-action="chapter-practice" aria-label="Choose chapter practice">›</button></article>
    <article class="card mode-card"><span class="mode-icon green">⏱️</span><div class="mode-copy"><strong>Practice mode</strong><span>${PRACTICE_LENGTHS.join(" / ")} questions · ${PRACTICE_LENGTHS.map(length => formatDuration(durationFor(`practice-${length}`))).join(" / ")}</span></div><button class="arrow-button" data-action="practice-mode-picker" aria-label="Choose practice mode">›</button></article>
    <article class="card mode-card"><span class="mode-icon purple">🏁</span><div class="mode-copy"><strong>Exam simulation</strong><span>${questionCount("exam")} available / ${questionTarget("exam")} questions · ${formatDuration(durationFor("exam"))}</span></div><button class="arrow-button" data-action="preview" data-mode="exam" aria-label="Start exam simulation" ${questionCount("exam") ? "" : "disabled"}>›</button></article>
    <article class="card mode-card"><span class="mode-icon amber">📚</span><div class="mode-copy"><strong>PYQ papers</strong><span>Exam papers and paper attempts</span></div><button class="arrow-button" data-action="pyq-library" aria-label="Open PYQ papers">›</button></article>
  </div>`;
}

function recentRow(item) {
  const percent = scorePercent(item);
  return `<button class="recent-row" data-action="result" data-result="${item.id}" style="width:100%;border:0;background:transparent;text-align:left">
    <span class="recent-icon">${item.mode === "exam" ? "🏁" : item.mode === "chapter" ? "📖" : "📝"}</span>
    <span class="recent-copy"><strong>${escapeHtml(modeLabel(item.mode))}</strong><span>${new Date(item.date).toLocaleDateString()}</span></span>
    <span class="recent-score"><strong>${percent}%</strong><span>${item.correct}/${item.ids.length} correct</span></span>
  </button>`;
}

function practicePage() {
  const subjects = [...new Set(chapterEntries().map(chapter => chapter.subject))];
  const lastSynced = questionBank?.syncedAt
    ? new Date(questionBank.syncedAt).toLocaleString()
    : "Not synced yet";
  if (practiceSelection === "chapter-subject") {
    return `<div class="page">
      <p class="eyebrow" style="margin-top:26px">Chapter practice</p><h1 class="page-title">Choose a subject</h1>
      <div class="section-heading"><span></span><button data-action="chapter-practice-reset">Back to practice</button></div>
      <div class="chapter-list">${subjects.length ? subjects.map(subject => `<article class="card chapter-list-card">
        <span class="chapter-number">${escapeHtml(subject.slice(0, 2).toUpperCase())}</span>
        <div class="mode-copy"><strong>${escapeHtml(subject)}</strong><span>${chapterEntries().filter(chapter => chapter.subject === subject).length} chapters available</span></div>
        <button class="arrow-button" data-action="chapter-subject-select" data-subject="${escapeHtml(subject)}" aria-label="Open chapters for ${escapeHtml(subject)}">›</button>
      </article>`).join("") : `<article class="card empty-state">${bankStatus === "loading" ? "Loading available subjects…" : "No published subjects are available. Refresh the question bank while online to try again."}</article>`}</div>
    </div>${navBar()}`;
  }

  if (practiceSelection === "chapter-chapters" && practiceSubject) {
    const subjectChapters = chapterEntries().filter(chapter => chapter.subject === practiceSubject);
    return `<div class="page">
      <p class="eyebrow" style="margin-top:26px">Chapter practice</p><h1 class="page-title">${escapeHtml(practiceSubject)}</h1>
      <div class="section-heading"><h2>Choose a chapter</h2><button data-action="chapter-subject-back">Back to subjects</button></div>
      <div class="chapter-list">${subjectChapters.map(chapter => {
        const count = questionCount("chapter", chapter.id);
        return `<article class="card chapter-list-card">
          <span class="chapter-number">${String(chapter.chapterNumber).padStart(2, "0")}</span>
          <div class="mode-copy"><strong>${escapeHtml(chapter.title)}</strong><span>${count} downloadable questions · full chapter practice</span></div>
          <button class="arrow-button" data-action="preview" data-mode="chapter" data-chapter-id="${escapeHtml(chapter.id)}" aria-label="Practice ${escapeHtml(chapter.title)}" ${count ? "" : "disabled"}>›</button>
        </article>`;
      }).join("")}</div>
    </div>${navBar()}`;
  }

  return `<div class="page">
    <p class="eyebrow" style="margin-top:26px">Choose your session</p><h1 class="page-title">Practice your way</h1>
    <p class="page-subtitle">Start with a chapter or take a timed practice test. Available counts reflect downloaded questions.</p>
    ${modeCards()}
    <div class="section-heading"><h2>Practice options</h2><span class="pill">${chapterEntries().length} chapters</span></div>
    <div class="bank-status" role="status"><span>${escapeHtml(bankMessage)} · Last sync: ${escapeHtml(lastSynced)}</span><button class="button" data-action="refresh-bank" ${bankStatus === "syncing" ? "disabled" : ""}>${bankStatus === "syncing" ? "Refreshing…" : "Refresh question bank"}</button></div>
    <div class="card"><div class="empty-state">Choose a practice option above to begin. Chapter practice is organized by subject and chapter, while practice mode lets you select a fixed length.</div></div>
  </div>${navBar()}`;
}

function chapterCards() {
  const chapters = chapterEntries();
  if (!chapters.length) return `<div class="card empty-state">${bankStatus === "loading" ? "Loading available chapters…" : "No downloaded chapters are available. Refresh while online to try again."}</div>`;
  const bySubject = new Map();
  chapters.forEach(chapter => {
    if (!bySubject.has(chapter.subject)) bySubject.set(chapter.subject, []);
    bySubject.get(chapter.subject).push(chapter);
  });
  const entries = [...bySubject.entries()];
  return entries.map(([subject, subjectChapters]) => `<section>
    ${entries.length > 1 ? `<h3 class="subject-heading">${escapeHtml(subject)}</h3>` : ""}
    ${subjectChapters.map(chapter => {
      const count = questionCount("chapter", chapter.id);
      return `<article class="card chapter-list-card">
        <span class="chapter-number">${String(chapter.chapterNumber).padStart(2, "0")}</span>
        <div class="mode-copy"><strong>${escapeHtml(chapter.title)}</strong><span>${escapeHtml(chapter.subject)} · ${count} available / ${questionTarget("chapter")} questions</span></div>
        <button class="arrow-button" data-action="preview" data-mode="chapter" data-chapter-id="${escapeHtml(chapter.id)}" aria-label="Practice ${escapeHtml(chapter.title)}" ${count ? "" : "disabled"}>›</button>
      </article>`;
    }).join("")}
  </section>`).join("");
}

function progressPage() {
  const results = completedHistory();
  const best = bestPercent();
  const average = results.length ? Math.round(results.reduce((sum, result) => sum + scorePercent(result), 0) / results.length) : 0;
  const recent = results.slice(0, 7).reverse();
  const categorySummary = [
    { key: "chapter", label: "Chapter practice", values: results.filter(result => result.mode === "chapter") },
    { key: "practice-30", label: "Practice mode — 30 questions", values: results.filter(result => result.mode === "practice-30" || result.mode === "mock") },
    { key: "practice-60", label: "Practice mode — 60 questions", values: results.filter(result => result.mode === "practice-60") },
    { key: "practice-90", label: "Practice mode — 90 questions", values: results.filter(result => result.mode === "practice-90") },
    { key: "exam", label: "Exam simulation", values: results.filter(result => result.mode === "exam") },
    { key: "pyq", label: "PYQ papers", values: results.filter(result => result.mode === "pyq") }
  ];
  const summaryCards = categorySummary.map(category => {
    const attempts = category.values.length;
    const answered = category.values.reduce((sum, item) => sum + (Number.isInteger(item.answered)
      ? item.answered
      : item.answers
        ? Object.keys(item.answers).length
        : 0), 0);
    const correct = category.values.reduce((sum, item) => sum + (item.correct || 0), 0);
    const accuracy = attempts && answered ? Math.round(correct / answered * 100) : 0;
    const latest = category.values[0]?.date ? new Date(category.values[0].date).toLocaleDateString() : "No attempts yet";
    const averageScore = attempts ? Math.round(category.values.reduce((sum, item) => sum + scorePercent(item), 0) / attempts) : 0;
    return `<article class="card stat-card"><span class="stat-icon">📊</span><span>${escapeHtml(category.label)}</span><strong>${attempts ? `${accuracy}%` : "—"}</strong><small>${attempts} attempts · ${answered} answered · ${correct} correct</small><small>${attempts ? `Avg. score ${averageScore}% · Latest ${escapeHtml(latest)}` : "No attempts yet"}</small></article>`;
  }).join("");

  return `<div class="page">
    <p class="eyebrow" style="margin-top:26px">Your learning journey</p><h1 class="page-title">Progress</h1>
    <p class="page-subtitle">Every practice session is a step forward.</p>
    <div class="stats-grid">
      <article class="card stat-card"><span class="stat-icon">🧾</span><span>Tests completed</span><strong>${results.length}</strong></article>
      <article class="card stat-card"><span class="stat-icon">🏆</span><span>Personal best</span><strong>${best}%</strong></article>
      <article class="card stat-card"><span class="stat-icon">📈</span><span>Average score</span><strong>${average}%</strong></article>
      <article class="card stat-card"><span class="stat-icon">✅</span><span>Correct answers</span><strong>${results.reduce((sum, result) => sum + result.correct, 0)}</strong></article>
    </div>
    <div class="section-heading"><h2>Category performance</h2><span class="pill">Accuracy = correct ÷ answered × 100</span></div>
    <div class="stats-grid">${summaryCards}</div>
    <div class="section-heading"><h2>Rankings</h2><span class="pill">Local-only until shared data is configured</span></div>
    <article class="card empty-state">Rankings remain unavailable for this device because no shared backend or authenticated leaderboard is configured.</article>
    <div class="section-heading"><h2>Score trend</h2><span class="pill">Last ${recent.length} tests</span></div>
    <article class="card">
      ${recent.length ? `<div class="chart" aria-label="Recent test scores">${recent.map((item, index) => {
        const percent = Math.max(4, scorePercent(item));
        return `<div class="chart-column" title="${percent}%"><div class="chart-bar" style="height:${percent}%"></div><span>${index + 1}</span></div>`;
      }).join("")}</div>` : `<div class="empty-state"><span class="empty-icon">📊</span>Complete a test to start your score trend.</div>`}
    </article>
    <div class="section-heading"><h2>Test history</h2></div>
    <div class="card">${results.length ? results.slice(0, 12).map(recentRow).join("") : `<div class="empty-state">Your completed sessions will appear here.</div>`}</div>
  </div>${navBar()}`;
}

function profilePage() {
  const data = profile();
  const name = data.name || "Learner";
  const email = data.email || "";
  const college = data.college || "";
  const dob = data.dob || "";
  const photo = isProfilePhotoData(data.photo) ? data.photo : "";

  return `<div class="page">
    <p class="eyebrow" style="margin-top:26px">Your account</p><h1 class="page-title">Profile</h1>
    <div class="card profile-card">
      <div class="profile-photo-control">
        <img class="profile-avatar-image${photo ? "" : " is-hidden"}" src="${photo ? escapeHtml(photo) : ""}" alt="Profile photo">
        <span class="profile-avatar${photo ? " is-hidden" : ""}" data-profile-initial>${escapeHtml(safeInitial(name))}</span>
        <button class="photo-upload-button" type="button" data-action="choose-profile-photo" aria-label="${photo ? "Change profile photo" : "Upload profile photo"}">+</button>
      </div>
      <div><h2>${escapeHtml(name)}</h2><p>Your progress is saved on this device until a backend is configured.</p></div>
    </div>
    <div class="section-heading"><h2>Personal details</h2></div>
    <form class="card" data-form="profile">
      <label class="input-label" for="profile-name">Full name</label>
      <input class="text-input" id="profile-name" name="name" maxlength="60" value="${escapeHtml(name)}" autocomplete="name" required>
      <label class="input-label" for="profile-email" style="margin-top:12px">Email</label>
      <input class="text-input" id="profile-email" name="email" type="email" value="${escapeHtml(email)}" autocomplete="email" placeholder="name@example.com">
      <label class="input-label" for="profile-college" style="margin-top:12px">College or institution</label>
      <input class="text-input" id="profile-college" name="college" maxlength="80" value="${escapeHtml(college)}" placeholder="Enter your institution">
      <label class="input-label" for="profile-dob" style="margin-top:12px">Date of birth</label>
      <input class="text-input" id="profile-dob" name="dob" type="date" value="${escapeHtml(dob)}">
      <input class="visually-hidden" id="profile-photo" name="photo" type="file" accept="image/png,image/jpeg,image/webp" aria-label="Choose a profile photo" tabindex="-1">
      ${photo ? `<p class="review-explanation">Current photo is saved locally and will not be shared publicly.</p>` : ""}
      <button class="button button-primary button-full" style="margin-top:12px" type="submit">Save changes</button>
    </form>
    <div class="section-heading"><h2>On this device</h2></div>
    <div class="card">
      <div class="profile-row"><span>Saved test results</span><strong>${history().length}</strong></div>
      <div class="profile-row"><span>Question bank</span><strong>${questions.length} questions · ${chapterEntries().length} chapters</strong></div>
      <div class="profile-row"><span>Last question-bank sync</span><strong>${questionBank?.syncedAt ? new Date(questionBank.syncedAt).toLocaleDateString() : "Not synced"}</strong></div>
    </div>
    <button class="button button-danger button-full" data-action="clear-progress">Clear my progress</button>
    <p class="empty-state">Exam Practice · Your study space, wherever you are.</p>
    <p class="developer-credit">App developer: Himanshu Kumar (HKUST)</p>
  </div>${navBar()}`;
}

function previewDialog(mode, chapterId) {
  const count = questionCount(mode, chapterId);
  const duration = durationFor(mode);
  const chapter = chapterById(chapterId);
  const title = mode === "chapter" ? `${chapter?.title || "Chapter"} practice` : modeLabel(mode);
  const actualCount = count < questionTarget(mode);
  return `<div class="modal-overlay">
    <section class="modal" role="dialog" aria-modal="true" aria-labelledby="preview-title">
      <p class="eyebrow">Before you begin</p><h2 id="preview-title">${escapeHtml(title)}</h2>
      <div class="result-stats" style="margin:15px 0"><div><strong>${count}</strong><span>Questions</span></div><div><strong>${formatDuration(duration)}</strong><span>Time</span></div><div><strong>+3 / −1</strong><span>Marking</span></div></div>
      ${actualCount ? `<p class="availability-note">There are ${count} eligible downloaded questions right now; this test uses the available questions, up to ${questionTarget(mode)}.</p>` : ""}
      <ul class="instruction-list"><li>The timer begins as soon as you start.</li><li>Choose an answer, then move to the next question.</li><li>Unanswered questions score zero; wrong answers lose one mark.</li><li>You can review marked questions before submitting.</li></ul>
      <button class="button button-primary button-full" data-action="start-test" data-mode="${mode}" data-chapter-id="${escapeHtml(chapterId || "")}" ${count ? "" : "disabled"}>I’m ready — start</button>
      <button class="button button-full" data-action="close-modal">Not now</button>
    </section>
  </div>`;
}

function testPage() {
  const question = currentQuestion();
  const answer = activeTest.answers[question.id];
  const isMarked = activeTest.marked.includes(question.id);
  const timeLeft = Math.max(0, Math.ceil((activeTest.deadline - Date.now()) / 1000));
  const progress = Math.round((activeTest.index + 1) / activeTest.ids.length * 100);
  const chapterSubtitle = question.chapterName;
  return `<section class="test-screen">
    <header class="test-header"><div class="test-head">
      <button class="back-button" data-action="exit-test" aria-label="Exit test">‹</button>
      <div class="test-name"><strong>${escapeHtml(modeLabel(activeTest.mode))}</strong><span>${escapeHtml(chapterSubtitle)}</span></div>
      <div class="timer ${timeLeft < 60 ? "urgent" : ""}" data-timer><span>Time left</span><strong>${formatDuration(timeLeft)}</strong></div>
    </div></header>
    <div class="test-meta"><span><strong>Question ${activeTest.index + 1}</strong> of ${activeTest.ids.length}</span><span>Marks <strong style="color:var(--green)">+3</strong> / <strong style="color:var(--red)">−1</strong></span><button class="button" style="min-height:34px;padding:0 10px;font-size:10px" data-action="palette">Question list</button></div>
    <main class="test-content">
      <div class="question-progress"><i style="width:${progress}%"></i></div>
      <p class="question-label">Question ${activeTest.index + 1}</p>
      <h1 class="question-text">${escapeHtml(question.text)}</h1>
      <div class="option-list">${question.options.map((option, index) => `<button class="option ${answer === index ? "selected" : ""}" data-action="answer" data-answer="${index}" aria-pressed="${answer === index}"><span class="option-letter">${String.fromCharCode(65 + index)}</span><span>${escapeHtml(option)}</span></button>`).join("")}</div>
      <div class="test-tools">
        <button class="button review-button" data-action="mark">${isMarked ? "★ Marked" : "☆ Mark for review"}</button>
        <button class="button" data-action="clear-answer" ${answer === undefined ? "disabled" : ""}>Clear response</button>
      </div>
    </main>
    <div class="bottom-actions"><div>
      <button class="button" data-action="previous" ${activeTest.index === 0 ? "disabled" : ""}>‹ Back</button>
      <button class="button button-primary" data-action="next">${activeTest.index === activeTest.ids.length - 1 ? "Submit test" : "Save & next →"}</button>
    </div></div>
    ${showPalette ? paletteDialog() : ""}
  </section>`;
}

function paletteDialog() {
  return `<div class="palette-overlay">
    <section class="palette-sheet" role="dialog" aria-modal="true" aria-labelledby="palette-title">
      <div class="section-heading" style="margin:0"><h2 id="palette-title">Question list</h2><button data-action="close-palette">Close ✕</button></div>
      <p>Tap a number to jump to that question.</p>
      <div class="pill-row"><span class="pill">● Answered</span><span class="pill" style="color:var(--purple)">● Marked for review</span><span class="pill" style="background:#f4ede4">● Not answered</span></div>
      <div class="palette-grid">${activeTest.ids.map((id, index) => {
        const classes = [
          activeTest.answers[id] !== undefined ? "answered" : "",
          activeTest.marked.includes(id) ? "marked" : "",
          activeTest.index === index ? "current" : ""
        ].filter(Boolean).join(" ");
        return `<button class="palette-number ${classes}" data-action="jump" data-index="${index}">${index + 1}</button>`;
      }).join("")}</div>
      <button class="button button-primary button-full" data-action="close-palette">Return to question</button>
    </section>
  </div>`;
}

function resultPage() {
  const result = history().find(item => item.id === selectedResult);
  if (!result) {
    selectedResult = null;
    return progressPage();
  }
  const percent = scorePercent(result);
  reviewIndex = Math.min(reviewIndex, result.ids.length - 1);
  const id = result.ids[reviewIndex];
  const question = result.questionSnapshots?.find(item => item.id === id) || questions.find(item => item.id === id);
  const chosen = result.answers[id];
  const correctAnswer = question?.answer ?? question?.correctAnswer;
  return `<div class="page">
    <button class="button" style="margin-top:22px" data-action="back-progress">‹ Back to progress</button>
    <p class="eyebrow" style="margin-top:20px">${new Date(result.date).toLocaleString()}</p>
    <h1 class="page-title" style="margin-top:0">${escapeHtml(result.mode === "chapter" ? result.chapterTitle || chapterById(result.chapterId)?.title || "Chapter-wise practice" : modeLabel(result.mode))}</h1>
    <article class="card result-score"><strong>${result.score}<span style="font-size:15px;color:var(--muted)"> / ${result.max}</span></strong><span>Final score · ${percent}%</span><span class="result-grade">${percent >= 75 ? "Great work!" : percent >= 50 ? "Good progress" : "Keep practicing"}</span><p class="review-explanation">Time taken: ${formatDuration(result.duration)}</p></article>
    <div class="card result-stats" style="margin-top:11px">
      <div><strong style="color:var(--green)">${result.correct}</strong><span>Correct</span></div>
      <div><strong style="color:var(--red)">${result.wrong}</strong><span>Incorrect</span></div>
      <div><strong>${result.skipped}</strong><span>Skipped</span></div>
    </div>
    <div class="section-heading"><h2>Review answers</h2></div>
    <div class="review-navigation">
      <button class="button" data-action="review-previous" ${reviewIndex === 0 ? "disabled" : ""}>‹ Previous</button>
      <span>Question ${reviewIndex + 1} of ${result.ids.length}</span>
      <button class="button" data-action="review-next" ${reviewIndex === result.ids.length - 1 ? "disabled" : ""}>Next ›</button>
    </div>
    ${question ? `<article class="card review-card"><h3>${reviewIndex + 1}. ${escapeHtml(question.text)}</h3>
      ${question.options.map((option, optionIndex) => `<div class="review-answer ${optionIndex === correctAnswer ? "correct" : chosen === optionIndex ? "incorrect" : ""}">${String.fromCharCode(65 + optionIndex)}. ${escapeHtml(option)}${optionIndex === chosen ? " · Your answer" : ""}${optionIndex === correctAnswer ? " · Correct" : ""}</div>`).join("")}
      ${chosen === undefined ? `<p class="review-explanation">Not answered.</p>` : ""}
      <p class="review-explanation">${escapeHtml(question.explanation)}</p>
    </article>` : `<article class="card empty-state">This historical question is not available in the saved attempt.</article>`}
  </div>${navBar()}`;
}

function render() {
  clearInterval(timerInterval);
  if (activeTest) {
    if (!currentQuestion()) {
      app.innerHTML = `<div class="page"><div class="card empty-state">Restoring your saved test and downloaded questions…</div></div>`;
      return;
    }
    app.innerHTML = testPage();
    timerInterval = setInterval(() => {
      if (!activeTest) return clearInterval(timerInterval);
      const remaining = Math.ceil((activeTest.deadline - Date.now()) / 1000);
      const timer = document.querySelector("[data-timer]");
      if (timer) {
        timer.classList.toggle("urgent", remaining < 60);
        timer.querySelector("strong").textContent = formatDuration(remaining);
      }
      if (remaining <= 0) finishTest();
    }, 1000);
    return;
  }
  if (selectedResult !== null) {
    app.innerHTML = resultPage();
    return;
  }
  if (currentTab === "home") app.innerHTML = homePage();
  else if (currentTab === "practice") app.innerHTML = practicePage();
  else if (currentTab === "progress") app.innerHTML = progressPage();
  else app.innerHTML = profilePage();
}

function handleAction(event) {
  const backdrop = event.target.closest("[data-modal-backdrop]");
  if (backdrop && event.target === backdrop) {
    backdrop.remove();
    return;
  }
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  if (action === "choose-profile-photo") {
    document.querySelector("#profile-photo")?.click();
  } else if (action === "tab") {
    currentTab = target.dataset.tab;
    selectedResult = null;
    render();
  } else if (action === "chapter-practice") {
    practiceSelection = "chapter-subject";
    practiceSubject = null;
    render();
  } else if (action === "chapter-practice-reset") {
    practiceSelection = "overview";
    practiceSubject = null;
    render();
  } else if (action === "chapter-subject-back") {
    practiceSelection = "chapter-subject";
    practiceSubject = null;
    render();
  } else if (action === "chapter-subject-select") {
    practiceSelection = "chapter-chapters";
    practiceSubject = target.dataset.subject || null;
    render();
  } else if (action === "practice-mode-picker") {
    const list = PRACTICE_LENGTHS.map(length => `
      <button class="button button-full" data-action="start-practice-length" data-length="${length}">${Math.min(length, eligibleQuestions("practice").length)} of ${length} questions · ${formatDuration(durationFor(`practice-${length}`))}</button>
    `).join("");
    app.insertAdjacentHTML("beforeend", `<div class="modal-overlay"><section class="modal" role="dialog" aria-modal="true"><h2>Practice mode</h2><p>Choose a length. The available question count and duration are shown before each test starts.</p>${list}<button class="button button-full" data-action="close-modal">Cancel</button></section></div>`);
  } else if (action === "start-practice-length") {
    const length = Number(target.dataset.length || 30);
    testStart("practice", null, length);
    document.querySelector(".modal-overlay")?.remove();
  } else if (action === "pyq-library") {
    app.insertAdjacentHTML("beforeend", `<div class="modal-overlay"><section class="modal" role="dialog" aria-modal="true"><h2>PYQ papers</h2><p>Paper data appears here when it is added to the question-bank metadata. No fake previous-year papers are generated.</p><div class="empty-state">${questionBank?.papers && questionBank.papers.length ? "Available papers are listed in the bank." : "No papers have been published yet. Papers will appear when added to the question bank."}</div><button class="button button-full" data-action="close-modal">Close</button></section></div>`);
  } else if (action === "preview") {
    const mode = target.dataset.mode;
    const chapterId = target.dataset.chapterId || null;
    app.insertAdjacentHTML("beforeend", previewDialog(mode, chapterId));
  } else if (action === "close-modal") {
    target.closest(".modal-overlay")?.remove();
  } else if (action === "start-test") {
    testStart(target.dataset.mode, target.dataset.chapterId || null);
  } else if (action === "answer") {
    chooseAnswer(Number(target.dataset.answer));
  } else if (action === "next") {
    moveQuestion(1);
  } else if (action === "previous") {
    moveQuestion(-1);
  } else if (action === "mark") {
    toggleMarked();
  } else if (action === "clear-answer") {
    delete activeTest.answers[currentQuestion().id];
    persistTest();
    render();
  } else if (action === "palette") {
    showPalette = true;
    render();
  } else if (action === "close-palette") {
    showPalette = false;
    render();
  } else if (action === "jump") {
    visitQuestion(Number(target.dataset.index));
  } else if (action === "finish-test") {
    finishTest();
  } else if (action === "exit-test") {
    app.insertAdjacentHTML("beforeend", `<div class="modal-overlay"><section class="modal" role="dialog" aria-modal="true"><h2>Leave this test?</h2><p>Your answers in this session will be discarded.</p><button class="button button-danger button-full" data-action="confirm-exit">Leave test</button><button class="button button-full" data-action="close-modal">Keep practicing</button></section></div>`);
  } else if (action === "confirm-exit") {
    abortTest();
  } else if (action === "result") {
    selectedResult = Number(target.dataset.result);
    reviewIndex = 0;
    render();
  } else if (action === "back-progress") {
    selectedResult = null;
    currentTab = "progress";
    render();
  } else if (action === "review-previous") {
    reviewIndex = Math.max(0, reviewIndex - 1);
    render();
  } else if (action === "review-next") {
    const selected = history().find(item => item.id === selectedResult);
    if (selected) reviewIndex = Math.min(selected.ids.length - 1, reviewIndex + 1);
    render();
  } else if (action === "clear-progress") {
    app.insertAdjacentHTML("beforeend", `<div class="modal-overlay"><section class="modal" role="dialog" aria-modal="true"><h2>Clear all progress?</h2><p>This removes your saved test history from this device. This cannot be undone.</p><button class="button button-danger button-full" data-action="confirm-clear">Clear progress</button><button class="button button-full" data-action="close-modal">Cancel</button></section></div>`);
  } else if (action === "confirm-clear") {
    localStorage.removeItem(KEY_HISTORY);
    selectedResult = null;
    target.closest(".modal-overlay")?.remove();
    render();
    showToast("Your test history has been cleared.");
  } else if (action === "refresh-bank") {
    void syncQuestionBank(true);
  }
}

function handleSubmit(event) {
  if (event.target.matches('[data-form="profile"]')) {
    event.preventDefault();
    const formData = new FormData(event.target);
    const name = String(formData.get("name") || "").trim();
    const email = String(formData.get("email") || "").trim();
    const college = String(formData.get("college") || "").trim();
    const dob = String(formData.get("dob") || "").trim();
    const photoFile = formData.get("photo");

    if (!name) {
      showToast("Please enter a display name.");
      return;
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showToast("Please enter a valid email address.");
      return;
    }

    let photo = profile().photo || "";
    if (photoFile && photoFile instanceof File) {
      if (!["image/png", "image/jpeg", "image/webp"].includes(photoFile.type)) {
        showToast("Profile photos must be PNG, JPEG, or WEBP images.");
        return;
      }
      if (photoFile.size > 2 * 1024 * 1024) {
        showToast("Profile photos must be under 2 MB.");
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const photoData = String(reader.result || "");
        if (!isProfilePhotoData(photoData)) {
          showToast("The selected profile photo could not be read.");
          return;
        }
        const nextProfile = { name: name.slice(0, 60), email: email.slice(0, 100), college: college.slice(0, 80), dob, photo: photoData };
        saveJson(KEY_PROFILE, nextProfile);
        render();
        showToast("Your profile has been updated.");
      };
      reader.onerror = () => showToast("The selected profile photo could not be read.");
      reader.readAsDataURL(photoFile);
      return;
    }

    saveJson(KEY_PROFILE, { name: name.slice(0, 60), email: email.slice(0, 100), college: college.slice(0, 80), dob, photo });
    render();
    showToast("Your profile has been updated.");
  }
}

function handleProfilePhotoSelection(input) {
  const [file] = input.files || [];
  if (!file) return;
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    input.value = "";
    showToast("Profile photos must be PNG, JPEG, or WEBP images.");
    return;
  }
  if (file.size > 2 * 1024 * 1024) {
    input.value = "";
    showToast("Profile photos must be under 2 MB.");
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    const preview = String(reader.result || "");
    if (!isProfilePhotoData(preview)) {
      input.value = "";
      showToast("The selected profile photo could not be read.");
      return;
    }
    const image = document.querySelector(".profile-avatar-image");
    const initial = document.querySelector("[data-profile-initial]");
    if (image) {
      image.src = preview;
      image.classList.remove("is-hidden");
    }
    initial?.classList.add("is-hidden");
  };
  reader.onerror = () => {
    input.value = "";
    showToast("The selected profile photo could not be read.");
  };
  reader.readAsDataURL(file);
}

app.addEventListener("click", handleAction);
app.addEventListener("submit", handleSubmit);
app.addEventListener("change", event => {
  if (event.target.matches("#profile-photo")) handleProfilePhotoSelection(event.target);
});

function syncQuestionBank(showStatus) {
  if (bankSyncPromise) return bankSyncPromise;
  bankStatus = "syncing";
  bankMessage = "Checking for question updates…";
  if (showStatus) render();
  bankSyncPromise = (async () => {
    try {
      questionBank = await refreshQuestionBank();
      questions = flattenBank(questionBank);
      bankStatus = navigator.onLine ? "ready" : "offline";
      bankMessage = navigator.onLine ? "Question bank is up to date" : "Using downloaded questions offline";
      render();
      if (showStatus) showToast("Question bank refreshed.");
    } catch (error) {
      console.error("Question-bank refresh failed.", error);
      bankStatus = "error";
      bankMessage = `Refresh failed: ${error.message}`;
      render();
      if (showStatus) showToast("Could not refresh the question bank. Your saved questions are unchanged.");
    } finally {
      bankSyncPromise = null;
    }
  })();
  return bankSyncPromise;
}

async function initializeQuestionBank() {
  try {
    const result = await loadQuestionBank();
    questionBank = result.bank;
    questions = flattenBank(questionBank);
    bankStatus = result.offline ? "offline" : result.syncError ? "error" : "ready";
    bankMessage = result.offline
      ? "Using downloaded questions offline"
      : result.syncError
        ? `Update unavailable; using saved bank: ${result.syncError.message}`
        : "Question bank is up to date";
    if (result.syncError) console.warn(bankMessage);
  } catch (error) {
    console.error("Could not load the question bank.", error);
    bankStatus = "error";
    bankMessage = `Question bank unavailable: ${error.message}`;
  }
  render();
}

render();
void initializeQuestionBank();

window.addEventListener("online", () => {
  if (questionBank) void syncQuestionBank(false);
});

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(error => {
      console.error("Unable to register the offline service worker.", error);
    });
  });
}
