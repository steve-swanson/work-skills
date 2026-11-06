import { DraftStore, SubmissionAttempt, recoverSubmission, sendSubmission, visibleFindings, tabCounts, findingTag, stepSelection, kindFilters, TABS } from './draft-store.mjs';

const $ = id => document.getElementById(id);
const choiceNames = { fix: 'Fix', dont_fix: 'Don’t fix', clarify: 'Clarify' };
const noteCopy = {
  fix: ['Note for the fix', 'Limits, expected behavior, or how you want it fixed…'],
  dont_fix: ['Reason', 'Why skip it? For example: intended behavior, or tracked in a ticket…'],
  clarify: ['Question', 'What should be explained in the chat?'],
};
const keyChoices = { f: 'fix', d: 'dont_fix', c: 'clarify' };
const emptyTab = { pending: 'Nothing left to decide.', decided: 'No choices are waiting to be submitted.', progress: 'Nothing is in progress.', done: 'Nothing is finished yet.', all: 'No findings.' };
const rows = new Map();
const local = (() => { try { return window.localStorage; } catch { return null; } })();
let state = null;
let attempt = null;
let submitting = false;
let refreshInFlight = null;
let stateEpoch = 0;
let pollTimer = null;
let detailsSignature = '';
let selectedId = null;
let shownId = null;
let tab = null;
let listed = [];
const kinds = new Set(); // Type filters. Empty means show everything.
let kindSignature = '';

function readPref(key) { try { return local?.getItem(key) ?? null; } catch { return null; } }
function writePref(key, value) { try { local?.setItem(key, value); } catch { /* Display preferences are optional. */ } }

function node(tag, className, value) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (value !== undefined) result.textContent = value;
  return result;
}

function text(target, value) {
  const next = String(value ?? '');
  if (target.textContent !== next) target.textContent = next;
}

function message(target, value, kind = '') {
  target.hidden = !value;
  target.className = `message ${kind}`.trim();
  text(target, value);
}

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options, headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers }, signal: AbortSignal.timeout(20_000) });
  } catch (error) {
    throw new Error(error.name === 'TimeoutError' ? 'The local review service took too long to respond. Retry when it is available.' : 'Cannot reach the local review service. Your draft stays on this page.');
  }
  let data;
  try { data = await response.json(); } catch { throw new Error(`The review service sent a response the page cannot read (${response.status}).`); }
  if (!response.ok) throw Object.assign(new Error(data.error?.message || `The request failed (${response.status}).`), { status: response.status, code: data.error?.code });
  return data;
}

const drafts = new DraftStore({
  patch: (id, payload) => api(`/api/findings/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  onChange: () => { if (state) render(); },
  onConflict: () => { refreshState().catch(() => {}); },
});

/* Theme and list settings. The server saves them for every review on this
   machine; this browser keeps a copy so the page paints with them at once. */

function savePrefs(patch) {
  api('/api/prefs', { method: 'PUT', body: JSON.stringify(patch) }).catch(() => { /* Display settings are optional. */ });
}

async function loadPrefs() {
  try {
    const prefs = await api('/api/prefs');
    writePref('review-work:theme', prefs.theme);
    applyTheme(prefs.theme);
    setListHidden(Boolean(prefs.listHidden), { remember: false });
    writePref('review-work:list-hidden', prefs.listHidden ? '1' : '0');
  } catch { /* Keep this browser's copy. */ }
}

function applyTheme(choice) {
  const value = choice === 'light' || choice === 'dark' ? choice : 'auto';
  if (value === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = value;
  for (const button of document.querySelectorAll('[data-theme-choice]')) button.setAttribute('aria-pressed', String(button.dataset.themeChoice === value));
}

function setListHidden(hidden, { remember = true } = {}) {
  $('split').classList.toggle('list-hidden', hidden);
  const label = hidden ? 'Show the list' : 'Hide the list';
  $('toggle-list').setAttribute('aria-expanded', String(!hidden));
  $('toggle-list').title = `${label} (L)`;
  text($('toggle-list-label'), label);
  if (remember) { writePref('review-work:list-hidden', hidden ? '1' : '0'); savePrefs({ listHidden: hidden }); }
}

/* Which findings show in the list. */

function matching(findings) {
  return visibleFindings(findings, { query: $('search').value, filter: tab, showDropped: tab === 'all', kinds });
}

// The open finding stays in the list until another one is picked, even when a
// new choice or a status change moves it out of the current tab.
function listedFindings(findings) {
  const ids = new Set(matching(findings).map(finding => finding.id));
  return findings.filter(finding => ids.has(finding.id) || finding.id === selectedId);
}

function select(id, { scroll = true } = {}) {
  if (!id) return;
  const rowHadFocus = document.activeElement?.classList?.contains('row');
  selectedId = id;
  render();
  const row = rows.get(id);
  if (scroll) row?.button.scrollIntoView({ block: 'nearest' });
  if (rowHadFocus) row?.button.focus({ preventScroll: true });
}

function move(delta) {
  select(stepSelection(listed.map(finding => finding.id), selectedId, delta));
}

function resetSelectionToMatches() {
  const matches = matching(drafts.list());
  if (!matches.some(finding => finding.id === selectedId)) selectedId = matches[0]?.id ?? null;
}

function toggleKind(key) {
  if (kinds.has(key)) kinds.delete(key); else kinds.add(key);
  resetSelectionToMatches();
  render();
}

function clearKinds() {
  kinds.clear();
  resetSelectionToMatches();
  render();
}

// Rebuilds the type buttons only when the set of types or counts changes.
function renderKinds(findings) {
  const filters = kindFilters(findings);
  for (const key of [...kinds]) if (!filters.some(filter => filter.key === key)) kinds.delete(key);
  const signature = filters.map(filter => `${filter.key}:${filter.count}`).join('|');
  const bar = $('kind-filters');
  if (signature !== kindSignature) {
    kindSignature = signature;
    bar.replaceChildren();
    for (const filter of filters) {
      const button = node('button', 'chip');
      button.type = 'button';
      button.dataset.kind = filter.key;
      button.append(document.createTextNode(filter.text), node('span', 'count', String(filter.count)));
      button.addEventListener('click', () => toggleKind(filter.key));
      bar.append(button);
    }
    const clear = node('button', 'chip-clear', 'Show all');
    clear.type = 'button';
    clear.id = 'clear-kinds';
    clear.addEventListener('click', clearKinds);
    bar.append(clear);
  }
  for (const button of bar.querySelectorAll('[data-kind]')) button.setAttribute('aria-pressed', String(kinds.has(button.dataset.kind)));
  $('clear-kinds').hidden = kinds.size === 0;
  $('kind-bar').hidden = filters.length === 0;
}

function setTab(next) {
  if (!TABS.includes(next)) return;
  tab = next;
  resetSelectionToMatches();
  render();
}

const controlsDisabled = finding => Boolean(finding.locked || state.review.closed || submitting || attempt?.pending);

function choose(decision) {
  const finding = selectedId && drafts.get(selectedId);
  if (!finding || controlsDisabled(finding)) return;
  try { drafts.update(finding.id, { decision: finding.decision === decision ? null : decision }); }
  catch (error) { message($('page-message'), error.message, 'error'); }
}

/* Rendering. */

function createRow(finding) {
  const item = node('li');
  const button = node('button', 'row');
  button.type = 'button';
  const meta = node('span', 'row-meta');
  const id = node('b');
  const kind = node('span');
  meta.append(id, kind);
  const tag = node('span', 'tag');
  const title = node('span', 'row-title');
  button.append(meta, tag, title);
  button.addEventListener('click', () => select(finding.id, { scroll: false }));
  item.append(button);
  $('finding-list').append(item);
  const row = { item, button, id, kind, tag, title };
  rows.set(finding.id, row);
  return row;
}

function renderList(findings) {
  const shown = new Set(listed.map(finding => finding.id));
  for (const finding of findings) {
    const row = rows.get(finding.id) ?? createRow(finding);
    text(row.id, finding.id);
    text(row.kind, ` · ${finding.label || 'comment'}${finding.blocking ? ' · blocking' : ''}`);
    const tag = findingTag(finding);
    text(row.tag, tag.text);
    row.tag.dataset.tone = tag.tone;
    text(row.title, finding.title);
    const selected = finding.id === selectedId;
    row.button.classList.toggle('selected', selected);
    if (selected) row.button.setAttribute('aria-current', 'true');
    else row.button.removeAttribute('aria-current');
    row.item.hidden = !shown.has(finding.id);
  }
}

function renderExcerpt(target, excerpt) {
  const signature = excerpt ? JSON.stringify(excerpt) : '';
  if (target.dataset.signature === signature) return;
  target.dataset.signature = signature;
  target.replaceChildren();
  target.hidden = !excerpt;
  if (!excerpt) return;
  const marked = new Set(excerpt.highlight ?? []);
  String(excerpt.code).split('\n').forEach((line, index) => {
    const number = Number(excerpt.startLine) + index;
    const row = node('span', marked.has(number) ? 'line marked' : 'line');
    row.append(node('span', 'line-number', String(number)), node('span', 'line-code', line));
    target.append(row);
  });
}

function part(id, value) {
  text($(`${id}-text`), value);
  $(id).hidden = !value;
}

function syncNote(input, value) {
  if (input.value === value) return;
  const focused = document.activeElement === input;
  const start = input.selectionStart; const end = input.selectionEnd; const direction = input.selectionDirection;
  input.value = value;
  if (focused) input.setSelectionRange(Math.min(start, value.length), Math.min(end, value.length), direction);
}

function renderDetail(finding) {
  $('detail-card').hidden = !finding;
  $('detail-empty').hidden = Boolean(finding);
  if (!finding) return;
  if (shownId !== finding.id) { shownId = finding.id; $('detail').scrollTop = 0; }
  const blocking = Boolean(finding.blocking);
  text($('d-label'), `${finding.label || 'comment'} (${blocking ? 'blocking' : 'non-blocking'})`);
  $('d-label').dataset.blocking = String(blocking);
  text($('d-id'), finding.id);
  const tag = findingTag(finding);
  text($('d-status'), tag.text);
  $('d-status').dataset.tone = tag.tone;
  const index = listed.findIndex(item => item.id === finding.id);
  text($('position'), index >= 0 ? `${index + 1} of ${listed.length}` : '');
  $('prev-finding').disabled = index <= 0;
  $('next-finding').disabled = index < 0 || index >= listed.length - 1;
  text($('detail-title'), finding.title);
  const location = finding.location ?? {};
  text($('d-path'), `${location.path ?? ''}${location.line ? `:${location.line}` : ''}`);
  $('d-path').hidden = !location.path;
  text($('d-commit'), location.commit ? `at ${String(location.commit).slice(0, 7)}` : '');
  part('d-discussion', finding.discussion);
  renderExcerpt($('d-excerpt'), finding.excerpt);
  text($('d-evidence-text'), finding.evidence);
  $('d-evidence-text').hidden = !finding.evidence;
  $('d-evidence').hidden = !finding.evidence && !finding.excerpt;
  part('d-suggestion', finding.suggestion);
  part('d-resolution', finding.resolution);

  const disabled = controlsDisabled(finding);
  $('choices').setAttribute('aria-label', `Decision for ${finding.id}`);
  for (const button of $('choices').querySelectorAll('[data-decision]')) {
    button.setAttribute('aria-pressed', String(finding.decision === button.dataset.decision));
    button.disabled = disabled;
  }
  // Any choice can carry a note: fix guidance, a Don't fix reason, or a Clarify question.
  const [noteLabel, notePlaceholder] = noteCopy[finding.decision] ?? ['Note', 'Add a note about this finding…'];
  text($('note-label'), noteLabel);
  $('note').placeholder = notePlaceholder;
  $('note').disabled = disabled;
  syncNote($('note'), finding.context);

  const saveLabels = { saved: finding.decision || finding.context ? 'Draft saved' : 'No choice yet', pending: 'Not saved yet', saving: 'Saving…', error: 'Save failed', conflict: 'Save conflict' };
  text($('save-state'), finding.locked && !finding.conflict ? 'Submitted · read-only' : `${saveLabels[finding.saveState]}${finding.saveState !== 'saved' ? ` · saved choice: ${choiceNames[finding.persistedDecision] ?? 'none'}` : ''}`);
  $('save-state').dataset.saveState = finding.saveState;
  $('read-only').hidden = !finding.locked && !state.review.closed;
  text($('read-only'), state.review.closed ? 'This review is closed. Its choices are read-only.' : finding.decision === 'clarify' ? 'We talk this one through in the chat. Submitted choices cannot change here.' : 'Submitted choices cannot change here. To change one, ask in the chat.');

  const conflict = finding.conflict;
  $('card-error').hidden = !finding.saveError && !conflict;
  text($('error-text'), conflict?.message || finding.saveError);
  $('remote-text').hidden = !conflict;
  text($('remote-text'), conflict?.latest ? `Saved version: ${choiceNames[conflict.latest.decision] ?? 'No choice'}${conflict.latest.context ? `\nNote: ${conflict.latest.context}` : '\nNo note.'}` : 'Loading the latest saved version…');
  $('retry-save').hidden = Boolean(conflict);
  $('retry-save').disabled = disabled;
  $('use-saved').hidden = !conflict;
  $('use-saved').disabled = !conflict?.latest || finding.saving || submitting;
  $('keep-draft').hidden = !conflict || finding.locked;
  $('keep-draft').disabled = !conflict?.latest || disabled;
}

function currentDelivery() {
  const batch = attempt?.pending && state.batches?.find(item => item.requestId === attempt.pending.requestId);
  return (batch && state.deliveries?.find(item => item.batchId === batch.id)) || state.delivery || {};
}

function deliveryMessage() {
  const delivery = currentDelivery();
  if (delivery.error || delivery.status === 'failed') {
    message($('delivery-message'), `Your choices are saved, but the chat was not told.${delivery.error ? ` ${typeof delivery.error === 'string' ? delivery.error : delivery.error.message || 'Notification failed.'}` : ''} Click Retry notification to send the same choices again.`, 'error');
  } else if (['pending', 'sending'].includes(delivery.status)) {
    message($('delivery-message'), 'Your choices are saved. The page is telling the chat now. If nothing happens, click Retry notification.');
  } else message($('delivery-message'), '');
}

function renderDetails() {
  const groups = [['Coverage', state.coverage], ['Verification', state.verification]];
  const signature = JSON.stringify(groups);
  if (signature === detailsSignature) return;
  detailsSignature = signature;
  const content = $('detail-content'); content.replaceChildren();
  let count = 0;
  for (const [title, entries] of groups) {
    if (!Array.isArray(entries) || !entries.length) continue;
    count += entries.length;
    content.append(node('h3', '', title));
    const list = node('ul', 'detail-list');
    for (const entry of entries) {
      const value = typeof entry === 'string' ? entry : [entry.title || entry.name || entry.scope || entry.path || entry.reviewer, entry.status, entry.summary || entry.result || entry.details || entry.message].filter(Boolean).join(' · ') || JSON.stringify(entry);
      list.append(node('li', '', value));
    }
    content.append(list);
  }
  $('review-detail').hidden = count === 0;
  text($('detail-count'), `(${count})`);
}

function render() {
  if (!state) return;
  const findings = drafts.list();
  renderKinds(findings);
  const tally = tabCounts(findings, kinds);
  if (!tab) tab = tally.pending ? 'pending' : tally.decided ? 'decided' : tally.progress ? 'progress' : 'all';
  for (const button of document.querySelectorAll('[data-tab]')) button.setAttribute('aria-pressed', String(button.dataset.tab === tab));
  for (const name of TABS) text($(`count-${name}`), tally[name]);
  if (!selectedId || !findings.some(finding => finding.id === selectedId)) selectedId = matching(findings)[0]?.id ?? null;
  listed = listedFindings(findings);
  renderList(findings);
  renderDetail(findings.find(finding => finding.id === selectedId));

  const searching = Boolean($('search').value.trim()) || kinds.size > 0;
  $('list-empty').hidden = listed.length > 0;
  text($('list-empty'), !findings.length ? 'No findings yet.' : searching ? 'No findings match your search or filters.' : emptyTab[tab]);
  text($('empty-title'), !findings.length ? 'No findings yet' : listed.length ? 'Pick a finding from the list' : searching ? 'No findings match your search or filters' : emptyTab[tab]);
  text($('empty-detail'), !findings.length ? 'Findings show up here as the review runs.' : listed.length ? 'Or press J to open the first one.' : 'Pick another tab to see other findings.');

  const ready = tally.decided;
  const unsettled = findings.filter(finding => finding.saveState !== 'saved');
  const problems = unsettled.filter(finding => ['conflict', 'error'].includes(finding.saveState));
  const saveText = submitting ? 'Saving and submitting…' : attempt?.reloadRequired ? 'The findings changed. Reload them first.' : problems.length ? `${problems.length} draft${problems.length === 1 ? '' : 's'} need attention.` : unsettled.length ? `Saving ${unsettled.length} draft${unsettled.length === 1 ? '' : 's'}…` : attempt?.pending ? 'Submit sent. Waiting for confirmation.' : 'All drafts saved.';
  text($('save-summary'), `${ready ? `${ready} ready to submit.` : 'Nothing to submit yet.'} ${saveText}`);
  const retry = Boolean(attempt?.pending);
  const notificationRetry = retry && ['failed', 'pending', 'sending'].includes(currentDelivery().status);
  text($('submit'), submitting ? 'Submitting…' : notificationRetry ? 'Retry notification' : retry ? 'Retry Submit' : ready ? `Submit ${ready} choice${ready === 1 ? '' : 's'}` : 'Submit');
  $('submit').disabled = submitting || Boolean(attempt?.reloadRequired) || (!retry && (ready === 0 || state.review.closed || problems.length > 0));
  $('reload-action').hidden = !attempt?.reloadRequired;
  $('reload-findings').disabled = submitting;
  text($('submit-help'), attempt?.reloadRequired ? 'Reload findings, check your choices, then Submit again.' : retry ? 'Retry sends the same choices. It cannot send newer drafts.' : state.review.mirror ? `Submit sends your choices to the chat on ${state.review.mirror.sourceHost}.` : state.review.deliveryMode === 't3' ? 'Submit resumes the chat.' : 'After Submit, type “resume the review” in the chat.');
  deliveryMessage(); renderDetails();
}

function applyState(next) {
  if (!next?.review?.id || !Array.isArray(next.findings)) throw new Error('The review service sent an incomplete state.');
  if (state && next.review.id !== state.review.id) throw new Error('The service switched to a different review. Reload this page to continue.');
  state = next;
  if (!attempt) {
    let storage;
    try { storage = window.sessionStorage; } catch { /* Memory-only retries remain available. */ }
    attempt = new SubmissionAttempt({ storage, reviewId: state.review.id, randomUUID: () => crypto.randomUUID() });
  }
  attempt.restore(recoverSubmission(state));
  if (attempt.reloadRequired) message($('page-message'), `Not submitted: the review changed. ${attempt.reloadRequired} Reload findings and check your choices before you submit again.`, 'error');
  const review = state.review;
  text($('project-title'), review.project || 'Project');
  document.title = `${review.project || 'Project'} · Review`;
  text($('branch-name'), review.branch || '');
  const scope = review.scope === 'diff' ? `changes since ${review.baseRef || 'its base'}` : 'whole branch';
  text($('review-meta'), [review.reviewedSha ? `@ ${review.reviewedSha.slice(0, 7)}` : '', scope, review.host ? `on ${review.host}` : ''].filter(Boolean).join(' · '));
  const prUrl = state.pullRequest?.url;
  const safePr = typeof prUrl === 'string' && /^https:\/\//.test(prUrl);
  $('pr-link').hidden = !safePr;
  if (safePr && $('pr-link').href !== prUrl) $('pr-link').href = prUrl;
  const isTerminal = (state.delivery?.mode || review.deliveryMode) !== 't3';
  $('handoff').hidden = false;
  text($('handoff'), review.closed ? 'This review is closed. Its choices are read-only.' : review.mirror ? `Pick a choice for each finding. Add a note if you want. Click Submit. Your choices go to the review chat on ${review.mirror.sourceHost}, and the work happens there.` : isTerminal ? 'Pick a choice for each finding. Add a note if you want. Click Submit, then go back to the chat and type “resume the review”.' : 'Pick a choice for each finding. Add a note if you want. Click Submit. Submit resumes the chat automatically.');
  drafts.ingest(state.findings);
  render();
}

async function refreshState({ allowDuringSubmit = false } = {}) {
  if (refreshInFlight) return refreshInFlight;
  const epoch = stateEpoch;
  refreshInFlight = api('/api/state').then(next => {
    if (epoch !== stateEpoch || (submitting && !allowDuringSubmit)) return;
    applyState(next);
    message($('connection-message'), '');
    $('connection-status').classList.remove('offline');
    text($('connection-text'), document.hidden ? 'Paused' : 'Live');
  }).catch(error => {
    $('connection-status').classList.add('offline'); text($('connection-text'), 'Offline');
    message($('connection-message'), error.message, 'error');
    if (!state) text($('save-summary'), 'The review is not available yet. The page keeps trying while it is open.');
    throw error;
  }).finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

async function submit() {
  if (!state || submitting || attempt?.reloadRequired) return;
  stateEpoch += 1;
  submitting = true; message($('page-message'), ''); render();
  try {
    const result = await sendSubmission({ drafts, attempt, reviewedSha: state.review.reviewedSha, send: payload => api('/api/submit', { method: 'POST', body: JSON.stringify(payload) }) });
    // Ignore polls that began before this authoritative submit response.
    stateEpoch += 1;
    applyState(result.state);
    const delivery = currentDelivery();
    const needsNotification = ['failed', 'pending', 'sending'].includes(delivery.status) || Boolean(delivery.error);
    if (!needsNotification) attempt.complete();
    if (!needsNotification) message($('page-message'), state.review.mirror ? `Submitted. Your choices are on their way to the chat on ${state.review.mirror.sourceHost}. Progress shows in that chat.` : state.review.deliveryMode === 't3' ? 'Submitted. The chat was told. Progress shows here.' : 'Submitted. Go back to the chat and type “resume the review”.', 'success');
  } catch (error) {
    message($('page-message'), attempt?.reloadRequired ? `Not submitted: the review changed. ${error.message} Reload findings and check your choices before you submit again.` : attempt?.pending ? `Submit could not be confirmed: ${error.message} Click Retry Submit. It sends the same choices again. Editing is paused until Submit is confirmed.` : `Not submitted: ${error.message} Fix the draft save error, then Submit again.`, 'error');
  } finally { submitting = false; render(); }
}

async function reloadFindings() {
  if (submitting || !attempt?.reloadRequired) return;
  submitting = true; stateEpoch += 1; render();
  try {
    // A response already in flight may describe the rejected snapshot.
    if (refreshInFlight) await refreshInFlight.catch(() => {});
    await refreshState({ allowDuringSubmit: true });
    attempt.complete();
    message($('page-message'), 'Findings reloaded. Check your choices, then Submit again. Reloading did not submit anything.');
  } catch (error) {
    message($('page-message'), `Could not reload findings: ${error.message} Nothing was submitted. Try Reload findings again.`, 'error');
  } finally { submitting = false; render(); }
}

function schedulePolling() {
  clearTimeout(pollTimer);
  if (document.hidden) { text($('connection-text'), 'Paused'); return; }
  pollTimer = setTimeout(async () => { try { await refreshState(); } catch { /* The error stays visible on the page. */ } schedulePolling(); }, 3_000);
}

/* Events. */

for (const button of document.querySelectorAll('[data-theme-choice]')) {
  button.addEventListener('click', () => { writePref('review-work:theme', button.dataset.themeChoice); applyTheme(button.dataset.themeChoice); savePrefs({ theme: button.dataset.themeChoice }); });
}
for (const button of document.querySelectorAll('[data-tab]')) button.addEventListener('click', () => setTab(button.dataset.tab));
for (const button of $('choices').querySelectorAll('[data-decision]')) button.addEventListener('click', () => choose(button.dataset.decision));
$('toggle-list').addEventListener('click', () => setListHidden(!$('split').classList.contains('list-hidden')));
$('prev-finding').addEventListener('click', () => move(-1));
$('next-finding').addEventListener('click', () => move(1));
$('filters').addEventListener('submit', event => event.preventDefault());
$('search').addEventListener('input', () => { resetSelectionToMatches(); render(); });
$('note').addEventListener('input', () => {
  if (!selectedId) return;
  try { drafts.update(selectedId, { context: $('note').value }); }
  catch (error) { message($('page-message'), error.message, 'error'); }
});
$('retry-save').addEventListener('click', () => { if (selectedId) drafts.save(selectedId).catch(error => message($('page-message'), error.message, 'error')); });
$('use-saved').addEventListener('click', () => { try { if (selectedId) drafts.acceptRemote(selectedId); } catch (error) { message($('page-message'), error.message, 'error'); } });
$('keep-draft').addEventListener('click', () => { try { if (selectedId) drafts.retryLocal(selectedId); } catch (error) { message($('page-message'), error.message, 'error'); } });
$('submit').addEventListener('click', submit);
$('reload-findings').addEventListener('click', reloadFindings);

document.addEventListener('keydown', event => {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || !state) return;
  const target = event.target;
  const typing = target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
  if (typing) {
    if (event.key === 'Escape') target.blur();
    return;
  }
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (key === 'j') move(1);
  else if (key === 'k') move(-1);
  else if (keyChoices[key]) choose(keyChoices[key]);
  else if (key === 'n' && selectedId && !$('note').disabled) $('note').focus();
  else if (key === 'l') setListHidden(!$('split').classList.contains('list-hidden'));
  else if (key === '/') $('search').focus();
  else return;
  event.preventDefault();
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshState().catch(() => {});
  schedulePolling();
});
window.addEventListener('beforeunload', event => {
  if (submitting || drafts.list().some(finding => finding.dirty)) { event.preventDefault(); event.returnValue = ''; }
});

applyTheme(readPref('review-work:theme'));
setListHidden(readPref('review-work:list-hidden') === '1', { remember: false });
loadPrefs();
refreshState().catch(() => {}).finally(schedulePolling);
