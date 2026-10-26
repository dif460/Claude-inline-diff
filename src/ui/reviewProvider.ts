import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { FileChange } from '../core/changeBuilder';
import { languageIdForPath } from '../core/language';
import { pathKey, splitText } from '../core/lines';
import { findHunkBySignature } from '../core/lineDiff';
import { buildReviewModel, ReviewModel, reviewKey } from './reviewModel';

export const REVIEW_SCHEME = 'claude-inline-review';

interface InternalReviewModel extends ReviewModel {
  uri: vscode.Uri;
  content: string;
  retired: boolean;
}

function currentFileContent(change: FileChange): string {
  const split = splitText(change.currentMissing ? '' : change.currentText);
  return split.lines.length > 0
    ? split.lines.join(split.eol) + (split.finalNewline ? split.eol : '')
    : '';
}

function makeUri(sessionId: string, fsPath: string): vscode.Uri {
  const id = crypto.createHash('sha1').update(reviewKey(sessionId, fsPath)).digest('hex').slice(0, 20);
  const base = path.basename(fsPath);
  return vscode.Uri.from({
    scheme: REVIEW_SCHEME,
    path: `/${base} · Claude 审查`,
    query: `id=${id}`
  });
}

export class ReviewProvider implements vscode.TextDocumentContentProvider, vscode.CodeLensProvider, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
  private readonly lensEmitter = new vscode.EventEmitter<void>();
  private readonly modelsByUri = new Map<string, InternalReviewModel>();
  private readonly modelsByPath = new Map<string, InternalReviewModel>();

  readonly onDidChange = this.changeEmitter.event;
  readonly onDidChangeCodeLenses = this.lensEmitter.event;

  async setChanges(changes: FileChange[]): Promise<void> {
    const currentUris = new Set<string>();
    for (const change of changes) {
      const key = pathKey(change.path);
      const uri = makeUri(change.sessionId, change.path);
      const uriKey = uri.toString();
      currentUris.add(uriKey);
      const model = buildReviewModel(reviewKey(change.sessionId, change.path), change);
      const content = splitText(
        change.currentMissing
          ? change.baselineText
          : change.currentText
      );
      const merged = model.lines.map((line) => line.text);
      const text = merged.length > 0 || content.finalNewline
        ? merged.join(content.eol) + (content.finalNewline ? content.eol : '')
        : '';
      const previous = this.modelsByUri.get(uriKey);
      const updated: InternalReviewModel = {
        ...model,
        uri,
        content: text,
        retired: false
      };
      this.modelsByUri.set(uriKey, updated);
      this.modelsByPath.set(key, updated);
      if (!previous || previous.content !== text) {
        this.changeEmitter.fire(uri);
      }
    }

    // When a file has no pending hunks anymore, turn its already-open review
    // tab into a plain snapshot of the current file instead of leaving stale
    // highlights behind.
    for (const [uriKey, model] of this.modelsByUri) {
      if (currentUris.has(uriKey) || model.retired) {
        continue;
      }
      model.retired = true;
      const clean = currentFileContent(model.change);
      if (model.content !== clean) {
        model.content = clean;
        this.changeEmitter.fire(model.uri);
      }
    }
    for (const key of [...this.modelsByPath.keys()]) {
      const model = this.modelsByPath.get(key);
      if (!model || model.retired) {
        this.modelsByPath.delete(key);
      }
    }
    const openDocuments = new Set(vscode.workspace.textDocuments.map((document) => document.uri.toString()));
    for (const [uriKey, model] of this.modelsByUri) {
      if (model.retired && !openDocuments.has(uriKey)) {
        this.modelsByUri.delete(uriKey);
      }
    }
    this.lensEmitter.fire();
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.modelsByUri.get(uri.toString())?.content ?? '';
  }

  getModel(uri: vscode.Uri): ReviewModel | undefined {
    const model = this.modelsByUri.get(uri.toString());
    return model && !model.retired ? model : undefined;
  }

  getModelForPath(fsPath: string): InternalReviewModel | undefined {
    return this.modelsByPath.get(pathKey(fsPath));
  }

  async openReview(fsPath: string, options?: { signature?: string; line?: number }): Promise<void> {
    const model = this.getModelForPath(fsPath);
    if (!model) {
      void vscode.window.showInformationMessage('这个文件当前没有未审核的 Claude 改动。');
      return;
    }
    try {
      let document = await vscode.workspace.openTextDocument(model.uri);
      const sourceEditor = vscode.window.visibleTextEditors.find(
        (editor) =>
          editor.document.uri.scheme === 'file' && pathKey(editor.document.uri.fsPath) === pathKey(fsPath)
      );
      const languageId = sourceEditor?.document.languageId ?? languageIdForPath(fsPath);
      if (languageId && document.languageId !== languageId) {
        document = await vscode.languages.setTextDocumentLanguage(document, languageId);
      }
      const editor = await vscode.window.showTextDocument(document, {
        preview: true,
        viewColumn: vscode.ViewColumn.Active
      });
      let mergedLine: number | undefined;
      if (options?.signature) {
        mergedLine = model.hunkStartLine.get(options.signature);
      } else if (options?.line !== undefined) {
        mergedLine = Math.max(0, Math.min(options.line, model.lines.length - 1));
      }
      if (mergedLine !== undefined) {
        const position = new vscode.Position(
          Math.max(0, Math.min(mergedLine, document.lineCount - 1)),
          0
        );
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(
          new vscode.Range(position, position),
          vscode.TextEditorRevealType.InCenterIfOutsideViewport
        );
      }
    } catch (error) {
      void vscode.window.showWarningMessage(
        `无法打开内联审查视图：${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const model = this.modelsByUri.get(document.uri.toString());
    if (!model || model.retired || model.pendingHunks.length === 0) {
      return [];
    }
    const lenses: vscode.CodeLens[] = [];
    const headerRange = new vscode.Range(0, 0, 0, 0);
    lenses.push(
      new vscode.CodeLens(headerRange, {
        title: `$(check-all) 全部标记为已审核（${model.change.diff.hunks.length} 处）`,
        tooltip: '仅标记为已审核，不会修改代码',
        command: 'claudeInlineDiff.acceptFile',
        arguments: [model.change.path]
      })
    );
    for (const hunk of model.change.diff.hunks) {
      const line = model.hunkStartLine.get(hunk.signature);
      if (line === undefined || line >= document.lineCount) {
        continue;
      }
      const range = new vscode.Range(line, 0, line, 0);
      lenses.push(
        new vscode.CodeLens(range, {
          title: '$(check) 标记此改动为已审核',
          tooltip: '仅标记为已审核，不会修改代码',
          command: 'claudeInlineDiff.acceptHunk',
          arguments: [model.change.path, hunk.signature]
        })
      );
      lenses.push(
        new vscode.CodeLens(range, {
          title: '$(go-to-file) 在源文件中打开',
          command: 'claudeInlineDiff.openSourceAt',
          arguments: [model.change.path, hunk.signature]
        })
      );
    }
    return lenses;
  }

  /**
   * Map the cursor line in a review document back to the source file.
   */
  sourceLocationFor(uri: vscode.Uri, line: number): { fsPath: string; line: number } | undefined {
    const model = this.modelsByUri.get(uri.toString());
    if (!model) {
      return undefined;
    }
    const info = model.lines[Math.max(0, Math.min(line, model.lines.length - 1))];
    if (!info) {
      return undefined;
    }
    const sourceLines = splitText(model.change.currentMissing ? '' : model.change.currentText).lines;
    const maxLine = Math.max(0, sourceLines.length - 1);
    let target = Math.max(0, Math.min(info.sourceLine, maxLine));
    if (model.change.currentMissing) {
      target = 0;
    }
    return { fsPath: model.change.path, line: target };
  }

  async openSourceAt(fsPath?: string, signature?: string): Promise<void> {
    let targetPath = fsPath;
    let targetLine = 0;
    if (!targetPath) {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.scheme !== REVIEW_SCHEME) {
        return;
      }
      const location = this.sourceLocationFor(editor.document.uri, editor.selection.active.line);
      if (!location) {
        return;
      }
      targetPath = location.fsPath;
      targetLine = location.line;
    } else {
      const model = this.getModelForPath(targetPath);
      const hunk = signature && model ? findHunkBySignature(model.change.diff, signature) : undefined;
      targetLine = hunk ? hunk.currentStart : 0;
    }
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(targetPath));
      const line = Math.max(0, Math.min(targetLine, document.lineCount - 1));
      const position = new vscode.Position(line, 0);
      const editor = await vscode.window.showTextDocument(document, {
        preview: false,
        viewColumn: vscode.ViewColumn.Active
      });
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    } catch {
      void vscode.window.showWarningMessage('源文件不存在或无法打开（可能已被删除）。');
    }
  }

  dispose(): void {
    this.changeEmitter.dispose();
    this.lensEmitter.dispose();
  }
}
