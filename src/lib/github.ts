const BAUDTIDE_ISSUES_URL = 'https://github.com/basilk15/baudtide/issues/new';

const MAX_GITHUB_TITLE_LENGTH = 80;

function feedbackTitle(message: string) {
  const firstLine = message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  const summary = (firstLine || 'Feedback from BaudTide').replace(/\s+/g, ' ');
  return `Feedback: ${summary.slice(0, MAX_GITHUB_TITLE_LENGTH)}`;
}

export function buildGitHubFeedbackIssueUrl(message: string, diagnostics: string) {
  const body = [
    '## Feedback',
    '',
    message.trim(),
    '',
    '## Diagnostics',
    '',
    '```text',
    diagnostics,
    '```',
    '',
    '_Submitted from BaudTide Help & feedback._',
  ].join('\n');

  const params = new URLSearchParams({
    title: feedbackTitle(message),
    body,
  });

  return `${BAUDTIDE_ISSUES_URL}?${params.toString()}`;
}
