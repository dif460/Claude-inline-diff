import * as vscode from 'vscode';
import { FileChange } from '../core/changeBuilder';
import { languageIdForPath } from '../core/language';
import { DiffHunk } from '../core/lineDiff';
import { pathKey, truncateText } from '../core/lines';

export type ChangeNode = FileNode | HunkNode;

interface FileNode {
  kind: 'file';
  change: FileChange;
}

interface HunkNode {
  kind: 'hunk';
  change: FileChange;
  hunk: DiffHunk;
}

function hunkLabel(hunk: DiffHunk): string {
  if (hunk.kind === 'add') {
    return `第 ${hunk.currentStart + 1} 行 · 新增 ${hunk.added.length} 行`;
  }
  if (hunk.kind === 'remove') {
    return `第 ${hunk.currentStart + 1} 行处 · 删除 ${hunk.removed.length} 行`;
  }
  return `第 ${hunk.currentStart + 1} 行 · 修改 ${hunk.removed.length} → ${hunk.added.length} 行`;
}

function hunkDescription(hunk: DiffHunk): string {
  return `+${hunk.added.length} −${hunk.removed.length}`;
}

function hunkTooltip(change: FileChange, hunk: DiffHunk): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString();
  markdown.appendMarkdown(`**${hunkLabel(hunk)}**\n\n`);
  const fence = languageIdForPath(change.path) ?? '';
  if (hunk.removed.length > 0) {
    markdown.appendMarkdown('已删除：\n\n');
    markdown.appendCodeblock(truncateText(hunk.removed.join('\n'), 3000), fence);
    markdown.appendMarkdown('\n');
  }
  if (hunk.added.length > 0) {
    markdown.appendMarkdown('新增：\n\n');
    markdown.appendCodeblock(truncateText(hunk.added.join('\n'), 3000), fence);
  }
  return markdown;
}

export class ChangesTreeProvider implements vscode.TreeDataProvider<ChangeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<ChangeNode | undefined | void>();
  private changes: FileChange[] = [];

  readonly onDidChangeTreeData = this.emitter.event;

  setChanges(changes: FileChange[]): void {
    this.changes = changes;
    this.emitter.fire();
  }

  getChanges(): readonly FileChange[] {
    return this.changes;
  }

  getChildren(element?: ChangeNode): ChangeNode[] {
    if (!element) {
      return this.changes.map((change) => ({ kind: 'file', change }));
    }
    if (element.kind === 'file') {
      return element.change.diff.hunks.map((hunk) => ({
        kind: 'hunk',
        change: element.change,
        hunk
      }));
    }
    return [];
  }

  getTreeItem(element: ChangeNode): vscode.TreeItem {
    if (element.kind === 'file') {
      return this.fileItem(element);
    }
    return this.hunkItem(element);
  }

  private fileItem(node: FileNode): vscode.TreeItem {
    const change = node.change;
    const item = new vscode.TreeItem(change.relativePath, vscode.TreeItemCollapsibleState.Collapsed);
    item.id = `file:${pathKey(change.path)}`;
    item.resourceUri = vscode.Uri.file(change.path);
    item.contextValue = 'claudeChangeFile';
    item.description = `+${change.addedCount} −${change.removedCount}`;
    item.tooltip = new vscode.MarkdownString(
      `**${change.relativePath}**\n\n${change.diff.hunks.length} 处未审核改动 · 新增 ${change.addedCount} 行 · 删除 ${change.removedCount} 行\n\n点击打开单栏内联审查视图。`
    );
    item.command = {
      command: 'claudeInlineDiff.openReview',
      title: '打开内联审查',
      arguments: [change.path]
    };
    return item;
  }

  private hunkItem(node: HunkNode): vscode.TreeItem {
    const { change, hunk } = node;
    const item = new vscode.TreeItem(hunkLabel(hunk), vscode.TreeItemCollapsibleState.None);
    item.id = `hunk:${pathKey(change.path)}:${hunk.signature}`;
    item.contextValue = 'claudeChangeHunk';
    item.description = hunkDescription(hunk);
    item.tooltip = hunkTooltip(change, hunk);
    item.iconPath = new vscode.ThemeIcon(
      hunk.kind === 'add' ? 'diff-added' : hunk.kind === 'remove' ? 'diff-removed' : 'diff-modified'
    );
    item.command = {
      command: 'claudeInlineDiff.openReview',
      title: '打开内联审查',
      arguments: [change.path, hunk.signature]
    };
    return item;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
