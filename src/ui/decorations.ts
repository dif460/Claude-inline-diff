import * as vscode from 'vscode';
import { FileChange } from '../core/changeBuilder';
import { DiffHunk } from '../core/lineDiff';
import { languageIdForPath } from '../core/language';
import { pathKey, truncateText } from '../core/lines';
import { ReviewModel } from './reviewModel';
import { REVIEW_SCHEME } from './reviewProvider';

// Trae 风格固定配色：整行背景使用约 20% 透明度，
// 词级高亮与边栏使用同色更高透明度/不透明版本，保证深浅主题下都清晰。
const ADDED_LINE_BG = '#39cc6533';
const REMOVED_LINE_BG = '#e6454533';
const ADDED_WORD_BG = '#39cc6566';
const REMOVED_WORD_BG = '#e6454566';
const ADDED_SOLID = '#39cc65';
const REMOVED_SOLID = '#e64545';
const MODIFIED_SOLID = '#1b7a9e';

export interface DecorationContext {
  changesByKey: Map<string, FileChange>;
  getReviewModel: (uri: vscode.Uri) => ReviewModel | undefined;
  showDeletedSummary: boolean;
}

function commandLink(label: string, command: string, args: unknown[]): string {
  const encoded = encodeURIComponent(JSON.stringify(args));
  return `[${label}](command:${command}?${encoded})`;
}

function makeMarkdown(lines: string[]): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString(lines.join('\n'));
  markdown.isTrusted = {
    enabledCommands: ['claudeInlineDiff.openReview']
  };
  return markdown;
}

function hoverTitle(hunk: DiffHunk): string {
  if (hunk.kind === 'modify') {
    return `**Claude 修改** · 替换 ${hunk.removed.length} 行 · 新增 ${hunk.added.length} 行`;
  }
  if (hunk.kind === 'remove') {
    return `**Claude 删除** · ${hunk.removed.length} 行`;
  }
  return `**Claude 新增** · ${hunk.added.length} 行`;
}

function hoverForHunk(change: FileChange, hunk: DiffHunk): vscode.MarkdownString {
  // 修改行不在编辑器里展示旧代码，删除内容只在单栏内联审查视图中显示。
  const lines: string[] = [hoverTitle(hunk), ''];
  lines.push(
    commandLink('打开内联审查', 'claudeInlineDiff.openReview', [change.path, hunk.signature])
  );
  return makeMarkdown(lines);
}

function hoverForAnchor(change: FileChange, hunks: DiffHunk[]): vscode.MarkdownString {
  const removedCount = hunks.reduce((sum, hunk) => sum + hunk.removed.length, 0);
  const lines: string[] = [
    `**Claude 删除** · ${removedCount} 行（此处为删除位置标记）`,
    ''
  ];
  const allRemoved = hunks.flatMap((hunk) => hunk.removed);
  if (allRemoved.length > 0) {
    const fence = languageIdForPath(change.path) ?? '';
    lines.push('已删除的内容：', '', '```' + fence, truncateText(allRemoved.join('\n'), 4000), '```', '');
  }
  const first = hunks[0];
  if (first) {
    lines.push(
      commandLink('打开内联审查', 'claudeInlineDiff.openReview', [change.path, first.signature])
    );
  }
  return makeMarkdown(lines);
}

function clampRange(document: vscode.TextDocument, line: number, start: number, end: number): vscode.Range {
  const safeLine = Math.max(0, Math.min(line, document.lineCount - 1));
  const textLength = document.lineAt(safeLine).text.length;
  const safeStart = Math.max(0, Math.min(start, textLength));
  const safeEnd = Math.max(safeStart, Math.min(end, textLength));
  return new vscode.Range(safeLine, safeStart, safeLine, safeEnd);
}

export class DecorationManager implements vscode.Disposable {
  private readonly addedLine: vscode.TextEditorDecorationType;
  private readonly modifiedLine: vscode.TextEditorDecorationType;
  private readonly addedText: vscode.TextEditorDecorationType;
  private readonly removedAnchor: vscode.TextEditorDecorationType;
  private readonly removedArrow: vscode.TextEditorDecorationType;
  private readonly removedLine: vscode.TextEditorDecorationType;
  private readonly removedText: vscode.TextEditorDecorationType;

  constructor(extensionUri: vscode.Uri) {
    const addedIcon = vscode.Uri.joinPath(extensionUri, 'media', 'added-line.svg');
    const modifiedIcon = vscode.Uri.joinPath(extensionUri, 'media', 'modified-line.svg');
    const removedIcon = vscode.Uri.joinPath(extensionUri, 'media', 'removed-line.svg');
    this.addedLine = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: ADDED_LINE_BG,
      // Gutter 图标固定在行号左侧，不随横向滚动移动，避免左侧竖线被编辑器边框裁掉。
      gutterIconPath: addedIcon,
      gutterIconSize: 'contain',
      overviewRulerColor: ADDED_SOLID,
      overviewRulerLane: vscode.OverviewRulerLane.Left
    });
    // 修改行（删旧增新）仍使用绿色行背景，但 gutter 改为麻蓝色斜纹竖线。
    this.modifiedLine = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: ADDED_LINE_BG,
      gutterIconPath: modifiedIcon,
      gutterIconSize: 'contain',
      overviewRulerColor: MODIFIED_SOLID,
      overviewRulerLane: vscode.OverviewRulerLane.Left
    });
    this.addedText = vscode.window.createTextEditorDecorationType({
      backgroundColor: ADDED_WORD_BG,
      borderRadius: '2px'
    });
    // 源文件中的删除位置只在概览标尺留下标记，具体位置用行间小箭头表示。
    this.removedAnchor = vscode.window.createTextEditorDecorationType({
      overviewRulerColor: REMOVED_SOLID,
      overviewRulerLane: vscode.OverviewRulerLane.Left
    });
    // 删除接缝处的小箭头：贴在上一行行尾（上下文之间），不占用代码宽度。
    this.removedArrow = vscode.window.createTextEditorDecorationType({});
    this.removedLine = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: REMOVED_LINE_BG,
      gutterIconPath: removedIcon,
      gutterIconSize: 'contain',
      overviewRulerColor: REMOVED_SOLID,
      overviewRulerLane: vscode.OverviewRulerLane.Left
    });
    this.removedText = vscode.window.createTextEditorDecorationType({
      backgroundColor: REMOVED_WORD_BG,
      borderRadius: '2px'
    });
  }

  apply(editor: vscode.TextEditor | undefined, context: DecorationContext): void {
    if (!editor) {
      return;
    }
    if (editor.document.uri.scheme === REVIEW_SCHEME) {
      this.applyReview(editor, context);
      return;
    }
    this.applySource(editor, context);
  }

  private clear(editor: vscode.TextEditor): void {
    editor.setDecorations(this.addedLine, []);
    editor.setDecorations(this.modifiedLine, []);
    editor.setDecorations(this.addedText, []);
    editor.setDecorations(this.removedAnchor, []);
    editor.setDecorations(this.removedArrow, []);
    editor.setDecorations(this.removedLine, []);
    editor.setDecorations(this.removedText, []);
  }

  private applySource(editor: vscode.TextEditor, context: DecorationContext): void {
    this.clear(editor);
    const change = context.changesByKey.get(pathKey(editor.document.uri.fsPath));
    if (!change) {
      return;
    }
    const addedRanges: vscode.DecorationOptions[] = [];
    const modifiedRanges: vscode.DecorationOptions[] = [];
    const addedTextRanges: vscode.DecorationOptions[] = [];
    const removedRanges: vscode.DecorationOptions[] = [];
    const arrowRanges: vscode.DecorationOptions[] = [];

    for (const hunk of change.diff.hunks) {
      const hover = hoverForHunk(change, hunk);
      const lineRanges = hunk.kind === 'modify' ? modifiedRanges : addedRanges;
      for (let i = 0; i < hunk.added.length; i++) {
        const line = hunk.currentStart + i;
        if (line < 0 || line >= editor.document.lineCount) {
          continue;
        }
        lineRanges.push({
          range: new vscode.Range(line, 0, line, 0),
          hoverMessage: hover
        });
        const wordDiff = change.diff.wordDiffs.get(hunk.signature);
        const pair = wordDiff?.pairs[i];
        if (pair) {
          for (const span of pair.added) {
            // 词级高亮不重复挂悬停，避免与整行装饰产生两个相同的提示框。
            addedTextRanges.push({
              range: clampRange(editor.document, line, span.start, span.end)
            });
          }
        }
      }
    }

    for (const anchor of change.diff.deletionAnchors) {
      // 修改块（删旧增新）不在编辑器中显示删除标记，旧代码只在内联审查视图中展示。
      const pureRemovals = anchor.hunks.filter((hunk) => hunk.kind === 'remove');
      if (pureRemovals.length === 0) {
        continue;
      }
      const doc = editor.document;
      const line = Math.max(0, Math.min(anchor.anchor, doc.lineCount - 1));
      const removedCount = pureRemovals.reduce((sum, hunk) => sum + hunk.removed.length, 0);
      const hover = hoverForAnchor(change, pureRemovals);
      removedRanges.push({
        range: new vscode.Range(line, 0, line, doc.lineAt(line).text.length),
        hoverMessage: hover
      });

      // 箭头放在删除接缝处：优先贴在上一行行尾，文件开头则放在第一行行首。
      const label = context.showDeletedSummary ? `↳ − ${removedCount} 行已删除` : '↳';
      const arrowStyle: vscode.ThemableDecorationAttachmentRenderOptions = {
        contentText: label,
        color: REMOVED_SOLID,
        backgroundColor: REMOVED_LINE_BG,
        fontStyle: 'italic'
      };
      if (anchor.anchor <= 0) {
        arrowRanges.push({
          range: new vscode.Range(0, 0, 0, 0),
          hoverMessage: hover,
          renderOptions: {
            before: { ...arrowStyle, contentText: `${label} `, margin: '0 0.6em 0 0' }
          }
        });
      } else {
        const previous = Math.max(0, Math.min(anchor.anchor - 1, doc.lineCount - 1));
        const end = doc.lineAt(previous).text.length;
        const position = new vscode.Position(previous, end);
        arrowRanges.push({
          range: new vscode.Range(position, position),
          hoverMessage: hover,
          renderOptions: {
            after: { ...arrowStyle, contentText: ` ${label}`, margin: '0 0 0 1em' }
          }
        });
      }
    }

    editor.setDecorations(this.addedLine, addedRanges);
    editor.setDecorations(this.modifiedLine, modifiedRanges);
    editor.setDecorations(this.addedText, addedTextRanges);
    editor.setDecorations(this.removedAnchor, removedRanges);
    editor.setDecorations(this.removedArrow, arrowRanges);
  }

  private applyReview(editor: vscode.TextEditor, context: DecorationContext): void {
    this.clear(editor);
    const model = context.getReviewModel(editor.document.uri);
    if (!model) {
      return;
    }
    // 审查视图统一使用绿/红竖线，麻蓝色只用于源文件编辑器的修改行。
    const addedLines: vscode.DecorationOptions[] = [];
    const removedLines: vscode.DecorationOptions[] = [];
    const addedTextRanges: vscode.DecorationOptions[] = [];
    const removedTextRanges: vscode.DecorationOptions[] = [];

    for (let line = 0; line < model.lines.length; line++) {
      const info = model.lines[line];
      if (line >= editor.document.lineCount) {
        break;
      }
      if (info.kind === 'added') {
        addedLines.push({ range: new vscode.Range(line, 0, line, 0) });
      } else if (info.kind === 'removed') {
        removedLines.push({ range: new vscode.Range(line, 0, line, 0) });
      }
    }
    const spanToRange = (span: { line: number; start: number; end: number }): vscode.Range | undefined => {
      if (span.line < 0 || span.line >= model.lines.length) {
        return undefined;
      }
      const info = model.lines[span.line];
      if (!info || info.kind === 'context') {
        return undefined;
      }
      if (span.line >= editor.document.lineCount) {
        return undefined;
      }
      const range = clampRange(editor.document, span.line, span.start, span.end);
      return range.start.character === range.end.character ? undefined : range;
    };
    for (const span of model.addedWordSpans) {
      const range = spanToRange(span);
      if (range) {
        addedTextRanges.push({ range });
      }
    }
    for (const span of model.removedWordSpans) {
      const range = spanToRange(span);
      if (range) {
        removedTextRanges.push({ range });
      }
    }

    editor.setDecorations(this.addedLine, addedLines);
    editor.setDecorations(this.removedLine, removedLines);
    editor.setDecorations(this.addedText, addedTextRanges);
    editor.setDecorations(this.removedText, removedTextRanges);
  }

  clearAll(editors: readonly vscode.TextEditor[]): void {
    for (const editor of editors) {
      this.clear(editor);
    }
  }

  dispose(): void {
    this.addedLine.dispose();
    this.modifiedLine.dispose();
    this.addedText.dispose();
    this.removedAnchor.dispose();
    this.removedArrow.dispose();
    this.removedLine.dispose();
    this.removedText.dispose();
  }
}
