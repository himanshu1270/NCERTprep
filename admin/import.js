import { configuredIndexUrl, validateCatalog, validateChapter } from "../question-bank.js";

const fileInput = document.querySelector("#chapter-file");
const dropZone = document.querySelector("#drop-zone");
const statusBox = document.querySelector("#validation-status");
const errorsBox = document.querySelector("#validation-errors");
const preview = document.querySelector("#preview");
const summary = document.querySelector("#chapter-summary");
const questionPreview = document.querySelector("#question-preview");
const previewCount = document.querySelector("#preview-count");
const downloadChapter = document.querySelector("#download-chapter");
const downloadCatalog = document.querySelector("#download-catalog");
let preparedChapter = null;
let preparedCatalog = null;
let chapterFileName = "";
downloadChapter.disabled = true;
downloadCatalog.disabled = true;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function slug(value) {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function nextBankVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match ? `${match[1]}.${match[2]}.${Number(match[3]) + 1}` : `${version}-updated`;
}

function displayErrors(errors) {
  errorsBox.innerHTML = `<ul>${errors.map(error => `<li>${escapeHtml(error)}</li>`).join("")}</ul>`;
  errorsBox.classList.remove("hidden");
  preview.classList.add("hidden");
  statusBox.className = "validation-status error";
  statusBox.textContent = "This file is invalid and cannot be prepared for download.";
  preparedChapter = null;
  preparedCatalog = null;
  downloadChapter.disabled = true;
  downloadCatalog.disabled = true;
}

async function readJsonFile(file) {
  let chapter;
  try {
    chapter = JSON.parse(await file.text());
  } catch {
    displayErrors(["The selected file is not valid JSON."]);
    return;
  }
  const errors = [];
  if (!chapter || chapter.schemaVersion !== 1 || typeof chapter.chapterId !== "string"
    || typeof chapter.subject !== "string" || !Number.isInteger(chapter.chapterNumber)
    || typeof chapter.title !== "string" || !Array.isArray(chapter.questions)) {
    displayErrors(["The file must use the version 1 chapter schema with chapterId, subject, chapterNumber, title, and questions."]);
    return;
  }

  const entry = {
    id: chapter.chapterId,
    subject: chapter.subject,
    chapterNumber: chapter.chapterNumber,
    title: chapter.title,
    path: `${slug(chapter.subject)}/chapter-${chapter.chapterNumber}.json`,
    questionCount: chapter.questions.length,
    revision: 1,
    published: true
  };

  try {
    validateChapter(chapter, entry);
  } catch (error) {
    errors.push(error.message);
  }

  let catalog;
  let previousCatalogEntry = null;
  let catalogLoaded = false;
  let duplicateCheckComplete = false;
  try {
    const response = await fetch(configuredIndexUrl(), { cache: "no-cache" });
    if (!response.ok) throw new Error("The current catalogue could not be downloaded.");
    catalog = await response.json();
    validateCatalog(catalog);
    catalogLoaded = true;
    previousCatalogEntry = catalog.chapters.find(item => item.id === entry.id) || null;
    if (previousCatalogEntry) {
      entry.path = previousCatalogEntry.path;
      entry.revision = previousCatalogEntry.revision + 1;
    }
    const existingIds = new Set();
    for (const existingEntry of catalog.chapters.filter(item => item.published && item.id !== entry.id)) {
      const chapterUrl = new URL(existingEntry.path, configuredIndexUrl()).href;
      const chapterResponse = await fetch(chapterUrl, { cache: "no-cache" });
      if (!chapterResponse.ok) throw new Error(`Could not check duplicate IDs against ${existingEntry.title}.`);
      const existingChapter = await chapterResponse.json();
      validateChapter(existingChapter, existingEntry);
      for (const question of existingChapter.questions) existingIds.add(question.id);
    }
    for (const question of chapter.questions) {
      if (existingIds.has(question.id)) errors.push(`Question ID "${question.id}" already exists in another published chapter.`);
    }
    duplicateCheckComplete = true;
  } catch (error) {
    console.warn("Cross-chapter duplicate check could not complete.", error);
  }
  if (errors.length) {
    displayErrors(errors);
    return;
  }

  const updatedEntry = {
    ...(previousCatalogEntry || {}),
    id: entry.id,
    subject: entry.subject,
    chapterNumber: entry.chapterNumber,
    title: entry.title,
    path: entry.path,
    questionCount: entry.questionCount,
    revision: entry.revision,
    published: true
  };
  if (catalogLoaded) {
    const conflictingPath = catalog.chapters.find(item => item.id !== updatedEntry.id && item.path === updatedEntry.path);
    const conflictingNumber = catalog.chapters.find(item =>
      item.id !== updatedEntry.id
      && item.subject.toLocaleLowerCase() === updatedEntry.subject.toLocaleLowerCase()
      && item.chapterNumber === updatedEntry.chapterNumber
    );
    if (conflictingPath || conflictingNumber) {
      displayErrors([`This subject/chapter number or file path is already assigned to "${(conflictingPath || conflictingNumber).title}".`]);
      return;
    }
    catalog.chapters = catalog.chapters.filter(item => item.id !== updatedEntry.id);
    catalog.chapters.push(updatedEntry);
    catalog.chapters.sort((left, right) => left.subject.localeCompare(right.subject) || left.chapterNumber - right.chapterNumber);
    catalog.bankVersion = nextBankVersion(catalog.bankVersion || "1.0.0");
  }
  preparedChapter = chapter;
  preparedCatalog = catalogLoaded ? catalog : null;
  chapterFileName = `chapter-${chapter.chapterNumber}.json`;
  downloadChapter.disabled = false;
  downloadCatalog.disabled = !catalogLoaded;
  errorsBox.classList.add("hidden");
  statusBox.className = `validation-status ${duplicateCheckComplete ? "success" : "warning"}`;
  statusBox.textContent = !catalogLoaded
    ? "Chapter structure is valid, but the current catalogue is unavailable. Only the chapter file can be downloaded; do not publish until the catalogue is updated."
    : duplicateCheckComplete
      ? "Valid chapter. Duplicate IDs were checked against published chapters."
      : "Chapter structure is valid, but cross-chapter duplicate checks were unavailable. Review IDs before publishing.";
  previewCount.textContent = `${chapter.questions.length} questions`;
  summary.innerHTML = `<h3>${escapeHtml(chapter.title)}</h3><div class="chapter-summary-grid">
    <div><span>Subject</span><strong>${escapeHtml(chapter.subject)}</strong></div>
    <div><span>Chapter</span><strong>${chapter.chapterNumber}</strong></div>
    <div><span>Stable ID</span><strong>${escapeHtml(chapter.chapterId)}</strong></div>
  </div>`;
  questionPreview.innerHTML = chapter.questions.slice(0, 5).map((question, index) => `
    <article class="card preview-question"><h3>${index + 1}. ${escapeHtml(question.text)}</h3>
      ${question.options.map((option, optionIndex) => `<div class="preview-option ${optionIndex === question.correctAnswer ? "correct" : ""}">${String.fromCharCode(65 + optionIndex)}. ${escapeHtml(option)}${optionIndex === question.correctAnswer ? " · Correct" : ""}</div>`).join("")}
      <p class="review-explanation">${escapeHtml(question.explanation)}</p>
    </article>`).join("");
  preview.classList.remove("hidden");
}

function downloadJson(filename, data) {
  const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

fileInput.addEventListener("change", () => {
  const [file] = fileInput.files;
  if (file) void readJsonFile(file);
});

for (const eventName of ["dragenter", "dragover"]) {
  dropZone.addEventListener(eventName, event => {
    event.preventDefault();
    dropZone.classList.add("dragging");
  });
}
for (const eventName of ["dragleave", "drop"]) {
  dropZone.addEventListener(eventName, event => {
    event.preventDefault();
    dropZone.classList.remove("dragging");
  });
}
dropZone.addEventListener("drop", event => {
  const [file] = event.dataTransfer.files;
  if (file) void readJsonFile(file);
});

downloadChapter.addEventListener("click", () => {
  if (preparedChapter) downloadJson(chapterFileName, preparedChapter);
});
downloadCatalog.addEventListener("click", () => {
  if (preparedCatalog) downloadJson("index.json", preparedCatalog);
});
