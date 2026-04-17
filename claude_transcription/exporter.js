// exporter.js — Generate DOCX and PDF from markdown notes content
import fs from 'fs';
import path from 'path';
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  AlignmentType, BorderStyle,
} from 'docx';
import PDFDocument from 'pdfkit';

// ── Markdown → structured blocks parser ──
function parseMarkdown(md) {
  const lines = md.split('\n');
  const blocks = [];

  for (const line of lines) {
    if (line.startsWith('## ')) {
      blocks.push({ type: 'h2', text: line.slice(3).trim() });
    } else if (line.startsWith('### ')) {
      blocks.push({ type: 'h3', text: line.slice(4).trim() });
    } else if (line.startsWith('---')) {
      blocks.push({ type: 'hr' });
    } else if (line.match(/^- \[ \] /)) {
      blocks.push({ type: 'todo', text: line.slice(6).trim(), checked: false });
    } else if (line.match(/^- \[x\] /i)) {
      blocks.push({ type: 'todo', text: line.slice(6).trim(), checked: true });
    } else if (line.match(/^    - /)) {
      blocks.push({ type: 'bullet3', text: line.slice(6).trim() });
    } else if (line.match(/^  - /)) {
      blocks.push({ type: 'bullet2', text: line.slice(4).trim() });
    } else if (line.startsWith('- ')) {
      blocks.push({ type: 'bullet1', text: line.slice(2).trim() });
    } else if (line.trim() === '') {
      blocks.push({ type: 'empty' });
    } else {
      blocks.push({ type: 'text', text: line.trim() });
    }
  }
  return blocks;
}

// Parse inline formatting: **bold** and *italic*
function parseInline(text) {
  const runs = [];
  const regex = /(\*\*(.+?)\*\*|\*(.+?)\*|([^*]+))/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match[2]) {
      runs.push({ text: match[2], bold: true });
    } else if (match[3]) {
      runs.push({ text: match[3], italic: true });
    } else if (match[4]) {
      runs.push({ text: match[4] });
    }
  }
  if (runs.length === 0) runs.push({ text });
  return runs;
}

function stripMarkdownInline(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1');
}

function latexToReadableMath(expr = '') {
  let value = String(expr || '').trim();
  const greek = {
    alpha: 'alpha', beta: 'beta', gamma: 'gamma', delta: 'delta', epsilon: 'epsilon', theta: 'theta', lambda: 'lambda', mu: 'mu',
    pi: 'pi', sigma: 'sigma', phi: 'phi', omega: 'omega', Delta: 'Delta', Theta: 'Theta', Lambda: 'Lambda',
    Pi: 'Pi', Sigma: 'Sigma', Phi: 'Phi', Omega: 'Omega'
  };
  const encodeScript = (input, fallbackPrefix) => {
    const raw = String(input || '').trim();
    if (!raw) return '';
    return `${fallbackPrefix}(${raw})`;
  };

  const replaceLoop = (pattern, replacer) => {
    let prev = '';
    while (prev !== value) {
      prev = value;
      value = value.replace(pattern, replacer);
    }
  };

  replaceLoop(/\\frac\s*\{([^{}]+)\}\s*\{([^{}]+)\}/g, (_, num, den) => `(${latexToReadableMath(num)})/(${latexToReadableMath(den)})`);
  replaceLoop(/\\sqrt\s*\{([^{}]+)\}/g, (_, inner) => `sqrt(${latexToReadableMath(inner)})`);
  value = value.replace(/\\operatorname\s*\{([^{}]+)\}/g, '$1');
  value = value.replace(/\\text\s*\{([^{}]+)\}/g, '$1');
  value = value.replace(/\\left|\\right/g, '');
  value = value.replace(/\\cdot/g, '*').replace(/\\times/g, 'x').replace(/\\div/g, '/');
  value = value.replace(/\\leq?/g, '<=').replace(/\\geq?/g, '>=').replace(/\\neq/g, '!=').replace(/\\approx/g, '~');
  value = value.replace(/\\to/g, '->').replace(/\\infty/g, 'infinity').replace(/\\pm/g, '+/-');
  value = value.replace(/\\sum/g, 'sum').replace(/\\prod/g, 'prod').replace(/\\int/g, 'int');
  Object.entries(greek).forEach(([name, char]) => {
    value = value.replace(new RegExp(`\\\\${name}(?![A-Za-z])`, 'g'), char);
  });
  value = value.replace(/\^\{([^{}]+)\}/g, (_, inner) => encodeScript(latexToReadableMath(inner), '^'));
  value = value.replace(/_\{([^{}]+)\}/g, (_, inner) => encodeScript(latexToReadableMath(inner), '_'));
  value = value.replace(/\^([A-Za-z0-9+\-=()])/g, (_, inner) => encodeScript(inner, '^'));
  value = value.replace(/_([A-Za-z0-9+\-=()])/g, (_, inner) => encodeScript(inner, '_'));
  value = value.replace(/\\,/g, ' ').replace(/\\;/g, ' ');
  value = value.replace(/[{}]/g, '');
  value = value.replace(/\\/g, '');
  value = value.replace(/\s+/g, ' ').trim();
  return value;
}

function normalizeMarkdownForExport(markdown = '') {
  let value = String(markdown || '');
  value = value.replace(/\$\$([\s\S]+?)\$\$/g, (_, expr) => `\n${latexToReadableMath(expr)}\n`);
  value = value.replace(/(^|[^\\])\$([^$\n]+?)\$/g, (_, prefix, expr) => `${prefix}${latexToReadableMath(expr)}`);
  return value;
}

// ══════════════════════════════════════════════════════
//  DOCX Generation
// ══════════════════════════════════════════════════════
export async function generateDocx(title, markdownContent, sessionInfo = {}) {
  const normalizedContent = normalizeMarkdownForExport(markdownContent);
  const blocks = parseMarkdown(normalizedContent);
  const children = [];

  // Title
  children.push(new Paragraph({
    heading: HeadingLevel.HEADING_1,
    children: [new TextRun({ text: title, bold: true, size: 36, font: 'Arial' })],
    spacing: { after: 200 },
  }));

  // Metadata line
  if (sessionInfo.date || sessionInfo.mode) {
    const metaParts = [];
    if (sessionInfo.date) metaParts.push(sessionInfo.date);
    if (sessionInfo.mode) metaParts.push(`Mode: ${sessionInfo.mode}`);
    children.push(new Paragraph({
      children: [new TextRun({ text: metaParts.join('  |  '), size: 18, color: '888888', font: 'Arial' })],
      spacing: { after: 300 },
    }));
  }

  for (const block of blocks) {
    switch (block.type) {
      case 'h2':
        children.push(new Paragraph({
          heading: HeadingLevel.HEADING_2,
          children: [new TextRun({ text: block.text, bold: true, size: 28, font: 'Arial' })],
          spacing: { before: 300, after: 150 },
        }));
        break;
      case 'h3':
        children.push(new Paragraph({
          heading: HeadingLevel.HEADING_3,
          children: [new TextRun({ text: block.text, bold: true, size: 24, font: 'Arial' })],
          spacing: { before: 200, after: 100 },
        }));
        break;
      case 'hr':
        children.push(new Paragraph({
          children: [],
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'CCCCCC' } },
          spacing: { before: 100, after: 100 },
        }));
        break;
      case 'bullet1':
      case 'bullet2':
      case 'bullet3': {
        const indent = block.type === 'bullet1' ? 360 : block.type === 'bullet2' ? 720 : 1080;
        const bulletChar = block.type === 'bullet1' ? '•  ' : block.type === 'bullet2' ? '◦  ' : '▪  ';
        const inlineRuns = parseInline(block.text);
        children.push(new Paragraph({
          children: [
            new TextRun({ text: bulletChar, size: 22, font: 'Arial' }),
            ...inlineRuns.map(r => new TextRun({ text: r.text, bold: r.bold, italics: r.italic, size: 22, font: 'Arial' })),
          ],
          indent: { left: indent },
          spacing: { after: 60 },
        }));
        break;
      }
      case 'todo': {
        const check = block.checked ? '☑  ' : '☐  ';
        const inlineRuns = parseInline(block.text);
        children.push(new Paragraph({
          children: [
            new TextRun({ text: check, size: 22, font: 'Arial' }),
            ...inlineRuns.map(r => new TextRun({
              text: r.text, bold: r.bold, italics: r.italic, size: 22, font: 'Arial',
              strike: block.checked,
            })),
          ],
          indent: { left: 360 },
          spacing: { after: 60 },
        }));
        break;
      }
      case 'text': {
        const inlineRuns = parseInline(block.text);
        children.push(new Paragraph({
          children: inlineRuns.map(r => new TextRun({
            text: r.text, bold: r.bold, italics: r.italic, size: 22, font: 'Arial',
          })),
          spacing: { after: 80 },
        }));
        break;
      }
      case 'empty':
        children.push(new Paragraph({ children: [], spacing: { after: 60 } }));
        break;
    }
  }

  // Footer
  children.push(new Paragraph({ children: [], spacing: { before: 400 } }));
  children.push(new Paragraph({
    children: [new TextRun({ text: 'Generated by SCRIBE', size: 16, color: 'AAAAAA', font: 'Arial' })],
    alignment: AlignmentType.CENTER,
  }));

  const doc = new Document({
    styles: {
      default: { document: { run: { font: 'Arial', size: 22 } } },
    },
    sections: [{
      properties: {
        page: {
          size: { width: 12240, height: 15840 },
          margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
        },
      },
      children,
    }],
  });

  return Packer.toBuffer(doc);
}

// ══════════════════════════════════════════════════════
//  PDF Generation
// ══════════════════════════════════════════════════════
export async function generatePdf(title, markdownContent, sessionInfo = {}) {
  const normalizedContent = normalizeMarkdownForExport(markdownContent);
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margins: { top: 72, bottom: 72, left: 72, right: 72 },
      info: { Title: title, Author: 'SCRIBE', Creator: 'SCRIBE Transcription' },
    });

    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const fonts = configurePdfFonts(doc);
    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    // Title
    doc.font(fonts.bold).fontSize(20).fillColor('#1a1a2e').text(title, { align: 'left' });

    // Metadata
    if (sessionInfo.date || sessionInfo.mode) {
      const metaParts = [];
      if (sessionInfo.date) metaParts.push(sessionInfo.date);
      if (sessionInfo.mode) metaParts.push(`Mode: ${sessionInfo.mode}`);
      doc.moveDown(0.3);
      doc.font(fonts.regular).fontSize(9).fillColor('#888888').text(metaParts.join('  |  '));
    }

    doc.moveDown(0.8);

    // Divider
    doc.strokeColor('#cccccc').lineWidth(0.5)
      .moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.margins.left + pageWidth, doc.y).stroke();
    doc.moveDown(0.5);

    const blocks = parseMarkdown(normalizedContent);

    for (const block of blocks) {
      switch (block.type) {
        case 'h2':
          ensurePdfSpace(doc, 30);
          doc.moveDown(0.5);
          doc.font(fonts.bold).fontSize(15).fillColor('#1a1a2e').text(block.text);
          doc.moveDown(0.3);
          break;
        case 'h3':
          ensurePdfSpace(doc, 24);
          doc.moveDown(0.3);
          doc.font(fonts.bold).fontSize(12).fillColor('#333355').text(block.text);
          doc.moveDown(0.2);
          break;
        case 'hr':
          ensurePdfSpace(doc, 12);
          doc.moveDown(0.3);
          doc.strokeColor('#dddddd').lineWidth(0.5)
            .moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.margins.left + pageWidth, doc.y).stroke();
          doc.moveDown(0.3);
          break;
        case 'bullet1':
          renderPdfParagraph(doc, block.text, { indent: 18, fontSize: 10, bulletType: 'solid-circle', fonts });
          break;
        case 'bullet2':
          renderPdfParagraph(doc, block.text, { indent: 36, fontSize: 10, bulletType: 'open-circle', fonts });
          break;
        case 'bullet3':
          renderPdfParagraph(doc, block.text, { indent: 54, fontSize: 10, bulletType: 'solid-square', fonts });
          break;
        case 'todo':
          renderPdfParagraph(doc, block.text, { indent: 18, fontSize: 10, bulletType: 'checkbox', checked: block.checked, strike: block.checked, fonts });
          break;
        case 'text':
          renderPdfParagraph(doc, block.text, { indent: 0, fontSize: 10, fonts });
          break;
        case 'empty':
          ensurePdfSpace(doc, 8);
          doc.moveDown(0.3);
          break;
      }
    }

    ensurePdfSpace(doc, 24);
    doc.moveDown(1.5);
    doc.font(fonts.regular).fontSize(8).fillColor('#aaaaaa')
      .text('Generated by SCRIBE', { align: 'center' });

    doc.end();
  });
}

function configurePdfFonts(doc) {
  const defaultFonts = {
    regular: 'Helvetica',
    bold: 'Helvetica-Bold',
    italic: 'Helvetica-Oblique',
    boldItalic: 'Helvetica-BoldOblique',
  };

  const candidates = {
    regular: [
      'C:/Windows/Fonts/msyh.ttf',
      'C:/Windows/Fonts/arial.ttf',
      '/System/Library/Fonts/PingFang.ttc',
      '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
      '/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf',
      '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    ],
    bold: [
      'C:/Windows/Fonts/msyhbd.ttf',
      'C:/Windows/Fonts/arialbd.ttf',
      '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
      '/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf',
      '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    ],
    italic: [
      'C:/Windows/Fonts/ariali.ttf',
      '/System/Library/Fonts/Supplemental/Arial Italic.ttf',
      '/usr/share/fonts/truetype/dejavu/DejaVuSans-Oblique.ttf',
    ],
    boldItalic: [
      'C:/Windows/Fonts/arialbi.ttf',
      '/System/Library/Fonts/Supplemental/Arial Bold Italic.ttf',
      '/usr/share/fonts/truetype/dejavu/DejaVuSans-BoldOblique.ttf',
    ],
  };

  const selected = {};
  for (const [style, paths] of Object.entries(candidates)) {
    const existingPath = paths.find((candidate) => {
      try {
        return fs.existsSync(candidate);
      } catch {
        return false;
      }
    });
    selected[style] = existingPath || null;
  }

  if (!selected.regular) {
    return defaultFonts;
  }

  const aliases = {
    regular: 'SCRIBE-Regular',
    bold: 'SCRIBE-Bold',
    italic: 'SCRIBE-Italic',
    boldItalic: 'SCRIBE-BoldItalic',
  };

  for (const style of Object.keys(aliases)) {
    const fontPath = selected[style] || selected.regular;
    try {
      doc.registerFont(aliases[style], path.normalize(fontPath));
    } catch {
      return defaultFonts;
    }
  }

  return aliases;
}

function ensurePdfSpace(doc, requiredHeight = 20) {
  const remaining = doc.page.height - doc.page.margins.bottom - doc.y;
  if (remaining < requiredHeight) {
    doc.addPage();
  }
}

function getPdfFontName(fonts, segment = {}) {
  if (segment.bold && segment.italic) return fonts.boldItalic;
  if (segment.bold) return fonts.bold;
  if (segment.italic) return fonts.italic;
  return fonts.regular;
}

function renderPdfParagraph(doc, text, options = {}) {
  const {
    indent = 0,
    fontSize = 10,
    bulletType = null,
    checked = false,
    strike = false,
    fonts = { regular: 'Helvetica', bold: 'Helvetica-Bold', italic: 'Helvetica-Oblique', boldItalic: 'Helvetica-BoldOblique' },
  } = options;

  const bulletArea = bulletType ? 16 : 0;
  const leftX = doc.page.margins.left + indent + bulletArea;
  const width = doc.page.width - doc.page.margins.right - leftX;
  const plainText = stripMarkdownInline(text);
  const lineGap = 2;
  const estimatedHeight = doc.heightOfString(plainText || ' ', {
    width,
    lineGap,
    align: 'left',
  }) + 6;

  ensurePdfSpace(doc, estimatedHeight + 6);

  const startY = doc.y;
  if (bulletType) {
    drawPdfBullet(doc, {
      bulletType,
      checked,
      x: doc.page.margins.left + indent + 6,
      y: startY + (fontSize * 0.72),
    });
  }

  const segments = parseInline(text);
  const hasSegments = segments.length > 0;

  doc.fillColor('#2a2a3d').fontSize(fontSize);

  segments.forEach((segment, index) => {
    const isLast = index === segments.length - 1;
    doc.font(getPdfFontName(fonts, segment)).text(segment.text, leftX, index === 0 ? startY : undefined, {
      width,
      lineGap,
      continued: !isLast,
      strike,
    });
  });

  if (!hasSegments) {
    doc.font(fonts.regular).text('', leftX, startY, { width, lineGap });
  }

  doc.moveDown(0.15);
}

function drawPdfBullet(doc, { bulletType, checked, x, y }) {
  doc.save();
  doc.lineWidth(1).strokeColor('#2a2a3d').fillColor('#2a2a3d');

  if (bulletType === 'solid-circle') {
    doc.circle(x, y, 2.5).fill();
  } else if (bulletType === 'open-circle') {
    doc.circle(x, y, 2.5).stroke();
  } else if (bulletType === 'solid-square') {
    doc.rect(x - 2.4, y - 2.4, 4.8, 4.8).fill();
  } else if (bulletType === 'checkbox') {
    const size = 8;
    doc.rect(x - 3, y - 4.8, size, size).stroke();
    if (checked) {
      doc.lineWidth(1.3)
        .moveTo(x - 1.2, y - 0.4)
        .lineTo(x + 0.8, y + 2.0)
        .lineTo(x + 4.2, y - 2.6)
        .stroke();
    }
  }

  doc.restore();
}
