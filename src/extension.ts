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
  findHunkBySignature
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
    this.decorations = new DecorationManager(context.extensionUri);
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
        // External edits (Claude writing the file) reload the document, which
        // leaves it clean. Keystrokes by the user leave it dirty; only the
        // saved state matters for the diff baseline.
        if (!event.document.isDirty && event.contentChanges.length > 0) {
          this.workspaceDirty = true;
          this.scheduleRefresh(500);
        }
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (document.uri.scheme === 'file') {
          this.workspaceDirty = true;
          this.scheduleRefresh(200);
        }
      }),
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
      if (force || !this.session || now - this.lastDiscoveryAt > DISCOVERY_INTERVAL_MS) {
        sessions = await discoverSessions(roots, this.settings.sessionMaxAgeHours);
        this.discoveredSessions = sessions;
        this.lastDiscoveryAt = now;
      }

      const target = this.pickSession(sessions);
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

  private pickSession(sessions: SessionCandidate[]): SessionCandidate | undefined {
    if (sessions.length === 0) {
      return undefined;
    }
    if (this.pinnedSessionId) {
      const pinned = sessions.find((candidate) => candidate.sessionId === this.pinnedSessionId);
      if (pinned) {
        return pinned;
      }
    }
    if (!this.session) {
      return sessions[0];
    }
    const current = sessions.find((candidate) => candidate.sessionId === this.session?.sessionId);
    const newest = sessions[0];
    if (!current) {
      return newest;
    }
    // Without an explicit pin, follow a newer conversation (for example a new
    // Claude chat started after this window was opened).
    if (
      !this.pinnedSessionId &&
      newest.sessionId !== current.sessionId &&
      newest.mtimeMs > current.mtimeMs + 1000
    ) {
      return newest;
    }
    return current;
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
      await this.context.workspaceState.update(PINNED_SESSION_KEY, undefined);
    } else if (picked.session) {
      this.pinnedSessionId = picked.session.sessionId;
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
