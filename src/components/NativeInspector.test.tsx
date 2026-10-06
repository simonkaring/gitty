// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { RepositorySession } from '../model/repository';
import { NativeInspector } from './NativeInspector';
import type { MutationOutcome } from '../model/workflow';

type Args = { oid?: string; spec?: { oid?: string } };
const mocks = vi.hoisted(() => ({ native: vi.fn<(command: string, args: Args) => Promise<unknown>>() }));
vi.mock('../model/native', async importOriginal => ({ ...await importOriginal<typeof import('../model/native')>(), native: mocks.native }));

const commit = (id: string, subject: string) => ({ id, parents: ['p1'], subject, body: '', author: 'Ada Lovelace', email: 'ada@example.com', timestamp: 1 });
const files = [{ path: 'src/a.ts', oldPath: null, status: 'M', additions: 1, deletions: 0, binary: false }];

it('shows placeholders only on first load, then keeps the previous commit in place until the next one lands', async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const gates = new Map<string, { promise: Promise<void>; open: () => void; fail: boolean }>();
  const gate = (oid: string, fail = false) => {
    let open!: () => void;
    const promise = new Promise<void>(resolve => { open = resolve; });
    gates.set(oid, { promise, open, fail });
  };
  mocks.native.mockImplementation(async (command, args) => {
    const oid = args.oid ?? args.spec!.oid!;
    const g = gates.get(oid)!;
    await g.promise;
    if (g.fail) throw new Error('boom');
    return command === 'repository_commit' ? commit(oid, `Subject ${oid}`) : files;
  });
  const host = document.createElement('div');
  const root = createRoot(host);
  const props = { session: { handle: 'h', head: null } as unknown as RepositorySession, revision: 0, base: '', target: '', onJump() {}, onBase() {}, onTarget() {}, onSwap() {}, onClear() {}, onClose() {}, activePath: null, onActiveDiffChange() {} };
  const render = (selected: string) => act(async () => { root.render(<NativeInspector {...props} selected={selected} />); });
  const aside = () => host.querySelector('aside')!;
  try {
    // First load: nothing to show yet, so layout-matched placeholders hold the space.
    gate('a');
    await render('a');
    expect(aside().getAttribute('aria-busy')).toBe('true');
    expect(host.querySelectorAll('.skeleton-text').length).toBeGreaterThan(0);
    expect(host.textContent).not.toContain('Subject a');
    expect(host.querySelectorAll('.file-row[aria-hidden="true"]')).toHaveLength(4);
    await act(async () => { gates.get('a')!.open(); });
    expect(aside().getAttribute('aria-busy')).toBe('false');
    expect(host.querySelector('.skeleton-text')).toBeNull();
    expect(host.querySelector('h2')?.textContent).toBe('Subject a');

    // Switching rows: previous commit stays rendered (no placeholders, no blank), marked stale and inert.
    gate('b');
    await render('b');
    expect(aside().getAttribute('aria-busy')).toBe('true');
    expect(host.querySelector('.inspector-content')?.hasAttribute('data-stale')).toBe(true);
    expect(host.querySelector('.skeleton-text')).toBeNull();
    expect(host.querySelector('h2')?.textContent).toBe('Subject a');
    expect(host.querySelector('.native-sha')?.textContent).toBe('a');
    expect(host.querySelectorAll('.file-row')).toHaveLength(1);
    expect(host.querySelector<HTMLButtonElement>('.parent-link')?.disabled).toBe(true);
    await act(async () => { gates.get('b')!.open(); });
    expect(aside().getAttribute('aria-busy')).toBe('false');
    expect(host.querySelector('.inspector-content')?.hasAttribute('data-stale')).toBe(false);
    expect(host.querySelector('h2')?.textContent).toBe('Subject b');
    expect(host.querySelector('.native-sha')?.textContent).toBe('b');
    expect(host.querySelector<HTMLButtonElement>('.parent-link')?.disabled).toBe(false);

    // A failed load must not leave the previous commit's data under the new selection.
    gate('c', true);
    await render('c');
    await act(async () => { gates.get('c')!.open(); });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('boom');
    expect(host.textContent).not.toContain('Subject b');
    expect(host.querySelectorAll('.file-row')).toHaveLength(0);
  } finally {
    await act(async () => { root.unmount(); });
  }
});


// ---- Inline editing of the HEAD commit message ----

const MAIN = 'refs/heads/main';
const head = (id: string, headRef: string | null = MAIN) => ({ handle: 'h', head: id, headRef }) as unknown as RepositorySession;
type EditRequest = { oid: string; headRef: string; message: string };
let eligibility: { canEditMessage?: boolean; editDisabledReason?: string | null } = { canEditMessage: true };
let commitGate: Promise<void> | null = null;
afterEach(() => { eligibility = { canEditMessage: true }; commitGate = null; });

async function mount(initial: { selected?: string; session?: RepositorySession; revision?: number; writeBlocked?: boolean } = {}) {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.native.mockImplementation(async (command, args) => {
    if (command !== 'repository_commit') return files;
    const gate = commitGate;
    if (gate) await gate;
    return { ...commit(args.oid!, 'Original subject'), body: 'Original subject\n\nOriginal body', ...eligibility };
  });
  const onEditMessage = vi.fn<(request: EditRequest) => Promise<MutationOutcome>>();
  const notify = vi.fn<(message: string) => void>();
  const host = document.createElement('div');
  const root = createRoot(host);
  let current = { selected: 'c1', session: head('c1'), revision: 0, writeBlocked: false, ...initial };
  const render = (next: Partial<typeof current> = {}) => act(async () => {
    current = { ...current, ...next };
    root.render(<NativeInspector session={current.session} selected={current.selected} revision={current.revision} base="" target="" onJump={() => {}} onBase={() => {}} onTarget={() => {}} onSwap={() => {}} onClear={() => {}} onClose={() => {}} activePath={null} onActiveDiffChange={() => {}} onEditMessage={onEditMessage} notify={notify} writeBlocked={current.writeBlocked} />);
  });
  await render();
  const q = <T extends Element>(selector: string) => host.querySelector<T>(selector);
  const set = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => act(async () => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const api = {
    host, render, onEditMessage, notify, q,
    subject: () => q<HTMLInputElement>('.commit-message-editor input')!,
    body: () => q<HTMLTextAreaElement>('.commit-message-editor textarea')!,
    save: () => q<HTMLButtonElement>('.commit-message-editor button[type="submit"]'),
    form: () => q<HTMLFormElement>('form.commit-message-editor'),
    alert: () => q('.commit-message-editor [role="alert"]')?.textContent ?? '',
    open: () => act(async () => { q<HTMLElement>('h2.editable-commit-heading')!.click(); }),
    submit: () => act(async () => { api.form()!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }),
    shortcut: () => act(async () => { api.subject().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true })); }),
    edit: async (subject: string, body?: string) => { await set(api.subject(), subject); if (body !== undefined) await set(api.body(), body); },
    cleanup: () => act(async () => { root.unmount(); }),
  };
  return api;
}
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };

it('edits the HEAD message inline, sending the captured commit and branch, and closes on a confirmed write', async () => {
  const t = await mount();
  try {
    const heading = t.q('h2.editable-commit-heading')!;
    expect(heading.textContent).toBe('Original subject');
    t.onEditMessage.mockResolvedValue({ oid: 'c2' });
    await t.open();
    expect(t.subject().value).toBe('Original subject');
    expect(t.body().value).toBe('Original body');
    await t.edit('Updated subject', 'Updated body');
    await t.submit();
    expect(t.onEditMessage).toHaveBeenCalledExactlyOnceWith({ oid: 'c1', headRef: MAIN, message: 'Updated subject\n\nUpdated body' });
    expect(t.form()).toBeNull();
    expect(t.notify).toHaveBeenCalledWith('Commit message updated.');
  } finally { await t.cleanup(); }
});

it('offers no editing for a commit that is not HEAD or that the backend refused, and explains the refusal without string matching', async () => {
  // Backend says yes, but this is not HEAD: the inspector never edits non-HEAD commits.
  let t = await mount({ selected: 'c0' });
  try {
    expect(t.q('h2')?.textContent).toBe('Original subject');
    expect(t.q('.editable-commit-heading')).toBeNull();
    expect(t.q('[aria-label="Edit commit message"]')).toBeNull();
    expect(t.q('.commit-edit-note')).toBeNull();
  } finally { await t.cleanup(); }
  // HEAD, refused: the readable reason is shown as a note, with no special-cased "Pushed" badge.
  eligibility = { canEditMessage: false, editDisabledReason: 'Contained in origin/main by local refs, which are not proof about the remote.' };
  t = await mount();
  try {
    expect(t.q('.editable-commit-heading')).toBeNull();
    expect(t.q('[aria-label="Edit commit message"]')).toBeNull();
    expect(t.q('.commit-edit-note')?.textContent).toContain('not proof about the remote');
    expect([...t.host.querySelectorAll('.badge')].map(badge => badge.textContent)).toEqual(['HEAD']);
  } finally { await t.cleanup(); }
  // Detached or session without a branch: no capture is possible, so no editing.
  eligibility = { canEditMessage: true };
  t = await mount({ session: head('c1', null) });
  try { expect(t.q('.editable-commit-heading')).toBeNull(); } finally { await t.cleanup(); }
  // A repository write in flight or a blocked refresh.
  t = await mount({ writeBlocked: true });
  try { expect(t.q('.editable-commit-heading')).toBeNull(); } finally { await t.cleanup(); }
  // Demo-style details (no eligibility fields at all) are not editable either.
  eligibility = {};
  t = await mount();
  try { expect(t.q('.editable-commit-heading')).toBeNull(); } finally { await t.cleanup(); }
});

it('never writes an empty or unchanged message', async () => {
  const t = await mount();
  try {
    await t.open();
    expect(t.save()!.disabled).toBe(true);
    await t.submit(); await t.shortcut();
    expect(t.alert()).toBe('The message has not changed.');
    // Whitespace around the subject is not a change.
    await t.edit('Original subject   ');
    expect(t.save()!.disabled).toBe(true);
    await t.edit('   ');
    expect(t.save()!.disabled).toBe(true);
    await t.submit();
    expect(t.alert()).toBe('Commit subject cannot be empty.');
    expect(t.onEditMessage).not.toHaveBeenCalled();
    await t.edit('Different');
    expect(t.save()!.disabled).toBe(false);
  } finally { await t.cleanup(); }
});

it('ignores a second submit while saving and never retargets a completion that arrives after the selection changed', async () => {
  const t = await mount();
  const write = deferred<MutationOutcome>();
  try {
    t.onEditMessage.mockReturnValue(write.promise);
    await t.open();
    await t.edit('Reworded');
    await t.submit();
    await t.submit(); await t.shortcut();
    expect(t.onEditMessage).toHaveBeenCalledOnce();
    expect(t.save()!.textContent).toBe('Saving…');
    expect(t.save()!.disabled).toBe(true);
    // Escape cannot cancel a write in flight.
    await act(async () => { t.subject().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(t.form()).not.toBeNull();

    await t.render({ selected: 'c0' });
    expect(t.form()).toBeNull();
    await act(async () => { write.resolve({ oid: 'c2' }); });
    // The late success is reported for what it was; nothing was re-sent for the new selection.
    expect(t.notify).toHaveBeenCalledExactlyOnceWith('Commit message updated.');
    expect(t.onEditMessage).toHaveBeenCalledOnce();
    expect(t.onEditMessage.mock.calls[0][0].oid).toBe('c1');
    expect(t.form()).toBeNull();
  } finally { await t.cleanup(); }
});

it('reports a late failure through notify once the editor it belonged to is gone', async () => {
  const t = await mount();
  const write = deferred<MutationOutcome>();
  try {
    t.onEditMessage.mockReturnValue(write.promise);
    await t.open(); await t.edit('Reworded'); await t.submit();
    await t.render({ selected: 'c0' });
    await act(async () => { write.resolve({ error: 'Already pushed' }); });
    expect(t.notify).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('Commit message was not updated. Already pushed'));
    expect(t.form()).toBeNull();
  } finally { await t.cleanup(); }
});

it('keeps the draft but blocks saving when HEAD or its branch changes under an open editor', async () => {
  const t = await mount();
  try {
    t.onEditMessage.mockResolvedValue({ oid: 'c9' });
    await t.open();
    await t.edit('My careful draft', 'with a body');
    await t.render({ session: head('c2') });
    expect(t.subject().value).toBe('My careful draft');
    expect(t.body().value).toBe('with a body');
    expect(t.save()!.disabled).toBe(true);
    expect(t.alert()).toContain('HEAD changed after editing started');
    await t.submit(); await t.shortcut();
    expect(t.onEditMessage).not.toHaveBeenCalled();

    await t.render({ session: head('c1', 'refs/heads/other') });
    expect(t.save()!.disabled).toBe(true);
    expect(t.alert()).toContain('HEAD changed after editing started');
    await t.submit();
    expect(t.onEditMessage).not.toHaveBeenCalled();

    // Back to the captured commit and branch: the same draft can be saved again.
    await t.render({ session: head('c1') });
    expect(t.subject().value).toBe('My careful draft');
    expect(t.save()!.disabled).toBe(false);
    await t.submit();
    expect(t.onEditMessage).toHaveBeenCalledExactlyOnceWith({ oid: 'c1', headRef: MAIN, message: 'My careful draft\n\nwith a body' });
  } finally { await t.cleanup(); }
});

it('blocks saving while commit details reload or eligibility is lost, without losing the draft', async () => {
  const t = await mount();
  try {
    await t.open(); await t.edit('Draft');
    const reload = deferred<void>();
    commitGate = reload.promise;
    await t.render({ revision: 1 });
    expect(t.save()!.disabled).toBe(true);
    expect(t.alert()).toBe('Reloading commit details…');
    await t.shortcut();
    expect(t.onEditMessage).not.toHaveBeenCalled();
    eligibility = { canEditMessage: false, editDisabledReason: 'A remote-tracking ref now contains this commit.' };
    await act(async () => { reload.resolve(); });
    expect(t.subject().value).toBe('Draft');
    expect(t.save()!.disabled).toBe(true);
    expect(t.alert()).toBe('A remote-tracking ref now contains this commit.');
    await t.submit();
    expect(t.onEditMessage).not.toHaveBeenCalled();
    // A write elsewhere blocks saving too.
    eligibility = { canEditMessage: true };
    await t.render({ revision: 2 });
    expect(t.save()!.disabled).toBe(false);
    await t.render({ writeBlocked: true });
    expect(t.save()!.disabled).toBe(true);
    expect(t.alert()).toContain('Another repository write is running');
  } finally { await t.cleanup(); }
});

it('distinguishes every kind of mutation outcome and never retries on its own', async () => {
  const t = await mount();
  try {
    await t.open(); await t.edit('Draft', 'Body');
    // A refused or failed write keeps the editor and the draft.
    t.onEditMessage.mockResolvedValueOnce({ error: 'This commit is already contained in origin/main' });
    await t.submit();
    expect(t.alert()).toContain('already contained in origin/main');
    expect(t.alert()).toContain('nothing is retried automatically');
    expect(t.subject().value).toBe('Draft');
    expect(t.onEditMessage).toHaveBeenCalledOnce();

    // A failed write whose refresh also failed says both.
    t.onEditMessage.mockResolvedValueOnce({ error: 'Hook failed', refreshError: 'Snapshot unavailable' });
    await t.submit();
    expect(t.alert()).toContain('Hook failed');
    expect(t.alert()).toContain('Snapshot unavailable');

    // A session change is not a Git failure.
    t.onEditMessage.mockResolvedValueOnce({ superseded: true });
    await t.submit();
    expect(t.alert()).toContain('repository session changed');

    // No oid and no error: Git did not confirm anything.
    t.onEditMessage.mockResolvedValueOnce({});
    await t.submit();
    expect(t.alert()).toContain('did not report a new commit');

    // A thrown error is an error outcome, not an unhandled rejection.
    t.onEditMessage.mockRejectedValueOnce(new Error('IPC down'));
    await t.submit();
    expect(t.alert()).toContain('IPC down');
    expect(t.onEditMessage).toHaveBeenCalledTimes(5);
    expect(t.notify).not.toHaveBeenCalled();

    // A confirmed write whose refresh failed is still a success: the editor closes and the failure is surfaced.
    t.onEditMessage.mockResolvedValueOnce({ oid: 'c2', refreshError: 'Snapshot unavailable' });
    await t.submit();
    expect(t.form()).toBeNull();
    expect(t.notify).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^Commit message updated\..*Snapshot unavailable.*blocked/));
    expect(t.onEditMessage).toHaveBeenCalledTimes(6);
  } finally { await t.cleanup(); }
});

it('ends the editor when the selection changes and starts a fresh one bound to the current HEAD', async () => {
  const t = await mount();
  try {
    await t.open(); await t.edit('Abandoned');
    await t.render({ selected: 'c0' });
    expect(t.form()).toBeNull();
    await t.render({ selected: 'c1' });
    expect(t.form()).toBeNull();
    await t.open();
    expect(t.subject().value).toBe('Original subject');
    await t.edit('Fresh');
    t.onEditMessage.mockResolvedValue({ oid: 'c2' });
    await t.submit();
    expect(t.onEditMessage).toHaveBeenCalledExactlyOnceWith({ oid: 'c1', headRef: MAIN, message: 'Fresh\n\nOriginal body' });
  } finally { await t.cleanup(); }
});
