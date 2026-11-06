// Applies the last Light or Dark choice before the page paints. app.mjs then
// loads the machine-wide setting from the server. Auto follows the system.
try {
  const choice = window.localStorage.getItem('review-work:theme');
  if (choice === 'light' || choice === 'dark') document.documentElement.dataset.theme = choice;
} catch { /* Storage can be unavailable. Auto still works. */ }
