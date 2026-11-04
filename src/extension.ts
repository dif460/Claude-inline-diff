import * as fs from 'fs';
import * as vscode from 'vscode';
import { FileHistoryReader } from './claude/fileHistory';
import { discoverSessions, SessionCandidate } from './claude/sessions';
import { TranscriptParser } from './claude/transcript';
import {
  BaselineMode,
  buildFileChanges,
  FileChange,
  LocalBaseline
} from './core/changeBuilder';
import {
  applyHunkToBaseline,
  findHunkAtLine,
  findHunkBySignature,
  revertHunkInCurrent
} from './core/lineDiff';
import { joinLines, pathKey, splitText } from './core/lines';
import { BaselineStore } from './storage/baselineStore';
import { DecorationManager } from './ui/decorations';
import { REVIEW_SCHEME, ReviewProvider } from './ui/reviewProvider';
import { ChangesTreeProvider } from './ui/treeProvider';
import type { ChangeNode } from './ui/treeProvider';

const PINNED_SESSION_KEY = 'claudeInlineDiff.pinnedSessionId';
const POLL_INTERVAL_MS = 2000;
const DISCOVERY_INTERVAL_MS = 4000;
const COMPLETION_FLASH_MS = 8000;
/** Claude Code does not reliably write an end-of-turn marker, so treat a quiet transcript as "done for now". */
const COMPLETION_QUIET_MS = 5000;

interface Settings {
  enabled: boolean;
  baselineMode: BaselineMode;
  showDeletedSummary: boolean;
  sessionMaxAgeHours: number;
  maxFileSizeKB: number;
  maxFileSizeBytes: number;
  exclude: string[];
  showCompletionStatus: boolean;
}

function readSettings(): Settings {
  const config = vscode.workspace.getConfiguration('claudeInlineDiff');
  const maxFileSizeKB = Math.max(16, config.get<number>('maxFileSizeKB', 5120));
  return {
    enabled: config.get<boolean>('enabled', true),
    baselineMode: config.get<BaselineMode>('baselineMode', 'session') === 'turn' ? 'turn' : 'session',
    showDeletedSummary: config.get<boolean>('showDeletedSummary', true),
    sessionMaxAgeHours: Math.max(1, config.get<number>('sessionMaxAgeHours', 168)),
    maxFileSizeKB,
    maxFileSizeBytes: maxFileSizeKB * 1024,
    exclude: config.get<string[]>('exclude', []),
    showCompletionStatus: config.get<boolean>('showCompletionStatus', true)
  };
}

function workspaceRoots(): string[] {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return [];
  }
  return folders.map((folder) => folder.uri.fsPath);
}

function formatRelative(timestampMs: number): string {
  const delta = Math.max(0, Date.now() - timestampMs);
  if (delta < 60_000) {
    return '刚刚';
  }
  if (delta < 3600_000) {
    return `${Math.floor(delta / 60_000)} 分钟前`;
  }
  if (delta < 86400_000) {
    return `${Math.floor(delta / 3600_000)} 小时前`;
  }
  return `${Math.floor(delta / 86400_000)} 天前`;
}

function logLine(output: vscode.OutputChannel, message: string): void {
  output.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
}

interface SessionQuickPickItem extends vscode.QuickPickItem {
  session?: SessionCandidate;
  followLatest?: boolean;
}

interface MenuQuickPickItem extends vscode.QuickPickItem {
  run?: () => void | Thenable<void>;
}

export class ClaudeInlineDiffController implements vscode.Disposable {
  private readonly output: vscode.OutputChannel;
  private readonly fileHistory = new FileHistoryReader();
  private readonly baselineStore: BaselineStore;
  private readonly reviewProvider = new ReviewProvider();
  private readonly decorations: DecorationManager;
  private readonly treeProvider = new ChangesTreeProvider();
  private readonly statusBar: vscode.StatusBarItem;
  private readonly treeView: vscode.TreeView<ChangeNode>;
  private readonly disposables: vscode.Disposable[] = [];

  private settings: Settings = readSettings();
  private session: SessionCandidate | undefined;
  private parser: TranscriptParser | undefined;
  private localBaselines = new Map<string, LocalBaseline>();
  private changes: FileChange[] = [];
  private changesByKey = new Map<string, FileChange>();
  private pinnedSessionId: string | undefined;
  /** Session this window adopted; kept until another transcript grows while focused. */
  private boundSessionId: string | undefined;
  private windowFocused = vscode.window.state.focused;
  private readonly sessionSizes = new Map<string, { size: number; mtimeMs: number }>();
  private sawFirstDiscovery = false;

  private discoveredSessions: SessionCandidate[] = [];
  private lastDiscoveryAt = 0;
  private lastEndTurnTimestamp: string | undefined;
  private lastTranscriptActivityAt = 0;
  private completionNotified = true;
  private suppressInitialCompletion = false;
  private workspaceDirty = false;

  private refreshing = false;
  private refreshPending = false;
  private disposed = false;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private completionTimer: ReturnType<typeof setTimeout> | undefined;
  private completionFlashUntil = 0;
  private acceptQueue: Promise<void> = Promise.resolve();

  constructor(private readonly context: vscode.ExtensionContext) {
    this.output = vscode.window.createOutputChannel('Claude Inline Diff');
    this.baselineStore = new BaselineStore(context);
    this.decorations = new DecorationManager();
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
    this.statusBar.command = 'claudeInlineDiff.showMenu';
    this.treeView = vscode.window.createTreeView('claudeInlineDiff.changes', {
      treeDataProvider: this.treeProvider,
      showCollapseAll: true
    });
  }

  async initialize(): Promise<void> {
    this.context.subscriptions.push(this);
    await this.baselineStore.initialize();

    this.pinnedSessionId = this.context.workspaceState.get<string>(PINNED_SESSION_KEY);

    this.context.subscriptions.push(
      this.output,
      this.statusBar,
      this.treeView,
      this.treeProvider,
      this.reviewProvider,
      this.decorations,
      vscode.workspace.registerTextDocumentContentProvider(REVIEW_SCHEME, this.reviewProvider),
      vscode.languages.registerCodeLensProvider({ scheme: REVIEW_SCHEME }, this.reviewProvider)
    );

    this.registerCommands();
    this.registerListeners();

    this.statusBar.hide();
    await this.updateContextKeys();
    this.pollTimer = setInterval(() => {
      void this.refresh(false);
    }, POLL_INTERVAL_MS);
    void this.refresh(true);
  }

  /**
   * Commands can arrive from CodeLens/hover (plain strings), editor menus
   * (a Uri) or tree items (the tree node element). Normalize them here.
   */
  private unwrapFsPath(arg: unknown): string | undefined {
    if (typeof arg === 'string') {
      return arg;
    }
    if (!arg || typeof arg !== 'object') {
      return undefined;
    }
    if (arg instanceof vscode.Uri) {
      return arg.fsPath;
    }
    const node = arg as { kind?: unknown; change?: { path?: unknown }; hunk?: unknown };
    if (typeof node.change?.path === 'string') {
      return node.change.path;
    }
    return undefined;
  }

  private unwrapSignature(arg: unknown): string | undefined {
    if (typeof arg === 'string') {
      return arg;
    }
    if (!arg || typeof arg !== 'object') {
      return undefined;
    }
    const node = arg as { kind?: unknown; hunk?: { signature?: unknown } };
    if (typeof node.hunk?.signature === 'string') {
      return node.hunk.signature;
    }
    return undefined;
  }

  private registerCommands(): void {
    const register = (command: string, callback: (...args: unknown[]) => unknown): void => {
      this.context.subscriptions.push(vscode.commands.registerCommand(command, callback));
    };
    register('claudeInlineDiff.openReview', (first?: unknown, second?: unknown) =>
      this.openReview(this.unwrapFsPath(first), this.unwrapSignature(second) ?? this.unwrapSignature(first))
    );
    register('claudeInlineDiff.acceptHunk', (first?: unknown, second?: unknown) =>
      this.acceptHunk(this.unwrapFsPath(first), this.unwrapSignature(second) ?? this.unwrapSignature(first))
    );
    register('claudeInlineDiff.acceptFile', (first?: unknown) =>
      this.acceptFile(this.unwrapFsPath(first))
    );
    register('claudeInlineDiff.acceptAll', () => this.acceptAll());
    register('claudeInlineDiff.rejectHunk', (first?: unknown, second?: unknown) =>
      this.rejectHunk(this.unwrapFsPath(first), this.unwrapSignature(second) ?? this.unwrapSignature(first))
    );
    register('claudeInlineDiff.rejectFile', (first?: unknown) =>
      this.rejectFile(this.unwrapFsPath(first))
    );
    register('claudeInlineDiff.rejectAll', () => this.rejectAll());
    register('claudeInlineDiff.resetReviewed', () => this.resetReviewed());
    register('claudeInlineDiff.refresh', () => this.refresh(true));
    register('claudeInlineDiff.showMenu', () => this.showMenu());
    register('claudeInlineDiff.selectSession', () => this.selectSession());
    register('claudeInlineDiff.openSourceAt', (first?: unknown, second?: unknown) =>
      this.reviewProvider.openSourceAt(
        this.unwrapFsPath(first),
        this.unwrapSignature(second) ?? this.unwrapSignature(first)
      )
    );
    register('claudeInlineDiff.showOutput', () => {
      this.output.show(true);
    });
  }

  private registerListeners(): void {
    this.disposables.push(
      vscode.window.onDidChangeWindowState((state) => {
        this.windowFocused = state.focused;
      }),
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.applyDecorations();
        void this.updateContextKeys();
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => {
        this.applyDecorations();
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document.uri.scheme === REVIEW_SCHEME) {
          // The provider replaced a review document's content; reapply
          // decorations once the editor has the new text.
          this.applyDecorations();
          return;
        }
        if (event.document.uri.scheme !== 'file') {
          return;
        }
        if (event.contentChanges.length === 0) {
          return;
        }
        // Manual edits only belong to the review while this window still has
        // unreviewed Claude changes; once everything is reviewed, edits the
        // user makes afterwards are not tracked.
        if (event.document.isDirty && !this.hasPendingReview()) {
          return;
        }
        // Unsaved keystrokes are part of the review too: the diff reads the
        // dirty editor buffer, so manual edits show up immediately.
        this.workspaceDirty = true;
        this.scheduleRefresh(event.document.isDirty ? 400 : 500);
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (document.uri.scheme === 'file' && this.hasPendingReview()) {
          this.workspaceDirty = true;
          this.scheduleRefresh(200);
        }
      }),
      // Pick up files Claude creates or deletes on disk, and manual file-level
      // changes the user makes outside the editor while a review is in progress.
      ...this.createFileWatcherDisposables(),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.lastDiscoveryAt = 0;
        this.workspaceDirty = true;
        this.scheduleRefresh(100);
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration('claudeInlineDiff')) {
          return;
        }
        this.settings = readSettings();
        this.lastDiscoveryAt = 0;
        this.workspaceDirty = true;
        if (!this.settings.enabled) {
          void this.clearAll();
        } else {
          this.applyDecorations();
          this.scheduleRefresh(100);
        }
      })
    );
  }

  private createFileWatcherDisposables(): vscode.Disposable[] {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    const refresh = (): void => {
      // Same rule as editor edits: manual file-level changes (Explorer, git,
      // another tool) only count while a Claude change is still unreviewed.
      if (!this.hasPendingReview()) {
        return;
      }
      this.workspaceDirty = true;
      this.scheduleRefresh(300);
    };
    return [watcher, watcher.onDidCreate(refresh), watcher.onDidDelete(refresh), watcher.onDidChange(refresh)];
  }

  /**
   * True while this window still holds unreviewed Claude changes. Manual edits
   * are only folded into the diff during that window.
   */
  private hasPendingReview(): boolean {
    return this.changes.length > 0;
  }

  private scheduleRefresh(delay: number): void {
    if (this.disposed) {
      return;
    }
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh(false);
    }, delay);
  }

  private async refresh(force: boolean): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (this.refreshing) {
      this.refreshPending = true;
      return;
    }
    this.refreshing = true;
    try {
      this.settings = readSettings();
      if (!this.settings.enabled) {
        await this.clearAll();
        return;
      }
      const roots = workspaceRoots();
      if (roots.length === 0) {
        await this.clearAll();
        return;
      }

      const now = Date.now();
      let sessions = this.discoveredSessions;
      let activeSession: SessionCandidate | undefined;
      if (force || !this.session || now - this.lastDiscoveryAt > DISCOVERY_INTERVAL_MS) {
        sessions = await discoverSessions(roots, this.settings.sessionMaxAgeHours);
        this.discoveredSessions = sessions;
        this.lastDiscoveryAt = now;
        activeSession = this.detectActiveSession(sessions);
      }

      const target = this.pickSession(sessions, activeSession);
      if (!target) {
        await this.clearAll();
        return;
      }
      if (!this.session || this.session.sessionId !== target.sessionId) {
        await this.activateSession(target);
        force = true;
      } else {
        this.session = target;
      }

      const parser = this.parser;
      if (!parser) {
        await this.clearAll();
        return;
      }
      const update = await parser.update();
      const firstUpdate = this.suppressInitialCompletion;
      this.suppressInitialCompletion = false;
      if (update.changed) {
        this.lastTranscriptActivityAt = Date.now();
        this.completionNotified = firstUpdate;
      }
      const shouldBuild = force || update.changed || this.workspaceDirty;
      this.workspaceDirty = false;
      if (!shouldBuild) {
        return;
      }

      const endTurn = parser.getState().lastEndTurnTimestamp;
      const previousEndTurn = this.lastEndTurnTimestamp;
      this.lastEndTurnTimestamp = endTurn;
      const completedTurn =
        !update.reset &&
        endTurn !== undefined &&
        previousEndTurn !== undefined &&
        endTurn !== previousEndTurn;

      const sessionId = target.sessionId;
      const changes = await buildFileChanges({
        session: parser.getState(),
        sessionId,
        baselineMode: this.settings.baselineMode,
        localBaselines: new Map(this.localBaselines),
        workspaceRoots: roots,
        exclude: this.settings.exclude,
        maxFileSizeBytes: this.settings.maxFileSizeBytes,
        readBackup: (backupFileName) => this.fileHistory.readBackup(sessionId, backupFileName),
        readCurrent: (fsPath) => this.readCurrent(fsPath),
        log: (message) => logLine(this.output, message)
      });

      await this.applyChanges(changes);
      if (completedTurn && changes.length > 0) {
        this.startCompletionFlash(changes.length);
      }
    } catch (error) {
      logLine(this.output, `刷新失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.refreshing = false;
      this.maybeNotifyCompletion();
      if (this.refreshPending && !this.disposed) {
        this.refreshPending = false;
        this.scheduleRefresh(50);
      }
    }
  }

  private maybeNotifyCompletion(): void {
    if (
      this.disposed ||
      !this.settings.showCompletionStatus ||
      this.completionNotified ||
      this.changes.length === 0 ||
      this.lastTranscriptActivityAt === 0
    ) {
      return;
    }
    if (Date.now() - this.lastTranscriptActivityAt < COMPLETION_QUIET_MS) {
      return;
    }
    this.startCompletionFlash(this.changes.length);
  }

  /**
   * Finds the transcript that grew since the previous discovery. Several
   * VS Code windows can share one workspace, so "newest by mtime" is not a
   * reliable signal; the session this window is actually talking to grows
   * while this window is focused.
   */
  private detectActiveSession(sessions: SessionCandidate[]): SessionCandidate | undefined {
    const firstDiscovery = !this.sawFirstDiscovery;
    this.sawFirstDiscovery = true;
    let active: SessionCandidate | undefined;
    for (const session of sessions) {
      const previous = this.sessionSizes.get(session.sessionId);
      const grew = previous
        ? session.size > previous.size || session.mtimeMs > previous.mtimeMs
        : !firstDiscovery;
      if (grew && (active === undefined || session.mtimeMs > active.mtimeMs)) {
        active = session;
      }
    }
    this.sessionSizes.clear();
    for (const session of sessions) {
      this.sessionSizes.set(session.sessionId, { size: session.size, mtimeMs: session.mtimeMs });
    }
    return this.windowFocused ? active : undefined;
  }

  private pickSession(
    sessions: SessionCandidate[],
    activeSession: SessionCandidate | undefined
  ): SessionCandidate | undefined {
    if (sessions.length === 0) {
      return undefined;
    }
    if (this.pinnedSessionId) {
      const pinned = sessions.find((candidate) => candidate.sessionId === this.pinnedSessionId);
      if (pinned) {
        return pinned;
      }
    }
    // Only adopt a different conversation when it is the one actually being
    // written in this window; never switch just because another window's
    // transcript is newer.
    if (activeSession) {
      this.boundSessionId = activeSession.sessionId;
    }
    if (this.boundSessionId) {
      const bound = sessions.find((candidate) => candidate.sessionId === this.boundSessionId);
      if (bound) {
        return bound;
      }
    }
    const currentId = this.session?.sessionId;
    if (!currentId) {
      return sessions[0];
    }
    return sessions.find((candidate) => candidate.sessionId === currentId) ?? sessions[0];
  }

  private async activateSession(session: SessionCandidate): Promise<void> {
    this.session = session;
    this.parser = new TranscriptParser(session.filePath);
    this.fileHistory.clear();
    this.lastEndTurnTimestamp = undefined;
    this.lastTranscriptActivityAt = 0;
    this.completionNotified = true;
    this.suppressInitialCompletion = true;
    const entries = await this.baselineStore.entriesForSession(session.sessionId);
    this.localBaselines = new Map(entries.map((entry) => [pathKey(entry.path), entry]));
    logLine(
      this.output,
      `会话 ${session.sessionId.slice(0, 8)} · ${session.cwd ?? session.projectDir} · ${entries.length} 个本地已审核基线`
    );
  }

  private async readCurrent(fsPath: string): Promise<{ text: string; missing: boolean; tooLarge?: boolean }> {
    // While this window still has unreviewed Claude changes, a manually edited
    // buffer (including unsaved changes) is reviewed alongside them. Once the
    // review is finished, the on-disk content is authoritative again.
    const openDocument = this.hasPendingReview()
      ? vscode.workspace.textDocuments.find(
          (document) =>
            document.uri.scheme === 'file' &&
            document.isDirty &&
            pathKey(document.uri.fsPath) === pathKey(fsPath)
        )
      : undefined;
    if (openDocument) {
      const liveText = openDocument.getText();
      if (liveText.length > this.settings.maxFileSizeBytes) {
        return { text: '', missing: false, tooLarge: true };
      }
      return { text: liveText, missing: false };
    }
    try {
      const stat = await fs.promises.stat(fsPath);
      if (stat.size > this.settings.maxFileSizeBytes) {
        return { text: '', missing: false, tooLarge: true };
      }
      const text = await fs.promises.readFile(fsPath, 'utf8');
      return { text, missing: false };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { text: '', missing: true };
      }
      // Unreadable files are skipped rather than rendered as fully deleted.
      return { text: '', missing: false, tooLarge: true };
    }
  }

  private async applyChanges(changes: FileChange[]): Promise<void> {
    this.changes = changes;
    this.changesByKey = new Map(changes.map((change) => [pathKey(change.path), change]));
    this.treeProvider.setChanges(changes);
    await this.reviewProvider.setChanges(changes);
    this.updateStatusBar();
    await this.updateContextKeys();
    this.applyDecorations();
  }

  private async clearAll(): Promise<void> {
    if (!this.session && this.changes.length === 0 && this.discoveredSessions.length === 0) {
      return;
    }
    this.session = undefined;
    this.parser = undefined;
    this.localBaselines.clear();
    this.lastEndTurnTimestamp = undefined;
    this.changes = [];
    this.changesByKey.clear();
    this.discoveredSessions = [];
    this.treeProvider.setChanges([]);
    await this.reviewProvider.setChanges([]);
    this.statusBar.hide();
    this.statusBar.backgroundColor = undefined;
    await this.updateContextKeys();
    this.applyDecorations();
  }

  private applyDecorations(): void {
    const context = {
      changesByKey: this.changesByKey,
      getReviewModel: (uri: vscode.Uri) => this.reviewProvider.getModel(uri),
      showDeletedSummary: this.settings.showDeletedSummary
    };
    for (const editor of vscode.window.visibleTextEditors) {
      this.decorations.apply(editor, context);
    }
  }

  private async updateContextKeys(): Promise<void> {
    const active = vscode.window.activeTextEditor;
    const activePath =
      active && active.document.uri.scheme === 'file' ? active.document.uri.fsPath : undefined;
    const activeHasChanges =
      activePath !== undefined && this.changesByKey.has(pathKey(activePath));
    await vscode.commands.executeCommand('setContext', 'claudeInlineDiff.hasChanges', this.changes.length > 0);
    await vscode.commands.executeCommand(
      'setContext',
      'claudeInlineDiff.activeFileHasChanges',
      activeHasChanges
    );
    this.treeView.description =
      this.session !== undefined && this.changes.length > 0 ? `${this.changes.length} 个文件` : undefined;
    this.treeView.badge =
      this.changes.length > 0
        ? {
            value: this.changes.length,
            tooltip: `${this.changes.length} 个文件有待审核的 Claude 改动`
          }
        : undefined;
  }

  private updateStatusBar(): void {
    if (!this.settings.enabled || !this.session || this.changes.length === 0) {
      this.statusBar.hide();
      this.statusBar.backgroundColor = undefined;
      return;
    }
    const added = this.changes.reduce((sum, change) => sum + change.addedCount, 0);
    const removed = this.changes.reduce((sum, change) => sum + change.removedCount, 0);
    if (Date.now() < this.completionFlashUntil) {
      this.statusBar.text = `$(sparkle) Claude 改动待审 · ${this.changes.length} 个文件`;
      this.statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      this.statusBar.text = `$(diff) Claude: ${this.changes.length} 个文件 · +${added} −${removed}`;
      this.statusBar.backgroundColor = undefined;
    }
    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**Claude 改动待审核**\n\n`);
    for (const change of this.changes) {
      tooltip.appendMarkdown(
        `- \`${change.relativePath}\` · +${change.addedCount} −${change.removedCount}\n`
      );
    }
    tooltip.appendMarkdown('\n点击打开审查菜单。');
    this.statusBar.tooltip = tooltip;
    this.statusBar.show();
  }

  private startCompletionFlash(fileCount: number): void {
    if (!this.settings.showCompletionStatus) {
      return;
    }
    this.completionNotified = true;
    this.completionFlashUntil = Date.now() + COMPLETION_FLASH_MS;
    this.updateStatusBar();
    if (this.completionTimer) {
      clearTimeout(this.completionTimer);
    }
    this.completionTimer = setTimeout(() => {
      this.completionTimer = undefined;
      this.completionFlashUntil = 0;
      this.updateStatusBar();
    }, COMPLETION_FLASH_MS);
    logLine(this.output, `Claude 停止写入，${fileCount} 个文件待审核。`);
  }

  private activeEditorPath(): string | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return undefined;
    }
    if (editor.document.uri.scheme === 'file') {
      return editor.document.uri.fsPath;
    }
    if (editor.document.uri.scheme === REVIEW_SCHEME) {
      return this.reviewProvider.getModel(editor.document.uri)?.change.path;
    }
    return undefined;
  }

  private async openReview(fsPath?: string, signature?: string): Promise<void> {
    const path = fsPath ?? this.activeEditorPath();
    if (!path) {
      void vscode.window.showInformationMessage('请先在编辑器中打开一个文件，或从 Claude 变更审查面板中选择。');
      return;
    }
    await this.reviewProvider.openReview(path, signature ? { signature } : undefined);
  }

  private hunkFromActiveEditor(): { fsPath: string; signature: string } | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return undefined;
    }
    if (editor.document.uri.scheme === REVIEW_SCHEME) {
      const model = this.reviewProvider.getModel(editor.document.uri);
      if (!model) {
        return undefined;
      }
      const line = Math.max(0, Math.min(editor.selection.active.line, model.lines.length - 1));
      const signature = model.lines[line]?.signature;
      return signature ? { fsPath: model.change.path, signature } : undefined;
    }
    if (editor.document.uri.scheme !== 'file') {
      return undefined;
    }
    const change = this.changesByKey.get(pathKey(editor.document.uri.fsPath));
    if (!change) {
      return undefined;
    }
    const hunk = findHunkAtLine(change.diff, editor.selection.active.line);
    return hunk ? { fsPath: change.path, signature: hunk.signature } : undefined;
  }

  private rememberLocalBaseline(change: FileChange, text: string): void {
    if (this.session?.sessionId === change.sessionId) {
      this.localBaselines.set(pathKey(change.path), { path: change.path, text });
    }
  }

  private async acceptHunk(fsPath?: string, signature?: string): Promise<void> {
    let path = fsPath;
    let hunkSignature = signature;
    if (!path || !hunkSignature) {
      const fromEditor = this.hunkFromActiveEditor();
      if (!fromEditor) {
        void vscode.window.showInformationMessage('请把光标放在待审核的改动行上，或从审查面板中选择一处改动。');
        return;
      }
      path = fromEditor.fsPath;
      hunkSignature = fromEditor.signature;
    }
    const targetPath = path;
    const targetSignature = hunkSignature;
    try {
      // Acceptance and the rebuild are serialized so two quick accepts always
      // apply to the baseline produced by the previous one.
      await this.queueAccept(async () => {
        const change = this.changesByKey.get(pathKey(targetPath));
        if (!change) {
          throw new Error('这处改动已不在待审核列表中。');
        }
        const hunk = findHunkBySignature(change.diff, targetSignature);
        if (!hunk) {
          throw new Error('找不到这处改动，可能已经被审核或代码已再次变化。');
        }
        const baselineSplit = splitText(change.baselineText);
        const currentSplit = splitText(change.currentMissing ? '' : change.currentText);
        const updated = applyHunkToBaseline(baselineSplit.lines, currentSplit.lines, hunk);
        const text = joinLines(updated, currentSplit.eol, currentSplit.finalNewline);
        await this.baselineStore.set(change.sessionId, change.path, text);
        this.rememberLocalBaseline(change, text);
        await this.refresh(true);
      });
      void vscode.window.setStatusBarMessage('已标记 1 处改动为已审核', 2000);
    } catch (error) {
      void vscode.window.showWarningMessage(
        error instanceof Error ? error.message : '标记审核失败。'
      );
    }
  }

  private async acceptFile(fsPath?: string): Promise<void> {
    const path = fsPath ?? this.activeEditorPath();
    if (!path) {
      void vscode.window.showInformationMessage('请先在编辑器中打开一个文件，或从审查面板中选择。');
      return;
    }
    const targetPath = path;
    try {
      await this.queueAccept(async () => {
        const change = this.changesByKey.get(pathKey(targetPath));
        if (!change) {
          throw new Error('这个文件已没有待审核改动。');
        }
        const text = change.currentMissing ? '' : change.currentText;
        await this.baselineStore.set(change.sessionId, change.path, text);
        this.rememberLocalBaseline(change, text);
        await this.refresh(true);
      });
      void vscode.window.setStatusBarMessage('已标记该文件的全部改动为已审核', 2000);
    } catch (error) {
      void vscode.window.showWarningMessage(
        error instanceof Error ? error.message : '标记审核失败。'
      );
    }
  }

  private async acceptAll(): Promise<void> {
    if (this.changes.length === 0) {
      return;
    }
    const snapshot = this.changes;
    try {
      await this.queueAccept(async () => {
        for (const change of snapshot) {
          const text = change.currentMissing ? '' : change.currentText;
          await this.baselineStore.set(change.sessionId, change.path, text);
          this.rememberLocalBaseline(change, text);
        }
        await this.refresh(true);
      });
      void vscode.window.setStatusBarMessage(
        `已将 ${snapshot.length} 个文件的改动标记为已审核`,
        2500
      );
    } catch (error) {
      void vscode.window.showWarningMessage(
        error instanceof Error ? error.message : '标记审核失败。'
      );
    }
  }

  private async confirmReject(message: string): Promise<boolean> {
    const choice = await vscode.window.showWarningMessage(message, { modal: true }, '拒绝修改');
    return choice === '拒绝修改';
  }

  private dirtyDocumentFor(fsPath: string): vscode.TextDocument | undefined {
    return vscode.workspace.textDocuments.find(
      (document) =>
        document.uri.scheme === 'file' &&
        document.isDirty &&
        pathKey(document.uri.fsPath) === pathKey(fsPath)
    );
  }

  private async writeFileContent(fsPath: string, text: string): Promise<void> {
    await vscode.workspace.fs.writeFile(vscode.Uri.file(fsPath), Buffer.from(text, 'utf8'));
  }

  private async deleteFileContent(fsPath: string): Promise<void> {
    try {
      await vscode.workspace.fs.delete(vscode.Uri.file(fsPath), { useTrash: true });
    } catch (error) {
      // Already gone (deleted by hand): the end state is what reject wants.
      if ((error as { code?: string }).code !== 'FileNotFound') {
        throw error;
      }
    }
  }

  private async rejectHunk(fsPath?: string, signature?: string): Promise<void> {
    let path = fsPath;
    let hunkSignature = signature;
    if (!path || !hunkSignature) {
      const fromEditor = this.hunkFromActiveEditor();
      if (!fromEditor) {
        void vscode.window.showInformationMessage('请把光标放在待拒绝的改动行上，或从审查面板中选择一处改动。');
        return;
      }
      path = fromEditor.fsPath;
      hunkSignature = fromEditor.signature;
    }
    const targetPath = path;
    const targetSignature = hunkSignature;
    const change = this.changesByKey.get(pathKey(targetPath));
    if (!change) {
      void vscode.window.showInformationMessage('这处改动已不在待审核列表中。');
      return;
    }
    const hunk = findHunkBySignature(change.diff, targetSignature);
    if (!hunk) {
      void vscode.window.showWarningMessage('找不到这处改动，可能已经被审核或代码已再次变化。');
      return;
    }
    if (this.dirtyDocumentFor(change.path)) {
      void vscode.window.showWarningMessage('该文件有未保存的修改，请先保存后再拒绝。');
      return;
    }
    const confirmed = await this.confirmReject(
      `将把 ${change.relativePath} 第 ${hunk.currentStart + 1} 行处的改动还原为 Claude 修改前的内容，` +
        '这会直接修改工作区文件。'
    );
    if (!confirmed) {
      return;
    }
    try {
      await this.queueAccept(async () => {
        // A deleted file has no current text; revert against an empty document
        // and reuse the baseline's line endings when writing it back.
        const currentSplit = change.currentMissing ? splitText('') : splitText(change.currentText);
        const lines = revertHunkInCurrent(currentSplit.lines, hunk);
        const eol = change.currentMissing ? splitText(change.baselineText).eol : currentSplit.eol;
        if (lines.length === 0 && !change.baselineExisted) {
          await this.deleteFileContent(change.path);
        } else {
          const finalNewline = change.currentMissing ? true : currentSplit.finalNewline;
          await this.writeFileContent(change.path, joinLines(lines, eol, finalNewline));
        }
        await this.refresh(true);
      });
      void vscode.window.setStatusBarMessage('已还原 1 处改动', 2000);
    } catch (error) {
      void vscode.window.showWarningMessage(
        error instanceof Error ? error.message : '拒绝改动失败。'
      );
    }
  }

  private async rejectFile(fsPath?: string): Promise<void> {
    const path = fsPath ?? this.activeEditorPath();
    if (!path) {
      void vscode.window.showInformationMessage('请先在编辑器中打开一个文件，或从审查面板中选择。');
      return;
    }
    const change = this.changesByKey.get(pathKey(path));
    if (!change) {
      void vscode.window.showInformationMessage('这个文件已没有待审核改动。');
      return;
    }
    if (this.dirtyDocumentFor(change.path)) {
      void vscode.window.showWarningMessage('该文件有未保存的修改，请先保存后再拒绝。');
      return;
    }
    const confirmed = await this.confirmReject(
      change.baselineExisted
        ? `将把 ${change.relativePath} 还原到 Claude 修改前的内容，这会直接覆盖工作区文件。`
        : `这个文件是 Claude 新建的，拒绝改动会把 ${change.relativePath} 删除。`
    );
    if (!confirmed) {
      return;
    }
    try {
      await this.queueAccept(async () => {
        if (change.baselineExisted) {
          await this.writeFileContent(change.path, change.baselineText);
        } else {
          await this.deleteFileContent(change.path);
        }
        await this.refresh(true);
      });
      void vscode.window.setStatusBarMessage('已还原该文件的改动', 2000);
    } catch (error) {
      void vscode.window.showWarningMessage(
        error instanceof Error ? error.message : '拒绝改动失败。'
      );
    }
  }

  private async rejectAll(): Promise<void> {
    if (this.changes.length === 0) {
      return;
    }
    const dirty = this.changes.find((change) => this.dirtyDocumentFor(change.path));
    if (dirty) {
      void vscode.window.showWarningMessage(`${dirty.relativePath} 有未保存的修改，请先保存后再拒绝。`);
      return;
    }
    const created = this.changes.filter((change) => !change.baselineExisted).length;
    const confirmed = await this.confirmReject(
      `将把 ${this.changes.length} 个文件还原到 Claude 修改前的内容` +
        (created > 0 ? `，并删除其中 ${created} 个由 Claude 新建的文件` : '') +
        '。这会直接修改工作区文件，且无法撤销。'
    );
    if (!confirmed) {
      return;
    }
    const snapshot = this.changes;
    const failed: string[] = [];
    try {
      await this.queueAccept(async () => {
        for (const change of snapshot) {
          try {
            if (change.baselineExisted) {
              await this.writeFileContent(change.path, change.baselineText);
            } else {
              await this.deleteFileContent(change.path);
            }
          } catch {
            failed.push(change.relativePath);
          }
        }
        await this.refresh(true);
      });
      if (failed.length > 0) {
        void vscode.window.showWarningMessage(`以下文件还原失败：${failed.join('、')}`);
        return;
      }
      void vscode.window.setStatusBarMessage(`已还原 ${snapshot.length} 个文件的改动`, 2500);
    } catch (error) {
      void vscode.window.showWarningMessage(
        error instanceof Error ? error.message : '拒绝改动失败。'
      );
    }
  }

  private async resetReviewed(): Promise<void> {
    if (!this.session) {
      return;
    }
    const sessionId = this.session.sessionId;
    try {
      await this.queueAccept(async () => {
        await this.baselineStore.deleteSession(sessionId);
        if (this.session?.sessionId === sessionId) {
          this.localBaselines.clear();
        }
        await this.refresh(true);
      });
      void vscode.window.setStatusBarMessage('已重置当前会话的审核标记', 2500);
    } catch (error) {
      void vscode.window.showWarningMessage(
        error instanceof Error ? error.message : '重置审核标记失败。'
      );
    }
  }

  private queueAccept(task: () => Promise<void>): Promise<void> {
    const next = this.acceptQueue.then(task, task);
    this.acceptQueue = next.catch(() => undefined);
    return next;
  }

  private async selectSession(): Promise<void> {
    const roots = workspaceRoots();
    if (roots.length === 0) {
      return;
    }
    this.settings = readSettings();
    const sessions = await discoverSessions(roots, this.settings.sessionMaxAgeHours);
    this.discoveredSessions = sessions;
    this.lastDiscoveryAt = Date.now();
    if (sessions.length === 0) {
      void vscode.window.showInformationMessage('没有找到与当前工作区相关的 Claude 会话。');
      return;
    }
    const items: SessionQuickPickItem[] = [];
    if (this.pinnedSessionId) {
      items.push({
        label: '$(sync) 跟随最近的 Claude 会话',
        description: '自动切换到最新活跃的会话',
        followLatest: true
      });
    }
    for (const session of sessions) {
      const isCurrent = this.session?.sessionId === session.sessionId;
      const pinned = this.pinnedSessionId === session.sessionId;
      items.push({
        label: `$(comment-discussion) ${session.sessionId.slice(0, 8)}${isCurrent ? '（当前）' : ''}`,
        description: `${formatRelative(session.mtimeMs)}${pinned ? ' · 已固定' : ''}`,
        detail: session.cwd ?? session.projectDir,
        session
      });
    }
    const picked = await vscode.window.showQuickPick(items, {
      title: '选择要跟踪的 Claude 会话',
      placeHolder: '每个会话的未审核改动分别记录'
    });
    if (!picked) {
      return;
    }
    if (picked.followLatest) {
      this.pinnedSessionId = undefined;
      this.boundSessionId = undefined;
      await this.context.workspaceState.update(PINNED_SESSION_KEY, undefined);
    } else if (picked.session) {
      this.pinnedSessionId = picked.session.sessionId;
      this.boundSessionId = picked.session.sessionId;
      await this.context.workspaceState.update(PINNED_SESSION_KEY, this.pinnedSessionId);
    }
    await this.refresh(true);
    if (picked.session) {
      void vscode.window.setStatusBarMessage(`已切换到会话 ${picked.session.sessionId.slice(0, 8)}`, 2500);
    }
  }

  private async showMenu(): Promise<void> {
    const items: MenuQuickPickItem[] = [];
    if (this.changes.length > 0) {
      for (const change of this.changes) {
        items.push({
          label: `$(file) ${change.relativePath}`,
          description: `+${change.addedCount} −${change.removedCount}`,
          detail: '打开单栏内联审查',
          run: () => this.openReview(change.path)
        });
      }
      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
      items.push({
        label: '$(layout) 打开变更审查面板',
        run: () =>
          vscode.commands.executeCommand('claudeInlineDiff.changes.focus').then(
            () => undefined,
            () => undefined
          )
      });
      items.push({
        label: '$(check-all) 标记全部为已审核',
        run: () => this.acceptAll()
      });
      items.push({
        label: '$(discard) 拒绝全部改动（还原文件）',
        run: () => this.rejectAll()
      });
      items.push({
        label: '$(history) 重置已审核标记',
        run: () => this.resetReviewed()
      });
    }
    items.push({
      label: '$(server-process) 切换 Claude 会话',
      description: this.session ? this.session.sessionId.slice(0, 8) : undefined,
      run: () => this.selectSession()
    });
    items.push({
      label: '$(refresh) 刷新改动',
      run: () => this.refresh(true)
    });
    items.push({
      label: '$(output) 显示日志',
      run: () => {
        this.output.show(true);
      }
    });
    const picked = await vscode.window.showQuickPick(items, {
      title: 'Claude 变更审查',
      placeHolder: '选择操作'
    });
    if (picked?.run) {
      await picked.run();
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    if (this.completionTimer) {
      clearTimeout(this.completionTimer);
      this.completionTimer = undefined;
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const controller = new ClaudeInlineDiffController(context);
  await controller.initialize();
}

export function deactivate(): void {
  // The controller is disposed through context.subscriptions.
}
