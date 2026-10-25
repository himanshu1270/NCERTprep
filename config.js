const appBaseUrl = new URL("./", document.currentScript.src);
window.EXAM_APP_CONFIG = {
  questionBankIndexUrl: new URL("./question-bank/index.json", appBaseUrl).href
};
