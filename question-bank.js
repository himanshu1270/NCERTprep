const DATABASE_NAME = "exam-practice-question-bank";
const DATABASE_VERSION = 2;
const STORE_NAME = "bank";
const ACTIVE_BANK_KEY = "active";
const DEFAULT_INDEX_URL = "./question-bank/index.json";
const SUPPORTED_SCHEMA_VERSIONS = new Set([1, 2]);

function configuredIndexUrl() {
  const configured = window.EXAM_APP_CONFIG?.questionBankIndexUrl || DEFAULT_INDEX_URL;
  return new URL(configured, document.baseURI).href;
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open the question-bank store."));
  });
}

async function readActiveBank() {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(ACTIVE_BANK_KEY);
    request.onsuccess = () => {
      database.close();
      resolve(request.result || null);
    };
    request.onerror = () => {
      database.close();
      reject(request.error || new Error("Could not read the saved question bank."));
    };
  });
}

async function activateBank(bank) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(bank, ACTIVE_BANK_KEY);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error || new Error("Could not save the updated question bank."));
    };
    transaction.onabort = () => {
      database.close();
      reject(transaction.error || new Error("The question-bank update was not saved."));
    };
  });
}

function normalizeQuestion(question, fallbackSubject, fallbackTitle) {
  if (!question || typeof question !== "object") return null;
  const optionList = Array.isArray(question.options) ? question.options : [];
  const answerIndex = Number.isInteger(question.correctAnswer)
    ? question.correctAnswer
    : Number.isInteger(question.answer)
      ? question.answer
      : null;
  const text = typeof question.text === "string" ? question.text : "";
  const explanation = typeof question.explanation === "string" ? question.explanation : "";
  return {
    ...question,
    id: typeof question.id === "string" ? question.id : `question-${Math.random().toString(16).slice(2)}`,
    type: question.type || "single-choice",
    text,
    options: optionList,
    correctAnswer: answerIndex,
    answer: answerIndex,
    explanation,
    subject: question.subject || fallbackSubject,
    section: question.section || null,
    chapter: question.chapter ?? fallbackTitle,
    source: question.source || null
  };
}

function validateCatalog(catalog) {
  if (!catalog || !Array.isArray(catalog.chapters) || typeof catalog.bankVersion !== "string" || !SUPPORTED_SCHEMA_VERSIONS.has(catalog.schemaVersion)) {
    throw new Error("The question-bank catalogue has an unsupported or invalid format.");
  }
  if (!catalog.chapters.some(chapter => chapter?.published === true)) {
    throw new Error("The catalogue does not contain any published chapters; the saved question bank was left unchanged.");
  }
  const chapterIds = new Set();
  const paths = new Set();
  const subjectChapterPairs = new Set();
  for (const chapter of catalog.chapters) {
    if (!chapter || typeof chapter.id !== "string" || !chapter.id.trim()
      || typeof chapter.subject !== "string" || !chapter.subject.trim()
      || typeof chapter.title !== "string" || !chapter.title.trim()
      || !Number.isInteger(chapter.chapterNumber) || chapter.chapterNumber < 1
      || typeof chapter.path !== "string" || !chapter.path.trim()
      || !Number.isInteger(chapter.revision) || chapter.revision < 1
      || typeof chapter.published !== "boolean") {
      throw new Error("The catalogue contains a chapter with missing or invalid metadata.");
    }
    if (chapterIds.has(chapter.id)) throw new Error(`Duplicate chapter ID in catalogue: ${chapter.id}`);
    if (paths.has(chapter.path)) throw new Error(`Duplicate chapter path in catalogue: ${chapter.path}`);
    const subjectChapter = JSON.stringify([chapter.subject.toLocaleLowerCase(), chapter.chapterNumber]);
    if (subjectChapterPairs.has(subjectChapter)) throw new Error(`Duplicate chapter number for subject ${chapter.subject}: ${chapter.chapterNumber}`);
    if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.json$/.test(chapter.path)) {
      throw new Error(`Unsafe relative chapter path in catalogue: ${chapter.path}`);
    }
    chapterIds.add(chapter.id);
    paths.add(chapter.path);
    subjectChapterPairs.add(subjectChapter);
  }
}

function validateChapter(data, catalogEntry) {
  if (!data || !SUPPORTED_SCHEMA_VERSIONS.has(data.schemaVersion) || data.chapterId !== catalogEntry.id
    || data.subject !== catalogEntry.subject
    || data.chapterNumber !== catalogEntry.chapterNumber
    || data.title !== catalogEntry.title
    || !Array.isArray(data.questions)) {
    throw new Error(`Chapter data does not match catalogue entry "${catalogEntry.title}".`);
  }
  const questionIds = new Set();
  for (const question of data.questions) {
    if (!question || typeof question.id !== "string" || !question.id.trim()) {
      throw new Error(`A question in "${catalogEntry.title}" is missing a stable ID.`);
    }
    if (questionIds.has(question.id)) throw new Error(`Duplicate question ID in "${catalogEntry.title}": ${question.id}`);
    const normalized = normalizeQuestion(question, catalogEntry.subject, catalogEntry.title);
    if (!normalized || typeof normalized.text !== "string" || !normalized.text.trim()) throw new Error(`Question "${question.id}" has no text.`);
    if (normalized.type !== "single-choice") throw new Error(`Question "${question.id}" has an unsupported question type.`);
    if (!Array.isArray(normalized.options) || normalized.options.length < 2
      || normalized.options.some(option => typeof option !== "string" || !option.trim())) {
      throw new Error(`Question "${question.id}" must have at least two non-empty options.`);
    }
    if (!Number.isInteger(normalized.correctAnswer) || normalized.correctAnswer < 0 || normalized.correctAnswer >= normalized.options.length) {
      throw new Error(`Question "${question.id}" has an invalid correct-answer index.`);
    }
    if (typeof normalized.explanation !== "string" || !normalized.explanation.trim()) {
      throw new Error(`Question "${question.id}" is missing its explanation.`);
    }
    questionIds.add(question.id);
  }
}

function flattenBank(bank) {
  return bank.catalog.chapters
    .filter(entry => entry.published)
    .flatMap(entry => {
      const chapter = bank.files[entry.id];
      if (!chapter) return [];
      return chapter.questions.map(question => {
        const normalized = normalizeQuestion(question, entry.subject, entry.title);
        return {
          ...normalized,
          answer: normalized.correctAnswer,
          chapterId: entry.id,
          chapter: entry.chapterNumber,
          chapterName: entry.title,
          subject: entry.subject,
          section: normalized.section || null,
          source: normalized.source || null
        };
      });
    });
}

async function fetchJson(url, description) {
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) throw new Error(`${description} could not be downloaded (${response.status}).`);
  try {
    return await response.json();
  } catch {
    throw new Error(`${description} is not valid JSON.`);
  }
}

async function synchronizeQuestionBank() {
  const saved = await readActiveBank();
  const indexUrl = configuredIndexUrl();
  const catalog = await fetchJson(indexUrl, "Question-bank catalogue");
  validateCatalog(catalog);
  const files = {};
  const oldCatalogById = new Map((saved?.catalog?.chapters || []).map(entry => [entry.id, entry]));

  for (const entry of catalog.chapters.filter(chapter => chapter.published)) {
    const previousEntry = oldCatalogById.get(entry.id);
    const previousFile = saved?.files?.[entry.id];
    if (previousEntry?.revision === entry.revision
      && previousEntry.path === entry.path
      && previousEntry.subject === entry.subject
      && previousEntry.chapterNumber === entry.chapterNumber
      && previousEntry.title === entry.title
      && previousFile) {
      validateChapter(previousFile, entry);
      files[entry.id] = previousFile;
      continue;
    }
    const chapterUrl = new URL(entry.path, indexUrl).href;
    const chapterData = await fetchJson(chapterUrl, `Question file "${entry.title}"`);
    validateChapter(chapterData, entry);
    files[entry.id] = chapterData;
  }

  const allQuestionIds = new Set();
  for (const entry of catalog.chapters.filter(chapter => chapter.published)) {
    const chapterQuestions = files[entry.id].questions;
    if (!Array.isArray(chapterQuestions) || chapterQuestions.length < 1) {
      throw new Error(`Question file "${entry.title}" contains no usable questions.`);
    }
    entry.questionCount = chapterQuestions.length;
    for (const question of chapterQuestions) {
      if (allQuestionIds.has(question.id)) throw new Error(`Question ID "${question.id}" is duplicated across chapters.`);
      allQuestionIds.add(question.id);
    }
  }

  const updated = { catalog, files, syncedAt: new Date().toISOString() };
  await activateBank(updated);
  return updated;
}

export async function getSavedQuestionBank() {
  return readActiveBank();
}

export async function loadQuestionBank() {
  const saved = await readActiveBank();
  if (!navigator.onLine) {
    if (!saved) throw new Error("You are offline and no question bank has been downloaded on this device yet.");
    return { bank: saved, updated: false, offline: true };
  }
  try {
    const updated = await synchronizeQuestionBank();
    return { bank: updated, updated: true, offline: false };
  } catch (error) {
    if (!saved) throw error;
    console.error("Question-bank sync failed; continuing with the last valid downloaded bank.", error);
    return { bank: saved, updated: false, offline: false, syncError: error };
  }
}

export async function refreshQuestionBank() {
  return synchronizeQuestionBank();
}

export { flattenBank, validateCatalog, validateChapter, configuredIndexUrl };
