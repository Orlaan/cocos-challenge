export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'header-max-length': [2, 'always', 120], // the longest existing header is 108 characters
    'subject-case': [0], // subjects start with names such as D-04, SELL or README
    'body-max-line-length': [0], // bodies are unwrapped paragraphs
    'footer-max-line-length': [0], // "Verified: ..." lines parse as footers and are unwrapped too
  },
};
