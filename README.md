# Exam Practice

A mobile-first, static Progressive Web App for Biology exam practice. It uses local browser storage for profile and results, IndexedDB for the last valid question bank, and no application server or publishing credentials.

## Run locally

Serve the project directory over HTTP, for example with the VS Code Live Server extension. Opening `index.html` directly with `file://` does not enable module loading, service workers, or offline caching.

All app, manifest, service-worker, and bundled question-bank URLs are relative. This supports deployment under a GitHub Pages project URL such as `https://username.github.io/repository-name/`.

## Practice settings

| Mode | Target | Time limit |
| --- | ---: | ---: |
| Chapter practice | 15 questions from the selected chapter | 10 minutes |
| Practice mode | 30, 60, or 90 questions from the downloaded bank | 30, 60, or 90 minutes |
| Exam simulation | Up to 120 questions from the downloaded bank | 120 minutes |
| PYQ papers | Paper attempts from published paper metadata | Varies by paper |

The starter bank has 15 Biology practice questions from *The Living World*, including three additional original study questions. They are not represented as official examination questions. The app shows the actual available count before a test starts and uses all eligible questions when fewer than the configured target are available. The configured time limit remains the same.

Scoring is +3 for a correct response, -1 for an incorrect response, and 0 for an unanswered question. Displayed percentage is clamped to the range 0–100%, so a negative raw score displays as 0%.

## Question-bank layout and schema

The app and its initial question-bank directory are separate from the question-bank data model:

```text
question-bank/
  index.json
  biology/
    chapter-1.json
```

`question-bank/index.json` is the catalogue. Each chapter entry declares a stable chapter ID, subject, chapter number, title, relative file path, question count, revision, and publication status. Each chapter JSON file has `schemaVersion: 1`, matching chapter metadata, and a `questions` array. Question IDs must be stable and unique across the entire published bank. `correctAnswer` is a zero-based option index (`0` is the first option). Every supported question is a `single-choice` MCQ with a non-empty explanation.

The app validates catalogue metadata, safe relative paths, chapter metadata, unique question IDs (within and across chapters), question text, options, question type, answer indexes, and explanations before activating an update. Usable question totals are derived from the validated downloaded question arrays.

## Add or update questions

1. Visit `admin/import.html` to open the administrator-only question-bank import tool.
2. Drop a version 1 chapter JSON file onto the page, or select it with the file picker.
3. Review the validation result and question preview. The tool checks IDs against the published chapter files when they are reachable.
4. Download the validated chapter JSON and updated `index.json`.
5. Put the chapter file at the relative path declared in `index.json` (for example, `question-bank/biology/chapter-2.json`).
6. Commit and publish the question-bank changes.
7. Student apps check for catalogue changes on launch and when the student uses **Refresh question bank**. Changed chapter files must have their `revision` incremented in the catalogue.

The importer only validates and downloads files on the administrator's device. It does **not** publish content. GitHub Pages is static hosting and cannot securely accept arbitrary uploads. Never place a GitHub write token or other publishing secret in client-side JavaScript.

### Hosting the question bank separately

The bundled default is configured in `config.js` as a relative `questionBankIndexUrl`. To host the bank independently, change it to the HTTPS URL of the published `index.json`. Keep each chapter `path` relative to that catalogue URL, and configure the bank host to allow cross-origin reads from the app origin. Publish the catalogue and chapter files atomically; the app retains its prior valid bank if any part of an update fails validation or download.

The separate-bank approach works with a static host. For a private or authenticated publishing workflow, use a secure server-side publisher; do not add write credentials to this app.

## Offline and updates

- The service worker caches the app shell and uses network-first requests for bundled bank files.
- Successfully validated bank data is saved as one IndexedDB record. On startup, the app attempts one catalogue synchronization; it fetches chapter files only when their revision, path, or metadata changes.
- When offline, the latest valid downloaded bank remains available. A chapter not downloaded to the device cannot be practiced offline.
- A failed, malformed, incomplete, or empty-published-chapter update does not replace the last known-good bank.
- Profile and completed attempts are stored independently from the question bank. Completed attempts include question/answer snapshots so answer review remains available if a chapter changes or is removed later.
- The question-bank importer itself is an administrator tool and should be used online when cross-chapter duplicate checking and catalogue generation are needed.

## PWA and Android

The manifest, app shell, theme, icon, relative start URL, and service-worker scope support HTTPS static hosting, including GitHub Pages project subpaths. Install the PWA from a supported browser's **Install app** or **Add to Home Screen** menu.

A future Android Trusted Web Activity requires an HTTPS domain, Digital Asset Links verification (`assetlinks.json`), a signed Android package, store graphics, and device testing. A native wrapper is not needed for the current web app.

## Verification notes

The project does not include an automated test suite. During the latest local audit:

- Checked JavaScript syntax for the app, question-bank loader, importer, configuration, and service worker; validated all four JSON files.
- Used a browser session to complete the subject → chapter → test flow and confirmed chapter practice still starts with 15 questions.
- Checked the 30-, 60-, and 90-minute practice choices against the current 15-question bank; each used 15 questions, retained its selected duration, and saved its own category/length.
- Uploaded a test photo through the `+` control, confirmed the circular preview and local profile save, and removed the test-only browser storage afterward.
- Completed a one-answer practice attempt and confirmed its result record stores answered count, accuracy, category, requested length, and start/completion timestamps.
- Checked the profile view at a 390px viewport with no horizontal overflow.

Deployed-host offline restart, reconnect synchronization, installation, and device-specific native file-picker behavior still require testing on the published HTTPS app and target devices.
